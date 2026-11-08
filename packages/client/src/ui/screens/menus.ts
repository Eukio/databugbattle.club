// Name prompt, main menu, practice, tutorials, how to play, and small message screens.
import { hexToSeed, seedToHex, getPracticeBest, getPracticeBestRun, getLastPracticeRun } from '../../sim.ts';
import { h } from '../dom.ts';
import type { Screen } from '../../main.ts';
import { go, TUTORIALS } from '../../app.ts';
import { kv, getName, setName, setToken, tutorialDone, NAME_RE, loadRankedBackup } from '../../storage.ts';
import { api, isOnline } from '../../net/api.ts';

function page(title: string, ...body: (HTMLElement | null)[]): HTMLElement {
  return h('div.screen.menu-screen', h('div.menu-card',
    h('div.menu-top', h('button.btn.btn-ghost.btn-small', { on: { click: () => go.menu() } }, '← Menu'), h('h2', title)),
    ...body));
}

export function nameScreen(first: boolean): Screen {
  const input = h('input.text-input', { maxLength: 16, placeholder: 'Your name', value: getName() ?? '', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  const err = h('p.error');
  const submit = async () => {
    const name = input.value.trim();
    if (!NAME_RE.test(name)) { err.textContent = '2–16 characters: letters, digits, space, _ and -'; return; }
    err.textContent = '';
    setName(name);
    if (isOnline()) {
      try {
        if (first) { const r = await api.createSession(name); setToken(r.token); }
        else await api.rename(name);
      } catch (e) { err.textContent = `Saved locally; the server said: ${(e as Error).message}`; }
    }
    const room = /^#room-([A-Za-z]{4})$/.exec(location.hash)?.[1];
    if (room && isOnline()) go.mpLobby({ joinCode: room.toUpperCase() });
    else go.menu();
  };
  input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void submit(); });
  const el = h('div.screen.menu-screen', h('div.menu-card.narrow',
    first ? h('div.brand', h('div.brand-mark'), h('h1', 'Data Center Grid')) : h('h2', 'Change name'),
    h('p.muted', first ? 'Expand across the grid, capture data centers, and build a network bugs can’t hurt. What should we call you?' : 'Shown on the daily leaderboard.'),
    input, err,
    h('div.row', first ? null : h('button.btn', { on: { click: () => go.menu() } }, 'Cancel'), h('button.btn.btn-primary', { on: { click: () => void submit() } }, 'Continue')),
  ));
  return { el, mount: () => input.focus() };
}

export function menuScreen(): Screen {
  const online = isOnline();
  const backup = loadRankedBackup();
  const item = (label: string, sub: string, fn: () => void, disabled = false) =>
    h('button.menu-item', { on: { click: fn }, disabled }, h('span.mi-label', label), h('span.mi-sub', sub));
  const el = h('div.screen.menu-screen', h('div.menu-card',
    h('div.brand', h('div.brand-mark'), h('div', h('h1', 'Data Center Grid'), h('p.muted', 'A 5-minute network-building run against bugs.'))),
    h('div.menu-items',
      item('Daily', online ? (backup ? 'Resume your run in progress' : 'One ranked attempt on today’s seed') : 'Offline: today’s seed, unranked', () => go.daily()),
      item('Multiplayer', online ? '1v1, 2v2, free for all, or a private room' : 'Needs the game server', () => go.mpLobby(), !online),
      item('Practice', 'Random or typed seeds, pause any time', () => go.practice()),
      item('Tutorials', `${TUTORIALS.filter((t) => tutorialDone(t.id)).length} of 3 complete`, () => go.tutorials()),
      item('Leaderboard', online ? 'Today and the last 7 days' : 'Needs the game server', () => go.leaderboard(), !online),
      item('How to play', 'Rules on one page', () => go.howTo()),
    ),
    h('div.menu-foot',
      h('span.muted', 'Playing as ', h('strong', getName() ?? '—'), ' · '),
      h('a.link', { href: '#', on: { click: (e: Event) => { e.preventDefault(); go.name(false); } } }, 'change'),
      h('span.status-dot' + (online ? '.on' : ''), online ? 'Server connected' : 'Offline mode'),
    ),
  ));
  return { el };
}

function recentSeeds(): { hex: string; best: number }[] {
  const out: { hex: string; best: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^dcg\.pb\.[0-9A-F]{8}$/.test(k)) out.push({ hex: k.slice(7), best: Number(localStorage.getItem(k)) });
    }
  } catch { /* storage blocked */ }
  return out.sort((a, b) => b.best - a.best).slice(0, 8);
}

export function practiceScreen(initial?: string): Screen {
  const input = h('input.text-input.mono', { maxLength: 8, placeholder: '8 hex digits, e.g. 0A1B2C3D', value: initial ?? '', spellcheck: false, autocomplete: 'off' }) as HTMLInputElement;
  const pb = h('p.muted');
  const err = h('p.error');
  const updatePb = () => {
    const v = input.value.trim().toUpperCase();
    if (/^[0-9A-F]{8}$/.test(v)) {
      const best = getPracticeBest(kv, v);
      pb.textContent = best === null ? 'No personal best on this seed yet.' : `Personal best on ${v}: ${best}`;
    } else pb.textContent = '';
  };
  input.addEventListener('input', updatePb);
  updatePb();
  const playTyped = () => {
    const v = input.value.trim();
    try { go.playPractice(hexToSeed(v)); } catch { err.textContent = 'A seed is exactly 8 hex digits (0–9, A–F).'; }
  };
  input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') playTyped(); });
  const random = () => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    go.playPractice(a[0] >>> 0);
  };
  const recents = recentSeeds();
  const back = () => go.practice();
  const el = page('Practice',
    h('p.muted', 'Practice seeds use the same rules as the daily run. Pauses are free and your best score per seed is kept on this device.'),
    h('div.row', h('button.btn.btn-primary', { on: { click: random } }, 'New random seed')),
    h('div.field', h('label', 'Play a seed'), h('div.row', input, h('button.btn', { on: { click: playTyped } }, 'Play')), pb, err),
    recents.length ? h('div.field', h('label', 'Your seeds'), h('table.table',
      h('thead', h('tr', h('th', 'Seed'), h('th.num', 'Best'), h('th', ''))),
      h('tbody', ...recents.map((r) => {
        const bestRun = getPracticeBestRun(kv, r.hex);
        const last = getLastPracticeRun(kv, r.hex);
        return h('tr',
          h('td.mono', r.hex),
          h('td.num', String(r.best)),
          h('td.actions',
            h('button.btn.btn-small', { on: { click: () => go.playPractice(hexToSeed(r.hex), { bugKeys: bestRun?.bugKeys }) } }, 'Play'),
            bestRun ? h('button.btn.btn-small.btn-ghost', { on: { click: () => go.replayPractice(r.hex, bestRun, back) } }, 'Best replay') : null,
            last && last !== bestRun && last.finishedAt !== bestRun?.finishedAt ? h('button.btn.btn-small.btn-ghost', { on: { click: () => go.replayPractice(r.hex, last, back) } }, 'Last replay') : null,
          ));
      })))) : null,
  );
  return { el, mount: () => input.focus() };
}

const TUT_BLURB: Record<string, string> = {
  't1-capture': 'Select, steer, queue moves, and capture data centers. Meet the safe level.',
  't2-safe-level': 'Why a DC survives a bug: links are only as strong as their weakest cell.',
  't3-land-bugs': 'Land bugs freeze and spread into weak land. Cure inside the window.',
};

export function tutorialsScreen(): Screen {
  const el = page('Tutorials',
    h('p.muted', 'Three short lessons. One rule to remember: keep every DC and corridor at the safe level.'),
    h('div.cards', ...TUTORIALS.map((t, i) => h('button.tut-card' + (tutorialDone(t.id) ? '.done' : ''), { on: { click: () => go.playTutorial(t.id) } },
      h('div.tut-num', String(i + 1)),
      h('div.tut-body', h('div.tut-title', t.title), h('div.muted', TUT_BLURB[t.id] ?? '')),
      h('div.tut-tick', tutorialDone(t.id) ? '✓' : ''),
    ))),
  );
  return { el };
}

export function tutorialDoneScreen(id: string): Screen {
  const idx = TUTORIALS.findIndex((t) => t.id === id);
  const next = TUTORIALS[idx + 1];
  const el = h('div.screen.menu-screen', h('div.menu-card.narrow',
    h('div.big-tick', '✓'),
    h('h2', `${TUTORIALS[idx]?.title ?? 'Tutorial'} — complete`),
    h('div.row',
      next ? h('button.btn.btn-primary', { on: { click: () => go.playTutorial(next.id) } }, `Next: ${next.title}`) : h('button.btn.btn-primary', { on: { click: () => go.practice() } }, 'Try a practice seed'),
      h('button.btn', { on: { click: () => go.tutorials() } }, 'Tutorials'),
      h('button.btn.btn-ghost', { on: { click: () => go.menu() } }, 'Main menu'),
    ),
  ));
  return { el };
}

export function messageScreen(title: string, text: string): Screen {
  const el = h('div.screen.menu-screen', h('div.menu-card.narrow',
    h('h2', title), h('p.muted', text),
    h('div.row', h('button.btn.btn-primary', { on: { click: () => go.menu() } }, 'Main menu')),
  ));
  return { el };
}

export function howToScreen(): Screen {
  const sec = (title: string, ...items: string[]) => h('div.howto-sec', h('h3', title), h('ul', ...items.map((t) => h('li', { html: t }))));
  const el = page('How to play',
    h('p.lead', 'Expand across a 20×20 grid under fog, capture data centers (DCs), and finish the 300-turn run (about 5 minutes) with as much total power as possible. Bugs freeze cells; strong networks survive them.'),
    h('div.howto-grid',
      sec('Moves',
        'Each turn has 2 tics; one queued step runs per tic. Queue as much as you like.',
        'Click an owned cell, then press <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows once per step, or drag a path. Clicking next to the cursor is a step.',
        '<kbd>Q</kbd>/<kbd>Esc</kbd> clears the queue, right-click removes one path. There is no undo.',
        'Split modes: <kbd>1</kbd> Auto (DCs keep the safe level, land keeps 1), <kbd>2</kbd> Half, <kbd>3</kbd> Keep N (<kbd>+</kbd>/<kbd>−</kbd>), <kbd>4</kbd> All but 1 (gathers along the way). <kbd>Z</kbd> makes the next path Half.'),
      sec('Capture and economy',
        'A neutral DC with cost <b>x</b> falls when more than x arrives. Each step onto new land leaves 1 behind.',
        'DCs make 2 power a turn, plus up to +1 from strong links to other DCs. Land makes +1 every 12 turns, only while connected to a healthy DC.',
        'Score is your total power at the end. Moving power never destroys it.'),
      sec('The safe level',
        'S(t) = 4 + ⌊t / 10⌋, shown in the top bar. A DC whose stack and best link are both at least S(t) is <b>Safe</b>.',
        'A link is only as strong as its weakest cell. Paths run through your own unfrozen cells.'),
      sec('Bugs',
        'From turn 30, bugs freeze DCs and land, favouring weakly connected cells. New bugs are immune to cures for 5 turns and grow +1 every 3 turns.',
        'A bugged DC keeps producing only while <b>protected</b>: its best link to a healthy DC must be stronger than the bug.',
        'Land bugs spread every 8 turns into a neighbour no stronger than the bug. Strong cells are firewalls.',
        'Cure by moving at least the bug’s health into it once it is curable. Cure power is destroyed.'),
      sec('Reading the board',
        'Outlines: <span style="color:#C9A227">Vulnerable</span>, <span style="color:#9B59B6">Exposed</span>, <span style="color:#E5484D">Cure needed</span>, <span style="color:#F97316">Unprotected</span>, <span style="color:#F5A524">At risk</span>, <span style="color:#30A46C">Protected</span>.',
        'Hatched land is cut off and not earning. Dashed cyan outlines are where a land bug can spread next.',
        '<kbd>Tab</kbd> cycles overlays: power, connectivity (reach to a DC and link lines), hot cells (spawn weight).'),
      sec('Daily and practice',
        'The daily seed is the same for everyone; only your first attempt ranks, with 3 pauses of up to 10 minutes.',
        'Practice seeds pause freely and keep your best score and replay on this device.'),
    ),
  );
  return { el };
}

export { seedToHex };
