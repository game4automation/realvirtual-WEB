// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2208b B3 review: the seed is a Base setting. With a variant in the scene the edit target is
 * the variant's, which cannot hold DESManager.MasterSeed — the seed must be refused BEFORE the live
 * seed changes, and a failed scene write must reach the caller (clock window and des.seed.set).
 * The real helper, not a mock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { VariantStore } from '../../src/core/variants/rv-variant-store';
import { createVariantEditTarget } from '../../src/core/variants/rv-variant-edit-target';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { checkFieldValue } from '../../src/core/params/rv-param-field';
import { viewerParamFieldEnv } from '../../src/core/params/rv-param-apply';
import { applyDesMasterSeed, DES_MANAGER_COMPONENT, DES_MASTER_SEED_FIELD } from '../../src/core/material-flow/des-manager-node';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { ensureDesRunCommandsRegistered } from '../../src/core/hmi/des-run-commands';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';
import type { RVViewer } from '../../src/core/rv-viewer';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import { acquireRunLease } from '../../src/core/hmi/rv-run-lease';

function sceneWithManager(seed = 42) {
  const scene = new Object3D();
  const sim = new Object3D(); sim.name = 'Simulation';
  sim.userData.realvirtual = { [DES_MANAGER_COMPONENT]: { EndTime: 3600, StatisticsResetTime: 0, [DES_MASTER_SEED_FIELD]: seed } };
  scene.add(sim);
  return scene;
}
function fixture() {
  const scene = sceneWithManager();
  const ctl = { masterSeed: 42, setMasterSeed: vi.fn(function (this: { masterSeed: number }, s: number) { this.masterSeed = s; }) };
  const registry = { getNode: () => null, getAddressForNode: () => null, getPathForNode: () => 'Simulation' };
  const viewer = { scene, registry, simulationKernel: { desControl: () => ctl } } as unknown as RVViewer;
  return { scene, ctl, viewer };
}
function variantInScene() {
  const store = new VariantStore({ apply: async () => ({ ok: true as const, written: [], captured: [], unresolved: [] }), readBase: () => ({ kind: 'value' as const, value: 0 }) });
  store.createWithId('v1', 'V1', []);
  setActiveEditTarget(createVariantEditTarget({ store, variantId: 'v1', host: { registry: null },
    check: (c, f, v) => { const r = checkFieldValue(viewerParamFieldEnv, c, f, v); return r.ok ? { ok: true } : { ok: false, detail: r.detail }; } }));
}

afterEach(() => { setActiveEditTarget(null); __resetDesRunSettingsForTest(); });

describe('applyDesMasterSeed with a variant in the scene', () => {
  it('refuses before changing the live seed', async () => {
    const f = fixture(); variantInScene();
    const r = await applyDesMasterSeed(f.viewer, f.ctl, 7);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('Base') });
    expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();
    expect(f.ctl.masterSeed).toBe(42);
  });

  it('des.seed.set reports the refusal and leaves the seed', async () => {
    const f = fixture(); variantInScene(); ensureDesRunCommandsRegistered();
    const out = await commandRegistry.execute('des.seed.set', { seed: 7, mode: 'fixed' }, { origin: 'mcp', viewer: f.viewer });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('Base') });
    expect(f.ctl.masterSeed).toBe(42);
  });

  it('propagates a failed scene write and keeps the live seed', async () => {
    const f = fixture();
    const failing: EditTarget = { available: true, persistsTo: 'scene', setField: () => {}, unsetField: () => {},
      setFieldAsync: () => Promise.reject(new Error('document refused the edit')), withTransaction: async (_label, fn) => fn() };
    setActiveEditTarget(failing);
    const r = await applyDesMasterSeed(f.viewer, f.ctl, 7);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('document refused the edit') });
    expect(f.ctl.masterSeed).toBe(42);
  });

  it('writes the scene first, then the live seed', async () => {
    const f = fixture();
    const order: string[] = [];
    f.ctl.setMasterSeed.mockImplementation(function (this: { masterSeed: number }, s: number) { order.push('live'); this.masterSeed = s; });
    const doc = documentTarget(f.scene, { onWrite: (value, prev) => order.push(`scene ${prev}->${value}`) });
    setActiveEditTarget(doc.target);
    expect(await applyDesMasterSeed(f.viewer, f.ctl, 7)).toEqual({ ok: true });
    expect(order).toEqual(['scene 42->7', 'live']);
    expect(managerOf(f.scene)[DES_MASTER_SEED_FIELD]).toBe(7);
  });

  it('a write the real document drops (canApply false: loading / replace) is a failure, live seed unchanged', async () => {
    const f = fixture();
    const doc = documentTarget(f.scene, { canApply: () => false });
    setActiveEditTarget(doc.target);
    const r = await applyDesMasterSeed(f.viewer, f.ctl, 7);
    expect(r).toMatchObject({ ok: false, code: 'failed', reason: expect.stringContaining('did not accept') });
    expect(doc.applied).toBe(0);
    expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();
    expect(f.ctl.masterSeed).toBe(42);
  });

  it('a batch that takes the run lease while the write is pending is not reseeded', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const doc = documentTarget(f.scene, { before: () => gate });
    setActiveEditTarget(doc.target);
    const pending = applyDesMasterSeed(f.viewer, f.ctl, 7);
    await Promise.resolve();
    const lease = acquireRunLease('doc', 'batch')!;
    try {
      release();
      expect(await pending).toMatchObject({ ok: false, code: 'refused', reason: expect.stringContaining('experiment is running') });
      expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();
      expect(f.ctl.masterSeed).toBe(42);
    } finally { lease.release(); }
  });

  it('a controller or edit target swapped while the write is pending is not reseeded', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const doc = documentTarget(f.scene, { before: () => gate });
    setActiveEditTarget(doc.target);
    const pending = applyDesMasterSeed(f.viewer, f.ctl, 7);
    await Promise.resolve();
    const other = { masterSeed: 1, setMasterSeed: vi.fn() };
    (f.viewer as unknown as { simulationKernel: { desControl: () => unknown } }).simulationKernel.desControl = () => other;
    release();
    expect(await pending).toMatchObject({ ok: false, code: 'refused', reason: expect.stringContaining('changed') });
    expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();
    expect(other.setMasterSeed).not.toHaveBeenCalled();
  });

  it.each(['replaced', 'removed'] as const)('a simulation kernel %s while the write is pending is not reseeded', async change => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const doc = documentTarget(f.scene, { before: () => gate });
    setActiveEditTarget(doc.target);
    const pending = applyDesMasterSeed(f.viewer, f.ctl, 7);
    await Promise.resolve();
    // A model replacement swaps the kernel; the old one still answers with the old controller.
    const holder = f.viewer as unknown as { simulationKernel: unknown };
    const other = { masterSeed: 1, setMasterSeed: vi.fn() };
    holder.simulationKernel = change === 'replaced' ? { desControl: () => other } : null;
    release();
    expect(await pending).toMatchObject({ ok: false, code: 'refused', reason: expect.stringContaining('changed') });
    expect(managerOf(f.scene)[DES_MASTER_SEED_FIELD]).toBe(7);
    expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();
    expect(other.setMasterSeed).not.toHaveBeenCalled();
  });
});

function managerOf(scene: Object3D): Record<string, unknown> {
  return (scene.getObjectByName('Simulation')!.userData.realvirtual as Record<string, Record<string, unknown>>)[DES_MANAGER_COMPONENT];
}

/**
 * A scene edit target over a REAL RvDocument: its executor writes the field into the node's extras
 * like the scene executor does; `canApply` / `before` model a loading document and a slow write.
 */
function documentTarget(scene: Object3D, opts: { canApply?: () => boolean; before?: () => Promise<void>; onWrite?(value: unknown, prev: unknown): void } = {}) {
  const state = { applied: 0 };
  const executor = {
    async applyForward(op: RvOp) {
      await opts.before?.();
      const o = op as unknown as { componentType: string; fieldName: string; value: unknown; prev: unknown };
      state.applied++;
      opts.onWrite?.(o.value, o.prev);
      managerOf(scene)[o.fieldName] = o.value;
    },
    async applyInverse() {},
  };
  const doc = new RvDocument({ id: 'seed-doc', name: 'Seed', mode: 'scene', executor, canApply: opts.canApply });
  const target: EditTarget = { available: true, persistsTo: 'scene', documentKey: doc, setField: () => {}, unsetField: () => {},
    setFieldAsync: (nodePath, componentType, fieldName, value, prev) => doc.applyOp({ id: `op-${Math.random()}`, ts: Date.now(), schemaV: 1, kind: 'setField', nodePath, componentType, fieldName, value, prev } as unknown as RvOp),
    withTransaction: async (_label, fn) => fn() };
  return { target, get applied() { return state.applied; } };
}
