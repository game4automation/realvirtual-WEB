// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, PerspectiveCamera, WebGLRenderer } from 'three';
import { PostProcessingManager, type PostProcessingHost } from '../src/core/rv-post-processing';

/**
 * Build a minimal host implementation. The real RVViewer provides one via
 * proxy getters; for testing the manager in isolation we just hand-roll a
 * matching shape. The `renderer` is a real WebGLRenderer so that the
 * EffectComposer can actually be constructed (it touches WebGL state at
 * `addPass()` time).
 */
function makeHost(overrides: Partial<PostProcessingHost> = {}): PostProcessingHost {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 100;
  const renderer = new WebGLRenderer({ canvas });
  renderer.setSize(200, 100, /* updateStyle */ false);
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 2, 0.01, 1000);
  const base: PostProcessingHost = {
    renderer,
    scene,
    camera,
    isWebGPU: false,
    antialiasActive: false,
    outlineHasOutlines: false,
    toonPassActive: false,
    markRenderDirty: () => { /* default noop */ },
  };
  return { ...base, ...overrides };
}

describe('PostProcessingManager — construction', () => {
  it('can be instantiated with a minimal host (no RVViewer required)', () => {
    const host = makeHost();
    const mgr = new PostProcessingManager(host);
    expect(mgr).toBeInstanceOf(PostProcessingManager);
    // No composer yet — lazy.
    expect(mgr.composer).toBeNull();
    expect(mgr.gtaoPass).toBeNull();
    expect(mgr.n8aoPass).toBeNull();
    // Default state mirrors the original RVViewer defaults.
    expect(mgr.aoMode).toBe('gtao');
    expect(mgr.bloomEnabled).toBe(false);
    expect(mgr.ssaoEnabled).toBe(true); // aoMode='gtao' → ssaoEnabled true
  });

  it('reports useComposer=false until something turns on', () => {
    const host = makeHost();
    const mgr = new PostProcessingManager(host);
    expect(mgr.useComposer).toBe(false);
  });
});

describe('PostProcessingManager — bloomEnabled side-effects', () => {
  let host: PostProcessingHost;
  let mgr: PostProcessingManager;
  let dirtyFn: () => void;
  let dirtyCalls: number;

  beforeEach(() => {
    dirtyCalls = 0;
    dirtyFn = () => { dirtyCalls++; };
    host = makeHost({ markRenderDirty: dirtyFn });
    mgr = new PostProcessingManager(host);
  });

  it('lazily creates the composer when bloomEnabled flips to true', () => {
    expect(mgr.composer).toBeNull();
    mgr.bloomEnabled = true;
    expect(mgr.composer).not.toBeNull();
    expect(mgr.bloomEnabled).toBe(true);
  });

  it('marks render dirty exactly once per state change', () => {
    mgr.bloomEnabled = true;
    expect(dirtyCalls).toBe(1);
    // Idempotent — setting to the same value is a no-op (matches original).
    mgr.bloomEnabled = true;
    expect(dirtyCalls).toBe(1);
    mgr.bloomEnabled = false;
    expect(dirtyCalls).toBe(2);
  });

  it('toggles the underlying bloom pass enabled flag once the composer exists', () => {
    mgr.bloomEnabled = true;
    const composer = mgr.composer!;
    // The bloom pass is one of the addPass entries — find it via the
    // strength field which only UnrealBloomPass exposes.
    const bloomPass = composer.passes.find((p) => (p as { strength?: number }).strength !== undefined);
    expect(bloomPass).toBeDefined();
    expect(bloomPass!.enabled).toBe(true);
    mgr.bloomEnabled = false;
    expect(bloomPass!.enabled).toBe(false);
  });

  it('skips composer creation on WebGPU', () => {
    const gpuHost = makeHost({ isWebGPU: true });
    const gpuMgr = new PostProcessingManager(gpuHost);
    gpuMgr.bloomIntensity = 0.24;
    gpuMgr.bloomEnabled = true;
    expect(gpuMgr.composer).toBeNull();
    // State still tracked so it re-applies if the renderer falls back later.
    expect(gpuMgr.bloomEnabled).toBe(true);
    // WebGL compatibility scaling must not leak into the separate WebGPU state.
    expect(gpuMgr.bloomIntensity).toBeCloseTo(0.24);
  });
});

describe('PostProcessingManager — bloom property setters', () => {
  it('applies the r171 bloom compatibility factor only inside the WebGL composer', () => {
    const mgr = new PostProcessingManager(makeHost());
    mgr.bloomEnabled = true; // ensures composer + bloomPass exist
    mgr.bloomIntensity = 1.5;
    expect(mgr.bloomIntensity).toBeCloseTo(1.5);
    const bloomPass = mgr.composer!.passes.find(
      (p) => (p as { strength?: number }).strength !== undefined,
    ) as unknown as { strength: number };
    expect(bloomPass.strength).toBeCloseTo(0.5);
    mgr.bloomThreshold = 0.42;
    expect(mgr.bloomThreshold).toBeCloseTo(0.42);
    mgr.bloomRadius = 0.7;
    expect(mgr.bloomRadius).toBeCloseTo(0.7);
  });

  it('preserves bloom settings assigned before the lazy pass exists', () => {
    const mgr = new PostProcessingManager(makeHost());
    mgr.bloomIntensity = 0.24;
    mgr.bloomThreshold = 0.91;
    mgr.bloomRadius = 0.35;

    mgr.bloomEnabled = true;

    const bloomPass = mgr.composer!.passes.find(
      (p) => (p as { strength?: number }).strength !== undefined,
    ) as unknown as { strength: number; threshold: number; radius: number };
    expect(mgr.bloomIntensity).toBeCloseTo(0.24);
    expect(bloomPass.strength).toBeCloseTo(0.08);
    expect(bloomPass.threshold).toBeCloseTo(0.91);
    expect(bloomPass.radius).toBeCloseTo(0.35);
  });

  it('returns defaults when no composer exists yet', () => {
    const mgr = new PostProcessingManager(makeHost());
    expect(mgr.bloomIntensity).toBeCloseTo(0.5);
    expect(mgr.bloomThreshold).toBeCloseTo(0.85);
    expect(mgr.bloomRadius).toBeCloseTo(0.4);
  });
});

describe('PostProcessingManager — aoMode transitions', () => {
  it('off → gtao ensures the composer and enables the GTAO pass', () => {
    const mgr = new PostProcessingManager(makeHost());
    mgr.aoMode = 'off';
    expect(mgr.aoMode).toBe('off');
    expect(mgr.composer).toBeNull();
    mgr.aoMode = 'gtao';
    expect(mgr.aoMode).toBe('gtao');
    expect(mgr.composer).not.toBeNull();
    expect(mgr.gtaoPass).not.toBeNull();
    expect(mgr.gtaoPass!.enabled).toBe(true);
  });

  it('gtao → off keeps the composer but disables the GTAO pass', () => {
    const mgr = new PostProcessingManager(makeHost());
    // Trigger composer creation
    mgr.aoMode = 'off';
    mgr.aoMode = 'gtao';
    expect(mgr.gtaoPass!.enabled).toBe(true);
    mgr.aoMode = 'off';
    expect(mgr.gtaoPass!.enabled).toBe(false);
  });

  it('marks render dirty on each transition', () => {
    let calls = 0;
    const mgr = new PostProcessingManager(makeHost({ markRenderDirty: () => { calls++; } }));
    mgr.aoMode = 'off';
    mgr.aoMode = 'gtao';
    // Two transitions away from the default 'gtao' → 'off' → 'gtao'
    expect(calls).toBe(2);
    // No-op when value unchanged
    mgr.aoMode = 'gtao';
    expect(calls).toBe(2);
  });

  it('on WebGPU just records the mode without building a composer', () => {
    const mgr = new PostProcessingManager(makeHost({ isWebGPU: true }));
    mgr.aoMode = 'off';
    mgr.aoMode = 'n8ao';
    expect(mgr.aoMode).toBe('n8ao');
    expect(mgr.composer).toBeNull();
  });
});

describe('PostProcessingManager — useComposer', () => {
  it('is true when AO is on', () => {
    const mgr = new PostProcessingManager(makeHost());
    // Default aoMode='gtao' but composer not yet built → useComposer false
    expect(mgr.useComposer).toBe(false);
    mgr.aoMode = 'off';
    mgr.aoMode = 'gtao'; // builds composer
    expect(mgr.useComposer).toBe(true);
  });

  it('is true when bloom is on', () => {
    const mgr = new PostProcessingManager(makeHost());
    mgr.aoMode = 'off';
    mgr.bloomEnabled = true;
    expect(mgr.useComposer).toBe(true);
  });

  it('respects outlineHasOutlines from the host', () => {
    let outlines = false;
    const base = makeHost();
    // Re-define the property as a live getter so the manager picks up the
    // mutation each time it reads it (matches how RVViewer's proxy does it).
    const host: PostProcessingHost = Object.create(base, {
      outlineHasOutlines: { get: () => outlines, enumerable: true },
    });
    const mgr = new PostProcessingManager(host);
    // Build composer first (so the !!composer guard isn't the limiter).
    mgr.aoMode = 'off';
    mgr.bloomEnabled = true;
    mgr.bloomEnabled = false;
    expect(mgr.useComposer).toBe(false);
    outlines = true;
    expect(mgr.useComposer).toBe(true);
  });

  it('is always false on WebGPU', () => {
    const mgr = new PostProcessingManager(makeHost({ isWebGPU: true }));
    mgr.bloomEnabled = true;
    expect(mgr.useComposer).toBe(false);
  });
});

describe('PostProcessingManager — isolate-overlay + desat resources', () => {
  it('ensureIsolateOverlay builds scene/cam/mat exactly once', () => {
    const mgr = new PostProcessingManager(makeHost());
    expect(mgr.isolateOverlayScene).toBeNull();
    mgr.ensureIsolateOverlay();
    const scene = mgr.isolateOverlayScene;
    const cam = mgr.isolateOverlayCam;
    const mat = mgr.isolateOverlayMat;
    expect(scene).not.toBeNull();
    expect(cam).not.toBeNull();
    expect(mat).not.toBeNull();
    // Idempotent — second call returns the same instances.
    mgr.ensureIsolateOverlay();
    expect(mgr.isolateOverlayScene).toBe(scene);
    expect(mgr.isolateOverlayCam).toBe(cam);
    expect(mgr.isolateOverlayMat).toBe(mat);
  });

  it('ensureDesatPass builds rt/scene/cam/mat exactly once', () => {
    const mgr = new PostProcessingManager(makeHost());
    expect(mgr.desatScene).toBeNull();
    mgr.ensureDesatPass();
    const rt = mgr.desatRT;
    const scene = mgr.desatScene;
    const cam = mgr.desatCam;
    const mat = mgr.desatMat;
    expect(rt).not.toBeNull();
    expect(scene).not.toBeNull();
    expect(cam).not.toBeNull();
    expect(mat).not.toBeNull();
    mgr.ensureDesatPass();
    expect(mgr.desatRT).toBe(rt);
    expect(mgr.desatScene).toBe(scene);
  });
});

describe('PostProcessingManager — dispose', () => {
  it('clears all owned resources and is idempotent', () => {
    const mgr = new PostProcessingManager(makeHost());
    mgr.bloomEnabled = true;       // builds composer
    mgr.ensureIsolateOverlay();
    mgr.ensureDesatPass();
    expect(mgr.composer).not.toBeNull();
    expect(mgr.isolateOverlayScene).not.toBeNull();
    expect(mgr.desatScene).not.toBeNull();
    mgr.dispose();
    expect(mgr.composer).toBeNull();
    expect(mgr.gtaoPass).toBeNull();
    expect(mgr.n8aoPass).toBeNull();
    expect(mgr.isolateOverlayScene).toBeNull();
    expect(mgr.isolateOverlayCam).toBeNull();
    expect(mgr.isolateOverlayMat).toBeNull();
    expect(mgr.desatRT).toBeNull();
    expect(mgr.desatScene).toBeNull();
    expect(mgr.desatCam).toBeNull();
    expect(mgr.desatMat).toBeNull();
    // Second dispose is a no-op (mustn't throw on null refs).
    expect(() => mgr.dispose()).not.toThrow();
  });
});

describe('PostProcessingManager — exported via rv-viewer barrel', () => {
  it('is re-exported from rv-viewer.ts (backwards-compat shim)', async () => {
    const mod = await import('../src/core/rv-viewer');
    expect(mod.PostProcessingManager).toBe(PostProcessingManager);
  });
});
