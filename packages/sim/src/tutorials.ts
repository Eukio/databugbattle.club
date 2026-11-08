import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Tutorial } from './types.ts';

export { TUTORIAL_IDS, hintTriggers } from './hints.ts';

/** Node-side loader (tests, server). The client bundles the JSON files directly. */
export function loadTutorial(id: string): Tutorial {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tutorials');
  return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as Tutorial;
}
