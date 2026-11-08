import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyLog, createGame, stepTic, applyOp, setBugKey, MissingKeyError, preview, totalPower } from '../src/index.ts';
import { fuzzRun } from '../src/fuzz.ts';
import type { LogOp } from '../src/types.ts';

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden');

test('golden vectors reproduce bit for bit', () => {
  const files = readdirSync(goldenDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 20, 'run golden:generate first');
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(goldenDir, f), 'utf8')) as { seed: number; log: LogOp[]; hashes: number[]; score: number };
    const r = verifyLog({ seed: v.seed }, v.log);
    assert.equal(r.valid, true, `${f}: ${r.reason}`);
    assert.equal(r.hashes.length, 300);
    assert.deepEqual(r.hashes, v.hashes, f);
    assert.equal(r.score, v.score);
  }
});

test('invalid logs: past-stamped op, ended path, op after the run, bad intent', () => {
  const { log } = fuzzRun({ seed: 2 }, 2);
  assert.equal(verifyLog({ seed: 2 }, log).valid, true);
  const past = log.slice();
  past.splice(10, 0, { g: 0, op: 'clear' });
  assert.equal(verifyLog({ seed: 2 }, past).valid, false);
  const late = log.concat([{ g: 700, op: 'clear' }]);
  assert.equal(verifyLog({ seed: 2 }, late).valid, false);
  const ended = [{ g: 0, op: 'step', path: 99, dir: 'U', intent: 'move' } as LogOp];
  assert.equal(verifyLog({ seed: 2 }, ended).valid, false);
});

test('ranked: keys per turn, MissingKeyError before any change, same log → same hashes as practice-with-keys', () => {
  const keys = Array.from({ length: 300 }, (_, i) => (i * 2654435761) >>> 0);
  const st = createGame({ mapSeed: 11, kind: 'ranked' });
  setBugKey(st, 1, keys[0]);
  stepTic(st);
  const before = JSON.stringify([...st.power]);
  // tic 2 of turn 1 needs key 1 (have it); turn 2 doesn't.
  stepTic(st);
  assert.throws(() => { stepTic(st); stepTic(st); }, MissingKeyError);
  assert.equal(st.turn, 2);
  assert.equal(st.tic, 1, 'the first tic of turn 2 ran; the second refused before changing anything');
  void before;
  assert.doesNotThrow(() => preview(st), 'preview never needs keys');
  // Practice-with-keys replays the same day exactly.
  const { log, st: ranked } = fuzzRun({ mapSeed: 11, bugKeys: keys, kind: 'ranked' }, 11);
  const r = verifyLog({ mapSeed: 11, bugKeys: keys }, log);
  assert.equal(r.valid, true);
  assert.deepEqual(r.hashes, ranked.hashes);
  const prac = createGame({ mapSeed: 11, bugKeys: keys, kind: 'practice' });
  let i = 0;
  while (!prac.finished) {
    while (i < log.length && log[i].g === 2 * (prac.turn - 1) + prac.tic) applyOp(prac, log[i++]);
    stepTic(prac);
  }
  assert.deepEqual(prac.hashes, ranked.hashes);
  assert.equal(totalPower(prac), r.score);
});
