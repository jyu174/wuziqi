'use strict';
// 五子棋 server: serves static files + auth API over HTTP, runs the
// authoritative game/lobby server over WebSocket.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const auth = require('./auth');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SIZE = 19;
const EMPTY = 0, BLACK = 1, WHITE = 2;
const CHALLENGE_TIMEOUT = 30 * 1000;
const RECONNECT_GRACE = 60 * 1000;

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleApi(req, res) {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'POST' && (url === '/api/register' || url === '/api/login' || url === '/api/logout')) {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        return sendJson(res, 400, { error: '无效的请求' });
      }
      if (url === '/api/register') {
        const r = auth.register(body.username, body.password);
        return sendJson(res, r.error ? 400 : 200, r);
      }
      if (url === '/api/login') {
        const r = auth.login(body.username, body.password);
        return sendJson(res, r.error ? 401 : 200, r);
      }
      auth.logout(body.token);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url === '/api/me') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const username = auth.verify(token);
      if (!username) return sendJson(res, 401, { error: '未登录' });
      return sendJson(res, 200, { username });
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: '服务器错误' });
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  serveStatic(req, res);
});

// ---------------------------------------------------------------- Game logic

function winLine(cells, x, y) {
  const color = cells[y * SIZE + x];
  if (!color) return null;
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    const line = [[x, y]];
    for (const s of [1, -1]) {
      let nx = x + dx * s, ny = y + dy * s;
      while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && cells[ny * SIZE + nx] === color) {
        if (s === 1) line.push([nx, ny]);
        else line.unshift([nx, ny]);
        nx += dx * s;
        ny += dy * s;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

// ---------------------------------------------------------------- Lobby / games state

const sockets = new Map(); // username -> ws
const userGame = new Map(); // username -> game
const challenges = new Map(); // challenger username -> { to, timer }

function makeGame(nameA, nameB) {
  const flip = crypto.randomInt(2) === 0;
  return {
    id: crypto.randomBytes(8).toString('hex'),
    players: { [BLACK]: flip ? nameA : nameB, [WHITE]: flip ? nameB : nameA },
    cells: new Int8Array(SIZE * SIZE),
    moveCount: 0,
    turn: BLACK,
    over: false,
    winner: null,
    winCells: null,
    rematchWanted: null, // username who offered
    disconnectTimers: new Map(), // username -> timer
  };
}

function colorOf(game, username) {
  return game.players[BLACK] === username ? BLACK : WHITE;
}

function opponentOf(game, username) {
  return game.players[BLACK] === username ? game.players[WHITE] : game.players[BLACK];
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendToUser(username, obj) {
  send(sockets.get(username), obj);
}

function lobbyUsers() {
  const list = [];
  for (const name of sockets.keys()) {
    list.push({ name, status: userGame.has(name) ? 'playing' : 'idle' });
  }
  return list;
}

function broadcastLobby() {
  const msg = { type: 'lobby', users: lobbyUsers() };
  for (const ws of sockets.values()) send(ws, msg);
}

function cancelChallengesInvolving(username) {
  for (const [from, ch] of challenges) {
    if (from === username || ch.to === username) {
      clearTimeout(ch.timer);
      challenges.delete(from);
      const other = from === username ? ch.to : from;
      sendToUser(other, { type: 'challengeCancelled', from, to: ch.to });
    }
  }
}

function stateMessage(game, username) {
  return {
    type: 'state',
    board: Array.from(game.cells),
    turn: game.turn,
    color: colorOf(game, username),
    opponent: opponentOf(game, username),
    over: game.over,
    winner: game.winner,
    winCells: game.winCells,
    moveCount: game.moveCount,
  };
}

function startGamePair(game) {
  userGame.set(game.players[BLACK], game);
  userGame.set(game.players[WHITE], game);
  for (const color of [BLACK, WHITE]) {
    sendToUser(game.players[color], {
      type: 'start',
      color,
      opponent: game.players[3 - color],
    });
  }
  broadcastLobby();
}

function destroyGame(game) {
  for (const t of game.disconnectTimers.values()) clearTimeout(t);
  for (const name of [game.players[BLACK], game.players[WHITE]]) {
    if (userGame.get(name) === game) userGame.delete(name);
  }
  broadcastLobby();
}

// ---------------------------------------------------------------- WebSocket handlers

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.username = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'auth') return handleAuth(ws, msg);
    if (!ws.username) return send(ws, { type: 'error', message: '请先登录' });

    switch (msg.type) {
      case 'challenge': return handleChallenge(ws, msg);
      case 'challengeAnswer': return handleChallengeAnswer(ws, msg);
      case 'move': return handleMove(ws, msg);
      case 'restart': return handleRestart(ws);
      case 'restartAnswer': return handleRestartAnswer(ws, msg);
      case 'leaveGame': return handleLeave(ws);
    }
  });

  ws.on('close', () => handleClose(ws));
});

function handleAuth(ws, msg) {
  const username = auth.verify(msg.token);
  if (!username) return send(ws, { type: 'authFail', message: '登录已过期，请重新登录' });

  const old = sockets.get(username);
  if (old && old !== ws) {
    send(old, { type: 'kicked' });
    old.username = null; // prevent close handler from touching game/lobby state
    old.close();
  }
  ws.username = username;
  sockets.set(username, ws);
  send(ws, { type: 'authOk', username });

  const game = userGame.get(username);
  if (game) {
    // Reconnected into a live game.
    const t = game.disconnectTimers.get(username);
    if (t) {
      clearTimeout(t);
      game.disconnectTimers.delete(username);
    }
    send(ws, stateMessage(game, username));
    sendToUser(opponentOf(game, username), { type: 'opponentReconnected' });
  }
  broadcastLobby();
}

function handleChallenge(ws, msg) {
  const from = ws.username;
  const to = msg.to;
  if (typeof to !== 'string' || to === from) return;
  if (userGame.has(from)) return send(ws, { type: 'error', message: '你已在对局中' });
  if (!sockets.has(to)) return send(ws, { type: 'error', message: '对方已离线' });
  if (userGame.has(to)) return send(ws, { type: 'error', message: '对方正在对局中' });
  if (challenges.has(from)) return send(ws, { type: 'error', message: '你已有一个等待回应的挑战' });

  const timer = setTimeout(() => {
    challenges.delete(from);
    sendToUser(from, { type: 'challengeResult', to, accept: false, reason: 'timeout' });
    sendToUser(to, { type: 'challengeCancelled', from, to });
  }, CHALLENGE_TIMEOUT);
  challenges.set(from, { to, timer });
  sendToUser(to, { type: 'challengeIncoming', from });
  send(ws, { type: 'challengeSent', to });
}

function handleChallengeAnswer(ws, msg) {
  const me = ws.username;
  const from = msg.from;
  const ch = challenges.get(from);
  if (!ch || ch.to !== me) return;
  clearTimeout(ch.timer);
  challenges.delete(from);

  if (!msg.accept) {
    return sendToUser(from, { type: 'challengeResult', to: me, accept: false });
  }
  if (userGame.has(from) || userGame.has(me) || !sockets.has(from)) {
    return sendToUser(from, { type: 'challengeResult', to: me, accept: false, reason: 'unavailable' });
  }
  sendToUser(from, { type: 'challengeResult', to: me, accept: true });
  startGamePair(makeGame(from, me));
}

function handleMove(ws, msg) {
  const username = ws.username;
  const game = userGame.get(username);
  if (!game || game.over) return;
  const color = colorOf(game, username);
  if (game.turn !== color) return send(ws, { type: 'error', message: '还没轮到你' });
  const x = msg.x, y = msg.y;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  if (game.cells[y * SIZE + x] !== EMPTY) return;

  game.cells[y * SIZE + x] = color;
  game.moveCount++;
  const win = winLine(game.cells, x, y);
  const draw = !win && game.moveCount >= SIZE * SIZE;
  if (win || draw) {
    game.over = true;
    game.winner = win ? color : null;
    game.winCells = win;
  } else {
    game.turn = 3 - color;
  }
  const out = { type: 'move', x, y, color, turn: game.turn, win, draw };
  sendToUser(game.players[BLACK], out);
  sendToUser(game.players[WHITE], out);
}

function handleRestart(ws) {
  const username = ws.username;
  const game = userGame.get(username);
  if (!game || !game.over) return;
  if (game.rematchWanted && game.rematchWanted !== username) {
    // Both want a rematch — start it.
    return doRematch(game);
  }
  game.rematchWanted = username;
  sendToUser(opponentOf(game, username), { type: 'rematchOffer', from: username });
}

function handleRestartAnswer(ws, msg) {
  const username = ws.username;
  const game = userGame.get(username);
  if (!game || !game.over || !game.rematchWanted || game.rematchWanted === username) return;
  if (!msg.accept) {
    const offerer = game.rematchWanted;
    game.rematchWanted = null;
    return sendToUser(offerer, { type: 'rematchResult', accept: false });
  }
  doRematch(game);
}

function doRematch(game) {
  game.cells.fill(EMPTY);
  game.moveCount = 0;
  game.turn = BLACK;
  game.over = false;
  game.winner = null;
  game.winCells = null;
  game.rematchWanted = null;
  // Swap colors for fairness.
  const b = game.players[BLACK];
  game.players[BLACK] = game.players[WHITE];
  game.players[WHITE] = b;
  for (const color of [BLACK, WHITE]) {
    sendToUser(game.players[color], { type: 'start', color, opponent: game.players[3 - color] });
  }
}

function handleLeave(ws) {
  const username = ws.username;
  const game = userGame.get(username);
  if (!game) return;
  sendToUser(opponentOf(game, username), { type: 'opponentLeft' });
  destroyGame(game);
}

function handleClose(ws) {
  const username = ws.username;
  if (!username) return;
  if (sockets.get(username) === ws) sockets.delete(username);
  cancelChallengesInvolving(username);

  const game = userGame.get(username);
  if (game) {
    if (game.over) {
      sendToUser(opponentOf(game, username), { type: 'opponentLeft' });
      destroyGame(game);
    } else {
      sendToUser(opponentOf(game, username), { type: 'opponentDisconnected', grace: RECONNECT_GRACE / 1000 });
      const timer = setTimeout(() => {
        game.disconnectTimers.delete(username);
        sendToUser(opponentOf(game, username), { type: 'opponentLeft' });
        destroyGame(game);
      }, RECONNECT_GRACE);
      game.disconnectTimers.set(username, timer);
    }
  }
  broadcastLobby();
}

server.listen(PORT, () => {
  console.log(`五子棋 server running: http://localhost:${PORT}`);
});
