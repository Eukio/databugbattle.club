// Multiplayer server tests: queues, force start, rooms and teams, live frames and ops, reconnect, surrender, time win.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { MPK } from '../../sim/src/index.ts';

const app = createApp({ dbPath: ':memory:', clientDir: null, rateLimits: false, mp: { ticMs: 4, countdownMs: 30, reconnectGraceMs: 300 } });
let base = '';
before(async () => {
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => { await app.close(); });

async function token(name: string): Promise<string> {
  const r = await fetch(`http://${base}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  return (await r.json()).token;
}

/** A client that keeps the latest frame and lets tests wait for message types. */
async function client(name: string, tok?: string) {
  const t = tok ?? await token(name);
  const ws = new WebSocket(`ws://${base}/mp`);
  const msgs: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  let lastFrame: any = null;
  let start: any = null;
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'frame') lastFrame = m;
    if (m.type === 'matchStart') start = m;
    msgs.push(m);
    for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  };
  await new Promise<void>((r) => { ws.onopen = () => r(); });
  ws.send(JSON.stringify({ type: 'hello', token: t }));
  const c = {
    token: t,
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    wait: (pred: (m: any) => boolean, ms = 8000) => new Promise<any>((resolve, reject) => {
      const hit = msgs.find(pred);
      if (hit) { msgs.splice(msgs.indexOf(hit), 1); resolve(hit); return; }
      const w = { pred, resolve: (m: any) => { clearTimeout(timer); msgs.splice(msgs.indexOf(m), 1); resolve(m); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`${name}: timed out waiting`)); }, ms);
      waiters.push(w);
    }),
    type: (ty: string, ms?: number) => c.wait((m) => m.type === ty, ms),
    frame: () => lastFrame,
    start: () => start,
    close: () => ws.close(),
  };
  await c.type('welcome');
  return c;
}

test('1v1 queue matches two players; frames are fogged per player; ops are acked and queued', async () => {
  const a = await client('Alice');
  const b = await client('Bob');
  a.send({ type: 'queue', mode: '1v1' });
  const qs = await a.type('queue');
  assert.equal(qs.count, 1);
  assert.equal(qs.size, 2);
  b.send({ type: 'queue', mode: '1v1' });
  const [sa, sb] = await Promise.all([a.type('matchStart'), b.type('matchStart')]);
  assert.equal(sa.matchId, sb.matchId);
  assert.deepEqual([sa.you, sb.you].sort(), [0, 1]);
  assert.equal(sa.width, 20);
  assert.equal(sa.turnLimit, 300);
  const f = await a.wait((m) => m.type === 'frame' && m.turn >= 2);
  // Alice sees her HQ, and nothing of Bob (spawns are far apart).
  const hq = f.hqs.find((h: number[]) => h[1] === sa.you);
  assert.ok(hq, 'own HQ visible');
  assert.ok(!f.hqs.some((h: number[]) => h[1] !== sa.you), 'enemy HQ hidden in fog');
  assert.ok(f.k.some((k: number) => k === MPK.FOG) && f.k.some((k: number) => k === MPK.FOG_OBSTACLE));
  // Queue a step from the HQ into open land.
  const W = sa.width;
  const cell = hq[0];
  const dir = (['U', 'D', 'L', 'R'] as const).find((d) => {
    const t = d === 'U' ? cell - W : d === 'D' ? cell + W : d === 'L' ? cell - 1 : cell + 1;
    const r = Math.floor(cell / W), c = cell % W;
    const ok = (d === 'U' && r > 0) || (d === 'D' && r < W - 1) || (d === 'L' && c > 0) || (d === 'R' && c < W - 1);
    return ok && f.k[t] === MPK.LAND;
  })!;
  a.send({ type: 'op', seq: 1, op: { op: 'step', path: 'new', from: cell, dir, intent: 'move', mode: 'half' } });
  const g = await a.wait((m) => m.type === 'frame' && m.ack === 1);
  assert.ok(g.queue.length === 1 || g.ended.length >= 1, 'path queued (or already ran)');
  // Bob surrenders: Alice wins by elimination.
  b.send({ type: 'surrender' });
  const [oa, ob] = await Promise.all([a.type('over'), b.type('over')]);
  assert.equal(oa.reason, 'elimination');
  assert.deepEqual(oa.winners, [sa.you]);
  assert.deepEqual(ob.winners, [sa.you]);
  assert.equal(oa.standings.find((s: any) => s.seat === sb.you).surrendered, true);
  a.close(); b.close();
});

test('FFA starts early when a majority votes force start', async () => {
  const cs = await Promise.all(['F1', 'F2', 'F3'].map((n) => client(n)));
  for (const c of cs) c.send({ type: 'queue', mode: 'ffa' });
  await cs[2].wait((m) => m.type === 'queue' && m.count === 3);
  cs[0].send({ type: 'force', on: true });
  const one = await cs[1].wait((m) => m.type === 'queue' && m.forceVotes === 1);
  assert.equal(one.forceNeeded, 2);
  cs[1].send({ type: 'force', on: true });
  const starts = await Promise.all(cs.map((c) => c.type('matchStart')));
  assert.equal(starts[0].players.length, 3);
  assert.equal(new Set(starts.map((s) => s.you)).size, 3);
  assert.equal(starts[0].width, 24);
  for (const c of cs) c.send({ type: 'leaveMatch' });
  await cs[0].type('over').catch(() => null); // the last one standing wins once two leave
  for (const c of cs) c.close();
});

test('2v2 queue makes two teams of two', async () => {
  const cs = await Promise.all(['T1', 'T2', 'T3', 'T4'].map((n) => client(n)));
  for (const c of cs) c.send({ type: 'queue', mode: '2v2' });
  const s = await Promise.all(cs.map((c) => c.type('matchStart')));
  const teams = s[0].players.map((p: any) => p.team).sort();
  assert.deepEqual(teams, [0, 0, 1, 1]);
  // Teammates share vision: each sees their ally's HQ.
  const f = await cs[0].wait((m) => m.type === 'frame' && m.turn >= 2);
  const me = s[0].you;
  const ally = s[0].players.findIndex((p: any, i: number) => i !== me && p.team === s[0].players[me].team);
  assert.ok(f.hqs.some((h: number[]) => h[1] === ally), 'ally HQ visible');
  // A whole team surrenders: the other team wins.
  const enemyTeam = s[0].players[me].team === 0 ? 1 : 0;
  s.forEach((st, k) => { if (st.players[st.you].team === enemyTeam) cs[k].send({ type: 'surrender' }); });
  const over = await cs[0].type('over');
  assert.equal(over.reason, 'elimination');
  assert.equal(over.winners.length, 2);
  for (const w of over.winners) assert.equal(s[0].players[w].team, s[0].players[me].team);
  for (const c of cs) c.close();
});

test('custom rooms: code, teams, host-only start, need two teams', async () => {
  const host = await client('Host');
  const guest = await client('Guest');
  host.send({ type: 'createRoom' });
  const r1 = await host.type('room');
  assert.match(r1.code, /^[A-Z]{4}$/);
  guest.send({ type: 'joinRoom', code: r1.code.toLowerCase() });
  const r2 = await guest.type('room');
  assert.equal(r2.players.length, 2);
  assert.equal(r2.canStart, true);
  guest.send({ type: 'setTeam', team: 1 });
  const r3 = await guest.wait((m) => m.type === 'room' && m.players.every((p: any) => p.team === 1));
  assert.equal(r3.canStart, false);
  guest.send({ type: 'startRoom' });
  assert.equal((await guest.type('error')).code, 'not_host');
  host.send({ type: 'startRoom' });
  assert.equal((await host.type('error')).code, 'need_players');
  guest.send({ type: 'setTeam', team: 2 });
  await host.wait((m) => m.type === 'room' && m.canStart);
  const bad = await client('Nobody');
  bad.send({ type: 'joinRoom', code: 'ZZZZ' });
  assert.equal((await bad.type('error')).code, 'no_room');
  host.send({ type: 'startRoom' });
  const [a, b] = await Promise.all([host.type('matchStart'), guest.type('matchStart')]);
  assert.equal(a.mode, 'custom');
  assert.notEqual(a.players[0].team, a.players[1].team);
  void b;
  // Reconnect: the guest drops and comes back with the same token, and is seated again.
  guest.close();
  await new Promise((r) => setTimeout(r, 50));
  const again = await client('Guest', guest.token);
  const s2 = await again.type('matchStart');
  assert.equal(s2.matchId, a.matchId);
  await again.wait((m) => m.type === 'frame');
  host.send({ type: 'leaveMatch' });
  const over = await again.type('over');
  assert.deepEqual(over.winners, [s2.you]);
  host.close(); again.close(); bad.close();
});

test('a player who stays away past the grace period is surrendered', async () => {
  const a = await client('Stayer');
  const b = await client('Leaver');
  a.send({ type: 'queue', mode: '1v1' });
  b.send({ type: 'queue', mode: '1v1' });
  const sa = await a.type('matchStart');
  await b.type('matchStart');
  b.close();
  const over = await a.type('over', 5000);
  assert.deepEqual(over.winners, [sa.you]);
  a.close();
});

test('an untouched 1v1 runs to the turn limit and ends on time', async () => {
  const a = await client('Idle1');
  const b = await client('Idle2');
  a.send({ type: 'queue', mode: '1v1' });
  b.send({ type: 'queue', mode: '1v1' });
  await a.type('matchStart');
  const over = await a.type('over', 20000);
  assert.equal(over.reason, 'time');
  assert.equal(over.turn, 300);
  assert.ok(over.winners.length >= 1);
  const final = a.frame();
  assert.ok(final.k.every((k: number) => k !== MPK.FOG), 'everything is revealed at the end');
  a.close(); b.close();
});
