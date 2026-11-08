// Integration tests: a real server on a random port, an in-memory database and a fake clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { createGame, applyOp, stepTic, setBugKey, totalPower, InvalidOpError, type LogOp, type GameState } from '../../sim/src/index.ts';
import { fuzzOps } from '../../sim/src/fuzz.ts';

let clock = Date.UTC(2026, 10, 8, 12, 0, 0);
const app = createApp({ dbPath: ':memory:', clientDir: null, now: () => clock, rateLimits: false });
let base = '';
const day = () => new Date(clock).toISOString().slice(0, 10);

before(async () => {
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => { await app.close(); });

async function http(method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(`http://${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

async function session(name: string): Promise<string> {
  const r = await http('POST', '/session', undefined, { name });
  assert.equal(r.status, 200);
  return r.json.token;
}

/** A JSON socket with a message queue. */
async function socket() {
  const ws = new WebSocket(`ws://${base}/ranked`);
  const inbox: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  let closed = false;
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    const w = waiters.shift();
    if (w) w(m); else inbox.push(m);
  };
  ws.onclose = () => { closed = true; for (const w of waiters.splice(0)) w({ type: 'closed' }); };
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('ws error')); });
  return {
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    next: () => new Promise<any>((r) => { if (inbox.length) r(inbox.shift()); else if (closed) r({ type: 'closed' }); else waiters.push(r); }),
    close: () => ws.close(),
  };
}

/** Plays a ranked run over the socket like the client does: a turn message at the start of every turn. */
async function playRanked(token: string, fuzzSeed: number, opts: { stopAfterTurn?: number } = {}) {
  const s = await socket();
  s.send({ type: 'hello', token, date: day() });
  const start = await s.next();
  assert.equal(start.type, 'start', JSON.stringify(start));
  const st: GameState = createGame({ mapSeed: start.mapSeed, kind: 'ranked' });
  for (const [t, k] of Object.entries(start.keys)) setBugKey(st, Number(t), k as number);
  const log: LogOp[] = [];
  let pending: LogOp[] = [];
  let ts = 1_000_000;
  while (!st.finished) {
    if (st.tic === 0) {
      if (opts.stopAfterTurn && st.turn > opts.stopAfterTurn) break;
      s.send({ type: 'turn', turn: st.turn, ops: pending });
      pending = [];
      if (st.turn + 2 <= 300) {
        const k = await s.next();
        assert.equal(k.type, 'key');
        assert.equal(k.turn, st.turn + 2);
        setBugKey(st, k.turn, k.key);
      }
    }
    for (const op of fuzzOps(st, fuzzSeed)) {
      try { applyOp(st, op); } catch (e) { if (e instanceof InvalidOpError) continue; throw e; }
      op.ts = (ts += 400);
      log.push(op);
      pending.push(op);
    }
    stepTic(st);
  }
  return { s, st, log, pending, start };
}

test('health, sessions, names and auth', async () => {
  assert.deepEqual((await http('GET', '/health')).json.game, 'dcg');
  assert.equal((await http('POST', '/session', undefined, { name: 'x' })).status, 400);
  assert.equal((await http('POST', '/session', undefined, { name: 'bad<name>' })).status, 400);
  const tok = await session('Ada Lovelace');
  assert.equal((await http('PATCH', '/session', tok, { name: 'Ada_L' })).json.name, 'Ada_L');
  assert.equal((await http('GET', '/daily', 'nope')).status, 401);
  const d = await http('GET', '/daily', tok);
  assert.deepEqual(d.json, { date: day(), played: false });
});

let finishedRunId = 0;
let finishedScore = 0;
let firstToken = '';

test('a full ranked run verifies on the server with the same score and hash', async () => {
  firstToken = await session('Grace');
  const { s, st, pending } = await playRanked(firstToken, 7);
  const clientScore = totalPower(st);
  s.send({ type: 'finish', ops: pending, clientScore, clientHash: st.hashes[299] });
  const res = await s.next();
  assert.equal(res.type, 'result', JSON.stringify(res));
  assert.equal(res.verifiedScore, clientScore);
  assert.equal(res.rank, 1);
  assert.equal(res.flagged, false);
  const daily = await http('GET', '/daily', firstToken);
  assert.equal(daily.json.played, true);
  assert.equal(daily.json.status, 'finished');
  assert.equal(daily.json.score, clientScore);
  finishedRunId = daily.json.runId;
  finishedScore = clientScore;
  const board = await http('GET', `/leaderboard/${day()}`, firstToken);
  assert.equal(board.json.entries[0].name, 'Grace');
  assert.deepEqual(board.json.me, { rank: 1, score: clientScore });
});

test('one attempt per day; late ops are rejected', async () => {
  const s = await socket();
  s.send({ type: 'hello', token: firstToken, date: day() });
  assert.equal((await s.next()).code, 'already_played');
  const tok = await session('Late');
  const s2 = await socket();
  s2.send({ type: 'hello', token: tok, date: day() });
  assert.equal((await s2.next()).type, 'start');
  s2.send({ type: 'turn', turn: 3, ops: [{ g: 0, op: 'clear' }] });
  assert.equal((await s2.next()).code, 'late_op');
  const s3 = await socket();
  s3.send({ type: 'hello', token: tok, date: '2001-01-01' });
  assert.equal((await s3.next()).code, 'not_today');
});

test('replays are private until the day ends, except your own', async () => {
  const other = await session('Other');
  assert.equal((await http('GET', `/runs/${finishedRunId}`, other)).status, 403);
  const own = await http('GET', `/runs/${finishedRunId}`, firstToken);
  assert.equal(own.status, 200);
  assert.equal(own.json.bugKeys.length, 300);
  assert.equal((await http('GET', `/daily/${day()}/keys`, other)).status, 403);
});

test('resume after a dropped socket returns op count, last turn and keys', async () => {
  const tok = await session('Dropper');
  const { s, log, pending, start } = await playRanked(tok, 11, { stopAfterTurn: 20 });
  // Flush the last ops, then drop.
  s.send({ type: 'turn', turn: 20, ops: pending });
  await s.next();
  s.close();
  await new Promise((r) => setTimeout(r, 50));
  const s2 = await socket();
  s2.send({ type: 'hello', token: tok, date: day(), resumeRunId: start.runId });
  const m = await s2.next();
  assert.equal(m.type, 'resumed', JSON.stringify(m));
  assert.equal(m.opCount, log.length);
  assert.equal(m.lastTurn, 20);
  assert.ok(m.keys['22'] !== undefined && m.keys['23'] === undefined);
  s2.close();
});

test('a run paused for more than 10 minutes is abandoned with a verified score, unranked', async () => {
  const tok = await session('Sleeper');
  const { s, pending, start } = await playRanked(tok, 5, { stopAfterTurn: 40 });
  s.send({ type: 'turn', turn: 41, ops: [...pending, { g: 2 * 40, op: 'pause', gid: 99999 }] });
  assert.equal((await s.next()).type, 'key');
  assert.equal(app.sweep(), 0);
  clock += 11 * 60_000;
  assert.equal(app.sweep(), 1);
  const err = await s.next();
  assert.equal(err.code, 'abandoned');
  const d = await http('GET', '/daily', tok);
  assert.equal(d.json.status, 'abandoned');
  assert.ok(Number.isInteger(d.json.score));
  const board = await http('GET', `/leaderboard/${day()}`, tok);
  assert.ok(!board.json.entries.some((e: { runId: number }) => e.runId === start.runId), 'abandoned runs do not rank');
  assert.deepEqual(board.json.me, { rank: null, score: d.json.score });
});

test('after the day ends: history, published keys and replays unlock', async () => {
  const played = day();
  clock += 24 * 3600_000;
  const tok = await session('Tomorrow');
  const hist = await http('GET', '/daily/history', tok);
  const row = hist.json.find((h: { date: string }) => h.date === played);
  assert.ok(row, 'yesterday is listed');
  assert.equal(row.players, 1);
  const keys = await http('GET', `/daily/${played}/keys`, tok);
  assert.equal(keys.status, 200);
  assert.equal(keys.json.mapSeed, row.mapSeed);
  const run = await http('GET', `/runs/${finishedRunId}`, tok);
  assert.equal(run.status, 200);
  assert.deepEqual(run.json.bugKeys, keys.json.bugKeys);
  assert.equal(run.json.score, finishedScore);
  // The published log and keys reproduce the verified score (what "Watch replays" plays).
  const st = createGame({ mapSeed: run.json.mapSeed, bugKeys: run.json.bugKeys, kind: 'ranked' });
  let i = 0;
  while (!st.finished) {
    while (i < run.json.log.length && run.json.log[i].g <= 2 * (st.turn - 1) + st.tic) applyOp(st, run.json.log[i++]);
    stepTic(st);
  }
  assert.equal(totalPower(st), finishedScore);
});
