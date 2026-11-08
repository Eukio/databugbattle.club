# Decisions — gaps in design doc rev 6, resolved in code

Each item names the doc ambiguity, the choice made, and where it lives. Numbering matches the review. Items 13 onward
came with the client and server.

## Sim rules

**1. `Paused` in the state hash is always 0; key-wait pauses are not ops.**
The hash is taken after step 11 and the sim never advances while paused, so the field can only be 1 if a
ranked run is auto-finished by the server with a pause still open. It stays in the encoding (hash format 6)
so the server and client agree even then. A pause while waiting for a bug key is a client-side stall only:
it is never written to the log and never touches `paused`. — `src/hash.ts`, `src/game.ts` (`applyOp`), `src/controller.ts`
(`pause()` is the only thing that logs a pause).

**2. A DC compromised at step 10 hashes `Protected = 0` that turn.** It had no status in snapshot A, so
`freeze()` writes 0 and the decrement counter starts at 0 as the doc says. — `src/game.ts` `freeze()`.

**3. `B_corridor(c, j)`** in the cure-to-protect formula is the best forest bottleneck from any owned,
non-frozen neighbour of c to a healthy DC, *without* the `min(p_c, …)` cap (the cap is applied by the formula
itself). — `src/game.ts` `cureToProtect()`.

**4. A pool with no eligible candidate spawns nothing** (all DCs frozen; or no land cell at or below the rolled
level). The trial and level draws still happen, so slot usage is identical either way. — `spawnRandom()`.

**5. Snapshot step 4 simplified.** Pairwise `B(i, j)` (one forest traversal per healthy DC) already yields
`R(n) = max_j B(n, j)` and a DC's `B_best = max_{j≠i} B(i, j)`, so there is no separate best/second-best
pass. Same results, less code. — `src/connectivity.ts`.

**5a. Ops are validated before any mutation.** An invalid `step` leaves no empty path behind (the doc
requires the whole log be rejected, so a half-applied op must not exist). `intent` in the op must match the
target's frozen state at queue time; a mismatch is an invalid op. — `applyOp`.

**5b. Keys are required at tic 2 of every ranked turn**, not only at step 10: step 8's spread tie-breaks also
read the turn key. `stepTic` throws `MissingKeyError` before changing anything; `preview` runs with spawn and
spread off and never needs a key. — `stepTic`.

**5c. Failure order and the "short attack / partial cure" end.** All failure checks run before the source is
debited (nothing is lost on a failed step). A short attack or partial cure is a step that *executed* — the
power is destroyed — and then ends the path with `current = source`, so the cursor jump lands on the cell the
power came from. — `executeStep`.

**5d. Freeze ends the head path immediately.** When a bug spawns or spreads onto the cell holding the head
path's travelling stack, the stack merges and the path ends at step 8/10 (cause `frozen`), so the queue, the
preview and the hash agree before the next tic. — `freeze()`.

## Input edges

**6. Drag over a refused cell stops the drag's queuing.** The refused step shakes the cursor; further pointer
motion in that gesture is ignored until pointer-up. Gap fill is the straight 4-directional line, horizontal
first. A drag only starts from an owned cell; a press that never leaves its cell is a click. — `controller.ts`
`pointerMove`.

**7. After Space the cursor stays but direction keys do nothing** until a new selection, or a click next to the
cursor (which re-engages the keyboard from there). The table wins over the paragraph. — `step()`.

**8. Clicking the cursor cell when it is not the selected cell selects it** (new path from mid-corridor).
Clicking the selected cell while the cursor is on it toggles Half, as specified. Adjacent-to-cursor clicks
always win. — `click()`.

**9. Keep N keys:** `=`/`+` and `-`/`_` (`Equal`, `Minus`, numpad add/subtract), active only in Keep mode;
N starts at S(t) when the mode is picked and clamps to 1–999. — `key()`.

**9a. Half-next applies to exactly one new path** and clears when that path starts.

## Product semantics

**10. "Practice this seed" on a past daily replays the real day** — same map seed *and* the published bug
keys — so a practice score is comparable with that day's board. A typed or random practice seed uses the plain
seed for every stream. `createGame({ mapSeed, bugKeys, kind: 'practice' })` is the new config variant;
pauses stay free. — `src/product.ts` `practiceConfig`.

**11. Practice replays.** Every practice run's log is stored as `dcg.last.<seed>`; the personal-best run's log
as `dcg.pblog.<seed>` beside `dcg.pb.<seed>`. "Watch my replay" plays the last run; the best run's replay is
kept until beaten (ties don't replace). Retry never erases a best. — `recordPracticeRun`.

**12. Only `finished` runs rank.** An abandoned run gets a verified score (shown privately on the Daily
screen) but no rank; the day still counts as played. — `isRankable`, `LEADERBOARD_SQL`.

**12a. Ranked pause budget is enforced in the sim**: a 4th `pause` op is invalid on ranked, so the client and
the server's re-sim can't disagree. Practice and tutorials don't count pauses.

**12b. Anomaly window is symmetric.** "Within one tic of the bug becoming curable" counts a cure as fast when
|queued − curable| ≤ 1. A cure queued well before the window (while the bug is still immune) is planning, not a
reaction. — `anomalyFlags`.

## Tooling

**Fuzz player slots (stream 9, turn = global tic g):** 0 act? (1/2) · 1 new-vs-extend (3/10 new) · 2 origin
among owned cells · 3 mode · 4 direction · 5 clear? (1/50) · 6 remove? (1/100) · 7 which path. Keep N uses
S(t). — `src/fuzz.ts`. Golden vectors: `golden/seed-01..20.json`.

**Tests run with `node --test`** (Node 22 strips types natively; no install needed), so `vitest` from the doc
is a drop-in later. `erasableSyntaxOnly` is on so the sources stay runnable without a build.

## Client

**13. Tutorial hints sit in a strip above the board,** not over it, and the last one stays visible (dimmed) as a
reminder. The game waits while a hint is open, but input keeps working, so a player can finish steering a path
before pressing Continue (or Enter). Hint `turn:N` fires before tic 1 of turn N. — `ui/screens/game.ts`.

**14. Hidden tab: stall first, pause a moment later.** On `visibilitychange` the sim stalls at once (client-side,
nothing logged); if the tab is still hidden 400 ms later the auto-pause op is applied. A reload or closed tab
therefore never spends a ranked pause. After the third pause, hiding neither pauses nor stalls. — `onVisibility`.

**15. Crash recovery resumes paused, board hidden, without a pause.** The run is rebuilt from the local backup
(log + tics executed + keys, saved after every op and tic), or from the server's copy at the start of the last
turn it saw. The Resume button runs the 3-second countdown and also closes a pause that was open when the page
went away. — `app.ts` `resumeRanked`, `game.ts`.

**16. Practice pauses dim the board; ranked pauses hide it** and the queue and cell panels, with a 10-minute
countdown. Practice and tutorials resume at once; ranked resumes through the 3-second countdown.

**17. Board scaling.** 32 px default, fit to the window between 24 and 40 px (64 px for small tutorial maps);
below 640 px of window width the minimum drops to 12 px so the board still fits a phone (mobile stays out of
scope; taps and drags work, there is no keyboard). — `render/board.ts`.

**18. Status display uses a live snapshot** of the current state (what next turn's snapshot A will see), so
outlines react to queued moves as they execute. The sim's protection flag for this turn is unchanged.

**19. Per-bug cost estimate** (results screen): decrements are a frozen cell's power drop between turn ends;
lost production is the DC's rate when hit, per unprotected turn; missed land income uses the doc's cut-off
attribution against snapshot A; children's costs roll up. "Paid" compares cure power with the loss rate × turns
left. Labelled as an estimate. — `tracker.ts`.

**20. Replay slider ends after turn 300 resolves** (position 301), so the last frame shows the final score.

**21. Offline mode.** Without a reachable server (or in the single-file build) Daily becomes an unranked run on
a date-derived seed, shared by everyone offline; Leaderboard is disabled. — `app.ts` `offlineDailySeed`.

## Server

**22. Node built-ins instead of Fastify / ws / better-sqlite3.** `node:http`, `node:crypto`, `node:sqlite` (WAL)
and a ~150-line WebSocket (`ws.ts`) implement the same endpoints and protocol, so the server runs with no install.
Swapping in the doc's libraries later changes no behaviour. The client is bundled with esbuild rather than Vite
for the same reason; the file layout follows the doc.

**23. `runs.updated`** (ms of the run's last message) is added to the doc's schema: the abandonment sweep needs
"silent for 30 minutes" and "paused for more than 10" (a run whose last pause/resume op is a pause).

**24. Two small endpoints:** `GET /health` (lets the client detect a server) and `GET /daily/:date/keys`
(map seed and all 300 bug keys of an ended day, for "Practice this seed"). `GET /runs/:id` of your own active
run returns only the keys already handed out.

**25. Turn messages** may repeat the last turn (used to flush a pause and after a reconnect) and may run at most
3 turns ahead of the last one seen; ops must be in tic order and no earlier than 2(t − 2). The client sends ops
with a wall-clock `ts` (ignored by the sim) for the fast-gesture flag.

## Multiplayer

**26. Scope.** Queues for 1v1 (2 players), 2v2 (4, random teams) and FFA (up to 8; starts full, or early when a
strict majority of at least 2 queued players vote Force start), plus custom rooms (4-letter code, invite link,
teams 1–8, host starts with ≥ 2 players on ≥ 2 teams). No ratings or match history yet.

**27. Same rules per network.** Each player's own cells are run through the single-player connectivity,
protection, production, land income and both bug pools (with the same caps and weights), so a resilient
network is an edge over opponents. Bugs only live on owned cells; spread stays inside the owner's land.

**28. Combat like generals.io.** Attacking an enemy (or neutral DC, or abandoned land) cell: arriving minus its
power; more than 0 captures it and the path carries on with the rest; otherwise it is chipped and the path ends
(as a single-player short attack). Defence is the cell's full power, travelling stacks included (their paths end
first). A frozen enemy cell can be captured; its bug comes with it. Players move in an order that rotates every tic.

**29. Hybrid win.** Capturing an HQ eliminates its owner: their paths end and their cells go to the captor at
half power (rounded up). Surrender, leaving, or 30 s disconnected turns the player's cells neutral (DCs become
neutral DCs costing their power; land keeps its power as a defence). Last team standing wins; at the turn limit
(300 in 1v1, 400 otherwise) the team with the most total power wins, ties share the win.

**30. Maps.** 20×20 for 2 players, 24 for 3–4, 28 for 5–6, 32 for 7–8. ~22% mountains, pocket fill, spawns by
farthest walking distance (re-placing the random first one), DCs costing 12–24 kept 3+ steps from spawns, and every
spawn with at least 2 DCs within 8 steps. Teammates take nearby spawns. In 60 bot 1v1s seats won 32/25 (3 draws).

**31. Server authority, client prediction.** Clients send queue ops only. Every tic the server sends each player
a frame with their team's vision (mountains and DCs show as obstacles in fog; enemy HQs are hidden until seen),
their own queue, ended paths, an op acknowledgement and everyone's power and cell counts. The client rebuilds a
local single-player view from the frame (enemy cells become neutral DCs costing their power, so the preview's
capture math is the server's), replays unacknowledged ops on it, and runs the same input controller. Eliminated
players and finished matches see the whole map.
