// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it, vi } from 'vitest';
import { AgvFlow } from '../../src/behaviors/Agv';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { serviceFixture } from './phase4-agv-fixture';
import { registerAction, ACTION_INDEX } from '../../src/plugins/des/rv-des-named-actions';

const SENTINEL = ACTION_INDEX.get('Plan2006.Phase4.ClockSentinel') ?? registerAction('Plan2006.Phase4.ClockSentinel', () => {});

it('9.14 removing a servicing vehicle cancels its service-end timer', () => {
  const f = serviceFixture();
  const ended = vi.fn();
  f.handle.assign({ destination: 'A', serviceSec: 10, onServiceEnd: ended });
  f.until(() => f.handle.phase === 'servicing');
  const local = f.self.local as unknown as { desServiceEvent: number };
  expect(local.desServiceEvent).toBeGreaterThanOrEqual(0);
  // The production lifecycle release hook; leave the runner/clock alive.
  AgvFlow.trafficRelease(f.self as never);
  expect(getDefaultAgvFleet().get('V')).toBeNull();
  const mgr = f.runner.getManager();
  const before = mgr.currentTime;
  // A model event past the service end keeps the DES clock moving even when the
  // (cancelled) service-end event is the only other pending event.
  mgr.scheduleEventByIndex(before + 15, SENTINEL, 0);
  f.advance(20);
  expect(f.runner.getManager().currentTime).toBeGreaterThan(before + 10);
  expect(ended, 'removed vehicle must never execute handleServiceEnd').not.toHaveBeenCalled();
});
