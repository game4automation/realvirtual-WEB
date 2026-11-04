// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { createIkCommandDescriptors } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';

describe('plan-2214 final descriptors', () => {
  const descriptors = createIkCommandDescriptors();
  it('exposes cancellable run as a sim job without recording or mirror', () => {
    const run = descriptors.find(d => d.id === 'ik.path.run')!;
    expect(run).toMatchObject({ toolClass: 'sim', timeoutMs: 600000, cancellable: true, macro: false, readOnly: false });
    expect(run.mcp).toBeUndefined();
    expect(run.undoLabel).toBeUndefined();
    const stop = descriptors.find(d => d.id === 'ik.path.stop')!;
    expect(stop).toMatchObject({ toolClass: 'sim', macro: false, readOnly: false });
    expect(stop.timeoutMs).toBeUndefined();
    expect(stop.mcp).toBeUndefined();
  });
  it('classifies moveTcp and check without mirrors or undo', () => {
    for (const id of ['ik.robot.moveTcp', 'ik.path.check']) {
      const d = descriptors.find(d => d.id === id)!;
      expect(d.readOnly).toBe(id === 'ik.path.check');
      expect(d.macro).toBe(false);
      expect(commandClassOf(d)).toBe(id === 'ik.path.check' ? 'read' : 'sim');
      expect(d.mcp).toBeUndefined(); expect(d.undoLabel).toBeUndefined();
      expect(d.timeoutMs).toBeUndefined(); expect(d.cancellable).toBeUndefined();
    }
  });
  it('declares setGrip as an undoable recorded edit without a mirror', () => {
    const d = descriptors.find(d => d.id === 'ik.target.setGrip')!;
    expect(d).toMatchObject({ macro: true, readOnly: false, undoLabel: 'Set waypoint grip' });
    expect(commandClassOf(d)).toBe('edit'); expect(d.mcp).toBeUndefined();
  });
  it('preserves all fourteen existing commands and their classification', () => {
    const old = descriptors.filter(d => !['ik.path.run', 'ik.path.stop', 'ik.robot.moveTcp', 'ik.path.check', 'ik.target.setGrip'].includes(d.id));
    expect(old).toHaveLength(14);
    const writes = ['ik.robot.rig', 'ik.path.create', 'ik.target.add', 'ik.target.set', 'ik.target.remove', 'ik.target.reorder', 'ik.target.solve'];
    for (const d of old) {
      const write = writes.includes(d.id);
      expect(d.readOnly).toBe(!write);
      expect(d.macro ?? false).toBe(write);
      expect(commandClassOf(d)).toBe(write ? 'edit' : 'read');
      expect(d.timeoutMs).toBeUndefined();
      expect(d.cancellable).toBeUndefined();
      expect(d.toolClass).toBeUndefined();
      if (write || d.id === 'ik.program.export') expect(d.mcp).toBeDefined();
    }
  });
});
