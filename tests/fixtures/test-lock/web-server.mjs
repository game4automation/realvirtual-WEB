// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-606 fixture — Playwright webServer stand-in; appends its start to RV_TL_WS_MARKER.
import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.env.RV_TL_WS_PORT);
fs.appendFileSync(process.env.RV_TL_WS_MARKER, `${JSON.stringify({
  at: Date.now(),
  pid: process.pid,
  run: process.env.RV_TL_RUN ?? null,
  held: process.env.RV_TEST_LOCK_HELD ?? null,
})}\n`);
http.createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1');
