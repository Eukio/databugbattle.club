import { MapStream } from './rng.ts';
import { CELL, type GenerationLog, type MapData } from './types.ts';

export const W = 20;
export const H = 20;
const N = W * H;
const BASE_MOUNTAINS = 75;

function neighbors4(i: number, w: number, h: number, out: number[]): number {
  let k = 0;
  const r = (i / w) | 0;
  const c = i - r * w;
  if (r > 0) out[k++] = i - w;
  if (r < h - 1) out[k++] = i + w;
  if (c > 0) out[k++] = i - 1;
  if (c < w - 1) out[k++] = i + 1;
  return k;
}

/** Connected regions of non-mountain cells. Returns region id per cell (−1 for mountains) and sizes. */
function regions(type: Uint8Array, w: number, h: number): { id: Int32Array; sizes: number[] } {
  const id = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  const nb = [0, 0, 0, 0];
  for (let s = 0; s < w * h; s++) {
    if (type[s] === CELL.MOUNTAIN || id[s] !== -1) continue;
    const rid = sizes.length;
    sizes.push(0);
    stack.push(s);
    id[s] = rid;
    while (stack.length) {
      const i = stack.pop()!;
      sizes[rid]++;
      const k = neighbors4(i, w, h, nb);
      for (let t = 0; t < k; t++) {
        const j = nb[t];
        if (type[j] !== CELL.MOUNTAIN && id[j] === -1) {
          id[j] = rid;
          stack.push(j);
        }
      }
    }
  }
  return { id, sizes };
}

/** Articulation points of the subgraph `inGraph` (4-connected). One Tarjan pass, iterative. */
function articulationPoints(inGraph: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const ap = new Uint8Array(n);
  const nb = [0, 0, 0, 0];
  let time = 0;
  for (let root = 0; root < n; root++) {
    if (!inGraph[root] || disc[root] !== -1) continue;
    let rootChildren = 0;
    // iterative DFS with explicit neighbour cursor
    const stackNode: number[] = [root];
    const stackIdx: number[] = [0];
    disc[root] = low[root] = time++;
    while (stackNode.length) {
      const u = stackNode[stackNode.length - 1];
      const k = neighbors4(u, w, h, nb);
      const idx = stackIdx[stackIdx.length - 1];
      if (idx < k) {
        stackIdx[stackIdx.length - 1] = idx + 1;
        const v = nb[idx];
        if (!inGraph[v]) continue;
        if (disc[v] === -1) {
          parent[v] = u;
          disc[v] = low[v] = time++;
          if (u === root) rootChildren++;
          stackNode.push(v);
          stackIdx.push(0);
        } else if (v !== parent[u]) {
          if (disc[v] < low[u]) low[u] = disc[v];
        }
      } else {
        stackNode.pop();
        stackIdx.pop();
        const p = parent[u];
        if (p !== -1) {
          if (low[u] < low[p]) low[p] = low[u];
          if (p !== root && low[u] >= disc[p]) ap[p] = 1;
        }
      }
    }
    if (rootChildren > 1) ap[root] = 1;
  }
  return ap;
}

function manhattan(a: number, b: number, w: number): number {
  const ar = (a / w) | 0, ac = a - ar * w, br = (b / w) | 0, bc = b - br * w;
  return Math.abs(ar - br) + Math.abs(ac - bc);
}

export function generateMap(seed: number): { map: MapData; log: GenerationLog } {
  const stream = new MapStream(seed >>> 0);
  let attempt = 0;
  let type = new Uint8Array(N);
  let L: number[] = [];
  let M = BASE_MOUNTAINS;
  // Steps 1–3: mountains, largest region, retry.
  for (;;) {
    attempt++;
    M = attempt <= 5 ? BASE_MOUNTAINS : Math.max(0, BASE_MOUNTAINS - 10 * (attempt - 5));
    const list = new Int32Array(N);
    for (let i = 0; i < N; i++) list[i] = i;
    for (let j = 0; j < M; j++) {
      const k = j + stream.draw(N - j);
      const t = list[j];
      list[j] = list[k];
      list[k] = t;
    }
    type = new Uint8Array(N);
    for (let j = 0; j < M; j++) type[list[j]] = CELL.MOUNTAIN;
    const { id, sizes } = regions(type, W, H);
    let best = -1;
    let bestSize = -1;
    for (let r = 0; r < sizes.length; r++) if (sizes[r] > bestSize) { bestSize = sizes[r]; best = r; } // first (lowest index) wins ties
    if (bestSize >= 200) {
      L = [];
      for (let i = 0; i < N; i++) if (id[i] === best) L.push(i);
      break;
    }
  }
  // Step 4: pocket fill.
  let pocketFill = 0;
  const inL = new Uint8Array(N);
  for (const i of L) inL[i] = 1;
  for (let i = 0; i < N; i++) if (type[i] !== CELL.MOUNTAIN && !inL[i]) { type[i] = CELL.MOUNTAIN; pocketFill++; }
  // Step 5: spawn.
  const spawn = L[stream.draw(L.length)];
  // Step 6: DC count.
  const D = 25 + stream.draw(16);
  // Step 7: candidates.
  const cand = L.filter((i) => i !== spawn);
  const n = cand.length;
  for (let j = 0; j < n - 1; j++) {
    const k = j + stream.draw(n - j);
    const t = cand[j];
    cand[j] = cand[k];
    cand[k] = t;
  }
  // Step 8: place DCs.
  const cost = new Int32Array(N);
  const placed: number[] = [];
  const used = new Uint8Array(N);
  let fallbacks = 0;
  const graph = new Uint8Array(inL); // L with placed DCs removed
  for (let d = 0; d < D; d++) {
    const ap = articulationPoints(graph, W, H);
    let pick = -1;
    for (const c of cand) {
      if (used[c]) continue;
      if (manhattan(c, spawn, W) < 3) continue;
      if (ap[c]) continue;
      let ok = true;
      for (const p of placed) if (manhattan(c, p, W) < 2) { ok = false; break; }
      if (ok) { pick = c; break; }
    }
    if (pick === -1) {
      for (const c of cand) {
        if (used[c]) continue;
        if (manhattan(c, spawn, W) < 3) continue;
        pick = c;
        fallbacks++;
        break;
      }
    }
    if (pick === -1) break;
    used[pick] = 1;
    placed.push(pick);
    graph[pick] = 0;
    type[pick] = CELL.NEUTRAL_DC;
    cost[pick] = 12 + stream.draw(7);
  }
  return {
    map: { width: W, height: H, type, cost, spawn },
    log: { attempts: attempt, m: M, pocketFill, dcsPlaced: placed.length, dcsWanted: D, fallbacks },
  };
}
