// Builds the local GameState-shaped view of a multiplayer frame, so the single-player controller, queue
// preview, statuses and overlays work unchanged on "my" network. Other players' cells are kept separately
// (MpDraw) for drawing. Enemy cells appear in the view as neutral DCs whose cost is their power, so the
// preview's capture math (arriving minus defence) is the server's.
import { CELL, MPK, blankGameState, type GameState, type MpFrame } from './sim.ts';
import type { MpDraw } from './render/board.ts';

export interface MpStart {
  matchId: string;
  mode: string;
  you: number;
  width: number;
  height: number;
  turnLimit: number;
  bugs: boolean;
  players: { name: string; team: number }[];
  startsIn: number;
}

// Me: always the single-player blues. Others: distinct hues, darker for land.
const OTHERS = [
  { dc: '#EF4444', land: '#991B1B' }, { dc: '#22C55E', land: '#166534' }, { dc: '#A855F7', land: '#6B21A8' },
  { dc: '#F97316', land: '#9A3412' }, { dc: '#EC4899', land: '#9D174D' }, { dc: '#EAB308', land: '#854D0E' },
  { dc: '#84CC16', land: '#3F6212' },
];
export const ME_COLOR = { dc: '#3B82F6', land: '#1D4ED8' };

export function colorFor(start: MpStart, p: number): { dc: string; land: string } {
  if (p === start.you) return ME_COLOR;
  const k = p < start.you ? p : p - 1;
  return OTHERS[k % OTHERS.length];
}

export const isAlly = (s: MpStart, p: number) => p !== s.you && s.players[p].team === s.players[s.you].team;

export function buildView(s: MpStart, f: MpFrame): { view: GameState; draw: MpDraw } {
  const view = blankGameState(s.width, s.height);
  const n = s.width * s.height;
  const draw: MpDraw = {
    me: s.you, owner: new Int8Array(n).fill(-1), isDC: new Uint8Array(n), power: new Int32Array(n),
    bugs: new Map(), hq: new Map(), color: (p) => colorFor(s, p),
  };
  view.kind = 'practice';
  view.turn = f.turn;
  view.tic = f.tic;
  view.turnLimit = 0; // never finishes locally; the clock comes from the match
  view.randomBugs = false;
  view.fog = true;
  for (let i = 0; i < n; i++) {
    const k = f.k[i];
    const o = f.o[i];
    if (k === MPK.FOG) { view.type[i] = CELL.LAND; continue; }
    if (k === MPK.FOG_OBSTACLE) { view.type[i] = CELL.MOUNTAIN; continue; }
    view.visible[i] = 1;
    if (k === MPK.MOUNTAIN) { view.type[i] = CELL.MOUNTAIN; continue; }
    const dc = k === MPK.DC;
    draw.isDC[i] = dc ? 1 : 0;
    draw.owner[i] = o;
    if (o === s.you) {
      view.owned[i] = 1;
      view.type[i] = dc ? CELL.OWNED_DC : CELL.LAND;
      view.power[i] = f.p[i];
    } else if (o >= 0 && isAlly(s, o)) {
      view.type[i] = CELL.LAND; // stepping in gifts power; the preview shows it like a claim
      draw.power[i] = f.p[i];
    } else if (o >= 0 || dc || f.p[i] > 0) {
      view.type[i] = CELL.NEUTRAL_DC; // attackable: cost = defence
      view.cost[i] = f.p[i];
      draw.power[i] = f.p[i];
    } else {
      view.type[i] = CELL.LAND;
    }
  }
  for (const [c, amt] of f.tr) view.travel[c] = amt;
  let id = 0;
  for (const [c, health, imm, spread, growth, dec, prot] of f.bugs) {
    if (f.o[c] === s.you) {
      view.bugId[c] = id++;
      view.bugHealth[c] = health;
      view.immunity[c] = imm;
      view.nextSpread[c] = spread;
      view.nextGrowth[c] = growth;
      view.decCounter[c] = dec;
      view.protectedFlag[c] = prot;
    } else draw.bugs.set(c, health);
  }
  view.nextBugId = id;
  for (const [c, p] of f.hqs) draw.hq.set(c, p);
  view.queue = structuredClone(f.queue);
  view.nextPathId = f.nextPathId;
  return { view, draw };
}
