import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, CELL, W, H, fmix32, uniform, rand } from '../src/index.ts';

const manhattan = (a: number, b: number) => Math.abs(((a / W) | 0) - ((b / W) | 0)) + Math.abs((a % W) - (b % W));

test('rng: fmix32 is the MurmurHash3 finalizer and draws are pure', () => {
  assert.equal(fmix32(0), 0);
  assert.equal(fmix32(0x12345678), fmix32(0x12345678 + 4294967296), 'uint32 wrap');
  assert.equal(rand(5, 1, 7, 2, 0), rand(5, 1, 7, 2, 0));
  assert.notEqual(rand(5, 1, 7, 2, 0), rand(5, 1, 7, 2, 1));
  for (let n = 1; n < 20; n++) for (let s = 0; s < 50; s++) { const v = uniform(s, 2, 3, 4, n); assert.ok(v >= 0 && v < n); }
});

test('map: same seed → same map, and every rule in §Map generation holds', () => {
  const a = generateMap(0xdeadbeef), b = generateMap(0xdeadbeef);
  assert.deepEqual([...a.map.type], [...b.map.type]);
  assert.deepEqual([...a.map.cost], [...b.map.cost]);
  for (let seed = 1; seed <= 300; seed++) {
    const { map, log } = generateMap(seed);
    const dcs: number[] = [];
    let open = 0;
    for (let i = 0; i < W * H; i++) {
      if (map.type[i] === CELL.NEUTRAL_DC) { dcs.push(i); assert.ok(map.cost[i] >= 12 && map.cost[i] <= 18); }
      if (map.type[i] !== CELL.MOUNTAIN) open++;
    }
    assert.ok(open >= 200, 'largest region at least 200 after pocket fill');
    assert.ok(dcs.length >= 1 && dcs.length <= 40);
    assert.equal(log.dcsPlaced, dcs.length);
    assert.ok(log.dcsWanted >= 25 && log.dcsWanted <= 40);
    for (const d of dcs) assert.ok(manhattan(d, map.spawn) >= 3, 'DC at least 3 from the spawn');
    if (log.fallbacks === 0) for (let i = 0; i < dcs.length; i++) for (let j = i + 1; j < dcs.length; j++) assert.ok(manhattan(dcs[i], dcs[j]) >= 2);
    // Connectivity guarantee: every non-mountain cell reachable from the spawn (DCs treated as passable once captured).
    const seen = new Uint8Array(W * H);
    const stack = [map.spawn];
    seen[map.spawn] = 1;
    let count = 0;
    while (stack.length) {
      const i = stack.pop()!;
      count++;
      const r = (i / W) | 0, c = i % W;
      for (const j of [r > 0 ? i - W : -1, r < H - 1 ? i + W : -1, c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1]) {
        if (j >= 0 && !seen[j] && map.type[j] !== CELL.MOUNTAIN) { seen[j] = 1; stack.push(j); }
      }
    }
    assert.equal(count, open, `seed ${seed}: all open cells in one region`);
  }
});

test('map: neutral DCs placed off articulation points never wall off land (no fallback → land stays one region)', () => {
  let checked = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const { map, log } = generateMap(seed);
    if (log.fallbacks) continue;
    checked++;
    const pass = (i: number) => map.type[i] === CELL.LAND;
    const seen = new Uint8Array(W * H);
    const stack = [map.spawn];
    seen[map.spawn] = 1;
    let count = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const r = (i / W) | 0, c = i % W;
      for (const j of [r > 0 ? i - W : -1, r < H - 1 ? i + W : -1, c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1]) {
        if (j >= 0 && !seen[j] && pass(j)) { seen[j] = 1; stack.push(j); count++; }
      }
    }
    let land = 0;
    for (let i = 0; i < W * H; i++) if (pass(i)) land++;
    assert.equal(count, land, `seed ${seed}`);
  }
  assert.ok(checked > 250);
});
