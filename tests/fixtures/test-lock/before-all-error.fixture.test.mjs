// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-617 fixture — runs inside vitest.failing.config.mjs: suite-level errors.
// - `setup fails`: its beforeAll throws, vitest skips both tests and records the error on the
//   SUITE → exactly one `[test-fail] … :: (suite setup fails) — BEFOREALL PROBE …`;
// - `test and afterAll fail`: a test fails AND the suite's afterAll throws → two causes, each
//   exactly once: `… :: test and afterAll fail > fails itself — TEST PROBE …` and
//   `… :: (suite test and afterAll fail) — AFTERALL PROBE …`.
// The module has no error of its own → no `(module)` line for this file.
import { afterAll, beforeAll, describe, it } from 'vitest';

describe('setup fails', () => {
  beforeAll(() => {
    throw new Error('BEFOREALL PROBE');
  });
  it('is skipped (1)', () => {});
  it('is skipped (2)', () => {});
});

describe('test and afterAll fail', () => {
  afterAll(() => {
    throw new Error('AFTERALL PROBE');
  });
  it('fails itself', () => {
    throw new Error('TEST PROBE');
  });
});
