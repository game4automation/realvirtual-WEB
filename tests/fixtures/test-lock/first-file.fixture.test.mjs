// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-900 fixture — runs inside vitest.perfile.config.mjs: a file that starts and ends
// normally, so the per-file limit has a HEALTHY neighbour next to the hanging one. Its name
// must never appear in the limit's message.
import { expect, it } from 'vitest';

it('passes at once', () => {
  expect(1).toBe(1);
});
