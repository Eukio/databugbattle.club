// localStorage with try/catch everywhere (private windows, blocked storage); falls back to memory.
import type { KV, LogOp } from './sim.ts';

const mem = new Map<string, string>();
export const kv: KV = {
  getItem(k) { try { const v = localStorage.getItem(k); if (v !== null) return v; } catch { /* blocked */ } return mem.get(k) ?? null; },
  setItem(k, v) { mem.set(k, v); try { localStorage.setItem(k, v); } catch { /* quota or blocked */ } },
  removeItem(k) { mem.delete(k); try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

export const getName = () => kv.getItem('dcg.name');
export const setName = (n: string) => kv.setItem('dcg.name', n);
export const getToken = () => kv.getItem('dcg.token');
export const setToken = (t: string | null) => (t ? kv.setItem('dcg.token', t) : kv.removeItem('dcg.token'));

export const tutorialDone = (id: string) => kv.getItem(`dcg.tut.${id}`) === '1';
export const markTutorialDone = (id: string) => kv.setItem(`dcg.tut.${id}`, '1');

export const NAME_RE = /^[A-Za-z0-9 _-]{2,16}$/;

/** Crash-recovery backup of the ranked run in progress (doc §Crash recovery). */
export interface RankedBackup {
  runId: number;
  date: string;
  mapSeed: number;
  keys: Record<string, number>;
  log: LogOp[];
  tics: number; // tics executed
  sent: number; // ops the server has acknowledged receiving (sent in a message)
}
export function saveRankedBackup(b: RankedBackup): void { kv.setItem('dcg.ranked', JSON.stringify(b)); }
export function loadRankedBackup(): RankedBackup | null {
  const v = kv.getItem('dcg.ranked');
  if (!v) return null;
  try { return JSON.parse(v) as RankedBackup; } catch { return null; }
}
export function clearRankedBackup(): void { kv.removeItem('dcg.ranked'); }

/** Last ranked run kept for "Watch my replay" from the results screen. */
export function saveRankedReplay(date: string, data: { mapSeed: number; bugKeys: number[]; log: LogOp[]; score: number }): void {
  kv.setItem(`dcg.rankedlog.${date}`, JSON.stringify(data));
}
export function loadRankedReplay(date: string): { mapSeed: number; bugKeys: number[]; log: LogOp[]; score: number } | null {
  const v = kv.getItem(`dcg.rankedlog.${date}`);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
