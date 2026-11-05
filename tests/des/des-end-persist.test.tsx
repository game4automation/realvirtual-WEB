// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The end time and the warm-up (statistics reset) are Base settings on the scene's DESManager, like
 * the seed: des.setEnd and the clock window write them through the same safe path — refused while a
 * variant is in the scene, the scene write awaited and read back, the live value changed only after.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { VariantStore } from '../../src/core/variants/rv-variant-store';
import { createVariantEditTarget } from '../../src/core/variants/rv-variant-edit-target';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { checkFieldValue } from '../../src/core/params/rv-param-field';
import { viewerParamFieldEnv } from '../../src/core/params/rv-param-apply';
import { applyDesClockSettings, applyDesMasterSeed, DES_END_TIME_FIELD, DES_MANAGER_COMPONENT, DES_MASTER_SEED_FIELD, DES_STAT_RESET_FIELD } from '../../src/core/material-flow/des-manager-node';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { ensureDesRunCommandsRegistered } from '../../src/core/hmi/des-run-commands';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { DESControllerToolbar } from '../../src/plugins/sim-controller/DESControllerToolbar';
import type { RVViewer } from '../../src/core/rv-viewer';

function managerOf(scene: Object3D): Record<string, unknown> {
  return (scene.getObjectByName('Simulation')!.userData.realvirtual as Record<string, Record<string, unknown>>)[DES_MANAGER_COMPONENT];
}
function fixture() {
  const scene = new Object3D();
  const sim = new Object3D(); sim.name = 'Simulation';
  sim.userData.realvirtual = { [DES_MANAGER_COMPONENT]: { [DES_END_TIME_FIELD]: 3600, [DES_STAT_RESET_FIELD]: 60, [DES_MASTER_SEED_FIELD]: 42 } };
  scene.add(sim);
  const stats = { currentTime: 0, processed: 0, pending: 0, nextEventTime: Infinity };
  const ctl = {
    subMode: 'animated' as const, multiplier: 1, simTime: 0, endTime: 3600, statResetTime: 60, masterSeed: 42, lifecycleGeneration: 1, runComplete: null,
    eventStats: () => stats, setSubMode: () => {}, setMultiplier: () => {}, step: () => false,
    setEndTime: vi.fn(function (this: { endTime: number }, s: number) { this.endTime = s; }),
    setStatResetTime: vi.fn(function (this: { statResetTime: number }, s: number) { this.statResetTime = s; }),
    setMasterSeed: vi.fn(),
  };
  const viewer = {
    scene, registry: { getNode: () => null, getAddressForNode: () => null, getPathForNode: () => 'Simulation' },
    simulationKernel: { mode: 'des', isSwitching: false, hasDesRunner: () => true, desControl: () => ctl },
    isSimulationPaused: false, simulationPauseReasons: [], signalStore: null,
    on: () => () => {}, emit: () => {}, getPlugin: () => undefined,
  } as unknown as RVViewer;
  const run = (args: Record<string, unknown>) => commandRegistry.execute('des.setEnd', args, { origin: 'mcp', viewer });
  return { scene, ctl, viewer, run };
}
function variantInScene() {
  const store = new VariantStore({ apply: async () => ({ ok: true as const, written: [], captured: [], unresolved: [] }), readBase: () => ({ kind: 'value' as const, value: 0 }) });
  store.createWithId('v1', 'V1', []);
  setActiveEditTarget(createVariantEditTarget({ store, variantId: 'v1', host: { registry: null },
    check: (c, f, v) => { const r = checkFieldValue(viewerParamFieldEnv, c, f, v); return r.ok ? { ok: true } : { ok: false, detail: r.detail }; } }));
}
/**
 * A scene edit target over a REAL RvDocument whose executor writes the field into the node's extras
 * (and restores `prev` on rollback). `afterWrite` runs after each applied write; `write` overrides
 * what a write does to the extras (a PalletYard-like default that is not stored as a field).
 */
function documentTarget(sceneOf: Object3D | (() => Object3D), opts: { canApply?: () => boolean; afterWrite?(field: string): void;
  gate?: () => Promise<void>; write?(extras: Record<string, unknown>, field: string, value: unknown): void } = {}) {
  const scene = () => (typeof sceneOf === 'function' ? sceneOf() : sceneOf);
  const writes: string[] = [];
  const executor = {
    async applyForward(op: RvOp) {
      await opts.gate?.();
      const o = op as unknown as { fieldName: string; value: unknown };
      writes.push(o.fieldName);
      if (opts.write) opts.write(managerOf(scene()), o.fieldName, o.value); else managerOf(scene())[o.fieldName] = o.value;
      opts.afterWrite?.(o.fieldName);
    },
    async applyInverse(op: RvOp) {
      const items = (op as unknown as { kind: string; ops?: RvOp[] }).kind === 'composite' ? (op as unknown as { ops: RvOp[] }).ops : [op];
      for (const item of [...items].reverse()) { const o = item as unknown as { fieldName: string; prev: unknown }; managerOf(scene())[o.fieldName] = o.prev; }
    },
  };
  const doc = new RvDocument({ id: 'end-doc', name: 'End', mode: 'scene', executor, canApply: opts.canApply });
  const target: EditTarget = { available: true, persistsTo: 'scene', documentKey: doc, setField: () => {}, unsetField: () => {},
    setFieldAsync: (nodePath, componentType, fieldName, value, prev) => doc.applyOp({ id: `op-${Math.random()}`, ts: Date.now(), schemaV: 1, kind: 'setField', nodePath, componentType, fieldName, value, prev } as unknown as RvOp),
    withTransaction: async (label, fn) => { await doc.withTransaction(label, fn); } };
  return Object.assign(target, { writes });
}

afterEach(() => { cleanup(); setActiveEditTarget(null); });

describe('des.setEnd', () => {
  it.each([[{ end: '00:02:00:00' }, 'setEndTime'], [{ statReset: '00:00:05:00' }, 'setStatResetTime']] as const)('%j is refused with a variant in the scene, nothing changes', async (args, live) => {
    ensureDesRunCommandsRegistered();
    const f = fixture(); variantInScene();
    expect(await f.run(args)).toMatchObject({ ok: false, reason: expect.stringContaining('Base setting') });
    expect(f.ctl[live]).not.toHaveBeenCalled();
    expect(managerOf(f.scene)).toMatchObject({ [DES_END_TIME_FIELD]: 3600, [DES_STAT_RESET_FIELD]: 60 });
  });

  it('a write the real document drops (canApply false) is a failure, live end unchanged', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture(); setActiveEditTarget(documentTarget(f.scene, { canApply: () => false }));
    expect(await f.run({ end: '00:02:00:00' })).toMatchObject({ ok: false, reason: expect.stringContaining('did not accept') });
    expect(f.ctl.setEndTime).not.toHaveBeenCalled();
    expect(f.ctl.endTime).toBe(3600);
  });

  it('an accepted write is read back and then applied live; infinite end stores 0', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture(); setActiveEditTarget(documentTarget(f.scene));
    expect(await f.run({ end: '00:02:00:00', statReset: '00:00:05:00' })).toEqual({ ok: true, value: { endTime: 7200, statResetTime: 300 } });
    expect(managerOf(f.scene)).toMatchObject({ [DES_END_TIME_FIELD]: 7200, [DES_STAT_RESET_FIELD]: 300 });
    expect(await f.run({ end: 'inf' })).toMatchObject({ ok: true, value: { endTime: Infinity } });
    expect(managerOf(f.scene)[DES_END_TIME_FIELD]).toBe(0);
  });
});

describe('clock window', () => {
  it('shows a refused end / warm-up edit and leaves the live values', async () => {
    const f = fixture(); variantInScene();
    render(<ThemeProvider theme={rvDarkTheme}><RVViewerProvider value={f.viewer}><DESControllerToolbar viewer={f.viewer} /></RVViewerProvider></ThemeProvider>);
    fireEvent.click(screen.getByTestId('des-clock'));
    const [end, warmup] = await screen.findAllByPlaceholderText('00:00:00:00');
    fireEvent.change(end, { target: { value: '00:02:00:00' } }); fireEvent.blur(end);
    await waitFor(() => expect(screen.getAllByText(/Base setting/).length).toBeGreaterThan(0));
    fireEvent.change(warmup, { target: { value: '00:00:05:00' } }); fireEvent.blur(warmup);
    await waitFor(() => expect(screen.getAllByText(/Base setting/).length).toBe(2));
    expect(f.ctl.setEndTime).not.toHaveBeenCalled();
    expect(f.ctl.setStatResetTime).not.toHaveBeenCalled();
  });
});

describe('LOP #248 — one unit, pinned context, live = persisted, defaults', () => {
  /** Swap the viewer to a replacement model: new scene + registry (+ kernel) with its own DESManager at the same path. */
  function swapModel(f: ReturnType<typeof fixture>) {
    const replacement = new Object3D();
    const sim = new Object3D(); sim.name = 'Simulation';
    sim.userData.realvirtual = { [DES_MANAGER_COMPONENT]: { [DES_END_TIME_FIELD]: 9999, [DES_STAT_RESET_FIELD]: 99, [DES_MASTER_SEED_FIELD]: 7 } };
    replacement.add(sim);
    const other = { setEndTime: vi.fn(), setStatResetTime: vi.fn(), setMasterSeed: vi.fn() };
    const v = f.viewer as unknown as { scene: Object3D; registry: unknown; simulationKernel: unknown };
    v.scene = replacement;
    v.registry = { getNode: () => null, getAddressForNode: () => null, getPathForNode: () => 'Simulation' };
    v.simulationKernel = { mode: 'des', isSwitching: false, hasDesRunner: () => true, desControl: () => other };
    return { replacement, other };
  }

  it.each(['queued', 'during-writes', 'after-writes'] as const)('a model swap (scene + registry) %s leaves the replacement untouched and changes nothing live', async point => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    let loading = false;
    let swapped: ReturnType<typeof swapModel> | null = null;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const target = documentTarget(() => (f.viewer as unknown as { scene: Object3D }).scene, {
      // A real swap goes through the scene document's load: queued ops are dropped while it runs.
      canApply: () => !loading,
      gate: point === 'queued' ? () => gate : undefined,
      afterWrite: field => {
        if (point === 'during-writes' && field === DES_END_TIME_FIELD) { loading = true; swapped = swapModel(f); }
        if (point === 'after-writes' && field === DES_STAT_RESET_FIELD) swapped = swapModel(f);
      },
    });
    setActiveEditTarget(target);
    let blocker: Promise<unknown> | null = null;
    if (point === 'queued') {
      // Another settings operation holds the queue (its write waits on the gate); ours is called
      // behind it with the old model's context, then the model is swapped while ours waits.
      blocker = applyDesMasterSeed(f.viewer, f.ctl, 5);
      await new Promise(r => setTimeout(r, 0));
    }
    const pending = point === 'queued'
      ? applyDesClockSettings(f.viewer, f.ctl, { end: 7200, statReset: 300 })
      : f.run({ end: '00:02:00:00', statReset: '00:00:05:00' });
    if (point === 'queued') { swapped = swapModel(f); release(); await blocker; }
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('changed') });
    expect(managerOf(swapped!.replacement)).toMatchObject({ [DES_END_TIME_FIELD]: 9999, [DES_STAT_RESET_FIELD]: 99 });
    expect(f.ctl.setEndTime).not.toHaveBeenCalled();
    expect(f.ctl.setStatResetTime).not.toHaveBeenCalled();
    expect(swapped!.other.setEndTime).not.toHaveBeenCalled();
    expect(swapped!.other.setStatResetTime).not.toHaveBeenCalled();
  });

  it('concurrent clock and seed with a dropped seed write: each result agrees with persisted and live', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    setActiveEditTarget(documentTarget(f.scene, { write: (extras, field, value) => { if (field !== DES_MASTER_SEED_FIELD) extras[field] = value; } }));
    const [end, seed] = await Promise.all([
      f.run({ end: '00:02:00:00' }),
      commandRegistry.execute('des.seed.set', { seed: 43, mode: 'fixed' }, { origin: 'mcp', viewer: f.viewer }),
    ]);
    expect(end).toMatchObject({ ok: true, value: { endTime: 7200 } });
    expect(seed).toMatchObject({ ok: false, reason: expect.stringContaining('did not accept') });
    expect(managerOf(f.scene)).toMatchObject({ [DES_END_TIME_FIELD]: 7200, [DES_MASTER_SEED_FIELD]: 42 });
    expect(f.ctl.endTime).toBe(7200);
    expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();
  });

  it('end + warm-up are one unit: a dropped warm-up write rolls the end back, nothing live changes', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    setActiveEditTarget(documentTarget(f.scene, { write: (extras, field, value) => { if (field !== DES_STAT_RESET_FIELD) extras[field] = value; } }));
    expect(await f.run({ end: '00:02:00:00', statReset: '00:00:05:00' })).toMatchObject({ ok: false, reason: expect.stringContaining('did not accept') });
    expect(managerOf(f.scene)).toMatchObject({ [DES_END_TIME_FIELD]: 3600, [DES_STAT_RESET_FIELD]: 60 });
    expect(f.ctl.setEndTime).not.toHaveBeenCalled();
    expect(f.ctl.setStatResetTime).not.toHaveBeenCalled();
  });

  it('end 0 is stored as 0 and applied live as Infinity (indefinite on reload AND now)', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture(); setActiveEditTarget(documentTarget(f.scene));
    expect(await f.run({ end: '00:00:00:00' })).toMatchObject({ ok: true, value: { endTime: Infinity } });
    expect(managerOf(f.scene)[DES_END_TIME_FIELD]).toBe(0);
    expect(f.ctl.setEndTime).toHaveBeenLastCalledWith(Infinity);
  });

  it('seed 42 on a PalletYard-like DESManager (seed not stored = default 42) is accepted', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture(); delete managerOf(f.scene)[DES_MASTER_SEED_FIELD];
    // A write of the default value leaves the field absent (stored as "not set").
    const target = documentTarget(f.scene, { write: (extras, field, value) => { if (field === DES_MASTER_SEED_FIELD && value === 42) delete extras[field]; else extras[field] = value; } });
    setActiveEditTarget(target);
    const out = await commandRegistry.execute('des.seed.set', { seed: 42, mode: 'fixed' }, { origin: 'mcp', viewer: f.viewer });
    expect(out).toMatchObject({ ok: true, value: { mode: 'fixed' } });
    expect(f.ctl.masterSeed).toBe(42); expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();   // live already 42: no re-set
    expect(target.writes).toEqual([]);           // already the effective value: no write at all
    expect(await commandRegistry.execute('des.seed.set', { seed: 43 }, { origin: 'mcp', viewer: f.viewer })).toMatchObject({ ok: true });
    expect(managerOf(f.scene)[DES_MASTER_SEED_FIELD]).toBe(43);
  });

  it('end / warm-up equal to their defaults on a scene without a DESManager need no write', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture(); f.scene.remove(f.scene.getObjectByName('Simulation')!);
    const target = documentTarget(f.scene);
    setActiveEditTarget(target);
    expect(await f.run({ end: '01:00:00:00', statReset: '00:00:00:00' })).toEqual({ ok: true, value: { endTime: 86400, statResetTime: 0 } });
    expect(target.writes).toEqual([]);
  });

  it('a genuinely dropped write of a new value stays a failure', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture(); setActiveEditTarget(documentTarget(f.scene, { canApply: () => false }));
    expect(await commandRegistry.execute('des.seed.set', { seed: 43, mode: 'fixed' }, { origin: 'mcp', viewer: f.viewer })).toMatchObject({ ok: false, reason: expect.stringContaining('did not accept') });
    expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();
  });

  it('the clock window goes through des.setEnd / des.seed.set: refused while a batch holds the run lease', async () => {
    const { acquireRunLease } = await import('../../src/core/hmi/rv-run-lease');
    const f = fixture(); setActiveEditTarget(documentTarget(f.scene));
    render(<ThemeProvider theme={rvDarkTheme}><RVViewerProvider value={f.viewer}><DESControllerToolbar viewer={f.viewer} /></RVViewerProvider></ThemeProvider>);
    fireEvent.click(screen.getByTestId('des-clock'));
    const [end, warmup] = await screen.findAllByPlaceholderText('00:00:00:00');
    const lease = acquireRunLease('doc', 'batch')!;
    try {
      fireEvent.change(end, { target: { value: '00:02:00:00' } }); fireEvent.blur(end);
      fireEvent.change(warmup, { target: { value: '00:00:05:00' } }); fireEvent.blur(warmup);
      const seedInput = screen.getByTestId('des-seed-input');
      fireEvent.change(seedInput, { target: { value: '7' } }); fireEvent.blur(seedInput);
      await waitFor(() => expect(screen.getAllByText(/experiment/i).length).toBeGreaterThanOrEqual(3));
    } finally { lease.release(); }
    expect(f.ctl.setEndTime).not.toHaveBeenCalled();
    expect(f.ctl.setStatResetTime).not.toHaveBeenCalled();
    expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();
    expect(managerOf(f.scene)).toMatchObject({ [DES_END_TIME_FIELD]: 3600, [DES_STAT_RESET_FIELD]: 60, [DES_MASTER_SEED_FIELD]: 42 });
  });
});

describe('clock window fields commit on blur / Enter (LOP #248)', () => {
  it('incremental typing across the 200 ms refresh commits nothing until blur; "0" as end is refused', async () => {
    const f = fixture(); setActiveEditTarget(documentTarget(f.scene));
    render(<ThemeProvider theme={rvDarkTheme}><RVViewerProvider value={f.viewer}><DESControllerToolbar viewer={f.viewer} /></RVViewerProvider></ThemeProvider>);
    fireEvent.click(screen.getByTestId('des-clock'));
    const [end] = await screen.findAllByPlaceholderText('00:00:00:00');
    end.focus();
    for (const typed of ['0', '00', '00:0', '00:02', '00:02:0', '00:02:00:00']) {
      fireEvent.change(end, { target: { value: typed } });
      await new Promise(r => setTimeout(r, 220));             // past the toolbar's 200 ms snapshot poll
      expect(f.ctl.setEndTime).not.toHaveBeenCalled();
      expect(screen.getAllByPlaceholderText('00:00:00:00')[0]).toBe(end);
      expect((screen.getByRole('checkbox', { name: /Run indefinitely/ }) as HTMLInputElement).checked).toBe(false);
    }
    fireEvent.keyDown(end, { key: 'Enter' });
    await waitFor(() => expect(f.ctl.setEndTime).toHaveBeenCalledWith(7200));
    end.focus(); fireEvent.change(end, { target: { value: '0' } }); fireEvent.blur(end);
    expect(await screen.findByText(/greater than 0/)).toBeTruthy();
    expect(f.ctl.setEndTime).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('checkbox', { name: /Run indefinitely/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('formatDesTimeArg (LOP #248)', () => {
  it('rounds the whole duration with carry and never encodes a positive value as the indefinite 0', async () => {
    const { formatDesTimeArg } = await import('../../src/plugins/sim-controller/format-sim-time');
    expect(formatDesTimeArg(0.9999999)).toBe('00:00:00:01');
    expect(formatDesTimeArg(59.9999999)).toBe('00:00:01:00');
    expect(formatDesTimeArg(86399.9999999)).toBe('01:00:00:00');
    expect(formatDesTimeArg(1.5)).toBe('00:00:00:01.5');
    expect(formatDesTimeArg(0.000001)).toBe('00:00:00:00.000001');
    expect(formatDesTimeArg(0.0000004)).toBeNull();
    expect(formatDesTimeArg(0)).toBe('00:00:00:00');
    expect(formatDesTimeArg(Infinity)).toBe('inf');
    expect(formatDesTimeArg(-1)).toBeNull();
  });
});

describe('an unchanged commit is a no-op (LOP #248, Codex r5)', () => {
  it('helper: same stored AND live value -> no write and no live setter call', async () => {
    const f = fixture(); setActiveEditTarget(documentTarget(f.scene));
    expect(await applyDesClockSettings(f.viewer, f.ctl, { statReset: 300 })).toEqual({ ok: true });
    expect(f.ctl.setStatResetTime).toHaveBeenCalledTimes(1);
    expect(await applyDesClockSettings(f.viewer, f.ctl, { statReset: 300 })).toEqual({ ok: true });
    expect(f.ctl.setStatResetTime).toHaveBeenCalledTimes(1);
    expect(await applyDesMasterSeed(f.viewer, f.ctl, 42)).toEqual({ ok: true });     // stored 42, live 42
    expect(f.ctl.setMasterSeed).not.toHaveBeenCalled();
  });

  it('clock: commit warm-up 300, sim past 300, focus + blur without an edit commits nothing again', async () => {
    const f = fixture(); setActiveEditTarget(documentTarget(f.scene));
    render(<ThemeProvider theme={rvDarkTheme}><RVViewerProvider value={f.viewer}><DESControllerToolbar viewer={f.viewer} /></RVViewerProvider></ThemeProvider>);
    fireEvent.click(screen.getByTestId('des-clock'));
    const warmup = (await screen.findAllByPlaceholderText('00:00:00:00'))[1] as HTMLInputElement;
    warmup.focus(); fireEvent.change(warmup, { target: { value: '300' } }); fireEvent.blur(warmup);
    await waitFor(() => expect(f.ctl.setStatResetTime).toHaveBeenCalledWith(300));
    (f.ctl as { simTime: number }).simTime = 400;
    await new Promise(r => setTimeout(r, 450));                      // two 200 ms snapshot polls
    const again = (screen.getAllByPlaceholderText('00:00:00:00')[1]) as HTMLInputElement;
    expect(again.value).toBe('00:00:05:00');                        // display follows the stored value
    again.focus(); fireEvent.blur(again);
    again.focus(); fireEvent.keyDown(again, { key: 'Enter' });
    await new Promise(r => setTimeout(r, 50));
    expect(f.ctl.setStatResetTime).toHaveBeenCalledTimes(1);
  });
});

describe('DES-Perfektion A2 — a settings write while the scene loads waits for it (tutorial gap 13)', () => {
  /** A scene target whose document reports `acceptsOps` like the SceneStore does during a load. */
  function loadingTarget(f: ReturnType<typeof fixture>) {
    const state = { loading: true };
    const target = documentTarget(f.scene, { canApply: () => !state.loading });
    const key = { get acceptsOps() { return !state.loading; } };
    Object.defineProperty(target, 'documentKey', { value: key });
    return { target, state };
  }

  it('des.setEnd issued while the scene document loads is written once the load is done, then applied live', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    const { target, state } = loadingTarget(f);
    setActiveEditTarget(target);
    const pending = f.run({ end: '00:02:00:00', statReset: '00:00:05:00' });
    await new Promise(r => setTimeout(r, 120));
    expect(target.writes, 'nothing is written into a loading document').toEqual([]);
    state.loading = false;
    expect(await pending).toEqual({ ok: true, value: { endTime: 7200, statResetTime: 300 } });
    expect(managerOf(f.scene)).toMatchObject({ [DES_END_TIME_FIELD]: 7200, [DES_STAT_RESET_FIELD]: 300 });
  });

  it('des.seed.set issued while the scene document loads is written once the load is done', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    const { target, state } = loadingTarget(f);
    setActiveEditTarget(target);
    const pending = commandRegistry.execute('des.seed.set', { seed: 44, mode: 'fixed' }, { origin: 'mcp', viewer: f.viewer });
    setTimeout(() => { state.loading = false; }, 80);
    expect(await pending).toMatchObject({ ok: true }); // the fixture's setMasterSeed is a spy: the call below is the live change
    expect(managerOf(f.scene)[DES_MASTER_SEED_FIELD]).toBe(44);
    expect(f.ctl.setMasterSeed).toHaveBeenCalledWith(44);
  });

  it('two writes called during the same load both land once it is done (Codex: queue entries share the load)', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    const { target, state } = loadingTarget(f);
    setActiveEditTarget(target);
    const end = f.run({ end: '00:02:00:00' });
    const seed = commandRegistry.execute('des.seed.set', { seed: 44, mode: 'fixed' }, { origin: 'mcp', viewer: f.viewer });
    setTimeout(() => {
      // The load brings a fresh registry (and scene graph state) for the same model.
      (f.viewer as unknown as { registry: unknown }).registry = { getNode: () => null, getAddressForNode: () => null, getPathForNode: () => 'Simulation' };
      state.loading = false;
    }, 80);
    expect(await end).toMatchObject({ ok: true, value: { endTime: 7200 } });
    expect(await seed).toMatchObject({ ok: true });
    expect(managerOf(f.scene)).toMatchObject({ [DES_END_TIME_FIELD]: 7200, [DES_MASTER_SEED_FIELD]: 44 });
  });

  it('a further load after the awaited one is refused: no write into the later replacement', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    const v = f.viewer as unknown as { loadGeneration: number; whenSceneReady: () => Promise<void> };
    v.loadGeneration = 1;
    let settle!: () => void;
    v.whenSceneReady = () => new Promise<void>(r => { settle = r; });
    const { target, state } = loadingTarget(f);
    setActiveEditTarget(target);
    const pending = f.run({ end: '00:02:00:00' });
    await new Promise(r => setTimeout(r, 60));
    state.loading = false;                       // the awaited load is done, its scene still fills
    await new Promise(r => setTimeout(r, 60));
    v.loadGeneration = 3;                        // a replacement of the same model starts and ends
    settle();
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('changed') });
    expect(target.writes).toEqual([]);
    expect(f.ctl.setEndTime).not.toHaveBeenCalled();
  });

  it('a later load that completes while the call still queues is refused (Codex r2: watched from the call)', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    const v = f.viewer as unknown as { loadGeneration: number };
    v.loadGeneration = 1;
    const { target, state } = loadingTarget(f);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    // Another settings operation holds the queue: its write waits on the gate.
    setActiveEditTarget(documentTarget(f.scene, { gate: () => gate }));
    const blocker = applyDesMasterSeed(f.viewer, f.ctl, 5);
    await new Promise(r => setTimeout(r, 0));
    setActiveEditTarget(target);
    const pending = f.run({ end: '00:02:00:00' });
    await new Promise(r => setTimeout(r, 40));
    state.loading = false;                       // the awaited load ends ...
    await new Promise(r => setTimeout(r, 80));
    v.loadGeneration = 3;                        // ... and a further one completes while we queue
    release(); await blocker;
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('changed') });
    expect(target.writes).toEqual([]);
    expect(f.ctl.setEndTime).not.toHaveBeenCalled();
  });

  it('a further load starting right as the awaited one ends is refused (Codex r3: settled from the notification)', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    const v = f.viewer as unknown as { loadGeneration: number };
    v.loadGeneration = 2;
    const listeners = new Set<() => void>();
    const state = { loading: true };
    const target = documentTarget(f.scene, { canApply: () => !state.loading });
    const key = { get acceptsOps() { return !state.loading; }, subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); } };
    Object.defineProperty(target, 'documentKey', { value: key });
    setActiveEditTarget(target);
    const pending = f.run({ end: '00:02:00:00' });
    await new Promise(r => setTimeout(r, 40));
    // The awaited load ends and notifies; in the same tick a replacement of the same model starts ...
    state.loading = false; for (const l of [...listeners]) l();
    state.loading = true; v.loadGeneration = 4;
    await new Promise(r => setTimeout(r, 40));
    state.loading = false; for (const l of [...listeners]) l();   // ... and ends before any poll saw a gap
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('changed') });
    expect(target.writes).toEqual([]);
    expect(f.ctl.setEndTime).not.toHaveBeenCalled();
  });

  it('a scene that never completes ends the wait as a failure, nothing written', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      ensureDesRunCommandsRegistered();
      const f = fixture();
      (f.viewer as unknown as { whenSceneReady: () => Promise<void> }).whenSceneReady = () => new Promise<void>(() => {});
      const { target, state } = loadingTarget(f);
      setActiveEditTarget(target);
      const pending = f.run({ end: '00:02:00:00' });
      state.loading = false;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('still loading') });
      expect(target.writes).toEqual([]);
      expect(f.ctl.setEndTime).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('a load that brings ANOTHER model is refused after the wait: nothing written, nothing live', async () => {
    ensureDesRunCommandsRegistered();
    const f = fixture();
    (f.viewer as unknown as { currentModelUrl: string }).currentModelUrl = 'a.glb';
    const { target, state } = loadingTarget(f);
    setActiveEditTarget(target);
    const pending = f.run({ end: '00:02:00:00' });
    setTimeout(() => { (f.viewer as unknown as { currentModelUrl: string }).currentModelUrl = 'b.glb'; state.loading = false; }, 80);
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('changed') });
    expect(target.writes).toEqual([]);
    expect(f.ctl.setEndTime).not.toHaveBeenCalled();
  });
});
