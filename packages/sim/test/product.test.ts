import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordPracticeRun, getPracticeBest, getPracticeBestRun, getLastPracticeRun, practiceConfig, isRankable, anomalyFlags, hexToSeed, seedToHex,
  type KV,
} from '../src/index.ts';

const mem = (): KV => { const m = new Map<string, string>(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };

test('practice replay storage: last run always kept, best run only replaced when beaten (decision 11)', () => {
  const kv = mem();
  const seed = 'DEADBEEF';
  assert.equal(getPracticeBest(kv, seed), null);
  let r = recordPracticeRun(kv, { seed, score: 500, log: [{ g: 0, op: 'clear' }], finishedAt: 1 });
  assert.deepEqual(r, { isNewBest: true, previousBest: null });
  r = recordPracticeRun(kv, { seed, score: 300, log: [], finishedAt: 2 });
  assert.deepEqual(r, { isNewBest: false, previousBest: 500 });
  assert.equal(getPracticeBest(kv, seed), 500);
  assert.equal(getPracticeBestRun(kv, seed)!.finishedAt, 1, 'Retry did not erase the best run');
  assert.equal(getLastPracticeRun(kv, seed)!.finishedAt, 2, 'Watch my replay shows the run just played');
  recordPracticeRun(kv, { seed, score: 500, log: [], finishedAt: 3 });
  assert.equal(getPracticeBestRun(kv, seed)!.finishedAt, 1, 'a tie does not replace the best');
});

test('practice this seed: published keys replay the real day; typed seeds use the plain seed (decision 10)', () => {
  assert.deepEqual(practiceConfig(5), { seed: 5 });
  assert.deepEqual(practiceConfig(5, [1, 2, 3]), { mapSeed: 5, bugKeys: [1, 2, 3], kind: 'practice' });
  assert.equal(hexToSeed(seedToHex(0xdeadbeef)), 0xdeadbeef);
});

test('only finished runs rank (decision 12); anomaly flags use gestures', () => {
  assert.equal(isRankable('finished'), true);
  assert.equal(isRankable('abandoned'), false);
  assert.equal(isRankable('active'), false);
  const cures = Array.from({ length: 10 }, (_, i) => ({ queuedG: 100 + i * 10, curableG: 100 + i * 10 - (i < 9 ? 1 : 5) }));
  assert.deepEqual(anomalyFlags({ cures, gestureTimestampsMs: [0, 200, 400] }), ['instant_cures']);
  const planned = cures.map((c) => ({ ...c, queuedG: c.curableG - 8 }));
  assert.deepEqual(anomalyFlags({ cures: planned, gestureTimestampsMs: [0, 200, 400] }), [], 'cures queued well before the window are planning, not reactions');
  assert.deepEqual(anomalyFlags({ cures: cures.slice(0, 9), gestureTimestampsMs: [0, 50, 100, 150] }), ['fast_gestures']);
  assert.deepEqual(anomalyFlags({ cures: [], gestureTimestampsMs: [0, 500] }), []);
});
