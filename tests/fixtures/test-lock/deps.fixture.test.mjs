// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Strict-deps fixture — runs inside vitest.deps.config.mjs: two passing tests; the config's
// fixture reporter simulates a mid-run dependency discovery at the test named `second`.
import { expect, it } from 'vitest';

it('first', () => { expect(1).toBe(1); });
it('second', () => { expect(2).toBe(2); });
