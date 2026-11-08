// pnpm --filter sim golden:generate [--update]
// Builds golden/seed-NN.json for seeds 1..20 with the stream-9 fuzz player (see src/fuzz.ts for slot use).
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fuzzRun } from '../src/fuzz.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden');
mkdirSync(dir, { recursive: true });
const update = process.argv.includes('--update');
let written = 0;
for (let seed = 1; seed <= 20; seed++) {
  const file = join(dir, `seed-${String(seed).padStart(2, '0')}.json`);
  if (existsSync(file) && !update) continue;
  const { log, st } = fuzzRun({ seed }, seed);
  writeFileSync(file, JSON.stringify({ seed, log, hashes: st.hashes, score: st.telemetry.score }));
  written++;
}
console.log(`golden: ${written} file(s) written${update ? ' (update)' : ''}`);
