import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, loadTutorial, stepTic, InputController, dcStatus, hintTriggers, CELL, totalPower,
} from '../src/index.ts';
import type { GameState, TicEvents } from '../src/types.ts';

const cell = (st: GameState, r: number, c: number) => r * st.width + c;

/** Runs until the predicate holds or `maxTurns` pass. Returns the events of the tic that satisfied it. */
function runUntil(st: GameState, ctl: InputController | null, pred: (st: GameState, ev: TicEvents) => boolean, maxTurns = 60): TicEvents {
  const limit = st.turn + maxTurns;
  while (st.turn < limit) {
    const ev = stepTic(st);
    ctl?.onTicEvents(ev);
    if (pred(st, ev)) return ev;
  }
  throw new Error(`predicate not met within ${maxTurns} turns (turn ${st.turn})`);
}

test('tutorial 1: capture and the queue plays out as the doc expects', () => {
  const st = createGame({ tutorial: loadTutorial('t1-capture') });
  const ctl = new InputController(st);
  const S = cell(st, 1, 1), dc1 = cell(st, 2, 4), dc2 = cell(st, 6, 1);
  assert.equal(st.power[S], 24);
  assert.equal(st.cost[dc1], 10);
  assert.equal(st.visible.every((v) => v === 1), true, 'fog off');

  // Click S, steer R R R D (4 steps to the DC marked 10).
  ctl.click(S);
  for (const d of ['R', 'R', 'R', 'D'] as const) assert.equal(ctl.step(d), true);
  assert.equal(st.queue.length, 1);
  let ev = stepTic(st);
  ctl.onTicEvents(ev);
  assert.equal(ev.step!.sent, 20);
  assert.equal(st.power[S], 4, 'Auto kept S(t) = 4 at home');
  ev = runUntil(st, ctl, (_s, e) => e.step?.kind === 'capture');
  assert.equal(ev.step!.to, dc1);
  assert.equal(ev.step!.arrived, 7, 'sends 20, leaves 1 on each of 3 land cells, 17 arrives, 10 consumed');
  assert.ok(st.turn <= 3, `DC 1 falls within about 2 turns (turn ${st.turn})`);
  assert.deepEqual(hintTriggers(st, ev), ['captured']);

  // Wait for S to reach 21, then go down 5 to the DC marked 12.
  runUntil(st, ctl, (s) => s.power[S] >= 21);
  assert.ok(st.turn >= 10 && st.turn <= 12, `S back to 21 around turn 11 (turn ${st.turn})`);
  ctl.click(S);
  for (let i = 0; i < 5; i++) assert.equal(ctl.step('D'), true);
  ev = runUntil(st, ctl, (_s, e) => e.step?.kind === 'capture');
  assert.equal(ev.step!.to, dc2);
  assert.ok(st.turn <= 15, `DC 2 falls around turn 13 (turn ${st.turn})`);
  assert.equal(ev.goalMet, true);
  assert.ok(hintTriggers(st, ev).includes('complete'));
  assert.equal(st.telemetry.tutorial!.completed, true);
});

test('tutorial 2: protection timing, at-risk margin, curable on turn 10', () => {
  const st = createGame({ tutorial: loadTutorial('t2-safe-level') });
  const ctl = new InputController(st);
  const S = cell(st, 1, 1), T = cell(st, 1, 4), mid = cell(st, 1, 3);
  // Bug on T at step 10 of turn 4.
  let ev = runUntil(st, ctl, (_s, e) => e.spawns.length > 0);
  assert.equal(ev.turn, 4);
  assert.equal(st.bugId[T], 0);
  assert.equal(st.bugHealth[T], 3);
  assert.deepEqual(hintTriggers(st, ev), ['bugSpawned']);
  // Unprotected: link capped at 1 by the cell next to T.
  ev = runUntil(st, ctl, (_s, e) => e.turnResolved !== null);
  assert.equal(st.protectedFlag[T], 0);
  assert.equal(dcStatus(st, st.snapA!, T), 'unprotected');
  // Select S and step right twice in Auto.
  ctl.click(S);
  ctl.step('R');
  ctl.step('R');
  runUntil(st, ctl, (s) => s.queue.length === 0);
  assert.equal(st.power[cell(st, 1, 2)], 5, 'Auto carried power through without stripping the 5');
  assert.ok(st.power[mid] >= 11, `the 1 next to T is now ${st.power[mid]}`);
  ev = runUntil(st, ctl, (_s, e) => e.protectedNow.length > 0);
  assert.ok(hintTriggers(st, ev).includes('protected'));
  // Turns 7–9: health 4, margin 1 → protected but at risk; curable on turn 10 at health 4.
  for (let turn = ev.turn + 1; turn <= 9; turn++) {
    ev = runUntil(st, ctl, (_s, e) => e.turnResolved !== null);
    assert.equal(st.protectedFlag[T], 1, `protected on turn ${turn}`);
    assert.equal(dcStatus(st, st.snapA!, T), 'atRisk', `at risk on turn ${turn}`);
  }
  assert.equal(st.turn, 10);
  assert.equal(st.immunity[T], 0, 'curable from turn 10');
  assert.equal(st.bugHealth[T], 4);
  assert.ok(ev.immunityEnded.includes(T) || st.hintsReached.includes('curable') || hintTriggers(st, ev).includes('curable'));
  // Leave it one turn: health grows to 5 at step 6 of turn 10 and T is unprotected from turn 11.
  runUntil(st, ctl, (_s, e) => e.turnResolved !== null);
  runUntil(st, ctl, (_s, e) => e.turnResolved !== null);
  assert.equal(st.bugHealth[T], 5);
  assert.equal(st.protectedFlag[T], 0, 'unprotected on turn 11');
  // Cure from the cell next to T.
  ctl.click(mid);
  assert.equal(ctl.step('R'), true);
  assert.equal(st.queue[0].steps[0].intent, 'cure');
  ev = runUntil(st, ctl, (_s, e) => e.step?.kind === 'cure');
  assert.equal(st.bugId[T], -1);
  assert.equal(ev.goalMet, true);
});

test('tutorial 3: land bug is curable turns 9–11 and spreads on turn 11 if ignored', () => {
  const st = createGame({ tutorial: loadTutorial('t3-land-bugs') });
  const bug = cell(st, 3, 5);
  let ev = runUntil(st, null, (_s, e) => e.spawns.length > 0);
  assert.equal(ev.turn, 3);
  assert.equal(st.bugHealth[bug], 4);
  ev = runUntil(st, null, (_s, e) => e.immunityEnded.includes(bug));
  assert.equal(ev.turn, 8, 'immunity reaches 0 at step 7 of turn 8');
  assert.equal(st.turn, 9, 'so the first curable tic is on turn 9');
  assert.equal(st.bugHealth[bug], 5, 'health 5 during the tics of turn 9');
  ev = runUntil(st, null, (_s, e) => e.spreads.length > 0);
  assert.equal(ev.turn, 11, 'spreads on turn 11');
  const child = ev.spreads[0];
  assert.equal(child.health, 3, 'child health is half of 6, rounded up');
  assert.equal(st.immunity[child.to], 5);
  assert.equal(st.bugHealth[bug], 6);
  assert.ok(st.type[child.to] === CELL.LAND && st.power[child.to] <= 6);
});

test('tutorial 3: curing from S along the middle row with Auto', () => {
  const st = createGame({ tutorial: loadTutorial('t3-land-bugs') });
  const ctl = new InputController(st);
  const S = cell(st, 3, 1), bug = cell(st, 3, 5);
  runUntil(st, ctl, (s) => s.turn === 9 && s.tic === 0);
  ctl.click(S);
  for (let i = 0; i < 4; i++) assert.equal(ctl.step('R'), true);
  assert.equal(st.queue[0].steps[3].intent, 'cure');
  const ev = runUntil(st, ctl, (_s, e) => e.step?.kind === 'cure');
  assert.equal(ev.turn, 10);
  assert.equal(st.bugId[bug], -1);
  assert.equal(st.power[cell(st, 3, 2)], 6, 'corridor not stripped');
  assert.equal(ev.goalMet, true);
  assert.ok(totalPower(st) > 0);
});
