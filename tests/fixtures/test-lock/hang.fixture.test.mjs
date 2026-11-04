// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-617 fixture — runs inside vitest.failing.config.mjs next to failing.fixture.test.mjs: a
// test that never ends on its own. Its timeout (10 min) outlasts every harness timeout, so the
// run is still going when the abort test kills the wrapper tree.
import { it } from 'vitest';

it('hangs until the run is killed', { timeout: 600_000 }, () => new Promise(() => {}));
