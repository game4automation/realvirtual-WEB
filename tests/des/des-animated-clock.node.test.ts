// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import { registerAction } from '@rv/plugins/des/rv-des-named-actions';

it('9.4 advances the animated clock to the requested target after events at 0.3', () => {
  const manager = new DESManager();
  const times: number[] = [];
  const action = registerAction('Plan2006.Animated.Clock', ctx => { times.push(ctx.simTime); });
  manager.scheduleEventByIndex(0.3, action, -1);
  manager.scheduleEventByIndex(0.3, action, -1);
  expect(manager.processAnimated(1.0)).toBe(2);
  expect(times).toEqual([0.3, 0.3]);
  expect(manager.currentTime).toBe(1.0);
});
