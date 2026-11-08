// Daily keys (doc §Ranked daily seed): a 256-bit secret per UTC day; the map seed and each turn's bug key
// are the first 4 bytes, big-endian, of HMAC-SHA256(secret, label).
import { createHmac, randomBytes } from 'node:crypto';

export const newSecret = () => randomBytes(32);

const hmac4 = (secret: Uint8Array, label: string) => createHmac('sha256', secret).update(label).digest().readUInt32BE(0);

export const mapSeedFor = (secret: Uint8Array, date: string) => hmac4(secret, `map:${date}`);
export const bugKeyFor = (secret: Uint8Array, date: string, turn: number) => hmac4(secret, `bug:${date}:${turn}`);
export const allBugKeys = (secret: Uint8Array, date: string) => Array.from({ length: 300 }, (_, i) => bugKeyFor(secret, date, i + 1));

export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
