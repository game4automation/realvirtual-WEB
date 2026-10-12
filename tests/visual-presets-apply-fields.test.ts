// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-591 §9.1 — the paths on which a preset apply used to stay incomplete.
 *
 * Three of the four are here (the fourth, the touch antialias veto, belongs to
 * plan-592):
 *
 *  - **F2** `applyVisualSettings` never set `maxDpr` — a preset switch left the
 *    resolution wherever the previous one had put it.
 *  - **F11** an already-created `EffectComposer` kept its own pixel ratio, so
 *    the beauty pass got sharp while the AO / bloom buffers stayed coarse.
 *  - **F10** with the editor wireframe applied, the per-FRAME suppression
 *    switched shadows / AO / reflection straight back off after the apply,
 *    while `matchPreset` still reported "Default".
 *
 * A REAL viewer, deliberately: `maxDpr` is setter-only and ends in
 * `renderer.setPixelRatio`, and F11 is about the actual RenderTarget sizes. A
 * fake with a readable `maxDpr` property would have asserted nothing (SOL #9).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WebGLRenderTarget } from 'three';
import {
  loadVisualSettings, saveVisualSettings, getDefaultVisualSettings,
  type VisualSettings,
} from '../src/core/hmi/visual-settings-store';
import {
  applyVisualPreset, VISUAL_PRESET_FIELDS, type VisualPreset,
} from '../src/core/hmi/visual-presets';
import { setAppConfig } from '../src/core/rv-app-config';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

/** A preset that only sets the named fields (the overlay semantics of apply). */
function preset(name: string, settings: Record<string, unknown>): VisualPreset {
  return { name, schemaVersion: 1, settings: settings as unknown as VisualPreset['settings'] };
}

/** Render exactly one frame. `render()` is private on RVViewer (the loop owns
 *  it), but the per-frame wireframe suppression is the subject here, so the
 *  frame has to be driven by hand. */
function renderOneFrame(v: RVViewer): void {
  (v as unknown as { render(): void }).render();
}

/** The composer's private geometry — the only place the real buffer size lives. */
interface ComposerView {
  _width: number;
  _height: number;
  _pixelRatio: number;
  renderTarget1: WebGLRenderTarget;
  renderTarget2: WebGLRenderTarget;
}

beforeEach(() => { localStorage.clear(); setAppConfig({}); });
afterEach(() => { localStorage.clear(); setAppConfig({}); });

describe('applyVisualSettings applies every preset field', () => {
  let handle: TestViewerHandle;
  let viewer: RVViewer;

  beforeAll(async () => {
    handle = await createTestViewer('webgl', { width: 320, height: 240 });
    viewer = handle.viewer;
    // The applied wireframe exists only in editor mode (`wireframeActive` =
    // toggle AND editor), and a bare test viewer has no modes registered — the
    // plugins normally bring them. Registering the two keeps the F10 case on the
    // REAL per-frame suppression path instead of faking the state it guards.
    viewer.modes.register({ id: 'viewer', label: 'Viewer' });
    viewer.modes.register({ id: 'editor', label: 'Editor', runtime: 'detached' });
  }, 120_000);
  afterAll(() => handle?.dispose());

  it('applies maxDpr — the regression: Fast → Default left the DPR behind (F2)', () => {
    const base: VisualSettings = { ...getDefaultVisualSettings(), maxDpr: 0.5 };
    viewer.applyVisualSettings(base);
    const low = viewer.effectiveDpr;
    expect(low).toBeCloseTo(Math.min(window.devicePixelRatio, 0.5), 6);

    // The actual bug: the SECOND apply, with a different maxDpr, used to be
    // ignored entirely because the field was never read here.
    viewer.applyVisualSettings({ ...base, maxDpr: 1.5 });
    expect(viewer.effectiveDpr).toBeCloseTo(Math.min(window.devicePixelRatio, 1.5), 6);
    expect(viewer.effectiveDpr).not.toBeCloseTo(low, 6);

    // maxDpr >= 2 means "native", not "clamp to 2".
    viewer.applyVisualSettings({ ...base, maxDpr: 2 });
    expect(viewer.effectiveDpr).toBeCloseTo(window.devicePixelRatio, 6);
  });

  it('resizes an EXISTING composer on a DPR change, in BOTH directions (F11)', () => {
    // The reported path: Fast → Shaded (a composer comes into being) → Max Quality.
    viewer.applyVisualSettings({ ...getDefaultVisualSettings(), maxDpr: 0.5 });
    viewer._ensureComposer();
    const composer = viewer._composer as unknown as ComposerView | null;
    expect(composer, 'the WebGL test viewer must have a composer').not.toBeNull();
    const c = composer!;
    const scale = (viewer as unknown as {
      _postProcessing: { bufferScale: number };
    })._postProcessing.bufferScale;

    const low = viewer.effectiveDpr;
    expect(c._pixelRatio).toBeCloseTo(low, 6);
    const lowTargetWidth = c.renderTarget1.width;

    // Up.
    viewer.applyVisualSettings({ ...getDefaultVisualSettings(), maxDpr: 2 });
    const high = viewer.effectiveDpr;
    expect(high).toBeGreaterThan(low);
    expect(c._pixelRatio).toBeCloseTo(high, 6);
    // The REAL target size, not just the setter.
    expect(c.renderTarget1.width).toBeGreaterThan(lowTargetWidth);
    expect(c.renderTarget1.width).toBe(Math.round(c._width * high));

    // And the buffer scale survived the resize — `setPixelRatio` resets every
    // pass to full resolution, so re-applying it is the load-bearing half.
    expect((viewer as unknown as {
      _postProcessing: { bufferScale: number };
    })._postProcessing.bufferScale).toBe(scale);

    // Down again.
    viewer.applyVisualSettings({ ...getDefaultVisualSettings(), maxDpr: 0.5 });
    expect(c._pixelRatio).toBeCloseTo(viewer.effectiveDpr, 6);
    expect(c.renderTarget1.width).toBe(lowTargetWidth);
  });

  it('a DPR apply without a composer is a no-op, not a crash (WebGPU shape)', () => {
    // `syncPixelRatio` must never CREATE a composer — on WebGPU there is none
    // at all, and before the first post pass there is none yet either.
    const pp = (viewer as unknown as { _postProcessing: { syncPixelRatio(): void } })._postProcessing;
    expect(() => pp.syncPixelRatio()).not.toThrow();
  });

  it('clears the APPLIED wireframe before applying, so the next frame keeps shadows (F10)', () => {
    viewer.modes.setMode('editor');
    viewer.applyVisualSettings({ ...getDefaultVisualSettings(), renderMode: 'default' });
    viewer.wireframe = true;
    expect(viewer.wireframeActive).toBe(true);
    // One frame with the wireframe on: the per-frame pass banks and clears them.
    renderOneFrame(viewer);
    expect(viewer.shadowEnabled).toBe(false);

    applyVisualPreset(viewer, preset('Default', {
      renderMode: 'default', shadowMapSize: 2048, aoMode: 'gtao', reflectionEnabled: true,
      modeSettings: { default: { shadowEnabled: true, dirLightEnabled: true } },
    }));
    expect(viewer.wireframeActive).toBe(false);

    // The point of F10: not the state right after the apply, but the state
    // after the NEXT frame — that is when the suppression used to strike again.
    renderOneFrame(viewer);
    expect(viewer.shadowEnabled).toBe(true);
    expect(viewer.aoMode).not.toBe('off');

    viewer.wireframe = false;
    viewer.modes.setMode('viewer');
  });

  it('leaves a LATENT wireframe toggle outside the editor alone (F10 boundary)', () => {
    // In viewer mode the toggle is a setting the user will find again in the
    // editor; only the APPLIED state is a rendering fact to clear.
    viewer.modes.setMode('viewer');
    viewer.wireframe = true;
    expect(viewer.wireframeActive).toBe(false);
    applyVisualPreset(viewer, preset('Default', { renderMode: 'default' }));
    expect(viewer.wireframe).toBe(true);
    viewer.wireframe = false;
  });

  it('every VISUAL_PRESET_FIELDS entry is accounted for in the field/effect matrix', () => {
    // The guard against the next field being forgotten the way `maxDpr` was.
    // Four honest categories instead of pretending every field is a viewer
    // setter: coupled `modeSettings` fields are deliberately NOT forced.
    const MATRIX: Record<string, 'viewer-setter' | 'constructor-only' | 'css' | 'coupled'> = {
      renderMode: 'viewer-setter',
      modeSettings: 'coupled',       // via settings.modeSettings[renderMode]
      projection: 'viewer-setter',
      fov: 'viewer-setter',
      antialias: 'constructor-only', // renderer creation — hence the reload hint
      shadowMapSize: 'viewer-setter',
      shadowRadius: 'viewer-setter',
      maxDpr: 'viewer-setter',       // plan-591 F2: this one was MISSING
      aoMode: 'viewer-setter',
      ssaoIntensity: 'viewer-setter',
      ssaoRadius: 'viewer-setter',
      bloomEnabled: 'viewer-setter',
      bloomIntensity: 'viewer-setter',
      bloomThreshold: 'viewer-setter',
      bloomRadius: 'viewer-setter',
      toonBands: 'viewer-setter',
      toonMetallic: 'viewer-setter',
      toonMetallicColor: 'viewer-setter',
      toonAlbedoMinBrightness: 'viewer-setter',
      toonAlbedoMaxBrightness: 'viewer-setter',
      toonAlbedoSaturation: 'viewer-setter',
      toonOutlineAmount: 'viewer-setter',
      toonOutlineThickness: 'viewer-setter',
      toonOutlineThreshold: 'viewer-setter',
      toonOutlineDistance: 'viewer-setter',
      toonOutlineSupersample: 'viewer-setter',
      toonOutlineColor: 'viewer-setter',
      toonCoolShadows: 'viewer-setter',
      groundEnabled: 'viewer-setter',
      groundBrightness: 'viewer-setter',
      groundColor: 'viewer-setter',
      backgroundBrightness: 'viewer-setter',
      checkerContrast: 'viewer-setter',
      reflectionEnabled: 'viewer-setter',
      reflectionStrength: 'viewer-setter',
      reflectionBlur: 'viewer-setter',
      envReflectionsEnabled: 'viewer-setter',
      envReflectionsIntensity: 'viewer-setter',
      uiBlurScale: 'css',             // saveVisualSettings → CSS custom property
    };
    const unmatched = VISUAL_PRESET_FIELDS.filter((f) => !MATRIX[f]);
    expect(unmatched, `new preset field(s) without a decision on WHERE they take effect: ${unmatched.join(', ')}`)
      .toEqual([]);
    // And no stale entries either — the matrix is a mirror, not a wish list.
    const stale = Object.keys(MATRIX).filter((k) => !(VISUAL_PRESET_FIELDS as readonly string[]).includes(k));
    expect(stale, `matrix entries for fields that no longer exist: ${stale.join(', ')}`).toEqual([]);
  });

  it('a preset apply persists maxDpr AND pushes it to the renderer (the whole F2 chain)', () => {
    saveVisualSettings({ ...getDefaultVisualSettings(), maxDpr: 0.5 });
    viewer.applyVisualSettings(loadVisualSettings());
    applyVisualPreset(viewer, preset('Default', { maxDpr: 2 }));
    expect(loadVisualSettings().maxDpr).toBe(2);
    expect(viewer.effectiveDpr).toBeCloseTo(window.devicePixelRatio, 6);
  });
});
