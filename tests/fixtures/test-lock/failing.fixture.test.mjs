// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-617 fixture — runs inside vitest.failing.config.mjs: one assertion failure (PROBE), a
// retried test that passes on its second attempt (no `[test-fail]` line), a retried test that
// fails every attempt (exactly one line) and one passing test.
import { expect, it } from 'vitest';

let flakyAttempts = 0;

it('fails with PROBE', () => {
  expect(1, 'PROBE value').toBe(2);
});

it('passes on the second attempt', { retry: 2 }, () => {
  flakyAttempts++;
  if (flakyAttempts < 2) throw new Error('FLAKY first attempt');
});

it('fails on every attempt', { retry: 2 }, () => {
  throw new Error('EXHAUSTED attempt');
});

it('passes', () => {
  expect(1).toBe(1);
});
