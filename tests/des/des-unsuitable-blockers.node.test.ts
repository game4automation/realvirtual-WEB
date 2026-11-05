// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesSnapshotBlockers } from '../../src/core/material-flow/des-snapshot-blockers';
import type { DesUnsuitableEntry } from '../../src/core/material-flow/des-unsuitable-entry';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { cycleRunnerFixture } from './cycle-runner-fixture';

const code = 'des-plc-not-event-suitable';
const finding = (node = 'P1', line = 7, rule = 'D1'): DesUnsuitableEntry => ({
  system: 'PLC program', node, code, line, column: 3, rule, message: 'State never settles.',
});
const problems = () => getProblems().filter(p => p.code === code);
const hazards = (runner: DESRunner) => (runner as unknown as { _logicHazards(): unknown })._logicHazards();

afterEach(() => { clearAllProblems(); vi.restoreAllMocks(); });

describe('DES suitability registry', () => {
  it('collects fourth-argument entries independently of snapshot reasons and presence', () => {
    const registry = new DesSnapshotBlockers();
    const presence = [{ system: 'PLC program', nodes: ['P1'] }];
    registry.register('legacy', () => 'running', () => presence);
    registry.register('reason-only', () => null);
    const before = registry.batchHazards();
    const off = registry.register('checked', () => null, undefined, () => [finding(), finding('P2', 12, 'D2')]);
    expect(registry.desUnsuitable()).toEqual([finding(), finding('P2', 12, 'D2')]);
    expect(registry.batchHazards()).toEqual(before);
    expect(registry.reasons()).toEqual(['legacy: running']);
    off();
    expect(registry.desUnsuitable()).toEqual([]);
    expect(registry.batchHazards()).toEqual(before);
    const offBoth = registry.register('both', () => null, () => presence, () => [finding()]);
    expect(registry.batchHazards()).toEqual([...before, ...presence]);
    offBoth();
    expect(registry.batchHazards()).toEqual(before);
  });

  it('notifies subscribers, catches a throwing callback, and supports unsubscribe', () => {
    const registry = new DesSnapshotBlockers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = vi.fn(() => { throw new Error('subscriber failure'); });
    const healthy = vi.fn();
    const offBroken = registry.onChanged(broken);
    const offHealthy = registry.onChanged(healthy);
    expect(healthy).not.toHaveBeenCalled();
    expect(() => registry.notifyChanged()).not.toThrow();
    expect(broken).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    offBroken(); offBroken();
    registry.notifyChanged();
    expect(broken).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledTimes(2);
    offHealthy();
    registry.notifyChanged();
    expect(healthy).toHaveBeenCalledTimes(2);
  });
});

describe('DES runner suitability Problems', () => {
  it('reports one error per entry on start, with node, line, rule and catalog title', () => {
    const f = cycleRunnerFixture();
    let entries = [finding(), finding('P2', 12, 'D2')];
    f.host.snapshotBlockers.register('plc', () => null, undefined, () => entries);
    expect(() => f.start()).not.toThrow();
    expect(problems()).toHaveLength(2);
    for (const entry of entries) {
      expect(problems()).toContainEqual(expect.objectContaining({
        id: expect.stringMatching(new RegExp(`^${code}:.*:${entry.node}:${entry.line}:${entry.rule}$`)),
        code, severity: 'error', title: 'PLC program cannot run on events', nodePath: entry.node,
        detail: `${entry.node} line ${entry.line}: ${entry.message} [${entry.rule}]`, at: 0,
      }));
    }
    // Logic ownership can refresh on ticks without losing the PLC subscription.
    f.runner.tick(0);
    entries = [];
    f.host.snapshotBlockers.notifyChanged();
    expect(problems()).toEqual([]);
  });

  it('groups hazard labels by system and includes program, line and rule', () => {
    const f = cycleRunnerFixture();
    f.host.snapshotBlockers.register('plc', () => null, undefined, () => [finding(), finding('P2', 12, 'D2')]);
    f.start();
    expect(hazards(f.runner)).toContainEqual({ system: 'PLC program', nodes: ['P1 (line 7, D1)', 'P2 (line 12, D2)'] });
  });

  it('exposes the single-entry hazard without changing presence', () => {
    const f = cycleRunnerFixture();
    f.host.snapshotBlockers.register('plc', () => null, undefined, () => [finding()]);
    f.start();
    expect(f.host.snapshotBlockers.batchHazards()).toEqual([]);
    expect(hazards(f.runner)).toContainEqual({ system: 'PLC program', nodes: ['P1 (line 7, D1)'] });
  });

  it.each(['clearMUs', 'dispose'] as const)('%s clears owned errors and unsubscribes', method => {
    const f = cycleRunnerFixture();
    f.host.snapshotBlockers.register('plc', () => null, undefined, () => [finding()]);
    f.start();
    expect(problems()).toHaveLength(1);
    f.runner[method]();
    expect(problems()).toEqual([]);
    f.host.snapshotBlockers.notifyChanged();
    expect(problems()).toEqual([]);
  });

  it('reset clears stale errors and subscribes again for the restarted run', () => {
    const f = cycleRunnerFixture();
    let entries = [finding()];
    f.host.snapshotBlockers.register('plc', () => null, undefined, () => entries);
    f.start();
    entries = [];
    f.runner.reset();
    expect(problems()).toEqual([]);
    entries = [finding('P2', 12, 'D2')];
    f.host.snapshotBlockers.notifyChanged();
    expect(problems()).toHaveLength(1);
    expect(problems()[0].detail).toContain('P2 line 12');
  });

  it('teardown of one runner leaves the other viewer\'s errors intact', () => {
    const one = cycleRunnerFixture(), two = cycleRunnerFixture();
    for (const f of [one, two]) {
      f.host.snapshotBlockers.register('plc', () => null, undefined, () => [finding()]);
      f.start();
    }
    expect(problems()).toHaveLength(2);
    one.runner.clearMUs();
    expect(problems()).toHaveLength(1);
    two.runner.dispose();
    expect(problems()).toEqual([]);
  });
});
