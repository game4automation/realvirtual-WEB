// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { DESEventQueue } from '../../src/plugins/des/rv-des-event-queue';
import { CHECKPOINT_PRIORITY, DEFAULT_PRIORITY, PLANNING_PRIORITY } from '../../src/plugins/des/rv-des-event';

it.each([[2, 1, 0], [0, 2, 1], [1, 0, 2]])('orders mixed enqueue %s as model, change, checkpoint', (...order) => {
  const queue = new DESEventQueue();
  const priorities = [DEFAULT_PRIORITY, PLANNING_PRIORITY, CHECKPOINT_PRIORITY];
  for (const action of order) queue.enqueue(5, action, -1, -1, priorities[action]);
  expect([queue.dequeue()!.actionIndex, queue.dequeue()!.actionIndex, queue.dequeue()!.actionIndex]).toEqual([0, 1, 2]);
});
