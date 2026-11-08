import { applyOp, cloneState, createGame, globalTic, stepTic, totalPower, type GameConfig } from './game.ts';
import { InvalidOpError, type GameState, type LogOp, type StepEvent, type Telemetry } from './types.ts';

export interface QueuePreview {
  paths: {
    id: number;
    mode: GameState['queue'][number]['mode'];
    n: number;
    origin: number;
    steps: { target: number; intent: 'move' | 'cure'; arrival: number; sent: number; fails: boolean; cause?: string; fogged: boolean }[];
    endsAt: number;
  }[];
}

/** Runs the queue on a clone with spawning and spread off; never touches `st`. */
export function preview(st: GameState): QueuePreview {
  const clone = cloneState(st);
  clone.turnLimit = 0; // a preview may run past turn 300; the clone is discarded
  clone.finished = false;
  const byPath = new Map<number, QueuePreview['paths'][number]>();
  for (const p of st.queue) {
    byPath.set(p.id, {
      id: p.id, mode: p.mode, n: p.n, origin: p.origin, endsAt: p.current,
      steps: p.steps.slice(p.executed).map((s) => ({ target: s.target, intent: s.intent, arrival: 0, sent: 0, fails: false, fogged: !st.visible[s.target] })),
    });
  }
  let budget = 0;
  for (const p of st.queue) budget += p.steps.length - p.executed;
  const cursor = new Map<number, number>();
  while (budget-- > 0 && clone.queue.length) {
    const head = clone.queue[0];
    const ev = stepTic(clone, { spawn: false, spread: false });
    const rec = byPath.get(head.id);
    if (!rec || !ev.step) continue;
    const k = cursor.get(head.id) ?? 0;
    cursor.set(head.id, k + 1);
    const s = rec.steps[k];
    if (!s) continue;
    s.arrival = ev.step.arrived;
    s.sent = ev.step.sent;
    if (ev.step.kind === 'fail') { s.fails = true; s.cause = ev.step.cause; }
    else if (ev.step.kind === 'shortAttack' || ev.step.kind === 'partialCure') { s.cause = ev.step.kind; }
    for (const e of ev.endedPaths) { const r = byPath.get(e.id); if (r) r.endsAt = e.at; }
    if (ev.step.kind === 'fail' || ev.step.kind === 'shortAttack' || ev.step.kind === 'partialCure') {
      for (let m = k + 1; m < rec.steps.length; m++) rec.steps[m].fails = true;
    }
  }
  return { paths: [...byPath.values()] };
}

export type VerifyInput = { seed: number } | { mapSeed: number; bugKeys: number[] };

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  score: number;
  hashes: number[];
  telemetry: Telemetry;
}

/** Re-simulates a log. An op stamped in the past, past the end, or that cannot apply makes the log invalid. */
export function verifyLog(input: VerifyInput, log: LogOp[]): VerifyResult {
  const config: GameConfig = 'seed' in input ? { seed: input.seed } : { mapSeed: input.mapSeed, bugKeys: input.bugKeys, kind: 'ranked' };
  const st = createGame(config);
  let i = 0;
  try {
    while (!st.finished) {
      const g = globalTic(st);
      while (i < log.length && log[i].g <= g) {
        if (log[i].g < g) throw new InvalidOpError(`op ${i} stamped at tic ${log[i].g} in the past`);
        applyOp(st, log[i]);
        i++;
      }
      stepTic(st);
    }
    if (i < log.length) throw new InvalidOpError(`op ${i} stamped after the run ended`);
  } catch (e) {
    if (e instanceof InvalidOpError) return { valid: false, reason: e.message, score: 0, hashes: st.hashes, telemetry: st.telemetry };
    throw e;
  }
  return { valid: true, score: totalPower(st), hashes: st.hashes, telemetry: st.telemetry };
}

/** Client-side helper: play a log on an existing state up to and including tic `untilG` (inclusive). */
export function playLog(st: GameState, log: LogOp[], untilG: number, from = 0): number {
  let i = from;
  while (!st.finished && globalTic(st) <= untilG) {
    const g = globalTic(st);
    while (i < log.length && log[i].g <= g) {
      if (log[i].g < g) throw new InvalidOpError(`op ${i} stamped in the past`);
      applyOp(st, log[i]);
      i++;
    }
    stepTic(st);
  }
  return i;
}

export type { StepEvent };
