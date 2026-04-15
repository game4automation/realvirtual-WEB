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
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private renderer: AnimationLoopRenderer | null;
  /** Sentinel: first renderer-driven tick sets the baseline time. */
  private rendererFirstTick = false;

  onFixedUpdate: (dt: number) => void = () => {};
  onRender: (frameTime: number) => void = () => {};

  constructor(renderer?: AnimationLoopRenderer) {
    this.renderer = renderer ?? null;
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

    this.accumulator += frameTime;
    while (this.accumulator >= this.fixedTimeStep) {
      this.onFixedUpdate(this.fixedTimeStep);
      this.accumulator -= this.fixedTimeStep;
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

    this.accumulator += frameTime;
    while (this.accumulator >= this.fixedTimeStep) {
      this.onFixedUpdate(this.fixedTimeStep);
      this.accumulator -= this.fixedTimeStep;
    }

    this.onRender(frameTime);
  }
}
