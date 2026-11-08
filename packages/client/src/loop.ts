// requestAnimationFrame + fixed-step accumulator (doc §Simulation clock). The accumulator holds at
// most one tic of backlog; after a longer stall the extra time is discarded. While the tab is hidden
// (rAF stops), a slow timer keeps the clock running for runs that no longer auto-pause.
export interface LoopHooks {
  canRun(): boolean;
  tick(): void;
  frame(now: number): void;
}

export class Loop {
  interval: number;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly hooks: LoopHooks;

  constructor(intervalMs: number, hooks: LoopHooks) { this.interval = intervalMs; this.hooks = hooks; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const onFrame = (now: number) => {
      if (!this.running) return;
      this.advance(now);
      this.hooks.frame(now);
      this.raf = requestAnimationFrame(onFrame);
    };
    this.raf = requestAnimationFrame(onFrame);
    this.timer = setInterval(() => { if (document.hidden) this.advance(performance.now()); }, 250);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Discard any accumulated time (after a pause, a hint, or a key wait). */
  reset(): void { this.acc = 0; this.last = performance.now(); }

  private advance(now: number): void {
    const dt = Math.max(0, now - this.last);
    this.last = now;
    if (!this.hooks.canRun()) { this.acc = 0; return; }
    this.acc = Math.min(this.acc + dt, 2 * this.interval);
    while (this.acc >= this.interval && this.hooks.canRun()) {
      this.acc -= this.interval;
      this.hooks.tick();
    }
  }
}
