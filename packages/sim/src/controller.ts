// Input controller (design doc §Controls) with the edge cases resolved as recorded in DECISIONS.md.
// Pure: turns clicks, drags and keys into LogOps applied to the state, and keeps the selection and cursor.
import { applyOp, dirDelta, globalTic, safeLevel, MAX_PAUSES } from './game.ts';
import { isFrozen } from './connectivity.ts';
import { CELL, InvalidOpError, type Dir, type GameState, type LogOp, type SplitMode, type TicEvents } from './types.ts';

export type ControllerEvent =
  | { kind: 'refused'; cell: number } // shake the cursor
  | { kind: 'select'; cell: number }
  | { kind: 'queued'; op: LogOp }
  | { kind: 'deselect' }
  | { kind: 'halfNext'; on: boolean }
  | { kind: 'mode'; mode: SplitMode; n: number }
  | { kind: 'cursor'; cell: number | null };

export interface ControllerOptions {
  /** Called with every op the controller makes (the client appends it to the log and sends it). */
  onOp?: (op: LogOp) => void;
  onEvent?: (e: ControllerEvent) => void;
}

export class InputController {
  selected: number | null = null;
  cursor: number | null = null;
  splitMode: SplitMode = 'auto';
  keepN = 4;
  halfNext = false;
  /** Path the next step would extend; null means the next step starts a new path from the cursor. */
  private lastPathId: number | null = null;
  private nextGid = 0;
  /** After rebuilding a run from its log (crash recovery), continue gesture numbers past the old ones. */
  resumeGids(next: number): void { this.nextGid = Math.max(this.nextGid, next); }
  private press: { cell: number; dragging: boolean; stopped: boolean; gid: number; last: number } | null = null;
  readonly log: LogOp[] = [];

  st: GameState;
  private readonly opts: ControllerOptions;
  constructor(st: GameState, opts: ControllerOptions = {}) { this.st = st; this.opts = opts; }

  private emit(e: ControllerEvent): void { this.opts.onEvent?.(e); }

  private apply(op: LogOp): boolean {
    try {
      applyOp(this.st, op);
    } catch (e) {
      if (e instanceof InvalidOpError) return false;
      throw e;
    }
    this.log.push(op);
    this.opts.onOp?.(op);
    return true;
  }

  private adjacentDir(from: number, to: number): Dir | null {
    for (const d of ['U', 'D', 'L', 'R'] as Dir[]) if (dirDelta(this.st, from, d) === to) return d;
    return null;
  }

  private setCursor(cell: number | null): void {
    this.cursor = cell;
    this.emit({ kind: 'cursor', cell });
  }

  // ---- selection ----

  select(cell: number): void {
    this.selected = cell;
    this.setCursor(cell);
    this.lastPathId = null;
    this.emit({ kind: 'select', cell });
  }

  /** Space: ends the current path's queuing. The cursor stays, but keys do nothing until a new selection or an adjacent click. */
  deselect(): void {
    this.selected = null;
    this.lastPathId = null;
    this.emit({ kind: 'deselect' });
  }

  private clearAll(): void {
    this.selected = null;
    this.lastPathId = null;
    this.setCursor(null);
    this.emit({ kind: 'deselect' });
  }

  click(cell: number, gid?: number): void {
    const st = this.st;
    if (this.cursor !== null) {
      const d = this.adjacentDir(this.cursor, cell);
      if (d) { this.step(d, gid ?? this.nextGid++); return; } // a click next to the cursor is a step, even on an owned cell
    }
    if (this.selected !== null && cell === this.selected && this.cursor === this.selected) {
      this.halfNext = !this.halfNext;
      this.emit({ kind: 'halfNext', on: this.halfNext });
      return;
    }
    if (st.owned[cell]) { this.select(cell); return; }
    this.clearAll(); // unowned land, mountain or neutral DC not next to the cursor
  }

  // ---- steps ----

  /** One key press or adjacent click. Returns false when refused (off grid / visible mountain / nothing to steer). */
  step(dir: Dir, gid?: number): boolean {
    const st = this.st;
    if (this.cursor === null) return false;
    if (this.selected === null && gid === undefined) return false; // after Space, keys do nothing; adjacent clicks and drags still work
    const from = this.cursor;
    const target = dirDelta(st, from, dir);
    if (target < 0 || (st.visible[target] && st.type[target] === CELL.MOUNTAIN)) {
      this.emit({ kind: 'refused', cell: from });
      return false;
    }
    const g = globalTic(st);
    const intent = isFrozen(st, target) ? 'cure' : 'move';
    const last = this.lastPathId !== null ? st.queue.find((p) => p.id === this.lastPathId) : undefined;
    const extend = last && (last.steps.length ? last.steps[last.steps.length - 1].target : last.origin) === from;
    let op: LogOp;
    if (extend) {
      op = { g, op: 'step', path: last!.id, dir, intent, gid: gid ?? this.nextGid++ };
    } else {
      const mode: SplitMode = this.halfNext ? 'half' : this.splitMode;
      op = { g, op: 'step', path: 'new', from, dir, intent, mode, n: mode === 'keep' ? this.keepN : undefined, gid: gid ?? this.nextGid++ };
    }
    const ok = this.apply(op);
    if (!ok) { this.emit({ kind: 'refused', cell: from }); return false; }
    if (!extend) {
      this.lastPathId = st.nextPathId - 1;
      this.halfNext = false;
    }
    if (this.selected === null) this.selected = from; // an adjacent click after Space re-engages the keyboard
    this.setCursor(target);
    this.emit({ kind: 'queued', op });
    return true;
  }

  // ---- drag ----

  pointerDown(cell: number): void {
    this.press = { cell, dragging: false, stopped: false, gid: this.nextGid++, last: cell };
  }

  pointerMove(cell: number): void {
    const p = this.press;
    if (!p || p.stopped || cell === p.last) return;
    if (!p.dragging) {
      if (!this.st.owned[p.cell]) { p.stopped = true; return; } // drags only start on owned cells
      p.dragging = true;
      if (this.cursor !== p.cell) this.select(p.cell);
      else if (this.selected === null) this.selected = p.cell;
    }
    // Fill the gap from the last cell along the straight 4-directional line, horizontal first.
    const w = this.st.width;
    let cur = p.last;
    const tr = (cell / w) | 0, tc = cell - tr * w;
    while (cur !== cell) {
      const cr = (cur / w) | 0, cc = cur - cr * w;
      const d: Dir = cc !== tc ? (tc > cc ? 'R' : 'L') : tr > cr ? 'D' : 'U';
      if (!this.step(d, p.gid)) { p.stopped = true; return; } // a refused cell ends the drag's queuing
      cur = dirDelta(this.st, cur, d);
      p.last = cur;
    }
  }

  pointerUp(cell: number): void {
    const p = this.press;
    this.press = null;
    if (!p) return;
    if (!p.dragging) this.click(p.cell);
    void cell;
  }

  // ---- queue edits ----

  private jumpToPathPower(pathId: number): void {
    const p = this.st.queue.find((q) => q.id === pathId);
    if (!p) return;
    const at = p.executed > 0 ? p.current : p.origin;
    this.selected = at;
    this.setCursor(at);
    this.lastPathId = null;
  }

  clear(): void {
    const st = this.st;
    if (!st.queue.length) return;
    this.jumpToPathPower(st.queue[st.queue.length - 1].id);
    this.apply({ g: globalTic(st), op: 'clear', gid: this.nextGid++ });
  }

  removePath(pathId: number): void {
    const st = this.st;
    const isLast = st.queue.length && st.queue[st.queue.length - 1].id === pathId;
    if (isLast) this.jumpToPathPower(pathId);
    if (this.lastPathId === pathId) this.lastPathId = null;
    this.apply({ g: globalTic(st), op: 'removePath', path: pathId, gid: this.nextGid++ });
  }

  /** Right-click on overlapping previews removes the most recently queued path among them. */
  removeTopmostAt(cell: number): void {
    for (let i = this.st.queue.length - 1; i >= 0; i--) {
      const p = this.st.queue[i];
      if (p.steps.slice(p.executed).some((s) => s.target === cell) || p.current === cell) { this.removePath(p.id); return; }
    }
  }

  // ---- modes ----

  setMode(mode: SplitMode): void {
    this.splitMode = mode;
    if (mode === 'keep') this.keepN = safeLevel(this.st.turn);
    this.emit({ kind: 'mode', mode, n: this.keepN });
  }
  adjustKeep(delta: number): void {
    this.keepN = Math.max(1, Math.min(999, this.keepN + delta));
    this.emit({ kind: 'mode', mode: this.splitMode, n: this.keepN });
  }
  toggleHalfNext(): void {
    this.halfNext = !this.halfNext;
    this.emit({ kind: 'halfNext', on: this.halfNext });
  }

  // ---- pause ----

  canPause(): boolean {
    return !this.st.paused && (this.st.kind !== 'ranked' || this.st.pausesUsed < MAX_PAUSES);
  }
  pause(): boolean {
    if (!this.canPause()) return false;
    return this.apply({ g: globalTic(this.st), op: 'pause', gid: this.nextGid++ });
  }
  resume(): boolean {
    if (!this.st.paused) return false;
    return this.apply({ g: globalTic(this.st), op: 'resume', gid: this.nextGid++ });
  }

  // ---- sim feedback ----

  /** Call after every stepTic. Moves the cursor when the last path in the queue ended early. */
  onTicEvents(ev: TicEvents): void {
    for (const e of ev.endedPaths) {
      if (e.id === this.lastPathId) this.lastPathId = null;
      if (e.cause === 'done' || e.cause === 'removed' || e.cause === 'cleared') continue;
      if (this.st.queue.length === 0) { // the path that failed was the last one
        this.selected = e.at;
        this.setCursor(e.at);
      }
    }
  }

  /** Keyboard dispatch. Ignores auto-repeat. Returns true when the key was consumed. */
  key(code: string, repeat = false): boolean {
    if (repeat) return true;
    switch (code) {
      case 'KeyW': case 'ArrowUp': this.step('U'); return true;
      case 'KeyS': case 'ArrowDown': this.step('D'); return true;
      case 'KeyA': case 'ArrowLeft': this.step('L'); return true;
      case 'KeyD': case 'ArrowRight': this.step('R'); return true;
      case 'KeyZ': this.toggleHalfNext(); return true;
      case 'Digit1': this.setMode('auto'); return true;
      case 'Digit2': this.setMode('half'); return true;
      case 'Digit3': this.setMode('keep'); return true;
      case 'Digit4': this.setMode('all1'); return true;
      case 'Equal': case 'NumpadAdd': if (this.splitMode === 'keep') this.adjustKeep(1); return true;
      case 'Minus': case 'NumpadSubtract': if (this.splitMode === 'keep') this.adjustKeep(-1); return true;
      case 'KeyQ': case 'Escape': this.clear(); return true;
      case 'Space': this.deselect(); return true;
      case 'KeyP': if (this.st.paused) this.resume(); else this.pause(); return true;
      default: return false;
    }
  }
}
