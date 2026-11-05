// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group } from 'three';
import { YardPlanning } from '../../src/plugins/models/PalletYard/yard-planning';
import { SIZE_KEY, VEHICLES_KEY, PALLET_YARD_OWNER, stationActiveKeyOf, validatePalletYard } from '../../src/plugins/models/PalletYard/parameters';
import type { PlantParameterContext } from '../../src/core/fleet/define-plant-plugin';
import type { StructuralResetContext } from '../../src/core/planning/rv-planning-params';
import { createPlanningRegistry, type PlanningRegistry } from '../../src/core/planning/rv-planning-registry';

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
  const handle = { get: () => committedSize, values: () => ({ [SIZE_KEY]: committedSize }), redeclare: vi.fn(), recoverCommitted: vi.fn(() => ({ ok: true, reset: [] })) };
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

  /** The fixture on a REAL registry whose session carries a saved size of 4 (document: 2). */
  function withRegistry(scenario: Record<string, unknown> = {}) {
    const f = fixture();
    const problems = { report: vi.fn(), clear: vi.fn() };
    const registry: PlanningRegistry = createPlanningRegistry({ problems });
    (f.viewer.planning as { registry: unknown }).registry = registry;
    f.planning.adoptDocument(f.root, f.ctx);
    // As fleet-plugin.ts declares it: the owner's reset runs with the plant context.
    const handle = registry.declare({
      ...f.planning.declare(f.root)!,
      onStructuralReset: (req, ctx) => f.planning.onStructuralReset(req, { ...f.ctx, ...ctx }),
    });
    (f.ctx as unknown as { planning: unknown }).planning = handle;
    registry.loadScenario({ [`${PALLET_YARD_OWNER}.${SIZE_KEY}`]: 4, ...scenario });
    const rowOf = (key: string) => registry.list().find(p => p.key === `${PALLET_YARD_OWNER}.${key}`)!;
    const row = () => rowOf(SIZE_KEY);
    return { ...f, problems, registry, handle, row, rowOf };
  }

  it('leaves committed at the document size when the load reconcile fails (plan-681 F2)', async () => {
    const f = withRegistry();
    expect(f.handle.get(SIZE_KEY)).toBe(4);
    mocks.materialize.mockRejectedValueOnce(new Error('placement failed'));
    f.planning.afterDeclare(f.ctx); f.ready(); await settle();
    expect(mocks.materialize.mock.calls.map(call => call[2].size)).toEqual([4, 2]);
    expect(f.planning.yard.size).toBe(2);
    expect(f.handle.get(SIZE_KEY)).toBe(2);
    expect(f.row().value).toBe(2);
    expect(f.row().pending, 'nothing left half-applied').toBeUndefined();
    expect(f.problems.report).toHaveBeenCalledWith(expect.objectContaining({ code: 'planning-apply-failed' }));
    expect(f.problems.report).toHaveBeenCalledWith(expect.objectContaining({ code: 'planning-committed-recovered' }));
  });

  it('a vehicle change during the rollback stays pending and the next apply builds it', async () => {
    const f = withRegistry();
    const want = f.rowOf(VEHICLES_KEY).value as number + 1;
    mocks.materialize.mockRejectedValueOnce(new Error('placement failed'));
    mocks.materialize.mockImplementationOnce(async (_v, _r, yard) => {
      expect(f.registry.set(`${PALLET_YARD_OWNER}.${VEHICLES_KEY}`, want, 'ui').applied).toBe('pending');
      f.log.push(`materialize:${yard.size}:${yard.counts.vehicles}`);
      return { pathsReplaced: true };
    });
    f.planning.afterDeclare(f.ctx); f.ready(); await settle();
    expect(f.handle.get(SIZE_KEY)).toBe(2);
    expect(f.rowOf(VEHICLES_KEY).pending, 'not committed without being built').toBe(want);
    expect(f.handle.get(VEHICLES_KEY)).toBe(want - 1);
    expect((await f.registry.applyPendingAndReset()).ok).toBe(true);
    expect(f.handle.get(VEHICLES_KEY)).toBe(want);
    expect(f.planning.yard.counts.vehicles).toBe(want);
    expect(f.log.at(-1)).toBe(`materialize:2:${want}`);
  });

  it('an edit during the fallback that the recovered values make invalid is refused by the next apply (Codex r2 #1)', async () => {
    const f = withRegistry({ [`${PALLET_YARD_OWNER}.${stationActiveKeyOf('A2')}`]: false });
    const a1 = `${PALLET_YARD_OWNER}.${stationActiveKeyOf('A1')}`;
    mocks.materialize.mockRejectedValueOnce(new Error('placement failed'));
    mocks.materialize.mockImplementationOnce(async () => {
      // Valid at size 4 (A3/A4 still active), so the write is accepted as pending.
      expect(f.registry.set(a1, false, 'ui').applied).toBe('pending');
      return { pathsReplaced: true };
    });
    f.planning.afterDeclare(f.ctx); f.ready(); await settle();
    expect(f.handle.get(SIZE_KEY)).toBe(2);
    expect(f.rowOf(stationActiveKeyOf('A1')).pending).toBe(false);
    f.problems.report.mockClear();
    const r = await f.registry.applyPendingAndReset();
    expect(r).toMatchObject({ ok: false, error: 'invalid-values' });
    expect(f.handle.get(stationActiveKeyOf('A1')), 'nothing committed').toBe(true);
    expect(f.rowOf(stationActiveKeyOf('A1')).pending, 'the edit is kept').toBe(false);
    expect(validatePalletYard(f.handle.values())).toEqual({});
    expect(f.problems.report).toHaveBeenCalledWith(expect.objectContaining({ code: 'planning-apply-failed' }));
    expect(f.problems.clear).not.toHaveBeenCalledWith(`planning-committed-recovered:${PALLET_YARD_OWNER}`);
  });

  it('a saved size-4 scenario with A1/A2 off recovers onto a size-2 document with an active output', async () => {
    const f = withRegistry({ [`${PALLET_YARD_OWNER}.${stationActiveKeyOf('A1')}`]: false, [`${PALLET_YARD_OWNER}.${stationActiveKeyOf('A2')}`]: false });
    expect(f.handle.get(stationActiveKeyOf('A1'))).toBe(false);
    mocks.materialize.mockRejectedValueOnce(new Error('placement failed'));
    f.planning.afterDeclare(f.ctx); f.ready(); await settle();
    expect(f.handle.get(SIZE_KEY)).toBe(2);
    expect(validatePalletYard(f.handle.values())).toEqual({});
    expect([1, 2].some(i => f.handle.get(stationActiveKeyOf(`A${i}`)) !== false)).toBe(true);
    expect(f.problems.report).toHaveBeenCalledWith(expect.objectContaining({
      code: 'planning-committed-recovered', detail: expect.stringContaining(stationActiveKeyOf('A1')),
    }));
  });

  it('keeps committed at the target when the load reconcile succeeds', async () => {
    const f = withRegistry();
    f.planning.afterDeclare(f.ctx); f.ready(); await settle();
    expect(mocks.materialize.mock.calls.map(call => call[2].size)).toEqual([4]);
    expect(f.planning.yard.size).toBe(4);
    expect(f.handle.get(SIZE_KEY)).toBe(4);
    expect(f.row().pending).toBeUndefined();
  });

  it('retries a half-built structure even when rollback requests its original size', async () => {
    const f = fixture(); f.planning.adoptDocument(f.root, f.ctx);
    mocks.materialize.mockRejectedValueOnce(new Error('half-built'));
    await expect(f.planning.onStructuralReset({ [SIZE_KEY]: 4 }, f.reset)).rejects.toThrow('half-built');
    await f.planning.onStructuralReset({ [SIZE_KEY]: 2 }, f.reset);
    expect(mocks.materialize.mock.calls.map(call => call[2].size)).toEqual([4, 2]);
  });
});
