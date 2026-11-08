// Effects layer, redrawn every frame: queue preview, cursor and selection, pulses, event effects.
import type { DCStatus, GameState, QueuePreview } from '../sim.ts';
import { C, MONO, PATH_COLORS } from './theme.ts';
import { cross } from './icons.ts';
import type { BoardView } from './board.ts';

export interface Effect { kind: 'capture' | 'cure' | 'spawn' | 'spread' | 'fail' | 'short' | 'claim'; cell: number; from?: number; t0: number }

export interface FxModel {
  st: GameState;
  preview: QueuePreview | null;
  cursor: number | null;
  selected: number | null;
  hover: number;
  halfNext: boolean;
  drain: Set<number>;
  statuses: Map<number, DCStatus>;
  cureWindow: number[];
  weakest: number | null;
  effects: Effect[];
  shake: { cell: number; t0: number } | null;
}

const EFFECT_MS = 600;

export function drawFx(view: BoardView, m: FxModel, now: number): void {
  const ctx = view.ctx('fx');
  const cs = view.cs;
  const st = m.st;
  ctx.clearRect(0, 0, cs * st.width, cs * st.height);
  const cx = (i: number) => (i % st.width) * cs + cs / 2;
  const cy = (i: number) => Math.floor(i / st.width) * cs + cs / 2;
  const box = (i: number, inset: number) => [(i % st.width) * cs + inset, Math.floor(i / st.width) * cs + inset, cs - 1 - 2 * inset, cs - 1 - 2 * inset] as const;
  const pulse = 0.5 + 0.5 * Math.sin(now / 180);

  // Pulsing outlines: Cure needed (red), drain warning (amber flash), cure window glow.
  for (const [i, s] of m.statuses) {
    if (s !== 'cureNeeded') continue;
    ctx.save();
    ctx.strokeStyle = C.cureNeeded;
    ctx.globalAlpha = 0.45 + 0.55 * pulse;
    ctx.lineWidth = 2 + pulse * 1.5;
    ctx.strokeRect(...box(i, 1));
    ctx.restore();
  }
  for (const i of m.cureWindow) {
    ctx.save();
    ctx.shadowColor = C.frozenSolid;
    ctx.shadowBlur = 6 + pulse * 8;
    ctx.strokeStyle = `rgba(103,232,249,${(0.5 + 0.5 * pulse).toFixed(2)})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(...box(i, 1));
    ctx.restore();
  }
  if (Math.floor(now / 300) % 2 === 0) {
    for (const i of m.drain) {
      ctx.save();
      ctx.strokeStyle = C.atRisk;
      ctx.lineWidth = 3;
      ctx.strokeRect(...box(i, 1));
      ctx.restore();
    }
  }
  if (m.weakest !== null) {
    ctx.save();
    ctx.strokeStyle = '#F472B6';
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(...box(m.weakest, 3));
    ctx.restore();
  }

  // Queue preview.
  if (m.preview) {
    const fsz = Math.max(9, Math.round((10 * cs) / 32));
    m.preview.paths.forEach((rec, idx) => {
      const path = st.queue.find((p) => p.id === rec.id);
      if (!path) return;
      const color = PATH_COLORS[rec.id % PATH_COLORS.length];
      const head = idx === 0;
      let prev = path.executed > 0 ? path.current : path.origin;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of rec.steps) {
        const bad = s.fails;
        ctx.strokeStyle = bad ? 'rgba(239,68,68,0.9)' : color;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.globalAlpha = head ? 0.95 : 0.7;
        ctx.lineWidth = Math.max(2, cs * (head ? 0.11 : 0.08));
        ctx.setLineDash(bad ? [4, 4] : []);
        arrow(ctx, cx(prev), cy(prev), cx(s.target), cy(s.target), cs);
        prev = s.target;
      }
      ctx.restore();
      // Arrival badges and fail crosses.
      for (const s of rec.steps) {
        const x = cx(s.target), y = cy(s.target) + cs * 0.3;
        let label: string;
        let bg: string;
        if (s.fogged && !s.fails) { label = '?'; bg = 'rgba(15,23,42,0.85)'; }
        else if (s.fails) { label = ''; bg = ''; }
        else if (s.cause === 'shortAttack') { label = `−${s.sent}`; bg = 'rgba(180,83,9,0.95)'; }
        else if (s.cause === 'partialCure') { label = `−${s.sent}`; bg = 'rgba(14,116,144,0.95)'; }
        else if (s.intent === 'cure') { label = `+${s.arrival}`; bg = 'rgba(14,116,144,0.95)'; }
        else { label = String(s.arrival); bg = 'rgba(15,23,42,0.85)'; }
        if (s.fails) {
          ctx.save();
          ctx.fillStyle = 'rgba(15,23,42,0.85)';
          roundRect(ctx, x - fsz * 0.75, y - fsz / 2 - 1, fsz * 1.5, fsz + 2, 3);
          ctx.fill();
          ctx.restore();
          cross(ctx, x, y, fsz * 0.32, '#EF4444', Math.max(1.5, cs / 16));
          continue;
        }
        ctx.save();
        ctx.font = `700 ${fsz}px ${MONO}`;
        const tw = ctx.measureText(label).width + 6;
        ctx.fillStyle = bg;
        roundRect(ctx, x - tw / 2, y - fsz / 2 - 1, tw, fsz + 2, 3);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + 0.5);
        ctx.restore();
      }
    });
  }

  // Event effects.
  m.effects = m.effects.filter((e) => now - e.t0 < EFFECT_MS);
  for (const e of m.effects) {
    const k = (now - e.t0) / EFFECT_MS;
    ctx.save();
    ctx.globalAlpha = 1 - k;
    const col = e.kind === 'capture' ? '#93C5FD' : e.kind === 'cure' ? '#4ADE80' : e.kind === 'spawn' || e.kind === 'spread' ? C.frozenSolid : e.kind === 'short' ? C.atRisk : e.kind === 'claim' ? '#93C5FD' : '#EF4444';
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    if (e.kind === 'fail') cross(ctx, cx(e.cell), cy(e.cell), cs * 0.25, col, 3);
    else if (e.kind === 'claim') { ctx.globalAlpha = 0.5 * (1 - k); ctx.strokeRect(...box(e.cell, 2)); }
    else {
      ctx.beginPath();
      ctx.arc(cx(e.cell), cy(e.cell), cs * (0.3 + k * 0.6), 0, Math.PI * 2);
      ctx.stroke();
      if (e.kind === 'spread' && e.from !== undefined) {
        ctx.beginPath();
        ctx.moveTo(cx(e.from), cy(e.from));
        ctx.lineTo(cx(e.cell), cy(e.cell));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Hover, selection, cursor.
  if (m.hover >= 0 && m.hover !== m.cursor && m.hover !== m.selected) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(...box(m.hover, 0.5));
    ctx.restore();
  }
  if (m.selected !== null) {
    ctx.save();
    ctx.strokeStyle = C.selected;
    ctx.lineWidth = 2;
    ctx.strokeRect(...box(m.selected, 1));
    ctx.restore();
  }
  if (m.cursor !== null) {
    let dx = 0;
    if (m.shake && m.shake.cell === m.cursor && now - m.shake.t0 < 280) dx = Math.sin((now - m.shake.t0) / 18) * 4;
    ctx.save();
    ctx.translate(dx, 0);
    ctx.strokeStyle = C.cursor;
    ctx.lineWidth = 2;
    const inset = m.selected === m.cursor ? 3.5 : 1;
    ctx.strokeRect(...box(m.cursor, inset));
    if (m.halfNext) {
      const fsz = Math.max(9, Math.round((10 * cs) / 32));
      ctx.font = `700 ${fsz}px ${MONO}`;
      ctx.fillStyle = C.cursor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('50%', cx(m.cursor), Math.floor(m.cursor / st.width) * cs + 1);
    }
    ctx.restore();
  }
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, cs: number): void {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const sx = x0 + ux * cs * 0.3, sy = y0 + uy * cs * 0.3;
  const ex = x1 - ux * cs * 0.3, ey = y1 - uy * cs * 0.3;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  const a = cs * 0.14;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(ex + ux * a * 0.6, ey + uy * a * 0.6);
  ctx.lineTo(ex - uy * a - ux * a * 0.4, ey + ux * a - uy * a * 0.4);
  ctx.lineTo(ex + uy * a - ux * a * 0.4, ey - ux * a - uy * a * 0.4);
  ctx.closePath();
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
