// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { lineFixture } from './runner-fixture';
import { installExperimentBackend } from '../../src/plugins/des/des-experiment-seam';
describe('experiment seam without backend', () => {
 it('runs, finishes, continues, resets and restores a snapshot without opening storage', async () => {
  const open = vi.spyOn(indexedDB, 'open');
  const { runner, manager } = lineFixture({ experiments: false });
  try {
   expect(runner.listExperiments).toBeUndefined();
   manager.duration = 30;
   expect(await runner.runFastForward()).toBe(true);
   expect(manager.currentTime).toBe(30);
   const snapshot = runner.snapshotJson();
   manager.duration = 60;
   runner.continueRun();
   await runner.runFastForward();
   runner.reset();
   runner.restoreJson(snapshot);
   expect(manager.currentTime).toBe(30);
   expect(open).not.toHaveBeenCalled();
  } finally { runner.dispose(); open.mockRestore(); }
 });
 it('attaches a late backend to the current run and detaches it on uninstall', () => {
  const { runner } = lineFixture({ experiments: false });
  const dispose = vi.fn(); let id: string | null = null;
  const uninstall = installExperimentBackend((_host, identity) => {
   id = identity.runId;
   return { beforeStart() {}, dispose, listExperiments: async () => [] };
  });
  expect(id).toBeTruthy(); expect(runner.listExperiments).toBeTypeOf('function');
  uninstall(); expect(runner.listExperiments).toBeUndefined(); expect(dispose).toHaveBeenCalledOnce();
 });
});
