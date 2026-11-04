// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-606 fixture — runs inside vitest.guard.config.mjs and records who holds the
// lock while the run is in progress (RV_TL_MARKER).
import fs from 'node:fs';
import { test, expect } from 'vitest';
import { lockConfig, probeLock } from '../../../scripts/test-lock.mjs';

test('records the lock holder during the run', async () => {
  const probe = await probeLock({ port: lockConfig().port });
  fs.writeFileSync(process.env.RV_TL_MARKER, JSON.stringify({
    probe,
    held: process.env.RV_TEST_LOCK_HELD ?? null,
  }));
  expect(probe.state).not.toBe('unknown');
});
