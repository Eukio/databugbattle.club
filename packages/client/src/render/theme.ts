// Visual tokens from the design doc's visual spec.
import type { DCStatus } from '../sim.ts';

export const C = {
  bg: '#0E1116',
  grid: '#0A0C10',
  land: '#1F242D',
  obstacle: '#4A4F59',
  neutralDC: '#6B7280',
  ownLand: '#1D4ED8',
  ownDC: '#3B82F6',
  frozen: 'rgba(103, 232, 249, 0.35)',
  frozenSolid: '#67E8F9',
  safeLevel: '#F8FAFC',
  vulnerable: '#C9A227',
  exposed: '#9B59B6',
  cureNeeded: '#E5484D',
  unprotected: '#F97316',
  atRisk: '#F5A524',
  protected: '#30A46C',
  cursor: '#FACC15',
  selected: '#FFFFFF',
  text: '#F8FAFC',
  muted: '#94A3B8',
} as const;

export const STATUS_COLOR: Record<DCStatus, string | null> = {
  safe: null,
  vulnerable: C.vulnerable,
  exposed: C.exposed,
  cureNeeded: C.cureNeeded,
  unprotected: C.unprotected,
  atRisk: C.atRisk,
  protected: C.protected,
};

export const STATUS_LABEL: Record<DCStatus, string> = {
  safe: 'Safe',
  vulnerable: 'Vulnerable',
  exposed: 'Exposed',
  cureNeeded: 'Cure needed',
  unprotected: 'Unprotected',
  atRisk: 'Protection at risk',
  protected: 'Protected',
};

export const PATH_COLORS = ['#FDE68A', '#A7F3D0', '#BFDBFE', '#FBCFE8', '#DDD6FE', '#FED7AA'];

export const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
export const SANS = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
