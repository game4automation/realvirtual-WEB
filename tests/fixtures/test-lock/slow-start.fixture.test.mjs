// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-617 fixture — runs inside vitest.failing.config.mjs: a legitimate run whose FIRST TEST
// event arrives late, the false 125 of 2026-10-17. `RV_TL_SLOW_MS` (default 8000) long:
// - `RV_TL_SLOW_START=sync` (default): the first test blocks its worker synchronously — the
//   runner's throttled `test-prepare` reaches the main process only after the test ended;
// - `RV_TL_SLOW_START=before-all`: an async beforeAll of that length before a quick test —
//   `test-prepare` is sent only after the beforeAll.
// Under the wrapper with a startup limit shorter than that, `module-start` must close the window.
import { beforeAll, expect, it } from 'vitest';

const mode = process.env.RV_TL_SLOW_START || 'sync';
const ms = Number(process.env.RV_TL_SLOW_MS) || 8000;

if (mode === 'before-all') {
  beforeAll(() => new Promise((resolve) => setTimeout(resolve, ms)), ms + 60_000);
}

it(mode === 'before-all' ? 'quick test after a long beforeAll' : 'long synchronous first test', { timeout: ms + 60_000 }, () => {
  if (mode !== 'before-all') {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* blocks the worker on purpose */ }
  }
  expect(1).toBe(1);
});
