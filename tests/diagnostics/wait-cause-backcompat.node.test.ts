// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { formatWaitCause, waitTimeoutProblemId, FLEET_WAIT_TIMEOUT_CODE } from '../../src/core/fleet/exec/wait-watch';
it('structured metadata preserves exact timeout text and identity', () => {
  const cause = { order: 'o1', waitingFor: 'fork', heldBy: 'drive', extra: 'detail' };
  const expected = 'Vehicle: A\nOrder: o1\nWaiting for: fork\nHeld by: drive\ndetail';
  expect(formatWaitCause('A', cause)).toBe(expected);
  expect(formatWaitCause('A', { ...cause, waiterId: 'A', resourceId: 'fork:A', ownerIds: [], nodePath: 'A' })).toBe(expected);
  expect(formatWaitCause('A', { waitingFor: 'fork' })).toBe('Vehicle: A\nOrder: none\nWaiting for: fork\nHeld by: unknown');
  expect(FLEET_WAIT_TIMEOUT_CODE).toBe('fleet-wait-timeout');
  expect(waitTimeoutProblemId('A', 'fork')).toBe('fleet-wait-timeout:A:fork');
});
