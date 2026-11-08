// Minimal RFC 6455 WebSocket server side: text frames, fragmentation, close, ping/pong. Enough for the
// ranked protocol (small JSON messages) without a dependency.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20;

export class WsConn {
  closed = false;
  onMessage: (text: string) => void = () => {};
  onClose: () => void = () => {};
  private buf: Buffer = Buffer.alloc(0);
  private frags: Buffer[] = [];
  private fragOp = 0;
  private readonly sock: Duplex;

  private constructor(sock: Duplex) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => this.onData(d));
    sock.on('close', () => this.finish());
    sock.on('error', () => this.finish());
  }

  static accept(req: IncomingMessage, sock: Duplex): WsConn | null {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return null;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    sock.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    return new WsConn(sock);
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.closed) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) { this.close(1009); return; }
        len = Number(big);
        off = 10;
      }
      if (len > MAX_MESSAGE) { this.close(1009); return; }
      if (!masked) { this.close(1002); return; } // client frames must be masked
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);
      switch (op) {
        case 0x8: this.close(1000); return;
        case 0x9: this.frame(0xa, payload); break;
        case 0xa: break;
        case 0x1: case 0x2:
          if (fin) { if (op === 0x1) this.onMessage(payload.toString('utf8')); }
          else { this.fragOp = op; this.frags = [payload]; }
          break;
        case 0x0: {
          this.frags.push(payload);
          if (this.frags.reduce((s, b) => s + b.length, 0) > MAX_MESSAGE) { this.close(1009); return; }
          if (fin) {
            const all = Buffer.concat(this.frags);
            this.frags = [];
            if (this.fragOp === 0x1) this.onMessage(all.toString('utf8'));
          }
          break;
        }
        default: this.close(1002); return;
      }
    }
  }

  private frame(op: number, payload: Buffer): void {
    if (this.closed || this.sock.destroyed) return;
    const len = payload.length;
    let head: Buffer;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    this.sock.write(Buffer.concat([head, payload]));
  }

  send(text: string): void { this.frame(0x1, Buffer.from(text, 'utf8')); }
  sendJson(obj: unknown): void { this.send(JSON.stringify(obj)); }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code, 0);
    p.write(reason, 2);
    this.frame(0x8, p);
    this.finish();
    this.sock.end();
    setTimeout(() => this.sock.destroy(), 1000).unref();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}
