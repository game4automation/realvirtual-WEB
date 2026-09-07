// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimulationLoop - Accumulator-based fixed timestep loop.
 *
 * Runs onFixedUpdate at a fixed rate (default 60Hz) regardless of frame rate,
 * then calls onRender once per frame. Same pattern as Unity's FixedUpdate.
 *
 * When a renderer with setAnimationLoop is provided (WebXR-capable), the loop
 * delegates frame scheduling to the renderer. Otherwise falls back to
 * requestAnimationFrame (legacy/desktop behavior).
 */

/** Minimal interface for a renderer that can drive the animation loop (e.g. WebGLRenderer). */
export interface AnimationLoopRenderer {
  setAnimationLoop(callback: ((time: DOMHighResTimeStamp) => void) | null): void;
}

export class SimulationLoop {
  fixedTimeStep = 1 / 60; // 16.67ms
  /** Hard ceiling on fixed-update sub-steps executed in a single frame. The
   *  0.1s frameTime clamp already bounds this to ~6, but an explicit cap makes
   *  the guarantee independent of the clamp and lets a heavy frame stay
   *  responsive instead of compounding into a catch-up spiral. Leftover
   *  accumulated time beyond the cap is dropped (sim prefers real-time pacing
   *  over replaying seconds of physics). */
  maxSubSteps = 6;
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private renderer: AnimationLoopRenderer | null;
  /** Sentinel: first renderer-driven tick sets the baseline time. */
  private rendererFirstTick = false;

  /** Active pause reasons — simulation runs only when this set is empty. Multiple
   *  systems can hold a pause simultaneously (AR placement, layout edit, shared-view,
   *  user button, etc.) and each must release its own reason before simulation resumes.
   *  Rendering is NOT affected — only onFixedUpdate is skipped while paused.
   */
  private _pauseReasons = new Set<string>();

  /** Time-integration master gate — INDEPENDENT of pause reasons. While false,
   *  onFixedUpdate is never invoked and the accumulator is drained each frame,
   *  so no fixed-update backlog can build up. Rendering continues. Owned by the
   *  SimulationRuntime: detached workspace modes (e.g. the asset editor) switch
   *  this off so no pause-reason bookkeeping (or `clearPauseReasons()`) can
   *  resurrect simulation there. */
  private _integrationEnabled = true;

  // ── Lost-simulation-time accounting (plan-465 F2/SOL #2) ──────────────
  /** Real seconds discarded by the 0.1 s frame-time clamp (spiral-of-death
   *  guard). Simulated time falls behind wall-clock by exactly this much. */
  private _clampedSeconds = 0;
  /** Real seconds discarded because the accumulator still held more than one
   *  fixed step after the `maxSubSteps` ceiling was hit (backlog drop). */
  private _droppedBacklogSeconds = 0;
  /** Real seconds during which time integration was intentionally off
   *  (pause reason held or `_integrationEnabled === false`). NOT a loss —
   *  reported separately so a paused tab is never counted as drift. */
  private _pausedSeconds = 0;

  onFixedUpdate: (dt: number) => void = () => {};
  onRender: (frameTime: number) => void = () => {};

  constructor(renderer?: AnimationLoopRenderer) {
    this.renderer = renderer ?? null;
  }

  /** True if any reason is currently holding the simulation paused. */
  get isPaused(): boolean { return this._pauseReasons.size > 0; }

  /** Snapshot of active pause reasons (for diagnostics / UI badges). */
  get pauseReasons(): readonly string[] { return [...this._pauseReasons]; }

  /**
   * Request or release a pause. Multiple reasons can be active simultaneously;
   * simulation resumes only after the last reason is released.
   *
   * @returns `true` if the overall pause state changed (idle ↔ paused), `false`
   *          if this call just added/removed a reason while others remained active.
   *          Callers can use this to emit transition events only once.
   */
  setPaused(reason: string, paused: boolean): boolean {
    const wasPaused = this.isPaused;
    if (paused) this._pauseReasons.add(reason);
    else this._pauseReasons.delete(reason);
    return wasPaused !== this.isPaused;
  }

  /** Whether fixed-update time integration is enabled (see {@link setIntegrationEnabled}). */
  get integrationEnabled(): boolean { return this._integrationEnabled; }

  /**
   * Master gate for fixed-update time integration, orthogonal to pause reasons.
   * `false` = fully detached: onFixedUpdate is never invoked, the accumulator is
   * drained each frame, rendering is unaffected. Unlike a pause reason this
   * cannot be released by `setPaused`/force-clearing — only by re-enabling here.
   */
  setIntegrationEnabled(enabled: boolean): void {
    this._integrationEnabled = enabled;
  }

  /** Real seconds dropped by the frame-time clamp since the last reset. */
  get clampedSeconds(): number { return this._clampedSeconds; }

  /** Real seconds dropped as fixed-update backlog since the last reset. */
  get droppedBacklogSeconds(): number { return this._droppedBacklogSeconds; }

  /** Real seconds spent paused / with integration disabled since the last reset. */
  get pausedSeconds(): number { return this._pausedSeconds; }

  /**
   * Simulated time lost relative to wall clock while the simulation was
   * *supposed* to run: clamp + backlog. Pause time is excluded on purpose —
   * a deliberately paused simulation has not drifted.
   */
  get lostSimSeconds(): number { return this._clampedSeconds + this._droppedBacklogSeconds; }

  /** Zero all lost-time counters (used by the perf probe between runs). */
  resetLostTimeCounters(): void {
    this._clampedSeconds = 0;
    this._droppedBacklogSeconds = 0;
    this._pausedSeconds = 0;
  }

  /**
   * Shared accumulator step for BOTH tick paths (`tick` and `tickFromRenderer`).
   *
   * Having exactly one implementation is the point: the two paths drifted apart
   * trivially before, and the lost-time counters must be identical in both
   * (plan-465, SOL #2). Returns the CLAMPED frame time the caller passes on to
   * `onRender`.
   */
  private advanceAccumulator(rawFrameTime: number): number {
    let frameTime = rawFrameTime;

    // Clamp frame time to avoid spiral of death — the discarded part is real
    // time the simulation will never see again.
    if (frameTime > 0.1) {
      this._clampedSeconds += frameTime - 0.1;
      frameTime = 0.1;
    }

    if (this.isPaused || !this._integrationEnabled) {
      // Drain accumulator so on resume we don't do a catch-up burst that
      // would fast-forward drives, sensors, and logic steps by seconds.
      this._pausedSeconds += frameTime;
      this.accumulator = 0;
      return frameTime;
    }

    this.accumulator += frameTime;
    let substeps = 0;
    while (this.accumulator >= this.fixedTimeStep && substeps < this.maxSubSteps) {
      this.onFixedUpdate(this.fixedTimeStep);
      this.accumulator -= this.fixedTimeStep;
      substeps++;
    }
    // Hit the sub-step ceiling: drop the unprocessed backlog so a slow frame
    // doesn't snowball into an ever-growing catch-up burst (real-time pacing).
    if (this.accumulator > this.fixedTimeStep) {
      this._droppedBacklogSeconds += this.accumulator;
      this.accumulator = 0;
    }
    return frameTime;
  }

  start() {
    this.running = true;
    if (this.renderer) {
      this.rendererFirstTick = true;
      this.renderer.setAnimationLoop((time: DOMHighResTimeStamp) => this.tickFromRenderer(time));
    } else {
      this.lastTime = performance.now() / 1000;
      this.tick();
    }
  }

  stop() {
    this.running = false;
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
    }
  }

  /** Legacy path: self-scheduling via requestAnimationFrame. */
  private tick = () => {
    if (!this.running) return;
    requestAnimationFrame(() => this.tick());

    const now = performance.now() / 1000;
    const rawFrameTime = now - this.lastTime;
    this.lastTime = now;

    this.onRender(this.advanceAccumulator(rawFrameTime));
  };

  /** Renderer-driven path: called by renderer.setAnimationLoop (supports WebXR). */
  private tickFromRenderer(time: DOMHighResTimeStamp) {
    if (!this.running) return;

    const now = time / 1000;

    // First tick: establish baseline, render a zero-delta frame
    if (this.rendererFirstTick) {
      this.rendererFirstTick = false;
      this.lastTime = now;
      this.onRender(0);
      return;
    }

    const rawFrameTime = now - this.lastTime;
    this.lastTime = now;

    this.onRender(this.advanceAccumulator(rawFrameTime));
  }
}
