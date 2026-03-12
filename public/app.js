(function () {
  var state = {
    me: null,
    sessionToken: '',
    roomsById: {},
    roomId: null,
    roomName: '',
    lastMessageId: 0,
    transport: '',
    ws: null,
    pollTimer: null
  };

  var el = {
    notice: document.getElementById('notice'),
    homeView: document.getElementById('homeView'),
    loginView: document.getElementById('loginView'),
    createRoomView: document.getElementById('createRoomView'),
    chatView: document.getElementById('chatView'),
    bottomBanner: document.getElementById('bottomBanner'),
    goLoginBtn: document.getElementById('goLoginBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    goCreateRoomBtn: document.getElementById('goCreateRoomBtn'),
    welcome: document.getElementById('welcome'),
    roomList: document.getElementById('roomList'),
    username: document.getElementById('username'),
    password: document.getElementById('password'),
    signupBtn: document.getElementById('signupBtn'),
    loginBtn: document.getElementById('loginBtn'),
    backToHomeFromLoginBtn: document.getElementById('backToHomeFromLoginBtn'),
    roomName: document.getElementById('roomName'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    backToHomeFromCreateBtn: document.getElementById('backToHomeFromCreateBtn'),
    chatRoomTitle: document.getElementById('chatRoomTitle'),
    transportMode: document.getElementById('transportMode'),
    chatMessages: document.getElementById('chatMessages'),
    chatInput: document.getElementById('chatInput'),
    sendBtn: document.getElementById('sendBtn'),
    leaveRoomBtn: document.getElementById('leaveRoomBtn')
  };

  function setNotice(msg) {
    var text = msg || '';
    el.notice.innerHTML = text;
    el.notice.style.display = text ? 'block' : 'none';
  }

  function show(viewName) {
    el.homeView.className = 'panel hidden';
    el.loginView.className = 'panel hidden';
    el.createRoomView.className = 'panel hidden';
    el.chatView.className = 'panel hidden';

    if (viewName === 'home') el.homeView.className = 'panel';
    if (viewName === 'login') el.loginView.className = 'panel';
    if (viewName === 'createRoom') el.createRoomView.className = 'panel';
    if (viewName === 'chat') el.chatView.className = 'panel';

    if (viewName === 'home') el.bottomBanner.className = 'bottom-banner';
    else el.bottomBanner.className = 'bottom-banner hidden';
  }

  function updateAuthUi() {
    if (state.me) {
      el.goLoginBtn.className = 'hidden';
      el.logoutBtn.className = '';
      el.goCreateRoomBtn.className = '';
      el.welcome.innerHTML = '안녕하세요, ' + escapeHtml(state.me.username) + ' 님';
    } else {
      el.goLoginBtn.className = '';
      el.logoutBtn.className = 'hidden';
      el.goCreateRoomBtn.className = 'hidden';
      el.welcome.innerHTML = '로그인 후 채팅에 참여할 수 있습니다.';
    }
  }

  function xhr(method, url, data, cb) {
    var req = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject('Microsoft.XMLHTTP');
    var body = null;

    function encodeForm(obj) {
      var out = [];
      var key;
      for (key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        out.push(encodeURIComponent(key) + '=' + encodeURIComponent(obj[key] == null ? '' : String(obj[key])));
      }
      return out.join('&');
    }

    function parseJson(text) {
      if (!text) return {};
      if (window.JSON && window.JSON.parse) return window.JSON.parse(text);
      try {
        return (new Function('return (' + text + ');'))();
      } catch (e) {
        return { error: '응답 형식 오류' };
      }
    }

    req.open(method, url, true);
    if (state.sessionToken) req.setRequestHeader('X-Session-Token', state.sessionToken);
    if (method !== 'GET' && data) {
      body = encodeForm(data);
      req.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }

    req.onreadystatechange = function () {
      if (req.readyState !== 4) return;
      var parsed = parseJson(req.responseText);
      if (req.status >= 200 && req.status < 300) cb(null, parsed);
      else cb(parsed && parsed.error ? parsed.error : '요청 실패', parsed);
    };

    req.send(body);
  }

  function xhrText(method, url, cb) {
    var req = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject('Microsoft.XMLHTTP');
    req.open(method, url, true);
    if (state.sessionToken) req.setRequestHeader('X-Session-Token', state.sessionToken);
    req.onreadystatechange = function () {
      if (req.readyState !== 4) return;
      if (req.status >= 200 && req.status < 300) cb(null, req.responseText || '');
      else cb('요청 실패', '');
    };
    req.send(null);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatChatTime(isoString, timeText) {
    if (timeText) return String(timeText);
    if (!isoString) return '--:--';
    var s = String(isoString);
    var m = s.match(/(?:T| )(\\d{2}):(\\d{2})/);
    if (!m) return '--:--';
    return m[1] + ':' + m[2];
  }

  function setTransportIndicator(mode) {
    var label = '●연결 끊김';
    var cls = 'transport-disconnected';
    if (mode === 'polling') {
      label = '●풀링';
      cls = 'transport-polling';
    } else if (mode === 'realtime') {
      label = '●실시간';
      cls = 'transport-realtime';
    }
    var currentUser = state.me && state.me.username ? state.me.username : '-';
    el.transportMode.innerHTML =
      '<span class="transport-box ' + cls + '">' + label + '</span>' +
      ' <span class="transport-user">접속: ' + escapeHtml(currentUser) + '</span>';
  }

  function formatRoomLastActivity(isoString, textValue) {
    if (textValue) return String(textValue);
    if (!isoString) return '-';
    var s = String(isoString);
    var m = s.match(/^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})/);
    if (!m) return s;
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
  }

  function loadMe(done) {
    xhr('GET', '/api/me', null, function (err, body) {
      if (err || !body.loggedIn) {
        state.me = null;
        state.sessionToken = '';
      } else {
        state.me = body.user;
      }
      updateAuthUi();
      loadRooms();
      if (done) done();
    });
  }

  function loadRooms() {
    function renderRooms(body) {
      if (!body || !body.rooms) {
        setNotice('채팅방 목록을 불러오지 못했습니다.');
        return;
      }

      state.roomsById = {};
      var html = '';
      var i;
      for (i = 0; i < body.rooms.length; i += 1) {
        var room = body.rooms[i];
        state.roomsById[String(room.id)] = room;
        var joinBtn = '';
        if (state.me) {
          joinBtn = '<button onclick="window.__joinRoom(' + room.id + ')">입장 ▶</button>';
        }
        html += '<li>' +
          '<div><b>' + escapeHtml(room.name) + '</b> <span class="room-id">(#' + room.id + ')</span></div>' +
          '<div class="room-last">마지막 활동: ' + escapeHtml(formatRoomLastActivity(room.last_activity, room.last_activity_text)) + '</div>' +
          joinBtn +
          '</li>';
      }
      el.roomList.innerHTML = html || '<li>생성된 방이 없습니다.</li>';
    }

    xhr('GET', '/api/public-rooms', null, function (err, body) {
      if (!err) {
        renderRooms(body);
        return;
      }
      xhr('GET', '/api/rooms', null, function (err2, body2) {
        if (!err2) {
          renderRooms(body2);
          return;
        }
        xhrText('GET', '/api/public-rooms-text', function (err3, text) {
          if (err3) {
            setNotice('채팅방 목록을 불러오지 못했습니다.');
            el.roomList.innerHTML = '<li>생성된 방이 없습니다.</li>';
            return;
          }
          var rows = text ? text.split('\n') : [];
          var rooms = [];
          var i;
          for (i = 0; i < rows.length; i += 1) {
            var line = rows[i];
            if (!line) continue;
            var tab = line.indexOf('\t');
            if (tab < 0) continue;
            var rest = line.slice(tab + 1);
            var tab2 = rest.indexOf('\t');
            var name = rest;
            var lastActivity = '';
            if (tab2 >= 0) {
              name = rest.slice(0, tab2);
              lastActivity = rest.slice(tab2 + 1);
            }
            rooms.push({
              id: Number(line.slice(0, tab)),
              name: name,
              last_activity: lastActivity,
              last_activity_text: lastActivity,
              type: 'public'
            });
          }
          renderRooms({ rooms: rooms });
        });
      });
    });
  }

  function stopRealtime() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.ws) {
      try { state.ws.close(); } catch (e) {}
      state.ws = null;
    }
  }

  function pollMessages() {
    xhr('GET', '/api/rooms/' + state.roomId + '/messages?sinceId=' + state.lastMessageId, null, function (err, body) {
      if (err) {
        setTransportIndicator('disconnected');
        return;
      }
      if (state.transport === 'polling') setTransportIndicator('polling');
      var i;
      for (i = 0; i < body.messages.length; i += 1) renderMessage(body.messages[i]);
    });
  }

  function startPollingMode() {
    stopRealtime();
    state.transport = 'polling';
    setTransportIndicator('polling');
    pollMessages();
    state.pollTimer = setInterval(pollMessages, 2000);
  }

  function startWebSocketMode() {
    if (!window.WebSocket) {
      startPollingMode();
      return;
    }

    stopRealtime();
    var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var wsUrl = protocol + location.host;
    if (state.sessionToken) wsUrl += '?token=' + encodeURIComponent(state.sessionToken);

    var ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = function () {
      state.transport = 'websocket';
      setTransportIndicator('realtime');
    };

    ws.onmessage = function (event) {
      var data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (data.type === 'ready') {
        ws.send(JSON.stringify({ type: 'join', roomId: state.roomId }));
        return;
      }
      if (data.type === 'joined') {
        pollMessages();
        return;
      }
      if (data.type === 'message') {
        renderMessage(data.message);
        return;
      }
      if (data.type === 'error') {
        setNotice(data.error);
      }
    };

    ws.onerror = function () {
      setTransportIndicator('disconnected');
      startPollingMode();
    };
    ws.onclose = function () {
      if (state.roomId && state.transport === 'websocket') {
        setTransportIndicator('disconnected');
        startPollingMode();
      }
    };
  }

  function renderMessage(m) {
    var div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML =
      '<span class="msg-user">&lt;' + escapeHtml(m.username) + '&gt;</span> ' +
      '<span class="msg-time">[' + escapeHtml(formatChatTime(m.created_at, m.time_text)) + ']</span> ' +
      '<span class="msg-text">' + escapeHtml(m.content) + '</span>';
    el.chatMessages.appendChild(div);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    if (m.id > state.lastMessageId) state.lastMessageId = m.id;
  }

  function enterRoom(roomId, roomName) {
    state.roomId = roomId;
    state.roomName = roomName;
    state.lastMessageId = 0;
    el.chatMessages.innerHTML = '';
    el.chatRoomTitle.innerHTML = escapeHtml(roomName) + ' <span class="room-id">(#' + roomId + ')</span>';
    show('chat');
    startWebSocketMode();
  }

  window.__joinRoom = function (roomId) {
    setNotice('');
    if (!state.me) {
      setNotice('로그인이 필요합니다.');
      show('login');
      return;
    }
    var room = state.roomsById[String(roomId)];
    if (!room) {
      setNotice('방 정보를 찾을 수 없습니다.');
      return;
    }

    xhr('POST', '/api/rooms/' + roomId + '/join', {}, function (err) {
      if (err) {
        setNotice(err);
        return;
      }
      enterRoom(roomId, room.name);
    });
  };

  el.goLoginBtn.onclick = function () {
    setNotice('');
    show('login');
  };

  el.backToHomeFromLoginBtn.onclick = function () {
    setNotice('');
    show('home');
  };

  el.goCreateRoomBtn.onclick = function () {
    setNotice('');
    if (!state.me) {
      setNotice('로그인 후 채팅방을 생성할 수 있습니다.');
      show('login');
      return;
    }
    show('createRoom');
  };

  el.backToHomeFromCreateBtn.onclick = function () {
    setNotice('');
    show('home');
  };

  el.signupBtn.onclick = function () {
    setNotice('');
    xhr('POST', '/api/signup', {
      username: el.username.value,
      password: el.password.value
    }, function (err, body) {
      if (err) {
        setNotice(err);
        return;
      }
      setNotice(body.message || '회원가입 성공');
    });
  };

  el.loginBtn.onclick = function () {
    setNotice('');
    xhr('POST', '/api/login', {
      username: el.username.value,
      password: el.password.value
    }, function (err, body) {
      if (err) {
        setNotice(err);
        return;
      }
      if (body && body.token) state.sessionToken = body.token;
      loadMe(function () {
        loadRooms();
        show('home');
      });
    });
  };

  el.logoutBtn.onclick = function () {
    setNotice('');
    xhr('POST', '/api/logout', {}, function () {
      stopRealtime();
      state.me = null;
      state.sessionToken = '';
      updateAuthUi();
      loadRooms();
      show('home');
    });
  };

  el.createRoomBtn.onclick = function () {
    setNotice('');
    xhr('POST', '/api/rooms', {
      name: el.roomName.value
    }, function (err) {
      if (err) {
        setNotice(err);
        return;
      }
      el.roomName.value = '';
      loadRooms();
      show('home');
    });
  };

  el.sendBtn.onclick = function () {
    var text = el.chatInput.value;
    if (!text) return;

    if (state.transport === 'websocket' && state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'message', content: text }));
      el.chatInput.value = '';
      return;
    }

    xhr('POST', '/api/rooms/' + state.roomId + '/messages', { content: text }, function (err, body) {
      if (err) {
        setNotice(err);
        return;
      }
      renderMessage(body.message);
      el.chatInput.value = '';
    });
  };

  el.chatInput.onkeydown = function (event) {
    var e = event || window.event;
    var keyCode = e.keyCode || e.which;
    if (keyCode === 13) {
      if (e.preventDefault) e.preventDefault();
      e.returnValue = false;
      el.sendBtn.onclick();
      return false;
    }
  };

  el.leaveRoomBtn.onclick = function () {
    stopRealtime();
    state.roomId = null;
    state.roomName = '';
    state.lastMessageId = 0;
    show('home');
    loadRooms();
  };

  show('home');
  loadRooms();
  loadMe();
})();
