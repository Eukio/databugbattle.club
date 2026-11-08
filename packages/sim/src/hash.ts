// State hash: 32-bit FNV-1a over int32 values written as 4 little-endian bytes (design doc §State hash).
import { MODE_CODE, type GameState } from './types.ts';

export const HASH_VERSION = 6;

class Fnv {
  h = 0x811c9dc5;
  int32(v: number): void {
    v = v | 0;
    let h = this.h;
    for (let i = 0; i < 4; i++) {
      h ^= (v >>> (8 * i)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    this.h = h;
  }
}

export function stateHash(st: GameState): number {
  const f = new Fnv();
  // 1. Header
  f.int32(HASH_VERSION);
  f.int32(st.turn);
  f.int32(st.width);
  f.int32(st.height);
  f.int32(st.nextBugId);
  f.int32(st.nextPathId);
  f.int32(st.paused);
  f.int32(st.pausesUsed);
  // 2. Per cell
  const n = st.width * st.height;
  for (let i = 0; i < n; i++) {
    f.int32(st.type[i]);
    f.int32(st.owned[i]);
    f.int32(st.power[i]);
    f.int32(st.travel[i]);
    f.int32(st.cost[i]);
    f.int32(st.acc[i]);
    f.int32(st.bugId[i]);
    f.int32(st.bugHealth[i]);
    f.int32(st.immunity[i]);
    f.int32(st.nextGrowth[i]);
    f.int32(st.nextSpread[i]);
    f.int32(st.decCounter[i]);
    f.int32(st.protectedFlag[i]);
    f.int32(st.visible[i]);
  }
  // 3. Queue
  f.int32(st.queue.length);
  for (const p of st.queue) {
    f.int32(p.id);
    f.int32(MODE_CODE[p.mode]);
    f.int32(p.mode === 'keep' ? p.n : 0);
    f.int32(p.current);
    f.int32(p.executed);
    const remaining = p.steps.length - p.executed;
    f.int32(remaining);
    for (let k = p.executed; k < p.steps.length; k++) {
      f.int32(p.steps[k].target);
      f.int32(p.steps[k].intent === 'cure' ? 1 : 0);
    }
  }
  return f.h >>> 0;
}
