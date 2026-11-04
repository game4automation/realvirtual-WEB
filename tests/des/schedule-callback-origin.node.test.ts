// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { lineFixture } from './c2a-fixture';
import { DES_CALLBACK_ACTION } from '../../src/plugins/des/rv-des-manager';

it.each([undefined, { owner: 'business', kind: 'replan' }])('refuses the same callback origin on capture and restore: %j', origin => {
  const { runner, manager } = lineFixture();
  const ui = runner.scheduleCallback(20, () => {}, { origin: { owner: 'test.ui', kind: 'ui' } });
  runner.cancelCallback(ui);
  const saved = runner.fullSnapshot();
  manager.scheduleEvent(20, DES_CALLBACK_ACTION, -1, -1, 0, { r: 1, g: 1, k: 1, ...(origin ? { origin } : {}) });
  expect(() => runner.fullSnapshot()).toThrow('callback without restorable origin');
  const event = manager.exportQueue(() => '#Source@Source', data => data as never).find(e => e.action === DES_CALLBACK_ACTION)!;
  saved.eventQueue.push(event); saved.nextEventId = manager.nextEventId;
  expect(() => runner.restoreFull(saved)).toThrow('callback without restorable origin');
});
it('allows UI callbacks and omits them from persisted state', () => {
  const { runner } = lineFixture();
  runner.scheduleCallback(30, () => {}, { origin: { owner: 'ui', kind: 'ui' } });
  expect(runner.fullSnapshot().eventQueue.some(e => e.action === DES_CALLBACK_ACTION)).toBe(false);
});
