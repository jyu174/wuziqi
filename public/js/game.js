'use strict';
// Game core: board state, win detection, canvas rendering, screen management,
// and the local game controller for both PvAI and online modes.

const SIZE = 19;
const EMPTY = 0, BLACK = 1, WHITE = 2;

function inBoard(x, y) {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

function winLine(cells, x, y) {
  const color = cells[y * SIZE + x];
  if (!color) return null;
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of dirs) {
    const line = [[x, y]];
    for (const s of [1, -1]) {
      let nx = x + dx * s, ny = y + dy * s;
      while (inBoard(nx, ny) && cells[ny * SIZE + nx] === color) {
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

class Board {
  constructor() {
    this.cells = new Int8Array(SIZE * SIZE);
    this.moves = [];
  }
  get(x, y) { return this.cells[y * SIZE + x]; }
  place(x, y, color) {
    this.cells[y * SIZE + x] = color;
    this.moves.push({ x, y, color });
  }
  undo() {
    const m = this.moves.pop();
    if (m) this.cells[m.y * SIZE + m.x] = EMPTY;
    return m || null;
  }
  get lastMove() { return this.moves.length ? this.moves[this.moves.length - 1] : null; }
  isFull() { return this.moves.length >= SIZE * SIZE; }
  reset() { this.cells.fill(EMPTY); this.moves.length = 0; }
}

// Allow require() from Node for tests; everything below is browser-only.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SIZE, EMPTY, BLACK, WHITE, Board, winLine, inBoard };
}

if (typeof document !== 'undefined') {

// ---------------------------------------------------------------- Rendering

const CELL = 30, MARGIN = 30, BOARD_PX = MARGIN * 2 + CELL * (SIZE - 1);
const STARS = [3, 9, 15];

const Renderer = {
  canvas: null,
  ctx: null,
  hover: null, // {x, y}

  init() {
    this.canvas = document.getElementById('board');
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = BOARD_PX * dpr;
    this.canvas.height = BOARD_PX * dpr;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);
  },

  toGrid(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const scale = BOARD_PX / rect.width;
    const px = (evt.clientX - rect.left) * scale;
    const py = (evt.clientY - rect.top) * scale;
    const x = Math.round((px - MARGIN) / CELL);
    const y = Math.round((py - MARGIN) / CELL);
    if (!inBoard(x, y)) return null;
    return { x, y };
  },

  draw(board, opts = {}) {
    const ctx = this.ctx;
    // Wood background
    ctx.fillStyle = '#d9a95b';
    ctx.fillRect(0, 0, BOARD_PX, BOARD_PX);
    const grad = ctx.createLinearGradient(0, 0, BOARD_PX, BOARD_PX);
    grad.addColorStop(0, 'rgba(255,235,190,0.25)');
    grad.addColorStop(1, 'rgba(120,70,20,0.18)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, BOARD_PX, BOARD_PX);

    // Grid
    ctx.strokeStyle = '#5a4020';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < SIZE; i++) {
      const p = MARGIN + i * CELL;
      ctx.moveTo(MARGIN, p); ctx.lineTo(BOARD_PX - MARGIN, p);
      ctx.moveTo(p, MARGIN); ctx.lineTo(p, BOARD_PX - MARGIN);
    }
    ctx.stroke();

    // Star points
    ctx.fillStyle = '#5a4020';
    for (const sy of STARS) for (const sx of STARS) {
      ctx.beginPath();
      ctx.arc(MARGIN + sx * CELL, MARGIN + sy * CELL, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Stones
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = board.get(x, y);
        if (c) this.drawStone(x, y, c, 1);
      }
    }

    // Hover ghost stone
    if (opts.hover && board.get(opts.hover.x, opts.hover.y) === EMPTY) {
      this.drawStone(opts.hover.x, opts.hover.y, opts.hoverColor || BLACK, 0.4);
    }

    // Last move marker
    const last = board.lastMove;
    if (last) {
      ctx.strokeStyle = '#e03030';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(MARGIN + last.x * CELL, MARGIN + last.y * CELL, 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Winning line highlight
    if (opts.winCells) {
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 3;
      for (const [x, y] of opts.winCells) {
        ctx.beginPath();
        ctx.arc(MARGIN + x * CELL, MARGIN + y * CELL, CELL * 0.44, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  },

  drawStone(x, y, color, alpha) {
    const ctx = this.ctx;
    const cx = MARGIN + x * CELL, cy = MARGIN + y * CELL, r = CELL * 0.44;
    ctx.save();
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.15, cx, cy, r);
    if (color === BLACK) {
      g.addColorStop(0, '#666');
      g.addColorStop(1, '#0a0a0a');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#c8c8c8');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();
  },
};

// ---------------------------------------------------------------- App shell (screens, modal, status)

const App = {
  user: null,

  $(id) { return document.getElementById(id); },

  show(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
    this.$('screen-' + name).classList.remove('hidden');
  },

  setStatus(text) { this.$('game-status').textContent = text; },

  banner(text) {
    const b = this.$('banner');
    if (!text) return b.classList.add('hidden');
    this.$('banner-text').textContent = text;
    b.classList.remove('hidden');
  },

  _modalCb: null,
  modal(text, okText, cancelText, cb) {
    this.$('modal-text').textContent = text;
    const ok = this.$('modal-ok'), cancel = this.$('modal-cancel');
    ok.textContent = okText;
    if (cancelText) {
      cancel.textContent = cancelText;
      cancel.classList.remove('hidden');
    } else {
      cancel.classList.add('hidden');
    }
    this._modalCb = cb || null;
    this.$('modal').classList.remove('hidden');
  },
  closeModal(result) {
    this.$('modal').classList.add('hidden');
    const cb = this._modalCb;
    this._modalCb = null;
    if (cb) cb(result);
  },
};

// ---------------------------------------------------------------- Game controller

const Game = {
  board: new Board(),
  mode: null,       // 'ai' | 'online'
  level: 'normal',
  myColor: BLACK,
  turn: BLACK,
  over: false,
  winCells: null,
  thinking: false,
  opponent: null,   // username, online mode
  statSent: false,  // AI mode: at most one recorded result per board

  colorName(c) { return c === BLACK ? '⚫ 黑方' : '⚪ 白方'; },

  render() {
    Renderer.draw(this.board, {
      hover: (!this.over && !this.thinking && this.turn === this.myColor) ? Renderer.hover : null,
      hoverColor: this.myColor,
      winCells: this.winCells,
    });
  },

  updateStatus() {
    if (this.over) return;
    let who;
    if (this.mode === 'ai') {
      who = this.turn === this.myColor ? '你' : '电脑';
      if (this.thinking) return App.setStatus('🤔 电脑思考中… AI thinking…');
    } else {
      who = this.turn === this.myColor ? '你' : this.opponent;
    }
    App.setStatus(`${this.colorName(this.turn)} 回合 · ${who}`);
  },

  // ----- shared game flow -----

  startLocal(level, myColor) {
    this.mode = 'ai';
    this.level = level;
    this.myColor = myColor;
    this.resetBoard();
    App.$('btn-undo').classList.remove('hidden');
    App.$('btn-newgame').classList.remove('hidden');
    App.show('game');
    this.render();
    this.updateStatus();
    if (this.myColor === WHITE) this.aiTurn();
  },

  startOnline(color, opponent) {
    this.mode = 'online';
    this.myColor = color;
    this.opponent = opponent;
    this.resetBoard();
    App.$('btn-undo').classList.add('hidden');
    App.$('btn-newgame').classList.add('hidden');
    App.show('game');
    this.render();
    App.setStatus(`对手：${opponent} · 你执${this.myColor === BLACK ? '黑 ⚫（先行）' : '白 ⚪'}`);
    setTimeout(() => this.updateStatus(), 1500);
  },

  resetBoard() {
    this.board.reset();
    this.turn = BLACK;
    this.over = false;
    this.winCells = null;
    this.thinking = false;
    this.statSent = false;
    App.banner(null);
  },

  finish(winnerColor, win, draw) {
    this.over = true;
    this.winCells = win || null;
    this.render();
    if (draw) {
      App.setStatus('平局 Draw');
      App.banner('平局 Draw');
      return;
    }
    const iWon = winnerColor === this.myColor;
    if (this.mode === 'ai' && App.user && !this.statSent) {
      this.statSent = true;
      Auth.api('POST', '/api/ai-result', { result: iWon ? 'win' : 'loss' }, true).catch(() => {});
    }
    const winnerName = this.mode === 'ai'
      ? (iWon ? '你' : '电脑')
      : (iWon ? '你' : this.opponent);
    App.setStatus(`${this.colorName(winnerColor)}（${winnerName}）获胜！`);
    App.banner(iWon ? '🎉 你赢了! You win!' : (this.mode === 'ai' ? '💻 电脑获胜 AI wins' : `${this.opponent} 获胜`));
    if (this.mode === 'online') App.$('btn-newgame').classList.remove('hidden');
  },

  finishDraw() { this.finish(null, null, true); },

  handleClick(x, y) {
    if (this.over || this.thinking) return;
    if (this.turn !== this.myColor) return;
    if (this.board.get(x, y) !== EMPTY) return;

    if (this.mode === 'online') {
      // Server-authoritative: send and wait for the echo.
      Net.sendMove(x, y);
      return;
    }

    this.applyMove(x, y, this.myColor);
    if (!this.over) this.aiTurn();
  },

  applyMove(x, y, color) {
    this.board.place(x, y, color);
    const win = winLine(this.board.cells, x, y);
    if (win) {
      this.finish(color, win, false);
    } else if (this.board.isFull()) {
      this.finishDraw();
    } else {
      this.turn = 3 - color;
      this.render();
      this.updateStatus();
    }
  },

  // ----- PvAI -----

  aiTurn() {
    this.thinking = true;
    this.updateStatus();
    this.render();
    const aiColor = 3 - this.myColor;
    setTimeout(() => {
      const move = AI.chooseMove(this.board.cells, aiColor, this.level);
      this.thinking = false;
      if (move) this.applyMove(move.x, move.y, aiColor);
    }, 120);
  },

  undo() {
    if (this.mode !== 'ai' || this.thinking) return;
    if (!this.board.moves.some((m) => m.color === this.myColor)) return;
    // Remove AI replies until the last move is the player's, then remove it too.
    while (this.board.lastMove && this.board.lastMove.color !== this.myColor) this.board.undo();
    this.board.undo();
    this.over = false;
    this.winCells = null;
    this.turn = this.myColor;
    App.banner(null);
    this.render();
    this.updateStatus();
  },

  newGame() {
    if (this.mode === 'ai') {
      this.resetBoard();
      this.render();
      this.updateStatus();
      if (this.myColor === WHITE) this.aiTurn();
    } else if (this.mode === 'online' && this.over) {
      Net.offerRematch();
    }
  },

  leave() {
    if (this.mode === 'online') {
      if (!this.over) {
        App.modal('对局尚未结束，确定要离开吗？', '离开 Leave', '取消 Cancel', (ok) => {
          if (ok) Net.leaveGame();
        });
        return;
      }
      Net.leaveGame();
      return;
    }
    App.show('menu');
  },
};

// ---------------------------------------------------------------- Wiring

window.addEventListener('DOMContentLoaded', () => {
  Renderer.init();

  Renderer.canvas.addEventListener('click', (e) => {
    const p = Renderer.toGrid(e);
    if (p) Game.handleClick(p.x, p.y);
  });
  Renderer.canvas.addEventListener('mousemove', (e) => {
    const p = Renderer.toGrid(e);
    const h = Renderer.hover;
    if ((p && h && p.x === h.x && p.y === h.y) || (!p && !h)) return;
    Renderer.hover = p;
    Game.render();
  });
  Renderer.canvas.addEventListener('mouseleave', () => {
    Renderer.hover = null;
    Game.render();
  });

  App.$('btn-start-ai').addEventListener('click', () => {
    const level = document.querySelector('input[name="ai-level"]:checked').value;
    const color = document.querySelector('input[name="ai-color"]:checked').value;
    Game.startLocal(level, color === 'black' ? BLACK : WHITE);
  });

  App.$('btn-undo').addEventListener('click', () => Game.undo());
  App.$('btn-newgame').addEventListener('click', () => Game.newGame());
  App.$('btn-leave').addEventListener('click', () => Game.leave());

  App.$('modal-ok').addEventListener('click', () => App.closeModal(true));
  App.$('modal-cancel').addEventListener('click', () => App.closeModal(false));
});

window.App = App;
window.Game = Game;

} // end browser-only block
