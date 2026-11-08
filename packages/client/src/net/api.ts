// HTTP calls to the game server (doc §HTTP endpoints). The same origin serves the client, so paths are relative.
// Without a server (the offline single-file build, or the server is down) the client runs in offline mode.
import { getName, getToken, setToken } from '../storage.ts';
import type { LogOp, Telemetry } from '../sim.ts';

declare const __OFFLINE_BUILD__: boolean;

let online = false;
export const isOnline = () => online;

export async function probe(): Promise<boolean> {
  if (typeof __OFFLINE_BUILD__ !== 'undefined' && __OFFLINE_BUILD__) return (online = false);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch('health', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    online = j?.game === 'dcg';
  } catch {
    online = false;
  }
  return online;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function raw<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const tok = getToken();
  if (auth && tok) headers.authorization = `Bearer ${tok}`;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!r.ok) throw new ApiError(r.status, j?.message ?? j?.error ?? `HTTP ${r.status}`);
  return j as T;
}

/** Makes sure we hold a valid token, creating a session from the stored name if needed. */
export async function ensureSession(): Promise<string> {
  let tok = getToken();
  if (tok) return tok;
  const name = getName() ?? 'Player';
  const r = await raw<{ token: string }>('POST', 'session', { name }, false);
  setToken(r.token);
  tok = r.token;
  return tok;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  await ensureSession();
  try {
    return await raw<T>(method, path, body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { setToken(null); await ensureSession(); return raw<T>(method, path, body); }
    throw e;
  }
}

export interface DailyInfo { date: string; played: boolean; runId?: number; score?: number | null; status?: string }
export interface HistoryDay { date: string; mapSeed: number; players: number }
export interface Board { entries: { rank: number; name: string; score: number; runId: number }[]; me: { rank: number | null; score: number | null } | null; total: number }
export interface RunData { date: string; mapSeed: number; bugKeys: number[]; log: LogOp[]; score: number | null; name: string; status: string }

export const api = {
  createSession: (name: string) => raw<{ token: string }>('POST', 'session', { name }, false),
  rename: (name: string) => call<{ name: string }>('PATCH', 'session', { name }),
  daily: () => call<DailyInfo>('GET', 'daily'),
  history: () => call<HistoryDay[]>('GET', 'daily/history'),
  leaderboard: (date: string, limit = 100) => call<Board>('GET', `leaderboard/${date}?limit=${limit}`),
  run: (id: number) => call<RunData>('GET', `runs/${id}`),
  dailyKeys: (date: string) => call<{ date: string; mapSeed: number; bugKeys: number[] }>('GET', `daily/${date}/keys`),
  telemetry: (t: Telemetry, runId?: number) => call<void>('POST', 'telemetry', { ...t, runId }).catch(() => undefined),
};
