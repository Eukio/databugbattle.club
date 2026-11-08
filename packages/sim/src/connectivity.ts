// Bottleneck connectivity (design doc §Connectivity). One snapshot = one maximum spanning forest.
import { CELL, type GameState, type Snapshot } from './types.ts';

export const TOP_K = 10;

function nbrs(i: number, w: number, h: number, out: number[]): number {
  let k = 0;
  const r = (i / w) | 0;
  const c = i - r * w;
  if (r > 0) out[k++] = i - w;
  if (r < h - 1) out[k++] = i + w;
  if (c > 0) out[k++] = i - 1;
  if (c < w - 1) out[k++] = i + 1;
  return k;
}

export function isFrozen(st: GameState, c: number): boolean {
  return st.bugId[c] >= 0;
}
export function isOwnedDC(st: GameState, c: number): boolean {
  return st.type[c] === CELL.OWNED_DC;
}
export function isHealthyDC(st: GameState, c: number): boolean {
  return st.type[c] === CELL.OWNED_DC && st.bugId[c] < 0;
}
/** A cell's power for connectivity, firewalls and score: own power plus any travelling amount sitting in it. */
export function fullPower(st: GameState, c: number): number {
  return st.power[c] + st.travel[c];
}

export function computeSnapshot(st: GameState): Snapshot {
  const { width: w, height: h } = st;
  const n = w * h;
  const inForest = new Uint8Array(n);
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    p[i] = fullPower(st, i);
    if (st.owned[i] && st.bugId[i] < 0) inForest[i] = 1;
  }
  // Edges between forest cells, weight = min(power). Sort high → low, ties by lower index then higher.
  const edges: { a: number; b: number; wgt: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!inForest[i]) continue;
    const r = (i / w) | 0;
    const c = i - r * w;
    if (c < w - 1 && inForest[i + 1]) edges.push({ a: i, b: i + 1, wgt: Math.min(p[i], p[i + 1]) });
    if (r < h - 1 && inForest[i + w]) edges.push({ a: i, b: i + w, wgt: Math.min(p[i], p[i + w]) });
  }
  edges.sort((x, y) => y.wgt - x.wgt || x.a - y.a || x.b - y.b);
  const uf = new Int32Array(n);
  for (let i = 0; i < n; i++) uf[i] = i;
  const find = (x: number): number => {
    while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; }
    return x;
  };
  const adj: number[][] = new Array(n);
  const adjW: number[][] = new Array(n);
  for (let i = 0; i < n; i++) { adj[i] = []; adjW[i] = []; }
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra === rb) continue;
    uf[ra] = rb;
    adj[e.a].push(e.b); adjW[e.a].push(e.wgt);
    adj[e.b].push(e.a); adjW[e.b].push(e.wgt);
  }
  // Components and anchors.
  const comp = new Int32Array(n).fill(-1);
  const anchored = new Uint8Array(n);
  const compHasAnchor: boolean[] = [];
  let compCount = 0;
  const rootComp = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (!inForest[i]) continue;
    const r = find(i);
    let cid = rootComp.get(r);
    if (cid === undefined) { cid = compCount++; rootComp.set(r, cid); compHasAnchor.push(false); }
    comp[i] = cid;
    if (isHealthyDC(st, i)) compHasAnchor[cid] = true;
  }
  for (let i = 0; i < n; i++) if (comp[i] >= 0 && compHasAnchor[comp[i]]) anchored[i] = 1;

  // Pairwise bottlenecks: one forest traversal from each healthy DC.
  const healthyDCs: number[] = [];
  for (let i = 0; i < n; i++) if (isHealthyDC(st, i)) healthyDCs.push(i);
  const bj: Int32Array[] = [];
  const stack: number[] = [];
  for (const j of healthyDCs) {
    const b = new Int32Array(n); // 0 = unreachable
    b[j] = p[j];
    stack.length = 0;
    stack.push(j);
    const seen = new Uint8Array(n);
    seen[j] = 1;
    while (stack.length) {
      const u = stack.pop()!;
      const au = adj[u], wu = adjW[u];
      for (let t = 0; t < au.length; t++) {
        const v = au[t];
        if (seen[v]) continue;
        seen[v] = 1;
        b[v] = Math.min(b[u], wu[t]);
        stack.push(v);
      }
    }
    bj.push(b);
  }
  // R(n) and DC B_best.
  const R = new Int32Array(n);
  const Bbest = new Int32Array(n);
  const bestLink = new Int32Array(n);
  const links = new Map<number, { j: number; b: number }[]>();
  for (let i = 0; i < n; i++) {
    if (!inForest[i]) continue;
    let r = 0;
    for (let k = 0; k < healthyDCs.length; k++) if (bj[k][i] > r) r = bj[k][i];
    R[i] = r;
  }
  const nb = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (!st.owned[i]) continue;
    if (st.type[i] === CELL.OWNED_DC) {
      const frozen = st.bugId[i] >= 0;
      const list: { j: number; b: number }[] = [];
      for (let k = 0; k < healthyDCs.length; k++) {
        const j = healthyDCs[k];
        if (j === i) continue;
        let b: number;
        if (!frozen) b = bj[k][i];
        else {
          // Compromised DC: outside the forest; link through its owned, non-frozen neighbours, capped by its own stack.
          b = 0;
          const cnt = nbrs(i, w, h, nb);
          for (let t = 0; t < cnt; t++) {
            const m = nb[t];
            if (!inForest[m]) continue;
            const v = Math.min(p[i], bj[k][m]);
            if (v > b) b = v;
          }
        }
        if (b > 0) list.push({ j, b });
      }
      list.sort((x, y) => y.b - x.b || x.j - y.j);
      if (list.length > TOP_K) list.length = TOP_K;
      links.set(i, list);
      bestLink[i] = list.length ? list[0].b : 0;
      if (!frozen) Bbest[i] = bestLink[i];
    } else if (inForest[i]) {
      // Land: best R over owned, non-frozen neighbours, not counting its own power.
      let best = 0;
      const cnt = nbrs(i, w, h, nb);
      for (let t = 0; t < cnt; t++) {
        const m = nb[t];
        if (inForest[m] && R[m] > best) best = R[m];
      }
      Bbest[i] = best;
    }
  }
  return { turn: st.turn, comp, anchored, R, Bbest, bestLink, links, healthyDCs, bj };
}
