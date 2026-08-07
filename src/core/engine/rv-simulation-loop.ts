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
    let frameTime = now - this.lastTime;
    this.lastTime = now;

    // Clamp frame time to avoid spiral of death
    if (frameTime > 0.1) frameTime = 0.1;

    if (this.isPaused || !this._integrationEnabled) {
      // Drain accumulator so on resume we don't do a catch-up burst that
      // would fast-forward drives, sensors, and logic steps by seconds.
      this.accumulator = 0;
    } else {
      this.accumulator += frameTime;
      let substeps = 0;
      while (this.accumulator >= this.fixedTimeStep && substeps < this.maxSubSteps) {
        this.onFixedUpdate(this.fixedTimeStep);
        this.accumulator -= this.fixedTimeStep;
        substeps++;
      }
      // Hit the sub-step ceiling: drop the unprocessed backlog so a slow frame
      // doesn't snowball into an ever-growing catch-up burst (real-time pacing).
      if (this.accumulator > this.fixedTimeStep) this.accumulator = 0;
    }

    this.onRender(frameTime);
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

    let frameTime = now - this.lastTime;
    this.lastTime = now;

    // Clamp frame time to avoid spiral of death
    if (frameTime > 0.1) frameTime = 0.1;

    if (this.isPaused || !this._integrationEnabled) {
      // Drain accumulator so on resume we don't do a catch-up burst that
      // would fast-forward drives, sensors, and logic steps by seconds.
      this.accumulator = 0;
    } else {
      this.accumulator += frameTime;
      let substeps = 0;
      while (this.accumulator >= this.fixedTimeStep && substeps < this.maxSubSteps) {
        this.onFixedUpdate(this.fixedTimeStep);
        this.accumulator -= this.fixedTimeStep;
        substeps++;
      }
      // Hit the sub-step ceiling: drop the unprocessed backlog so a slow frame
      // doesn't snowball into an ever-growing catch-up burst (real-time pacing).
      if (this.accumulator > this.fixedTimeStep) this.accumulator = 0;
    }

    this.onRender(frameTime);
  }
}
