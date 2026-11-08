export const CELL = { LAND: 0, MOUNTAIN: 1, NEUTRAL_DC: 2, OWNED_DC: 3 } as const;
export type CellType = (typeof CELL)[keyof typeof CELL];

export type Dir = 'U' | 'D' | 'L' | 'R';
export type Intent = 'move' | 'cure';
export type SplitMode = 'auto' | 'half' | 'keep' | 'all1';
export const MODE_CODE: Record<SplitMode, number> = { auto: 0, half: 1, keep: 2, all1: 3 };

export interface QueuedStep {
  target: number;
  intent: Intent;
}

export interface Path {
  id: number;
  mode: SplitMode;
  n: number; // Keep N's value; 0 otherwise
  origin: number;
  current: number; // cell holding its power: target of the last successful step, or origin
  travelling: number; // unmerged amount sitting in `current` (0 until the first step executes)
  executed: number;
  steps: QueuedStep[];
}

/** Fields the simulation ignores: the gesture number, and the client's wall-clock time (anomaly checks only). */
export interface OpMeta { gid?: number; ts?: number }

export type LogOp = OpMeta & (
  | {
      g: number;
      op: 'step';
      path: number | 'new';
      from?: number;
      dir: Dir;
      intent: Intent;
      mode?: SplitMode;
      n?: number;
    }
  | { g: number; op: 'removePath'; path: number }
  | { g: number; op: 'clear' }
  | { g: number; op: 'pause' }
  | { g: number; op: 'resume' });

export type FailCause = 'mountain' | 'frozenMove' | 'immune' | 'sourceLost' | 'nothingToSend';
export type PathEndCause = 'done' | 'shortAttack' | 'partialCure' | 'cureExhausted' | 'frozen' | 'removed' | 'cleared' | FailCause;

export interface StepEvent {
  pathId: number;
  from: number;
  to: number;
  sent: number;
  kind: 'move' | 'claim' | 'capture' | 'shortAttack' | 'cure' | 'partialCure' | 'fail';
  cause?: FailCause;
  arrived: number; // power that landed in `to` (0 when destroyed or failed)
}

export interface TicEvents {
  g: number;
  turn: number;
  tic: 0 | 1;
  step: StepEvent | null;
  idle: boolean;
  endedPaths: { id: number; cause: PathEndCause; at: number }[];
  spawns: { cell: number; id: number; health: number; kind: 'dc' | 'land' | 'scripted' }[];
  spreads: { from: number; to: number; id: number; health: number }[];
  immunityEnded: number[]; // cells whose bug became curable this turn
  protectedNow: number[]; // compromised DCs protected in snapshot A this turn
  turnResolved: { turn: number; hash: number } | null;
  goalMet: boolean;
}

export interface MapData {
  width: number;
  height: number;
  type: Uint8Array;
  cost: Int32Array;
  spawn: number;
}

export interface GenerationLog {
  attempts: number;
  m: number;
  pocketFill: number;
  dcsPlaced: number;
  dcsWanted: number;
  fallbacks: number;
}

export interface ScriptedBug {
  turn: number;
  cell: [number, number];
  health: number;
}

export interface TutorialHint {
  on: string;
  text: string;
}

export interface Tutorial {
  id: string;
  title: string;
  width: number;
  height: number;
  rows: string[];
  owned?: { cell: [number, number]; power: number }[];
  dcCosts?: Record<string, number>;
  fog?: boolean;
  randomBugs?: boolean;
  scriptedBugs?: ScriptedBug[];
  turnSeconds?: number;
  goal: { type: 'ownDCs'; count: number } | { type: 'cureScripted' };
  hints?: TutorialHint[];
  seed?: number; // only used when randomBugs is true
}

export interface Telemetry {
  v: 6;
  kind: 'practice' | 'ranked' | 'tutorial';
  seed: string;
  score: number;
  generation: GenerationLog | null;
  firstCaptureTurn: number | null;
  bugs: { spawned: number; cured: number; ignored: number };
  powerLost: { capture: number; shortAttack: number; cure: number; decrement: number };
  frozenShareEvery10: number[];
  notEarningShareEvery10: number[];
  steps: { expand: number; reinforce: number; cure: number; idle: number };
  failedByCause: Record<FailCause, number>;
  queueEdits: { clear: number; removePath: number };
  dcStatusTurns: Record<DCStatus, number>;
  turnsNoHealthyDC: number;
  tutorial: { id: string; completed: boolean; hintsReached: string[] } | null;
}

export type DCStatus = 'safe' | 'vulnerable' | 'exposed' | 'cureNeeded' | 'unprotected' | 'atRisk' | 'protected';

export type GameKind = 'practice' | 'ranked' | 'tutorial';

export interface GameState {
  kind: GameKind;
  /** Practice: plain seed for every stream. Ranked / practice-with-keys: map seed for stream 0. */
  seed: number;
  /** Where streams 1–3 take their seed from. */
  keySource: 'seed' | 'keys';
  bugKeys: Map<number, number>; // turn → key
  width: number;
  height: number;
  turn: number; // turn in progress (1-based)
  tic: 0 | 1; // next tic within the turn
  finished: boolean;
  turnLimit: number; // 0 = none (tutorials)
  spawnStart: number; // first turn bugs may spawn (30)
  randomBugs: boolean;
  fog: boolean;
  scripted: ScriptedBug[];
  goal: Tutorial['goal'] | null;
  tutorialId: string | null;

  type: Uint8Array;
  owned: Uint8Array;
  power: Int32Array;
  travel: Int32Array;
  cost: Int32Array;
  acc: Int32Array;
  bugId: Int32Array;
  bugHealth: Int32Array;
  immunity: Int32Array;
  nextGrowth: Int32Array;
  nextSpread: Int32Array;
  decCounter: Int32Array;
  protectedFlag: Uint8Array;
  visible: Uint8Array;

  nextBugId: number;
  nextPathId: number;
  paused: 0 | 1;
  pausesUsed: number;
  queue: Path[];

  hashes: number[];
  snapA: Snapshot | null;
  telemetry: Telemetry;
  generation: GenerationLog | null;
  /** Internal: scripted bugs that have spawned (for cureScripted goal). */
  scriptedSpawned: number;
  /** Internal: tutorial hint triggers reached. */
  hintsReached: string[];
  /** Internal accounting for the conservation property (not hashed). */
  accounting: { produced: number; landIncome: number };
}

export interface Snapshot {
  turn: number;
  /** Forest component id per cell, −1 when not in the forest (unowned, frozen, mountain, neutral). */
  comp: Int32Array;
  /** 1 when the cell's component contains a healthy DC. */
  anchored: Uint8Array;
  /** R(n): best bottleneck from n to any healthy DC. */
  R: Int32Array;
  /** B_best per owned non-frozen cell (DC: to another healthy DC; land: best R over neighbours). */
  Bbest: Int32Array;
  /** Per owned DC (healthy or compromised): best link to another healthy DC, 0 if none. */
  bestLink: Int32Array;
  /** Per owned DC: top-10 links, strongest first. */
  links: Map<number, { j: number; b: number }[]>;
  /** Pairwise bottleneck lookup for a healthy DC j: index into bj. */
  healthyDCs: number[];
  bj: Int32Array[];
}

export class InvalidOpError extends Error {}
export class MissingKeyError extends Error {}
