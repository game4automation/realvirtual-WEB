// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-900 fixture — the SECOND legitimate slow file (see slow-file.fixture.test.mjs). D1 needs
// two of them: each one alone stays under the per-file limit, together they run longer than it,
// and the run must still be green. Deliberately a file of its own and not a second test in the
// first one — the discriminator is "per FILE versus per PROCESS", so it takes two files.
import { expect, it } from 'vitest';

const ms = Number(process.env.RV_TL_SLOW_FILE_MS) || 1500;

it('takes its time but stays under the per-file limit', { timeout: ms + 60_000 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  expect(1).toBe(1);
});
