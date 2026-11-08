// Daily and leaderboard screens. Online they talk to the server; offline the daily is an unranked
// practice run on a date-derived seed.
import { seedToHex, getPracticeBest, getPracticeBestRun, practiceConfig } from '../../sim.ts';
import { h, clear } from '../dom.ts';
import type { Screen } from '../../main.ts';
import { go, todayUTC, offlineDailySeed } from '../../app.ts';
import { api, isOnline, type HistoryDay } from '../../net/api.ts';
import { kv, loadRankedBackup, loadRankedReplay } from '../../storage.ts';

function page(title: string, body: HTMLElement): HTMLElement {
  return h('div.screen.menu-screen', h('div.menu-card',
    h('div.menu-top', h('button.btn.btn-ghost.btn-small', { on: { click: () => go.menu() } }, '← Menu'), h('h2', title)),
    body));
}

const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function dailyScreen(): Screen {
  const body = h('div');
  const el = page('Daily', body);
  const date = todayUTC();

  if (!isOnline()) {
    const seed = offlineDailySeed(date);
    const hex = seedToHex(seed);
    const best = getPracticeBest(kv, hex);
    const bestRun = getPracticeBestRun(kv, hex);
    body.append(
      h('div.daily-today',
        h('div.daily-date', fmtDate(date), h('span.muted', ' · UTC')),
        h('p.muted', 'Offline mode: today’s seed is the same for everyone playing offline, but it isn’t ranked. Run the game server to play ranked dailies with a leaderboard.'),
        h('div.row',
          h('button.btn.btn-primary.btn-big', { on: { click: () => go.playPractice(seed, { label: 'Daily (offline)' }) } }, best === null ? 'Start' : 'Play again'),
          bestRun ? h('button.btn', { on: { click: () => go.replayPractice(hex, bestRun, () => go.daily()) } }, 'Watch best replay') : null),
        best !== null ? h('p', `Your best today: `, h('strong', String(best))) : null,
      ));
    return { el };
  }

  body.append(h('p.muted', 'Loading…'));
  void (async () => {
    try {
      const [info, history] = await Promise.all([api.daily(), api.history()]);
      clear(body);
      const backup = loadRankedBackup();
      let action: HTMLElement;
      if (info.played && info.status === 'active') {
        action = h('div',
          h('p', 'You have a run in progress.'),
          h('button.btn.btn-primary.btn-big', { on: { click: () => void go.resumeRanked(info.runId!, info.date) } }, 'Resume run'),
          backup && backup.runId === info.runId ? null : h('p.muted', 'No local copy on this device; it will resume from the server’s copy at the start of your last turn.'));
      } else if (info.played) {
        const replay = loadRankedReplay(info.date);
        action = h('div',
          h('p.played', info.status === 'abandoned' ? 'Played — abandoned, score ' : info.status === 'invalid' ? 'Played — run rejected' : 'Played — score ', info.status === 'invalid' ? '' : h('strong', String(info.score ?? 0))),
          info.status === 'abandoned' ? h('p.muted', 'Abandoned runs get a verified score but are not ranked.') : null,
          h('div.row',
            h('button.btn', { on: { click: () => go.leaderboard(info.date) } }, 'Leaderboard'),
            replay ? h('button.btn.btn-ghost', { on: { click: () => go.replay({ mapSeed: replay.mapSeed, bugKeys: replay.bugKeys, kind: 'practice' }, replay.log, `Your daily · ${info.date}`, () => go.daily()) } }, 'Watch my replay') : null));
      } else {
        action = h('div',
          h('p.muted', 'One attempt counts. You get 3 pauses of up to 10 minutes, and the board is hidden while paused.'),
          h('button.btn.btn-primary.btn-big', { on: { click: () => void go.playRanked() } }, 'Start'));
      }
      body.append(
        h('div.daily-today', h('div.daily-date', fmtDate(info.date), h('span.muted', ' · UTC')), action),
        h('h3.section-title', 'Last 7 days'),
        history.length ? historyTable(history) : h('p.muted', 'No finished days yet.'),
      );
    } catch (e) {
      clear(body);
      body.append(h('p.error', `Could not reach the server: ${(e as Error).message}`));
    }
  })();
  return { el };
}

function historyTable(days: HistoryDay[]): HTMLElement {
  return h('table.table',
    h('thead', h('tr', h('th', 'Day'), h('th.num', 'Players'), h('th', ''))),
    h('tbody', ...days.map((d) => h('tr',
      h('td', fmtDate(d.date), h('div.muted.mono.small', seedToHex(d.mapSeed))),
      h('td.num', String(d.players)),
      h('td.actions',
        h('button.btn.btn-small', { on: { click: () => go.leaderboard(d.date) } }, 'Leaderboard'),
        h('button.btn.btn-small.btn-ghost', { on: { click: () => go.leaderboard(d.date) } }, 'Watch replays'),
        h('button.btn.btn-small.btn-ghost', { on: { click: () => void practiceDay(d.date) } }, 'Practice this seed'),
      ),
    ))));
}

/** Decision 10: practice on a past daily replays the real day (same map and published bug keys). */
async function practiceDay(date: string): Promise<void> {
  try {
    const k = await api.dailyKeys(date);
    go.playPractice(k.mapSeed, { bugKeys: k.bugKeys, label: `Practice · daily ${date}` });
  } catch (e) {
    go.message('Could not load that day', (e as Error).message);
  }
}

export function leaderboardScreen(initialDate?: string): Screen {
  const body = h('div');
  const el = page('Leaderboard', body);
  const tabs = h('div.tabs');
  const table = h('div');
  body.append(tabs, table);
  const today = todayUTC();

  const load = async (date: string) => {
    for (const b of tabs.querySelectorAll('button')) b.classList.toggle('active', (b as HTMLElement).dataset.date === date);
    clear(table);
    table.append(h('p.muted', 'Loading…'));
    try {
      const board = await api.leaderboard(date);
      clear(table);
      const ended = date < today;
      if (!board.entries.length) { table.append(h('p.muted', 'No finished runs yet.')); return; }
      table.append(h('table.table',
        h('thead', h('tr', h('th.num', '#'), h('th', 'Name'), h('th.num', 'Score'), h('th', ''))),
        h('tbody', ...board.entries.map((e) => h('tr' + (board.me && board.me.rank === e.rank ? '.me' : ''),
          h('td.num', String(e.rank)), h('td', e.name), h('td.num', String(e.score)),
          h('td.actions', ended || (board.me && board.me.rank === e.rank)
            ? h('button.btn.btn-small.btn-ghost', { on: { click: () => void watch(e.runId, e.name, date) } }, 'Watch')
            : h('span.muted.small', 'replays after the day ends')),
        )))),
        h('p.muted', board.me && board.me.rank ? `You: rank ${board.me.rank} of ${board.total}, score ${board.me.score}.` : `${board.total} ranked run${board.total === 1 ? '' : 's'}.`),
      );
    } catch (e) {
      clear(table);
      table.append(h('p.error', (e as Error).message));
    }
  };

  const watch = async (runId: number, name: string, date: string) => {
    try {
      const run = await api.run(runId);
      go.replay(practiceConfig(run.mapSeed, run.bugKeys), run.log, `${name} · ${date}`, () => go.leaderboard(date));
    } catch (e) {
      go.message('Replay unavailable', (e as Error).message);
    }
  };

  void (async () => {
    let dates = [today];
    try { dates = [today, ...(await api.history()).map((d) => d.date)]; } catch { /* keep today */ }
    for (const d of dates) tabs.append(h('button.tab', { 'data-date': d, on: { click: () => void load(d) } }, d === today ? 'Today' : fmtDate(d)));
    void load(initialDate && dates.includes(initialDate) ? initialDate : today);
  })();
  return { el };
}
