'use strict';
// AI engine for PvAI mode. Self-contained (no dependency on game.js) so it can
// also be loaded in Node for testing.

const AI = (() => {
  const SIZE = 19;
  const EMPTY = 0;
  const WIN = 10000000;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  function inB(x, y) {
    return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  }

  // Score for a run of `count` stones (including a hypothetical stone) with
  // `open` open ends, from the perspective of the player making it.
  function patternScore(count, open) {
    if (count >= 5) return WIN;
    if (open === 0) return 0;
    switch (count) {
      case 4: return open === 2 ? 100000 : 10000;
      case 3: return open === 2 ? 5000 : 500;
      case 2: return open === 2 ? 200 : 50;
      default: return open === 2 ? 20 : 5;
    }
  }

  // Value of placing `color` at empty (x, y): sum of resulting runs in 4 directions.
  function pointScore(cells, x, y, color) {
    let total = 0;
    for (const [dx, dy] of DIRS) {
      let count = 1, open = 0;
      for (const s of [1, -1]) {
        let nx = x + dx * s, ny = y + dy * s;
        while (inB(nx, ny) && cells[ny * SIZE + nx] === color) {
          count++;
          nx += dx * s;
          ny += dy * s;
        }
        if (inB(nx, ny) && cells[ny * SIZE + nx] === EMPTY) open++;
      }
      total += patternScore(count, open);
    }
    return total;
  }

  // Empty cells within Chebyshev distance 2 of any stone (center if board empty).
  function candidates(cells) {
    const seen = new Uint8Array(SIZE * SIZE);
    const list = [];
    let any = false;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (!cells[y * SIZE + x]) continue;
        any = true;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (!inB(nx, ny)) continue;
            const i = ny * SIZE + nx;
            if (cells[i] === EMPTY && !seen[i]) {
              seen[i] = 1;
              list.push({ x: nx, y: ny });
            }
          }
        }
      }
    }
    if (!any) {
      const c = Math.floor(SIZE / 2);
      return [{ x: c, y: c }];
    }
    return list;
  }

  // Static evaluation of the whole board from `me`'s perspective.
  function runScore(len, open) {
    if (len >= 5) return WIN;
    if (open === 0) return 0;
    if (len === 4) return open === 2 ? 50000 : 8000;
    if (len === 3) return open === 2 ? 3000 : 300;
    if (len === 2) return open === 2 ? 100 : 20;
    return open === 2 ? 5 : 1;
  }

  function evaluate(cells, me) {
    const scores = [0, 0, 0];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = cells[y * SIZE + x];
        if (!c) continue;
        for (const [dx, dy] of DIRS) {
          const px = x - dx, py = y - dy;
          if (inB(px, py) && cells[py * SIZE + px] === c) continue; // not a run start
          let len = 0, nx = x, ny = y;
          while (inB(nx, ny) && cells[ny * SIZE + nx] === c) {
            len++;
            nx += dx;
            ny += dy;
          }
          let open = 0;
          if (inB(px, py) && cells[py * SIZE + px] === EMPTY) open++;
          if (inB(nx, ny) && cells[ny * SIZE + nx] === EMPTY) open++;
          scores[c] += runScore(len, open);
        }
      }
    }
    // The side to move gets a small initiative bonus.
    return scores[me] * 1.1 - scores[3 - me];
  }

  // Candidates scored by attack + defense value, sorted best-first.
  function scoredCandidates(cells, me, defenseWeight) {
    const opp = 3 - me;
    const list = candidates(cells);
    const out = [];
    for (const { x, y } of list) {
      const attack = pointScore(cells, x, y, me);
      const defend = pointScore(cells, x, y, opp);
      out.push({ x, y, attack, defend, h: attack + defenseWeight * defend });
    }
    out.sort((a, b) => b.h - a.h);
    return out;
  }

  // Immediate tactics shared by all levels: win now, else block an opponent five.
  function forcedMove(scored) {
    const winning = scored.filter((m) => m.attack >= WIN);
    if (winning.length) return winning[0];
    const blocks = scored.filter((m) => m.defend >= WIN);
    if (blocks.length) {
      // Block wherever our own position gains the most.
      blocks.sort((a, b) => b.attack - a.attack);
      return blocks[0];
    }
    return null;
  }

  // ----- Levels -----

  function easyMove(cells, me) {
    const scored = scoredCandidates(cells, me, 0.4);
    const forced = forcedMove(scored);
    if (forced) return forced;
    // Random-weighted pick among the top moves: usually decent, often imperfect.
    const pool = scored.slice(0, 8);
    const weights = pool.map((_, i) => Math.max(1, 8 - i * 1.5));
    let total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[0];
  }

  function normalMove(cells, me) {
    const scored = scoredCandidates(cells, me, 0.9);
    const forced = forcedMove(scored);
    if (forced) return forced;
    // Argmax with a random tie-break among near-equal moves.
    const best = scored[0].h;
    const top = scored.filter((m) => m.h >= best * 0.999);
    return top[Math.floor(Math.random() * top.length)];
  }

  const DEPTH = 6, BRANCH = 8;
  const OPEN_FOUR = 100000, FOUR = 10000;

  // Moves worth searching at a node. When the opponent threatens an open four
  // (or better), only blocking that cell or making our own four can matter.
  function movesToSearch(scored) {
    if (scored[0] && scored.some((m) => m.defend >= OPEN_FOUR)) {
      const urgent = scored.filter((m) => m.defend >= OPEN_FOUR || m.attack >= FOUR);
      if (urgent.length) return urgent.slice(0, BRANCH);
    }
    return scored.slice(0, BRANCH);
  }

  function negamax(cells, depth, alpha, beta, me) {
    const scored = scoredCandidates(cells, me, 1.0);
    if (!scored.length) return 0;
    // If any move completes five, this node is won — check the full list (the
    // h-sort can rank a blocking cell above a winning one). Because winning
    // moves short-circuit here, a child position never contains an unnoticed
    // five by the parent.
    for (const m of scored) {
      if (m.attack >= WIN) return WIN + depth; // prefer faster wins
    }
    if (depth === 0) return evaluate(cells, me);

    let best = -Infinity;
    for (const m of movesToSearch(scored)) {
      const i = m.y * SIZE + m.x;
      cells[i] = me;
      const v = -negamax(cells, depth - 1, -beta, -alpha, 3 - me);
      cells[i] = EMPTY;
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }

  function hardMove(cellsInput, me) {
    const cells = cellsInput.slice();
    const scored = scoredCandidates(cells, me, 1.0);
    const forced = forcedMove(scored);
    if (forced) return forced;

    let bestMove = scored[0];
    let alpha = -Infinity;
    for (const m of movesToSearch(scored)) {
      const i = m.y * SIZE + m.x;
      cells[i] = me;
      const v = -negamax(cells, DEPTH - 1, -Infinity, -alpha, 3 - me);
      cells[i] = EMPTY;
      if (v > alpha) {
        alpha = v;
        bestMove = m;
      }
    }
    return bestMove;
  }

  function chooseMove(cells, color, level) {
    const work = cells.slice();
    let m;
    if (level === 'easy') m = easyMove(work, color);
    else if (level === 'hard') m = hardMove(work, color);
    else m = normalMove(work, color);
    return m ? { x: m.x, y: m.y } : null;
  }

  return {
    chooseMove,
    _test: { negamax, scoredCandidates, evaluate, pointScore, candidates, forcedMove, WIN, DEPTH, BRANCH },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AI;
}
