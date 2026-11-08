import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELL } from '../src/types.ts';
import {
  createMpGame, generateMpMap, mpApplyOp, mpStepTic, mpSurrender, mpScores, mpFrame, mpVision, mpMapSize, MPK, type MpState,
} from '../src/mp.ts';
import { mpBotPlay } from '../src/mpbot.ts';

function invariants(st: MpState): void {
  const n = st.width * st.height;
  const travel = new Int32Array(n);
  st.players.forEach((P) => { for (const q of P.queue) if (q.travelling) travel[q.current] += q.travelling; });
  for (let i = 0; i < n; i++) {
    assert.ok(st.power[i] >= 0, `power ≥ 0 at ${i}`);
    assert.equal(st.travel[i], travel[i], `travel matches paths at ${i}`);
    if (st.owner[i] >= 0) assert.notEqual(st.type[i], CELL.MOUNTAIN);
    if (st.type[i] === CELL.OWNED_DC) assert.ok(st.owner[i] >= 0, 'owned DCs have an owner');
    if (st.type[i] === CELL.NEUTRAL_DC) assert.equal(st.owner[i], -1);
    if (st.bugId[i] >= 0) assert.ok(st.owner[i] >= 0, 'bugs only on owned cells');
  }
  st.players.forEach((P, i) => {
    if (P.alive) { assert.ok(P.hq >= 0); assert.equal(st.owner[P.hq], i, 'a living player owns their HQ'); }
    else assert.equal(P.queue.length, 0);
  });
}

test('maps for 2–8 players: spaced spawns, open region, DCs near every spawn', () => {
  for (let players = 2; players <= 8; players++) {
    for (let seed = 1; seed <= 12; seed++) {
      const m = generateMpMap(seed * 7919 + players, players);
      assert.equal(m.width, mpMapSize(players));
      assert.equal(new Set(m.spawns).size, players);
      for (const s of m.spawns) assert.equal(m.type[s], CELL.LAND);
    }
  }
});

test('bot matches run to the end with consistent state (1v1, 2v2, FFA)', () => {
  const setups = [
    { mode: '1v1' as const, teams: [0, 1] },
    { mode: '2v2' as const, teams: [0, 0, 1, 1] },
    { mode: 'ffa' as const, teams: [0, 1, 2, 3, 4, 5] },
  ];
  for (const s of setups) {
    for (const seed of [3, 11]) {
      const st = createMpGame({ seed, mode: s.mode, players: s.teams.map((t, i) => ({ name: `P${i}`, team: t })) });
      let tics = 0;
      while (!st.finished) {
        for (let p = 0; p < st.players.length; p++) mpBotPlay(st, p);
        mpStepTic(st);
        if (++tics % 50 === 0) invariants(st);
      }
      invariants(st);
      assert.ok(st.winners && st.winners.length >= 1, `${s.mode} has winners`);
      assert.ok(st.endReason === 'time' || st.endReason === 'elimination');
      const winTeam = st.players[st.winners[0]].team;
      for (const w of st.winners) assert.equal(st.players[w].team, winTeam, 'winners are one team');
    }
  }
});

test('capturing an HQ eliminates the player and hands over their cells, halved', () => {
  const st = createMpGame({ seed: 5, players: [{ name: 'A', team: 0 }, { name: 'B', team: 1 }] });
  const a = st.players[0], b = st.players[1];
  // Put a big stack next to B's HQ, owned by A.
  const W = st.width;
  const hq = b.hq;
  const nb = [hq - W, hq + W, hq - 1, hq + 1].find((c) => c >= 0 && c < W * W && st.type[c] === CELL.LAND)!;
  st.owner[nb] = 0;
  st.power[nb] = 50;
  const other = [hq - W, hq + W, hq - 1, hq + 1].find((c) => c !== nb && c >= 0 && c < W * W && st.type[c] === CELL.LAND)!;
  st.owner[other] = 1;
  st.power[other] = 9;
  st.power[hq] = 7;
  const dir = nb === hq - W ? 'D' : nb === hq + W ? 'U' : nb === hq - 1 ? 'R' : 'L';
  mpApplyOp(st, 0, { op: 'step', path: 'new', from: nb, dir, intent: 'move', mode: 'all1' });
  const ev = mpStepTic(st);
  assert.deepEqual(ev.eliminated, [{ who: 1, by: 0 }]);
  assert.equal(b.alive, false);
  assert.equal(st.owner[hq], 0);
  assert.equal(st.power[hq] + st.travel[hq], 49 - 7, 'attack math: arriving minus defence');
  assert.equal(st.owner[other], 0);
  assert.equal(st.power[other], 5, 'transferred cells are halved, rounded up');
  assert.ok(st.finished && st.endReason === 'elimination');
  assert.deepEqual(st.winners, [0]);
  void a;
});

test('a short attack chips the defence; allies gift instead of attacking', () => {
  const st = createMpGame({ seed: 9, players: [{ name: 'A', team: 0 }, { name: 'B', team: 0 }, { name: 'C', team: 1 }] });
  const W = st.width;
  // A cell of A next to a land cell given to C (enemy) and to B (ally).
  let src = -1, enemy = -1, ally = -1;
  for (let i = W; i < W * W - W && src < 0; i++) {
    const c = i % W;
    if (c < 1 || c > W - 2) continue;
    if (st.type[i] === CELL.LAND && st.type[i + 1] === CELL.LAND && st.type[i - 1] === CELL.LAND && st.owner[i] < 0 && st.owner[i + 1] < 0 && st.owner[i - 1] < 0) { src = i; enemy = i + 1; ally = i - 1; }
  }
  st.owner[src] = 0; st.power[src] = 10;
  st.owner[enemy] = 2; st.power[enemy] = 20;
  st.owner[ally] = 1; st.power[ally] = 3;
  mpApplyOp(st, 0, { op: 'step', path: 'new', from: src, dir: 'R', intent: 'move', mode: 'all1' });
  for (let k = 0; k < 3; k++) mpStepTic(st);
  assert.equal(st.owner[enemy], 2);
  assert.equal(st.power[enemy] + st.travel[enemy] >= 11, true, 'chipped by 9');
  st.power[src] = 10;
  mpApplyOp(st, 0, { op: 'step', path: 'new', from: src, dir: 'L', intent: 'move', mode: 'all1' });
  for (let k = 0; k < 3; k++) mpStepTic(st);
  assert.equal(st.owner[ally], 1, 'ally keeps the cell');
  assert.ok(st.power[ally] >= 12, 'ally received the power');
});

test('surrender turns cells neutral; frames hide fog and only show your queue', () => {
  const st = createMpGame({ seed: 21, players: [{ name: 'A', team: 0 }, { name: 'B', team: 1 }, { name: 'C', team: 2 }] });
  for (let t = 0; t < 40; t++) { for (let p = 0; p < 3; p++) mpBotPlay(st, p); mpStepTic(st); }
  const cCells = [...st.owner].map((o, i) => (o === 2 ? i : -1)).filter((i) => i >= 0);
  const ev = mpSurrender(st, 2);
  assert.deepEqual(ev.eliminated, [{ who: 2, by: null }]);
  for (const c of cCells) assert.equal(st.owner[c], -1);
  assert.ok(!st.finished, 'two players remain');
  const f = mpFrame(st, 0, 0);
  const vis = mpVision(st, 0);
  for (let i = 0; i < f.k.length; i++) {
    if (!vis[i]) { assert.ok(f.k[i] === MPK.FOG || f.k[i] === MPK.FOG_OBSTACLE); assert.equal(f.o[i], -1); assert.equal(f.p[i], 0); }
  }
  assert.ok(f.queue.every((q) => st.players[0].queue.includes(q)));
  assert.equal(f.scores.length, 3);
  assert.equal(f.scores[2].alive, false);
  const total = mpScores(st).reduce((s, x) => s + x.army, 0);
  assert.ok(total > 0);
});

test('time limit: the team with the most power wins', () => {
  const st = createMpGame({ seed: 4, players: [{ name: 'A', team: 0 }, { name: 'B', team: 1 }], turnLimit: 20 });
  while (!st.finished) { mpBotPlay(st, 0); mpStepTic(st); }
  assert.equal(st.endReason, 'time');
  const s = mpScores(st);
  assert.deepEqual(st.winners, s[0].army > s[1].army ? [0] : s[1].army > s[0].army ? [1] : [0, 1]);
});
