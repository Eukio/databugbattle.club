// Multiplayer engine: generals.io-style matches for 2–8 players on one shared grid, with the single-player
// rules applied to each player's own network (safe level, production and link bonus, land income, bugs).
//
// Differences from single player:
//  - Cells have an owner (−1 neutral). Moving into an enemy cell attacks it: arriving power minus its power;
//    more than 0 left captures the cell (and the path carries on with the rest), otherwise it is chipped.
//  - Each player starts on an HQ data center. Capturing an enemy HQ eliminates that player: all their cells
//    go to the captor with power halved (rounded up). Bugs on captured cells stay, now in the captor's network.
//  - Teams: allies share vision and can't attack each other; moving into an ally's cell gives it the power.
//  - Win: last team standing; or when the turn limit is reached, the team with the most total power.
//  - The server runs this authoritatively; clients only send queue ops. Determinism is kept anyway (seeded RNG).
import { CELL, InvalidOpError, type Dir, type Intent, type Path, type PathEndCause, type FailCause, type SplitMode, type GameState, type Snapshot } from './types.ts';
import { computeSnapshot } from './connectivity.ts';
import { safeLevel, thresholdMilli, bugCap, IMMUNITY, GROWTH_INTERVAL, SPREAD_INTERVAL, LAND_INCOME_INTERVAL, SPAWN_START } from './game.ts';
import { mix, uniform, weightedIndex, STREAM } from './rng.ts';

export const MP_MAX_PLAYERS = 8;
export type MpMode = '1v1' | '2v2' | 'ffa' | 'custom';

export interface MpPlayerInit { name: string; team: number }

export interface MpPlayer extends MpPlayerInit {
  hq: number;
  alive: boolean;
  surrendered: boolean;
  eliminatedTurn: number | null;
  eliminatedBy: number | null;
  queue: Path[];
  nextPathId: number;
  /** Paths that ended since the last frame (for the client's controller). Drained by mpFrame. */
  ended: { id: number; cause: PathEndCause | 'gift' | 'eliminated'; at: number }[];
}

export interface MpState {
  seed: number;
  mode: MpMode;
  width: number;
  height: number;
  turn: number;
  tic: 0 | 1;
  turnLimit: number;
  bugs: boolean;
  finished: boolean;
  winners: number[] | null; // player indices
  endReason: 'elimination' | 'time' | null;

  type: Uint8Array; // LAND, MOUNTAIN, NEUTRAL_DC (unowned DC), OWNED_DC (a DC with an owner)
  owner: Int8Array;
  power: Int32Array;
  travel: Int32Array;
  cost: Int32Array; // neutral DCs
  acc: Int32Array;
  bugId: Int32Array;
  bugHealth: Int32Array;
  immunity: Int32Array;
  nextGrowth: Int32Array;
  nextSpread: Int32Array;
  decCounter: Int32Array;
  protectedFlag: Uint8Array;
  nextBugId: number;
  players: MpPlayer[];
}

export interface MpStepEvent { player: number; from: number; to: number; sent: number; kind: 'move' | 'claim' | 'capture' | 'attack' | 'shortAttack' | 'gift' | 'cure' | 'partialCure' | 'fail'; cause?: FailCause; victim?: number }
export interface MpEvents {
  turn: number;
  tic: 0 | 1;
  steps: MpStepEvent[];
  spawns: { cell: number; owner: number; health: number }[];
  spreads: { from: number; to: number; health: number }[];
  eliminated: { who: number; by: number | null }[];
  turnResolved: boolean;
  finished: boolean;
}

// ---------- map ----------

export function mpMapSize(players: number): number {
  return players <= 2 ? 20 : players <= 4 ? 24 : players <= 6 ? 28 : 32;
}
export function mpTurnLimit(players: number): number {
  return players <= 2 ? 300 : 400;
}

function bfs(w: number, h: number, passable: (i: number) => boolean, from: number): Int32Array {
  const n = w * h;
  const d = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  let qh = 0, qt = 0;
  d[from] = 0;
  q[qt++] = from;
  while (qh < qt) {
    const u = q[qh++];
    const r = (u / w) | 0, c = u - r * w;
    const nb = [r > 0 ? u - w : -1, r < h - 1 ? u + w : -1, c > 0 ? u - 1 : -1, c < w - 1 ? u + 1 : -1];
    for (const v of nb) if (v >= 0 && d[v] < 0 && passable(v)) { d[v] = d[u] + 1; q[qt++] = v; }
  }
  return d;
}

export interface MpMap { width: number; height: number; type: Uint8Array; cost: Int32Array; spawns: number[] }

/** Map for n players: mountains (~22%), pocket fill, spaced spawns, neutral DCs costing 12–24 kept off spawns. */
export function generateMpMap(seed: number, n: number): MpMap {
  const W = mpMapSize(n), H = W, N = W * H;
  for (let attempt = 0; attempt < 200; attempt++) {
    let slot = 0;
    const draw = (k: number) => uniform(seed, STREAM.MAP, attempt, slot++, k);
    const type = new Uint8Array(N);
    for (let i = 0; i < N; i++) type[i] = draw(100) < 22 ? CELL.MOUNTAIN : CELL.LAND;
    // Pocket fill: keep only the largest open region.
    const comp = new Int32Array(N).fill(-1);
    let best = -1, bestSize = 0;
    for (let i = 0, id = 0; i < N; i++) {
      if (type[i] === CELL.MOUNTAIN || comp[i] >= 0) continue;
      const d = bfs(W, H, (v) => type[v] !== CELL.MOUNTAIN, i);
      let size = 0;
      for (let v = 0; v < N; v++) if (d[v] >= 0) { comp[v] = id; size++; }
      if (size > bestSize) { bestSize = size; best = id; }
      id++;
    }
    if (bestSize < 0.6 * N) continue;
    for (let i = 0; i < N; i++) if (type[i] !== CELL.MOUNTAIN && comp[i] !== best) type[i] = CELL.MOUNTAIN;
    const open = (i: number) => type[i] !== CELL.MOUNTAIN;
    const openNbrs = (i: number) => {
      const r = (i / W) | 0, c = i - r * W;
      let k = 0;
      if (r > 0 && open(i - W)) k++;
      if (r < H - 1 && open(i + W)) k++;
      if (c > 0 && open(i - 1)) k++;
      if (c < W - 1 && open(i + 1)) k++;
      return k;
    };
    const L: number[] = [];
    for (let i = 0; i < N; i++) if (open(i) && openNbrs(i) >= 2) L.push(i);
    // Farthest-point spawns, by walking distance.
    const spawns = [L[draw(L.length)]];
    const minD = bfs(W, H, open, spawns[0]);
    while (spawns.length < n) {
      let pick = -1;
      for (const c of L) if (pick < 0 || minD[c] > minD[pick]) pick = c;
      spawns.push(pick);
      const d = bfs(W, H, open, pick);
      for (let i = 0; i < N; i++) if (d[i] >= 0 && (minD[i] < 0 || d[i] < minD[i])) minD[i] = d[i];
    }
    // Re-place the random first spawn as far as possible from the others (balances 1v1).
    {
      const others = spawns.slice(1);
      const dist = new Int32Array(N).fill(-1);
      for (const s of others) {
        const d = bfs(W, H, open, s);
        for (let i = 0; i < N; i++) if (d[i] >= 0 && (dist[i] < 0 || d[i] < dist[i])) dist[i] = d[i];
      }
      let pick = spawns[0];
      for (const c of L) if (dist[c] > dist[pick]) pick = c;
      spawns[0] = pick;
    }
    let minPair = Infinity;
    for (let a = 0; a < n; a++) {
      const d = bfs(W, H, open, spawns[a]);
      for (let b = a + 1; b < n; b++) minPair = Math.min(minPair, d[spawns[b]]);
    }
    if (minPair < Math.max(8, Math.floor(W / 2.5))) continue;
    // Neutral DCs.
    const cost = new Int32Array(N);
    const nearSpawn = new Uint8Array(N);
    for (const s of spawns) {
      const d = bfs(W, H, open, s);
      for (let i = 0; i < N; i++) if (d[i] >= 0 && d[i] <= 2) nearSpawn[i] = 1;
    }
    const want = Math.round(N / 13);
    let placed = 0;
    for (let tries = 0; placed < want && tries < want * 20; tries++) {
      const i = draw(N);
      if (type[i] !== CELL.LAND || nearSpawn[i]) continue;
      type[i] = CELL.NEUTRAL_DC;
      cost[i] = 12 + draw(13);
      placed++;
    }
    // Fairness: every spawn has at least 2 DCs within 8 steps.
    let fair = true;
    for (const s of spawns) {
      const d = bfs(W, H, open, s);
      let k = 0;
      for (let i = 0; i < N; i++) if (type[i] === CELL.NEUTRAL_DC && d[i] >= 0 && d[i] <= 8) k++;
      if (k < 2) { fair = false; break; }
    }
    if (!fair && attempt < 150) continue;
    return { width: W, height: H, type, cost, spawns };
  }
  throw new Error('generateMpMap: no map after 200 attempts');
}

// ---------- setup ----------

export function createMpGame(cfg: { seed: number; players: MpPlayerInit[]; mode?: MpMode; turnLimit?: number; bugs?: boolean }): MpState {
  const n = cfg.players.length;
  if (n < 2 || n > MP_MAX_PLAYERS) throw new Error('2–8 players');
  const map = generateMpMap(cfg.seed >>> 0, n);
  const N = map.width * map.height;
  // Assign spawns: teammates on nearby spawns.
  const open = (i: number) => map.type[i] !== CELL.MOUNTAIN;
  const dist = map.spawns.map((s) => bfs(map.width, map.height, open, s));
  const free = new Set(map.spawns.map((_, k) => k));
  const assign = new Array<number>(n).fill(-1);
  const teams = [...new Set(cfg.players.map((p) => p.team))];
  for (const t of teams) {
    const members = cfg.players.map((p, i) => ({ p, i })).filter((x) => x.p.team === t);
    let anchor = -1;
    for (const m of members) {
      let pick = -1;
      for (const k of free) {
        if (pick < 0) { pick = k; continue; }
        if (anchor >= 0 && dist[anchor][map.spawns[k]] < dist[anchor][map.spawns[pick]]) pick = k;
      }
      free.delete(pick);
      assign[m.i] = pick;
      if (anchor < 0) anchor = pick;
    }
  }
  const st: MpState = {
    seed: cfg.seed >>> 0,
    mode: cfg.mode ?? 'custom',
    width: map.width,
    height: map.height,
    turn: 1,
    tic: 0,
    turnLimit: cfg.turnLimit ?? mpTurnLimit(n),
    bugs: cfg.bugs ?? true,
    finished: false,
    winners: null,
    endReason: null,
    type: map.type,
    owner: new Int8Array(N).fill(-1),
    power: new Int32Array(N),
    travel: new Int32Array(N),
    cost: map.cost,
    acc: new Int32Array(N),
    bugId: new Int32Array(N).fill(-1),
    bugHealth: new Int32Array(N),
    immunity: new Int32Array(N),
    nextGrowth: new Int32Array(N),
    nextSpread: new Int32Array(N),
    decCounter: new Int32Array(N),
    protectedFlag: new Uint8Array(N),
    nextBugId: 0,
    players: cfg.players.map((p, i) => ({
      name: p.name, team: p.team, hq: map.spawns[assign[i]], alive: true, surrendered: false,
      eliminatedTurn: null, eliminatedBy: null, queue: [], nextPathId: 0, ended: [],
    })),
  };
  for (let i = 0; i < n; i++) {
    const c = st.players[i].hq;
    st.owner[c] = i;
    st.type[c] = CELL.OWNED_DC;
    st.power[c] = 1;
  }
  return st;
}

// ---------- helpers ----------

export const mpGlobalTic = (st: MpState) => 2 * (st.turn - 1) + st.tic;
const fullP = (st: MpState, c: number) => st.power[c] + st.travel[c];

export function mpDelta(st: MpState, cell: number, dir: Dir): number {
  const w = st.width, h = st.height;
  const r = (cell / w) | 0, c = cell - r * w;
  switch (dir) {
    case 'U': return r > 0 ? cell - w : -1;
    case 'D': return r < h - 1 ? cell + w : -1;
    case 'L': return c > 0 ? cell - 1 : -1;
    case 'R': return c < w - 1 ? cell + 1 : -1;
  }
}

function nbrs(st: MpState, i: number, out: number[]): number {
  const w = st.width, h = st.height;
  let k = 0;
  const r = (i / w) | 0, c = i - r * w;
  if (r > 0) out[k++] = i - w;
  if (r < h - 1) out[k++] = i + w;
  if (c > 0) out[k++] = i - 1;
  if (c < w - 1) out[k++] = i + 1;
  return k;
}

export const sameTeam = (st: MpState, a: number, b: number) => a === b || st.players[a].team === st.players[b].team;

/** Cells the viewer sees: 8-neighbourhood of every cell owned by a living teammate. Eliminated players see everything. */
export function mpVision(st: MpState, viewer: number): Uint8Array {
  const n = st.width * st.height;
  const vis = new Uint8Array(n);
  if (viewer < 0 || !st.players[viewer].alive || st.finished) { vis.fill(1); return vis; }
  const w = st.width, h = st.height;
  for (let i = 0; i < n; i++) {
    const o = st.owner[i];
    if (o < 0 || !st.players[o].alive || !sameTeam(st, o, viewer)) continue;
    const r = (i / w) | 0, c = i - r * w;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < h && cc >= 0 && cc < w) vis[rr * w + cc] = 1;
    }
  }
  return vis;
}

/** One player's network as a GameState-shaped view, so single-player connectivity applies unchanged. */
export function mpProjection(st: MpState, p: number): GameState {
  const n = st.width * st.height;
  const owned = new Uint8Array(n);
  const type = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const mine = st.owner[i] === p;
    owned[i] = mine ? 1 : 0;
    type[i] = st.type[i] === CELL.OWNED_DC && !mine ? CELL.NEUTRAL_DC : st.type[i];
  }
  return { width: st.width, height: st.height, turn: st.turn, owned, type, power: st.power, travel: st.travel, bugId: st.bugId } as unknown as GameState;
}

export function mpScores(st: MpState): { army: number; land: number; dcs: number }[] {
  const out = st.players.map(() => ({ army: 0, land: 0, dcs: 0 }));
  const n = st.width * st.height;
  for (let i = 0; i < n; i++) {
    const o = st.owner[i];
    if (o < 0) continue;
    out[o].army += fullP(st, i);
    out[o].land++;
    if (st.type[i] === CELL.OWNED_DC) out[o].dcs++;
  }
  return out;
}

// ---------- ops ----------

export type MpOp =
  | { op: 'step'; path: number | 'new'; from?: number; dir: Dir; intent: Intent; mode?: SplitMode; n?: number }
  | { op: 'removePath'; path: number }
  | { op: 'clear' };

function endPath(st: MpState, p: number, path: Path, cause: MpPlayer['ended'][number]['cause']): void {
  const P = st.players[p];
  const idx = P.queue.indexOf(path);
  if (idx === -1) return;
  if (path.travelling > 0) {
    st.power[path.current] += path.travelling;
    st.travel[path.current] -= path.travelling;
    path.travelling = 0;
  }
  P.queue.splice(idx, 1);
  P.ended.push({ id: path.id, cause, at: path.current });
}

/** Apply a queue op for player p. Throws InvalidOpError when it can't apply (the server ignores it; the client resyncs). */
export function mpApplyOp(st: MpState, p: number, op: MpOp, vision?: Uint8Array): void {
  const P = st.players[p];
  if (!P || !P.alive || st.finished) throw new InvalidOpError('not playing');
  switch (op.op) {
    case 'step': {
      let path: Path | undefined;
      let from: number;
      let mode: SplitMode = 'auto';
      let n = 0;
      const N = st.width * st.height;
      if (!['U', 'D', 'L', 'R'].includes(op.dir)) throw new InvalidOpError('bad dir');
      if (op.path === 'new') {
        if (!Number.isInteger(op.from) || op.from! < 0 || op.from! >= N) throw new InvalidOpError('new path needs a valid from');
        mode = op.mode ?? 'auto';
        if (!['auto', 'half', 'keep', 'all1'].includes(mode)) throw new InvalidOpError('bad mode');
        if (mode === 'keep') {
          n = op.n ?? 0;
          if (!Number.isInteger(n) || n < 1 || n > 999) throw new InvalidOpError('keep N must be 1..999');
        }
        from = op.from!;
      } else {
        path = P.queue.find((q) => q.id === op.path);
        if (!path) throw new InvalidOpError(`path ${op.path} has ended`);
        from = path.steps.length ? path.steps[path.steps.length - 1].target : path.origin;
      }
      if (P.queue.reduce((s, q) => s + q.steps.length - q.executed, 0) >= 500) throw new InvalidOpError('queue is full');
      const target = mpDelta(st, from, op.dir);
      if (target < 0) throw new InvalidOpError('target off grid');
      const vis = vision ?? mpVision(st, p);
      if (vis[target] && st.type[target] === CELL.MOUNTAIN) throw new InvalidOpError('visible mountain');
      const intent: Intent = st.owner[target] === p && st.bugId[target] >= 0 ? 'cure' : 'move';
      if (op.intent !== intent) throw new InvalidOpError('intent does not match');
      if (!path) {
        path = { id: P.nextPathId++, mode, n, origin: from, current: from, travelling: 0, executed: 0, steps: [] };
        P.queue.push(path);
      }
      path.steps.push({ target, intent });
      return;
    }
    case 'removePath': {
      const path = P.queue.find((q) => q.id === op.path);
      if (!path) throw new InvalidOpError('path has ended');
      endPath(st, p, path, 'removed');
      return;
    }
    case 'clear':
      for (const q of P.queue.slice()) endPath(st, p, q, 'cleared');
      return;
    default:
      throw new InvalidOpError('unknown op');
  }
}

// ---------- tics ----------

function clearBug(st: MpState, c: number): void {
  st.bugId[c] = -1;
  st.bugHealth[c] = 0;
  st.immunity[c] = 0;
  st.nextGrowth[c] = 0;
  st.nextSpread[c] = 0;
  st.decCounter[c] = 0;
  st.protectedFlag[c] = 0;
}

function freeze(st: MpState, c: number, health: number): void {
  st.bugId[c] = st.nextBugId++;
  st.bugHealth[c] = health;
  st.immunity[c] = IMMUNITY;
  st.nextGrowth[c] = st.turn + GROWTH_INTERVAL;
  st.nextSpread[c] = st.type[c] === CELL.LAND ? st.turn + SPREAD_INTERVAL : 0;
  st.decCounter[c] = 0;
  st.protectedFlag[c] = 0;
  const o = st.owner[c];
  if (o >= 0) {
    const head = st.players[o].queue[0];
    if (head && head.executed > 0 && head.current === c) endPath(st, o, head, 'frozen');
  }
}

/** End every path of player q that holds power in cell c (merging it), before c changes hands. */
function releaseCell(st: MpState, q: number, c: number): void {
  for (const path of st.players[q].queue.slice()) if (path.executed > 0 && path.current === c) endPath(st, q, path, 'sourceLost');
}

function eliminate(st: MpState, q: number, by: number | null, ev: MpEvents): void {
  const Q = st.players[q];
  if (!Q.alive) return;
  for (const path of Q.queue.slice()) endPath(st, q, path, 'eliminated');
  Q.alive = false;
  Q.eliminatedTurn = st.turn;
  Q.eliminatedBy = by;
  const n = st.width * st.height;
  for (let i = 0; i < n; i++) {
    if (st.owner[i] !== q) continue;
    if (by !== null) {
      st.owner[i] = by;
      st.power[i] = Math.ceil(st.power[i] / 2);
    } else {
      // Surrender / abandon: the cells go neutral, keeping their power as a defence.
      st.owner[i] = -1;
      clearBug(st, i);
      if (st.type[i] === CELL.OWNED_DC) { st.type[i] = CELL.NEUTRAL_DC; st.cost[i] = Math.max(1, st.power[i]); st.power[i] = 0; }
    }
    st.acc[i] = 0;
  }
  ev.eliminated.push({ who: q, by });
  checkLastTeam(st, ev);
}

function checkLastTeam(st: MpState, ev: MpEvents): void {
  const teams = new Set(st.players.filter((p) => p.alive).map((p) => p.team));
  if (teams.size <= 1 && !st.finished) {
    st.finished = true;
    st.endReason = 'elimination';
    const t = [...teams][0];
    st.winners = st.players.map((p, i) => (p.team === t ? i : -1)).filter((i) => i >= 0);
    ev.finished = true;
  }
}

/** Player p surrenders (or leaves): their cells go neutral. */
export function mpSurrender(st: MpState, p: number): MpEvents {
  const ev = newEvents(st);
  if (st.players[p]?.alive && !st.finished) { st.players[p].surrendered = true; eliminate(st, p, null, ev); }
  return ev;
}

function newEvents(st: MpState): MpEvents {
  return { turn: st.turn, tic: st.tic, steps: [], spawns: [], spreads: [], eliminated: [], turnResolved: false, finished: false };
}

function executeStep(st: MpState, p: number, ev: MpEvents): void {
  const P = st.players[p];
  const path = P.queue[0];
  if (!path) return;
  const step = path.steps[path.executed];
  const src = path.executed === 0 ? path.origin : path.current;
  const tgt = step.target;
  const fail = (cause: FailCause): void => {
    ev.steps.push({ player: p, from: src, to: tgt, sent: 0, kind: 'fail', cause });
    endPath(st, p, path, cause);
  };
  if (st.type[tgt] === CELL.MOUNTAIN) return fail('mountain');
  const tOwner = st.owner[tgt];
  const mine = tOwner === p;
  const ally = tOwner >= 0 && !mine && sameTeam(st, tOwner, p);
  const enemy = tOwner >= 0 && !mine && !ally;
  const tFrozen = mine && st.bugId[tgt] >= 0;
  if (tFrozen && step.intent === 'move') return fail('frozenMove');
  if (tFrozen && st.immunity[tgt] > 0) return fail('immune');
  if (st.owner[src] !== p || st.bugId[src] >= 0) return fail('sourceLost');

  let send: number;
  let keep: number;
  const own = st.power[src];
  if (path.executed === 0) {
    switch (path.mode) {
      case 'auto': send = st.type[src] === CELL.OWNED_DC ? own - safeLevel(st.turn) : own - 1; break;
      case 'half': send = Math.floor(own / 2); break;
      case 'keep': send = own - path.n; break;
      case 'all1': send = own - 1; break;
    }
    keep = own - send;
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

  st.power[src] = keep;
  st.travel[src] -= path.travelling;
  path.travelling = 0;

  const arrive = (amount: number, kind: MpStepEvent['kind'], victim?: number) => {
    path.travelling = amount;
    st.travel[tgt] += amount;
    ev.steps.push({ player: p, from: src, to: tgt, sent: send, kind, victim });
  };
  const stopShort = (kind: MpStepEvent['kind'], victim?: number) => {
    ev.steps.push({ player: p, from: src, to: tgt, sent: send, kind, victim });
    path.current = src;
    endPath(st, p, path, kind === 'gift' ? 'gift' : kind === 'partialCure' ? 'partialCure' : 'shortAttack');
  };

  if (enemy || (tOwner < 0 && (st.type[tgt] === CELL.NEUTRAL_DC || st.power[tgt] > 0))) {
    // Attack: an enemy cell, a neutral DC (its cost), or neutral land left with power after a surrender.
    if (enemy) releaseCell(st, tOwner, tgt);
    const def = tOwner < 0 && st.type[tgt] === CELL.NEUTRAL_DC ? st.cost[tgt] : st.power[tgt];
    if (send > def) {
      const wasHq = enemy && st.players[tOwner].hq === tgt;
      st.owner[tgt] = p;
      if (st.type[tgt] === CELL.NEUTRAL_DC) { st.type[tgt] = CELL.OWNED_DC; st.cost[tgt] = 0; }
      st.power[tgt] = 0;
      st.acc[tgt] = 0;
      arrive(send - def, enemy ? 'attack' : 'capture', enemy ? tOwner : undefined);
      if (wasHq) {
        st.players[tOwner].hq = -1;
        eliminate(st, tOwner, p, ev);
      }
    } else {
      if (tOwner < 0 && st.type[tgt] === CELL.NEUTRAL_DC) st.cost[tgt] = def - send;
      else st.power[tgt] = def - send;
      stopShort('shortAttack', enemy ? tOwner : undefined);
      return;
    }
  } else if (ally) {
    st.power[tgt] += send;
    stopShort('gift', tOwner);
    return;
  } else if (tFrozen) {
    const h = st.bugHealth[tgt];
    if (send >= h) {
      clearBug(st, tgt);
      arrive(send - h, 'cure');
      if (path.travelling === 0 && path.executed + 1 < path.steps.length) {
        path.current = tgt;
        path.executed++;
        endPath(st, p, path, 'cureExhausted');
        return;
      }
    } else {
      st.bugHealth[tgt] = h - send;
      stopShort('partialCure');
      return;
    }
  } else if (tOwner < 0) {
    st.owner[tgt] = p;
    arrive(send, 'claim');
  } else {
    arrive(send, 'move');
  }
  path.current = tgt;
  path.executed++;
  if (path.executed === path.steps.length) endPath(st, p, path, 'done');
}

/** One tic: every living player's head step, in an order that rotates each tic; the second tic resolves the turn. */
export function mpStepTic(st: MpState): MpEvents {
  if (st.finished) throw new Error('match is finished');
  const ev = newEvents(st);
  const n = st.players.length;
  const g = mpGlobalTic(st);
  for (let k = 0; k < n && !st.finished; k++) {
    const p = (g + k) % n;
    if (st.players[p].alive) executeStep(st, p, ev);
  }
  if (st.finished) return ev;
  if (st.tic === 0) st.tic = 1;
  else resolveTurn(st, ev);
  return ev;
}

function keyFor(st: MpState, p: number): number {
  return mix(st.seed, 1000 + p);
}

function resolveTurn(st: MpState, ev: MpEvents): void {
  const N = st.width * st.height;
  const t = st.turn;
  const alive = st.players.map((P, i) => (P.alive ? i : -1)).filter((i) => i >= 0);
  const snaps = new Map<number, Snapshot>();
  // 3–5 per player: snapshot, protection, DC production, land income.
  const Tm = thresholdMilli(t);
  for (const p of alive) {
    const A = computeSnapshot(mpProjection(st, p));
    snaps.set(p, A);
    for (let i = 0; i < N; i++) {
      if (st.owner[i] !== p) continue;
      if (st.type[i] === CELL.OWNED_DC) {
        const frozen = st.bugId[i] >= 0;
        if (frozen) st.protectedFlag[i] = A.bestLink[i] > st.bugHealth[i] ? 1 : 0;
        if (frozen && !st.protectedFlag[i]) continue;
        let sum = 0;
        for (const { b } of A.links.get(i) ?? []) sum += b * 1000 >= Tm ? 1000 : Math.floor((b * 1000000) / Tm);
        st.acc[i] += 2000 + Math.floor((100 * sum) / 1000);
        const pay = Math.floor(st.acc[i] / 1000);
        st.acc[i] -= pay * 1000;
        st.power[i] += pay;
      } else if (st.bugId[i] < 0 && A.anchored[i] && t % LAND_INCOME_INTERVAL === 0) {
        st.power[i] += 1;
      }
    }
  }
  // 6. Growth and decrements. 7. Immunity.
  for (let i = 0; i < N; i++) {
    if (st.bugId[i] < 0) continue;
    if (st.nextGrowth[i] === t) { st.bugHealth[i]++; st.nextGrowth[i] += GROWTH_INTERVAL; }
    if (st.type[i] === CELL.LAND || !st.protectedFlag[i]) {
      st.decCounter[i]++;
      if (st.decCounter[i] >= 2) { st.decCounter[i] = 0; if (st.power[i] > 0) st.power[i]--; }
    }
  }
  for (let i = 0; i < N; i++) if (st.immunity[i] > 0) st.immunity[i]--;
  if (st.bugs) {
    // 8. Spread into the owner's weak neighbouring land.
    const due: number[] = [];
    for (let i = 0; i < N; i++) if (st.bugId[i] >= 0 && st.type[i] === CELL.LAND && st.nextSpread[i] === t) due.push(i);
    due.sort((a, b) => st.bugId[a] - st.bugId[b]);
    const nb = [0, 0, 0, 0];
    for (const cell of due) {
      if (st.bugId[cell] < 0) continue;
      st.nextSpread[cell] = t + SPREAD_INTERVAL;
      const o = st.owner[cell];
      if (o < 0) continue;
      const h = st.bugHealth[cell];
      const cnt = nbrs(st, cell, nb);
      const cand = nb.slice(0, cnt).sort((a, b) => a - b);
      let best = Infinity;
      const tied: number[] = [];
      for (const m of cand) {
        if (st.owner[m] !== o || st.type[m] !== CELL.LAND || st.bugId[m] >= 0) continue;
        const pw = fullP(st, m);
        if (pw > h) continue;
        if (pw < best) { best = pw; tied.length = 0; tied.push(m); }
        else if (pw === best) tied.push(m);
      }
      if (!tied.length) continue;
      const target = tied.length === 1 ? tied[0] : tied[uniform(keyFor(st, o), STREAM.SPREAD, t, cell, tied.length)];
      const child = Math.ceil(h / 2);
      freeze(st, target, child);
      ev.spreads.push({ from: cell, to: target, health: child });
    }
    // 9–10. Spawns: each living player's own DC and land pools, as in single player.
    if (t >= SPAWN_START) {
      const weightOf = (b: number) => Math.max(1, Math.floor(1000 / (1 + b)));
      for (const p of alive) {
        const B = computeSnapshot(mpProjection(st, p));
        const key = keyFor(st, p);
        let dcCount = 0, landCount = 0;
        for (let i = 0; i < N; i++) {
          if (st.owner[i] !== p) continue;
          if (st.type[i] === CELL.OWNED_DC) dcCount++; else landCount++;
        }
        if (uniform(key, STREAM.DC_POOL, t, 0, 1000) < Math.min(400, 10 * dcCount)) {
          const level = 1 + uniform(key, STREAM.DC_POOL, t, 1, bugCap(t));
          const cand: number[] = [];
          for (let i = 0; i < N; i++) if (st.owner[i] === p && st.type[i] === CELL.OWNED_DC && st.bugId[i] < 0) cand.push(i);
          if (cand.length) {
            const c = cand[weightedIndex(key, STREAM.DC_POOL, t, 2, cand.map((x) => weightOf(B.Bbest[x])))];
            freeze(st, c, level);
            ev.spawns.push({ cell: c, owner: p, health: level });
          }
        }
        if (uniform(key, STREAM.LAND_POOL, t, 0, 1000) < Math.min(150, 2 * landCount)) {
          const level = 1 + uniform(key, STREAM.LAND_POOL, t, 1, bugCap(t));
          const cand: number[] = [];
          for (let i = 0; i < N; i++) if (st.owner[i] === p && st.type[i] === CELL.LAND && st.bugId[i] < 0 && fullP(st, i) <= level) cand.push(i);
          if (cand.length) {
            const c = cand[weightedIndex(key, STREAM.LAND_POOL, t, 2, cand.map((x) => weightOf(B.Bbest[x])))];
            freeze(st, c, level);
            ev.spawns.push({ cell: c, owner: p, health: level });
          }
        }
      }
    }
  }
  ev.turnResolved = true;
  st.turn++;
  st.tic = 0;
  if (t >= st.turnLimit && !st.finished) {
    // Time: the team with the most total power wins (ties share the win).
    const scores = mpScores(st);
    const teamPower = new Map<number, number>();
    st.players.forEach((P, i) => { if (P.alive) teamPower.set(P.team, (teamPower.get(P.team) ?? 0) + scores[i].army); });
    const top = Math.max(...teamPower.values());
    const winTeams = new Set([...teamPower].filter(([, v]) => v === top).map(([k]) => k));
    st.finished = true;
    st.endReason = 'time';
    st.winners = st.players.map((P, i) => (P.alive && winTeams.has(P.team) ? i : -1)).filter((i) => i >= 0);
    ev.finished = true;
  }
}

// ---------- frames (server → client) ----------

/** Cell kinds in a frame: what the viewer can see of each cell. */
export const MPK = { FOG: 0, FOG_OBSTACLE: 1, LAND: 2, MOUNTAIN: 3, DC: 4 } as const;

export interface MpFrame {
  type: 'frame';
  turn: number;
  tic: 0 | 1;
  /** Per cell: MPK kind. */
  k: number[];
  /** Per cell: owner (−1), visible cells only. */
  o: number[];
  /** Per cell: power. Own cells: power without travelling; others: full power; neutral DC: cost. */
  p: number[];
  /** Own cells with travelling power: [cell, amount]. */
  tr: [number, number][];
  /** Visible bugs: [cell, health, immunity, nextSpread, nextGrowth, decCounter, protected]. */
  bugs: [number, number, number, number, number, number, number][];
  /** Visible HQs: [cell, player]. */
  hqs: [number, number][];
  queue: Path[];
  nextPathId: number;
  ended: MpPlayer['ended'];
  ack: number;
  scores: { army: number; land: number; dcs: number; alive: boolean }[];
}

export function mpFrame(st: MpState, viewer: number, ack: number): MpFrame {
  const n = st.width * st.height;
  const vis = mpVision(st, viewer);
  const k = new Array<number>(n), o = new Array<number>(n), p = new Array<number>(n);
  const tr: [number, number][] = [];
  const bugs: MpFrame['bugs'] = [];
  const hqs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = st.type[i];
    if (!vis[i]) {
      k[i] = t === CELL.MOUNTAIN || t === CELL.NEUTRAL_DC || t === CELL.OWNED_DC ? MPK.FOG_OBSTACLE : MPK.FOG;
      o[i] = -1;
      p[i] = 0;
      continue;
    }
    k[i] = t === CELL.MOUNTAIN ? MPK.MOUNTAIN : t === CELL.LAND ? MPK.LAND : MPK.DC;
    o[i] = st.owner[i];
    const mine = viewer >= 0 && st.owner[i] === viewer;
    p[i] = st.owner[i] < 0 && t === CELL.NEUTRAL_DC ? st.cost[i] : mine ? st.power[i] : fullP(st, i);
    if (mine && st.travel[i]) tr.push([i, st.travel[i]]);
    if (st.bugId[i] >= 0) bugs.push([i, st.bugHealth[i], st.immunity[i], st.nextSpread[i], st.nextGrowth[i], st.decCounter[i], st.protectedFlag[i]]);
  }
  st.players.forEach((P, i) => { if (P.alive && P.hq >= 0 && vis[P.hq]) hqs.push([P.hq, i]); });
  const me = viewer >= 0 ? st.players[viewer] : null;
  const ended = me ? me.ended.splice(0) : [];
  const scores = mpScores(st).map((s, i) => ({ ...s, alive: st.players[i].alive }));
  return {
    type: 'frame', turn: st.turn, tic: st.tic, k, o, p, tr, bugs, hqs,
    queue: me ? me.queue : [], nextPathId: me ? me.nextPathId : 0, ended, ack, scores,
  };
}
