// Rule-level checks on hand-built boards (tutorial format), covering the edge cases in DECISIONS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, stepTic, applyOp, stateHash, preview, computeSnapshot, cureToProtect, CELL, totalPower, InvalidOpError } from '../src/index.ts';
import type { GameState, Tutorial } from '../src/types.ts';

function board(rows: string[], owned: Tutorial['owned'], extra: Partial<Tutorial> = {}): GameState {
  return createGame({
    tutorial: {
      id: 'x', title: 'x', width: rows[0].length, height: rows.length, rows, owned, dcCosts: extra.dcCosts ?? { '1': 10, '2': 12 },
      fog: extra.fog ?? false, randomBugs: false, scriptedBugs: extra.scriptedBugs ?? [], goal: { type: 'ownDCs', count: 99 }, ...extra,
    },
  });
}
const c = (st: GameState, r: number, col: number) => r * st.width + col;
const lost = (st: GameState) => Object.values(st.telemetry.powerLost).reduce((a, b) => a + b, 0);

test('split modes: first-step amounts and later-step carry', () => {
  const st = board(['#####', '#S.o.', '#####'], [{ cell: [1, 1], power: 20 }, { cell: [1, 3], power: 5 }]);
  const S = c(st, 1, 1);
  // Auto from a DC: stack − S(t) = 20 − 4 = 16; through unowned land leaves 1; into own cell keeps its 5.
  applyOp(st, { g: 0, op: 'step', path: 'new', from: S, dir: 'R', intent: 'move', mode: 'auto' });
  applyOp(st, { g: 0, op: 'step', path: 0, dir: 'R', intent: 'move' });
  let ev = stepTic(st);
  assert.equal(ev.step!.sent, 16);
  assert.equal(st.power[S], 4);
  assert.equal(st.travel[c(st, 1, 2)], 16);
  ev = stepTic(st);
  assert.equal(ev.step!.sent, 15, 'a cell with own power 0 keeps 1 of the travelling stack');
  assert.equal(st.power[c(st, 1, 2)], 1);
  assert.equal(st.power[c(st, 1, 3)], 5 + 15, 'path ended, merged; own 5 kept');
  assert.equal(st.queue.length, 0);
  // Half / Keep N / All but 1 from a land source.
  const st2 = board(['#####', '#oooo', '#####'], [{ cell: [1, 1], power: 9 }, { cell: [1, 2], power: 3 }, { cell: [1, 3], power: 2 }]);
  applyOp(st2, { g: 0, op: 'step', path: 'new', from: c(st2, 1, 1), dir: 'R', intent: 'move', mode: 'half' });
  assert.equal(stepTic(st2).step!.sent, 4);
  applyOp(st2, { g: 1, op: 'step', path: 'new', from: c(st2, 1, 2), dir: 'R', intent: 'move', mode: 'keep', n: 2 });
  assert.equal(stepTic(st2).step!.sent, 3 + 4 - 2);
  const st3 = board(['#####', '#oooo', '#####'], [{ cell: [1, 1], power: 9 }, { cell: [1, 2], power: 3 }, { cell: [1, 3], power: 2 }]);
  applyOp(st3, { g: 0, op: 'step', path: 'new', from: c(st3, 1, 1), dir: 'R', intent: 'move', mode: 'all1' });
  applyOp(st3, { g: 0, op: 'step', path: 0, dir: 'R', intent: 'move' });
  applyOp(st3, { g: 0, op: 'step', path: 0, dir: 'R', intent: 'move' });
  assert.equal(stepTic(st3).step!.sent, 8);
  assert.equal(stepTic(st3).step!.sent, 8 + 3 - 1, 'All but 1 gathers');
  assert.equal(st3.power[c(st3, 1, 2)], 1);
  assert.equal(stepTic(st3).step!.sent, 10 + 2 - 1);
  // A first step that would send < 1 fails and ends only its own path.
  const st4 = board(['####', '#S.#', '####'], [{ cell: [1, 1], power: 4 }]);
  applyOp(st4, { g: 0, op: 'step', path: 'new', from: c(st4, 1, 1), dir: 'R', intent: 'move', mode: 'auto' });
  assert.equal(stepTic(st4).step!.cause, 'nothingToSend');
});

test('capture, short attack, chipped DC, and the real capture cost', () => {
  const st = board(['######', '#S..1#', '######'], [{ cell: [1, 1], power: 10 }]);
  const S = c(st, 1, 1), dc = c(st, 1, 4);
  // Auto sends 6; 1 left on each of two land cells → 4 arrives ≤ 10 → short attack.
  for (const [i, d] of (['R', 'R', 'R'] as const).entries()) applyOp(st, { g: 0, op: 'step', path: i === 0 ? 'new' : 0, from: S, dir: d, intent: 'move', mode: 'auto' });
  stepTic(st); stepTic(st);
  const ev = stepTic(st);
  assert.equal(ev.step!.kind, 'shortAttack');
  assert.equal(st.cost[dc], 6);
  assert.equal(st.telemetry.powerLost.shortAttack, 4);
  assert.equal(ev.endedPaths[0].at, c(st, 1, 3), 'cursor goes to the step source after a short attack');
  assert.equal(totalPower(st) + lost(st), 10 + st.accounting.produced);
  // Chip it to 0: any arriving power captures.
  st.cost[dc] = 0;
  st.power[c(st, 1, 3)] = 3;
  applyOp(st, { g: 6, op: 'step', path: 'new', from: c(st, 1, 3), dir: 'R', intent: 'move', mode: 'all1' });
  const ev2 = stepTic(st);
  assert.equal(ev2.step!.kind, 'capture');
  assert.equal(st.type[dc], CELL.OWNED_DC);
  assert.equal(ev2.step!.arrived, 2);
  // Capture then continue: the new DC keeps 1, the path carries a − x − 1.
  const st2 = board(['######', '#S1..#', '######'], [{ cell: [1, 1], power: 30 }]);
  applyOp(st2, { g: 0, op: 'step', path: 'new', from: c(st2, 1, 1), dir: 'R', intent: 'move', mode: 'auto' });
  applyOp(st2, { g: 0, op: 'step', path: 0, dir: 'R', intent: 'move' });
  assert.equal(stepTic(st2).step!.arrived, 26 - 10);
  assert.equal(stepTic(st2).step!.sent, 15);
  assert.equal(st2.power[c(st2, 1, 2)], 1 + 2, 'kept 1, then produced 2 at the turn end');
});

test('cures: immunity, partial, full, leftover 0 ends the path; intent is fixed at queue time', () => {
  const st = board(['######', '#Sooo#', '######'], [{ cell: [1, 1], power: 20 }], { scriptedBugs: [{ turn: 1, cell: [1, 2], health: 6 }] });
  const S = c(st, 1, 1), B = c(st, 1, 2);
  stepTic(st); stepTic(st); // turn 1 resolves, bug spawns at step 10
  assert.equal(st.bugId[B], 0);
  assert.equal(st.immunity[B], 5);
  // A move queued into a frozen cell is refused (intent mismatch): the client records intent cure.
  assert.throws(() => applyOp(st, { g: 2, op: 'step', path: 'new', from: S, dir: 'R', intent: 'move', mode: 'auto' }), InvalidOpError);
  applyOp(st, { g: 2, op: 'step', path: 'new', from: S, dir: 'R', intent: 'cure', mode: 'auto' });
  assert.equal(stepTic(st).step!.cause, 'immune');
  assert.equal(st.power[S], 20 + 2, 'nothing deducted on failure');
  // Run to turn 7 (curable from t+6 = 7). Health grows at 4 and 7 (step 6, after the tics).
  while (st.turn < 7) stepTic(st);
  assert.equal(st.immunity[B], 0);
  assert.equal(st.bugHealth[B], 7);
  // Partial cure with Half: sends floor(32/2) = 16 ≥ 7 → full cure actually; use Keep N to send exactly 3.
  applyOp(st, { g: 12, op: 'step', path: 'new', from: S, dir: 'R', intent: 'cure', mode: 'keep', n: st.power[S] - 3 });
  let ev = stepTic(st);
  assert.equal(ev.step!.kind, 'partialCure');
  assert.equal(st.bugHealth[B], 4);
  assert.equal(ev.endedPaths[0].at, S);
  // Full cure with exact health and a continuing path: leftover 0 → the rest fails (cureExhausted).
  applyOp(st, { g: 13, op: 'step', path: 'new', from: S, dir: 'R', intent: 'cure', mode: 'keep', n: st.power[S] - 4 });
  applyOp(st, { g: 13, op: 'step', path: st.queue[0].id, dir: 'R', intent: 'move' });
  ev = stepTic(st);
  assert.equal(ev.step!.kind, 'cure');
  assert.equal(st.bugId[B], -1);
  assert.equal(ev.endedPaths[0].cause, 'cureExhausted');
  assert.equal(st.power[B], 0, 'cured cell keeps its own power (decremented to 0 while frozen)');
  // A cure queued against a bug that is gone by execution runs as a normal move.
  const st2 = board(['######', '#Sooo#', '######'], [{ cell: [1, 1], power: 20 }], { scriptedBugs: [{ turn: 1, cell: [1, 2], health: 2 }] });
  while (st2.turn < 7) stepTic(st2);
  applyOp(st2, { g: 12, op: 'step', path: 'new', from: c(st2, 1, 1), dir: 'R', intent: 'cure', mode: 'half' });
  applyOp(st2, { g: 12, op: 'step', path: 'new', from: c(st2, 1, 1), dir: 'R', intent: 'cure', mode: 'half' });
  assert.equal(stepTic(st2).step!.kind, 'cure');
  assert.equal(stepTic(st2).step!.kind, 'move');
});

test('decrement, unprotected production stop, spread firewall, cut-off land earns nothing', () => {
  // S(14) o(5) o(1) T(6) like tutorial 2 but we never fix the corridor; plus a land tail off T.
  const st = board(['########', '#SooToo#', '########'],
    [{ cell: [1, 1], power: 14 }, { cell: [1, 2], power: 5 }, { cell: [1, 3], power: 1 }, { cell: [1, 4], power: 6 }, { cell: [1, 5], power: 1 }, { cell: [1, 6], power: 1 }],
    { scriptedBugs: [{ turn: 2, cell: [1, 4], health: 3 }] });
  const T = c(st, 1, 4);
  while (st.turn < 3) stepTic(st);
  assert.equal(st.power[T], 6 + 4, 'T produced on turns 1–2 before the bug (spawn is at step 10 of turn 2)');
  while (st.turn < 12) stepTic(st); // turns 3..11 resolved
  assert.equal(st.protectedFlag[T], 0);
  // Unprotected for turns 3–11 (9 turns): decrement every 2 counted turns → 4; no production.
  assert.equal(st.power[T], 10 - 4);
  assert.equal(st.telemetry.powerLost.decrement, 4);
  assert.equal(st.accounting.landIncome, 0, 'turn 12 not reached');
  stepTic(st); stepTic(st); // turn 12: land income
  // Cells left of T connect to S (healthy): earn. Cells right of T: cut off: don't earn.
  assert.equal(st.power[c(st, 1, 2)], 6);
  assert.equal(st.power[c(st, 1, 3)], 2);
  assert.equal(st.power[c(st, 1, 5)], 1);
  assert.equal(st.power[c(st, 1, 6)], 1);
});

test('land spread picks the lowest neighbour at or below health, deterministic ties, DC never infected', () => {
  const st = board(['#####', '#.o.#', '#oSo#', '#.o.#', '#####'],
    [{ cell: [1, 2], power: 2 }, { cell: [2, 1], power: 1 }, { cell: [2, 3], power: 1 }, { cell: [3, 2], power: 9 }, { cell: [2, 2], power: 10 }],
    { scriptedBugs: [{ turn: 1, cell: [2, 1], health: 2 }] });
  // bug at [2,1] (power 1): neighbours [1,1] mountain? no: '#' at [1,0]; [1,1]='.' unowned, [3,1]='.' unowned, [2,2]=S (DC). So no land target → nothing spreads.
  while (st.turn <= 9) stepTic(st);
  assert.equal(st.nextBugId, 1, 'no spread into the DC or unowned cells');
  const st2 = board(['#####', '#ooo#', '#oSo#', '#####'],
    [{ cell: [1, 1], power: 1 }, { cell: [1, 2], power: 1 }, { cell: [2, 1], power: 1 }, { cell: [1, 3], power: 3 }, { cell: [2, 3], power: 1 }, { cell: [2, 2], power: 10 }],
    { scriptedBugs: [{ turn: 1, cell: [1, 2], health: 2 }] });
  while (st2.turn <= 9) stepTic(st2);
  // spreads on turn 9 (t+8): candidates [1,1] (1) and [1,3] (3 > health 4? health is 2+1+1 = 4 at turn 9 step 8? growth at 4 and 7 → 4; [1,3]=3 ≤ 4 qualifies) → lowest is [1,1].
  assert.equal(st2.nextBugId, 2);
  assert.equal(st2.bugId[c(st2, 1, 1)], 1);
  assert.equal(st2.bugHealth[c(st2, 1, 1)], 2);
});

test('freeze merges a travelling stack and ends its path; hash and preview are stable', () => {
  const st = board(['######', '#Sooo#', '######'], [{ cell: [1, 1], power: 20 }], { scriptedBugs: [{ turn: 1, cell: [1, 3], health: 1 }] });
  const S = c(st, 1, 1);
  applyOp(st, { g: 0, op: 'step', path: 'new', from: S, dir: 'R', intent: 'move', mode: 'auto' });
  applyOp(st, { g: 0, op: 'step', path: 0, dir: 'R', intent: 'move' });
  applyOp(st, { g: 0, op: 'step', path: 0, dir: 'R', intent: 'move' });
  const before = stateHash(st);
  const pv = preview(st);
  assert.equal(stateHash(st), before, 'preview never touches the state');
  assert.deepEqual(pv.paths[0].steps.map((s) => s.arrival), [16, 16, 16]);
  stepTic(st); // step 1 → travelling 16 sits in [1,2]
  const ev = stepTic(st); // step 2 → travelling in [1,3]; then the bug spawns on [1,3]
  assert.equal(ev.spawns[0].cell, c(st, 1, 3));
  assert.equal(ev.endedPaths[0].cause, 'frozen');
  assert.equal(st.queue.length, 0);
  assert.equal(st.power[c(st, 1, 3)], 1 + 16, 'merged into the frozen cell');
  assert.equal(st.travel[c(st, 1, 3)], 0);
});

test('cure-to-protect and status transitions', () => {
  const st = board(['########', '#SooT..#', '########'],
    [{ cell: [1, 1], power: 14 }, { cell: [1, 2], power: 5 }, { cell: [1, 3], power: 5 }, { cell: [1, 4], power: 3 }],
    { scriptedBugs: [{ turn: 1, cell: [1, 4], health: 5 }] });
  const T = c(st, 1, 4);
  stepTic(st); stepTic(st); stepTic(st); stepTic(st);
  const A = computeSnapshot(st);
  // stack 3+2 = 5 ≤ health 5 → cure needed; corridor 5: cure_protect = h − (min(5,5) − 1) = 5 − 4 = 1.
  assert.equal(cureToProtect(st, A, T), 1);
});
