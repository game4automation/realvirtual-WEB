// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-606 fixture — a Playwright test without a browser that holds the run open until
// the barrier file RV_TL_RELEASE exists.
import fs from 'node:fs';
import { test } from 'playwright/test';

test('holds until released', async () => {
  fs.writeFileSync(`${process.env.RV_TL_RELEASE}.${process.env.RV_TL_RUN}.running`, String(process.pid));
  while (!fs.existsSync(process.env.RV_TL_RELEASE)) await new Promise((r) => setTimeout(r, 25));
});
