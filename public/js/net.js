'use strict';
// WebSocket client: lobby presence, challenge flow, online game sync.

const Net = (() => {
  let ws = null;
  let active = false;        // user is in online mode (lobby or game)
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  function connStatus(text) {
    App.$('conn-status').textContent = text;
  }

  function connected() {
    return ws && ws.readyState === WebSocket.OPEN;
  }

  function send(obj) {
    if (connected()) ws.send(JSON.stringify(obj));
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    connStatus('连接中… connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      reconnectAttempts = 0;
      send({ type: 'auth', token: Auth.token() });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      handle(msg);
    };
    ws.onclose = () => {
      ws = null;
      if (!active) return;
      if (reconnectAttempts >= 5) {
        connStatus('连接失败 disconnected');
        App.modal('与服务器的连接已断开。', '返回菜单 Menu', null, () => {
          active = false;
          App.show('menu');
        });
        return;
      }
      reconnectAttempts++;
      connStatus(`重连中(${reconnectAttempts})… reconnecting`);
      reconnectTimer = setTimeout(connect, 1000 * reconnectAttempts);
    };
  }

  function disconnect() {
    active = false;
    clearTimeout(reconnectTimer);
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  }

  // ---------------------------------------------------------------- lobby UI

  function renderLobby(users) {
    const ul = App.$('lobby-users');
    ul.innerHTML = '';
    const others = users.filter((u) => u.name !== App.user);
    if (!others.length) {
      const li = document.createElement('li');
      li.textContent = '暂无其他在线玩家 · No other players online';
      li.className = 'me';
      ul.appendChild(li);
    }
    for (const u of users) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = u.name === App.user ? `${u.name}（我）` : u.name;
      const status = document.createElement('span');
      const playing = u.status === 'playing';
      status.textContent = playing ? '对局中 playing' : '空闲 idle';
      status.className = playing ? 'status-playing' : 'status-idle';
      li.appendChild(name);
      li.appendChild(status);
      if (u.name === App.user) {
        li.className = 'me';
      } else if (!playing) {
        li.className = 'challengeable';
        li.title = '点击发起挑战';
        li.addEventListener('click', () => {
          App.modal(`向 ${u.name} 发起挑战？`, '挑战 Challenge', '取消 Cancel', (ok) => {
            if (ok) send({ type: 'challenge', to: u.name });
          });
        });
      }
      ul.appendChild(li);
    }
  }

  // ---------------------------------------------------------------- game sync

  function applyRemoteMove(msg) {
    Game.board.place(msg.x, msg.y, msg.color);
    if (msg.win) {
      Game.finish(msg.color, msg.win, false);
    } else if (msg.draw) {
      Game.finishDraw();
    } else {
      Game.turn = msg.turn;
      Game.render();
      Game.updateStatus();
    }
  }

  function applyState(msg) {
    Game.mode = 'online';
    Game.myColor = msg.color;
    Game.opponent = msg.opponent;
    Game.board.reset();
    Game.board.cells.set(msg.board);
    Game.turn = msg.turn;
    Game.over = msg.over;
    Game.winCells = msg.winCells || null;
    Game.thinking = false;
    App.$('btn-undo').classList.add('hidden');
    App.$('btn-newgame').classList.toggle('hidden', !msg.over);
    App.show('game');
    Game.render();
    if (msg.over) {
      if (msg.winner) Game.finish(msg.winner, msg.winCells, false);
      else Game.finishDraw();
    } else {
      Game.updateStatus();
    }
  }

  // ---------------------------------------------------------------- message dispatch

  function handle(msg) {
    switch (msg.type) {
      case 'authOk':
        connStatus('✅ 已连接 connected');
        break;
      case 'authFail':
        disconnect();
        App.modal('登录已过期，请重新登录。', '好 OK', null, () => Auth.loggedOut());
        break;
      case 'kicked':
        disconnect();
        App.modal('该账号已在其他窗口登录，本窗口已下线。', '好 OK', null, () => App.show('menu'));
        break;
      case 'lobby':
        renderLobby(msg.users);
        break;

      case 'challengeSent':
        connStatus(`已向 ${msg.to} 发起挑战，等待回应…`);
        break;
      case 'challengeIncoming':
        App.modal(`${msg.from} 向你发起挑战！接受吗？`, '接受 Accept', '拒绝 Decline', (ok) => {
          send({ type: 'challengeAnswer', from: msg.from, accept: !!ok });
        });
        break;
      case 'challengeResult':
        if (!msg.accept) {
          connStatus('');
          const why = msg.reason === 'timeout' ? '（超时未回应）' : '';
          App.modal(`${msg.to} 拒绝了你的挑战${why}。`, '好 OK', null, null);
        }
        break;
      case 'challengeCancelled':
        App.closeModal(undefined);
        connStatus('');
        break;

      case 'start':
        App.closeModal(undefined);
        connStatus('');
        Game.startOnline(msg.color, msg.opponent);
        break;
      case 'move':
        applyRemoteMove(msg);
        break;
      case 'state':
        applyState(msg);
        break;

      case 'rematchOffer':
        App.modal(`${msg.from} 想再来一局，接受吗？`, '接受 Accept', '拒绝 Decline', (ok) => {
          send({ type: 'restartAnswer', accept: !!ok });
        });
        break;
      case 'rematchResult':
        if (!msg.accept) App.setStatus('对方拒绝了再来一局。');
        break;

      case 'opponentDisconnected':
        App.setStatus(`⚠️ 对手掉线，等待重连（${msg.grace}秒）…`);
        break;
      case 'opponentReconnected':
        Game.updateStatus();
        break;
      case 'opponentLeft':
        App.closeModal(undefined);
        App.modal('对手已离开对局。', '返回大厅 Lobby', null, () => App.show('lobby'));
        break;

      case 'error':
        if (msg.message) App.setStatus(`⚠️ ${msg.message}`);
        break;
    }
  }

  // ---------------------------------------------------------------- public API

  window.addEventListener('DOMContentLoaded', () => {
    App.$('btn-enter-lobby').addEventListener('click', () => {
      active = true;
      reconnectAttempts = 0;
      App.show('lobby');
      App.$('lobby-users').innerHTML = '';
      connect();
    });
    App.$('btn-lobby-back').addEventListener('click', () => {
      disconnect();
      App.show('menu');
    });
  });

  return {
    disconnect,
    sendMove(x, y) { send({ type: 'move', x, y }); },
    offerRematch() {
      send({ type: 'restart' });
      App.setStatus('已发送再来一局请求，等待对方回应…');
    },
    leaveGame() {
      send({ type: 'leaveGame' });
      App.show('lobby');
    },
  };
})();
