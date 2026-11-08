// Multiplayer: queues (1v1, 2v2, FFA with force start), custom rooms with codes and teams, and live matches
// run authoritatively on the server at 2 tics per second. One WebSocket per player at /mp.
import { randomInt } from 'node:crypto';
import {
  createMpGame, mpApplyOp, mpFrame, mpStepTic, mpSurrender, mpScores, InvalidOpError,
  type MpMode, type MpOp, type MpState, type MpEvents,
} from '../../sim/src/index.ts';
import type { WsConn } from './ws.ts';

export type QueueMode = '1v1' | '2v2' | 'ffa';
export const QUEUE_SIZE: Record<QueueMode, number> = { '1v1': 2, '2v2': 4, ffa: 8 };
const ROOM_MAX = 8;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

interface Client {
  ws: WsConn;
  token: string;
  name: string;
  state: { kind: 'idle' } | { kind: 'queue'; mode: QueueMode; force: boolean; since: number } | { kind: 'room'; code: string } | { kind: 'match'; match: Match; seat: number };
  lastHeard: number;
  opWindow: { start: number; n: number };
}

interface Seat { token: string; name: string; team: number; client: Client | null; ack: number; leftAt: number | null }

interface Match {
  id: string;
  mode: MpMode;
  st: MpState;
  seats: Seat[];
  timer: ReturnType<typeof setInterval> | null;
  startAt: number;
  over: boolean;
  pendingEvents: MpEvents['eliminated'];
}

interface Room { code: string; host: Client; members: { client: Client; team: number }[] }

export interface MpServerOptions {
  player: (token: string) => { token: string; name: string } | undefined;
  ticMs?: number;
  countdownMs?: number;
  reconnectGraceMs?: number;
  now?: () => number;
}

export function createMpServer(opts: MpServerOptions) {
  const ticMs = opts.ticMs ?? 500;
  const countdownMs = opts.countdownMs ?? 3000;
  const graceMs = opts.reconnectGraceMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const clients = new Set<Client>();
  const queues: Record<QueueMode, Client[]> = { '1v1': [], '2v2': [], ffa: [] };
  const rooms = new Map<string, Room>();
  const matches = new Map<string, Match>();
  let lobbyTimer: ReturnType<typeof setTimeout> | null = null;
  const send = (c: Client | null | undefined, obj: unknown) => { if (c && !c.ws.closed) c.ws.sendJson(obj); };

  // ---------- lobby broadcast ----------

  function lobbyInfo() {
    return {
      type: 'lobby',
      queues: { '1v1': queues['1v1'].length, '2v2': queues['2v2'].length, ffa: queues.ffa.length },
      matches: [...matches.values()].filter((m) => !m.over).length,
      online: clients.size,
    };
  }
  function broadcastLobby(): void {
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      const info = lobbyInfo();
      for (const c of clients) if (c.state.kind === 'idle' || c.state.kind === 'queue') send(c, info);
    }, 200);
    lobbyTimer.unref?.();
  }

  // ---------- queues ----------

  function queueStatus(mode: QueueMode): void {
    const q = queues[mode];
    const votes = q.filter((c) => c.state.kind === 'queue' && c.state.force).length;
    for (const c of q) {
      send(c, {
        type: 'queue', mode, count: q.length, size: QUEUE_SIZE[mode],
        forceVotes: votes, forceNeeded: mode === 'ffa' ? Math.floor(q.length / 2) + 1 : null,
        you: { force: c.state.kind === 'queue' && c.state.force },
      });
    }
  }

  function leaveCurrent(c: Client): void {
    const s = c.state;
    if (s.kind === 'queue') {
      const q = queues[s.mode];
      const i = q.indexOf(c);
      if (i >= 0) q.splice(i, 1);
      c.state = { kind: 'idle' };
      queueStatus(s.mode);
    } else if (s.kind === 'room') {
      const room = rooms.get(s.code);
      c.state = { kind: 'idle' };
      if (room) {
        room.members = room.members.filter((m) => m.client !== c);
        if (!room.members.length) rooms.delete(room.code);
        else {
          if (room.host === c) room.host = room.members[0].client;
          roomUpdate(room);
        }
      }
    } else if (s.kind === 'match') {
      const seat = s.match.seats[s.seat];
      if (seat.client === c) seat.client = null;
      c.state = { kind: 'idle' };
      if (!s.match.over && s.match.st.players[s.seat].alive) {
        const ev = mpSurrender(s.match.st, s.seat);
        s.match.pendingEvents.push(...ev.eliminated);
        if (ev.finished) finishMatch(s.match);
      }
    }
    broadcastLobby();
  }

  function joinQueue(c: Client, mode: QueueMode): void {
    leaveCurrent(c);
    // One seat per player: drop any other connection of the same player from every queue.
    for (const m of Object.keys(queues) as QueueMode[]) for (const o of queues[m].slice()) if (o.token === c.token) leaveCurrent(o);
    c.state = { kind: 'queue', mode, force: false, since: now() };
    queues[mode].push(c);
    queueStatus(mode);
    tryStartQueue(mode);
    broadcastLobby();
  }

  function tryStartQueue(mode: QueueMode): void {
    const q = queues[mode];
    const size = QUEUE_SIZE[mode];
    let take = 0;
    if (q.length >= size) take = size;
    else if (mode === 'ffa' && q.length >= 2) {
      const votes = q.filter((c) => c.state.kind === 'queue' && c.state.force).length;
      if (votes * 2 > q.length) take = q.length;
    }
    if (!take) return;
    const group = q.splice(0, take);
    let teams: number[];
    if (mode === '2v2') {
      const order = shuffle([0, 1, 2, 3]);
      teams = [0, 0, 0, 0];
      order.forEach((seat, k) => { teams[seat] = k < 2 ? 0 : 1; });
    } else teams = group.map((_, i) => i);
    startMatch(mode, group, teams);
    queueStatus(mode);
  }

  // ---------- rooms ----------

  function newCode(): string {
    for (;;) {
      let s = '';
      for (let i = 0; i < 4; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(s)) return s;
    }
  }

  function roomUpdate(room: Room): void {
    const teams = new Set(room.members.map((m) => m.team));
    for (const m of room.members) {
      send(m.client, {
        type: 'room', code: room.code,
        players: room.members.map((x) => ({ name: x.client.name, team: x.team, host: x.client === room.host, you: x.client === m.client })),
        canStart: room.members.length >= 2 && teams.size >= 2,
        max: ROOM_MAX,
      });
    }
  }

  function createRoom(c: Client): void {
    leaveCurrent(c);
    const room: Room = { code: newCode(), host: c, members: [{ client: c, team: 1 }] };
    rooms.set(room.code, room);
    c.state = { kind: 'room', code: room.code };
    roomUpdate(room);
  }

  function joinRoom(c: Client, code: string): void {
    const room = rooms.get(String(code ?? '').toUpperCase().trim());
    if (!room) return send(c, { type: 'error', code: 'no_room', message: 'No room with that code. Check the code, or ask the host for a new link.' });
    if (room.members.some((m) => m.client === c)) return roomUpdate(room);
    if (room.members.length >= ROOM_MAX) return send(c, { type: 'error', code: 'room_full', message: 'That room is full (8 players).' });
    leaveCurrent(c);
    const used = new Set(room.members.map((m) => m.team));
    let team = 1;
    while (used.has(team) && team < ROOM_MAX) team++;
    room.members.push({ client: c, team });
    c.state = { kind: 'room', code: room.code };
    roomUpdate(room);
  }

  function setTeam(c: Client, team: number): void {
    if (c.state.kind !== 'room') return;
    const room = rooms.get(c.state.code);
    const m = room?.members.find((x) => x.client === c);
    if (!room || !m || !Number.isInteger(team) || team < 1 || team > ROOM_MAX) return;
    m.team = team;
    roomUpdate(room);
  }

  function startRoom(c: Client): void {
    if (c.state.kind !== 'room') return;
    const room = rooms.get(c.state.code);
    if (!room) return;
    if (room.host !== c) return send(c, { type: 'error', code: 'not_host', message: 'Only the host can start the game.' });
    if (room.members.length < 2 || new Set(room.members.map((m) => m.team)).size < 2) {
      return send(c, { type: 'error', code: 'need_players', message: 'You need at least two players on different teams.' });
    }
    rooms.delete(room.code);
    const ids = [...new Set(room.members.map((m) => m.team))];
    startMatch('custom', room.members.map((m) => m.client), room.members.map((m) => ids.indexOf(m.team)));
  }

  // ---------- matches ----------

  function startMatch(mode: MpMode, group: Client[], teams: number[]): void {
    const id = `${now().toString(36)}${randomInt(1 << 30).toString(36)}`;
    const st = createMpGame({ seed: randomInt(2 ** 32 - 1), mode, players: group.map((c, i) => ({ name: c.name, team: teams[i] })) });
    const match: Match = {
      id, mode, st, timer: null, startAt: now() + countdownMs, over: false, pendingEvents: [],
      seats: group.map((c, i) => ({ token: c.token, name: c.name, team: teams[i], client: c, ack: 0, leftAt: null })),
    };
    matches.set(id, match);
    group.forEach((c, i) => {
      c.state = { kind: 'match', match, seat: i };
      sendStart(match, i);
      send(c, mpFrame(st, i, 0));
    });
    const begin = setTimeout(() => {
      match.timer = setInterval(() => tick(match), ticMs);
      match.timer.unref?.();
    }, countdownMs);
    begin.unref?.();
    broadcastLobby();
  }

  function sendStart(match: Match, seat: number): void {
    const st = match.st;
    send(match.seats[seat].client, {
      type: 'matchStart', matchId: match.id, mode: match.mode, you: seat,
      width: st.width, height: st.height, turnLimit: st.turnLimit, bugs: st.bugs,
      players: match.seats.map((s) => ({ name: s.name, team: s.team })),
      startsIn: Math.max(0, match.startAt - now()),
    });
  }

  function tick(match: Match): void {
    if (match.over) return;
    const st = match.st;
    const t = now();
    // Seats gone longer than the grace period surrender.
    match.seats.forEach((s, i) => {
      if (!s.client && s.leftAt !== null && t - s.leftAt > graceMs && st.players[i].alive && !st.finished) {
        match.pendingEvents.push(...mpSurrender(st, i).eliminated);
      }
    });
    if (!st.finished) {
      const ev = mpStepTic(st);
      match.pendingEvents.push(...ev.eliminated);
    }
    const events = match.pendingEvents.splice(0);
    match.seats.forEach((s, i) => {
      const f = mpFrame(st, i, s.ack);
      if (s.client) send(s.client, { ...f, events });
    });
    if (st.finished) finishMatch(match);
  }

  function finishMatch(match: Match): void {
    if (match.over) return;
    match.over = true;
    if (match.timer) clearInterval(match.timer);
    const st = match.st;
    const scores = mpScores(st);
    const events = match.pendingEvents.splice(0);
    match.seats.forEach((s, i) => {
      if (!s.client) return;
      send(s.client, { ...mpFrame(st, i, s.ack), events });
      send(s.client, {
        type: 'over', winners: st.winners ?? [], reason: st.endReason, turn: Math.min(st.turn, st.turnLimit),
        standings: st.players.map((P, k) => ({ seat: k, name: P.name, team: P.team, army: scores[k].army, land: scores[k].land, alive: P.alive, eliminatedTurn: P.eliminatedTurn, eliminatedBy: P.eliminatedBy, surrendered: P.surrendered })),
      });
      s.client.state = { kind: 'idle' };
    });
    setTimeout(() => matches.delete(match.id), 60_000).unref?.();
    broadcastLobby();
  }

  function op(c: Client, msg: { seq?: unknown; op?: unknown }): void {
    if (c.state.kind !== 'match') return;
    const { match, seat } = c.state;
    const s = match.seats[seat];
    const t = now();
    if (t - c.opWindow.start > 1000) c.opWindow = { start: t, n: 0 };
    if (++c.opWindow.n > 60) return; // flood guard
    const seq = Number(msg.seq);
    if (Number.isInteger(seq) && seq > s.ack) s.ack = seq;
    if (match.over) return;
    try {
      mpApplyOp(match.st, seat, msg.op as MpOp);
    } catch (e) {
      if (!(e instanceof InvalidOpError) && !(e instanceof TypeError)) throw e;
    }
  }

  // ---------- connections ----------

  function accept(ws: WsConn): void {
    let client: Client | null = null;
    const helloTimer = setTimeout(() => { if (!client) ws.close(1008, 'hello timeout'); }, 5000);
    helloTimer.unref?.();
    const silence = setInterval(() => { if (client && now() - client.lastHeard > 60_000) ws.close(1001, 'silent'); }, 15_000);
    silence.unref?.();
    ws.onClose = () => {
      clearTimeout(helloTimer);
      clearInterval(silence);
      if (!client) return;
      clients.delete(client);
      const s = client.state;
      if (s.kind === 'match') {
        const seat = s.match.seats[s.seat];
        if (seat.client === client) { seat.client = null; seat.leftAt = now(); }
      } else leaveCurrent(client);
      broadcastLobby();
    };
    ws.onMessage = (text) => {
      let msg: any;
      try { msg = JSON.parse(text); } catch { return; }
      if (client) client.lastHeard = now();
      if (!client) {
        if (msg?.type !== 'hello') { ws.sendJson({ type: 'error', code: 'bad_token', message: 'Send hello first.' }); ws.close(1008); return; }
        const p = opts.player(String(msg.token ?? ''));
        if (!p) { ws.sendJson({ type: 'error', code: 'bad_token', message: 'Unknown player. Reload the page.' }); ws.close(1008); return; }
        client = { ws, token: p.token, name: p.name, state: { kind: 'idle' }, lastHeard: now(), opWindow: { start: 0, n: 0 } };
        clients.add(client);
        send(client, { type: 'welcome', name: p.name });
        // Rejoin a running match this player is seated in (reload, dropped connection).
        for (const m of matches.values()) {
          if (m.over) continue;
          const i = m.seats.findIndex((s) => s.token === p.token);
          if (i < 0 || !m.st.players[i].alive) continue;
          const old = m.seats[i].client;
          if (old && old !== client) { old.state = { kind: 'idle' }; old.ws.close(1000, 'replaced'); }
          m.seats[i].client = client;
          m.seats[i].leftAt = null;
          client.state = { kind: 'match', match: m, seat: i };
          sendStart(m, i);
          send(client, mpFrame(m.st, i, m.seats[i].ack));
          return;
        }
        send(client, lobbyInfo());
        return;
      }
      const c = client;
      switch (msg?.type) {
        case 'ping': send(c, { type: 'pong' }); break;
        case 'queue': if (msg.mode in QUEUE_SIZE) joinQueue(c, msg.mode); break;
        case 'leaveQueue': if (c.state.kind === 'queue') leaveCurrent(c); send(c, lobbyInfo()); break;
        case 'force':
          if (c.state.kind === 'queue') { c.state.force = !!msg.on; queueStatus(c.state.mode); tryStartQueue(c.state.mode); }
          break;
        case 'createRoom': createRoom(c); break;
        case 'joinRoom': joinRoom(c, msg.code); break;
        case 'leaveRoom': if (c.state.kind === 'room') leaveCurrent(c); send(c, lobbyInfo()); break;
        case 'setTeam': setTeam(c, Number(msg.team)); break;
        case 'startRoom': startRoom(c); break;
        case 'op': op(c, msg); break;
        case 'surrender':
          if (c.state.kind === 'match' && !c.state.match.over) {
            const m = c.state.match;
            const ev = mpSurrender(m.st, c.state.seat);
            m.pendingEvents.push(...ev.eliminated);
            if (ev.finished) finishMatch(m);
          }
          break;
        case 'leaveMatch': if (c.state.kind === 'match') leaveCurrent(c); send(c, lobbyInfo()); break;
        default: break;
      }
    };
  }

  return {
    accept,
    stats: () => ({ clients: clients.size, rooms: rooms.size, matches: matches.size, queues: { '1v1': queues['1v1'].length, '2v2': queues['2v2'].length, ffa: queues.ffa.length } }),
    close: () => { for (const m of matches.values()) if (m.timer) clearInterval(m.timer); },
  };
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
