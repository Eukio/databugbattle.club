// Multiplayer match screen. The server runs the match; this screen predicts my own queue edits locally
// (the same input controller as single player) and reconciles with every frame.
import {
  CELL, InputController, applyOp, computeSnapshot, dcStatus, preview, InvalidOpError,
  type ControllerEvent, type DCStatus, type GameState, type LogOp, type MpFrame, type QueuePreview, type Snapshot, type TicEvents,
} from '../../sim.ts';
import { BoardView, type MpDraw, type Overlay } from '../../render/board.ts';
import { drawFx, type Effect } from '../../render/fx.ts';
import { Hud } from '../hud.ts';
import { h, clear } from '../dom.ts';
import { drainWarnings, spreadTargets } from '../../analysis.ts';
import { buildView, colorFor, isAlly, type MpStart } from '../../mpview.ts';
import { mpLink, type MpMsg } from '../../net/mp.ts';
import type { Screen } from '../../main.ts';

const OVERLAYS: Overlay[] = ['power', 'connectivity', 'hot'];
const MODE_NAME: Record<string, string> = { '1v1': '1v1', '2v2': '2v2', ffa: 'Free for all', custom: 'Custom game' };

export interface MpGameOpts {
  start: MpStart;
  onLobby: () => void;
  onMenu: () => void;
  onAgain: ((mode: string) => void) | null;
}

export class MpGameScreen implements Screen {
  readonly el: HTMLElement;
  private readonly s: MpStart;
  private view: GameState;
  private draw: MpDraw;
  private frame: MpFrame | null = null;
  private readonly ctl: InputController;
  private readonly bv = new BoardView();
  private readonly hud: Hud;
  private readonly boardWrap: HTMLElement;
  private readonly overlayEl = h('div.board-overlay.hidden');
  private readonly bannerEl = h('div.board-banner.hidden');
  private readonly toastEl = h('div.toasts');
  private readonly scoreEl = h('ol.scoreboard');
  private readonly surrenderBtn: HTMLElement;
  private snap!: Snapshot;
  private statuses = new Map<number, DCStatus>();
  private prev: QueuePreview | null = null;
  private drain = new Set<number>();
  private cureWindow: number[] = [];
  private overlay: Overlay = 'power';
  private hover = -1;
  private effects: Effect[] = [];
  private shake: { cell: number; t0: number } | null = null;
  private pending: { seq: number; op: LogOp }[] = [];
  private seq = 0;
  private raf = 0;
  private over = false;
  private eliminated = false;
  private confirmOpen = false;
  private startsAt: number;
  private ro: ResizeObserver;
  private readonly opts: MpGameOpts;
  private readonly onKeyBound = (e: KeyboardEvent) => this.onKey(e);
  private lastPowers: Int32Array | null = null;

  constructor(opts: MpGameOpts) {
    this.opts = opts;
    this.s = opts.start;
    this.startsAt = performance.now() + opts.start.startsIn;
    const blank = { type: 'frame', turn: 1, tic: 0, k: new Array(this.s.width * this.s.height).fill(0), o: [], p: [], tr: [], bugs: [], hqs: [], queue: [], nextPathId: 0, ended: [], ack: 0, scores: [] } as unknown as MpFrame;
    ({ view: this.view, draw: this.draw } = buildView(this.s, blank));
    this.ctl = new InputController(this.view, { onOp: (op) => this.onOp(op), onEvent: (e) => this.onCtlEvent(e) });
    this.surrenderBtn = h('button.btn.btn-small.btn-ghost', { on: { click: () => this.askSurrender() } }, 'Surrender');
    this.hud = new Hud({ kind: 'mp', actions: [this.surrenderBtn], onRemove: (id) => this.ctl.removePath(id), onClear: () => this.ctl.clear() });
    const me = this.s.players[this.s.you];
    this.hud.panel.prepend(h('section.panel-sec', h('div.panel-head', h('h3', 'Players'), h('span.muted', MODE_NAME[this.s.mode] ?? this.s.mode)), this.scoreEl));
    this.boardWrap = h('div.board-wrap', this.bv.el, this.overlayEl, this.bannerEl, this.toastEl);
    this.el = h('div.screen.game.mp',
      this.hud.top,
      h('div.game-main', h('div.board-col', this.boardWrap, h('div.seedbar', `${MODE_NAME[this.s.mode] ?? ''} · you are `, h('span', { style: `color:${colorFor(this.s, this.s.you).dc}` }, me.name), ' · capture an enemy HQ (crown) to eliminate them; at the time limit the most power wins')), this.hud.panel),
    );
    this.bindPointer();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.boardWrap);
  }

  mount(): void {
    mpLink.handler = (m) => this.onMsg(m);
    document.addEventListener('keydown', this.onKeyBound);
    this.layout();
    this.refresh();
    this.renderScores();
    const loop = (now: number) => { this.frameFx(now); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    (window as any).__mp = { screen: this, ctl: this.ctl, get view() { return (window as any).__mp.screen.view; }, get frame() { return (window as any).__mp.screen.frame; } };
  }

  unmount(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    document.removeEventListener('keydown', this.onKeyBound);
    if (mpLink.handler) mpLink.handler = null;
  }

  private layout(): void {
    const r = this.boardWrap.getBoundingClientRect();
    this.bv.layout(this.s.width, this.s.height, Math.max(200, r.width - 8), Math.max(200, r.height - 8));
    this.refresh();
  }

  // ---------- server messages ----------

  private onMsg(m: MpMsg): void {
    if (m.type === 'frame') this.onFrame(m as unknown as MpFrame & { events?: { who: number; by: number | null }[] });
    else if (m.type === 'over') this.onOver(m);
  }

  private onFrame(f: MpFrame & { events?: { who: number; by: number | null }[] }): void {
    this.frame = f;
    const built = buildView(this.s, f);
    // Replay my unacknowledged edits on top of the server's queue.
    this.pending = this.pending.filter((p) => p.seq > f.ack);
    for (const p of this.pending) {
      try { applyOp(built.view, p.op); } catch (e) { if (!(e instanceof InvalidOpError)) throw e; }
    }
    this.view = built.view;
    this.draw = built.draw;
    this.ctl.st = this.view;
    this.ctl.onTicEvents({ endedPaths: f.ended.filter((e) => e.cause !== 'gift').map((e) => ({ ...e, cause: e.cause === 'eliminated' ? 'removed' : e.cause })) } as unknown as TicEvents);
    this.spotEffects();
    for (const e of f.events ?? []) this.toastElimination(e.who, e.by);
    const me = f.scores[this.s.you];
    if (me && !me.alive && !this.eliminated && !this.over) {
      this.eliminated = true;
      this.surrenderBtn.textContent = 'Leave';
      this.flash('You were eliminated. You can keep watching — the whole map is visible now.');
    }
    this.refresh();
    this.renderScores();
    (window as any).__dcg = { st: this.view, ctl: this.ctl }; // handle for automated tests
  }

  /** Light effects from power changes I can see (captures and fights), since frames carry no step events. */
  private spotEffects(): void {
    const n = this.s.width * this.s.height;
    const now = performance.now();
    const owner = this.draw.owner;
    if (this.lastPowers) {
      for (let i = 0; i < n; i++) {
        const was = this.lastOwner![i];
        if (owner[i] !== was && was !== -2 && this.view.visible[i]) {
          if (owner[i] === this.s.you && was >= 0 && was !== this.s.you) this.effects.push({ kind: 'capture', cell: i, t0: now });
          else if (was === this.s.you && owner[i] !== this.s.you) this.effects.push({ kind: 'fail', cell: i, t0: now });
          else if (this.draw.isDC[i] && owner[i] === this.s.you) this.effects.push({ kind: 'capture', cell: i, t0: now });
        }
      }
    }
    this.lastPowers = new Int32Array(this.view.power);
    this.lastOwner = Int8Array.from(owner, (o, i) => (this.view.visible[i] ? o : -2));
  }
  private lastOwner: Int8Array | null = null;

  private onOver(m: MpMsg): void {
    this.over = true;
    try { sessionStorage.removeItem('dcg.mp.match'); } catch { /* blocked */ }
    const winners: number[] = m.winners ?? [];
    const won = winners.includes(this.s.you);
    const draw = winners.length > 1 && new Set(winners.map((w) => this.s.players[w].team)).size > 1;
    const title = draw ? 'Draw' : won ? 'Victory' : 'Defeat';
    const reason = m.reason === 'time' ? `Time is up after turn ${m.turn}: the most total power wins.` : 'Every other team was eliminated.';
    const standings = (m.standings as any[]).slice().sort((a, b) => Number(winners.includes(b.seat)) - Number(winners.includes(a.seat)) || Number(b.alive) - Number(a.alive) || b.army - a.army);
    const winNames = winners.map((w) => this.s.players[w].name).join(' & ');
    this.surrenderBtn.textContent = 'Leave';
    this.showOverlay(h('div.ov-card.over-card',
      h('div.ov-title' + (won ? '.good' : ''), title),
      h('p.muted', draw ? `${winNames} share the win. ${reason}` : `${winNames} win${winners.length === 1 ? 's' : ''}. ${reason}`),
      h('table.table.compact',
        h('thead', h('tr', h('th', ''), h('th', 'Player'), h('th.num', 'Power'), h('th.num', 'Cells'), h('th', ''))),
        h('tbody', ...standings.map((p) => h('tr' + (p.seat === this.s.you ? '.me' : ''),
          h('td', h('span.swatch', { style: `background:${colorFor(this.s, p.seat).dc}` })),
          h('td', p.name, this.s.mode === '2v2' || this.s.mode === 'custom' ? h('span.muted', ` · team ${p.team + 1}`) : null),
          h('td.num', String(p.army)), h('td.num', String(p.land)),
          h('td.small.muted', winners.includes(p.seat) ? 'winner' : p.surrendered ? 'surrendered' : p.alive ? '' : `out on turn ${p.eliminatedTurn}${p.eliminatedBy !== null ? ` (${this.s.players[p.eliminatedBy].name})` : ''}`),
        )))),
      h('div.row',
        this.opts.onAgain && this.s.mode !== 'custom' ? h('button.btn.btn-primary', { on: { click: () => this.opts.onAgain!(this.s.mode) } }, 'Play again') : null,
        h('button.btn', { on: { click: () => this.opts.onLobby() } }, 'Multiplayer lobby'),
        h('button.btn.btn-ghost', { on: { click: () => this.opts.onMenu() } }, 'Main menu'),
        h('button.btn.btn-ghost', { on: { click: () => this.hideOverlay() } }, 'View board'),
      ),
    ), false);
  }

  // ---------- derived state and drawing ----------

  private refresh(): void {
    const st = this.view;
    const n = st.width * st.height;
    this.snap = computeSnapshot(st);
    this.statuses.clear();
    this.cureWindow = [];
    for (let i = 0; i < n; i++) {
      if (st.type[i] === CELL.OWNED_DC) this.statuses.set(i, dcStatus(st, this.snap, i));
      if (st.bugId[i] >= 0 && st.type[i] === CELL.LAND && st.immunity[i] === 0 && st.nextSpread[i] - st.turn <= 3) this.cureWindow.push(i);
    }
    this.drain = drainWarnings(st);
    this.prev = st.queue.length ? preview(st) : null;
    this.bv.drawStatic({ st, snap: this.snap, statuses: this.statuses, spreadTargets: spreadTargets(st), overlay: this.overlay, reveal: false, mp: this.draw });
    const ctx = this.hudCtx();
    this.hud.updateTop(ctx);
    this.hud.updateQueue(ctx);
    this.hud.updateDetails(ctx, this.detailsCell());
  }

  private hudCtx() {
    return {
      st: this.view, ctl: this.ctl, snap: this.snap, statuses: this.statuses, preview: this.prev, overlay: this.overlay,
      kind: 'mp' as const, turnLimit: this.s.turnLimit, describe: (c: number) => this.describe(c),
    };
  }

  private describe(c: number): { title: string; rows: [string, string][] } | null {
    const o = this.draw.owner[c];
    if (!this.view.visible[c]) return null;
    if (o >= 0 && o !== this.s.you) {
      const P = this.s.players[o];
      const hq = this.draw.hq.get(c) === o;
      const rel = isAlly(this.s, o) ? 'ally' : 'enemy';
      const rows: [string, string][] = [['Power', String(this.draw.power[c])], ['Player', `${P.name} (${rel})`]];
      if (this.draw.bugs.has(c)) rows.push(['Bug', `health ${this.draw.bugs.get(c)}`]);
      if (rel === 'enemy') rows.push(['', hq ? `Their HQ. Arrive with more than ${this.draw.power[c]} to capture it and eliminate ${P.name}.` : `Arrive with more than ${this.draw.power[c]} to take it.`]);
      else rows.push(['', 'Moving onto an ally’s cell gives them the power.']);
      return { title: `${P.name}’s ${hq ? 'HQ' : this.draw.isDC[c] ? 'data center' : 'land'}`, rows };
    }
    if (o < 0 && !this.draw.isDC[c] && this.draw.power[c] > 0) {
      return { title: 'Abandoned land', rows: [['Power', String(this.draw.power[c])], ['', 'Left by a player who surrendered. Arrive with more than its power to take it.']] };
    }
    if (o === this.s.you && this.draw.hq.get(c) === this.s.you) return null;
    return null;
  }

  private detailsCell(): number | null {
    if (this.hover >= 0) return this.hover;
    return this.ctl.cursor ?? this.ctl.selected;
  }

  private frameFx(now: number): void {
    const left = Math.ceil((this.startsAt - now) / 1000);
    if (left > 0) { this.bannerEl.textContent = `Starting in ${left}…`; this.bannerEl.classList.remove('hidden'); }
    else if (this.bannerEl.textContent?.startsWith('Starting')) this.bannerEl.classList.add('hidden');
    drawFx(this.bv, {
      st: this.view, preview: this.prev, cursor: this.ctl.cursor, selected: this.ctl.selected, hover: this.hover,
      halfNext: this.ctl.halfNext, drain: this.drain, statuses: this.statuses, cureWindow: this.cureWindow,
      weakest: this.hud.weakestFromDetails, effects: this.effects, shake: this.shake,
    }, now);
  }

  private renderScores(): void {
    clear(this.scoreEl);
    const scores = this.frame?.scores ?? this.s.players.map(() => ({ army: 1, land: 1, dcs: 1, alive: true }));
    const order = this.s.players.map((_, i) => i).sort((a, b) => Number(scores[b].alive) - Number(scores[a].alive) || scores[b].army - scores[a].army);
    const teams = this.s.mode === '2v2' || this.s.mode === 'custom';
    for (const i of order) {
      const P = this.s.players[i];
      const sc = scores[i];
      this.scoreEl.append(h('li.sb-row' + (sc.alive ? '' : '.dead') + (i === this.s.you ? '.me' : ''),
        h('span.swatch', { style: `background:${colorFor(this.s, i).dc}` }),
        h('span.sb-name', P.name, i === this.s.you ? ' (you)' : '', teams ? h('span.muted', ` · T${P.team + 1}`) : null),
        h('span.sb-num', { title: 'Total power' }, String(sc.army)),
        h('span.sb-num.muted', { title: 'Cells' }, String(sc.land)),
      ));
    }
  }

  private toastElimination(who: number, by: number | null): void {
    const name = (p: number) => (p === this.s.you ? 'You' : this.s.players[p].name);
    const text = by === null ? `${name(who)} left the game.` : `${name(by)} captured ${who === this.s.you ? 'your' : `${this.s.players[who].name}’s`} HQ.`;
    const t = h('div.toast', text);
    this.toastEl.append(t);
    setTimeout(() => t.remove(), 5000);
  }

  private flash(text: string): void {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.remove('hidden');
    setTimeout(() => { if (this.bannerEl.textContent === text) this.bannerEl.classList.add('hidden'); }, 5000);
  }

  // ---------- input ----------

  private blocked(): boolean { return this.over || this.eliminated || this.confirmOpen; }

  private onOp(op: LogOp): void {
    const seq = ++this.seq;
    this.pending.push({ seq, op });
    const { g: _g, gid: _gid, ts: _ts, ...wire } = op as LogOp & { ts?: number };
    void _g; void _gid; void _ts;
    mpLink.send({ type: 'op', seq, op: wire });
    this.refresh();
  }

  private onCtlEvent(e: ControllerEvent): void {
    if (e.kind === 'refused') this.shake = { cell: e.cell, t0: performance.now() };
    if (e.kind !== 'queued') { const ctx = this.hudCtx(); this.hud.updateTop(ctx); this.hud.updateDetails(ctx, this.detailsCell()); }
  }

  private onKey(e: KeyboardEvent): void {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
    if (e.code === 'Tab') {
      e.preventDefault();
      if (!e.repeat) { this.overlay = OVERLAYS[(OVERLAYS.indexOf(this.overlay) + 1) % OVERLAYS.length]; this.refresh(); }
      return;
    }
    if (this.confirmOpen && e.code === 'Escape') { this.confirmOpen = false; this.hideOverlay(); return; }
    if (this.blocked() || e.code === 'KeyP' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.ctl.key(e.code, e.repeat)) e.preventDefault();
  }

  private bindPointer(): void {
    const fx = this.bv.fx;
    let pressed = false;
    fx.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.blocked()) return;
      const c = this.bv.cellAt(e.clientX, e.clientY);
      if (c < 0) return;
      pressed = true;
      try { fx.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.ctl.pointerDown(c);
    });
    fx.addEventListener('pointermove', (e) => {
      const c = this.bv.cellAt(e.clientX, e.clientY);
      if (c !== this.hover) { this.hover = c; this.hud.updateDetails(this.hudCtx(), this.detailsCell()); }
      if (pressed && c >= 0 && !this.blocked()) this.ctl.pointerMove(c);
    });
    fx.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !pressed) return;
      pressed = false;
      if (this.blocked()) return;
      this.ctl.pointerUp(this.bv.cellAt(e.clientX, e.clientY));
    });
    fx.addEventListener('pointerleave', () => { if (!pressed) { this.hover = -1; this.hud.updateDetails(this.hudCtx(), this.detailsCell()); } });
    fx.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.blocked()) return;
      const c = this.bv.cellAt(e.clientX, e.clientY);
      if (c >= 0) this.ctl.removeTopmostAt(c);
    });
  }

  // ---------- surrender / leave ----------

  private askSurrender(): void {
    if (this.over || this.eliminated) { mpLink.send({ type: 'leaveMatch' }); this.opts.onLobby(); return; }
    this.confirmOpen = true;
    this.showOverlay(h('div.ov-card',
      h('div.ov-title', 'Surrender?'),
      h('p.muted', 'Your cells turn neutral and you are out of the match. You can keep watching.'),
      h('div.row',
        h('button.btn', { on: { click: () => { this.confirmOpen = false; this.hideOverlay(); } } }, 'Keep playing'),
        h('button.btn.btn-danger', { on: { click: () => { this.confirmOpen = false; this.hideOverlay(); mpLink.send({ type: 'surrender' }); } } }, 'Surrender'),
      ),
    ), false);
  }

  private showOverlay(content: HTMLElement, opaque: boolean): void {
    this.overlayEl.replaceChildren(content);
    this.overlayEl.classList.remove('hidden');
    this.overlayEl.classList.toggle('opaque', opaque);
  }
  private hideOverlay(): void { this.overlayEl.classList.add('hidden'); this.overlayEl.replaceChildren(); }
}

