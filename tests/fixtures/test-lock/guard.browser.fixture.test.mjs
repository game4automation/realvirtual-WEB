// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-606 fixture — the one trivial browser test of vitest.guard.browser.config.mjs.
import { test, expect } from 'vitest';

test('runs in the browser', () => {
  expect(typeof window).toBe('object');
});
