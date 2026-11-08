// Ranked WebSocket session (doc §Ranked WebSocket protocol), with reconnect via resumeRunId.
import type { LogOp } from '../sim.ts';

export interface StartMsg { type: 'start'; runId: number; date: string; mapSeed: number; keys: Record<string, number> }
export interface ResumedMsg { type: 'resumed'; runId: number; mapSeed: number; opCount: number; lastTurn: number; keys: Record<string, number> }
export interface ResultMsg { type: 'result'; verifiedScore: number; rank: number | null; percentile: number | null; flagged: boolean; total?: number }
type ServerMsg = StartMsg | ResumedMsg | ResultMsg
  | { type: 'key'; turn: number; key: number }
  | { type: 'error'; code: string; message: string }
  | { type: 'ping' } | { type: 'pong' };

export class RankedError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function wsUrl(): string {
  const u = new URL('ranked', location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

export class RankedLink {
  runId = 0;
  date = '';
  mapSeed = 0;
  readonly keys = new Map<number, number>();
  /** Ops of `log` the server has received. */
  sent = 0;
  lastTurnSent = 0;
  connected = false;
  finished = false;
  log: LogOp[] = [];
  onKey: ((turn: number, key: number) => void) | null = null;
  onFatal: ((code: string, message: string) => void) | null = null;
  onStatus: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  private resultWaiter: { resolve: (r: ResultMsg) => void; reject: (e: Error) => void } | null = null;
  private readonly token: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(token: string) { this.token = token; }

  /** Opens a socket and sends hello; resolves with the first server reply (start or resumed). */
  open(date: string, resumeRunId?: number): Promise<StartMsg | ResumedMsg> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      this.ws = ws;
      let first = true;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', token: this.token, date, ...(resumeRunId ? { resumeRunId } : {}) }));
      };
      ws.onmessage = (e) => {
        this.lastHeard = Date.now();
        let msg: ServerMsg;
        try { msg = JSON.parse(String(e.data)); } catch { return; }
        if (first) {
          first = false;
          if (msg.type === 'error') { reject(new RankedError(msg.code, msg.message)); return; }
          if (msg.type === 'start' || msg.type === 'resumed') {
            this.connected = true;
            this.runId = msg.runId;
            this.mapSeed = msg.mapSeed;
            if (msg.type === 'start') this.date = msg.date;
            for (const [t, k] of Object.entries(msg.keys)) this.keys.set(Number(t), k >>> 0);
            this.startPings();
            this.onStatus?.();
            resolve(msg);
            return;
          }
        }
        this.handle(msg);
      };
      ws.onerror = () => { if (first) { first = false; reject(new RankedError('network', 'Could not reach the game server.')); } };
      ws.onclose = () => {
        this.connected = false;
        this.stopPings();
        this.onStatus?.();
        if (first) { first = false; reject(new RankedError('network', 'Connection closed.')); return; }
        if (!this.finished) this.scheduleReconnect();
      };
    });
  }

  private handle(msg: ServerMsg): void {
    switch (msg.type) {
      case 'key':
        this.keys.set(msg.turn, msg.key >>> 0);
        this.onKey?.(msg.turn, msg.key >>> 0);
        break;
      case 'result':
        this.finished = true;
        this.resultWaiter?.resolve(msg);
        this.resultWaiter = null;
        break;
      case 'error':
        this.finished = true;
        this.resultWaiter?.reject(new RankedError(msg.code, msg.message));
        this.resultWaiter = null;
        this.onFatal?.(msg.code, msg.message);
        break;
      case 'ping':
        this.send({ type: 'pong' });
        break;
      default:
        break;
    }
  }

  private send(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /** At the start of each turn: every op made since the last message. */
  sendTurn(turn: number): void {
    const ops = this.log.slice(this.sent);
    if (this.send({ type: 'turn', turn, ops })) {
      this.sent = this.log.length;
      this.lastTurnSent = Math.max(this.lastTurnSent, turn);
    }
  }

  finish(clientScore: number, clientHash: number): Promise<ResultMsg> {
    return new Promise((resolve, reject) => {
      this.resultWaiter = { resolve, reject };
      const trySend = () => {
        if (this.send({ type: 'finish', ops: this.log.slice(this.sent), clientScore, clientHash })) this.sent = this.log.length;
        else setTimeout(trySend, 1000);
      };
      trySend();
    });
  }

  private startPings(): void {
    this.stopPings();
    this.lastHeard = Date.now();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
      if (Date.now() - this.lastHeard > 45000) this.ws?.close();
    }, 15000);
  }
  private stopPings(): void { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = null; }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        const msg = await this.open(this.date, this.runId);
        if (msg.type === 'resumed') {
          // Resend local ops the server has not seen.
          this.sent = Math.min(this.sent, msg.opCount);
          this.sent = msg.opCount;
          if (this.log.length > this.sent) this.sendTurn(Math.max(msg.lastTurn, 1));
          for (const [t, k] of Object.entries(msg.keys)) this.onKey?.(Number(t), k >>> 0);
        }
      } catch (e) {
        if (e instanceof RankedError && e.code !== 'network') { this.finished = true; this.onFatal?.(e.code, e.message); return; }
        this.scheduleReconnect();
      }
    }, 1500);
  }

  close(): void {
    this.finished = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPings();
    this.ws?.close();
  }
}
