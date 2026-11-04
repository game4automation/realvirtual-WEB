// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import { YardPlanning } from '../../src/plugins/models/PalletYard/yard-planning';
import { SIZE_KEY, PALLET_YARD_OWNER } from '../../src/plugins/models/PalletYard/parameters';
import type { PlantParameterContext } from '../../src/core/fleet/define-plant-plugin';
import type { StructuralResetContext } from '../../src/core/planning/rv-planning-params';

const mocks = vi.hoisted(() => ({ materialize: vi.fn(), learn: vi.fn(() => new Map()), live: vi.fn() }));
vi.mock('../../src/plugins/planning-parameters', () => ({ getPlanningPlugin: (viewer: { planning: unknown }) => viewer.planning }));
vi.mock('../../src/plugins/models/PalletYard/yard-runtime', () => ({
  applyYardLive: mocks.live, SIZE_RECONCILE_PAUSE_REASON: 'pallet-yard-size-reconcile',
}));
vi.mock('../../src/plugins/models/PalletYard/yard-materialize', () => ({
  learnYardTemplates: mocks.learn,
  materializeYard: mocks.materialize,
  findYardNode: (root: Group, name: string) => root.getObjectByName(name),
}));
const active: YardPlanning[] = [];
afterEach(() => { for (const planning of active.splice(0)) planning.dispose(); vi.clearAllMocks(); });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fixture(committedSize = 2) {
  const log: string[] = [];
  const root = new Group(); root.name = 'PalletYardRoot';
  root.userData.realvirtual = { PalletYard: { Size: 2 } };
  let ready!: () => void;
  const sceneReady = new Promise<void>(r => { ready = r; });
  const handle = { get: () => committedSize, values: () => ({ [SIZE_KEY]: committedSize }), redeclare: vi.fn() };
  const registry = { list: () => [], reconcileStructure: vi.fn(async () => ({ ok: true })) };
  const off = vi.fn();
  const viewer = {
    simTime: 12, planning: { registry }, on: vi.fn(() => off),
    setSimulationPaused: vi.fn((_reason, paused) => log.push(paused ? 'hold' : 'release')),
    whenSceneReady: () => sceneReady, placements: { whenMaterialized: async () => {} },
  };
  const ctx = { root, viewer, planning: handle, runtime: null,
    prepareUnbind: () => log.push('prepare-unbind'), reconfigure: vi.fn(),
  } as unknown as PlantParameterContext;
  const reset: StructuralResetContext & PlantParameterContext = {
    ...ctx, documentLoadId: 'doc', signal: new AbortController().signal, awaitPlacements: async () => {},
  };
  const planning = new YardPlanning(); active.push(planning);
  mocks.materialize.mockImplementation(async (_viewer, _root, yard) => {
    log.push(`materialize:${yard.size}:${yard.counts.vehicles}`);
    return { pathsReplaced: true };
  });
  return { root, ctx, reset, planning, handle, registry, viewer, ready, log, off };
}

describe('extracted yard planning', () => {
  it('learns the document and establishes the saved-size hold before scene readiness', async () => {
    const f = fixture(4);
    f.planning.adoptDocument(f.root, f.ctx);
    expect(f.planning.docSize).toBe(2);
    expect(mocks.learn).toHaveBeenCalledWith(f.root, f.planning.yard);
    expect(f.planning.declare(f.root)!.owner).toBe(PALLET_YARD_OWNER);
    f.planning.afterDeclare(f.ctx);
    expect(f.log).toEqual(['hold']);
    expect(f.registry.reconcileStructure).not.toHaveBeenCalled();
    f.ready(); await settle();
    expect(f.registry.reconcileStructure).toHaveBeenCalledWith(PALLET_YARD_OWNER);
    expect(f.log).toEqual(['hold', 'release']);
  });

  it('cancels a queued load reconciliation when its document is disposed', async () => {
    const f = fixture(4); f.planning.adoptDocument(f.root, f.ctx); f.planning.afterDeclare(f.ctx);
    f.planning.dispose(); f.ready(); await settle();
    expect(f.registry.reconcileStructure).not.toHaveBeenCalled();
    expect(f.off).toHaveBeenCalledTimes(1);
    expect(f.log).toEqual(['hold', 'release']);
  });

  it('releases the owner before a component-driven materialization and redeclares the vehicle bounds', async () => {
    const f = fixture(); f.planning.adoptDocument(f.root, f.ctx);
    await f.planning.rebuildYard(2, 5, f.reset);
    expect(f.log).toEqual(['prepare-unbind', 'materialize:2:5']);
    expect(f.planning.docVehicles).toBe(5);
    expect(f.planning.yard.counts.vehicles).toBe(5);
    expect(f.handle.redeclare).toHaveBeenCalledTimes(1);
  });

  it('restores the document size after failed load reconciliation and preserves failure', async () => {
    const f = fixture(4); f.planning.adoptDocument(f.root, f.ctx);
    const failure = new Error('placement failed');
    mocks.materialize.mockRejectedValueOnce(failure);
    let rejected: unknown;
    f.registry.reconcileStructure.mockImplementation(async () => {
      try { await f.planning.onStructuralReset({ [SIZE_KEY]: 4 }, f.reset); }
      catch (error) { rejected = error; }
      return { ok: true };
    });
    f.planning.afterDeclare(f.ctx); f.ready(); await settle();
    expect(rejected).toBe(failure);
    expect(mocks.materialize.mock.calls.map(call => call[2].size)).toEqual([4, 2]);
    expect(f.planning.yard.size).toBe(2);
    expect(f.log.at(-1)).toBe('release');
  });

  it('retries a half-built structure even when rollback requests its original size', async () => {
    const f = fixture(); f.planning.adoptDocument(f.root, f.ctx);
    mocks.materialize.mockRejectedValueOnce(new Error('half-built'));
    await expect(f.planning.onStructuralReset({ [SIZE_KEY]: 4 }, f.reset)).rejects.toThrow('half-built');
    await f.planning.onStructuralReset({ [SIZE_KEY]: 2 }, f.reset);
    expect(mocks.materialize.mock.calls.map(call => call[2].size)).toEqual([4, 2]);
  });
});
