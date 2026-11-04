// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it, vi } from 'vitest';
import { lineFixture } from './c2a-fixture';
import { getProblems } from '../../src/core/hmi/problems-store';

it('preserves manager and component identities while replacing the queue', () => {
  const a = lineFixture(); a.runUntil(23);
  const manager = a.manager, owners = [...a.components];
  const oldQueue = (manager as unknown as { queue: object }).queue;
  const saved = a.runner.fullSnapshot();
  a.runner.restoreFull(saved);
  expect(a.runner.getManager()).toBe(manager);
  a.components.forEach((owner, i) => expect(owner).toBe(owners[i]));
  expect((manager as unknown as { queue: object }).queue).not.toBe(oldQueue);
  expect(a.runner.fullSnapshot()).toEqual(saved);
});
it('prepare failure leaves all live state unchanged', () => {
  const a = lineFixture(); a.runUntil(23);
  const saved = a.runner.fullSnapshot(), before = a.runner.snapshotJson();
  const original = (a.runner as unknown as { _snapshotParticipants: (...args: unknown[]) => { registry: { order(): Array<{ key: string; prepare: () => unknown }> } } })._snapshotParticipants.bind(a.runner);
  const spy = vi.spyOn(a.runner as unknown as { _snapshotParticipants: typeof original }, '_snapshotParticipants').mockImplementation(((...args: unknown[]) => {
    const frame = original(...args);
    frame.registry.order().find(p => p.key === 'des.manager')!.prepare = () => { throw new Error('late prepare'); };
    return frame;
  }));
  expect(() => a.runner.restoreFull(saved)).toThrow('late prepare'); spy.mockRestore();
  expect(a.runner.snapshotJson()).toBe(before);
  const baseline = lineFixture(); baseline.runner.restoreFull(saved);
  a.runUntil(53); baseline.runUntil(53);
  expect(a.runner.snapshotJson()).toBe(baseline.runner.snapshotJson());
});
it('apply failure forces a reset and reports corruption', () => {
  const a = lineFixture(); a.runUntil(23);
  const saved = a.runner.fullSnapshot();
  const spy = vi.spyOn(a.source, 'fromSnapshot').mockImplementation(() => { throw new Error('apply'); });
  try { a.runner.restoreFull(saved); throw new Error('restore unexpectedly succeeded'); }
  catch (error) { expect(error).toMatchObject({ code: 'des-restore-commit-failed', status: 'corrupt' }); }
  spy.mockRestore();
  expect(a.manager.currentTime).toBe(0);
  expect(getProblems().some(p => p.code === 'des-restore-commit-failed')).toBe(true);
});
