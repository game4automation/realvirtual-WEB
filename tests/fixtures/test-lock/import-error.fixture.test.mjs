// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-617 fixture — runs inside vitest.failing.config.mjs: the file throws while it is
// imported, so vitest reports `suite-failed-early` (onTestModuleStart + onTestModuleEnd) and no
// test at all. Expected: one `[test-fail] import-error.fixture.test.mjs :: (module) — IMPORT PROBE …`.
import { it } from 'vitest';

throw new Error('IMPORT PROBE: the module failed to load');

it('is never collected', () => {});
