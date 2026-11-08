// Replay viewer (doc §Screen flow 7): play, pause, 1×/2×/4×, a turn slider. Seeking re-simulates from
// a cached state saved every 10 turns. The board shows without fog, with the player's vision outlined.
import {
  CELL, applyOp, cloneState, computeSnapshot, createGame, dcStatus, globalTic, preview, stepTic, InputController,
  type DCStatus, type GameConfig, type GameState, type LogOp, type QueuePreview, type Snapshot,
} from '../../sim.ts';
import { BoardView, type Overlay } from '../../render/board.ts';
import { drawFx, type Effect } from '../../render/fx.ts';
import { Loop } from '../../loop.ts';
import { Hud } from '../hud.ts';
import { h } from '../dom.ts';
import { spreadTargets } from '../../analysis.ts';
import type { Screen } from '../../main.ts';

export interface ReplayOpts { config: GameConfig; log: LogOp[]; title: string; onBack: () => void }

interface Cached { st: GameState; op: number }

export class ReplayScreen implements Screen {
  readonly el: HTMLElement;
  private st: GameState;
  private opIndex = 0;
  private readonly log: LogOp[];
  private readonly config: GameConfig;
  private readonly cache = new Map<number, Cached>(); // turn → state at the start of that turn
  private lastTurn = 1;
  private readonly view = new BoardView();
  private readonly hud: Hud;
  private readonly loop: Loop;
  private readonly boardWrap: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly playBtn: HTMLElement;
  private readonly speedBtns: HTMLElement[];
  private readonly errEl = h('div.board-banner.hidden');
  private playing = false;
  private speed = 1;
  private overlay: Overlay = 'power';
  private snap!: Snapshot;
  private statuses = new Map<number, DCStatus>();
  private prev: QueuePreview | null = null;
  private hover = -1;
  private effects: Effect[] = [];
  private ro: ResizeObserver;
  private readonly dummyCtl: InputController;
  private readonly onKeyBound = (e: KeyboardEvent) => this.onKey(e);

  constructor(opts: ReplayOpts) {
    this.log = opts.log;
    this.config = opts.config;
    this.st = createGame(opts.config);
    this.dummyCtl = new InputController(this.st);
    this.playBtn = h('button.btn.btn-small.btn-primary', { on: { click: () => this.setPlaying(!this.playing) } }, 'Play');
    this.speedBtns = [1, 2, 4].map((s) => h('button.btn.btn-small.seg' + (s === 1 ? '.active' : ''), { on: { click: () => this.setSpeed(s) } }, `${s}×`));
    this.slider = h('input.slider', { type: 'range', min: '1', max: '300', value: '1' }) as HTMLInputElement;
    this.slider.addEventListener('input', () => this.seek(Number(this.slider.value)));
    const back = h('button.btn.btn-small.btn-ghost', { on: { click: () => opts.onBack() } }, 'Back');
    this.hud = new Hud({ kind: 'replay', actions: [this.playBtn, h('div.seg-group', ...this.speedBtns), back], onRemove: () => {}, onClear: () => {}, showKeys: false });
    this.boardWrap = h('div.board-wrap', this.view.el, this.errEl);
    this.el = h('div.screen.game.replay',
      this.hud.top,
      h('div.game-main',
        h('div.board-col', this.boardWrap, h('div.replay-bar', h('span.muted', 'Turn'), this.slider, h('span.seedbar-inline', opts.title))),
        this.hud.panel),
    );
    this.loop = new Loop(500, { canRun: () => this.playing, tick: () => this.tickOnce(true), frame: (now) => this.frame(now) });
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.boardWrap);
    const fx = this.view.fx;
    fx.addEventListener('pointermove', (e) => {
      const c = this.view.cellAt(e.clientX, e.clientY);
      if (c !== this.hover) { this.hover = c; this.hud.updateDetails(this.hudCtx(), c); }
    });
    fx.addEventListener('pointerleave', () => { this.hover = -1; this.hud.updateDetails(this.hudCtx(), null); });
    this.buildCache();
  }

  mount(): void {
    document.addEventListener('keydown', this.onKeyBound);
    this.layout();
    this.refresh();
    this.loop.start();
  }

  unmount(): void {
    this.loop.stop();
    this.ro.disconnect();
    document.removeEventListener('keydown', this.onKeyBound);
  }

  /** One pass over the whole run, caching the state every 10 turns. */
  private buildCache(): void {
    const st = createGame(this.config);
    let op = 0;
    try {
      for (;;) {
        if (st.tic === 0 && (st.turn - 1) % 10 === 0) this.cache.set(st.turn, { st: cloneState(st), op });
        if (st.finished) break;
        op = this.applyOpsAt(st, op);
        stepTic(st);
        if (st.turnLimit === 0 && st.turn > 2000) break; // never for real runs
      }
    } catch (e) {
      this.errEl.textContent = `This replay stops early: ${(e as Error).message}`;
      this.errEl.classList.remove('hidden');
    }
    this.lastTurn = Math.max(1, st.turn); // after a full run this is 301: the board after turn 300 resolved
    this.slider.max = String(this.lastTurn);
  }

  private applyOpsAt(st: GameState, from: number): number {
    let i = from;
    const g = globalTic(st);
    while (i < this.log.length && this.log[i].g <= g) applyOp(st, this.log[i++]);
    return i;
  }

  private tickOnce(animate: boolean): void {
    const st = this.st;
    if (st.finished) { this.setPlaying(false); return; }
    try {
      this.opIndex = this.applyOpsAt(st, this.opIndex);
      const ev = stepTic(st);
      if (animate) {
        const now = performance.now();
        if (ev.step?.kind === 'capture') this.effects.push({ kind: 'capture', cell: ev.step.to, t0: now });
        if (ev.step?.kind === 'cure') this.effects.push({ kind: 'cure', cell: ev.step.to, t0: now });
        for (const s of ev.spawns) this.effects.push({ kind: 'spawn', cell: s.cell, t0: now });
        for (const s of ev.spreads) this.effects.push({ kind: 'spread', cell: s.to, from: s.from, t0: now });
      }
    } catch (e) {
      this.setPlaying(false);
      this.errEl.textContent = `Replay error: ${(e as Error).message}`;
      this.errEl.classList.remove('hidden');
      return;
    }
    if (st.finished) this.setPlaying(false);
    this.slider.value = String(Math.min(st.turn, this.lastTurn));
    if (animate) this.refresh();
  }

  private seek(turn: number): void {
    const base = Math.floor((turn - 1) / 10) * 10 + 1;
    const c = this.cache.get(base) ?? this.cache.get(1)!;
    this.st = cloneState(c.st);
    this.dummyCtl.st = this.st;
    this.opIndex = c.op;
    while (this.st.turn < turn && !this.st.finished) this.tickOnce(false);
    this.refresh();
  }

  private setPlaying(p: boolean): void {
    if (p && this.st.finished) this.seek(1);
    this.playing = p;
    this.playBtn.textContent = p ? 'Pause' : 'Play';
    this.loop.reset();
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.loop.interval = 500 / s;
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', [1, 2, 4][i] === s));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'Space' || e.code === 'KeyP') { e.preventDefault(); if (!e.repeat) this.setPlaying(!this.playing); }
    else if (e.code === 'Tab') { e.preventDefault(); const o: Overlay[] = ['power', 'connectivity', 'hot']; this.overlay = o[(o.indexOf(this.overlay) + 1) % 3]; this.refresh(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); this.seek(Math.min(this.lastTurn, this.st.turn + 10)); this.slider.value = String(this.st.turn); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); this.seek(Math.max(1, this.st.turn - 10)); this.slider.value = String(this.st.turn); }
  }

  private layout(): void {
    const r = this.boardWrap.getBoundingClientRect();
    this.view.layout(this.st.width, this.st.height, Math.max(200, r.width - 8), Math.max(200, r.height - 8));
    this.refresh();
  }

  private hudCtx() {
    return { st: this.st, ctl: this.dummyCtl, snap: this.snap, statuses: this.statuses, preview: this.prev, overlay: this.overlay, kind: 'replay' as const };
  }

  private refresh(): void {
    const st = this.st;
    this.snap = computeSnapshot(st);
    this.statuses.clear();
    for (let i = 0; i < st.width * st.height; i++) if (st.type[i] === CELL.OWNED_DC) this.statuses.set(i, dcStatus(st, this.snap, i));
    this.prev = st.queue.length ? preview(st) : null;
    this.view.drawStatic({ st, snap: this.snap, statuses: this.statuses, spreadTargets: spreadTargets(st), overlay: this.overlay, reveal: true });
    this.hud.updateTop(this.hudCtx());
    this.hud.updateDetails(this.hudCtx(), this.hover >= 0 ? this.hover : null);
    this.speed = this.speed;
  }

  private frame(now: number): void {
    drawFx(this.view, {
      st: this.st, preview: this.prev, cursor: null, selected: null, hover: this.hover, halfNext: false, drain: new Set(),
      statuses: this.statuses, cureWindow: [], weakest: this.hud.weakestFromDetails, effects: this.effects, shake: null,
    }, now);
  }
}
