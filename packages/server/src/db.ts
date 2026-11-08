// SQLite (node:sqlite, WAL) with the doc's schema. One addition: runs.updated, the time of the run's last
// message, which the abandonment job needs ("silent for 30 minutes", "paused for more than 10").
import { DatabaseSync } from 'node:sqlite';
import { LEADERBOARD_SQL } from '../../sim/src/index.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players  (token TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS daily    (date TEXT PRIMARY KEY, secret BLOB NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs     (id INTEGER PRIMARY KEY, token TEXT NOT NULL REFERENCES players,
                       date TEXT NOT NULL, status TEXT NOT NULL,
                       log TEXT NOT NULL DEFAULT '[]', last_turn INTEGER NOT NULL DEFAULT 0,
                       verified_score INTEGER, flags TEXT NOT NULL DEFAULT '[]',
                       started INTEGER NOT NULL, finished INTEGER, updated INTEGER NOT NULL DEFAULT 0,
                       UNIQUE (token, date));
CREATE TABLE IF NOT EXISTS telemetry(id INTEGER PRIMARY KEY, run_id INTEGER REFERENCES runs, token TEXT,
                       kind TEXT NOT NULL, json TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS runs_board ON runs (date, status, verified_score DESC, finished);
`;

export interface RunRow {
  id: number;
  token: string;
  date: string;
  status: 'active' | 'finished' | 'abandoned' | 'invalid';
  log: string;
  last_turn: number;
  verified_score: number | null;
  flags: string;
  started: number;
  finished: number | null;
  updated: number;
}

export type Db = ReturnType<typeof openDb>;

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  const q = {
    insertPlayer: db.prepare('INSERT INTO players (token, name, created) VALUES (?, ?, ?)'),
    getPlayer: db.prepare('SELECT token, name FROM players WHERE token = ?'),
    renamePlayer: db.prepare('UPDATE players SET name = ? WHERE token = ?'),
    getDaily: db.prepare('SELECT date, secret FROM daily WHERE date = ?'),
    insertDaily: db.prepare('INSERT OR IGNORE INTO daily (date, secret, created) VALUES (?, ?, ?)'),
    history: db.prepare(`SELECT d.date, d.secret, (SELECT COUNT(*) FROM runs r WHERE r.date = d.date AND r.status = 'finished') AS players
                         FROM daily d WHERE d.date < ? ORDER BY d.date DESC LIMIT 7`),
    insertRun: db.prepare(`INSERT INTO runs (token, date, status, started, updated) VALUES (?, ?, 'active', ?, ?)`),
    getRun: db.prepare('SELECT * FROM runs WHERE id = ?'),
    getRunFor: db.prepare('SELECT * FROM runs WHERE token = ? AND date = ?'),
    updateRunLog: db.prepare('UPDATE runs SET log = ?, last_turn = ?, updated = ? WHERE id = ?'),
    finishRun: db.prepare('UPDATE runs SET status = ?, log = ?, verified_score = ?, flags = ?, finished = ?, updated = ? WHERE id = ?'),
    activeRuns: db.prepare(`SELECT * FROM runs WHERE status = 'active'`),
    board: db.prepare(LEADERBOARD_SQL),
    boardCount: db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE date = ? AND status = 'finished' AND verified_score IS NOT NULL`),
    rankOf: db.prepare(`SELECT COUNT(*) AS better FROM runs WHERE date = ? AND status = 'finished' AND verified_score IS NOT NULL
                        AND (verified_score > ? OR (verified_score = ? AND finished < ?))`),
    insertTelemetry: db.prepare('INSERT INTO telemetry (run_id, token, kind, json, created) VALUES (?, ?, ?, ?, ?)'),
  };
  return { db, q, close: () => db.close() };
}

export function dailySecret(d: Db, date: string, now: number, make: () => Uint8Array): Uint8Array {
  const row = d.q.getDaily.get(date) as { secret: Uint8Array } | undefined;
  if (row) return row.secret;
  d.q.insertDaily.run(date, make(), now);
  return (d.q.getDaily.get(date) as { secret: Uint8Array }).secret;
}

/** 1-based rank of a finished run, by the doc's tie rule (score desc, earlier finish first). */
export function rankOf(d: Db, run: RunRow): { rank: number; total: number } {
  const better = (d.q.rankOf.get(run.date, run.verified_score, run.verified_score, run.finished) as { better: number }).better;
  const total = (d.q.boardCount.get(run.date) as { n: number }).n;
  return { rank: better + 1, total };
}
