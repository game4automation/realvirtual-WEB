// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Test-lock startup-limit fixture — runs inside vitest.progress.config.mjs: one passing
// test, two skips with a note, one plain `it.skip`. Records whether the progress file
// variable reached the worker (RV_TL_MARKER).
import fs from 'node:fs';
import { expect, it } from 'vitest';

it('passes and records the worker environment', () => {
  if (process.env.RV_TL_MARKER) {
    fs.writeFileSync(process.env.RV_TL_MARKER, JSON.stringify({
      progressFile: process.env.RV_TEST_LOCK_PROGRESS_FILE ?? null,
    }));
  }
  expect(1).toBe(1);
});

it('skips with a note (1)', (ctx) => { ctx.skip('no adapter'); });
it('skips with a note (2)', (ctx) => { ctx.skip('no adapter'); });
it.skip('skipped without a note', () => {});
