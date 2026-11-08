// The multiplayer socket (/mp): one per tab, reconnecting on drops. The current screen sets `handler`.
import { ensureSession } from './api.ts';

export type MpMsg = { type: string; [k: string]: any };

function wsUrl(): string {
  const u = new URL('mp', location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

class MpLink {
  handler: ((m: MpMsg) => void) | null = null;
  /** Called for every message before the handler (the app uses it to switch to the game on matchStart). */
  router: ((m: MpMsg) => boolean) | null = null;
  connected = false;
  name = '';
  lobby: MpMsg | null = null;
  private ws: WebSocket | null = null;
  private wanted = false;
  private outbox: unknown[] = [];
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private statusListeners = new Set<() => void>();

  onStatus(fn: () => void): () => void { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  private status(): void { for (const f of this.statusListeners) f(); }

  async connect(): Promise<void> {
    this.wanted = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const token = await ensureSession();
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', token })); };
    ws.onmessage = (e) => {
      let m: MpMsg;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.type === 'welcome') {
        this.connected = true;
        this.name = m.name;
        for (const o of this.outbox.splice(0)) ws.send(JSON.stringify(o));
        this.status();
      }
      if (m.type === 'lobby') this.lobby = m;
      if (m.type === 'pong') return;
      if (this.router?.(m)) return;
      this.handler?.(m);
    };
    ws.onclose = () => {
      this.connected = false;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      this.status();
      if (this.wanted && !this.retry) this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, 1500);
    };
    if (this.ping) clearInterval(this.ping);
    this.ping = setInterval(() => this.send({ type: 'ping' }), 20000);
  }

  send(obj: unknown): void {
    if (this.ws && this.connected && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    else if ((obj as MpMsg).type !== 'op' && (obj as MpMsg).type !== 'ping') this.outbox.push(obj);
  }

  disconnect(): void {
    this.wanted = false;
    this.ws?.close();
    this.ws = null;
  }
}

export const mpLink = new MpLink();
