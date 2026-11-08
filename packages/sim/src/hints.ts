// Browser-safe tutorial helpers: the tutorial ids and hint triggers. The Node file loader is in tutorials.ts.
import type { GameState, TicEvents } from './types.ts';

export const TUTORIAL_IDS = ['t1-capture', 't2-safe-level', 't3-land-bugs'] as const;

/**
 * Which hint triggers a tic's events satisfy, in the doc's order. Each fires at most once; the
 * caller is responsible for `start`, `select` and `queued` (input events) and for `turn:N`
 * (fired before tic 1 of turn N: check `st.tic === 0 && st.turn === N` before calling stepTic).
 */
export function hintTriggers(st: GameState, ev: TicEvents): string[] {
  const out: string[] = [];
  const fire = (name: string) => { if (!st.hintsReached.includes(name)) { st.hintsReached.push(name); out.push(name); } };
  if (ev.step?.kind === 'capture') fire('captured');
  if (ev.spawns.length) fire('bugSpawned');
  if (ev.immunityEnded.length) fire('curable');
  if (ev.protectedNow.length) fire('protected');
  if (ev.step?.kind === 'cure') fire('cured');
  if (ev.spreads.length) fire('spread');
  if (ev.goalMet) fire('complete');
  return out;
}
