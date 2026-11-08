// Development aid: ?speed=N runs the clock N× faster (pacing only; the simulation is unaffected).
export function devSpeed(): number {
  try {
    const v = Number(new URLSearchParams(location.search).get('speed'));
    return v > 0 && v <= 100 ? v : 1;
  } catch {
    return 1;
  }
}
