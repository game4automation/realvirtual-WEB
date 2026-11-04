// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Render strategy seam (plan-2215 Phase 2).
 *
 * A render strategy replaces the main scene pass of `RVViewer.render()` with
 * N camera views into N rectangles of the canvas (stereo side by side, a
 * display wall, ...). The seam is neutral: it knows rectangles and cameras,
 * nothing about eyes or walls. Exactly one strategy can be installed at a time
 * (`RVViewer.setRenderStrategy`); without one, the render path is unchanged.
 *
 * Contract:
 *  - `viewer.camera` stays the one navigation camera (controls, picking,
 *    capture, multiuser and MCP see only it). A strategy DERIVES its view
 *    cameras from it every frame and never writes back.
 *  - The strategy renders only when the viewer renders (render on demand):
 *    whoever changes a view parameter calls `viewer.markRenderDirty()`.
 *  - Captures and screenshots (`renderFrameForCapture`, video capture) stay
 *    mono; an XR session always wins over a strategy.
 *  - A throw from `renderFrame` removes the strategy, restores the render target
 *    bound at entry, renders the frame mono and then calls `onFailed(err)`
 *    exactly once (also when that mono render throws).
 *  - While a strategy draws, `viewer.pointerPickBlocked` is true: every pointer
 *    pick with `viewer.camera` from client coordinates finds nothing.
 */

import type { Camera, Scene, WebGLRenderer } from 'three';

/** A rectangle in renderer units, WebGL origin (bottom left) — the units of `renderer.setViewport`. */
export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the viewer hands a strategy for one frame. The object is reused across frames. */
export interface RenderStrategyContext {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  /** The navigation camera (`viewer.camera`) — read it, never modify it. */
  readonly monoCamera: Camera;
  /** Renderer size (`renderer.getSize`); at DPR 1 these are drawing-buffer pixels. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Render time of this frame in seconds. */
  readonly frameDt: number;
  /**
   * Render the scene and then the overlay layers into `rect` with `camera`
   * (viewport + scissor). The shadow map is updated by the first call of a
   * frame only. Viewport and scissor are reset by the viewer after the frame.
   */
  renderViewport(rect: Readonly<ViewportRect>, camera: Camera): void;
  /** The overlay-layer pass (highlights, measurements) with `camera` into the current viewport. */
  renderOverlayLayers(camera: Camera): void;
}

/** A replacement of the main scene pass. Installed with `RVViewer.setRenderStrategy`. */
export interface RenderStrategy {
  /** Read once per rendered frame; false = this frame renders mono. */
  readonly active: boolean;
  /** Render the complete frame (scene + overlay layers) through `ctx.renderViewport`. */
  renderFrame(ctx: RenderStrategyContext): void;
  /**
   * `renderFrame` threw. Called AFTER the viewer removed the strategy and rendered
   * the frame mono; the owner runs its one deactivation path.
   */
  onFailed(err: unknown): void;
  /** The canvas was resized (CSS pixels). */
  onResize?(width: number, height: number): void;
  /**
   * A fixed device pixel ratio while installed (e.g. 1 — every view renders the
   * scene again). The viewer applies it on install, keeps it against the
   * render-resolution setting and restores the previous DPR on removal
   * (also after a failure). Omitted = the DPR stays as it is.
   */
  readonly pixelRatio?: number;
  /** Optional fixed renderer size, independent of the canvas CSS display size. */
  readonly canvasSize?: { readonly width: number; readonly height: number };
}
