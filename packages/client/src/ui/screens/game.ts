// The play screen for practice, ranked and tutorial runs.
import {
  CELL, InputController, MissingKeyError, computeSnapshot, dcStatus, globalTic, hintTriggers, preview, recordPracticeRun,
  setBugKey, stepTic, totalPower, MAX_PAUSES,
  type ControllerEvent, type DCStatus, type GameState, type LogOp, type QueuePreview, type Snapshot, type TicEvents, type Tutorial,
} from '../../sim.ts';
import { BoardView, type Overlay } from '../../render/board.ts';
import { drawFx, type Effect } from '../../render/fx.ts';
import { Loop } from '../../loop.ts';
import { Hud } from '../hud.ts';
import { h, richText } from '../dom.ts';
import { drainWarnings, spreadTargets } from '../../analysis.ts';
import { Tracker, type BugRecord } from '../../tracker.ts';
import { kv, saveRankedBackup, clearRankedBackup, saveRankedReplay, markTutorialDone } from '../../storage.ts';
import { api, isOnline } from '../../net/api.ts';
import type { RankedLink, ResultMsg } from '../../net/ranked.ts';
import type { Screen } from '../../main.ts';
import { devSpeed } from '../../dev.ts';

export interface ResultsData {
  kind: 'practice' | 'ranked';
  seedHex: string;
  seed: number;
  score: number;
  telemetry: GameState['telemetry'];
  bugs: (BugRecord & { cost: number })[];
  stranded: number;
  practice?: { isNewBest: boolean; previousBest: number | null; bugKeys?: number[] };
  ranked?: { date: string; result: ResultMsg; mapSeed: number; bugKeys: number[] };
  log: LogOp[];
}

export type GameExit =
  | { kind: 'menu' }
  | { kind: 'results'; data: ResultsData }
  | { kind: 'tutorialDone'; id: string };

export interface GameOpts {
  kind: 'practice' | 'ranked' | 'tutorial';
  st: GameState;
  seedHex: string;
  label: string;
  tutorial?: Tutorial;
  link?: RankedLink;
  bugKeys?: number[];
  restored?: boolean;
  priorLog?: LogOp[];
  tracker?: Tracker;
  onExit: (e: GameExit) => void;
}

const OVERLAYS: Overlay[] = ['power', 'connectivity', 'hot'];

export class GameScreen implements Screen {
  readonly el: HTMLElement;
  private readonly st: GameState;
  private readonly ctl: InputController;
  private readonly view = new BoardView();
  private readonly hud: Hud;
  private readonly loop: Loop;
  private readonly tracker: Tracker;
  private readonly opts: GameOpts;
  private readonly boardWrap: HTMLElement;
  private readonly overlayEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly hintStrip: HTMLElement | null;
  private snap!: Snapshot;
  private statuses = new Map<number, DCStatus>();
  private spreadT = new Set<number>();
  private drain = new Set<number>();
  private cureWindow: number[] = [];
  private prev: QueuePreview | null = null;
  private overlay: Overlay = 'power';
  private hover = -1;
  private effects: Effect[] = [];
  private shake: { cell: number; t0: number } | null = null;
  private hintQueue: { on: string; text: string }[] = [];
  private hintOpen = false;
  private goalReached = false;
  private waitingKey = false;
  private countdownEnd: number | null = null;
  private restoredStall = false;
  private confirmOpen = false;
  private ended = false;
  private pausedAt = 0;
  private ro: ResizeObserver;
  private readonly onKeyBound = (e: KeyboardEvent) => this.onKey(e);
  private readonly onVisBound = () => this.onVisibility();

  constructor(opts: GameOpts) {
    this.opts = opts;
    this.st = opts.st;
    const st = this.st;
    this.ctl = new InputController(st, { onOp: (op) => this.onOp(op), onEvent: (e) => this.onCtlEvent(e) });
    if (opts.priorLog?.length) {
      this.ctl.log.push(...opts.priorLog);
      this.ctl.resumeGids(1 + Math.max(...opts.priorLog.map((o) => o.gid ?? 0)));
    }
    this.tracker = opts.tracker ?? new Tracker(st);
    const turnSeconds = opts.tutorial?.turnSeconds ?? 1;
    this.loop = new Loop((turnSeconds * 1000) / 2 / devSpeed(), {
      canRun: () => this.canRun(),
      tick: () => this.tick(),
      frame: (now) => this.frame(now),
    });

    const pauseBtn = h('button.btn.btn-small', { on: { click: () => this.togglePause() }, title: 'Pause (P)' }, 'Pause');
    const quitBtn = h('button.btn.btn-small.btn-ghost', { on: { click: () => this.askQuit() } }, opts.kind === 'tutorial' ? 'Exit tutorial' : 'Quit');
    this.hud = new Hud({ kind: opts.kind, actions: [pauseBtn, quitBtn], onRemove: (id) => this.ctl.removePath(id), onClear: () => this.ctl.clear() });

    this.overlayEl = h('div.board-overlay.hidden');
    this.bannerEl = h('div.board-banner.hidden');
    this.boardWrap = h('div.board-wrap', this.view.el, this.overlayEl, this.bannerEl);
    this.hintStrip = opts.kind === 'tutorial' ? h('div.hint-strip') : null;
    const seedbar = h('div.seedbar', opts.kind === 'tutorial' ? `Tutorial · ${opts.tutorial?.title ?? ''}` : `Seed ${opts.seedHex} · ${opts.label}`);
    this.el = h('div.screen.game',
      this.hud.top,
      h('div.game-main', h('div.board-col', this.hintStrip, this.boardWrap, seedbar), this.hud.panel),
    );

    this.bindPointer();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.boardWrap);

    if (opts.link) {
      const link = opts.link;
      link.log = this.ctl.log;
      for (const [t, k] of link.keys) setBugKey(st, t, k);
      link.onKey = (t, k) => {
        setBugKey(st, t, k);
        if (this.waitingKey && st.bugKeys.has(st.turn)) { this.waitingKey = false; this.loop.reset(); }
        this.backup();
        this.updateBanner();
      };
      link.onStatus = () => this.updateBanner();
      link.onFatal = (code, message) => this.fatal(code, message);
    }
    if (opts.restored) this.restoredStall = true;
  }

  mount(): void {
    document.addEventListener('keydown', this.onKeyBound);
    document.addEventListener('visibilitychange', this.onVisBound);
    this.layout();
    this.refresh();
    this.loop.start();
    if (this.opts.kind === 'tutorial') this.fireHints(['start']);
    if (this.restoredStall) this.showRestored();
    (window as any).__dcg = { st: this.st, ctl: this.ctl, screen: this }; // handle for automated tests
  }

  unmount(): void {
    this.loop.stop();
    this.ro.disconnect();
    document.removeEventListener('keydown', this.onKeyBound);
    document.removeEventListener('visibilitychange', this.onVisBound);
    if (this.opts.link && !this.opts.link.finished && this.ended) this.opts.link.close();
  }

  private layout(): void {
    const r = this.boardWrap.getBoundingClientRect();
    this.view.layout(this.st.width, this.st.height, Math.max(200, r.width - 8), Math.max(200, r.height - 8));
    this.refresh();
  }

  // ---------- loop ----------

  private canRun(): boolean {
    return !this.ended && !this.st.paused && !this.hintOpen && !this.goalReached && !this.waitingKey
      && this.countdownEnd === null && !this.restoredStall && !this.confirmOpen && !this.st.finished && !this.hiddenStall;
  }

  private tick(): void {
    const st = this.st;
    if (this.opts.kind === 'tutorial' && st.tic === 0) {
      const name = `turn:${st.turn}`;
      if (!st.hintsReached.includes(name)) {
        st.hintsReached.push(name);
        if (this.fireHints([name])) return; // the hint shows before tic 1 of this turn
      }
    }
    const link = this.opts.link;
    if (link && st.tic === 0 && link.lastTurnSent < st.turn) link.sendTurn(st.turn);
    let ev: TicEvents;
    try {
      ev = stepTic(st);
    } catch (e) {
      if (e instanceof MissingKeyError) { this.waitingKey = true; this.updateBanner(); return; }
      throw e;
    }
    this.ctl.onTicEvents(ev);
    this.tracker.onTic(st, ev);
    this.addEffects(ev);
    if (this.opts.kind === 'tutorial') {
      this.fireHints(hintTriggers(st, ev));
      if (ev.goalMet) this.goalReached = true;
    }
    if (link) this.backup();
    this.refresh();
    if (st.finished) this.finish();
  }

  private frame(now: number): void {
    if (this.countdownEnd !== null) {
      const left = Math.ceil((this.countdownEnd - now) / 1000);
      if (left <= 0) {
        this.countdownEnd = null;
        this.restoredStall = false;
        if (this.st.paused) this.ctl.resume(); // also closes a pause that was open when the page went away
        this.hideOverlay();
        this.loop.reset();
      } else {
        const n = this.overlayEl.querySelector('.countdown');
        if (n) n.textContent = String(left);
      }
    }
    if (this.st.paused && this.opts.kind === 'ranked' && this.countdownEnd === null) {
      const el = this.overlayEl.querySelector('.pause-timer');
      if (el) {
        const left = Math.max(0, 600 - Math.floor((Date.now() - this.pausedAt) / 1000));
        el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left before the run counts as abandoned`;
      }
    }
    drawFx(this.view, {
      st: this.st, preview: this.prev, cursor: this.ctl.cursor, selected: this.ctl.selected, hover: this.hover,
      halfNext: this.ctl.halfNext, drain: this.drain, statuses: this.statuses, cureWindow: this.cureWindow,
      weakest: this.hud.weakestFromDetails, effects: this.effects, shake: this.shake,
    }, now);
  }

  /** Recompute everything derived from the state and redraw the static layer and the HUD. */
  private refresh(): void {
    const st = this.st;
    const n = st.width * st.height;
    this.snap = computeSnapshot(st);
    this.statuses.clear();
    this.cureWindow = [];
    for (let i = 0; i < n; i++) {
      if (st.type[i] === CELL.OWNED_DC) this.statuses.set(i, dcStatus(st, this.snap, i));
      if (st.bugId[i] >= 0 && st.type[i] === CELL.LAND && st.immunity[i] === 0 && st.nextSpread[i] - st.turn <= 3) this.cureWindow.push(i);
    }
    this.spreadT = spreadTargets(st);
    this.drain = drainWarnings(st);
    this.prev = st.queue.length ? preview(st) : null;
    this.view.drawStatic({ st, snap: this.snap, statuses: this.statuses, spreadTargets: this.spreadT, overlay: this.overlay, reveal: false });
    const ctx = this.hudCtx();
    this.hud.updateTop(ctx);
    this.hud.updateQueue(ctx);
    this.hud.updateDetails(ctx, this.detailsCell());
  }

  private hudCtx() {
    return { st: this.st, ctl: this.ctl, snap: this.snap, statuses: this.statuses, preview: this.prev, overlay: this.overlay, kind: this.opts.kind };
  }

  private detailsCell(): number | null {
    if (this.hover >= 0) return this.hover;
    return this.ctl.cursor ?? this.ctl.selected;
  }

  private addEffects(ev: TicEvents): void {
    const now = performance.now();
    const s = ev.step;
    if (s) {
      const kind = s.kind === 'capture' ? 'capture' : s.kind === 'cure' ? 'cure' : s.kind === 'fail' ? 'fail' : s.kind === 'shortAttack' || s.kind === 'partialCure' ? 'short' : s.kind === 'claim' ? 'claim' : null;
      if (kind) this.effects.push({ kind, cell: s.to, t0: now });
    }
    for (const sp of ev.spawns) this.effects.push({ kind: 'spawn', cell: sp.cell, t0: now });
    for (const sp of ev.spreads) this.effects.push({ kind: 'spread', cell: sp.to, from: sp.from, t0: now });
  }

  // ---------- input ----------

  private inputBlocked(): boolean {
    return this.ended || this.st.paused === 1 || this.restoredStall || this.countdownEnd !== null || this.confirmOpen || this.goalReached;
  }

  private onOp(op: LogOp): void {
    op.ts = Date.now();
    if (this.opts.link) this.backup();
    this.refresh();
  }

  private onCtlEvent(e: ControllerEvent): void {
    if (e.kind === 'refused') this.shake = { cell: e.cell, t0: performance.now() };
    if (this.opts.kind === 'tutorial') {
      if (e.kind === 'select') this.fireHints(['select']);
      if (e.kind === 'queued') this.fireHints(['queued']);
    }
    if (e.kind === 'mode' || e.kind === 'halfNext' || e.kind === 'select' || e.kind === 'deselect' || e.kind === 'cursor') {
      const ctx = this.hudCtx();
      this.hud.updateTop(ctx);
      if (e.kind !== 'mode' && e.kind !== 'halfNext') this.hud.updateDetails(ctx, this.detailsCell());
    }
  }

  private onKey(e: KeyboardEvent): void {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
    if (this.hintOpen && e.code === 'Enter' && !e.repeat) { e.preventDefault(); this.dismissHint(); return; }
    if (this.confirmOpen) { if (e.code === 'Escape') { e.preventDefault(); this.hideOverlay(); this.confirmOpen = false; } return; }
    if (e.code === 'Tab') {
      e.preventDefault();
      if (!e.repeat) { this.overlay = OVERLAYS[(OVERLAYS.indexOf(this.overlay) + 1) % OVERLAYS.length]; this.refresh(); }
      return;
    }
    if (e.code === 'KeyP') { e.preventDefault(); if (!e.repeat) this.togglePause(); return; }
    if (this.inputBlocked()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.ctl.key(e.code, e.repeat)) e.preventDefault();
  }

  private bindPointer(): void {
    const fx = this.view.fx;
    let pressed = false;
    fx.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.inputBlocked()) return;
      const c = this.view.cellAt(e.clientX, e.clientY);
      if (c < 0) return;
      pressed = true;
      try { fx.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      this.ctl.pointerDown(c);
    });
    fx.addEventListener('pointermove', (e) => {
      const c = this.view.cellAt(e.clientX, e.clientY);
      if (c !== this.hover) { this.hover = c; this.hud.updateDetails(this.hudCtx(), this.detailsCell()); }
      if (pressed && c >= 0 && !this.inputBlocked()) this.ctl.pointerMove(c);
    });
    fx.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !pressed) return;
      pressed = false;
      if (this.inputBlocked()) return;
      this.ctl.pointerUp(this.view.cellAt(e.clientX, e.clientY));
      this.hud.updateDetails(this.hudCtx(), this.detailsCell());
    });
    fx.addEventListener('pointerleave', () => { if (!pressed) { this.hover = -1; this.hud.updateDetails(this.hudCtx(), this.detailsCell()); } });
    fx.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.inputBlocked()) return;
      const c = this.view.cellAt(e.clientX, e.clientY);
      if (c >= 0) this.ctl.removeTopmostAt(c);
    });
  }

  // ---------- pause ----------

  private togglePause(): void {
    if (this.ended || this.hintOpen || this.confirmOpen || this.goalReached) return;
    if (this.restoredStall) { if (this.countdownEnd === null) this.startCountdown(); return; }
    if (this.st.paused) { this.requestResume(); return; }
    if (!this.ctl.canPause()) { this.flashBanner('No pauses left on this run.'); return; }
    this.ctl.pause();
    this.pausedAt = Date.now();
    if (this.opts.link) this.opts.link.sendTurn(this.st.turn); // tell the server now (10-minute pause cap)
    this.showPaused();
  }

  private requestResume(): void {
    if (this.opts.kind === 'ranked') { this.startCountdown(); return; }
    this.ctl.resume();
    this.hideOverlay();
    this.loop.reset();
  }

  private startCountdown(): void {
    this.countdownEnd = performance.now() + 3000;
    this.showOverlay(h('div.ov-card', h('div.ov-title', 'Resuming in'), h('div.countdown', '3')), true);
  }

  /**
   * Hidden tab: stall at once (client-side, nothing logged), then auto-pause if the tab is still hidden a
   * moment later. A reload or a closed tab never gets that far, so it doesn't spend a ranked pause.
   * Auto-pauses count toward the ranked budget; after the third, hiding no longer pauses or stalls.
   */
  private onVisibility(): void {
    if (!document.hidden) { if (this.hiddenStall) { this.hiddenStall = false; this.loop.reset(); } return; }
    if (this.ended || this.st.paused || this.hintOpen || this.restoredStall || this.goalReached || !this.ctl.canPause()) return;
    this.hiddenStall = true;
    setTimeout(() => {
      if (!this.hiddenStall) return;
      this.hiddenStall = false;
      if (document.hidden && !this.st.paused && !this.ended && this.ctl.canPause()) this.togglePause();
    }, 400);
  }
  private hiddenStall = false;

  private showPaused(): void {
    const ranked = this.opts.kind === 'ranked';
    const left = MAX_PAUSES - this.st.pausesUsed;
    this.showOverlay(h('div.ov-card',
      h('div.ov-title', 'Paused'),
      ranked ? h('p.muted', `${left} pause${left === 1 ? '' : 's'} left on this run.`) : h('p.muted', 'Practice runs can be paused freely.'),
      ranked ? h('p.pause-timer.muted', '') : null,
      h('button.btn.btn-primary', { on: { click: () => this.requestResume() } }, 'Resume (P)'),
    ), ranked);
  }

  private showRestored(): void {
    this.showOverlay(h('div.ov-card',
      h('div.ov-title', 'Run restored'),
      h('p.muted', 'Your ranked run was recovered from the last tic. This does not use a pause.'),
      h('button.btn.btn-primary', { on: { click: () => this.startCountdown() } }, 'Resume'),
    ), true);
  }

  private showOverlay(content: HTMLElement, hideBoard: boolean): void {
    this.overlayEl.replaceChildren(content);
    this.overlayEl.classList.remove('hidden');
    this.overlayEl.classList.toggle('opaque', hideBoard);
    this.view.el.classList.toggle('concealed', hideBoard);
    this.el.classList.toggle('concealed', hideBoard);
  }

  private hideOverlay(): void {
    this.overlayEl.classList.add('hidden');
    this.overlayEl.replaceChildren();
    this.view.el.classList.remove('concealed');
    this.el.classList.remove('concealed');
  }

  private updateBanner(): void {
    const link = this.opts.link;
    let text = '';
    if (link && !link.connected && !link.finished) text = 'Reconnecting to the server…';
    else if (this.waitingKey) text = 'Waiting for the server…';
    this.bannerEl.textContent = text;
    this.bannerEl.classList.toggle('hidden', !text);
  }

  private flashBanner(text: string): void {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.remove('hidden');
    setTimeout(() => this.updateBanner(), 1800);
  }

  // ---------- tutorials ----------

  /** Queues the hints for these triggers in the tutorial's list order. Returns true if any will show. */
  private fireHints(names: string[]): boolean {
    const tut = this.opts.tutorial;
    if (!tut) return false;
    for (const nm of names) if (!this.st.hintsReached.includes(nm)) this.st.hintsReached.push(nm);
    const shown = new Set(this.hintQueue.map((x) => x.on));
    let any = false;
    for (const hint of tut.hints ?? []) {
      if (names.includes(hint.on) && !shown.has(hint.on) && !this.shownHints.has(hint.on)) {
        this.hintQueue.push(hint);
        this.shownHints.add(hint.on);
        any = true;
      }
    }
    if (names.includes('complete') && !(tut.hints ?? []).some((x) => x.on === 'complete')) this.completeTutorial();
    if (any && !this.hintOpen) this.showNextHint();
    return any;
  }
  private shownHints = new Set<string>();

  private showNextHint(): void {
    const hint = this.hintQueue[0];
    if (!hint || !this.hintStrip) return;
    this.hintOpen = true;
    const last = hint.on === 'complete';
    const btn = h('button.btn.btn-primary', { on: { click: () => this.dismissHint() } }, last ? 'Finish' : 'Continue');
    this.hintStrip.replaceChildren(h('div.hint-card.active',
      h('div.hint-body',
        h('div.hint-kicker', last ? 'Tutorial complete' : 'Tip · the game waits for you'),
        h('p.hint-text', { html: richText(hint.text) })),
      h('div.hint-actions', btn, h('span.muted.small', 'Enter'))));
  }

  private dismissHint(): void {
    const hint = this.hintQueue.shift();
    this.hintOpen = false;
    if (hint?.on === 'complete') { this.completeTutorial(); return; }
    if (this.hintQueue.length) { this.showNextHint(); return; }
    // Keep the last tip visible, dimmed, as a reminder.
    const card = this.hintStrip?.querySelector('.hint-card');
    card?.classList.remove('active');
    card?.querySelector('.hint-actions')?.remove();
    const kicker = card?.querySelector('.hint-kicker');
    if (kicker) kicker.textContent = 'Last tip';
    this.loop.reset();
  }

  private completeTutorial(): void {
    if (this.ended) return;
    this.ended = true;
    const id = this.opts.tutorial!.id;
    markTutorialDone(id);
    if (isOnline()) void api.telemetry(this.st.telemetry);
    this.opts.onExit({ kind: 'tutorialDone', id });
  }

  // ---------- end of run ----------

  private backup(): void {
    const link = this.opts.link;
    if (!link || this.ended) return;
    saveRankedBackup({
      runId: link.runId, date: link.date, mapSeed: link.mapSeed, keys: Object.fromEntries(this.st.bugKeys),
      log: this.ctl.log, tics: globalTic(this.st), sent: link.sent,
    });
  }

  private resultsBase(): Omit<ResultsData, 'kind'> {
    const st = this.st;
    return {
      seedHex: this.opts.seedHex, seed: st.seed, score: totalPower(st), telemetry: st.telemetry,
      bugs: this.tracker.list().map((b) => ({ ...b, cost: this.tracker.totalCost(b.id) })),
      stranded: this.tracker.stranded, log: this.ctl.log.slice(),
    };
  }

  private finish(): void {
    if (this.ended) return;
    const st = this.st;
    if (this.opts.kind === 'practice') {
      this.ended = true;
      this.loop.stop();
      const base = this.resultsBase();
      const rec = recordPracticeRun(kv, { seed: this.opts.seedHex, score: base.score, log: base.log, finishedAt: Date.now(), bugKeys: this.opts.bugKeys });
      if (isOnline()) void api.telemetry(st.telemetry);
      this.opts.onExit({ kind: 'results', data: { kind: 'practice', ...base, practice: { ...rec, bugKeys: this.opts.bugKeys } } });
      return;
    }
    if (this.opts.kind === 'ranked') {
      const link = this.opts.link!;
      this.backup();
      this.ended = true;
      this.loop.stop();
      this.showOverlay(h('div.ov-card', h('div.ov-title', 'Run complete'), h('p.muted', 'Verifying your run with the server…')), false);
      const base = this.resultsBase();
      const bugKeys = Array.from({ length: 300 }, (_, i) => st.bugKeys.get(i + 1) ?? 0);
      link.finish(base.score, st.hashes[st.hashes.length - 1] ?? 0).then((result) => {
        saveRankedReplay(link.date, { mapSeed: link.mapSeed, bugKeys, log: base.log, score: result.verifiedScore });
        void api.telemetry(st.telemetry, link.runId);
        clearRankedBackup();
        link.close();
        this.opts.onExit({ kind: 'results', data: { kind: 'ranked', ...base, ranked: { date: link.date, result, mapSeed: link.mapSeed, bugKeys } } });
      }).catch((err: Error) => this.fatal('finish', err.message));
    }
  }

  private fatal(code: string, message: string): void {
    this.ended = true;
    this.loop.stop();
    if (code === 'abandoned' || code === 'invalid_log') clearRankedBackup();
    const title = code === 'abandoned' ? 'Run abandoned' : code === 'invalid_log' ? 'Run rejected' : 'Ranked run stopped';
    this.showOverlay(h('div.ov-card',
      h('div.ov-title', title),
      h('p.muted', message),
      h('button.btn.btn-primary', { on: { click: () => this.opts.onExit({ kind: 'menu' }) } }, 'Main menu'),
    ), true);
  }

  private askQuit(): void {
    if (this.ended) { this.opts.onExit({ kind: 'menu' }); return; }
    const kind = this.opts.kind;
    const msg = kind === 'ranked'
      ? 'This is your one ranked attempt today. If you leave, you can resume it from the Daily screen within 30 minutes; after that the server finishes it with no further moves.'
      : kind === 'tutorial' ? 'Leave the tutorial? You can start it again any time.' : 'Leave this practice run? It will not be saved.';
    this.confirmOpen = true;
    this.showOverlay(h('div.ov-card',
      h('div.ov-title', 'Leave the run?'),
      h('p.muted', msg),
      h('div.row',
        h('button.btn', { on: { click: () => { this.confirmOpen = false; this.hideOverlay(); this.loop.reset(); if (this.st.paused) this.showPaused(); } } }, 'Stay'),
        h('button.btn.btn-danger', { on: { click: () => this.quit() } }, 'Leave'),
      ),
    ), kind === 'ranked');
  }

  private quit(): void {
    this.ended = true;
    this.loop.stop();
    if (this.opts.kind === 'tutorial' && isOnline()) void api.telemetry(this.st.telemetry);
    if (this.opts.link) this.opts.link.close(); // the backup stays, so the run can be resumed
    this.opts.onExit({ kind: 'menu' });
  }
}
