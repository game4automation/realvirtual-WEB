// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-2208b B3: des.seed.get / des.seed.set are the clock window's "Random seed" setting. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { createDesRunCommandDescriptors, ensureDesRunCommandsRegistered } from '../../src/core/hmi/des-run-commands';
import { __resetDesRunSettingsForTest, getDesRunSettings, updateDesRunSettings } from '../../src/core/hmi/des-run-settings-store';
import { acquireRunLease } from '../../src/core/hmi/rv-run-lease';
import { commandClassOf } from '../../src/plugins/mcp-bridge/rv-mcp-tool-class';
import * as managerNode from '../../src/core/material-flow/des-manager-node';
import type { RVViewer } from '../../src/core/rv-viewer';

vi.mock('../../src/core/material-flow/des-manager-node', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/core/material-flow/des-manager-node')>(),
  // The scene write is the clock window's; here only the live seed is observed.
  applyDesMasterSeed: vi.fn(async (_viewer: unknown, ctl: { setMasterSeed?(s: number): void } | null, seed: number) => { ctl?.setMasterSeed?.(seed); return { ok: true as const }; }),
}));

function fixture(des = true) {
  const ctl = { masterSeed: 42, setMasterSeed: vi.fn(function (this: { masterSeed: number }, seed: number) { this.masterSeed = seed; }) };
  const viewer = { simulationKernel: { desControl: () => des ? ctl : null } } as unknown as RVViewer;
  const run = (id: string, args: Record<string, unknown> = {}) => commandRegistry.execute(id, args, { origin: 'mcp', viewer });
  return { ctl, viewer, run };
}

describe('des.seed commands', () => {
  beforeEach(() => { __resetDesRunSettingsForTest(); ensureDesRunCommandsRegistered(); vi.mocked(managerNode.applyDesMasterSeed).mockClear(); });
  afterEach(() => __resetDesRunSettingsForTest());

  it('declares get as read and set as sim', () => {
    const d = createDesRunCommandDescriptors();
    expect(commandClassOf(d.find(x => x.id === 'des.seed.get')!)).toBe('read');
    expect(commandClassOf(d.find(x => x.id === 'des.seed.set')!)).toBe('sim');
  });

  it('reads the live seed and the seed mode', async () => {
    const f = fixture();
    expect(await f.run('des.seed.get')).toEqual({ ok: true, value: { seed: 42, mode: 'fixed' } });
    updateDesRunSettings({ seedMode: 'auto' });
    expect(await f.run('des.seed.get')).toEqual({ ok: true, value: { seed: 42, mode: 'auto' } });
  });

  it('sets a fixed seed through the clock window seed path', async () => {
    const f = fixture();
    expect(await f.run('des.seed.set', { seed: 1234, mode: 'fixed' })).toEqual({ ok: true, value: { seed: 1234, mode: 'fixed' } });
    expect(managerNode.applyDesMasterSeed).toHaveBeenCalledWith(f.viewer, f.ctl, 1234);
    expect(getDesRunSettings().seedMode).toBe('fixed');
  });

  it('switches to auto without touching the seed and refuses a seed in auto mode', async () => {
    const f = fixture();
    expect(await f.run('des.seed.set', { mode: 'auto' })).toEqual({ ok: true, value: { seed: 42, mode: 'auto' } });
    expect(managerNode.applyDesMasterSeed).not.toHaveBeenCalled();
    expect(await f.run('des.seed.set', { seed: 7 })).toMatchObject({ ok: false, reason: expect.stringContaining('auto mode') });
    expect(f.ctl.masterSeed).toBe(42);
    // Back to fixed with a seed in one call.
    expect(await f.run('des.seed.set', { seed: 7, mode: 'fixed' })).toEqual({ ok: true, value: { seed: 7, mode: 'fixed' } });
  });

  it.each([
    [{}, 'Give seed, mode or both'], [{ mode: 'random' }, "mode must be 'fixed' or 'auto'"],
    [{ seed: 0 }, 'seed must be an integer'], [{ seed: 1.5 }, 'seed must be an integer'], [{ seed: 2 ** 31 }, 'seed must be an integer'],
  ])('refuses %j', async (args, reason) => {
    const f = fixture();
    expect(await f.run('des.seed.set', args)).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    expect(f.ctl.masterSeed).toBe(42);
  });

  it('needs DES mode and is blocked while a batch holds the run lease', async () => {
    expect(await fixture(false).run('des.seed.get')).toMatchObject({ ok: false, reason: expect.stringContaining('DES not active') });
    const f = fixture();
    const lease = acquireRunLease('doc', 'batch')!;
    try {
      expect(await f.run('des.seed.set', { seed: 9 })).toMatchObject({ ok: false });
      expect(await f.run('des.seed.get')).toMatchObject({ ok: true });
    } finally { lease.release(); }
    expect(f.ctl.masterSeed).toBe(42);
  });
});

describe('des.checkpoint* without the experiment manager', () => {
  it.each(['des.checkpoint.list', 'des.checkpoint.load', 'des.checkpoints.set'])('%s answers commercial-feature', async id => {
    expect(await fixture().run(id)).toMatchObject({ ok: false, kind: 'commercial-feature', details: { module: 'des-experiments' } });
  });
  it('leaves the core des.* commands alone', async () => {
    expect(await fixture().run('des.seed.get')).toMatchObject({ ok: true });
  });
});
