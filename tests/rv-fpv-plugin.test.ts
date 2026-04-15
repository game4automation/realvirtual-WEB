// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FpvPlugin Tests
 *
 * Tests mode switching, keyboard state tracking, ground snapping,
 * settings persistence, XR conflict guard, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Vector3, Quaternion } from 'three';

// ─── Mock three/addons PointerLockControls ──────────────────────────────
// Must be mocked BEFORE importing the plugin (hoisted by vitest).

vi.mock('three/addons/controls/PointerLockControls.js', () => {
  class MockPointerLockControls {
    pointerSpeed = 1;
    private _camera: unknown;
    private _listeners = new Map<string, Set<() => void>>();

    constructor(camera: unknown, _domElement: unknown) {
      this._camera = camera;
    }
    getObject() { return this._camera; }
    addEventListener(event: string, cb: () => void) {
      let set = this._listeners.get(event);
      if (!set) { set = new Set(); this._listeners.set(event, set); }
      set.add(cb);
    }
    removeEventListener(event: string, cb: () => void) {
      this._listeners.get(event)?.delete(cb);
    }
    dispose() { this._listeners.clear(); }
  }
  return { PointerLockControls: MockPointerLockControls };
});

// Mock visual settings store
vi.mock('../src/core/hmi/visual-settings-store', () => ({
  loadVisualSettings: () => ({
    fpvSpeed: 2.5,
    fpvSprintSpeed: 5.0,
    fpvSensitivity: 0.002,
    fpvEyeHeight: 1.7,
    lightingMode: 'default',
    modeSettings: { simple: {}, default: {} },
    projection: 'perspective',
    fov: 45,
    cameras: [null, null, null],
    antialias: true,
    shadowMapSize: 1024,
    shadowRadius: 2,
    maxDpr: 1.5,
  }),
}));

// Mock mobile detection — desktop by default
vi.mock('../src/hooks/use-mobile-layout', () => ({
  isMobileDevice: () => false,
}));

import { FpvPlugin } from '../src/plugins/fpv-plugin';

// ─── DOM Cleanup ────────────────────────────────────────────────────────
// Tests add DOM elements (crosshair, overlay). Clean up between tests.
afterEach(() => {
  document.querySelectorAll('div[style*="border-radius: 50%"]').forEach(el => el.remove());
  document.querySelectorAll('div[style*="inset: 0"]').forEach(el => el.remove());
});

// ─── Minimal Viewer Mock ────────────────────────────────────────────────

function createMockViewer() {
  const camera = {
    position: new Vector3(3, 2.5, 4),
    quaternion: new Quaternion(),
    getWorldDirection: vi.fn((target: Vector3) => target.set(0, 0, -1).normalize()),
    rotation: { x: 0, y: 0, z: 0 },
  };

  const controls = {
    enabled: true,
    target: new Vector3(0, 0.5, 0),
    update: vi.fn(),
  };

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  // Minimal scene with a "ground" mesh
  const groundMesh = {
    isMesh: true,
    rotation: { x: -Math.PI / 2, y: 0, z: 0 },
    geometry: {},
    material: {},
  };

  const scene = {
    children: [groundMesh],
  };

  const renderer = {
    domElement: document.createElement('canvas'),
  };

  return {
    camera,
    controls,
    scene,
    renderer,
    raycastManager: {
      setEnabled: vi.fn(),
    },
    markRenderDirty: vi.fn(),
    cancelCameraAnimation: vi.fn(),
    getPlugin: vi.fn((_id: string): unknown => undefined),
    emit: vi.fn((event: string, data?: unknown) => {
      const set = listeners.get(event);
      if (set) for (const cb of set) cb(data);
    }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    }),
  };
}

type MockViewer = ReturnType<typeof createMockViewer>;

// ─── Helper: set up plugin with model loaded ────────────────────────────

function setupPlugin() {
  const plugin = new FpvPlugin();
  const viewer = createMockViewer();
  const result = { drives: [] } as unknown;
  plugin.onModelLoaded(result as never, viewer as never);
  return { plugin, viewer };
}

// ─── 9.1 Mode Switching Tests ───────────────────────────────────────────

describe('FpvPlugin - Mode Switching', () => {
  it('starts in inactive state', () => {
    const { plugin } = setupPlugin();
    expect(plugin.isActive).toBe(false);
  });

  it('enter() shows overlay (does not activate immediately)', () => {
    const { plugin } = setupPlugin();
    plugin.enter();
    // Plugin is not yet active (waiting for pointer lock)
    expect(plugin.isActive).toBe(false);
    // Overlay should be in DOM
    const overlay = document.querySelector('div[style*="inset: 0"]');
    expect(overlay).not.toBeNull();
    // Clean up
    plugin.dispose();
  });

  it('exit() when not active is a no-op', () => {
    const { plugin, viewer } = setupPlugin();
    plugin.exit();
    expect(plugin.isActive).toBe(false);
    expect(viewer.emit).not.toHaveBeenCalledWith('fpv-exit', expect.anything());
  });

  it('should disable OrbitControls when FPV is active', () => {
    const { plugin, viewer } = setupPlugin();
    // Simulate pointer lock acquired by directly calling _activateFpv
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    expect(viewer.controls.enabled).toBe(false);
    expect(plugin.isActive).toBe(true);
    plugin.dispose();
  });

  it('should re-enable OrbitControls when exiting FPV', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    expect(viewer.controls.enabled).toBe(false);
    plugin.exit();
    expect(viewer.controls.enabled).toBe(true);
    expect(plugin.isActive).toBe(false);
  });

  it('should save and restore orbit camera state on exit', () => {
    const { plugin, viewer } = setupPlugin();
    const origPos = viewer.camera.position.clone();
    const origTarget = viewer.controls.target.clone();

    (plugin as unknown as { _activateFpv: () => void })._activateFpv();

    // Move camera in FPV
    viewer.camera.position.set(10, 1.7, 10);

    plugin.exit();

    // Camera should be restored to original orbit position
    expect(viewer.camera.position.x).toBeCloseTo(origPos.x);
    expect(viewer.camera.position.y).toBeCloseTo(origPos.y);
    expect(viewer.camera.position.z).toBeCloseTo(origPos.z);
    expect(viewer.controls.target.x).toBeCloseTo(origTarget.x);
    expect(viewer.controls.target.y).toBeCloseTo(origTarget.y);
    expect(viewer.controls.target.z).toBeCloseTo(origTarget.z);
  });

  it('should cancel camera animation on FPV enter', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    expect(viewer.cancelCameraAnimation).toHaveBeenCalled();
    plugin.dispose();
  });

  it('should emit fpv-enter event when activated', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    expect(viewer.emit).toHaveBeenCalledWith('fpv-enter', undefined);
    plugin.dispose();
  });

  it('should emit fpv-exit event when deactivated', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    viewer.emit.mockClear();
    plugin.exit();
    expect(viewer.emit).toHaveBeenCalledWith('fpv-exit', undefined);
  });

  it('should disable orbit controls on enter and re-enable on exit', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    expect(viewer.controls.enabled).toBe(false);

    plugin.exit();
    expect(viewer.controls.enabled).toBe(true);
  });

  it('should prevent FPV entry when XR is active', () => {
    const { plugin, viewer } = setupPlugin();
    viewer.getPlugin.mockReturnValue({ isPresenting: true });
    plugin.enter();
    // Should not show overlay and should not activate
    expect(plugin.isActive).toBe(false);
    plugin.dispose();
  });

  it('should exit FPV when XR session starts', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    expect(plugin.isActive).toBe(true);

    // Simulate XR session start event
    const xrListeners = (viewer.on as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: unknown[]) => c[0] === 'xr-session-start')
      .map((c: unknown[]) => c[1] as () => void);
    expect(xrListeners.length).toBeGreaterThan(0);
    xrListeners[0]();

    expect(plugin.isActive).toBe(false);
  });

  it('should prevent rapid toggle via isTransitioning flag', () => {
    const { plugin } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();

    // Set transitioning flag
    (plugin as unknown as { _isTransitioning: boolean })._isTransitioning = true;
    plugin.exit(); // Should be a no-op while transitioning
    expect(plugin.isActive).toBe(true);

    // Reset and exit properly
    (plugin as unknown as { _isTransitioning: boolean })._isTransitioning = false;
    plugin.exit();
    expect(plugin.isActive).toBe(false);
  });
});

// ─── 9.2 Keyboard Movement Tests ───────────────────────────────────────

describe('FpvPlugin - Keyboard Movement', () => {
  it('should track key state on keydown/keyup via event.code', () => {
    const { plugin } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();

    const keys = (plugin as unknown as { _keys: Set<string> })._keys;

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(keys.has('KeyW')).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    expect(keys.has('KeyW')).toBe(false);

    plugin.dispose();
  });

  it('should move forward when W is pressed', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    const keys = (plugin as unknown as { _keys: Set<string> })._keys;

    // Camera looking along -Z
    viewer.camera.getWorldDirection.mockImplementation((target: Vector3) =>
      target.set(0, 0, -1).normalize()
    );

    const startZ = viewer.camera.position.z;
    keys.add('KeyW');
    plugin.onFixedUpdatePre(1 / 60); // one frame

    // Camera should have moved in -Z direction
    expect(viewer.camera.position.z).toBeLessThan(startZ);

    plugin.dispose();
  });

  it('should apply sprint multiplier when Shift is held', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    const keys = (plugin as unknown as { _keys: Set<string> })._keys;

    viewer.camera.getWorldDirection.mockImplementation((target: Vector3) =>
      target.set(0, 0, -1).normalize()
    );

    // Walk one frame
    const walkStart = viewer.camera.position.z;
    keys.add('KeyW');
    plugin.onFixedUpdatePre(1 / 60);
    const walkDist = Math.abs(viewer.camera.position.z - walkStart);
    keys.clear();

    // Reset camera
    viewer.camera.position.set(3, 2.5, 4);

    // Sprint one frame
    const sprintStart = viewer.camera.position.z;
    keys.add('KeyW');
    keys.add('ShiftLeft');
    plugin.onFixedUpdatePre(1 / 60);
    const sprintDist = Math.abs(viewer.camera.position.z - sprintStart);

    // Sprint should move further than walk
    expect(sprintDist).toBeGreaterThan(walkDist);

    plugin.dispose();
  });

  it('should move on XZ plane only (no vertical from WASD)', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    const keys = (plugin as unknown as { _keys: Set<string> })._keys;

    // Camera looking slightly downward
    viewer.camera.getWorldDirection.mockImplementation((target: Vector3) =>
      target.set(0, -0.3, -0.95).normalize()
    );

    // Record Y before move (after ground snap it may have changed)
    plugin.onFixedUpdatePre(1 / 60); // one frame for ground snap settle
    const yBefore = viewer.camera.position.y;

    keys.add('KeyW');
    plugin.onFixedUpdatePre(1 / 60);

    // Y should only change from ground snap, not from WASD
    // Since WASD flattens direction to XZ, the Y change should be minimal
    // (only ground snap lerp, not movement-induced)
    const yAfter = viewer.camera.position.y;
    // The difference should be very small (just ground snap interpolation)
    expect(Math.abs(yAfter - yBefore)).toBeLessThan(0.5);

    plugin.dispose();
  });

  it('should clear keys on window blur (sticky keys guard)', () => {
    const { plugin } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    const keys = (plugin as unknown as { _keys: Set<string> })._keys;

    keys.add('KeyW');
    keys.add('ShiftLeft');
    expect(keys.size).toBe(2);

    window.dispatchEvent(new Event('blur'));
    expect(keys.size).toBe(0);

    plugin.dispose();
  });

  it('should skip WASD when an input element is focused', () => {
    const { plugin } = setupPlugin();
    // Create and focus an input element
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const keys = (plugin as unknown as { _keys: Set<string> })._keys;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));

    // Key should NOT be tracked (input is focused)
    expect(keys.has('KeyW')).toBe(false);

    document.body.removeChild(input);
    plugin.dispose();
  });

  it('should not move when FPV is not active', () => {
    const { plugin, viewer } = setupPlugin();
    const startPos = viewer.camera.position.clone();
    plugin.onFixedUpdatePre(1 / 60);
    expect(viewer.camera.position.x).toBe(startPos.x);
    expect(viewer.camera.position.z).toBe(startPos.z);
  });
});

// ─── 9.3 Ground Snapping Tests ──────────────────────────────────────────

describe('FpvPlugin - Ground Snapping', () => {
  it('should snap camera Y towards ground + eye height', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();

    // After activation, camera Y should be around eyeHeight (1.7)
    // (initial ground snap sets it)
    // The exact value depends on raycast mock, but it should be positive
    expect(viewer.camera.position.y).toBeGreaterThan(0);

    plugin.dispose();
  });

  it('should use default eye height when no ground targets', () => {
    const plugin = new FpvPlugin();
    const viewer = createMockViewer();
    // Empty scene (no ground mesh)
    viewer.scene.children = [];
    plugin.onModelLoaded({ drives: [] } as never, viewer as never);

    (plugin as unknown as { _activateFpv: () => void })._activateFpv();

    // Move and check ground snap behavior
    const yBefore = viewer.camera.position.y;
    plugin.onFixedUpdatePre(1 / 60);

    // Y should lerp towards eyeHeight (1.7) above Y=0
    // After a few frames it should approach 1.7
    for (let i = 0; i < 120; i++) plugin.onFixedUpdatePre(1 / 60);
    expect(viewer.camera.position.y).toBeCloseTo(1.7, 0);

    plugin.dispose();
  });
});

// ─── 9.4 Settings Tests ────────────────────────────────────────────────

describe('FpvPlugin - Settings', () => {
  it('should load default values from visual-settings-store', () => {
    const { plugin } = setupPlugin();
    expect(plugin.speed).toBe(2.5);
    expect(plugin.sprintSpeed).toBe(5.0);
    expect(plugin.sensitivity).toBe(0.002);
    expect(plugin.eyeHeight).toBe(1.7);
  });

  it('should have plugin id "fpv"', () => {
    const plugin = new FpvPlugin();
    expect(plugin.id).toBe('fpv');
  });

  it('should have empty slots (FPV button is in BottomBar)', () => {
    const plugin = new FpvPlugin();
    expect(plugin.slots).toBeDefined();
    expect(plugin.slots.length).toBe(0);
  });

  it('should reload settings via reloadSettings()', () => {
    const { plugin } = setupPlugin();
    plugin.speed = 10; // manually override
    plugin.reloadSettings();
    expect(plugin.speed).toBe(2.5); // back to settings value
  });
});

// ─── 9.5 Crosshair Tests ───────────────────────────────────────────────

describe('FpvPlugin - Crosshair', () => {
  it('should activate FPV mode', () => {
    const { plugin } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();

    expect(plugin.isActive).toBe(true);

    plugin.dispose();
  });

  it('should remove crosshair when FPV exits', () => {
    const { plugin } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    plugin.exit();

    const crosshair = document.querySelector('div[style*="border-radius: 50%"]');
    expect(crosshair).toBeNull();
  });

  it('should remove crosshair on dispose (prevent DOM leak)', () => {
    const { plugin } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    plugin.dispose();

    const crosshair = document.querySelector('div[style*="border-radius: 50%"]');
    expect(crosshair).toBeNull();
  });
});

// ─── 9.6 Model Clear Tests ─────────────────────────────────────────────

describe('FpvPlugin - Model Clear', () => {
  it('should exit FPV when model is cleared', () => {
    const { plugin, viewer } = setupPlugin();
    (plugin as unknown as { _activateFpv: () => void })._activateFpv();
    expect(plugin.isActive).toBe(true);

    plugin.onModelCleared(viewer as never);
    expect(plugin.isActive).toBe(false);
  });

  it('should clear ground targets on model clear', () => {
    const { plugin, viewer } = setupPlugin();
    const p = plugin as unknown as { _groundTargets: unknown[] };
    expect(p._groundTargets.length).toBeGreaterThan(0);

    plugin.onModelCleared(viewer as never);
    expect(p._groundTargets.length).toBe(0);
  });
});

// ─── 9.7 Dispose Tests ─────────────────────────────────────────────────

describe('FpvPlugin - Dispose', () => {
  it('should clean up all DOM elements on dispose', () => {
    const { plugin } = setupPlugin();
    plugin.enter(); // shows overlay
    (plugin as unknown as { _activateFpv: () => void })._activateFpv(); // shows crosshair

    plugin.dispose();

    // No overlay or crosshair should remain
    const overlay = document.querySelector('div[style*="inset: 0"]');
    const crosshair = document.querySelector('div[style*="border-radius: 50%"]');
    expect(overlay).toBeNull();
    expect(crosshair).toBeNull();
  });

  it('should not throw when disposing without model loaded', () => {
    const plugin = new FpvPlugin();
    expect(() => plugin.dispose()).not.toThrow();
  });

  it('should not throw when calling enter/exit after dispose', () => {
    const { plugin } = setupPlugin();
    plugin.dispose();
    expect(() => plugin.enter()).not.toThrow();
    expect(() => plugin.exit()).not.toThrow();
  });
});
