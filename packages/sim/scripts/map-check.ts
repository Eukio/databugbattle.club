// pnpm --filter sim map-check --count 10000
import { generateMap } from '../src/map.ts';
const idx = process.argv.indexOf('--count');
const count = idx >= 0 ? Number(process.argv[idx + 1]) : 1000;
const hist = (xs: number[]) => { const m = new Map<number, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '); };
const attempts: number[] = [], pocket: number[] = [], fallbacks: number[] = [], shortfall: number[] = [], dcs: number[] = [];
const t0 = performance.now();
for (let seed = 1; seed <= count; seed++) {
  const { log } = generateMap(seed);
  attempts.push(log.attempts); pocket.push(log.pocketFill); fallbacks.push(log.fallbacks); shortfall.push(log.dcsWanted - log.dcsPlaced); dcs.push(log.dcsPlaced);
}
console.log(`maps: ${count} in ${(performance.now() - t0).toFixed(0)} ms`);
console.log('attempts      ', hist(attempts));
console.log('pocket fill   ', hist(pocket));
console.log('fallback DCs  ', hist(fallbacks));
console.log('DC shortfall  ', hist(shortfall));
console.log('DCs placed    ', hist(dcs));
