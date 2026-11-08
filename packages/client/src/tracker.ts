// Per-bug cost estimate for the results screen (doc §Results screen). Observes the state after every
// tic; never changes it. Costs are estimates and are labelled as such in the UI.
import { CELL, RUN_TURNS, LAND_INCOME_INTERVAL, neighbors4, type GameState, type TicEvents } from './sim.ts';
import { productionRate } from './analysis.ts';

export interface BugRecord {
  id: number;
  cell: number;
  kind: 'dc' | 'land' | 'child';
  parent: number | null;
  spawnTurn: number;
  health0: number;
  curedTurn: number | null;
  decremented: number;
  productionLost: number;
  incomeMissed: number;
  cureSpent: number;
  children: number[];
  rateAtHit: number; // DC production per turn when hit
  paid: boolean | null;
}

export class Tracker {
  readonly bugs = new Map<number, BugRecord>();
  stranded = 0;
  private prevPower: Int32Array;
  private prevBug: Int32Array;
  private bugIdAtTurnStart: number;
  private lastProtected = new Map<number, boolean>();

  constructor(st: GameState) {
    this.prevPower = new Int32Array(st.power);
    this.prevBug = new Int32Array(st.bugId);
    this.bugIdAtTurnStart = st.nextBugId;
  }

  onTic(st: GameState, ev: TicEvents): void {
    const s = ev.step;
    if (s && (s.kind === 'cure' || s.kind === 'partialCure')) {
      const id = this.prevBug[s.to];
      const rec = this.bugs.get(id);
      if (rec) {
        rec.cureSpent += s.kind === 'cure' ? s.sent - s.arrived : s.sent;
        if (s.kind === 'cure') {
          rec.curedTurn = ev.turn;
          const remaining = st.turnLimit ? Math.max(0, st.turnLimit - ev.turn) : null;
          if (remaining !== null) rec.paid = rec.cureSpent < this.lossRate(rec, ev.turn) * remaining;
        }
      }
    }
    if (!ev.turnResolved) return;
    const t = ev.turnResolved.turn;
    const n = st.width * st.height;
    const A = st.snapA!;
    // Frozen cells that existed at snapshot A this turn (bugs born at steps 8/10 have newer IDs).
    const frozenAtA = (c: number) => st.bugId[c] >= 0 && st.bugId[c] < this.bugIdAtTurnStart;

    for (let c = 0; c < n; c++) {
      const id = st.bugId[c];
      if (id < 0 || this.prevBug[c] !== id) continue;
      const rec = this.bugs.get(id);
      if (!rec) continue;
      const d = this.prevPower[c] - st.power[c];
      if (d > 0) rec.decremented += d; // a frozen cell only ever loses power to decrements
      if (st.type[c] === CELL.OWNED_DC) {
        const prot = st.protectedFlag[c] === 1;
        this.lastProtected.set(id, prot);
        if (!prot) rec.productionLost += rec.rateAtHit;
      }
    }

    if (t % LAND_INCOME_INTERVAL === 0) this.attributeCutOff(st, frozenAtA);

    for (const sp of ev.spreads) {
      const parentId = st.bugId[sp.from];
      const rec = this.newRecord(sp.id, sp.to, 'child', t, sp.health, parentId >= 0 ? parentId : null);
      if (parentId >= 0) this.bugs.get(parentId)?.children.push(rec.id);
    }
    for (const sp of ev.spawns) {
      const rec = this.newRecord(sp.id, sp.cell, st.type[sp.cell] === CELL.OWNED_DC ? 'dc' : 'land', t, sp.health, null);
      if (rec.kind === 'dc') rec.rateAtHit = productionRate(st, A, sp.cell);
    }

    this.prevPower.set(st.power);
    this.prevBug.set(st.bugId);
    this.bugIdAtTurnStart = st.nextBugId;
  }

  private newRecord(id: number, cell: number, kind: BugRecord['kind'], turn: number, health: number, parent: number | null): BugRecord {
    const rec: BugRecord = {
      id, cell, kind, parent, spawnTurn: turn, health0: health, curedTurn: null, decremented: 0, productionLost: 0,
      incomeMissed: 0, cureSpent: 0, children: [], rateAtHit: 0, paid: null,
    };
    this.bugs.set(id, rec);
    return rec;
  }

  /** Doc §Cut-off attribution: credit each missed land income to the first frozen neighbour (by bug ID) that would reconnect it. */
  private attributeCutOff(st: GameState, frozenAtA: (c: number) => boolean): void {
    const A = st.snapA!;
    const n = st.width * st.height;
    const byComp = new Map<number, number[]>();
    for (let c = 0; c < n; c++) {
      if (!st.owned[c] || A.comp[c] < 0 || A.anchored[c]) continue;
      const k = A.comp[c];
      let arr = byComp.get(k);
      if (!arr) byComp.set(k, (arr = []));
      arr.push(c);
    }
    const nb = [0, 0, 0, 0];
    const nb2 = [0, 0, 0, 0];
    for (const cells of byComp.values()) {
      const land = cells.filter((c) => st.type[c] === CELL.LAND).length;
      if (!land) continue;
      const frozenNbrs = new Set<number>();
      for (const c of cells) {
        const k = neighbors4(st, c, nb);
        for (let q = 0; q < k; q++) if (frozenAtA(nb[q])) frozenNbrs.add(nb[q]);
      }
      const ordered = [...frozenNbrs].sort((a, b) => st.bugId[a] - st.bugId[b]);
      let credited = false;
      for (const f of ordered) {
        const k = neighbors4(st, f, nb2);
        let bridges = false;
        for (let q = 0; q < k; q++) { const m = nb2[q]; if (A.comp[m] >= 0 && A.anchored[m]) { bridges = true; break; } }
        if (bridges) {
          const rec = this.bugs.get(st.bugId[f]);
          if (rec) rec.incomeMissed += land;
          credited = true;
          break;
        }
      }
      if (!credited) this.stranded += land;
    }
  }

  private lossRate(rec: BugRecord, turn: number): number {
    if (rec.kind === 'dc') return this.lastProtected.get(rec.id) ? 0 : 0.5 + rec.rateAtHit;
    const age = Math.max(1, turn - rec.spawnTurn);
    return 0.5 + rec.incomeMissed / age;
  }

  /** Own cost plus its children's, recursively. */
  totalCost(id: number): number {
    const rec = this.bugs.get(id);
    if (!rec) return 0;
    let s = rec.decremented + rec.productionLost + rec.incomeMissed;
    for (const c of rec.children) s += this.totalCost(c);
    return s;
  }

  list(): BugRecord[] {
    return [...this.bugs.values()].sort((a, b) => this.totalCost(b.id) - this.totalCost(a.id) || a.id - b.id);
  }
}

export const RUN_LENGTH = RUN_TURNS;
