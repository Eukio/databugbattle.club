// Results screen (doc §Results screen).
import { getLastPracticeRun, practiceConfig } from '../../sim.ts';
import { h, rc } from '../dom.ts';
import type { Screen } from '../../main.ts';
import { go } from '../../app.ts';
import { kv } from '../../storage.ts';
import type { ResultsData } from './game.ts';

export function resultsScreen(d: ResultsData, retry?: () => void): Screen {
  const t = d.telemetry;
  const lost = t.powerLost;
  const W = 20;
  let headline: HTMLElement;
  if (d.kind === 'practice' && d.practice) {
    const p = d.practice;
    headline = h('div.res-compare',
      p.previousBest === null ? h('span', 'First run on this seed — this is your personal best.')
        : p.isNewBest ? h('span.good', `New personal best! Previous: ${p.previousBest} (+${d.score - p.previousBest})`)
          : h('span', `Personal best: ${p.previousBest} (${d.score - p.previousBest >= 0 ? '+' : ''}${d.score - p.previousBest})`));
  } else {
    const r = d.ranked!.result;
    headline = h('div.res-compare',
      r.rank ? h('span', `Rank `, h('strong', String(r.rank)), r.total ? ` of ${r.total}` : '', r.percentile !== null ? ` · top ${r.percentile}%` : '') : h('span', 'Verified, not ranked.'),
      r.verifiedScore !== d.score ? h('div.muted', `The server’s verified score (${r.verifiedScore}) differs from this device’s; the verified score counts.`) : null);
  }

  const replay = () => {
    if (d.kind === 'practice') {
      const last = getLastPracticeRun(kv, d.seedHex);
      const log = last?.log ?? d.log;
      go.replay(practiceConfig(d.seed, d.practice?.bugKeys), log, `Replay · ${d.seedHex}`, () => go.results(d, retry));
    } else {
      const rk = d.ranked!;
      go.replay({ mapSeed: rk.mapSeed, bugKeys: rk.bugKeys, kind: 'practice' }, d.log, `Your daily · ${rk.date}`, () => go.results(d, retry));
    }
  };

  const bugs = d.bugs;
  const totalBugCost = bugs.filter((b) => b.parent === null).reduce((s, b) => s + b.cost, 0);
  const bugRows = bugs.slice(0, 60).map((b) => h('tr',
    h('td.mono', `#${b.id}`),
    h('td', b.kind === 'dc' ? 'DC' : b.kind === 'land' ? 'Land' : `Spread from #${b.parent}`),
    h('td.mono', rc(b.cell, W)),
    h('td.num', String(b.spawnTurn)),
    h('td', b.curedTurn ? `cured t${b.curedTurn}` : 'left'),
    h('td.num', b.cost >= 10 ? String(Math.round(b.cost)) : b.cost.toFixed(1).replace(/\.0$/, '')),
    h('td.num', b.cureSpent ? String(b.cureSpent) : '—'),
    h('td', b.paid === null ? '' : b.paid ? h('span.good', 'paid') : h('span.muted', 'not worth it')),
  ));

  const el = h('div.screen.menu-screen', h('div.menu-card.wide',
    h('div.res-head',
      h('div', h('div.res-kicker', d.kind === 'ranked' ? `Daily · ${d.ranked!.date}` : `Practice · seed ${d.seedHex}`), h('div.res-score', String(d.kind === 'ranked' ? d.ranked!.result.verifiedScore : d.score)), h('div.muted', 'total power')),
      headline),
    h('div.res-grid',
      stat('First capture', t.firstCaptureTurn === null ? 'none' : `turn ${t.firstCaptureTurn}`),
      stat('Bugs', `${t.bugs.spawned} spawned · ${t.bugs.cured} cured · ${t.bugs.ignored} left`),
      stat('Lost to captures', String(lost.capture)),
      stat('Lost to short attacks', String(lost.shortAttack)),
      stat('Lost to cures', String(lost.cure)),
      stat('Lost to decrements', String(lost.decrement)),
    ),
    h('h3.section-title', 'Bugs ', h('span.muted.small', `estimated cost — decrements, lost production and missed land income, children included · total ≈ ${Math.round(totalBugCost)}${d.stranded ? ` · ${d.stranded} income stranded (no single bug)` : ''}`)),
    bugs.length ? h('div.table-scroll', h('table.table.compact',
      h('thead', h('tr', h('th', 'Bug'), h('th', 'Kind'), h('th', 'Cell'), h('th.num', 'Spawned'), h('th', 'Outcome'), h('th.num', 'Est. cost'), h('th.num', 'Cure spent'), h('th', 'Cure'))),
      h('tbody', ...bugRows))) : h('p.muted', 'No bugs this run.'),
    h('div.row.res-actions',
      d.kind === 'practice' && retry ? h('button.btn.btn-primary', { on: { click: retry } }, 'Retry') : null,
      h('button.btn', { on: { click: replay } }, 'Watch my replay'),
      d.kind === 'ranked' ? h('button.btn', { on: { click: () => go.leaderboard(d.ranked!.date) } }, 'Leaderboard') : null,
      h('button.btn.btn-ghost', { on: { click: () => go.menu() } }, 'Main menu'),
    ),
  ));
  return { el };
}

function stat(label: string, value: string): HTMLElement {
  return h('div.stat', h('div.stat-label', label), h('div.stat-value', value));
}
