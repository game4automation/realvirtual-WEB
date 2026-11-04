// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DESManager } from '../../src/plugins/des/rv-des-manager';
import { RunIdentity } from '../../src/plugins/des/rv-des-run-identity';
import { __resetDesRunSettingsForTest, updateDesRunSettings } from '../../src/core/hmi/des-run-settings-store';
describe('core run identity', () => {
 beforeEach(() => __resetDesRunSettingsForTest());
 it('preserves FA8 start/end events and the identity on continuation', () => {
  const manager = new DESManager(); manager.setMasterSeed(42);
  const emit = vi.fn(); const identity = new RunIdentity(manager, emit);
  identity.start(); const id = identity.runId;
  expect(emit).toHaveBeenCalledWith('simulation-run-started', { runId: id, seed: 42 });
  identity.complete(); identity.complete();
  expect(emit.mock.calls.filter(([event]) => event === 'simulation-run-ending')).toHaveLength(1);
  expect(identity.reopen()).toBe(true); expect(identity.runId).toBe(id);
  const late = vi.fn(); const off = identity.subscribe(late); expect(late).toHaveBeenCalledOnce();
  off(); identity.complete('manual'); expect(late).toHaveBeenCalledOnce();
  manager.reset(); identity.start(); expect(identity.runId).not.toBe(id); identity.dispose();
 });
 it.each(['auto', 'fixed'] as const)('renews seeds only in auto mode (%s)', mode => {
  updateDesRunSettings({ seedMode: mode });
  const manager = new DESManager(); manager.setMasterSeed(42);
  const identity = new RunIdentity(manager); identity.start(); manager.reset();
  if (mode === 'auto') expect(manager.masterSeed).not.toBe(42);
  else expect(manager.masterSeed).toBe(42);
  identity.dispose();
 });
});
