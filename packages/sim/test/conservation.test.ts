// Property test: every turn, total power changes by exactly production + land income − power destroyed.
// 1,000 seeds as the doc specifies; FUZZ_SEEDS=100 for a quick run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzRun } from '../src/fuzz.ts';
import { totalPower } from '../src/index.ts';

const seeds = Number(process.env.FUZZ_SEEDS ?? 1000);

test(`power is conserved across ${seeds} fuzz seeds`, () => {
  for (let seed = 1; seed <= seeds; seed++) {
    let prevTotal = 1, prevP = 0, prevL = 0, prevLost = 0;
    const { st } = fuzzRun({ seed }, seed + 1000, (s) => {
      const lost = s.telemetry.powerLost;
      const l = lost.capture + lost.shortAttack + lost.cure + lost.decrement;
      const tot = totalPower(s);
      const expect = prevTotal + (s.accounting.produced - prevP) + (s.accounting.landIncome - prevL) - (l - prevLost);
      assert.equal(tot, expect, `seed ${seed} turn ${s.turn - 1}`);
      prevTotal = tot; prevP = s.accounting.produced; prevL = s.accounting.landIncome; prevLost = l;
      // Invariants.
      for (let i = 0; i < s.width * s.height; i++) {
        assert.ok(s.power[i] >= 0 && s.travel[i] >= 0, 'no negative power');
        if (s.travel[i]) assert.equal(s.queue[0]?.current, i, 'only the head path has an unmerged stack');
        if (s.bugId[i] >= 0) assert.ok(s.owned[i], 'bugs only on owned cells');
        if (s.owned[i]) assert.ok(s.visible[i], 'owned cells are visible');
      }
    });
    assert.equal(st.hashes.length, 300);
    assert.equal(st.turn, 301);
  }
});
