// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * pallet-yard-continuous-scene.ts — the REAL scenes/PalletYard.glb in the
 * CONTINUOUS kernel, for the plan-612 CP2 tests (9.7, 9.7a, lifecycle).
 *
 * A real test viewer as main.ts builds it for this scene: every behaviour
 * registered (roller conveyors, Agv, Sink), the snap-point plugin (the shipping
 * input conveyor hands over to `ConveyorOut_*` through its paired snap — without
 * the plugin the conveyor sees no successor and holds every pallet at its end
 * sensor), the placements materialised, then `resetSimulation()` (the
 * `simulation-start` that arms the continuous Agv fleet). The viewer loop is
 * paused; the test steps fixed ticks itself and runs the render pass's
 * `scene.updateMatrixWorld()` after each one (baked static nodes below a moving
 * vehicle get their world matrix only there — as in the app).
 *
 * Two ways to drive the yard:
 *   - `plugin: true` — the real `PalletYardPlugin` binds itself (mode switches,
 *     reset, TickStage.POST / onRender exactly as in the app);
 *   - otherwise the continuous backend is bound directly with `cfg` and its
 *     tick runs from a minimal plugin's `onFixedUpdatePost` (the same slot).
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { SnapPointPlugin } from '../../src/plugins/snap-point';
import { clearShared } from '../helpers/agv-harness';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { PalletYardConfig } from '../../src/plugins/models/PalletYard/layout';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard/index';
import { bindContinuousYard } from '@rv/plugins/models/PalletYard/continuous-bind';
import { startContinuousRuntime, type YardRun } from '@rv/plugins/models/PalletYard/yard-runtime';
import { type ContinuousHandover } from '@rv/core/fleet/continuous/handover';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';

export const TICK = 1 / 60;

export interface ContinuousYard {
  handle: TestViewerHandle;
  viewer: RVViewer;
  root: Object3D;
  /** The plugin (only with `plugin: true`). */
  plugin: PalletYardPlugin | null;
  /** The bound runtime (the plugin's current one with `plugin: true`). */
  readonly rt: YardRun;
  readonly be: ContinuousHandover;
  now(): number;
  /** `n` fixed ticks, each followed by the render pass's world-matrix update and the per-frame work. */
  tick(n?: number): void;
  /** Tick to sim time `t`. */
  runTo(t: number): void;
  /** Tick until `pred()` holds (checked every tick) or `limit` sim seconds passed. */
  runUntil(pred: () => boolean, limit: number): boolean;
  /** Direct mode: dispose the runtime, `resetSimulation()`, bind anew with `cfg` (same viewer, no reload). */
  rebind(cfg?: PalletYardConfig): void;
  dispose(): void;
}

export interface ContinuousYardOptions {
  plugin?: boolean;
  cfg?: PalletYardConfig;
  /** Called every tick after the per-frame work (tracing). */
  onTick?: () => void;
  /** Runs before the yard plugin is registered and the scene loaded (e.g. the planning plugin, plan-681). */
  before?: (viewer: TestViewerHandle['viewer']) => void;
}

/** Load the real scene in the continuous kernel and bind the yard (see the module doc). */
export async function loadContinuousYard(opts: ContinuousYardOptions = {}): Promise<ContinuousYard> {
  clearShared();
  const handle = await createTestViewer('webgl');
  const v = handle.viewer;
  v.loop.setPaused('pallet-yard-continuous', true);
  registerAllBehaviors(v.behaviors);
  const use = (p: unknown, origin?: string): void => { (v as unknown as { use(p: unknown, o?: string): void }).use(p, origin); };
  use(new SnapPointPlugin(), 'core');
  opts.before?.(v);
  const plugin = opts.plugin ? new PalletYardPlugin() : null;
  if (plugin) use(plugin);
  await v.loadModel(PALLET_YARD_URL);
  await v.whenSceneReady();
  await Promise.resolve();
  const root = (v as unknown as { currentModel: Object3D }).currentModel;
  v.scene.updateMatrixWorld(true);
  v.resetSimulation();   // simulation-start: arms the continuous fleet (and restarts a bound plugin)

  let direct: { rt: YardRun; be: ContinuousHandover } | null = null;
  const bind = (cfg?: PalletYardConfig): void => {
    const r = bindContinuousYard({
      root, transportManager: v.transportManager, drives: v.drives, simTime: () => v.simTime,
      signals: v.signalStore ?? null, cfg,
    });
    if (!r.ok) throw new Error(`continuous bind: ${r.missing.join(', ')}`);
    const rt = startContinuousRuntime(r.backend, { cfg, signals: v.signalStore ?? null });
    direct = { rt, be: r.backend };
  };
  if (!plugin) {
    bind(opts.cfg);
    use({ id: 'pallet-yard-test-tick', onFixedUpdatePost: () => { direct?.be.tick(); } });
  }
  const runtime = (): YardRun => {
    const rt = plugin ? plugin.runtime : direct!.rt;
    if (!rt) throw new Error('PalletYard not bound');
    return rt;
  };
  const y: ContinuousYard = {
    handle, viewer: v, root, plugin,
    get rt() { return runtime(); },
    get be() { return runtime().adapters as ContinuousHandover; },
    now: () => v.simTime,
    tick(n = 1): void {
      const vv = v as unknown as { _tickOnce(dt: number): void };
      for (let i = 0; i < n; i++) {
        vv._tickOnce(TICK);
        v.scene.updateMatrixWorld();
        if (plugin) plugin.onRender(); else direct!.rt.frame();
        opts.onTick?.();
      }
    },
    runTo(t: number): void { while (v.simTime < t - 1e-9) y.tick(); },
    runUntil(pred: () => boolean, limit: number): boolean {
      const end = v.simTime + limit;
      while (!pred()) {
        if (v.simTime >= end - 1e-9) return false;
        y.tick();
      }
      return true;
    },
    rebind(cfg?: PalletYardConfig): void {
      if (plugin) throw new Error('rebind: direct mode only');
      direct?.rt.dispose();
      direct = null;
      v.resetSimulation();
      bind(cfg);
    },
    dispose(): void {
      direct?.rt.dispose();
      handle.dispose();
      clearShared();
    },
  };
  return y;
}
