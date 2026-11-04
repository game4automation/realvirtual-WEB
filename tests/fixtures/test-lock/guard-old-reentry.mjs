// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-606 fixture — NEGATIVE CONTROL for the guard's same-process re-entry. Reimplements
// ONLY the decision of tests/global-lock-guard.ts as it was before the fix: a
// RV_TEST_LOCK_HELD naming this very process falls through to acquire() and waits on
// its own lock. Never used as a real globalSetup.
import { acquire, holderInfo, isProcessAlive, lockConfig } from '../../../scripts/test-lock.mjs';

export default async function setup() {
  const config = lockConfig();
  if (config.disabled) return;

  const heldBy = Number(process.env.RV_TEST_LOCK_HELD);
  if (heldBy !== process.pid && isProcessAlive(heldBy)) return;

  const handle = await acquire({ info: holderInfo(['old-guard']), port: config.port });
  const previous = process.env.RV_TEST_LOCK_HELD;
  process.env.RV_TEST_LOCK_HELD = String(process.pid);
  return async () => {
    if (previous === undefined) delete process.env.RV_TEST_LOCK_HELD;
    else process.env.RV_TEST_LOCK_HELD = previous;
    await handle.release();
  };
}
