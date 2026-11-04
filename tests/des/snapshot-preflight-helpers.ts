// SPDX-License-Identifier: AGPL-3.0-only
import { expect, vi } from 'vitest';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';

export function rejectSnapshotWithoutMutation(runner: DESRunner, before: DESSnapshotV4, saved: DESSnapshotV4) {
  const reset = vi.spyOn(runner, 'reset');
  expect(() => runner.restoreFull(saved)).toThrow();
  expect(reset).not.toHaveBeenCalled();
  expect(runner.fullSnapshot()).toEqual(before);
}
