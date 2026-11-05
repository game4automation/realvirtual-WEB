// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it, vi } from 'vitest';
import { SnapshotRegistry, type Snapshottable } from '../../src/plugins/des/rv-snapshot-registry';
import { createCaptureSession } from '../../src/plugins/des/rv-snapshot-contract';

function setup() {
  const parent = { run: {}, service: {} }, step = { run: { state: 1 }, config: {} }, fb = { run: { value: false }, clock: {} };
  const capture = vi.fn(() => ({ steps: [step.run], fbs: [fb.run] }));
  const p: Snapshottable = { key: 'core.aggregate', version: 1, owner: parent, stateKeys: ['run'], services: ['service'],
    owners: function* () {
      yield { path: 'steps.Cell/Step', owner: step, stateKeys: ['run'], services: ['config'] };
      yield { path: 'programs.Cell/P10.fbs.timer', owner: fb, stateKeys: ['run'], services: ['clock'] };
    }, capture, validate: () => [], prepare: () => null, commit: () => {} };
  const registry = new SnapshotRegistry(); registry.register(p);
  return { registry, p, parent, step, fb, capture };
}

it('checks every concrete owner and preserves the single-owner capture path', () => {
  const { registry, capture } = setup();
  expect(registry.captureAll(createCaptureSession())[0].state).toEqual({ steps: [{ state: 1 }], fbs: [{ value: false }] });
  expect(capture).toHaveBeenCalledOnce();
});

it.each(['step', 'fb'] as const)('reports a hidden %s property with participant, owner and property', target => {
  const f = setup(); Object.defineProperty(f[target], 'hiddenCounter', { value: 42, enumerable: false });
  const path = target === 'step' ? 'steps.Cell/Step' : 'programs.Cell/P10.fbs.timer';
  expect(() => f.registry.captureAll(createCaptureSession())).toThrow(`des-state-not-declared: core.aggregate.${path}.hiddenCounter`);
  try { f.registry.captureAll(createCaptureSession()); } catch (error) {
    expect(error).toMatchObject({ code: 'des-state-not-declared', participant: 'core.aggregate', owner: path, property: `${path}.hiddenCounter` });
  }
  expect(f.capture).not.toHaveBeenCalled();
});

it('includes symbol keys and collects violations across parent and aggregated owners before capture', () => {
  const f = setup();
  Object.defineProperty(f.parent, 'extra', { value: 1 });
  Object.defineProperty(f.step, Symbol('hidden'), { value: 2 });
  Object.defineProperty(f.fb, 'extra', { value: 3 });
  try { f.registry.captureAll(createCaptureSession()); throw new Error('expected guard failure'); } catch (error) {
    expect(error).toMatchObject({ errors: [
      { participant: 'core.aggregate', property: 'extra' },
      { participant: 'core.aggregate', owner: 'steps.Cell/Step', property: 'steps.Cell/Step.Symbol(hidden)' },
      { participant: 'core.aggregate', owner: 'programs.Cell/P10.fbs.timer', property: 'programs.Cell/P10.fbs.timer.extra' },
    ] });
  }
  expect(f.capture).not.toHaveBeenCalled();
});

it('checks owners without a primary owner and discovers dynamically added owners', () => {
  const f = setup(); const late = { run: {}, unclassified: 1 };
  const owners = [...f.p.owners!()];
  f.registry.unregister(f.p.key);
  f.registry.register({ ...f.p, owner: undefined, owners: () => owners });
  f.registry.captureAll(createCaptureSession());
  owners.push({ path: 'late', owner: late, stateKeys: ['run'] });
  expect(() => f.registry.captureAll(createCaptureSession())).toThrow('core.aggregate.late.unclassified');
});
