var express = require('express');
var http = require('http');
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var WebSocket = require('ws');
var sqlite3 = require('sqlite3').verbose();

var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server });

var dbPath = path.join(__dirname, 'database.db');
var db = new sqlite3.Database(dbPath);

function run(sql, params) {
  return new Promise(function (resolve, reject) {
    db.run(sql, params || [], function (err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params) {
  return new Promise(function (resolve, reject) {
    db.get(sql, params || [], function (err, row) {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function all(sql, params) {
  return new Promise(function (resolve, reject) {
    db.all(sql, params || [], function (err, rows) {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function initDb() {
  return run('PRAGMA foreign_keys = ON;')
    .then(function () {
      return run(
        'CREATE TABLE IF NOT EXISTS users (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
          'username TEXT UNIQUE NOT NULL,' +
          'password_hash TEXT NOT NULL,' +
          'created_at TEXT NOT NULL' +
        ')' 
      );
    })
    .then(function () {
      return run(
        'CREATE TABLE IF NOT EXISTS sessions (' +
          'token TEXT PRIMARY KEY,' +
          'user_id INTEGER NOT NULL,' +
          'created_at TEXT NOT NULL,' +
          'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE' +
        ')'
      );
    })
    .then(function () {
      return run(
        'CREATE TABLE IF NOT EXISTS rooms (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
          'name TEXT NOT NULL,' +
          'type TEXT NOT NULL,' +
          'private_code TEXT,' +
          'owner_user_id INTEGER NOT NULL,' +
          'created_at TEXT NOT NULL,' +
          'FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE' +
        ')'
      );
    })
    .then(function () {
      return run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_name_unique ON rooms(name)')
        .catch(function () {
          // If legacy duplicated names already exist, keep server running and enforce in API.
          return null;
        });
    })
    .then(function () {
      return run(
        'CREATE TABLE IF NOT EXISTS room_members (' +
          'room_id INTEGER NOT NULL,' +
          'user_id INTEGER NOT NULL,' +
          'joined_at TEXT NOT NULL,' +
          'PRIMARY KEY (room_id, user_id),' +
          'FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,' +
          'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE' +
        ')'
      );
    })
    .then(function () {
      return run(
        'CREATE TABLE IF NOT EXISTS messages (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
          'room_id INTEGER NOT NULL,' +
          'user_id INTEGER NOT NULL,' +
          'content TEXT NOT NULL,' +
          'created_at TEXT NOT NULL,' +
          'FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,' +
          'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE' +
        ')'
      );
    });
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function random4DigitCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function pbkdf2Hash(password, salt) {
  var hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') === -1) return false;
  var parts = stored.split(':');
  var salt = parts[0];
  var expected = parts[1];
  var actual = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
  } catch (err) {
    return false;
  }
}

function parseCookies(cookieHeader) {
  var out = {};
  if (!cookieHeader) return out;
  var list = cookieHeader.split(';');
  var i;
  for (i = 0; i < list.length; i += 1) {
    var part = list[i];
    var idx = part.indexOf('=');
    if (idx === -1) continue;
    var key = part.slice(0, idx).trim();
    var val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch (err) {
      out[key] = val;
    }
  }
  return out;
}

function setSessionCookie(res, token) {
  // Legacy browser compatibility: avoid SameSite which can break parsing on old engines.
  res.setHeader('Set-Cookie', 'session=' + encodeURIComponent(token) + '; HttpOnly; Path=/');
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
}

var USERNAME_REGEX = /^[A-Za-z0-9가-힣]+$/;

async function getUserBySessionToken(token) {
  if (!token) return null;
  return get(
    'SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?',
    [token]
  );
}

function getSessionTokenFromReq(req) {
  var cookies = parseCookies(req.headers.cookie || '');
  var headerToken = req.headers['x-session-token'];
  if (headerToken) return String(headerToken);
  if (cookies.session) return String(cookies.session);
  return '';
}

async function requireAuth(req, res, next) {
  try {
    var token = getSessionTokenFromReq(req);
    var user = await getUserBySessionToken(token);
    if (!user) {
      res.status(401).json({ error: '로그인이 필요합니다.' });
      return;
    }
    req.user = user;
    req.sessionToken = token;
    next();
  } catch (err) {
    res.status(500).json({ error: '인증 처리 중 오류가 발생했습니다.' });
  }
}

async function canJoinRoom(userId, roomId) {
  var room = await get('SELECT id, type FROM rooms WHERE id = ?', [roomId]);
  if (!room) return { ok: false, reason: '방을 찾을 수 없습니다.' };

  var member = await get('SELECT room_id FROM room_members WHERE room_id = ? AND user_id = ?', [roomId, userId]);
  if (member) return { ok: true, room: room };

  return { ok: true, room: room };
}

async function joinRoom(userId, roomId) {
  await run('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)', [roomId, userId, nowIso()]);
}

function sanitizeMessage(text) {
  if (!text) return '';
  var trimmed = String(text).replace(/\r/g, '').trim();
  if (trimmed.length > 500) {
    trimmed = trimmed.slice(0, 500);
  }
  return trimmed;
}

async function roomMembershipRequired(req, res, next) {
  try {
    var roomId = Number(req.params.roomId);
    if (!roomId) {
      res.status(400).json({ error: '잘못된 방 ID입니다.' });
      return;
    }
    var member = await get('SELECT room_id FROM room_members WHERE room_id = ? AND user_id = ?', [roomId, req.user.id]);
    if (!member) {
      res.status(403).json({ error: '먼저 방에 입장해야 합니다.' });
      return;
    }
    req.roomId = roomId;
    next();
  } catch (err) {
    res.status(500).json({ error: '방 접근 확인 중 오류가 발생했습니다.' });
  }
}

var roomSockets = {};

function sendJson(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcastRoom(roomId, payload) {
  var bucket = roomSockets[String(roomId)] || [];
  var i;
  for (i = 0; i < bucket.length; i += 1) {
    sendJson(bucket[i], payload);
  }
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTimeText(isoString) {
  if (!isoString) return '-';
  var d = new Date(String(isoString));
  if (isNaN(d.getTime())) return String(isoString);
  // Default display timezone: KST (UTC+9). Can be overridden via env.
  var tzOffsetMinutes = Number(process.env.DISPLAY_TZ_OFFSET_MINUTES || 540);
  var shifted = new Date(d.getTime() + tzOffsetMinutes * 60000);
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  return shifted.getUTCFullYear() + '-' +
    pad(shifted.getUTCMonth() + 1) + '-' +
    pad(shifted.getUTCDate()) + ' ' +
    pad(shifted.getUTCHours()) + ':' +
    pad(shifted.getUTCMinutes());
}

function formatTimeText(isoString) {
  if (!isoString) return '--:--';
  var d = new Date(String(isoString));
  if (isNaN(d.getTime())) return '--:--';
  var tzOffsetMinutes = Number(process.env.DISPLAY_TZ_OFFSET_MINUTES || 540);
  var shifted = new Date(d.getTime() + tzOffsetMinutes * 60000);
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  return pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes());
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/', async function (req, res, next) {
  try {
    var indexPath = path.join(__dirname, 'public', 'index.html');
    var tpl = fs.readFileSync(indexPath, 'utf8');
    var rooms = await all(
      'SELECT rooms.id, rooms.name, ' +
      'COALESCE((SELECT m.created_at FROM messages m WHERE m.room_id = rooms.id ORDER BY m.id DESC LIMIT 1), rooms.created_at) AS last_activity ' +
      'FROM rooms ORDER BY last_activity DESC, rooms.id DESC',
      []
    );
    var listHtml = '';
    var i;
    for (i = 0; i < rooms.length; i += 1) {
      listHtml += '<li><div><b>' + escapeHtml(rooms[i].name) + '</b> <span class="room-id">(#' + rooms[i].id + ')</span></div>' +
        '<div class="room-last">마지막 활동: ' + escapeHtml(formatDateTimeText(rooms[i].last_activity)) + '</div></li>';
    }
    if (!listHtml) {
      listHtml = '<li>생성된 방이 없습니다.</li>';
    }
    var html = tpl.replace('<ul id=\"roomList\" class=\"list\"></ul>', '<ul id=\"roomList\" class=\"list\">' + listHtml + '</ul>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    next();
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/signup', async function (req, res) {
  try {
    var username = (req.body.username || '').trim();
    var password = String(req.body.password || '');

    if (!username || !password) {
      res.status(400).json({ error: '아이디와 비밀번호를 모두 입력하세요.' });
      return;
    }

    if (!USERNAME_REGEX.test(username)) {
      res.status(400).json({ error: '아이디는 한글/영문/숫자만 사용할 수 있습니다.' });
      return;
    }

    if (password.length < 4) {
      res.status(400).json({ error: '비밀번호는 최소 4자 이상이어야 합니다.' });
      return;
    }

    var salt = crypto.randomBytes(16).toString('hex');
    var hash = pbkdf2Hash(password, salt);

    await run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', [username, hash, nowIso()]);
    res.json({ ok: true, message: '회원가입이 완료되었습니다.' });
  } catch (err) {
    if (String(err.message || '').indexOf('UNIQUE') >= 0) {
      res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
      return;
    }
    res.status(500).json({ error: '회원가입 중 오류가 발생했습니다.' });
  }
});

app.post('/api/login', async function (req, res) {
  try {
    var username = (req.body.username || '').trim();
    var password = String(req.body.password || '');

    var user = await get('SELECT id, username, password_hash FROM users WHERE username = ?', [username]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: '아이디 또는 비밀번호가 잘못되었습니다.' });
      return;
    }

    var token = randomToken();
    await run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', [token, user.id, nowIso()]);

    setSessionCookie(res, token);
    res.json({ ok: true, token: token, user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: '로그인 중 오류가 발생했습니다.' });
  }
});

app.post('/api/logout', requireAuth, async function (req, res) {
  try {
    await run('DELETE FROM sessions WHERE token = ?', [req.sessionToken]);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '로그아웃 중 오류가 발생했습니다.' });
  }
});

app.get('/api/me', async function (req, res) {
  try {
    var token = getSessionTokenFromReq(req);
    var user = await getUserBySessionToken(token);
    if (!user) {
      res.json({ loggedIn: false });
      return;
    }
    res.json({ loggedIn: true, user: user });
  } catch (err) {
    res.status(500).json({ error: '사용자 조회 중 오류가 발생했습니다.' });
  }
});

app.post('/api/rooms', requireAuth, async function (req, res) {
  try {
    var name = (req.body.name || '').trim();

    if (!name) {
      res.status(400).json({ error: '방 이름을 입력하세요.' });
      return;
    }

    var existing = await get('SELECT id FROM rooms WHERE name = ?', [name]);
    if (existing) {
      res.status(409).json({ error: '이미 같은 이름의 채팅방이 있습니다.' });
      return;
    }

    var type = 'public';
    var privateCode = null;

    var created = await run(
      'INSERT INTO rooms (name, type, private_code, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [name, type, privateCode, req.user.id, nowIso()]
    );

    await joinRoom(req.user.id, created.lastID);

    res.json({
      ok: true,
      room: {
        id: created.lastID,
        name: name,
        type: type
      }
    });
  } catch (err) {
    if (String(err.message || '').indexOf('UNIQUE') >= 0) {
      res.status(409).json({ error: '이미 같은 이름의 채팅방이 있습니다.' });
      return;
    }
    res.status(500).json({ error: '방 생성 중 오류가 발생했습니다.' });
  }
});

app.get('/api/rooms', async function (req, res) {
  try {
    var rooms = await all(
      'SELECT rooms.id, rooms.name, rooms.type, rooms.owner_user_id, rooms.created_at, ' +
      'COALESCE((SELECT m.created_at FROM messages m WHERE m.room_id = rooms.id ORDER BY m.id DESC LIMIT 1), rooms.created_at) AS last_activity ' +
      'FROM rooms ' +
      'ORDER BY last_activity DESC, rooms.id DESC',
      []
    );
    var i;
    for (i = 0; i < rooms.length; i += 1) {
      rooms[i].last_activity_text = formatDateTimeText(rooms[i].last_activity);
    }
    res.json({ rooms: rooms });
  } catch (err) {
    res.status(500).json({ error: '방 목록 조회 중 오류가 발생했습니다.' });
  }
});

app.get('/api/public-rooms', async function (req, res) {
  try {
    var rooms = await all(
      'SELECT rooms.id, rooms.name, rooms.type, rooms.owner_user_id, rooms.created_at, ' +
      'COALESCE((SELECT m.created_at FROM messages m WHERE m.room_id = rooms.id ORDER BY m.id DESC LIMIT 1), rooms.created_at) AS last_activity ' +
      'FROM rooms ' +
      'ORDER BY last_activity DESC, rooms.id DESC',
      []
    );
    var i;
    for (i = 0; i < rooms.length; i += 1) {
      rooms[i].last_activity_text = formatDateTimeText(rooms[i].last_activity);
    }
    res.json({ rooms: rooms });
  } catch (err) {
    res.status(500).json({ error: '방 목록 조회 중 오류가 발생했습니다.' });
  }
});

app.get('/api/public-rooms-text', async function (req, res) {
  try {
    var rooms = await all(
      'SELECT rooms.id, rooms.name, ' +
      'COALESCE((SELECT m.created_at FROM messages m WHERE m.room_id = rooms.id ORDER BY m.id DESC LIMIT 1), rooms.created_at) AS last_activity ' +
      'FROM rooms ORDER BY last_activity DESC, rooms.id DESC',
      []
    );
    var lines = [];
    var i;
    for (i = 0; i < rooms.length; i += 1) {
      lines.push(String(rooms[i].id) + '\t' + String(rooms[i].name || '') + '\t' + formatDateTimeText(rooms[i].last_activity));
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).send('');
  }
});

app.get('/api/my-rooms', requireAuth, async function (req, res) {
  try {
    var rooms = await all(
      'SELECT rooms.id, rooms.name, rooms.type, rooms.created_at FROM room_members JOIN rooms ON rooms.id = room_members.room_id WHERE room_members.user_id = ? ORDER BY rooms.id DESC',
      [req.user.id]
    );
    res.json({ rooms: rooms });
  } catch (err) {
    res.status(500).json({ error: '내 방 목록 조회 중 오류가 발생했습니다.' });
  }
});

app.post('/api/rooms/:roomId/join', requireAuth, async function (req, res) {
  try {
    var roomId = Number(req.params.roomId);
    if (!roomId) {
      res.status(400).json({ error: '잘못된 방 ID입니다.' });
      return;
    }

    var check = await canJoinRoom(req.user.id, roomId);
    if (!check.ok) {
      res.status(403).json({ error: check.reason });
      return;
    }

    await joinRoom(req.user.id, roomId);
    res.json({ ok: true, room: { id: roomId, type: check.room.type } });
  } catch (err) {
    res.status(500).json({ error: '방 입장 중 오류가 발생했습니다.' });
  }
});

app.get('/api/rooms/:roomId/messages', requireAuth, roomMembershipRequired, async function (req, res) {
  try {
    var sinceId = Number(req.query.sinceId || 0);
    if (!sinceId || sinceId < 0) sinceId = 0;

    var messages = await all(
      'SELECT messages.id, messages.content, messages.created_at, users.username FROM messages JOIN users ON users.id = messages.user_id WHERE messages.room_id = ? AND messages.id > ? ORDER BY messages.id ASC',
      [req.roomId, sinceId]
    );
    var i;
    for (i = 0; i < messages.length; i += 1) {
      messages[i].created_at_text = formatDateTimeText(messages[i].created_at);
      messages[i].time_text = formatTimeText(messages[i].created_at);
    }
    res.json({ messages: messages });
  } catch (err) {
    res.status(500).json({ error: '메시지 조회 중 오류가 발생했습니다.' });
  }
});

app.post('/api/rooms/:roomId/messages', requireAuth, roomMembershipRequired, async function (req, res) {
  try {
    var content = sanitizeMessage(req.body.content || '');
    if (!content) {
      res.status(400).json({ error: '메시지를 입력하세요.' });
      return;
    }

    var inserted = await run(
      'INSERT INTO messages (room_id, user_id, content, created_at) VALUES (?, ?, ?, ?)',
      [req.roomId, req.user.id, content, nowIso()]
    );

    var message = await get(
      'SELECT messages.id, messages.content, messages.created_at, users.username FROM messages JOIN users ON users.id = messages.user_id WHERE messages.id = ?',
      [inserted.lastID]
    );
    message.created_at_text = formatDateTimeText(message.created_at);
    message.time_text = formatTimeText(message.created_at);

    broadcastRoom(req.roomId, { type: 'message', message: message });

    res.json({ ok: true, message: message });
  } catch (err) {
    res.status(500).json({ error: '메시지 전송 중 오류가 발생했습니다.' });
  }
});

wss.on('connection', async function (ws, req) {
  ws.user = null;
  ws.roomId = null;

  try {
    var token = '';
    var url = req.url || '';
    var qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      var query = url.slice(qIdx + 1).split('&');
      var i;
      for (i = 0; i < query.length; i += 1) {
        var p = query[i].split('=');
        if (p[0] === 'token') {
          try {
            token = decodeURIComponent(p[1] || '');
          } catch (err) {
            token = p[1] || '';
          }
        }
      }
    }
    if (!token) {
      var cookies = parseCookies(req.headers.cookie || '');
      token = cookies.session || '';
    }
    var user = await getUserBySessionToken(token);
    if (!user) {
      sendJson(ws, { type: 'error', error: '인증이 필요합니다.' });
      ws.close();
      return;
    }
    ws.user = user;
    sendJson(ws, { type: 'ready', user: user });
  } catch (err) {
    ws.close();
    return;
  }

  ws.on('message', async function (raw) {
    var data;
    try {
      data = JSON.parse(String(raw || ''));
    } catch (err) {
      sendJson(ws, { type: 'error', error: '잘못된 요청 형식입니다.' });
      return;
    }

    if (data.type === 'join') {
      var roomId = Number(data.roomId);
      if (!roomId) {
        sendJson(ws, { type: 'error', error: '잘못된 방 ID입니다.' });
        return;
      }

      try {
        var check = await canJoinRoom(ws.user.id, roomId);
        if (!check.ok) {
          sendJson(ws, { type: 'error', error: check.reason });
          return;
        }

        await joinRoom(ws.user.id, roomId);
        ws.roomId = roomId;

        if (!roomSockets[String(roomId)]) {
          roomSockets[String(roomId)] = [];
        }
        roomSockets[String(roomId)].push(ws);

        sendJson(ws, { type: 'joined', roomId: roomId });
      } catch (err) {
        sendJson(ws, { type: 'error', error: '방 입장 중 오류가 발생했습니다.' });
      }
      return;
    }

    if (data.type === 'message') {
      var content = sanitizeMessage(data.content || '');
      if (!ws.roomId) {
        sendJson(ws, { type: 'error', error: '먼저 방에 입장하세요.' });
        return;
      }
      if (!content) {
        sendJson(ws, { type: 'error', error: '메시지를 입력하세요.' });
        return;
      }

      try {
        var inserted = await run(
          'INSERT INTO messages (room_id, user_id, content, created_at) VALUES (?, ?, ?, ?)',
          [ws.roomId, ws.user.id, content, nowIso()]
        );
        var message = await get(
          'SELECT messages.id, messages.content, messages.created_at, users.username FROM messages JOIN users ON users.id = messages.user_id WHERE messages.id = ?',
          [inserted.lastID]
        );
        message.created_at_text = formatDateTimeText(message.created_at);
        message.time_text = formatTimeText(message.created_at);

        broadcastRoom(ws.roomId, { type: 'message', message: message });
      } catch (err) {
        sendJson(ws, { type: 'error', error: '메시지 전송 중 오류가 발생했습니다.' });
      }
    }
  });

  ws.on('close', function () {
    if (!ws.roomId) return;
    var key = String(ws.roomId);
    var bucket = roomSockets[key] || [];
    var next = [];
    var i;
    for (i = 0; i < bucket.length; i += 1) {
      if (bucket[i] !== ws) {
        next.push(bucket[i]);
      }
    }
    roomSockets[key] = next;
  });
});

initDb()
  .then(function () {
    var port = process.env.PORT || 3000;
    server.listen(port, function () {
      console.log('Chat Minus server running on http://localhost:' + port);
    });
  })
  .catch(function (err) {
    console.error('DB initialization failed:', err);
    process.exit(1);
  });
