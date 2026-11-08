# Data Center Grid

Monorepo for the design doc (rev 6): a single-player, generals.io-style run against bugs.

| Package | What |
| --- | --- |
| `packages/sim` | Deterministic simulation shared by client and server (rules, RNG, map, connectivity, hash, controller, preview, verify) |
| `packages/client` | Canvas 2D board + effects layer, plain TypeScript/DOM HUD and screens, no framework |
| `packages/server` | HTTP API, ranked WebSocket, SQLite, re-simulation, abandonment job — Node built-ins only |

## Run it

Requires Node ≥ 22.13 (`node:sqlite`). The scripts pass `--experimental-strip-types`, so Node 22.13–22.17 can run the `.ts` sources too.

```
node --experimental-strip-types --disable-warning=ExperimentalWarning packages/server/src/main.ts   # http://localhost:8787
```

The client is already built in `packages/client/dist`, so that one command is enough: the server serves the
game, ranked dailies, the leaderboard, replays and multiplayer from one origin. `PORT`, `DB` (SQLite file, default
`./dcg.sqlite`) and `CLIENT_DIR` are environment variables.

No server? Open `packages/client/dist-single/index.html` directly: the offline build plays tutorials,
practice seeds and an unranked offline daily, with personal bests and replays kept in the browser.

## Develop

```
pnpm install                       # only esbuild, for rebuilding the client
pnpm build                         # packages/client/dist
pnpm build:single                  # packages/client/dist-single/index.html (everything inlined)
pnpm test                          # sim (incl. 1,000-seed conservation fuzz, ≈ 30 s) + server integration
FUZZ_SEEDS=100 node --test packages/sim/test/*.test.ts
node packages/sim/scripts/map-check.ts --count 10000
node packages/sim/scripts/golden.ts --update   # only when a rule changes; say which in the PR
```

Dev aid: `?speed=N` in the URL runs the clock N× faster (pacing only; the simulation is unaffected).
`MP_TIC_MS=40 npm start` speeds up multiplayer matches the same way (default 500 ms per tic).

## Multiplayer

Menu → **Multiplayer**. Queues work like generals.io: press **1v1**, **2v2** or **Free for all** and the match
starts as soon as enough players are queued (2, 4, or 8 — FFA also starts early when a majority of the queue
votes **Force start**, with at least 2). **Create a room** for a private game: share the 4-letter code or the
invite link (`/#room-CODE`), pick teams, and the host starts it.

Rules on top of single player: everyone starts on an HQ (crown). Moving into an enemy cell attacks it —
arriving power minus its power; more than 0 left takes it. Capturing an enemy HQ eliminates that player and
hands you their cells at half power. Teammates share vision; moving onto an ally's cell gives them the power.
When time runs out (300 turns in 1v1, 400 otherwise) the team with the most total power wins. Bugs, the safe
level, production and land income work per network exactly as in single player. The server runs every match
authoritatively; a dropped player has 30 seconds to reconnect (a reload puts you straight back in), then
surrenders and their cells turn neutral.

Resolved spec ambiguities and the places this build departs from the doc are in `DECISIONS.md`.

## packages/client

| File | What |
| --- | --- |
| `src/main.ts`, `src/app.ts` | boot, screen router, run flows (practice, tutorials, ranked start and crash-recovery resume) |
| `src/loop.ts` | rAF + fixed-step accumulator, at most one tic of backlog |
| `src/render/board.ts` | static layer: cells, fog, numbers, statuses, frozen/immunity/spread rings, overlays |
| `src/render/fx.ts` | effects layer: queue preview with arrivals and failures, cursor, pulses, event effects |
| `src/ui/hud.ts` | top bar and right panel (queue list, cell details with the "Shows" text per status) |
| `src/ui/screens/` | game, menus, daily, leaderboard, results (per-bug cost estimates), replay viewer |
| `src/analysis.ts`, `src/tracker.ts` | weakest cells, drain warnings, queue projection; per-bug cost attribution |
| `src/net/` | HTTP API and the ranked WebSocket session with reconnect |
| `src/storage.ts` | name, token, personal bests (via sim `product.ts`), tutorial ticks, ranked backup |
| `src/net/mp.ts`, `src/mpview.ts` | multiplayer socket; builds the local view from each server frame |
| `src/ui/screens/mplobby.ts`, `mpgame.ts` | queues and rooms; the match screen with prediction, scoreboard and results |

## packages/server

| File | What |
| --- | --- |
| `src/app.ts` | endpoints, rate limits, static files, ranked protocol, abandonment sweep |
| `src/db.ts` | schema (doc + `runs.updated`), prepared statements, ranking |
| `src/daily.ts` | per-day secret, HMAC map seed and bug keys |
| `src/verify.ts` | re-simulation with anomaly-flag inputs |
| `src/ws.ts` | minimal RFC 6455 server side |
| `src/mp.ts` | matchmaking queues, force start, rooms and teams, live matches, reconnect, surrender |

## packages/sim

| File | What |
| --- | --- |
| `src/rng.ts` | counter-based RNG, streams, uniform / weighted draws |
| `src/map.ts` | map generation with the exact draw order, pocket fill, articulation-point DC placement |
| `src/connectivity.ts` | bottleneck snapshot: max spanning forest, R(n), B_best, top-10 links, compromised-DC links |
| `src/game.ts` | `createGame`, `applyOp`, `stepTic`, turn resolution, spawn/growth/spread, statuses, goals |
| `src/hash.ts` | FNV-1a state hash, format 6 |
| `src/verify.ts` | `preview` (cloned run, no spawns), `verifyLog`, `playLog` |
| `src/controller.ts` | pure input controller: select/cursor/drag/split modes → log ops |
| `src/product.ts` | practice-with-keys, replay storage, ranking rule, anomaly flags |
| `src/hints.ts`, `src/tutorials.ts` | hint triggers (browser-safe); Node tutorial loader; JSON in `tutorials/` |
| `src/browser.ts`, `src/index.ts` | browser entry; Node entry (adds the file loader) |
| `src/fuzz.ts` | stream-9 fuzz player for golden vectors and property tests |
| `src/mp.ts` | multiplayer engine: map for 2–8 players, owner-aware steps and combat, per-player economy and bugs, elimination, win rules, per-player frames |
| `src/mpbot.ts` | a simple multiplayer bot (tests) |
