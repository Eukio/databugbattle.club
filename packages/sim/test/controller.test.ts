// Input edges, as resolved in DECISIONS.md items 6–9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, stepTic, InputController, CELL } from '../src/index.ts';
import type { GameState, Tutorial } from '../src/types.ts';

function board(rows: string[], owned: Tutorial['owned'], fog = false): GameState {
  return createGame({
    tutorial: { id: 'x', title: 'x', width: rows[0].length, height: rows.length, rows, owned, dcCosts: { '1': 10 }, fog, randomBugs: false, goal: { type: 'ownDCs', count: 99 } },
  });
}
const c = (st: GameState, r: number, col: number) => r * st.width + col;

test('select, key steps, cursor follows the queued path, path extension vs new path', () => {
  const st = board(['######', '#Sooo#', '#....#', '######'], [{ cell: [1, 1], power: 20 }]);
  const ctl = new InputController(st);
  const S = c(st, 1, 1);
  assert.equal(ctl.step('R'), false, 'no cursor: keys do nothing');
  ctl.click(S);
  assert.equal(ctl.cursor, S);
  assert.equal(ctl.key('KeyD'), true);
  assert.equal(ctl.key('KeyD', true), true, 'auto-repeat consumed but ignored');
  assert.equal(st.queue[0].steps.length, 1);
  ctl.key('ArrowRight');
  assert.equal(st.queue.length, 1, 'second key extends the same path');
  assert.equal(ctl.cursor, c(st, 1, 3));
  // Selecting a new cell starts a new path.
  ctl.click(c(st, 1, 1));
  ctl.step('D');
  assert.equal(st.queue.length, 2);
  assert.equal(st.queue[1].origin, S);
});

test('a click next to the cursor is a step even on an owned cell; clicking the selected cell toggles Half', () => {
  const st = board(['######', '#Sooo#', '######'], [{ cell: [1, 1], power: 20 }]);
  const ctl = new InputController(st);
  const S = c(st, 1, 1);
  ctl.click(S);
  ctl.click(S); // cursor is on the selected cell → Half toggle, not a step
  assert.equal(ctl.halfNext, true);
  assert.equal(st.queue.length, 0);
  ctl.click(c(st, 1, 2)); // adjacent owned → a step with Half
  assert.equal(st.queue.length, 1);
  assert.equal(st.queue[0].mode, 'half');
  assert.equal(ctl.halfNext, false, 'Half applies to one path');
  ctl.click(c(st, 1, 3)); // adjacent to the cursor → step, extends
  assert.equal(st.queue[0].steps.length, 2);
  // Clicking the cursor cell when it isn't the selected cell selects it (decision 8).
  ctl.click(c(st, 1, 3));
  assert.equal(ctl.selected, c(st, 1, 3));
  assert.equal(ctl.cursor, c(st, 1, 3));
  ctl.step('R');
  assert.equal(st.queue.length, 2, 'new path from mid-corridor');
});

test('Space keeps the cursor but disables keys until a new selection or an adjacent click (decision 7)', () => {
  const st = board(['######', '#Sooo#', '######'], [{ cell: [1, 1], power: 20 }]);
  const ctl = new InputController(st);
  ctl.click(c(st, 1, 1));
  ctl.step('R');
  ctl.key('Space');
  assert.equal(ctl.cursor, c(st, 1, 2));
  assert.equal(ctl.step('R'), false, 'keys do nothing after Space');
  ctl.click(c(st, 1, 3)); // adjacent click works and starts a new path
  assert.equal(st.queue.length, 2);
  assert.equal(ctl.step('R'), true, 'keyboard re-engaged');
});

test('refused steps: off grid and visible mountain shake; a fogged obstacle is accepted', () => {
  const st = board(['######', '#S#..#', '######'], [{ cell: [1, 1], power: 20 }], true);
  const ctl = new InputController(st);
  const refused: number[] = [];
  const ctl2 = new InputController(st, { onEvent: (e) => { if (e.kind === 'refused') refused.push(e.cell); } });
  void ctl;
  ctl2.click(c(st, 1, 1));
  assert.equal(ctl2.step('R'), false, 'visible mountain');
  assert.equal(ctl2.step('U'), false, 'visible mountain (row 0)');
  assert.equal(refused.length, 2);
  // A fogged mountain beyond vision is accepted and fails at execution.
  const st2 = board(['########', '#S..#..#', '########'], [{ cell: [1, 1], power: 20 }], true);
  const c2 = new InputController(st2);
  c2.click(c(st2, 1, 1));
  assert.equal(st2.visible[c(st2, 1, 4)], 0);
  c2.step('R'); c2.step('R'); c2.step('R');
  assert.equal(st2.queue[0].steps.length, 3);
  stepTic(st2); stepTic(st2);
  const ev = stepTic(st2);
  assert.equal(ev.step!.cause, 'mountain');
});

test('drag: fills gaps horizontal-first, shares a gid, stops at a refused cell (decision 6)', () => {
  const st = board(['#######', '#So..o#', '#oo#oo#', '#######'], [{ cell: [1, 1], power: 20 }]);
  const ctl = new InputController(st);
  const S = c(st, 1, 1);
  ctl.pointerDown(S);
  ctl.pointerMove(c(st, 1, 2));
  ctl.pointerMove(c(st, 2, 4)); // jump: fill R R then D
  const steps = st.queue[0].steps.map((s) => s.target);
  assert.deepEqual(steps, [c(st, 1, 2), c(st, 1, 3), c(st, 1, 4), c(st, 2, 4)]);
  const gids = new Set(ctl.log.map((o) => o.gid));
  assert.equal(gids.size, 1, 'one gesture');
  ctl.pointerMove(c(st, 2, 3)); // mountain: refused; drag stops queuing
  ctl.pointerMove(c(st, 2, 2));
  assert.equal(st.queue[0].steps.length, 4);
  ctl.pointerUp(c(st, 2, 2));
  assert.equal(st.queue.length, 1, 'pointer up after a drag is not a click');
  // A press without movement is a click.
  ctl.pointerDown(S);
  ctl.pointerUp(S);
  assert.equal(ctl.selected, S);
  // Drags only start on owned cells.
  ctl.pointerDown(c(st, 1, 3));
  ctl.pointerMove(c(st, 1, 4));
  ctl.pointerUp(c(st, 1, 4));
  assert.equal(st.queue.length, 1);
});

test('clear and remove jump the cursor to where the last path\'s power sits; a failed last path jumps too', () => {
  const st = board(['######', '#Sooo#', '######'], [{ cell: [1, 1], power: 20 }]);
  const ctl = new InputController(st);
  const S = c(st, 1, 1);
  ctl.click(S);
  ctl.step('R'); ctl.step('R'); ctl.step('R');
  const ev = stepTic(st);
  ctl.onTicEvents(ev);
  ctl.key('KeyQ');
  assert.equal(st.queue.length, 0);
  assert.equal(ctl.cursor, c(st, 1, 2), 'power sits one step along');
  assert.equal(st.power[c(st, 1, 2)], 1 + 16, 'merged');
  assert.equal(ctl.step('R'), true, 'keys work from the jump');
  assert.equal(st.queue[0].origin, c(st, 1, 2));
  ctl.removePath(st.queue[0].id);
  assert.equal(ctl.cursor, c(st, 1, 2));
  // Failed last path: capture with too little → short attack → cursor to the source.
  const st2 = board(['######', '#S..1#', '######'], [{ cell: [1, 1], power: 10 }]);
  const c2 = new InputController(st2);
  c2.click(c(st2, 1, 1));
  c2.step('R'); c2.step('R'); c2.step('R');
  for (let i = 0; i < 3; i++) c2.onTicEvents(stepTic(st2));
  assert.equal(st2.queue.length, 0);
  assert.equal(c2.cursor, c(st2, 1, 3));
  assert.equal(c2.selected, c(st2, 1, 3));
});

test('split modes and Keep N keys; ranked pause budget', () => {
  const st = createGame({ mapSeed: 3, bugKeys: Array.from({ length: 300 }, (_, i) => i + 1), kind: 'ranked' });
  const ctl = new InputController(st);
  ctl.key('Digit3');
  assert.equal(ctl.splitMode, 'keep');
  assert.equal(ctl.keepN, 4, 'starts at S(t)');
  ctl.key('Equal'); ctl.key('Equal'); ctl.key('Minus');
  assert.equal(ctl.keepN, 5);
  for (let i = 0; i < 1000; i++) ctl.key('Equal');
  assert.equal(ctl.keepN, 999);
  ctl.key('Digit4');
  assert.equal(ctl.splitMode, 'all1');
  assert.equal(ctl.pause(), true);
  assert.equal(st.paused, 1);
  assert.equal(ctl.pause(), false, 'already paused');
  ctl.resume(); ctl.pause(); ctl.resume(); ctl.pause(); ctl.resume();
  assert.equal(st.pausesUsed, 3);
  assert.equal(ctl.pause(), false, 'no pauses left on ranked');
  const practice = new InputController(createGame({ seed: 3 }));
  for (let i = 0; i < 5; i++) { assert.equal(practice.pause(), true); practice.resume(); }
  assert.equal(practice.st.pausesUsed, 0, 'practice pauses are free');
  assert.equal(st.type.includes(CELL.NEUTRAL_DC), true);
});
