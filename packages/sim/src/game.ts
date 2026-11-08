// Game state creation, ops, tics and turn resolution (design doc rev 6).
import { STREAM, uniform, weightedIndex, seedToHex } from './rng.ts';
import { generateMap } from './map.ts';
import { computeSnapshot, fullPower, isFrozen } from './connectivity.ts';
import { stateHash } from './hash.ts';
import {
  CELL,
  InvalidOpError,
  MissingKeyError,
  type Dir,
  type FailCause,
  type GameState,
  type LogOp,
  type Path,
  type PathEndCause,
  type SplitMode,
  type StepEvent,
  type Telemetry,
  type TicEvents,
  type Tutorial,
  type MapData,
  type DCStatus,
} from './types.ts';

export const RUN_TURNS = 300;
export const SPAWN_START = 30;
export const IMMUNITY = 5;
export const GROWTH_INTERVAL = 3;
export const SPREAD_INTERVAL = 8;
export const LAND_INCOME_INTERVAL = 12;
export const MAX_PAUSES = 3;

export const safeLevel = (t: number) => 4 + Math.floor(t / 10);
export const thresholdMilli = (t: number) => Math.max(1000, 100 * t);
export const bugCap = (t: number) => 3 + Math.floor(t / 10);
export const globalTic = (st: GameState) => 2 * (st.turn - 1) + st.tic;

export type GameConfig =
  | { seed: number }
  | { mapSeed: number; bugKeys?: number[] | Map<number, number>; kind?: 'ranked' | 'practice' }
  | { tutorial: Tutorial };

// ---------- creation ----------

function blankTelemetry(kind: Telemetry['kind'], seedHex: string, gen: GameState['generation']): Telemetry {
  return {
    v: 6,
    kind,
    seed: seedHex,
    score: 0,
    generation: gen,
    firstCaptureTurn: null,
    bugs: { spawned: 0, cured: 0, ignored: 0 },
    powerLost: { capture: 0, shortAttack: 0, cure: 0, decrement: 0 },
    frozenShareEvery10: [],
    notEarningShareEvery10: [],
    steps: { expand: 0, reinforce: 0, cure: 0, idle: 0 },
    failedByCause: { mountain: 0, frozenMove: 0, immune: 0, sourceLost: 0, nothingToSend: 0 },
    queueEdits: { clear: 0, removePath: 0 },
    dcStatusTurns: { safe: 0, vulnerable: 0, exposed: 0, cureNeeded: 0, unprotected: 0, atRisk: 0, protected: 0 },
    turnsNoHealthyDC: 0,
    tutorial: null,
  };
}

function baseState(map: MapData): GameState {
  const n = map.width * map.height;
  return {
    kind: 'practice',
    seed: 0,
    keySource: 'seed',
    bugKeys: new Map(),
    width: map.width,
    height: map.height,
    turn: 1,
    tic: 0,
    finished: false,
    turnLimit: RUN_TURNS,
    spawnStart: SPAWN_START,
    randomBugs: true,
    fog: true,
    scripted: [],
    goal: null,
    tutorialId: null,
    type: new Uint8Array(map.type),
    owned: new Uint8Array(n),
    power: new Int32Array(n),
    travel: new Int32Array(n),
    cost: new Int32Array(map.cost),
    acc: new Int32Array(n),
    bugId: new Int32Array(n).fill(-1),
    bugHealth: new Int32Array(n),
    immunity: new Int32Array(n),
    nextGrowth: new Int32Array(n),
    nextSpread: new Int32Array(n),
    decCounter: new Int32Array(n),
    protectedFlag: new Uint8Array(n),
    visible: new Uint8Array(n),
    nextBugId: 0,
    nextPathId: 0,
    paused: 0,
    pausesUsed: 0,
    queue: [],
    hashes: [],
    snapA: null,
    telemetry: blankTelemetry('practice', '00000000', null),
    generation: null,
    scriptedSpawned: 0,
    hintsReached: [],
    accounting: { produced: 0, landIncome: 0 },
  };
}

/** An empty state of the given size (all land, nothing owned). Used by the multiplayer client's local view. */
export function blankGameState(width: number, height: number): GameState {
  const n = width * height;
  return baseState({ width, height, type: new Uint8Array(n), cost: new Int32Array(n), spawn: 0 });
}

export function parseTutorial(tut: Tutorial): MapData & { owned: Uint8Array; power: Int32Array } {
  const { width: w, height: h } = tut;
  if (tut.rows.length !== h || tut.rows.some((r) => r.length !== w)) throw new Error('tutorial rows do not match width/height');
  const n = w * h;
  const type = new Uint8Array(n);
  const cost = new Int32Array(n);
  const owned = new Uint8Array(n);
  const power = new Int32Array(n);
  let spawn = -1;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = tut.rows[r][c];
      const i = r * w + c;
      if (ch === '#') type[i] = CELL.MOUNTAIN;
      else if (ch === '.') type[i] = CELL.LAND;
      else if (ch === 'o') { type[i] = CELL.LAND; owned[i] = 1; power[i] = 1; }
      else if (ch === 'S' || ch === 'T') { type[i] = CELL.OWNED_DC; owned[i] = 1; power[i] = 1; if (ch === 'S') spawn = i; }
      else if (ch >= '1' && ch <= '9') {
        type[i] = CELL.NEUTRAL_DC;
        const x = tut.dcCosts?.[ch];
        if (x === undefined) throw new Error(`tutorial: no cost for DC ${ch}`);
        cost[i] = x;
      } else throw new Error(`tutorial: bad map char ${ch}`);
    }
  }
  for (const o of tut.owned ?? []) {
    const i = o.cell[0] * w + o.cell[1];
    if (!owned[i]) throw new Error(`tutorial: owned entry on unowned cell ${o.cell}`);
    power[i] = o.power;
  }
  if (spawn === -1) spawn = owned.findIndex((v) => v === 1);
  return { width: w, height: h, type, cost, spawn, owned, power };
}

export function createGame(config: GameConfig): GameState {
  if ('tutorial' in config) {
    const tut = config.tutorial;
    const md = parseTutorial(tut);
    const st = baseState(md);
    st.kind = 'tutorial';
    st.seed = tut.seed ?? 0;
    st.owned.set(md.owned);
    st.power.set(md.power);
    st.turnLimit = 0;
    st.fog = tut.fog ?? false;
    st.randomBugs = tut.randomBugs ?? false;
    st.scripted = (tut.scriptedBugs ?? []).slice().sort((a, b) => a.turn - b.turn);
    st.goal = tut.goal;
    st.tutorialId = tut.id;
    st.telemetry = blankTelemetry('tutorial', seedToHex(st.seed), null);
    st.telemetry.tutorial = { id: tut.id, completed: false, hintsReached: st.hintsReached };
    recomputeVision(st);
    return st;
  }
  const mapSeed = 'seed' in config ? config.seed : config.mapSeed;
  const { map, log } = generateMap(mapSeed);
  const st = baseState(map);
  st.seed = mapSeed >>> 0;
  st.generation = log;
  st.owned[map.spawn] = 1;
  st.type[map.spawn] = CELL.OWNED_DC;
  st.power[map.spawn] = 1;
  if ('seed' in config) {
    st.kind = 'practice';
    st.keySource = 'seed';
  } else {
    st.kind = config.kind ?? 'ranked';
    st.keySource = 'keys';
    if (config.bugKeys) {
      if (Array.isArray(config.bugKeys)) config.bugKeys.forEach((k, i) => st.bugKeys.set(i + 1, k >>> 0));
      else for (const [t, k] of config.bugKeys) st.bugKeys.set(t, k >>> 0);
    }
  }
  st.telemetry = blankTelemetry(st.kind, seedToHex(st.seed), log);
  recomputeVision(st);
  return st;
}

export function setBugKey(st: GameState, turn: number, key: number): void {
  st.bugKeys.set(turn, key >>> 0);
}

export function cloneState(st: GameState): GameState {
  return structuredClone(st); // shared references (telemetry.tutorial.hintsReached) survive structuredClone
}

// ---------- helpers ----------

export function dirDelta(st: GameState, cell: number, dir: Dir): number {
  const w = st.width, h = st.height;
  const r = (cell / w) | 0, c = cell - r * w;
  switch (dir) {
    case 'U': return r > 0 ? cell - w : -1;
    case 'D': return r < h - 1 ? cell + w : -1;
    case 'L': return c > 0 ? cell - 1 : -1;
    case 'R': return c < w - 1 ? cell + 1 : -1;
  }
}

export function neighbors4(st: GameState, i: number, out: number[]): number {
  const w = st.width, h = st.height;
  let k = 0;
  const r = (i / w) | 0, c = i - r * w;
  if (r > 0) out[k++] = i - w;
  if (r < h - 1) out[k++] = i + w;
  if (c > 0) out[k++] = i - 1;
  if (c < w - 1) out[k++] = i + 1;
  return k;
}

export function recomputeVision(st: GameState): void {
  const n = st.width * st.height;
  if (!st.fog) { st.visible.fill(1); return; }
  const w = st.width, h = st.height;
  for (let i = 0; i < n; i++) {
    if (!st.owned[i]) continue;
    const r = (i / w) | 0, c = i - r * w;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < h && cc >= 0 && cc < w) st.visible[rr * w + cc] = 1;
      }
    }
  }
}

export function totalPower(st: GameState): number {
  let s = 0;
  const n = st.width * st.height;
  for (let i = 0; i < n; i++) if (st.owned[i]) s += st.power[i] + st.travel[i];
  return s;
}

function keyForTurn(st: GameState, turn: number): number {
  if (st.keySource === 'seed') return st.seed;
  const k = st.bugKeys.get(turn);
  if (k === undefined) throw new MissingKeyError(`no bug key for turn ${turn}`);
  return k;
}

function hasKey(st: GameState, turn: number): boolean {
  return st.keySource === 'seed' || st.bugKeys.has(turn);
}

// ---------- ops ----------

function findPath(st: GameState, id: number): Path | undefined {
  return st.queue.find((p) => p.id === id);
}

export function endPath(st: GameState, path: Path, cause: PathEndCause, ev?: TicEvents): void {
  const idx = st.queue.indexOf(path);
  if (idx === -1) return;
  // Merge the travelling amount into the cell where it sits.
  if (path.travelling > 0) {
    st.power[path.current] += path.travelling;
    st.travel[path.current] -= path.travelling;
    path.travelling = 0;
  }
  st.queue.splice(idx, 1);
  ev?.endedPaths.push({ id: path.id, cause, at: path.current });
}

/** Apply a queue operation. Throws InvalidOpError when the op cannot apply (the log is then invalid). */
export function applyOp(st: GameState, op: LogOp): void {
  switch (op.op) {
    case 'step': {
      // Validate everything before touching the state, so an invalid op leaves no trace.
      let path: Path | undefined;
      let from: number;
      let mode: SplitMode = 'auto';
      let n = 0;
      if (op.path === 'new') {
        if (op.from === undefined || !Number.isInteger(op.from) || op.from < 0 || op.from >= st.width * st.height) throw new InvalidOpError('new path needs a valid from');
        mode = op.mode ?? 'auto';
        if (!['auto', 'half', 'keep', 'all1'].includes(mode)) throw new InvalidOpError('bad mode');
        if (mode === 'keep') {
          n = op.n ?? 0;
          if (!Number.isInteger(n) || n < 1 || n > 999) throw new InvalidOpError('keep N must be 1..999');
        }
        from = op.from;
      } else {
        path = findPath(st, op.path);
        if (!path) throw new InvalidOpError(`path ${op.path} has ended`);
        from = path.steps.length ? path.steps[path.steps.length - 1].target : path.origin;
      }
      const target = dirDelta(st, from, op.dir);
      if (target < 0) throw new InvalidOpError('target off grid');
      if (st.visible[target] && st.type[target] === CELL.MOUNTAIN) throw new InvalidOpError('target is a visible mountain');
      const intent = isFrozen(st, target) ? 'cure' : 'move';
      if (op.intent !== intent) throw new InvalidOpError(`intent ${op.intent} does not match target state`);
      if (!path) {
        path = { id: st.nextPathId++, mode, n, origin: from, current: from, travelling: 0, executed: 0, steps: [] };
        st.queue.push(path);
      }
      path.steps.push({ target, intent });
      return;
    }
    case 'removePath': {
      const p = findPath(st, op.path);
      if (!p) throw new InvalidOpError(`path ${op.path} has ended`);
      endPath(st, p, 'removed');
      st.telemetry.queueEdits.removePath++;
      return;
    }
    case 'clear': {
      for (const p of st.queue.slice()) endPath(st, p, 'cleared');
      st.telemetry.queueEdits.clear++;
      return;
    }
    case 'pause': {
      if (st.paused) throw new InvalidOpError('already paused');
      if (st.kind === 'ranked') {
        if (st.pausesUsed >= MAX_PAUSES) throw new InvalidOpError('no pauses left');
        st.pausesUsed++;
      }
      st.paused = 1;
      return;
    }
    case 'resume': {
      if (!st.paused) throw new InvalidOpError('not paused');
      st.paused = 0;
      return;
    }
  }
}

// ---------- tics ----------

function newEvents(st: GameState): TicEvents {
  return {
    g: globalTic(st), turn: st.turn, tic: st.tic, step: null, idle: false, endedPaths: [], spawns: [], spreads: [],
    immunityEnded: [], protectedNow: [], turnResolved: null, goalMet: false,
  };
}

function executeStep(st: GameState, ev: TicEvents): void {
  const path = st.queue[0];
  if (!path) { ev.idle = true; st.telemetry.steps.idle++; return; }
  const step = path.steps[path.executed];
  const src = path.executed === 0 ? path.origin : path.current;
  const tgt = step.target;
  const fail = (cause: FailCause): void => {
    st.telemetry.failedByCause[cause]++;
    ev.step = { pathId: path.id, from: src, to: tgt, sent: 0, kind: 'fail', cause, arrived: 0 };
    endPath(st, path, cause, ev);
  };
  if (st.type[tgt] === CELL.MOUNTAIN) return fail('mountain');
  const tFrozen = isFrozen(st, tgt);
  if (tFrozen && step.intent === 'move') return fail('frozenMove');
  if (tFrozen && st.immunity[tgt] > 0) return fail('immune');
  if (!st.owned[src] || isFrozen(st, src)) return fail('sourceLost');

  let send: number;
  let keep: number;
  const own = st.power[src];
  if (path.executed === 0) {
    const stack = own; // a path never starts with an unmerged travelling amount in its cell
    switch (path.mode) {
      case 'auto': send = st.type[src] === CELL.OWNED_DC ? stack - safeLevel(st.turn) : stack - 1; break;
      case 'half': send = Math.floor(stack / 2); break;
      case 'keep': send = stack - path.n; break;
      case 'all1': send = stack - 1; break;
    }
    keep = stack - send;
  } else if (path.mode === 'all1') {
    send = own + path.travelling - 1;
    keep = 1;
  } else if (own === 0) {
    send = path.travelling - 1;
    keep = 1;
  } else {
    send = path.travelling;
    keep = own;
  }
  if (send < 1) return fail('nothingToSend');

  // Commit the source.
  st.power[src] = keep;
  st.travel[src] -= path.travelling;
  path.travelling = 0;

  const unownedTarget = !st.owned[tgt];
  if (st.type[tgt] === CELL.NEUTRAL_DC) {
    const x = st.cost[tgt];
    if (send > x) {
      st.owned[tgt] = 1;
      st.type[tgt] = CELL.OWNED_DC;
      st.cost[tgt] = 0;
      st.acc[tgt] = 0;
      st.telemetry.powerLost.capture += x;
      if (st.telemetry.firstCaptureTurn === null) st.telemetry.firstCaptureTurn = st.turn;
      st.telemetry.steps.expand++;
      path.travelling = send - x;
      st.travel[tgt] += path.travelling;
      ev.step = { pathId: path.id, from: src, to: tgt, sent: send, kind: 'capture', arrived: send - x };
    } else {
      st.cost[tgt] = x - send;
      st.telemetry.powerLost.shortAttack += send;
      st.telemetry.steps.expand++;
      ev.step = { pathId: path.id, from: src, to: tgt, sent: send, kind: 'shortAttack', arrived: 0 };
      path.current = src;
      endPath(st, path, 'shortAttack', ev);
      return;
    }
  } else if (tFrozen) {
    const h = st.bugHealth[tgt];
    st.telemetry.steps.cure++;
    if (send >= h) {
      clearBug(st, tgt);
      st.telemetry.powerLost.cure += h;
      st.telemetry.bugs.cured++;
      path.travelling = send - h;
      st.travel[tgt] += path.travelling;
      ev.step = { pathId: path.id, from: src, to: tgt, sent: send, kind: 'cure', arrived: send - h };
      if (path.travelling === 0 && path.executed + 1 < path.steps.length) {
        path.current = tgt;
        path.executed++;
        endPath(st, path, 'cureExhausted', ev);
        return;
      }
    } else {
      st.bugHealth[tgt] = h - send;
      st.telemetry.powerLost.cure += send;
      ev.step = { pathId: path.id, from: src, to: tgt, sent: send, kind: 'partialCure', arrived: 0 };
      path.current = src;
      endPath(st, path, 'partialCure', ev);
      return;
    }
  } else {
    if (unownedTarget) { st.owned[tgt] = 1; st.telemetry.steps.expand++; }
    else st.telemetry.steps.reinforce++;
    path.travelling = send;
    st.travel[tgt] += send;
    ev.step = { pathId: path.id, from: src, to: tgt, sent: send, kind: unownedTarget ? 'claim' : 'move', arrived: send };
  }
  path.current = tgt;
  path.executed++;
  if (path.executed === path.steps.length) endPath(st, path, 'done', ev);
}

function clearBug(st: GameState, c: number): void {
  st.bugId[c] = -1;
  st.bugHealth[c] = 0;
  st.immunity[c] = 0;
  st.nextGrowth[c] = 0;
  st.nextSpread[c] = 0;
  st.decCounter[c] = 0;
  st.protectedFlag[c] = 0;
}

function freeze(st: GameState, c: number, health: number, ev: TicEvents, kind: 'dc' | 'land' | 'scripted'): number {
  const id = st.nextBugId++;
  st.bugId[c] = id;
  st.bugHealth[c] = health;
  st.immunity[c] = IMMUNITY;
  st.nextGrowth[c] = st.turn + GROWTH_INTERVAL;
  st.nextSpread[c] = st.type[c] === CELL.LAND ? st.turn + SPREAD_INTERVAL : 0;
  st.decCounter[c] = 0;
  st.protectedFlag[c] = 0;
  st.telemetry.bugs.spawned++;
  // A travelling stack sitting here merges and its path ends (its next source is frozen).
  const head = st.queue[0];
  if (head && head.executed > 0 && head.current === c) endPath(st, head, 'frozen', ev);
  ev.spawns.push({ cell: c, id, health, kind });
  return id;
}

/** One tic. Throws MissingKeyError before changing anything if this tic would need a bug key it doesn't have. */
export function stepTic(st: GameState, opts: { spawn?: boolean; spread?: boolean } = {}): TicEvents {
  if (st.finished) throw new Error('run is finished');
  const spawn = opts.spawn ?? true;
  const spread = opts.spread ?? true;
  // Keys are needed at steps 8 (spread tie-breaks) and 10 (spawns); refuse before touching anything.
  if (st.tic === 1 && st.keySource === 'keys' && (spawn || spread) && !hasKey(st, st.turn)) {
    throw new MissingKeyError(`no bug key for turn ${st.turn}`);
  }
  const ev = newEvents(st);
  executeStep(st, ev);
  recomputeVision(st);
  if (st.tic === 0) {
    st.tic = 1;
  } else {
    resolveTurn(st, ev, spawn, spread);
  }
  ev.goalMet = checkGoal(st);
  if (ev.goalMet && st.kind === 'tutorial' && st.telemetry.tutorial) st.telemetry.tutorial.completed = true;
  return ev;
}

function resolveTurn(st: GameState, ev: TicEvents, spawn: boolean, spread: boolean): void {
  const n = st.width * st.height;
  const t = st.turn;
  // 3. Snapshot A; fix protection for compromised DCs.
  const A = computeSnapshot(st);
  st.snapA = A;
  for (let i = 0; i < n; i++) {
    if (st.type[i] === CELL.OWNED_DC && st.bugId[i] >= 0) {
      const prot = A.bestLink[i] > st.bugHealth[i] ? 1 : 0;
      st.protectedFlag[i] = prot;
      if (prot) ev.protectedNow.push(i);
    }
  }
  // 4. DC production.
  const Tm = thresholdMilli(t);
  for (let i = 0; i < n; i++) {
    if (st.type[i] !== CELL.OWNED_DC) continue;
    const frozen = st.bugId[i] >= 0;
    if (frozen && !st.protectedFlag[i]) continue;
    let sum = 0;
    for (const { b } of A.links.get(i) ?? []) sum += b * 1000 >= Tm ? 1000 : Math.floor((b * 1000000) / Tm);
    const bonus = Math.floor((100 * sum) / 1000);
    st.acc[i] += 2000 + bonus;
    const pay = Math.floor(st.acc[i] / 1000);
    st.acc[i] -= pay * 1000;
    st.power[i] += pay;
    st.accounting.produced += pay;
  }
  // 5. Land income.
  let notEarning = 0, landCells = 0;
  for (let i = 0; i < n; i++) {
    if (!st.owned[i] || st.type[i] !== CELL.LAND) continue;
    landCells++;
    if (st.bugId[i] >= 0) continue;
    if (A.anchored[i]) { if (t % LAND_INCOME_INTERVAL === 0) { st.power[i] += 1; st.accounting.landIncome++; } }
    else notEarning++;
  }
  // 6. Bug upkeep: growth and decrements.
  let frozenCells = 0;
  for (let i = 0; i < n; i++) {
    if (st.bugId[i] < 0) continue;
    frozenCells++;
    if (st.nextGrowth[i] === t) { st.bugHealth[i]++; st.nextGrowth[i] += GROWTH_INTERVAL; }
    const counts = st.type[i] === CELL.LAND || !st.protectedFlag[i];
    if (counts) {
      st.decCounter[i]++;
      if (st.decCounter[i] >= 2) {
        st.decCounter[i] = 0;
        if (st.power[i] > 0) { st.power[i]--; st.telemetry.powerLost.decrement++; }
      }
    }
  }
  // 7. Immunity timers.
  for (let i = 0; i < n; i++) {
    if (st.immunity[i] > 0) { st.immunity[i]--; if (st.immunity[i] === 0) ev.immunityEnded.push(i); }
  }
  // 8. Land spread.
  if (spread) spreadBugs(st, ev);
  // 9. Snapshot B. 10. Spawn.
  if (spawn) {
    const scriptedDue = st.scripted.filter((b) => b.turn === t);
    const randomDue = st.randomBugs && t >= st.spawnStart;
    if (scriptedDue.length || randomDue) {
      const B = computeSnapshot(st);
      for (const b of scriptedDue) {
        const c = b.cell[0] * st.width + b.cell[1];
        st.scriptedSpawned++;
        if (!st.owned[c] || st.bugId[c] >= 0) continue;
        freeze(st, c, b.health, ev, 'scripted');
      }
      if (randomDue) spawnRandom(st, B, ev);
    }
  }
  // 11. Vision; then hash and bookkeeping.
  recomputeVision(st);
  const hash = stateHash(st);
  st.hashes.push(hash);
  ev.turnResolved = { turn: t, hash };
  // Telemetry shares and statuses.
  if (t % 10 === 0) {
    let ownedCells = 0;
    for (let i = 0; i < n; i++) if (st.owned[i]) ownedCells++;
    st.telemetry.frozenShareEvery10.push(ownedCells ? Math.round((frozenCells / ownedCells) * 1000) / 1000 : 0);
    st.telemetry.notEarningShareEvery10.push(landCells ? Math.round((notEarning / landCells) * 1000) / 1000 : 0);
  }
  let healthy = 0;
  for (let i = 0; i < n; i++) {
    if (st.type[i] !== CELL.OWNED_DC) continue;
    if (st.bugId[i] < 0) healthy++;
    st.telemetry.dcStatusTurns[dcStatus(st, A, i)]++;
  }
  if (healthy === 0) st.telemetry.turnsNoHealthyDC++;
  // Advance.
  st.turn++;
  st.tic = 0;
  if (st.turnLimit && t >= st.turnLimit) {
    st.finished = true;
    st.telemetry.score = totalPower(st);
    let remaining = 0;
    for (let i = 0; i < n; i++) if (st.bugId[i] >= 0) remaining++;
    st.telemetry.bugs.ignored = remaining;
  }
}

function spreadBugs(st: GameState, ev: TicEvents): void {
  const n = st.width * st.height;
  const t = st.turn;
  const key = keyForTurn(st, t);
  const due: { id: number; cell: number }[] = [];
  for (let i = 0; i < n; i++) if (st.bugId[i] >= 0 && st.type[i] === CELL.LAND && st.nextSpread[i] === t) due.push({ id: st.bugId[i], cell: i });
  due.sort((a, b) => a.id - b.id);
  const nb = [0, 0, 0, 0];
  for (const { cell } of due) {
    if (st.bugId[cell] < 0) continue; // cured since listing (cannot happen within step 8, kept for safety)
    st.nextSpread[cell] = t + SPREAD_INTERVAL;
    const h = st.bugHealth[cell];
    const cnt = neighbors4(st, cell, nb);
    let best = Infinity;
    const tied: number[] = [];
    const cand: number[] = [];
    for (let k = 0; k < cnt; k++) cand.push(nb[k]);
    cand.sort((a, b) => a - b); // row-major
    for (const m of cand) {
      if (!st.owned[m] || st.type[m] !== CELL.LAND || st.bugId[m] >= 0) continue;
      const p = fullPower(st, m);
      if (p > h) continue;
      if (p < best) { best = p; tied.length = 0; tied.push(m); }
      else if (p === best) tied.push(m);
    }
    if (!tied.length) continue;
    const target = tied.length === 1 ? tied[0] : tied[uniform(key, STREAM.SPREAD, t, cell, tied.length)];
    const child = Math.ceil(h / 2);
    const id = freeze(st, target, child, ev, 'land');
    ev.spawns.pop();
    ev.spreads.push({ from: cell, to: target, id, health: child });
  }
}

function spawnRandom(st: GameState, B: ReturnType<typeof computeSnapshot>, ev: TicEvents): void {
  const n = st.width * st.height;
  const t = st.turn;
  const key = keyForTurn(st, t);
  let dcCount = 0, landCount = 0;
  for (let i = 0; i < n; i++) {
    if (!st.owned[i]) continue;
    if (st.type[i] === CELL.OWNED_DC) dcCount++;
    else landCount++;
  }
  const weightOf = (b: number) => Math.max(1, Math.floor(1000 / (1 + b)));
  // DC pool.
  {
    const lambda = Math.min(400, 10 * dcCount);
    if (uniform(key, STREAM.DC_POOL, t, 0, 1000) < lambda) {
      const level = 1 + uniform(key, STREAM.DC_POOL, t, 1, bugCap(t));
      const cand: number[] = [];
      for (let i = 0; i < n; i++) if (st.type[i] === CELL.OWNED_DC && st.bugId[i] < 0) cand.push(i);
      if (cand.length) {
        const idx = weightedIndex(key, STREAM.DC_POOL, t, 2, cand.map((c) => weightOf(B.Bbest[c])));
        freeze(st, cand[idx], level, ev, 'dc');
      }
    }
  }
  // Land pool.
  {
    const lambda = Math.min(150, 2 * landCount);
    if (uniform(key, STREAM.LAND_POOL, t, 0, 1000) < lambda) {
      const level = 1 + uniform(key, STREAM.LAND_POOL, t, 1, bugCap(t));
      const cand: number[] = [];
      for (let i = 0; i < n; i++) if (st.owned[i] && st.type[i] === CELL.LAND && st.bugId[i] < 0 && fullPower(st, i) <= level) cand.push(i);
      if (cand.length) {
        const idx = weightedIndex(key, STREAM.LAND_POOL, t, 2, cand.map((c) => weightOf(B.Bbest[c])));
        freeze(st, cand[idx], level, ev, 'land');
      }
    }
  }
}

// ---------- status, goals ----------

export function dcStatus(st: GameState, A: ReturnType<typeof computeSnapshot>, i: number): DCStatus {
  const S = safeLevel(A.turn);
  const stack = fullPower(st, i);
  if (st.bugId[i] < 0) {
    if (stack < S) return 'exposed';
    return A.bestLink[i] >= S ? 'safe' : 'vulnerable';
  }
  const h = st.bugHealth[i];
  if (stack <= h) return 'cureNeeded';
  const margin = A.bestLink[i] - h;
  if (margin <= 0) return 'unprotected';
  return margin <= 2 ? 'atRisk' : 'protected';
}

export function checkGoal(st: GameState): boolean {
  if (!st.goal) return false;
  const n = st.width * st.height;
  if (st.goal.type === 'ownDCs') {
    let c = 0;
    for (let i = 0; i < n; i++) if (st.type[i] === CELL.OWNED_DC) c++;
    return c >= st.goal.count;
  }
  if (st.scriptedSpawned < st.scripted.length) return false;
  for (let i = 0; i < n; i++) if (st.bugId[i] >= 0) return false;
  return true;
}

/** Power needed to cure the bug on `c` down to where corridor work can protect it (0 when a full cure is the only way). */
export function cureToProtect(st: GameState, A: ReturnType<typeof computeSnapshot>, c: number): number {
  const h = st.bugHealth[c];
  const nb = [0, 0, 0, 0];
  const cnt = neighbors4(st, c, nb);
  let corridor = 0;
  for (let k = 0; k < cnt; k++) {
    const m = nb[k];
    if (A.comp[m] < 0) continue;
    for (let j = 0; j < A.healthyDCs.length; j++) if (A.bj[j][m] > corridor) corridor = A.bj[j][m];
  }
  const floor = Math.min(fullPower(st, c), corridor) - 1;
  return Math.max(0, h - floor);
}
