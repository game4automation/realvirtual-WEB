// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-monaco-load-order.test.ts — plan-555 9.2: REAL TypeScript and JSON
 * workers coexist through the shared worker registry, order TS → JSON.
 * The reverse order (JSON → TS) is rv-monaco-load-order-reverse.test.ts —
 * a separate file, because a browser test file is one page and Monaco plus
 * the registry are page-global once loaded.
 */

import { describe, it } from 'vitest';
import { assertWorkersCoexist } from './helpers/monaco-load-order';

describe('plan-555 9.2 — real Monaco workers, order TS → JSON', () => {
  it('TS transpiles AND an rv-json model gets a JSON syntax marker', async () => {
    await assertWorkersCoexist(['ts', 'json']);
  }, 90_000);
});
