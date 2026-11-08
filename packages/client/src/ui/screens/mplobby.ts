// Multiplayer lobby: 1v1, 2v2 and FFA queues (FFA can force start), and custom rooms with invite codes.
import { h, clear } from '../dom.ts';
import type { Screen } from '../../main.ts';
import { mpLink, type MpMsg } from '../../net/mp.ts';

export interface LobbyOpts { onMenu: () => void; joinCode?: string; autoQueue?: string }

const MODES = [
  { mode: '1v1', title: '1v1', sub: 'One opponent · 20×20 · 300 turns' },
  { mode: '2v2', title: '2v2', sub: 'Random teammate, shared vision · 24×24 · 400 turns' },
  { mode: 'ffa', title: 'Free for all', sub: 'Up to 8 players · force start with 2+ · 400 turns' },
] as const;

export function mpLobbyScreen(opts: LobbyOpts): Screen {
  const body = h('div.mp-body');
  const status = h('span.status-dot');
  const el = h('div.screen.menu-screen', h('div.menu-card.wide',
    h('div.menu-top', h('button.btn.btn-ghost.btn-small', { on: { click: () => leave() } }, '← Menu'), h('h2', 'Multiplayer'), h('span.mp-online.muted', ''), status),
    body,
    h('div.mp-rules',
      h('strong', 'Rules: '),
      'everyone starts on an HQ (crown). Capture an enemy HQ to eliminate them and take their cells. If time runs out, the team with the most total power wins. Bugs hit every network, so keep yours at the safe level.'),
  ));
  let state: 'idle' | 'queue' | 'room' = 'idle';
  let lastQueue: MpMsg | null = null;
  let lastRoom: MpMsg | null = null;
  let error = '';

  const leave = () => {
    if (state === 'queue') mpLink.send({ type: 'leaveQueue' });
    if (state === 'room') mpLink.send({ type: 'leaveRoom' });
    try { if (location.hash.startsWith('#room-')) history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ }
    opts.onMenu();
  };

  const render = () => {
    clear(body);
    status.textContent = mpLink.connected ? 'Connected' : 'Connecting…';
    status.classList.toggle('on', mpLink.connected);
    const online = el.querySelector('.mp-online');
    const lobby = mpLink.lobby;
    if (online) online.textContent = lobby ? `${lobby.online} online · ${lobby.matches} game${lobby.matches === 1 ? '' : 's'} running` : '';
    if (error) body.append(h('p.error', error));
    if (state === 'queue' && lastQueue) { body.append(queueView(lastQueue)); return; }
    if (state === 'room' && lastRoom) { body.append(roomView(lastRoom)); return; }
    const counts = lobby?.queues ?? {};
    body.append(
      h('div.mode-grid', ...MODES.map((m) => h('button.mode-card', { on: { click: () => { error = ''; mpLink.send({ type: 'queue', mode: m.mode }); } }, disabled: !mpLink.connected },
        h('div.mode-title', m.title),
        h('div.muted', m.sub),
        h('div.mode-count', `${counts[m.mode] ?? 0} in queue`),
      ))),
      h('h3.section-title', 'Custom game'),
      h('div.row',
        h('button.btn.btn-primary', { on: { click: () => { error = ''; mpLink.send({ type: 'createRoom' }); } }, disabled: !mpLink.connected }, 'Create a room'),
        (() => {
          const input = h('input.text-input.mono.code-input#room-code', { maxLength: 4, placeholder: 'CODE', spellcheck: false, autocomplete: 'off' }) as HTMLInputElement;
          const join = () => { error = ''; mpLink.send({ type: 'joinRoom', code: input.value.trim() }); };
          input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') join(); });
          return h('div.row', input, h('button.btn', { on: { click: join }, disabled: !mpLink.connected }, 'Join'));
        })(),
      ),
    );
  };

  const queueView = (q: MpMsg) => {
    const ffa = q.mode === 'ffa';
    const title = MODES.find((m) => m.mode === q.mode)?.title ?? q.mode;
    return h('div.queue-card',
      h('div.spinner'),
      h('div.queue-text',
        h('div.mode-title', `Finding a ${title} game…`),
        h('div.muted', `${q.count} / ${q.size} players`),
        ffa ? h('div.muted', q.count >= 2 ? `Force start: ${q.forceVotes} of ${q.forceNeeded} votes needed` : 'Force start needs at least 2 players.') : null),
      h('div.row',
        ffa ? h('button.btn' + (q.you?.force ? '.btn-primary' : ''), { on: { click: () => mpLink.send({ type: 'force', on: !q.you?.force }) }, disabled: q.count < 2 }, q.you?.force ? 'Force start: on' : 'Force start') : null,
        h('button.btn.btn-ghost', { on: { click: () => { mpLink.send({ type: 'leaveQueue' }); state = 'idle'; render(); } } }, 'Cancel')),
    );
  };

  const roomView = (r: MpMsg) => {
    const me = r.players.find((p: any) => p.you);
    const link = `${location.origin}${location.pathname}#room-${r.code}`;
    const copyBtn = h('button.btn.btn-small', {
      on: {
        click: () => {
          navigator.clipboard?.writeText(link).then(() => { copyBtn.textContent = 'Copied'; }, () => { copyBtn.textContent = 'Select the link to copy'; });
        },
      },
    }, 'Copy invite link');
    const teamSel = h('select.team-select#team', { on: { change: (e: Event) => mpLink.send({ type: 'setTeam', team: Number((e.target as HTMLSelectElement).value) }) } },
      ...Array.from({ length: 8 }, (_, i) => h('option', { value: String(i + 1), selected: me?.team === i + 1 }, `Team ${i + 1}`)));
    return h('div.room',
      h('div.room-head',
        h('div', h('div.muted.small', 'Room code'), h('div.room-code', r.code)),
        h('div.room-link', h('input.text-input.small-input', { value: link, readOnly: true, on: { focus: (e: Event) => (e.target as HTMLInputElement).select() } }), copyBtn)),
      h('table.table',
        h('thead', h('tr', h('th', 'Player'), h('th', 'Team'), h('th', ''))),
        h('tbody', ...r.players.map((p: any) => h('tr' + (p.you ? '.me' : ''),
          h('td', p.name, p.host ? h('span.muted', ' · host') : null),
          h('td', p.you ? teamSel : `Team ${p.team}`),
          h('td.small.muted', p.you ? 'you' : ''))))),
      h('p.muted.small', 'Players on the same team share vision and win together. Give everyone a different team for free for all.'),
      h('div.row',
        me?.host ? h('button.btn.btn-primary', { on: { click: () => mpLink.send({ type: 'startRoom' }) }, disabled: !r.canStart }, r.canStart ? 'Start game' : 'Need 2 players on different teams') : h('span.muted', 'Waiting for the host to start…'),
        h('button.btn.btn-ghost', { on: { click: () => { mpLink.send({ type: 'leaveRoom' }); state = 'idle'; lastRoom = null; try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ } render(); } } }, 'Leave room')),
    );
  };

  const onMsg = (m: MpMsg) => {
    switch (m.type) {
      case 'welcome':
        if (opts.joinCode) { mpLink.send({ type: 'joinRoom', code: opts.joinCode }); opts.joinCode = undefined; }
        if (opts.autoQueue) { mpLink.send({ type: 'queue', mode: opts.autoQueue }); opts.autoQueue = undefined; }
        break;
      case 'queue': state = 'queue'; lastQueue = m; break;
      case 'room':
        state = 'room'; lastRoom = m;
        try { history.replaceState(null, '', `${location.pathname}${location.search}#room-${m.code}`); } catch { /* sandboxed */ }
        break;
      case 'lobby': if (state === 'queue' && !lastQueue) state = 'idle'; break;
      case 'error': error = m.message; if (m.code === 'no_room' || m.code === 'room_full') { state = 'idle'; lastRoom = null; } break;
      default: break;
    }
    render();
  };

  let off: (() => void) | null = null;
  return {
    el,
    mount: () => {
      mpLink.handler = onMsg;
      off = mpLink.onStatus(() => {
        render();
        if (mpLink.connected) {
          if (opts.joinCode) { mpLink.send({ type: 'joinRoom', code: opts.joinCode }); opts.joinCode = undefined; }
          if (opts.autoQueue) { mpLink.send({ type: 'queue', mode: opts.autoQueue }); opts.autoQueue = undefined; }
        }
      });
      void mpLink.connect().catch((e) => { error = `Could not connect: ${(e as Error).message}`; render(); });
      if (mpLink.connected) {
        if (opts.joinCode) { mpLink.send({ type: 'joinRoom', code: opts.joinCode }); opts.joinCode = undefined; }
        if (opts.autoQueue) { mpLink.send({ type: 'queue', mode: opts.autoQueue }); opts.autoQueue = undefined; }
      }
      render();
    },
    unmount: () => { off?.(); if (mpLink.handler === onMsg) mpLink.handler = null; },
  };
}
