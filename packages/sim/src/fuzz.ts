// Fuzz player driven by stream 9 (golden-log generator, test tooling only). Slot assignments:
//   0 act? (1/2)   1 new-vs-extend (3/10 new)   2 origin among owned cells   3 mode (4)
//   4 direction (4)   5 clear? (1/50)   6 remove? (1/100)   7 which path to remove
import { STREAM, uniform } from './rng.ts';
import { applyOp, createGame, globalTic, safeLevel, stepTic, dirDelta, type GameConfig } from './game.ts';
import { isFrozen } from './connectivity.ts';
import { CELL, InvalidOpError, type Dir, type GameState, type LogOp, type SplitMode } from './types.ts';

const DIRS: Dir[] = ['U', 'D', 'L', 'R'];
const MODES: SplitMode[] = ['auto', 'half', 'keep', 'all1'];

export function fuzzOps(st: GameState, fuzzSeed: number): LogOp[] {
  const g = globalTic(st);
  const ops: LogOp[] = [];
  const u = (slot: number, n: number) => uniform(fuzzSeed, STREAM.GOLDEN, g, slot, n);
  if (st.queue.length && u(5, 50) === 0) { ops.push({ g, op: 'clear', gid: g * 4 }); return ops; }
  if (st.queue.length && u(6, 100) === 0) {
    const p = st.queue[u(7, st.queue.length)];
    ops.push({ g, op: 'removePath', path: p.id, gid: g * 4 + 1 });
    return ops;
  }
  if (u(0, 2) === 0) return ops;
  const last = st.queue.length ? st.queue[st.queue.length - 1] : undefined;
  const useNew = !last || u(1, 10) < 3;
  let from: number;
  let base: LogOp;
  if (useNew) {
    const owned: number[] = [];
    for (let i = 0; i < st.width * st.height; i++) if (st.owned[i]) owned.push(i);
    from = owned[u(2, owned.length)];
    const mode = MODES[u(3, 4)];
    base = { g, op: 'step', path: 'new', from, dir: 'U', intent: 'move', mode, n: mode === 'keep' ? safeLevel(st.turn) : undefined, gid: g * 4 + 2 };
  } else {
    from = last!.steps.length ? last!.steps[last!.steps.length - 1].target : last!.origin;
    base = { g, op: 'step', path: last!.id, dir: 'U', intent: 'move', gid: g * 4 + 2 };
  }
  const dir = DIRS[u(4, 4)];
  const target = dirDelta(st, from, dir);
  if (target < 0 || (st.visible[target] && st.type[target] === CELL.MOUNTAIN)) return ops;
  base.dir = dir;
  base.intent = isFrozen(st, target) ? 'cure' : 'move';
  ops.push(base);
  return ops;
}

/** Plays a whole run with the fuzz player; returns the log and the finished state. */
export function fuzzRun(config: GameConfig, fuzzSeed: number, onTurn?: (st: GameState) => void): { log: LogOp[]; st: GameState } {
  const st = createGame(config);
  const log: LogOp[] = [];
  while (!st.finished) {
    for (const op of fuzzOps(st, fuzzSeed)) {
      try { applyOp(st, op); log.push(op); } catch (e) { if (!(e instanceof InvalidOpError)) throw e; }
    }
    const ev = stepTic(st);
    if (ev.turnResolved && onTurn) onTurn(st);
  }
  return { log, st };
}
