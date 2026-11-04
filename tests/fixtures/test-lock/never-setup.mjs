// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-617 fixture — a globalSetup that never resolves (vitest.failing.config.mjs with
// RV_TL_NEVER_SETUP=1): the vitest process stays alive, reported `run-start` (onTestRunStart
// fires before globalSetup) and never reaches a test file — the "no module event received"
// case the wrapper's startup limit must still end with 125. Writes RV_TL_MARKER when entered,
// so the test can tell the setup really ran.
import fs from 'node:fs';

export default async function neverSetup() {
  if (process.env.RV_TL_MARKER) fs.writeFileSync(process.env.RV_TL_MARKER, JSON.stringify({ pid: process.pid, at: Date.now() }));
  setInterval(() => {}, 60_000); // a live handle: the process must not end on an empty event loop
  await new Promise(() => {});
}
