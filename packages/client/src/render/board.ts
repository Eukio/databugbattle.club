// Board view: two stacked canvases. The static layer (cells, fog, numbers, statuses, overlays) is
// redrawn only when the state changes; the effects layer (fx.ts) is redrawn every frame.
import { CELL, safeLevel, fullPower, IMMUNITY, SPREAD_INTERVAL, type GameState, type Snapshot, type DCStatus } from '../sim.ts';
import { C, MONO, STATUS_COLOR } from './theme.ts';
import * as I from './icons.ts';
import { spawnWeight } from '../analysis.ts';

export type Overlay = 'power' | 'connectivity' | 'hot';

export interface StaticModel {
  st: GameState;
  snap: Snapshot; // live snapshot of the current state
  statuses: Map<number, DCStatus>;
  spreadTargets: Set<number>;
  overlay: Overlay;
  reveal: boolean; // replays: no fog, vision outlined
  /** Multiplayer: other players' cells, drawn from the server frame rather than the local view. */
  mp?: MpDraw;
}

export interface MpDraw {
  me: number;
  owner: Int8Array; // −1 neutral or unknown
  isDC: Uint8Array; // visible DCs (any owner)
  power: Int32Array; // other players' full power; neutral land's leftover power
  bugs: Map<number, number>; // other players' visible bugs: cell → health
  hq: Map<number, number>; // visible HQs: cell → player
  color: (p: number) => { dc: string; land: string };
}

export class BoardView {
  readonly el: HTMLDivElement;
  readonly base: HTMLCanvasElement;
  readonly fx: HTMLCanvasElement;
  cs = 32;
  w = 20;
  h = 20;
  dpr = 1;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'board';
    this.base = document.createElement('canvas');
    this.fx = document.createElement('canvas');
    this.base.className = 'board-base';
    this.fx.className = 'board-fx';
    this.el.append(this.base, this.fx);
  }

  /** Fit the board into the given CSS box. 32 px per cell by default; small tutorial maps scale up. */
  layout(gridW: number, gridH: number, availW: number, availH: number): void {
    this.w = gridW;
    this.h = gridH;
    const fit = Math.floor(Math.min(availW / gridW, availH / gridH));
    const max = gridW * gridH <= 100 ? 64 : 40;
    // 24 px minimum per the visual spec; on narrow (phone) screens allow smaller cells so the board still fits.
    const min = window.innerWidth < 640 ? 12 : 24;
    this.cs = Math.max(min, Math.min(max, fit));
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = this.cs * gridW, H = this.cs * gridH;
    for (const c of [this.base, this.fx]) {
      c.width = Math.round(W * this.dpr);
      c.height = Math.round(H * this.dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    this.el.style.width = `${W}px`;
    this.el.style.height = `${H}px`;
  }

  cellAt(clientX: number, clientY: number): number {
    const r = this.fx.getBoundingClientRect();
    const c = Math.floor((clientX - r.left) / this.cs);
    const row = Math.floor((clientY - r.top) / this.cs);
    if (c < 0 || row < 0 || c >= this.w || row >= this.h) return -1;
    return row * this.w + c;
  }

  ctx(layer: 'base' | 'fx'): CanvasRenderingContext2D {
    const ctx = (layer === 'base' ? this.base : this.fx).getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return ctx;
  }

  drawStatic(m: StaticModel): void {
    const ctx = this.ctx('base');
    const { st, snap } = m;
    const cs = this.cs;
    const n = st.width * st.height;
    const S = safeLevel(st.turn);
    ctx.fillStyle = C.grid;
    ctx.fillRect(0, 0, cs * st.width, cs * st.height);
    const fs = Math.round((12 * cs) / 32);
    const small = Math.max(8, Math.round((9 * cs) / 32));
    const icon = Math.max(8, Math.round((10 * cs) / 32));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Fills first; numbers, icons and outlines are queued in `late` and drawn after the link lines.
    const late: (() => void)[] = [];

    for (let i = 0; i < n; i++) {
      const r = (i / st.width) | 0, c = i - r * st.width;
      const x = c * cs, y = r * cs, s = cs - 1;
      const t = st.type[i];
      const vis = m.reveal || st.visible[i] === 1;
      if (!vis) {
        if (t === CELL.MOUNTAIN || t === CELL.NEUTRAL_DC) {
          ctx.fillStyle = C.obstacle;
          ctx.fillRect(x, y, s, s);
          I.mountain(ctx, x, y, s, 'rgba(255,255,255,0.18)');
        } else {
          ctx.fillStyle = C.bg;
          ctx.fillRect(x, y, s, s);
        }
        continue;
      }
      if (m.mp) {
        const o = m.mp.owner[i];
        if (o >= 0 && o !== m.mp.me) { this.drawForeign(ctx, m.mp, i, x, y, s, fs, small, icon, late); continue; }
        if (o < 0 && !m.mp.isDC[i] && m.mp.power[i] > 0 && t !== CELL.MOUNTAIN) {
          // Neutral land left behind by a player who surrendered: it has to be attacked.
          ctx.fillStyle = C.land;
          ctx.fillRect(x, y, s, s);
          I.hatch(ctx, x, y, s, 'rgba(148,163,184,0.25)', Math.max(4, cs / 6));
          const pw = m.mp.power[i];
          late.push(() => { ctx.font = `700 ${fs}px ${MONO}`; ctx.fillStyle = '#CBD5E1'; ctx.fillText(String(pw), x + s / 2, y + s / 2 + 1); });
          continue;
        }
      }
      if (st.owned[i]) {
        const isDC = t === CELL.OWNED_DC;
        ctx.fillStyle = isDC ? C.ownDC : C.ownLand;
        ctx.fillRect(x, y, s, s);
        if (isDC) I.rack(ctx, x, y, s, '#0B1B3F', 0.35);
        const frozen = st.bugId[i] >= 0;
        // Overlays (owned cells only).
        if (!frozen && m.overlay === 'connectivity') {
          const R = snap.R[i];
          const col = R >= S ? 'rgba(48,164,108,0.55)' : R * 2 >= S ? 'rgba(245,165,36,0.55)' : 'rgba(229,72,77,0.55)';
          ctx.fillStyle = col;
          ctx.fillRect(x, y, s, s);
        } else if (!frozen && m.overlay === 'hot') {
          const wgt = spawnWeight(snap.Bbest[i]);
          const a = Math.min(0.85, 0.12 + Math.log10(wgt) / 3 * 0.75);
          ctx.fillStyle = `rgba(239,68,68,${a.toFixed(3)})`;
          ctx.fillRect(x, y, s, s);
        }
        if (!isDC && !frozen && !snap.anchored[i]) I.hatch(ctx, x, y, s, 'rgba(203,213,225,0.35)', Math.max(4, cs / 6));
        if (frozen) {
          ctx.fillStyle = C.frozen;
          ctx.fillRect(x, y, s, s);
          if (st.immunity[i] > 0) I.hatch(ctx, x, y, s, 'rgba(255,255,255,0.22)', Math.max(4, cs / 5));
        }
        late.push(() => {
          if (frozen) {
            if (st.immunity[i] > 0) {
              I.lock(ctx, x + 2, y + s - icon - 2, icon * 0.9, '#E0F2FE');
              ctx.font = `700 ${small}px ${MONO}`;
              ctx.fillStyle = '#E0F2FE';
              ctx.textAlign = 'left';
              ctx.fillText(String(st.immunity[i]), x + 3 + icon, y + s - icon / 2 - 2);
              ctx.textAlign = 'center';
            }
            I.bug(ctx, x + 2, y + 2, icon, '#ECFEFF');
            ctx.font = `700 ${small}px ${MONO}`;
            ctx.fillStyle = '#ECFEFF';
            ctx.textAlign = 'left';
            ctx.fillText(String(st.bugHealth[i]), x + 3 + icon, y + 2 + icon / 2 + 1);
            ctx.textAlign = 'center';
            if (t === CELL.LAND && st.nextSpread[i] > 0) {
              // Spread countdown ring.
              const left = st.nextSpread[i] - st.turn;
              const frac = Math.max(0, Math.min(1, 1 - left / SPREAD_INTERVAL));
              ctx.strokeStyle = 'rgba(236,254,255,0.85)';
              ctx.lineWidth = Math.max(1.5, cs / 16);
              ctx.beginPath();
              ctx.arc(x + s / 2, y + s / 2, s * 0.42, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
              ctx.stroke();
            }
          }
          // Power number.
          const p = fullPower(st, i);
          let f = fs;
          const txt = String(p);
          if (txt.length >= 4) f = Math.round(fs * (txt.length >= 5 ? 0.62 : 0.78));
          ctx.font = `700 ${f}px ${MONO}`;
          ctx.fillStyle = C.text;
          ctx.fillText(txt, x + s / 2, y + s / 2 + (frozen ? cs * 0.08 : 1));
          // DC status: outline + icon (Cure needed pulses on the effects layer).
          if (isDC) {
            const status = m.statuses.get(i);
            if (status) drawStatus(ctx, x, y, s, icon, status);
          }
          if (!isDC && !frozen && m.spreadTargets.has(i)) {
            ctx.save();
            ctx.strokeStyle = C.frozenSolid;
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 1.5, y + 1.5, s - 3, s - 3);
            ctx.restore();
          }
        });
      } else if (t === CELL.MOUNTAIN) {
        ctx.fillStyle = C.obstacle;
        ctx.fillRect(x, y, s, s);
        I.mountain(ctx, x, y, s, 'rgba(255,255,255,0.28)');
      } else if (t === CELL.NEUTRAL_DC) {
        ctx.fillStyle = C.neutralDC;
        ctx.fillRect(x, y, s, s);
        I.rack(ctx, x, y, s, '#1F2937', 0.4);
        late.push(() => {
          ctx.font = `700 ${fs}px ${MONO}`;
          ctx.fillStyle = '#FFFFFF';
          ctx.fillText(String(st.cost[i]), x + s / 2, y + s / 2 + 1);
        });
      } else {
        ctx.fillStyle = C.land;
        ctx.fillRect(x, y, s, s);
      }
    }

    if (m.overlay === 'connectivity') drawLinks(ctx, st, snap, cs);
    for (const f of late) f();
    if (m.mp) for (const [cell] of m.mp.hq) {
      const x = (cell % st.width) * cs, y = Math.floor(cell / st.width) * cs;
      I.crown(ctx, x + cs / 2 - icon * 0.6, y + 1, icon * 1.2, '#FDE68A');
    }
    if (m.reveal) drawVisionOutline(ctx, st, cs);
  }

  /** Another player's cell: their colour (darker for land), power, and a bug if one is visible. */
  private drawForeign(ctx: CanvasRenderingContext2D, mp: MpDraw, i: number, x: number, y: number, s: number, fs: number, small: number, icon: number, late: (() => void)[]): void {
    const col = mp.color(mp.owner[i]);
    const isDC = mp.isDC[i] === 1;
    ctx.fillStyle = isDC ? col.dc : col.land;
    ctx.fillRect(x, y, s, s);
    if (isDC) I.rack(ctx, x, y, s, '#000000', 0.3);
    const bugH = mp.bugs.get(i);
    if (bugH !== undefined) { ctx.fillStyle = C.frozen; ctx.fillRect(x, y, s, s); }
    const pw = mp.power[i];
    late.push(() => {
      if (bugH !== undefined) {
        I.bug(ctx, x + 2, y + 2, icon, '#ECFEFF');
        ctx.font = `700 ${small}px ${MONO}`;
        ctx.fillStyle = '#ECFEFF';
        ctx.textAlign = 'left';
        ctx.fillText(String(bugH), x + 3 + icon, y + 2 + icon / 2 + 1);
        ctx.textAlign = 'center';
      }
      const txt = String(pw);
      let f = fs;
      if (txt.length >= 4) f = Math.round(fs * (txt.length >= 5 ? 0.62 : 0.78));
      ctx.font = `700 ${f}px ${MONO}`;
      ctx.fillStyle = C.text;
      ctx.fillText(txt, x + s / 2, y + s / 2 + 1);
    });
  }
}


function drawStatus(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, icon: number, status: DCStatus): void {
  const col = STATUS_COLOR[status];
  const ix = x + s - icon - 2, iy = y + 2;
  ctx.save();
  if (col && status !== 'cureNeeded') {
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    if (status === 'exposed') ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
  }
  ctx.restore();
  switch (status) {
    case 'safe': I.shield(ctx, ix, iy, icon, 'rgba(248,250,252,0.85)', 'small'); break;
    case 'vulnerable': I.shield(ctx, ix, iy, icon, C.vulnerable, 'open'); break;
    case 'exposed': I.warning(ctx, ix, iy, icon, C.exposed); break;
    case 'cureNeeded': I.wrench(ctx, ix, iy, icon, C.cureNeeded); break;
    case 'unprotected': I.shield(ctx, ix, iy, icon, C.unprotected, 'broken'); break;
    case 'atRisk': I.shield(ctx, ix, iy, icon, C.atRisk, 'cracked'); break;
    case 'protected': I.shield(ctx, ix, iy, icon, C.protected, 'full'); break;
  }
}

/** Link-strength lines between DCs (top-10 links), thickness and opacity by B(i, j) against T(t). */
function drawLinks(ctx: CanvasRenderingContext2D, st: GameState, snap: Snapshot, cs: number): void {
  const Tm = Math.max(1000, 100 * snap.turn);
  const seen = new Set<string>();
  ctx.save();
  ctx.lineCap = 'round';
  for (const [i, links] of snap.links) {
    for (const { j, b } of links) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const strength = Math.min(1, (b * 1000) / Tm);
      const xi = (i % st.width) * cs + cs / 2, yi = Math.floor(i / st.width) * cs + cs / 2;
      const xj = (j % st.width) * cs + cs / 2, yj = Math.floor(j / st.width) * cs + cs / 2;
      ctx.strokeStyle = strength >= 1 ? `rgba(74,222,128,0.75)` : `rgba(245,165,36,${(0.2 + strength * 0.5).toFixed(2)})`;
      ctx.lineWidth = 1 + strength * Math.max(2, cs / 8);
      ctx.beginPath();
      ctx.moveTo(xi, yi);
      ctx.lineTo(xj, yj);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Replays: outline the player's vision (fog is off). */
function drawVisionOutline(ctx: CanvasRenderingContext2D, st: GameState, cs: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(250,204,21,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const W = st.width, H = st.height;
  const v = (r: number, c: number) => r >= 0 && c >= 0 && r < H && c < W && st.visible[r * W + c] === 1;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (!v(r, c)) continue;
      const x = c * cs, y = r * cs;
      if (!v(r - 1, c)) { ctx.moveTo(x, y); ctx.lineTo(x + cs, y); }
      if (!v(r + 1, c)) { ctx.moveTo(x, y + cs); ctx.lineTo(x + cs, y + cs); }
      if (!v(r, c - 1)) { ctx.moveTo(x, y); ctx.lineTo(x, y + cs); }
      if (!v(r, c + 1)) { ctx.moveTo(x + cs, y); ctx.lineTo(x + cs, y + cs); }
    }
  }
  ctx.stroke();
  ctx.restore();
}

export const IMMUNITY_TURNS = IMMUNITY;
