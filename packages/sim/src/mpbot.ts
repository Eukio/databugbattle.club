// A simple multiplayer bot (tests and empty-seat filler): cures curable bugs next to strong cells, otherwise
// walks its strongest cell toward the nearest cell it doesn't own, attacking when it can win.
import { CELL, type Dir } from './types.ts';
import { safeLevel } from './game.ts';
import { mpVision, mpApplyOp, sameTeam, type MpOp, type MpState } from './mp.ts';
import { InvalidOpError } from './types.ts';

const DIRS: [Dir, number, number][] = [['U', -1, 0], ['D', 1, 0], ['L', 0, -1], ['R', 0, 1]];

export function mpBotOps(st: MpState, p: number): MpOp[] {
  const P = st.players[p];
  if (!P.alive || st.finished) return [];
  const pending = P.queue.reduce((s, q) => s + q.steps.length - q.executed, 0);
  if (pending > 2) return [];
  const W = st.width, H = st.height, N = W * H;
  const S = safeLevel(st.turn);
  const vis = mpVision(st, p);
  const full = (i: number) => st.power[i] + st.travel[i];
  // Cure first.
  for (let c = 0; c < N; c++) {
    if (st.owner[c] !== p || st.bugId[c] < 0 || st.immunity[c] > 0) continue;
    const r = (c / W) | 0, cc = c % W;
    for (const [d, dr, dc] of DIRS) {
      const nr = r - dr, nc = cc - dc;
      if (nr < 0 || nc < 0 || nr >= H || nc >= W) continue;
      const m = nr * W + nc;
      if (st.owner[m] !== p || st.bugId[m] >= 0 || P.queue.some((q) => q.origin === m)) continue;
      const keep = st.type[m] === CELL.OWNED_DC ? S : 1;
      if (st.power[m] - keep >= st.bugHealth[c]) return [{ op: 'step', path: 'new', from: m, dir: d, intent: 'cure' }];
    }
  }
  let best = -1;
  for (let i = 0; i < N; i++) if (st.owner[i] === p && st.bugId[i] < 0 && (best < 0 || full(i) > full(best))) best = i;
  if (best < 0 || st.power[best] < 3) return [];
  const avail = st.power[best] - (st.type[best] === CELL.OWNED_DC ? S : 1);
  if (avail < 2) return [];
  const prev = new Int32Array(N).fill(-2);
  const dirOf: Dir[] = new Array(N);
  prev[best] = -1;
  const q = [best];
  let goal = -1;
  while (q.length && goal < 0) {
    const u = q.shift()!;
    const r = (u / W) | 0, c = u % W;
    for (const [d, dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= H || nc >= W) continue;
      const v = nr * W + nc;
      if (prev[v] !== -2) continue;
      if (vis[v] && st.type[v] === CELL.MOUNTAIN) continue;
      if (!vis[v] && st.type[v] !== CELL.LAND && st.type[v] !== CELL.OWNED_DC) continue; // fogged obstacle: unknown
      if (st.owner[v] === p && st.bugId[v] >= 0) continue;
      const o = st.owner[v];
      if (o >= 0 && o !== p && sameTeam(st, o, p)) continue;
      const def = vis[v] ? (o < 0 && st.type[v] === CELL.NEUTRAL_DC ? st.cost[v] : o === p ? 0 : full(v)) : 0;
      if (o !== p && def >= avail - 1) continue;
      prev[v] = u;
      dirOf[v] = d;
      if (o !== p) { goal = v; break; }
      q.push(v);
    }
  }
  if (goal < 0) return [];
  const dirs: Dir[] = [];
  for (let v = goal; prev[v] !== -1; v = prev[v]) dirs.push(dirOf[v]);
  dirs.reverse();
  const ops: MpOp[] = [];
  dirs.slice(0, 10).forEach((d, k) => ops.push(k === 0 ? { op: 'step', path: 'new', from: best, dir: d, intent: 'move' } : { op: 'step', path: P.nextPathId, dir: d, intent: 'move' }));
  return ops;
}

/** Apply a bot's ops, ignoring any that no longer apply. */
export function mpBotPlay(st: MpState, p: number): number {
  let applied = 0;
  for (const op of mpBotOps(st, p)) {
    try { mpApplyOp(st, p, op); applied++; } catch (e) { if (!(e instanceof InvalidOpError)) throw e; break; }
  }
  return applied;
}
