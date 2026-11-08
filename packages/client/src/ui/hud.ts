// Top bar and right panel (doc §HUD).
import {
  CELL, fullPower, safeLevel, totalPower, RUN_TURNS, MAX_PAUSES, IMMUNITY,
  type GameState, type InputController, type QueuePreview, type Snapshot, type DCStatus,
} from '../sim.ts';
import { h, clear, rc } from './dom.ts';
import { STATUS_COLOR, STATUS_LABEL, PATH_COLORS } from '../render/theme.ts';
import { statusInfo, projectQueue, spawnWeight, firstSend, bestLinkPartner } from '../analysis.ts';
import type { Overlay } from '../render/board.ts';

const MODE_LABEL = { auto: 'Auto', half: 'Half', keep: 'Keep', all1: 'All but 1' } as const;
export const modeText = (mode: keyof typeof MODE_LABEL, n: number) => (mode === 'keep' ? `Keep ${n}` : MODE_LABEL[mode]);
const OVERLAY_LABEL: Record<Overlay, string> = { power: 'Power', connectivity: 'Connectivity', hot: 'Hot cells' };

export interface HudContext {
  st: GameState;
  ctl: InputController;
  snap: Snapshot;
  statuses: Map<number, DCStatus>;
  preview: QueuePreview | null;
  overlay: Overlay;
  kind: 'practice' | 'ranked' | 'tutorial' | 'replay' | 'mp';
  /** Overrides st.turnLimit for the clock (multiplayer views keep st.turnLimit at 0). */
  turnLimit?: number;
  /** Multiplayer: describe cells the local view can't (other players' cells). */
  describe?: (cell: number) => { title: string; rows: [string, string][] } | null;
}

export class Hud {
  readonly top: HTMLElement;
  readonly panel: HTMLElement;
  private turnEl = h('span.tb-value');
  private scoreEl = h('span.tb-value');
  private safeEl = h('span.tb-safe-num');
  private modeEl = h('span.tb-value');
  private overlayEl = h('span.tb-value');
  private pausesEl = h('span.tb-value');
  private pausesWrap: HTMLElement;
  private queueList = h('ol.queue-list');
  private queueCount = h('span.muted');
  private details = h('div.details');
  private lastSafe = -1;
  private onRemove: (id: number) => void;
  private onClear: () => void;
  weakestFromDetails: number | null = null;
  private scoreLabel = 'Score';

  constructor(opts: { kind: HudContext['kind']; actions: HTMLElement[]; onRemove: (id: number) => void; onClear: () => void; showKeys?: boolean }) {
    this.onRemove = opts.onRemove;
    this.onClear = opts.onClear;
    this.pausesWrap = h('div.tb-item', h('span.tb-label', 'Pauses'), this.pausesEl);
    if (opts.kind === 'mp') this.scoreLabel = 'Your power';
    if (opts.kind !== 'ranked') this.pausesWrap.style.display = 'none';
    this.top = h('header.topbar',
      h('div.tb-item.tb-turn', h('span.tb-label', 'Turn'), this.turnEl),
      h('div.tb-item', h('span.tb-label', opts.kind === 'mp' ? 'Your power' : 'Score'), this.scoreEl),
      h('div.tb-item.tb-safe', { title: 'Safe level S(t): keep every DC and corridor at or above it' }, h('span.tb-label', 'Safe level'), this.safeEl),
      opts.kind === 'replay' ? null : h('div.tb-item', h('span.tb-label', 'Split'), this.modeEl),
      h('div.tb-item', h('span.tb-label', 'Overlay ⇥'), this.overlayEl),
      this.pausesWrap,
      h('div.tb-spacer'),
      ...opts.actions,
    );
    this.panel = h('aside.panel',
      opts.kind === 'replay' ? null : h('section.panel-sec',
        h('div.panel-head', h('h3', 'Queue'), this.queueCount, h('button.btn.btn-small', { on: { click: () => this.onClear() }, title: 'Clear the queue (Q / Esc)' }, 'Clear')),
        this.queueList),
      h('section.panel-sec.details-sec', h('div.panel-head', h('h3', 'Cell')), this.details),
      opts.showKeys === false ? null : h('section.panel-sec.keys',
        h('div', h('kbd', 'Click'), ' select · ', h('kbd', 'WASD'), '/', h('kbd', '←↑→↓'), ' step · drag a path'),
        h('div', h('kbd', '1'), '–', h('kbd', '4'), ' split · ', h('kbd', 'Z'), ' half next · ', h('kbd', '+'), h('kbd', '−'), ' keep N'),
        h('div', h('kbd', 'Q'), ' clear · right-click a path to remove · ', h('kbd', 'Space'), ' deselect'),
        opts.kind === 'mp' ? h('div', h('kbd', 'Tab'), ' overlays') : h('div', h('kbd', 'P'), ' pause · ', h('kbd', 'Tab'), ' overlays')),
    );
  }

  updateTop(c: HudContext): void {
    const st = c.st;
    const limit = c.turnLimit ?? st.turnLimit;
    const t = Math.min(st.turn, limit || st.turn);
    if (limit) {
      const ticsLeft = Math.max(0, 2 * limit - (2 * (st.turn - 1) + st.tic));
      const secs = Math.ceil(ticsLeft / 2);
      this.turnEl.textContent = `${t} / ${limit} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    } else this.turnEl.textContent = String(t);
    void RUN_TURNS;
    this.scoreEl.textContent = String(totalPower(st));
    const S = safeLevel(t);
    if (S !== this.lastSafe) {
      if (this.lastSafe >= 0 && S > this.lastSafe) {
        this.safeEl.classList.remove('tick');
        void this.safeEl.offsetWidth;
        this.safeEl.classList.add('tick');
      }
      this.safeEl.textContent = String(S);
      this.lastSafe = S;
    }
    const ctl = c.ctl;
    this.modeEl.textContent = modeText(ctl.splitMode, ctl.keepN) + (ctl.halfNext ? ' · 50% next' : '');
    this.overlayEl.textContent = OVERLAY_LABEL[c.overlay];
    this.pausesEl.textContent = String(MAX_PAUSES - st.pausesUsed);
  }

  updateQueue(c: HudContext): void {
    const st = c.st;
    clear(this.queueList);
    const remaining = st.queue.reduce((s, p) => s + p.steps.length - p.executed, 0);
    this.queueCount.textContent = st.queue.length ? `${st.queue.length} path${st.queue.length > 1 ? 's' : ''} · ${remaining} step${remaining === 1 ? '' : 's'}` : 'empty';
    st.queue.forEach((p, idx) => {
      const rec = c.preview?.paths.find((r) => r.id === p.id);
      const last = rec?.steps[rec.steps.length - 1];
      const failing = rec?.steps.some((s) => s.fails);
      let arrive = '';
      if (rec && last) {
        if (last.fails || failing) arrive = '✕ fails';
        else if (last.fogged) arrive = 'arrives ?';
        else if (last.cause === 'shortAttack') arrive = `chips −${last.sent}`;
        else arrive = `arrives ${last.arrival}`;
      }
      const left = p.steps.length - p.executed;
      this.queueList.append(h('li.qitem' + (idx === 0 ? '.head' : ''),
        h('span.qdot', { style: `background:${PATH_COLORS[p.id % PATH_COLORS.length]}` }),
        h('span.qtext', `${rc(p.executed ? p.current : p.origin, st.width)} · ${modeText(p.mode, p.n)} · ${left} left`),
        h('span.qarrive' + (failing ? '.bad' : ''), arrive),
        h('button.qx', { title: 'Remove this path', on: { click: () => this.onRemove(p.id) } }, '×'),
      ));
    });
    if (!st.queue.length) this.queueList.append(h('li.qempty', 'Select a cell and press a direction, or drag a path.'));
  }

  updateDetails(c: HudContext, cell: number | null): void {
    clear(this.details);
    this.weakestFromDetails = null;
    const st = c.st;
    if (cell === null || cell < 0) { this.details.append(h('p.muted', 'Hover a cell to see its details.')); return; }
    const w = st.width;
    const custom = c.describe?.(cell);
    if (custom) {
      this.details.append(h('div.details-title', custom.title, h('span.muted', ` ${rc(cell, w)}`)));
      const dl = h('dl.details-rows');
      for (const [k, v] of custom.rows) { if (k) dl.append(h('dt', k), h('dd', v)); else dl.append(h('dd.full', v)); }
      this.details.append(dl);
      return;
    }
    const vis = c.kind === 'replay' || st.visible[cell] === 1;
    const t = st.type[cell];
    const rows: [string, string | HTMLElement][] = [];
    let title: string;
    if (!vis) {
      title = t === CELL.MOUNTAIN || t === CELL.NEUTRAL_DC ? 'Obstacle in fog' : 'Fog';
      rows.push(['', t === CELL.MOUNTAIN || t === CELL.NEUTRAL_DC ? 'A mountain or a data center. Expand next to it to find out.' : 'Expand next to it to see it.']);
    } else if (!st.owned[cell]) {
      if (t === CELL.MOUNTAIN) { title = 'Mountain'; rows.push(['', 'Impassable.']); }
      else if (t === CELL.NEUTRAL_DC) { title = 'Neutral data center'; rows.push(['Capture cost', String(st.cost[cell])], ['', `Arrive with more than ${st.cost[cell]} to capture it.`]); }
      else { title = 'Empty land'; rows.push(['', 'Step onto it to claim it.']); }
    } else {
      const isDC = t === CELL.OWNED_DC;
      title = isDC ? 'Your data center' : 'Your land';
      const trav = st.travel[cell];
      rows.push(['Power', trav ? `${st.power[cell]} + ${trav} travelling` : String(st.power[cell])]);
      const frozen = st.bugId[cell] >= 0;
      if (isDC) {
        const status = c.statuses.get(cell);
        if (status) {
          let projected;
          if (status === 'cureNeeded' && st.queue.length) projected = projectQueue(st);
          const info = statusInfo(st, c.snap, cell, projected);
          const col = STATUS_COLOR[status] ?? '#E2E8F0';
          rows.push(['Status', h('span.status-pill', { style: `border-color:${col};color:${col}` }, STATUS_LABEL[status])]);
          rows.push(['', info.text]);
          this.weakestFromDetails = info.weakest;
          if (status === 'cureNeeded' && c.ctl.selected !== null && c.ctl.selected !== cell && st.owned[c.ctl.selected]) {
            const s = firstSend(st, c.ctl.selected, c.ctl.halfNext ? 'half' : c.ctl.splitMode, c.ctl.keepN);
            rows.push(['From selected', `${rc(c.ctl.selected, w)} sends ${Math.max(0, s)} on its first step`]);
          }
        }
        const best = c.snap.bestLink[cell];
        const j = bestLinkPartner(st, c.snap, cell);
        rows.push(['Best link', j >= 0 ? `${best} to ${rc(j, w)}` : 'none']);
        if (!frozen) rows.push(['Spawn weight', String(spawnWeight(c.snap.Bbest[cell]))]);
      } else if (!frozen) {
        rows.push(['Reach to a DC', String(c.snap.R[cell])]);
        rows.push(['Earning', c.snap.anchored[cell] ? 'yes (connected to a healthy DC)' : 'no — cut off from every healthy DC']);
        rows.push(['Spawn weight', String(spawnWeight(c.snap.Bbest[cell]))]);
      }
      if (frozen) {
        rows.push(['Bug', `#${st.bugId[cell]} · health ${st.bugHealth[cell]}`]);
        const imm = st.immunity[cell];
        rows.push(['Immunity', imm > 0 ? `${imm} turn${imm > 1 ? 's' : ''} (curable from turn ${st.turn + imm})` : 'none — curable now']);
        rows.push(['Grows', `+1 on turn ${st.nextGrowth[cell]}`]);
        if (t === CELL.LAND && st.nextSpread[cell]) rows.push(['Spreads', `turn ${st.nextSpread[cell]}`]);
        rows.push(['Decrement', isDC && st.protectedFlag[cell] ? 'paused while protected' : `counter ${st.decCounter[cell]} / 2`]);
      }
      void IMMUNITY;
      void fullPower;
    }
    this.details.append(h('div.details-title', title, h('span.muted', ` ${rc(cell, w)}`)));
    const dl = h('dl.details-rows');
    for (const [k, v] of rows) {
      if (k) dl.append(h('dt', k), h('dd', v));
      else dl.append(h('dd.full', v));
    }
    this.details.append(dl);
  }
}
