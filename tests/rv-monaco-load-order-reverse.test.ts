// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-monaco-load-order-reverse.test.ts — plan-555 9.2, order JSON → TS (the
 * other order is rv-monaco-load-order.test.ts; one page per file).
 */

import { describe, it } from 'vitest';
import { assertWorkersCoexist } from './helpers/monaco-load-order';

describe('plan-555 9.2 — real Monaco workers, order JSON → TS', () => {
  it('TS transpiles AND an rv-json model gets a JSON syntax marker', async () => {
    await assertWorkersCoexist(['json', 'ts']);
  }, 90_000);
});
