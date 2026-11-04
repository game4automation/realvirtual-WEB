// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-900 fixture — runs inside vitest.perfile.config.mjs: a LEGITIMATE slow file with regular
// file events, `RV_TL_SLOW_FILE_MS` long (default 1500). It is the discriminator D1/D2: run two
// of these with a per-file limit above a single file's duration but below their SUM, and a
// per-file clock stays green where a global cap of the same height would kill the run.
import { expect, it } from 'vitest';

const ms = Number(process.env.RV_TL_SLOW_FILE_MS) || 1500;

it('takes its time but stays under the per-file limit', { timeout: ms + 60_000 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  expect(1).toBe(1);
});
