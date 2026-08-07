// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-pallet-source-flow.test.ts — a real PALLET source spawns VISIBLE europallets
 * that flow through the DES line and are consumed by the sink.
 *
 * The abstract `des-source` is a virtual gizmo (no GLB, no rv_extras): it spawns
 * STRUCTURAL DES MUs with no visual, because the DES runner gets a MU's mesh from
 * the engine RVSource (des-scene-binding `engineSourceFor(root).spawnMU()`), and a
 * virtual node has no engine RVSource — so nothing renders. The fix is to use a
 * real pallet asset as the source: `pallethandling-europalletloaded` (and
 * `-europallet`) bake `rv_extras.Source` with `ThisObjectAsMU` == their own node
 * name, i.e. a SELF-TEMPLATE source — placing one makes a europallet that spawns
 * copies of itself.
 *
 * This proves, end-to-end:
 *  1. a europallet's baked config self-templates as a Source (sourceIsTemplate);
 *  2. its `spawnMU()` returns a REAL, visible clone (the exact call the DES
 *     binding makes — null for a virtual des-source);
 *  3. those visible pallets flow Source -> Conveyor -> Sink, every consumed MU
 *     carries a non-null visual, and the sink consumes them (load back to 0).
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshStandardMaterial } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import type { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { RVSource } from '../../src/core/engine/rv-source';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import Source from '../../src/behaviors/Source';
import { createSelf, type MaterialFlowSelf, type MU } from '../../src/core/material-flow/material-flow-self';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry, getMaterialFlow } from '../../src/core/material-flow/registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

void Source; void ConveyorFlow;
const SourceDef = getMaterialFlow('Source') as MaterialFlowDefinition;
const ConveyorDef = ConveyorFlow as unknown as MaterialFlowDefinition;

// The europallet's baked rv_extras.Source (verified from EuropalletLoaded.glb /
// Europallet.glb): ThisObjectAsMU == node name => self-template.
const PALLET_SOURCE_EXTRAS = {
  ThisObjectAsMU: 'EuropalletLoaded',
  AutomaticGeneration: true,
  Interval: 0,
  GenerateIfDistance: 1300,
};

/** A multi-mesh pallet template (analyzeTemplate -> null -> deterministic clone
 *  path, so spawnMU() returns a real RVMovingUnit rather than an instanced MU). */
function makePalletNode(name = 'EuropalletLoaded'): Object3D {
  const node = new Object3D();
  node.name = name;
  const deck = new Mesh(new BoxGeometry(1.2, 0.14, 0.8), new MeshStandardMaterial());
  deck.name = 'Deck';
  const box = new Mesh(new BoxGeometry(0.6, 0.6, 0.6), new MeshStandardMaterial());
  box.name = 'CartonBox';
  node.add(deck, box);
  return node;
}

/** Build a self-template engine RVSource from the europallet's baked config —
 *  exactly what the scene loader does for a placed europalletloaded node. */
function makePalletEngineSource(spawnParent: Object3D): RVSource {
  const node = makePalletNode('EuropalletLoaded');
  const src = new RVSource(node);
  src.ThisObjectAsMU = PALLET_SOURCE_EXTRAS.ThisObjectAsMU;
  src.AutomaticGeneration = PALLET_SOURCE_EXTRAS.AutomaticGeneration;
  src.Interval = PALLET_SOURCE_EXTRAS.Interval;
  src.GenerateIfDistance = PALLET_SOURCE_EXTRAS.GenerateIfDistance;
  src.computeSpawnConfig(PALLET_SOURCE_EXTRAS);
  src.spawnParent = spawnParent;
  src.setTemplate(node); // self-template branch
  return src;
}

function makeHost(
  values: Map<string, boolean | number>,
  drives: BindContextHost['drives'] = [],
): BindContextHost {
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: drives as never,
    registry: null,
    getPlugin: () => undefined,
  };
}

function conveyorCtx(
  name: string,
  values: Map<string, boolean | number>,
  lengthMm: number,
  speedMmS: number,
): { ctx: RVBindContext; root: Object3D } {
  const root = new Object3D(); root.name = name;
  const belt = new Mesh(new BoxGeometry(lengthMm / 1000, 0.1, 0.2));
  belt.name = 'Transport-X'; belt.updateMatrixWorld(true); root.add(belt);
  const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
  const host = makeHost(values, [{ name: 'Transport-X', node: belt, TargetSpeed: speedMmS }]);
  const accum: KinematicsSpec = {};
  return { ctx: createBindContext(root, host, accum).ctx, root };
}

function bareCtx(name: string, values: Map<string, boolean | number>): { ctx: RVBindContext; root: Object3D } {
  const root = new Object3D(); root.name = name;
  const accum: KinematicsSpec = {};
  return { ctx: createBindContext(root, makeHost(values), accum).ctx, root };
}

describe('DES pallet source — visible europallets spawn, flow and are consumed', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
    void Source; void ConveyorFlow;
  });

  it('a europallet self-templates as a Source (baked ThisObjectAsMU == node name)', () => {
    const src = new RVSource(makePalletNode('EuropalletLoaded'));
    src.ThisObjectAsMU = 'EuropalletLoaded';
    src.computeSpawnConfig(PALLET_SOURCE_EXTRAS);
    // ThisObjectAsMU === node name => the pallet IS its own MU template.
    expect(src.sourceIsTemplate).toBe(true);
    expect(src.muName).toBe('EuropalletLoaded');
  });

  it('the pallet source spawns a REAL visible MU clone via spawnMU() (the DES call)', () => {
    const sceneRoot = new Object3D();
    const src = makePalletEngineSource(sceneRoot);

    // This is exactly what des-scene-binding does for every DES MU.
    const mu = src.spawnMU();
    expect(mu).toBeInstanceOf(RVMovingUnit);

    // A real, visible pallet clone was added to the scene (not a structural-only MU).
    const clone = sceneRoot.children.find((c) => c.name.startsWith('EuropalletLoaded_'));
    expect(clone, 'a visible pallet clone is added to the scene').toBeTruthy();
    let meshes = 0;
    clone!.traverse((c) => { if ((c as Mesh).isMesh) meshes++; });
    expect(meshes).toBeGreaterThan(0); // the pallet has real geometry (visible)
  });

  it('visible pallets flow Source -> Conveyor -> Sink and the sink consumes them', () => {
    const values = new Map<string, boolean | number>();
    const runner = new DESRunner({ subMode: 'animated' });
    const sceneRoot = new Object3D();

    // The real engine pallet source whose spawnMU() supplies each MU's visual —
    // the same object des-scene-binding resolves via engineSourceFor(root).
    const engineSrc = makePalletEngineSource(sceneRoot);

    const adapters: MaterialFlowAdapter[] = [];
    const idAt = (i: number) => () => adapters[i].entityId;

    // ── Source: spawnMU mirrors des-scene-binding (mu.visual = engineSrc.spawnMU()) ──
    const srcCtx = bareCtx('EuropalletLoaded', values);
    const srcSelf = createSelf(srcCtx.ctx, SourceDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(SourceDef, idAt(0)),
      onTransfer: (mu) => runner.makeTransfer(adapters[0])(mu),
      canAcceptDownstream: (mu) => adapters[0].nextComponents.some((c) => c.canAccept(mu as never)),
      spawnMU: () => {
        const mu = runner.createMU();
        (mu as unknown as { visual: unknown }).visual = engineSrc.spawnMU();
        return mu;
      },
      local: (SourceDef.state ?? SourceDef.local)?.(),
    });
    srcSelf.prop['Interval'] = 1; // ~20 pallets over 20 s
    adapters.push(runner.addInstance(SourceDef, srcSelf, srcCtx.root));

    // ── Conveyor (500 mm @ 1000 mm/s) ──
    const c1 = conveyorCtx('Conveyor1', values, 500, 1000);
    const c1Self = createSelf(c1.ctx, ConveyorDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(ConveyorDef, idAt(1)),
      onTransfer: (mu) => runner.makeTransfer(adapters[1])(mu),
      canAcceptDownstream: (mu) => adapters[1].nextComponents.some((c) => c.canAccept(mu as never)),
      local: (ConveyorDef.state ?? ConveyorDef.local)!(),
    });
    adapters.push(runner.addInstance(ConveyorDef, c1Self, c1.root));

    // ── Sink: capture every consumed MU (kind:'sink' so the adapter sink-consume
    //    fix applies — infinite capacity + release-on-consume). ──
    const consumed: MU[] = [];
    const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestPalletSink', kind: 'sink', schema: {}, continuous: {},
      des: { onAccept(_s, mu) { consumed.push(mu); return true; } },
    });
    const sinkCtx = bareCtx('PalletSink', values);
    const sinkSelf = createSelf(sinkCtx.ctx, sinkDef as MaterialFlowDefinition, {
      mode: 'des', scheduler: runner.makeScheduler(sinkDef as MaterialFlowDefinition, idAt(2)),
    });
    adapters.push(runner.addInstance(sinkDef as MaterialFlowDefinition, sinkSelf, sinkCtx.root));

    // Wire Source -> Conveyor -> Sink.
    adapters[0].nextComponents = [adapters[1]];
    adapters[1].nextComponents = [adapters[2]]; adapters[1].previousComponents = [adapters[0]];
    adapters[2].previousComponents = [adapters[1]];

    values.set('Flow.Run', true);
    runner.start([SourceDef, ConveyorDef, sinkDef as MaterialFlowDefinition], { root: new Object3D() });

    for (let i = 0; i < 60 * 20; i++) runner.tick(1 / 60);

    // Pallets kept flowing and were consumed (NOT capped at the first one).
    expect(consumed.length).toBeGreaterThanOrEqual(5);
    // EVERY consumed MU carried a real visual pallet — a virtual des-source would
    // leave these undefined (the invisible-MU bug).
    for (const mu of consumed) {
      expect((mu as unknown as { visual?: unknown }).visual).toBeInstanceOf(RVMovingUnit);
    }
    // The sink freed its slot after each consume (adapter sink-consume fix).
    expect(adapters[2].totalProcessed).toBeGreaterThanOrEqual(5);
    expect(adapters[2].currentLoad).toBe(0);
  });
});
