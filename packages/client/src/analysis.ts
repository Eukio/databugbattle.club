// Read-only analysis for the UI: statuses with their "Shows" text, weakest cells, drain warnings,
// spread targets, and the queue projection used for cure numbers. Never mutates the live state.
import {
  CELL, cloneState, computeSnapshot, cureToProtect, dcStatus, fullPower, safeLevel, stepTic, neighbors4,
  type DCStatus, type GameState, type Snapshot,
} from './sim.ts';
import { rc } from './ui/dom.ts';

/** Widest (max-bottleneck) path from `from` to `to` through owned, non-frozen cells; both endpoints may be frozen. */
export function widestPath(st: GameState, from: number, to: number): number[] | null {
  const n = st.width * st.height;
  const best = new Int32Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const ok = (c: number) => st.owned[c] === 1 && (st.bugId[c] < 0 || c === to || c === from);
  best[from] = fullPower(st, from);
  const nb = [0, 0, 0, 0];
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && best[i] >= 0 && (u < 0 || best[i] > best[u])) u = i;
    if (u < 0) return null;
    if (u === to) break;
    done[u] = 1;
    if (u !== from && st.bugId[u] >= 0) continue; // a frozen endpoint never relays
    const k = neighbors4(st, u, nb);
    for (let q = 0; q < k; q++) {
      const v = nb[q];
      if (done[v] || !ok(v)) continue;
      const b = Math.min(best[u], fullPower(st, v));
      if (b > best[v]) { best[v] = b; prev[v] = u; }
    }
  }
  const path: number[] = [];
  for (let c = to; c >= 0; c = prev[c]) { path.push(c); if (c === from) break; }
  return path.reverse();
}

/** The weakest cell on a path (lowest power; first one on ties). */
export function weakestCell(st: GameState, path: number[]): number {
  let w = path[0];
  for (const c of path) if (fullPower(st, c) < fullPower(st, w)) w = c;
  return w;
}

/** The healthy DC giving `i` its best link, or −1. */
export function bestLinkPartner(st: GameState, A: Snapshot, i: number): number {
  const links = A.links.get(i);
  return links && links.length ? links[0].j : -1;
}

export interface StatusInfo { status: DCStatus; text: string; weakest: number | null }

export function statusInfo(st: GameState, A: Snapshot, i: number, projected?: { st: GameState; A: Snapshot }): StatusInfo {
  const status = dcStatus(st, A, i);
  const S = safeLevel(A.turn);
  const w = st.width;
  const stack = fullPower(st, i);
  const best = A.bestLink[i];
  const weak = () => {
    const j = bestLinkPartner(st, A, i);
    if (j < 0) return null;
    const p = widestPath(st, i, j);
    return p ? weakestCell(st, p) : null;
  };
  switch (status) {
    case 'safe':
      return { status, text: `Stack ${stack} and best link ${best} are at or above the safe level ${S}.`, weakest: null };
    case 'vulnerable': {
      const wk = weak();
      return { status, text: `Link power missing: ${S - best}${wk !== null ? ` · weakest cell ${rc(wk, w)}` : ' · no link to another DC'}.`, weakest: wk };
    }
    case 'exposed':
      return { status, text: `Needs ${S - stack} more power to reach the safe level ${S}.`, weakest: null };
    case 'cureNeeded': {
      const P = projected ?? { st, A };
      const h = P.st.bugHealth[i];
      if (h <= 0) return { status, text: 'The queued cure clears this bug.', weakest: null };
      const ctp = cureToProtect(P.st, P.A, i);
      const queued = projected && projected.st.bugHealth[i] !== st.bugHealth[i] ? ' (after queued cures)' : '';
      return { status, text: `Cure ${ctp} to restore protection, ${h} to cure fully${queued}.`, weakest: null };
    }
    case 'unprotected': {
      const wk = weak();
      const h = st.bugHealth[i];
      return { status, text: `Corridor power missing: ${h + 1 - best}${wk !== null ? ` · weakest cell ${rc(wk, w)}` : ''}.`, weakest: wk };
    }
    case 'atRisk': {
      const m = best - st.bugHealth[i];
      const turns = Math.max(0, st.nextGrowth[i] - A.turn) + 3 * (m - 1);
      return { status, text: `Margin ${m}. Growth breaks protection in about ${turns} turn${turns === 1 ? '' : 's'}.`, weakest: null };
    }
    case 'protected':
      return { status, text: `Margin ${best - st.bugHealth[i]}.`, weakest: null };
  }
}

/** Runs the queue to the end on a clone (no spawns, no spread), like the preview, and returns the clone and its snapshot. */
export function projectQueue(st: GameState): { st: GameState; A: Snapshot } {
  const c = cloneState(st);
  c.turnLimit = 0;
  c.finished = false;
  let budget = 0;
  for (const p of c.queue) budget += p.steps.length - p.executed;
  while (budget-- > 0 && c.queue.length) stepTic(c, { spawn: false, spread: false });
  return { st: c, A: computeSnapshot(c) };
}

/** Healthy DCs a queued step would leave below S(t) (doc §Drain warning). Auto never does this. */
export function drainWarnings(st: GameState): Set<number> {
  const out = new Set<number>();
  const S = safeLevel(st.turn);
  const isHealthyDC = (c: number) => st.type[c] === CELL.OWNED_DC && st.bugId[c] < 0;
  for (const p of st.queue) {
    if (p.executed === 0 && isHealthyDC(p.origin)) {
      const stack = fullPower(st, p.origin);
      const keep = p.mode === 'half' ? Math.ceil(stack / 2) : p.mode === 'keep' ? p.n : p.mode === 'all1' ? 1 : S;
      if (keep < S && stack >= 1) out.add(p.origin);
    }
    if (p.mode === 'all1') {
      // Gathering strips every cell it passes, DCs included.
      const from = p.executed;
      for (let k = Math.max(0, from); k < p.steps.length - 1; k++) {
        const c = p.steps[k].target;
        if (isHealthyDC(c)) out.add(c);
      }
    }
  }
  return out;
}

/** Owned, non-frozen land cells at or below a neighbouring land bug's health (doc §Land and spread). */
export function spreadTargets(st: GameState): Set<number> {
  const out = new Set<number>();
  const n = st.width * st.height;
  const nb = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (st.bugId[i] < 0 || st.type[i] !== CELL.LAND) continue;
    const h = st.bugHealth[i];
    const k = neighbors4(st, i, nb);
    for (let q = 0; q < k; q++) {
      const m = nb[q];
      if (st.owned[m] && st.type[m] === CELL.LAND && st.bugId[m] < 0 && fullPower(st, m) <= h) out.add(m);
    }
  }
  return out;
}

export const spawnWeight = (bBest: number) => Math.max(1, Math.floor(1000 / (1 + bBest)));

/** Production per turn (in power) of a working DC from its links in snapshot A. */
export function productionRate(st: GameState, A: Snapshot, i: number): number {
  const Tm = Math.max(1000, 100 * A.turn);
  let sum = 0;
  for (const { b } of A.links.get(i) ?? []) sum += b * 1000 >= Tm ? 1000 : Math.floor((b * 1000000) / Tm);
  void st;
  return (2000 + Math.floor((100 * sum) / 1000)) / 1000;
}

/** Amount a new path from `cell` would send on its first step with the given mode. */
export function firstSend(st: GameState, cell: number, mode: 'auto' | 'half' | 'keep' | 'all1', n: number): number {
  const stack = st.power[cell];
  switch (mode) {
    case 'auto': return st.type[cell] === CELL.OWNED_DC ? stack - safeLevel(st.turn) : stack - 1;
    case 'half': return Math.floor(stack / 2);
    case 'keep': return stack - n;
    case 'all1': return stack - 1;
  }
}
