// SPDX-License-Identifier: AGPL-3.0-only
import * as coursePlugin from '../../src/plugins/models/AGVDemo';
import * as factoryPlugin from '../../src/plugins/models/AGVFactory';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { SnapPointPlugin } from '../../src/plugins/snap-point';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard';
import type { YardKpiRun } from '../../src/plugins/models/PalletYard/yard-order-kpis';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { WebComponentPlugin } from '../../src/plugins/web-component-plugin';
import { createParityHost } from '../helpers/parity-harness';
import { clearShared } from '../helpers/agv-harness';
import type { ContinuationEvent, ContinuationWorld } from '../helpers/des-continuation-harness';
import { continuationWorld } from './continuation-world-fixture';
import { ACTION_INDEX } from '../../src/plugins/des/rv-des-named-actions';

export const SCENES = ['PalletYard', 'DemoRealvirtualWeb', 'LaserWeldingAssemblyStation',
  'AGVDemo', 'AGVFactory', 'Course', 'Test-DES-Turntable-Loop', 'DemoPlanner'] as const;
export type Scene = typeof SCENES[number];
export interface SceneOptions {
  failures?: Array<{ desIdMatch: RegExp | string; at: number; until: number }>;
  hidden?: boolean;
  /** Called on the fresh viewer before the model loads (e.g. install a plugin). */
  setup?(v: import('../../src/core/rv-viewer').RVViewer): void;
  /** Awaited after the scene is wired and before DES mode starts (e.g. programs deployed). */
  ready?(v: import('../../src/core/rv-viewer').RVViewer): Promise<void>;
}

const bytes = new Map<Scene, Promise<ArrayBuffer>>();
const urlOf = (scene: Scene) => scene === 'Course' ? '/demo-realvirtual/library/Custom/Course.glb' : `/demo-realvirtual/${scene}.glb`;
function sceneBytes(scene: Scene): Promise<ArrayBuffer> {
  let pending = bytes.get(scene);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(urlOf(scene));
      if (!response.ok) throw new Error(`${scene}: HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      if (new TextDecoder().decode(new Uint8Array(data, 0, 4)) !== 'glTF') {
        throw new Error(`${scene}: expected real GLB bytes`);
      }
      return data;
    })();
    bytes.set(scene, pending);
  }
  return pending;
}

/** Real loader, fresh owners and blob URL, paused viewer loop. */
export async function sceneWorld(scene: Scene, opts: SceneOptions = {}) {
  const data = await sceneBytes(scene);
  clearShared(); resetDESMUCounter();
  (globalThis as { __rvFleetDesClockGen?: number }).__rvFleetDesClockGen = 0;
  const host = await createParityHost();
  const v = host.viewer;
  const blob = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
  const modelPlugin = scene === 'Course' ? coursePlugin : scene === 'AGVFactory' ? factoryPlugin : null;
  const dispose = () => {
    try { modelPlugin?.unregisterModelPlugins(); }
    finally {
      try { host.dispose(); }
      finally { URL.revokeObjectURL(blob); clearShared(); }
    }
  };
  try {
    registerAllBehaviors(v.behaviors);
    opts.setup?.(v as unknown as import('../../src/core/rv-viewer').RVViewer);
    v.use(new SnapPointPlugin());
    const yard = scene === 'PalletYard' ? new PalletYardPlugin() : null;
    if (yard) v.use(yard);
    await v.loadModel(blob, { modelName: `${scene}.glb`, identityUrl: urlOf(scene) });
    await v.whenSceneReady();
    await v.getPlugin<WebComponentPlugin>('web-component')?.whenWired();
    v.scene.updateMatrixWorld(true);
    await opts.ready?.(v as unknown as import('../../src/core/rv-viewer').RVViewer);
    v.simulationKernel!.setMode('des');
    await Promise.resolve();
    await whenDocumentHashesSettled();
    await Promise.resolve();
    const runner = v.simulationKernel!.desControl() as unknown as DESRunner;
    if (!runner) throw new Error(`${scene}: no DES runner`);
    modelPlugin?.registerModelPlugins(v);
    if (modelPlugin) v.emit('simulation-start');
    runner.setSubMode('animated');
    // A run may wait for its KPI sources (plan-2211 review #4; only with a source provider).
    await runner.kpiSourcesReady();
    const base = continuationWorld(runner);
    // The real viewer tick advances the RENDER clock; the event clock stays at the last
    // processed event (processUpTo) exactly like in the app. Deliberately no per-tick
    // alignment: a capture that synchronises the clocks must not change what follows.
    const tickTo = (toT: number) => {
      const manager = runner.getManager();
      const queue = (manager as unknown as { queue: { dequeue(): unknown } }).queue;
      const dequeue = queue.dequeue;
      const names = new Map([...ACTION_INDEX].map(([name, index]) => [index, name]));
      const owners = new Map(runner.liveInstances.map(i => [i.adapter.entityId, i.desId!]));
      const events = base.trace() as ContinuationEvent[];
      queue.dequeue = function () {
        const event = dequeue.call(this) as { time: number; actionIndex: number; entityId: number; muId: number } | null;
        if (event) events.push({ time: event.time, action: names.get(event.actionIndex)!,
          componentId: owners.get(event.entityId) ?? null, muId: event.muId });
        return event;
      };
      try {
        while (runner.renderClock < toT) {
          const expected = runner.renderClock + 0.25;
          if (expected > toT) throw new Error('Scene ticks require the quarter-second grid');
          (v as unknown as { _tickOnce(dt: number): void })._tickOnce(0.25);
          yard?.onRender();
          if (runner.renderClock !== expected) throw new Error(`Viewer tick did not reach ${expected} (render clock ${runner.renderClock})`);
        }
      } finally { queue.dequeue = dequeue; }
    };
    let hiddenCounter = 0;
    const failures = opts.failures ?? [];
    for (const f of failures) {
      if (!(f.at > 0 && f.until > f.at) || ![f.at, f.until].every(t => Number.isFinite(t) && t * 4 === Math.trunc(t * 4))) {
        throw new Error('Failure boundaries must be positive quarter seconds');
      }
    }
    const matches = (pattern: RegExp | string, id: string, type: string) => {
      if (typeof pattern === 'string') return id.includes(pattern) || type === pattern;
      pattern.lastIndex = 0;
      if (pattern.test(id)) return true;
      pattern.lastIndex = 0;
      return pattern.test(type);
    };
    const world = {
      ...base, v, runner, yard, dispose,
      step(toT: number) {
        const manager = runner.getManager();
        if (toT < runner.renderClock) throw new Error('Cannot step backwards');
        while (runner.renderClock < toT) {
          const before = runner.renderClock;
          const next = Math.min((Math.floor(before * 4) + 1) / 4, toT);
          tickTo(next);
          for (const f of failures) {
            const candidates = runner.liveInstances.filter(i => matches(f.desIdMatch, i.desId!, i.def.type));
            if (before < f.at && next === f.at) {
              const queue = manager.queuedEventsWithData();
              const moving = candidates.find(i => queue.some(e => e.entityId === i.adapter.entityId));
              if (!moving) throw new Error(`${scene}: no queued moving instance for ${String(f.desIdMatch)} at ${next}`);
              console.info(`MATRIX_FAILURE ${JSON.stringify({ scene, at: next, desId: moving.desId })}`);
              moving.adapter.setFailure(true);
            }
            if (before < f.until && next === f.until) {
              // The failed adapter is persisted. A fresh world needs no hidden selection history.
              const failed = candidates.filter(i => i.adapter.isFailure);
              if (failed.length !== 1) throw new Error(`${scene}: expected one failed adapter at ${next}`);
              failed[0].adapter.setFailure(false);
            }
          }
          if (opts.hidden) hiddenCounter++;
        }
      },
      kpis() {
        const rt = yard?.runtime as YardKpiRun | null | undefined;
        if (yard && !rt) throw new Error('PalletYard runtime did not bind');
        return {
          ...base.kpis(),
          ...(rt ? {
            'fleet.runner': { stats: rt.fleetStats(), counters: { ...rt.counters }, firstJobs: [...rt.firstJobs] },
            'fleet.kpis': { meanOrderSec: rt.orderKpis.meanOrderSec() },
            // DesLift.position reads the bound drive.currentPosition, not stroke metadata.
            'lift.drives': Object.fromEntries(rt.vehicleIds.map(id => [id, rt.lift.position(id)])),
          } : {}),
          ...(opts.hidden ? { hidden: hiddenCounter } : {}),
        };
      },
    } satisfies ContinuationWorld & { v: typeof v; yard: typeof yard };
    return world;
  } catch (error) { dispose(); throw error; }
}

export type SceneWorld = Awaited<ReturnType<typeof sceneWorld>>;
