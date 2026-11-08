// HTTP endpoints, the ranked WebSocket, static client files and the abandonment job (doc §Technology).
// Built on Node built-ins only (http, crypto, node:sqlite and a small WebSocket), so it runs without installs.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import type { LogOp } from '../../sim/src/index.ts';
import { openDb, dailySecret, rankOf, type Db, type RunRow } from './db.ts';
import { newSecret, mapSeedFor, bugKeyFor, allBugKeys, utcDate } from './daily.ts';
import { WsConn } from './ws.ts';
import { verifyRanked } from './verify.ts';
import { createMpServer, type MpServerOptions } from './mp.ts';

export interface AppOptions {
  dbPath: string;
  clientDir?: string | null;
  now?: () => number;
  /** Rate limits can be relaxed in tests. */
  rateLimits?: boolean;
  /** Multiplayer pacing (tests run faster). */
  mp?: Partial<Omit<MpServerOptions, 'player'>>;
}

const NAME_RE = /^[A-Za-z0-9 _-]{2,16}$/;
const MIN = 60_000;
const SILENT_LIMIT = 30 * MIN;
const PAUSE_LIMIT = 10 * MIN;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Fixed-window counters (doc §Tooling and operations). */
class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private readonly now: () => number;
  constructor(now: () => number) { this.now = now; }
  take(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t >= h.reset) { this.hits.set(key, { n: 1, reset: t + windowMs }); return true; }
    h.n++;
    return h.n <= limit;
  }
}

export function createApp(opts: AppOptions) {
  const now = opts.now ?? Date.now;
  const today = () => utcDate(now());
  const d: Db = openDb(opts.dbPath);
  const limiter = new RateLimiter(now);
  const limits = opts.rateLimits ?? true;
  const live = new Map<number, WsConn>(); // runId → open socket

  const secretFor = (date: string) => dailySecret(d, date, now(), newSecret);
  const player = (token: string | undefined) => (token ? (d.q.getPlayer.get(token) as { token: string; name: string } | undefined) : undefined);
  const mp = createMpServer({ player, ...opts.mp });

  // ---------- HTTP ----------

  async function body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 1 << 20) throw new HttpError(413, 'body too large');
      chunks.push(c as Buffer);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
  }

  function send(res: ServerResponse, status: number, obj?: unknown): void {
    if (obj === undefined) { res.writeHead(status); res.end(); return; }
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(s);
  }

  function auth(req: IncomingMessage): { token: string; name: string } {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(h);
    const p = player(m?.[1]);
    if (!p) throw new HttpError(401, 'bad_token');
    return p;
  }

  function limit(key: string, n: number, windowMs: number): void {
    if (limits && !limiter.take(key, n, windowMs)) throw new HttpError(429, 'rate limited');
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!opts.clientDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    const file = normalize(join(opts.clientDir, rel));
    if (!file.startsWith(normalize(opts.clientDir))) return false;
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300' });
      res.end(req.method === 'HEAD' ? undefined : data);
      return true;
    } catch {
      return false;
    }
  }

  function runPublic(run: RunRow, callerToken: string | null) {
    const ended = run.date < today();
    const own = callerToken === run.token;
    if (!ended && !own) throw new HttpError(403, 'Replays unlock when the day ends.');
    const secret = secretFor(run.date);
    let bugKeys = allBugKeys(secret, run.date);
    // An active run of your own only gets the keys the server has already handed out.
    if (run.status === 'active') bugKeys = bugKeys.map((k, i) => (i + 1 <= Math.max(2, run.last_turn + 2) ? k : 0));
    const p = player(run.token);
    return { date: run.date, mapSeed: mapSeedFor(secret, run.date), bugKeys, log: JSON.parse(run.log), score: run.verified_score, name: p?.name ?? '?', status: run.status };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const ip = req.socket.remoteAddress ?? '?';
    const m = req.method ?? 'GET';

    if (m === 'GET' && path === '/health') return send(res, 200, { ok: true, game: 'dcg', date: today() });

    if (path === '/session' && m === 'POST') {
      limit(`session:${ip}`, 10, 60 * MIN);
      const b = await body(req);
      const name = String(b?.name ?? '').trim();
      if (!NAME_RE.test(name)) throw new HttpError(400, 'Names are 2–16 characters: letters, digits, space, _ and -');
      const token = randomBytes(32).toString('base64url');
      d.q.insertPlayer.run(token, name, now());
      return send(res, 200, { token });
    }

    const isApi = path === '/session' || path === '/telemetry' || path.startsWith('/daily') || path.startsWith('/leaderboard/') || path.startsWith('/runs/');
    if (!isApi) {
      if (await serveStatic(req, res, path)) return;
      throw new HttpError(404, 'not found');
    }

    const p = auth(req);
    if (path === '/telemetry' && m === 'POST') {
      limit(`tel:${p.token}`, 60, 60 * MIN);
      const b = await body(req);
      const runId = Number.isInteger(b?.runId) ? b.runId : null;
      d.q.insertTelemetry.run(runId, p.token, String(b?.kind ?? 'unknown'), JSON.stringify(b ?? {}), now());
      return send(res, 204);
    }
    limit(`api:${p.token}`, 120, MIN);

    if (path === '/session' && m === 'PATCH') {
      const b = await body(req);
      const name = String(b?.name ?? '').trim();
      if (!NAME_RE.test(name)) throw new HttpError(400, 'Names are 2–16 characters: letters, digits, space, _ and -');
      d.q.renamePlayer.run(name, p.token);
      return send(res, 200, { name });
    }
    if (m !== 'GET') throw new HttpError(405, 'method not allowed');

    if (path === '/daily') {
      const date = today();
      secretFor(date);
      const run = d.q.getRunFor.get(p.token, date) as RunRow | undefined;
      return send(res, 200, run
        ? { date, played: true, runId: run.id, score: run.verified_score, status: run.status }
        : { date, played: false });
    }
    if (path === '/daily/history') {
      const rows = d.q.history.all(today()) as { date: string; secret: Uint8Array; players: number }[];
      return send(res, 200, rows.map((r) => ({ date: r.date, mapSeed: mapSeedFor(r.secret, r.date), players: r.players })));
    }
    let mm = /^\/daily\/(\d{4}-\d{2}-\d{2})\/keys$/.exec(path);
    if (mm) {
      const date = mm[1];
      if (date >= today()) throw new HttpError(403, 'A daily seed’s keys are published when its UTC day ends.');
      const row = d.q.getDaily.get(date) as { secret: Uint8Array } | undefined;
      if (!row) throw new HttpError(404, 'No daily seed was played that day.');
      return send(res, 200, { date, mapSeed: mapSeedFor(row.secret, date), bugKeys: allBugKeys(row.secret, date) });
    }
    mm = /^\/leaderboard\/(\d{4}-\d{2}-\d{2})$/.exec(path);
    if (mm) {
      const date = mm[1];
      const lim = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 100) || 100));
      const rows = d.q.board.all(date, lim) as { id: number; token: string; score: number; finished: number }[];
      const entries = rows.map((r, i) => ({ rank: i + 1, name: player(r.token)?.name ?? '?', score: r.score, runId: r.id }));
      const mine = d.q.getRunFor.get(p.token, date) as RunRow | undefined;
      let me: { rank: number | null; score: number | null } | null = null;
      if (mine && mine.status === 'finished') me = { rank: rankOf(d, mine).rank, score: mine.verified_score };
      else if (mine && mine.status === 'abandoned') me = { rank: null, score: mine.verified_score };
      const total = (d.q.boardCount.get(date) as { n: number }).n;
      return send(res, 200, { entries, me, total });
    }
    mm = /^\/runs\/(\d+)$/.exec(path);
    if (mm) {
      const run = d.q.getRun.get(Number(mm[1])) as RunRow | undefined;
      if (!run) throw new HttpError(404, 'no such run');
      return send(res, 200, runPublic(run, p.token));
    }
    throw new HttpError(404, 'not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 401 ? 'bad_token' : 'error', message: e instanceof Error ? e.message : String(e) });
    });
  });

  // ---------- ranked WebSocket ----------

  function finalize(run: RunRow, status: 'finished' | 'abandoned', extraOps: LogOp[], client?: { score: number; hash: number }) {
    const log = (JSON.parse(run.log) as LogOp[]).concat(extraOps);
    const secret = secretFor(run.date);
    const v = verifyRanked(mapSeedFor(secret, run.date), allBugKeys(secret, run.date), log);
    const t = now();
    if (!v.valid) {
      d.q.finishRun.run('invalid', JSON.stringify(log), null, JSON.stringify(['invalid_log']), t, t, run.id);
      return { valid: false as const, reason: v.reason };
    }
    const flags = [...v.flags];
    if (client && client.score !== v.score) flags.push('score_mismatch');
    if (client && (client.hash >>> 0) !== (v.finalHash >>> 0)) flags.push('hash_mismatch');
    d.q.finishRun.run(status, JSON.stringify(log), v.score, JSON.stringify(flags), t, t, run.id);
    return { valid: true as const, score: v.score, flags };
  }

  function validOps(ops: unknown, lastG: number, minG: number): LogOp[] {
    if (!Array.isArray(ops)) throw new Error('ops must be an array');
    let prev = lastG;
    for (const op of ops) {
      if (!op || typeof op !== 'object' || !Number.isInteger((op as LogOp).g)) throw new Error('bad op');
      const g = (op as LogOp).g;
      if (g < minG) throw Object.assign(new Error(`op stamped at tic ${g} is earlier than ${minG}`), { code: 'late_op' });
      if (g < prev || g > 599) throw new Error('ops out of order');
      prev = g;
    }
    return ops as LogOp[];
  }

  server.on('upgrade', (req, socket) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/mp') { const c = WsConn.accept(req, socket); if (c) mp.accept(c); return; }
    if (path !== '/ranked') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const accepted = WsConn.accept(req, socket);
    if (!accepted) return;
    const ws: WsConn = accepted;
    let run: RunRow | null = null;
    let lastHeard = Date.now();
    const helloTimer = setTimeout(() => { if (!run) ws.close(1008, 'hello timeout'); }, 5000);
    const silence = setInterval(() => {
      if (Date.now() - lastHeard > 45_000) ws.close(1001, 'silent');
      else ws.sendJson({ type: 'ping' });
    }, 15_000);
    const fail = (code: string, message: string) => { ws.sendJson({ type: 'error', code, message }); ws.close(1008, code); };
    ws.onClose = () => {
      clearTimeout(helloTimer);
      clearInterval(silence);
      if (run && live.get(run.id) === ws) live.delete(run.id);
    };
    ws.onMessage = (text) => {
      lastHeard = Date.now();
      let msg: any;
      try { msg = JSON.parse(text); } catch { return fail('invalid_log', 'Messages must be JSON.'); }
      try {
        handle(msg);
      } catch (e) {
        fail((e as { code?: string }).code ?? 'invalid_log', (e as Error).message);
      }
    };

    function handle(msg: any): void {
      if (msg?.type === 'ping') { ws.sendJson({ type: 'pong' }); return; }
      if (msg?.type === 'pong') return;
      if (!run) {
        if (msg?.type !== 'hello') return fail('bad_token', 'Send hello first.');
        const p = player(msg.token);
        if (!p) return fail('bad_token', 'Unknown token.');
        if (msg.resumeRunId !== undefined) {
          const r = d.q.getRun.get(Number(msg.resumeRunId)) as RunRow | undefined;
          if (!r || r.token !== p.token) return fail('bad_token', 'That run is not yours.');
          if (r.status === 'abandoned') return fail('abandoned', 'The run was finished by the server after a long pause or disconnect.');
          if (r.status !== 'active') return fail('already_played', 'That run is over.');
          run = r;
          live.get(r.id)?.close(1000, 'replaced');
          live.set(r.id, ws);
          const secret = secretFor(r.date);
          const keys: Record<string, number> = {};
          for (let t = 1; t <= Math.min(300, Math.max(2, r.last_turn + 2)); t++) keys[t] = bugKeyFor(secret, r.date, t);
          d.q.updateRunLog.run(r.log, r.last_turn, now(), r.id);
          ws.sendJson({ type: 'resumed', runId: r.id, mapSeed: mapSeedFor(secret, r.date), opCount: (JSON.parse(r.log) as unknown[]).length, lastTurn: r.last_turn, keys });
          return;
        }
        const date = today();
        if (msg.date !== date) return fail('not_today', `Today (UTC) is ${date}.`);
        if (d.q.getRunFor.get(p.token, date)) return fail('already_played', 'Only the first attempt counts.');
        const secret = secretFor(date);
        const t = now();
        const id = Number(d.q.insertRun.run(p.token, date, t, t).lastInsertRowid);
        run = d.q.getRun.get(id) as unknown as RunRow;
        live.set(id, ws);
        ws.sendJson({ type: 'start', runId: id, date, mapSeed: mapSeedFor(secret, date), keys: { 1: bugKeyFor(secret, date, 1), 2: bugKeyFor(secret, date, 2) } });
        return;
      }
      // Re-read: the abandonment job may have closed the run.
      const cur = d.q.getRun.get(run.id) as unknown as RunRow;
      if (cur.status === 'abandoned') return fail('abandoned', 'The run was finished by the server.');
      if (cur.status !== 'active') return fail('already_played', 'That run is over.');
      const log = JSON.parse(cur.log) as LogOp[];
      const lastG = log.length ? log[log.length - 1].g : 0;
      if (msg.type === 'turn') {
        const turn = Number(msg.turn);
        if (!Number.isInteger(turn) || turn < 1 || turn > 300) throw new Error('bad turn');
        if (turn > cur.last_turn + 3) throw new Error('turn is too far ahead');
        const ops = validOps(msg.ops ?? [], lastG, 2 * (turn - 2));
        const lastTurn = Math.max(cur.last_turn, turn);
        d.q.updateRunLog.run(JSON.stringify(log.concat(ops)), lastTurn, now(), cur.id);
        if (turn + 2 <= 300) ws.sendJson({ type: 'key', turn: turn + 2, key: bugKeyFor(secretFor(cur.date), cur.date, turn + 2) });
        return;
      }
      if (msg.type === 'finish') {
        const ops = validOps(msg.ops ?? [], lastG, 2 * (cur.last_turn - 2));
        const r = finalize(cur, 'finished', ops, { score: Number(msg.clientScore), hash: Number(msg.clientHash) });
        if (!r.valid) return fail('invalid_log', `The run could not be verified: ${r.reason}`);
        const done = d.q.getRun.get(cur.id) as unknown as RunRow;
        const { rank, total } = rankOf(d, done);
        ws.sendJson({ type: 'result', verifiedScore: r.score, rank, total, percentile: Math.max(1, Math.ceil((100 * rank) / total)), flagged: r.flags.length > 0 });
        run = null;
        ws.close(1000, 'done');
        return;
      }
      throw new Error(`unknown message ${String(msg.type)}`);
    }
  });

  // ---------- abandonment job ----------

  function sweep(): number {
    let n = 0;
    const t = now();
    for (const r of d.q.activeRuns.all() as unknown as RunRow[]) {
      const log = JSON.parse(r.log) as LogOp[];
      let paused = false;
      for (const op of log) if (op.op === 'pause') paused = true; else if (op.op === 'resume') paused = false;
      const silentFor = t - r.updated;
      if (silentFor > SILENT_LIMIT || (paused && silentFor > PAUSE_LIMIT)) {
        finalize(r, 'abandoned', []);
        const ws = live.get(r.id);
        if (ws) { ws.sendJson({ type: 'error', code: 'abandoned', message: 'The run was finished by the server.' }); ws.close(1000, 'abandoned'); }
        n++;
      }
    }
    return n;
  }
  const job = setInterval(sweep, MIN);
  job.unref();

  return {
    server,
    db: d,
    sweep,
    mp,
    close: () => new Promise<void>((resolve) => {
      clearInterval(job);
      mp.close();
      for (const ws of live.values()) ws.close(1001, 'shutdown');
      server.close(() => { d.close(); resolve(); });
      server.closeAllConnections?.();
    }),
  };
}
