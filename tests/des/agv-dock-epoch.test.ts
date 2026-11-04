// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it, vi } from 'vitest';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { serviceFixture } from './phase4-agv-fixture';

it('9.13 a release from an abandoned dock cannot end the next dock service', () => {
  const f = serviceFixture();
  let oldRelease: (() => void) | undefined, currentRelease: (() => void) | undefined;
  const docks = getDefaultPathDockRegistry();
  const removeOldDock = docks.register('A', { onVehicleArrive: (_id, release) => { oldRelease = release; } });
  docks.register('B', { onVehicleArrive: (_id, release) => { currentRelease = release; } });
  f.handle.assign({ destination: 'A' });
  f.until(() => !!oldRelease);
  // The abandoned station no longer accepts visits, but its outstanding
  // asynchronous completion still owns the release closure from this stay.
  removeOldDock();
  const ended = vi.fn();
  f.handle.assign({ destination: 'B', onServiceEnd: ended });
  f.until(() => !!currentRelease);
  expect(f.handle.phase).toBe('servicing');
  oldRelease!();
  f.advance(1);
  expect(ended, 'stale release must not run the second task callback').not.toHaveBeenCalled();
  expect(f.handle.phase).toBe('servicing');
  currentRelease!();
  f.until(() => ended.mock.calls.length === 1);
  currentRelease!(); oldRelease!(); f.advance(1);
  expect(ended).toHaveBeenCalledTimes(1);
});
