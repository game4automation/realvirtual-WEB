// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-606 test fixture — a wrapper child that spawns grandchildren WITHOUT the
 * watchdog environment, to show what ends when the wrapper is hard-killed:
 *   - a NON-Node grandchild (`ping` on Windows, `sleep` elsewhere), attached
 *   - an attached Node grandchild
 *   - a `detached: true` Node grandchild (documented limit: may survive)
 * Writes `{ child, nonNode, nodeAttached, nodeDetached }` pids to <dir>/tree.json
 * and then idles until killed (at most 120 s).
 *
 *   node child-tree.mjs <dir>
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.RV_TEST_LOCK_PARENT_PID;
delete env.RV_TEST_LOCK_HELD;

const idle = ['-e', 'setTimeout(() => {}, 120000)'];
const nonNode = process.platform === 'win32'
  ? spawn('ping', ['-n', '120', '127.0.0.1'], { env, stdio: 'ignore', windowsHide: true })
  : spawn('sleep', ['120'], { env, stdio: 'ignore' });
const nodeAttached = spawn(process.execPath, idle, { env, stdio: 'ignore', windowsHide: true });
const nodeDetached = spawn(process.execPath, idle, { env, stdio: 'ignore', detached: true, windowsHide: true });
nodeDetached.unref();

fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify({
  child: process.pid,
  nonNode: nonNode.pid,
  nodeAttached: nodeAttached.pid,
  nodeDetached: nodeDetached.pid,
}));
setTimeout(() => process.exit(0), 120000);
