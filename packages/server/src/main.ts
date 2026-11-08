// Entry point: node --disable-warning=ExperimentalWarning packages/server/src/main.ts
//   PORT (default 8787), DB (default ./dcg.sqlite), CLIENT_DIR (default packages/client/dist)
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createApp } from './app.ts';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB ?? resolve(process.cwd(), 'dcg.sqlite');
const clientDir = process.env.CLIENT_DIR ?? join(here, '..', '..', 'client', 'dist');
if (!existsSync(join(clientDir, 'index.html'))) console.warn(`No client build at ${clientDir} — run: node packages/client/build.mjs`);

const ticMs = Number(process.env.MP_TIC_MS) || undefined; // multiplayer tic length; 500 ms by default
const app = createApp({ dbPath, clientDir, mp: ticMs ? { ticMs } : {} });
app.server.listen(port, () => console.log(`Data Center Grid server on http://localhost:${port}  (db: ${dbPath})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
