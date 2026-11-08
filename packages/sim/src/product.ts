// Product semantics that the doc left open, resolved here so client and server share one answer.
// See DECISIONS.md items 10–12.
import { seedToHex } from './rng.ts';
import { createGame, type GameConfig } from './game.ts';
import type { GameState, LogOp } from './types.ts';

/** Minimal key-value store (localStorage on the client, a Map in tests). */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoredRun {
  seed: string; // 8 hex digits
  score: number;
  log: LogOp[];
  finishedAt: number; // Unix ms, client clock; display only
  bugKeys?: number[]; // present only for a practice run of a past daily seed
}

const PB = (seed: string) => `dcg.pb.${seed}`;
const PB_LOG = (seed: string) => `dcg.pblog.${seed}`;
const LAST = (seed: string) => `dcg.last.${seed}`;

/** Personal best score for a practice seed, or null. */
export function getPracticeBest(kv: KV, seedHex: string): number | null {
  const v = kv.getItem(PB(seedHex));
  return v === null ? null : Number(v);
}

export function getPracticeBestRun(kv: KV, seedHex: string): StoredRun | null {
  const v = kv.getItem(PB_LOG(seedHex));
  return v === null ? null : (JSON.parse(v) as StoredRun);
}

export function getLastPracticeRun(kv: KV, seedHex: string): StoredRun | null {
  const v = kv.getItem(LAST(seedHex));
  return v === null ? null : (JSON.parse(v) as StoredRun);
}

/**
 * Decision 11: every practice run's log is kept as "last run" for that seed (what "Watch my replay"
 * plays); the personal-best run's log is kept separately and only replaced when beaten. Retry never
 * erases a best.
 */
export function recordPracticeRun(kv: KV, run: StoredRun): { isNewBest: boolean; previousBest: number | null } {
  const previousBest = getPracticeBest(kv, run.seed);
  kv.setItem(LAST(run.seed), JSON.stringify(run));
  const isNewBest = previousBest === null || run.score > previousBest;
  if (isNewBest) {
    kv.setItem(PB(run.seed), String(run.score));
    kv.setItem(PB_LOG(run.seed), JSON.stringify(run));
  }
  return { isNewBest, previousBest };
}

/**
 * Decision 10: "Practice this seed" on a past daily replays the real day — same map and the same
 * published bug keys — so the practice run is comparable with the leaderboard. A typed or random
 * seed uses the plain seed for every stream.
 */
export function practiceConfig(seed: number, publishedBugKeys?: number[]): GameConfig {
  if (publishedBugKeys && publishedBugKeys.length) return { mapSeed: seed, bugKeys: publishedBugKeys, kind: 'practice' };
  return { seed };
}

export function createPracticeGame(seed: number, publishedBugKeys?: number[]): GameState {
  return createGame(practiceConfig(seed, publishedBugKeys));
}

export type RunStatus = 'active' | 'finished' | 'abandoned' | 'invalid';

/**
 * Decision 12: only runs the player actually finished rank on the daily leaderboard. Abandoned runs
 * get a verified score (shown privately on the Daily screen) but never a rank, so a crash does not
 * put a half-played run on the board. The player still cannot replay the day (one attempt).
 */
export function isRankable(status: RunStatus): boolean {
  return status === 'finished';
}

/** The SQL the server uses for the board, consistent with isRankable and the doc's tie rule. */
export const LEADERBOARD_SQL =
  `SELECT id, token, verified_score AS score, finished FROM runs
   WHERE date = ? AND status = 'finished' AND verified_score IS NOT NULL
   ORDER BY verified_score DESC, finished ASC LIMIT ?`;

/**
 * Anomaly flags (design doc §Ranked daily seed). `cures` pairs each queued cure with the tic its bug became curable.
 * "Within one tic" is read both ways: a cure planned well ahead of the window (queued while the bug is still immune)
 * is not a reaction and does not count as fast.
 */
export function anomalyFlags(input: {
  cures: { queuedG: number; curableG: number }[];
  gestureTimestampsMs: number[]; // wall-clock per distinct gid, in order
}): string[] {
  const flags: string[] = [];
  if (input.cures.length >= 10) {
    const fast = input.cures.filter((c) => Math.abs(c.queuedG - c.curableG) <= 1).length;
    if (fast / input.cures.length >= 0.8) flags.push('instant_cures');
  }
  const ts = input.gestureTimestampsMs;
  if (ts.length >= 2) {
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
    const median = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
    if (median < 80) flags.push('fast_gestures');
  }
  return flags;
}

export { seedToHex };
