// Boot and screen router.
import './style.css';
import { probe, isOnline } from './net/api.ts';
import { getName } from './storage.ts';
import { go, activeMatch } from './app.ts';

export interface Screen {
  el: HTMLElement;
  mount?(): void;
  unmount?(): void;
}

let current: Screen | null = null;

export function show(s: Screen): void {
  current?.unmount?.();
  const app = document.getElementById('app')!;
  app.replaceChildren(s.el);
  current = s;
  s.mount?.();
  window.scrollTo(0, 0);
}

async function boot(): Promise<void> {
  await probe();
  const room = /^#room-([A-Za-z]{4})$/.exec(location.hash)?.[1];
  if (!getName()) go.name(true);
  else if (room && isOnline()) go.mpLobby({ joinCode: room.toUpperCase() });
  else if (activeMatch() && isOnline()) go.mpLobby(); // reconnecting puts us back in the match
  else go.menu();
}

// An invite link opened in a tab that already runs the game only changes the hash.
window.addEventListener('hashchange', () => {
  const room = /^#room-([A-Za-z]{4})$/.exec(location.hash)?.[1];
  if (room && getName() && isOnline()) go.mpLobby({ joinCode: room.toUpperCase() });
});

void boot();
