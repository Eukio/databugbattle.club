// Server re-simulation of a ranked log: the verified score plus the inputs for the anomaly flags.
import {
  anomalyFlags, applyOp, createGame, dirDelta, globalTic, stepTic, totalPower, InvalidOpError,
  type LogOp, type GameState,
} from '../../sim/src/index.ts';

export interface ServerVerify {
  valid: boolean;
  reason?: string;
  score: number;
  finalHash: number;
  flags: string[];
}

function cureTarget(st: GameState, op: LogOp): number {
  if (op.op !== 'step') return -1;
  let from: number;
  if (op.path === 'new') from = op.from ?? -1;
  else {
    const p = st.queue.find((q) => q.id === op.path);
    if (!p) return -1;
    from = p.steps.length ? p.steps[p.steps.length - 1].target : p.origin;
  }
  return from < 0 ? -1 : dirDelta(st, from, op.dir);
}

export function verifyRanked(mapSeed: number, bugKeys: number[], log: LogOp[]): ServerVerify {
  const st = createGame({ mapSeed, bugKeys, kind: 'ranked' });
  const queuedCures: { g: number; bug: number }[] = [];
  const curableAt = new Map<number, number>(); // bug id → first tic it can be cured
  let i = 0;
  try {
    while (!st.finished) {
      const g = globalTic(st);
      while (i < log.length && log[i].g <= g) {
        const op = log[i];
        if (op.g < g) throw new InvalidOpError(`op ${i} stamped at tic ${op.g} in the past`);
        if (op.op === 'step' && op.intent === 'cure') {
          const t = cureTarget(st, op);
          if (t >= 0 && st.bugId[t] >= 0) queuedCures.push({ g: op.g, bug: st.bugId[t] });
        }
        applyOp(st, op);
        i++;
      }
      const ev = stepTic(st);
      for (const c of ev.immunityEnded) if (st.bugId[c] >= 0) curableAt.set(st.bugId[c], ev.g + 1);
    }
    if (i < log.length) throw new InvalidOpError(`op ${i} stamped after the run ended`);
  } catch (e) {
    if (e instanceof InvalidOpError) return { valid: false, reason: e.message, score: 0, finalHash: 0, flags: [] };
    throw e;
  }
  const cures = queuedCures.filter((c) => curableAt.has(c.bug)).map((c) => ({ queuedG: c.g, curableG: curableAt.get(c.bug)! }));
  const seen = new Set<number>();
  const gestureTimestampsMs: number[] = [];
  for (const op of log) {
    if (op.gid === undefined || seen.has(op.gid) || typeof op.ts !== 'number') continue;
    seen.add(op.gid);
    gestureTimestampsMs.push(op.ts);
  }
  return { valid: true, score: totalPower(st), finalHash: st.hashes[st.hashes.length - 1] ?? 0, flags: anomalyFlags({ cures, gestureTimestampsMs }) };
}
