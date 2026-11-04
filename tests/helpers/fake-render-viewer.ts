// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * fake-render-viewer — the shared fake for the render-mode tests (plan-761 §9.0).
 *
 * Reproduces the four viewer contracts the render-mode controller, the command
 * and the pill rely on, and emits the three events the pill subscribes to:
 *
 *  - `renderMode` getter/setter → emits `render-mode-changed`
 *  - `wireframe` getter/setter (the latent toggle) → emits `wireframe-changed`
 *  - `wireframeActive` = toggle AND editor mode — the APPLIED state, exactly
 *    `_wireframeApplied` in the real viewer
 *  - `hasCompute` (field, default false) + `renderModeContext`, read LIVE like
 *    the real getter (plan-762 F18; `backendRegistered` from the hook)
 *  - `modes.activeMode` + `setMode()` → emits `mode-changed` (the real viewer
 *    re-syncs the applied wireframe inside that handler, rv-viewer.ts:3605)
 *
 * Every lighting setter the controller pushes is RECORDED in `calls` (as
 * `name=value`, in call order), so a test can assert order and values without
 * a renderer.
 */

import type { RVViewer } from '../../src/core/rv-viewer';
import {
  getRaytracedBackend, inactiveRaytracedStats,
  type RaytracedBackend, type RaytracedBackendFactory, type RaytracedSceneHost, type RaytracedStats,
} from '../../src/core/engine/rv-raytraced-hook';

export interface FakeRenderViewerInit {
  renderMode?: string;
  wireframe?: boolean;
  mode?: string;
  /** Real-WebGPU flag of the fake (plan-762); default false = a WebGL viewer. */
  hasCompute?: boolean;
}

export type FakeRenderViewer = RVViewer & {
  /** Every setter call as `name=value`, in order. */
  calls: string[];
  /** Switch the app mode (emits `mode-changed`). */
  setMode(m: string): void;
  _mode: string;
  _rm: string;
  _wf: boolean;
};

const LIGHTING_SETTERS = [
  'toneMapping', 'toneMappingExposure', 'ambientColor', 'ambientIntensity',
  'dirLightColor', 'dirLightIntensity', 'shadowIntensity', 'shadowQuality',
  'dirLightEnabled', 'shadowEnabled', 'lightIntensity',
] as const;

export function fakeRenderViewer(init: FakeRenderViewerInit = {}): FakeRenderViewer {
  const listeners = new Map<string, Set<(data?: unknown) => void>>();
  const emit = (ev: string, data?: unknown): void => { listeners.get(ev)?.forEach((cb) => cb(data)); };
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = {
    _rm: init.renderMode ?? 'default',
    _wf: init.wireframe ?? false,
    _mode: init.mode ?? 'viewer',
    calls,
    hasCompute: init.hasCompute ?? false,
    // Read LIVE like the real getter (plan-762 F18).
    get renderModeContext() {
      return { hasCompute: v.hasCompute === true, backendRegistered: getRaytracedBackend() !== null };
    },
    get renderMode() { return v._rm; },
    set renderMode(m: string) { calls.push(`renderMode=${m}`); v._rm = m; emit('render-mode-changed', { mode: m }); },
    get wireframe() { return v._wf; },
    set wireframe(on: boolean) {
      if (v._wf === on) return;
      calls.push(`wireframe=${on}`); v._wf = on; emit('wireframe-changed', { on });
    },
    get wireframeActive() { return v._wf && v._mode === 'editor'; },
    modes: {
      get activeMode() { return v._mode; },
      has: () => true,
      setMode(m: string) { v.setMode(m); },
      list: () => [{ id: 'viewer' }, { id: 'editor' }],
      subscribe: () => () => {},
    },
    setMode(m: string) { const from = v._mode; v._mode = m; emit('mode-changed', { from, to: m }); },
    on(ev: string, cb: (data?: unknown) => void) {
      let set = listeners.get(ev);
      if (!set) { set = new Set(); listeners.set(ev, set); }
      set.add(cb);
      return () => { listeners.get(ev)?.delete(cb); };
    },
    emit,
    // The command registry's context builder reads these for scope 'none'.
    selectionManager: { getSnapshot: () => ({ selectedPaths: [], primaryPath: null }), clear() {}, selectPaths() {} },
    registry: { getNode: () => null },
  };
  for (const k of LIGHTING_SETTERS) {
    Object.defineProperty(v, k, {
      configurable: true,
      set(x: unknown) { calls.push(`${k}=${String(x)}`); },
      get() { return undefined; },
    });
  }
  return v as FakeRenderViewer;
}

/**
 * A fake that can carry a mounted `VisualTab` (plan-761 §9.4).
 *
 * `VisualTabBody` reads a handful of viewer fields at mount (renderer kind,
 * antialias, WebGPU flag, plugin lookup) and every slider writes a viewer
 * property. On top of {@link fakeRenderViewer} this gives those reads a
 * deterministic default and accepts — and records — every other write, so
 * the tab mounts without a renderer and a test can still assert what it
 * pushed. Unknown reads answer `undefined`, never a stand-in function, so a
 * capability check like `viewer.isWebGPU` stays honestly false.
 */
export function visualTabCapableFake(init: FakeRenderViewerInit = {}): FakeRenderViewer {
  const base = fakeRenderViewer(init) as unknown as Record<string | symbol, unknown>;
  Object.assign(base, {
    rendererKind: 'webgl',
    antialiasActive: true,
    isWebGPU: false,
    getPlugin: () => null,
    setSourceMarkersVisible() {},
    showDriveAxisGizmo: false,
    groups: null,
    leftPanelManager: { subscribe: () => () => {}, getSnapshot: () => ({ activePanel: null, activePanelWidth: 0 }), close() {}, open() {} },
  });
  const calls = base['calls'] as string[];
  return new Proxy(base, {
    get(target, prop) {
      return prop in target ? target[prop] : undefined;
    },
    set(target, prop, value) {
      if (prop in target) {
        target[prop] = value;
      } else {
        calls.push(`${String(prop)}=${String(value)}`);
        target[prop] = value;
      }
      return true;
    },
  }) as unknown as FakeRenderViewer;
}

// ─── Fake ray traced backend (plan-762 Phase 2) ──────────────────────────────

/** A recording fake of the private backend: counts every lifecycle call. */
export interface FakeRaytracedBackend extends RaytracedBackend {
  readonly calls: { setup: number; frame: number; afterRender: number; order: string[]; resize: Array<[number, number]>; resetHistory: number; dispose: number };
  /** The host the last `setup()` received. */
  host: RaytracedSceneHost | null;
  disposed: boolean;
}

/** Create a fake backend; `overrides` replace single methods (e.g. a gated `setup`). */
export function createFakeRaytracedBackend(overrides: Partial<RaytracedBackend> = {}): FakeRaytracedBackend {
  const calls = { setup: 0, frame: 0, afterRender: 0, order: [] as string[], resize: [] as Array<[number, number]>, resetHistory: 0, dispose: 0 };
  const fake: FakeRaytracedBackend = {
    calls,
    host: null,
    disposed: false,
    async setup(host: RaytracedSceneHost): Promise<void> {
      calls.setup++;
      fake.host = host;
      if (overrides.setup) await overrides.setup(host);
    },
    frame(): void {
      calls.frame++;
      calls.order.push('frame');
      overrides.frame?.();
    },
    afterRender(): void {
      calls.afterRender++;
      calls.order.push('afterRender');
      overrides.afterRender?.();
    },
    resize(width: number, height: number): void {
      calls.resize.push([width, height]);
    },
    resetHistory(): void { calls.resetHistory++; },
    stats(): RaytracedStats {
      return { ...inactiveRaytracedStats(), active: !fake.disposed };
    },
    dispose(): void {
      calls.dispose++;
      fake.disposed = true;
    },
  };
  return fake;
}

/** A factory that hands out a fresh {@link createFakeRaytracedBackend} per call. */
export const fakeRaytracedBackendFactory: RaytracedBackendFactory = async () => createFakeRaytracedBackend();
