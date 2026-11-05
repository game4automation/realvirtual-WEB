// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { clearProblemsOfCode, getProblems } from '../../src/core/hmi/problems-store';
import { snapshotUserMessage } from '../../src/core/sdk/rv-des-snapshot-messages';

const CODE = 'des-snapshot-plc-pending';

function pendingGate() {
  let pending = true;
  let release!: () => void;
  const cleared = new Promise<void>(resolve => { release = resolve; });
  return {
    gate: { check: () => pending ? { code: CODE, detail: 'Station01' } : null, whenClear: () => cleared },
    clear() { pending = false; release(); },
  };
}

describe('plan-2207 P5c — snapshot gate of a transient owner state', () => {
  afterEach(() => clearProblemsOfCode(CODE));

  it('refuses capture and synchronous restore with the owner code before anything else', () => {
    const runner = new DESRunner();
    const { gate } = pendingGate();
    runner.simEvents.registerSnapshotGate!('plc.deploy', gate);
    expect(() => runner.fullSnapshot()).toThrow(CODE);
    expect(() => runner.restoreFull({})).toThrow(CODE);
    const problem = getProblems().find(p => p.code === CODE)!;
    expect(problem.title).toBe(snapshotUserMessage(CODE).title);
    expect(problem.detail).toContain('Station01');
  });

  it('whenCycleOwnersReady waits until the gate is clear', async () => {
    const runner = new DESRunner();
    const g = pendingGate();
    runner.simEvents.registerSnapshotGate!('plc.deploy', g.gate);
    let ready = false;
    const waiting = runner.whenCycleOwnersReady().then(() => { ready = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(ready).toBe(false);
    g.clear();
    await waiting;
    expect(ready).toBe(true);
  });

  it('retires the refusal from Problems once the gate clears', async () => {
    const runner = new DESRunner();
    const g = pendingGate();
    runner.simEvents.registerSnapshotGate!('plc.deploy', g.gate);
    expect(() => runner.restoreFull({})).toThrow(CODE);
    expect(getProblems().some(p => p.code === CODE)).toBe(true);
    g.clear();
    await runner.whenCycleOwnersReady();
    await Promise.resolve();
    expect(getProblems().some(p => p.code === CODE)).toBe(false);
  });

  it('an unregistered gate no longer refuses; duplicate ids are rejected', () => {
    const runner = new DESRunner();
    const { gate } = pendingGate();
    const off = runner.simEvents.registerSnapshotGate!('plc.deploy', gate);
    expect(() => runner.simEvents.registerSnapshotGate!('plc.deploy', gate)).toThrow('duplicate');
    off();
    let error: unknown;
    try { runner.fullSnapshot(); } catch (e) { error = e; }
    expect(String(error ?? '')).not.toContain(CODE);
  });
});
