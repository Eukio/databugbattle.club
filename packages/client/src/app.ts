// Navigation and run flows (doc §Screen flow).
import {
  createGame, createPracticeGame, globalTic, applyOp, stepTic, seedToHex, setBugKey, fmix32, practiceConfig,
  type GameConfig, type LogOp, type Tutorial,
} from './sim.ts';
import { show } from './main.ts';
import { GameScreen, type GameExit, type ResultsData } from './ui/screens/game.ts';
import { nameScreen, menuScreen, practiceScreen, tutorialsScreen, howToScreen, tutorialDoneScreen, messageScreen } from './ui/screens/menus.ts';
import { dailyScreen, leaderboardScreen } from './ui/screens/daily.ts';
import { resultsScreen } from './ui/screens/results.ts';
import { ReplayScreen } from './ui/screens/replay.ts';
import { mpLobbyScreen } from './ui/screens/mplobby.ts';
import { MpGameScreen } from './ui/screens/mpgame.ts';
import { mpLink } from './net/mp.ts';
import type { MpStart } from './mpview.ts';
import { Tracker } from './tracker.ts';
import { ensureSession, api, isOnline } from './net/api.ts';
import { RankedLink, RankedError } from './net/ranked.ts';
import { loadRankedBackup, clearRankedBackup } from './storage.ts';
import t1 from '../../sim/tutorials/t1-capture.json';
import t2 from '../../sim/tutorials/t2-safe-level.json';
import t3 from '../../sim/tutorials/t3-land-bugs.json';

export const TUTORIALS = [t1, t2, t3] as unknown as Tutorial[];

export const todayUTC = () => new Date().toISOString().slice(0, 10);
/** Offline daily: one seed per UTC date for everyone using the offline build. Unranked. */
export const offlineDailySeed = (date: string) => fmix32(Number(date.replace(/-/g, '')) ^ 0x44434721) >>> 0;

function onGameExit(e: GameExit, retry?: () => void): void {
  if (e.kind === 'menu') go.menu();
  else if (e.kind === 'results') go.results(e.data, retry);
  else go.tutorialDone(e.id);
}

export const go = {
  name(first: boolean): void { show(nameScreen(first)); },
  menu(): void { show(menuScreen()); },
  practice(seedHex?: string): void { show(practiceScreen(seedHex)); },
  tutorials(): void { show(tutorialsScreen()); },
  howTo(): void { show(howToScreen()); },
  daily(): void { show(dailyScreen()); },
  leaderboard(date?: string): void { show(leaderboardScreen(date)); },
  results(data: ResultsData, retry?: () => void): void { show(resultsScreen(data, retry)); },
  tutorialDone(id: string): void { show(tutorialDoneScreen(id)); },
  message(title: string, text: string): void { show(messageScreen(title, text)); },

  replay(config: GameConfig, log: LogOp[], title: string, back: () => void): void {
    show(new ReplayScreen({ config, log, title, onBack: back }));
  },

  playPractice(seed: number, opts: { bugKeys?: number[]; label?: string } = {}): void {
    const st = createPracticeGame(seed, opts.bugKeys);
    const retry = () => go.playPractice(seed, opts);
    show(new GameScreen({
      kind: 'practice', st, seedHex: seedToHex(seed), label: opts.label ?? 'Practice', bugKeys: opts.bugKeys,
      onExit: (e) => onGameExit(e, retry),
    }));
  },

  playTutorial(id: string): void {
    const tut = TUTORIALS.find((t) => t.id === id)!;
    const st = createGame({ tutorial: tut });
    show(new GameScreen({ kind: 'tutorial', st, seedHex: '', label: 'Tutorial', tutorial: tut, onExit: (e) => onGameExit(e) }));
  },

  async playRanked(): Promise<void> {
    try {
      const token = await ensureSession();
      const link = new RankedLink(token);
      const msg = await link.open(todayUTC());
      if (msg.type !== 'start') throw new RankedError('protocol', 'Unexpected reply from the server.');
      const st = createGame({ mapSeed: msg.mapSeed, kind: 'ranked' });
      for (const [t, k] of link.keys) setBugKey(st, t, k);
      show(new GameScreen({ kind: 'ranked', st, seedHex: seedToHex(msg.mapSeed), label: 'Daily', link, onExit: (e) => onGameExit(e) }));
    } catch (e) {
      go.message('Could not start the daily run', rankedMessage(e));
    }
  },

  /** Crash recovery: rebuild the run from the local backup (or the server's copy) and resume it paused, board hidden. */
  async resumeRanked(runId: number, date: string): Promise<void> {
    try {
      const token = await ensureSession();
      const link = new RankedLink(token);
      const msg = await link.open(date, runId);
      if (msg.type !== 'resumed') throw new RankedError('protocol', 'Unexpected reply from the server.');
      link.date = date;
      let backup = loadRankedBackup();
      if (backup && (backup.runId !== runId || backup.log.length < msg.opCount)) backup = null;
      let log: LogOp[];
      let tics: number;
      if (backup) {
        log = backup.log;
        tics = backup.tics;
        for (const [t, k] of Object.entries(backup.keys)) link.keys.set(Number(t), k >>> 0);
      } else {
        const run = await api.run(runId);
        log = run.log;
        tics = 2 * (Math.max(1, msg.lastTurn) - 1);
        run.bugKeys.forEach((k, i) => { if (k) link.keys.set(i + 1, k >>> 0); });
      }
      const st = createGame({ mapSeed: msg.mapSeed, kind: 'ranked' });
      for (const [t, k] of link.keys) setBugKey(st, t, k);
      const tracker = new Tracker(st);
      let i = 0;
      while (globalTic(st) < tics && !st.finished) {
        const g = globalTic(st);
        while (i < log.length && log[i].g <= g) applyOp(st, log[i++]);
        tracker.onTic(st, stepTic(st));
      }
      while (i < log.length && log[i].g <= globalTic(st)) applyOp(st, log[i++]);
      if (i < log.length) throw new RankedError('local', 'The saved run is ahead of the board; it cannot be restored.');
      link.sent = msg.opCount;
      link.lastTurnSent = msg.lastTurn;
      show(new GameScreen({
        kind: 'ranked', st, seedHex: seedToHex(msg.mapSeed), label: 'Daily', link, restored: true, priorLog: log, tracker,
        onExit: (e) => onGameExit(e),
      }));
      if (log.length > msg.opCount) link.sendTurn(Math.max(1, msg.lastTurn));
    } catch (e) {
      if (e instanceof RankedError && (e.code === 'abandoned' || e.code === 'already_played')) clearRankedBackup();
      go.message('Could not resume the run', rankedMessage(e));
    }
  },

  replayPractice(seedHex: string, run: { log: LogOp[]; bugKeys?: number[] }, back: () => void): void {
    const seed = parseInt(seedHex, 16) >>> 0;
    go.replay(practiceConfig(seed, run.bugKeys), run.log, `Replay · ${seedHex}`, back);
  },

  online: () => isOnline(),

  mpLobby(opts: { joinCode?: string; autoQueue?: string } = {}): void {
    currentMatch = null;
    mpLink.router = (m) => {
      if (m.type !== 'matchStart') return false;
      if (currentMatch === m.matchId) return true; // a reconnect re-sends matchStart; keep the screen
      go.mpGame(m as unknown as MpStart);
      return true;
    };
    show(mpLobbyScreen({ ...opts, onMenu: () => { mpLink.disconnect(); go.menu(); } }));
  },

  mpGame(start: MpStart): void {
    currentMatch = start.matchId;
    setActiveMatch(start.matchId);
    try { if (location.hash.startsWith('#room-')) history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ }
    show(new MpGameScreen({
      start,
      onLobby: () => { setActiveMatch(null); go.mpLobby(); },
      onMenu: () => { setActiveMatch(null); mpLink.send({ type: 'leaveMatch' }); mpLink.disconnect(); currentMatch = null; go.menu(); },
      onAgain: (mode) => { setActiveMatch(null); go.mpLobby({ autoQueue: mode }); },
    }));
  },
};

let currentMatch: string | null = null;

/** The match this tab is in, so a reload goes straight back to it (the server keeps the seat for 30 s). */
export function setActiveMatch(id: string | null): void {
  try { if (id) sessionStorage.setItem('dcg.mp.match', id); else sessionStorage.removeItem('dcg.mp.match'); } catch { /* blocked */ }
}
export function activeMatch(): string | null {
  try { return sessionStorage.getItem('dcg.mp.match'); } catch { return null; }
}

function rankedMessage(e: unknown): string {
  if (e instanceof RankedError) {
    switch (e.code) {
      case 'already_played': return 'You have already played today’s daily seed. Only the first attempt counts.';
      case 'not_today': return 'That daily seed is no longer open.';
      case 'bad_token': return 'Your session was not recognised. Reload the page and try again.';
      case 'abandoned': return 'This run was finished by the server after a long pause or disconnect.';
      default: return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
