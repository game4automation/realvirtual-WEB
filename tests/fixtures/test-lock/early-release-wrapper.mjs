// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-606 NEGATIVE-CONTROL fixture — a deliberately BROKEN wrapper that releases the
 * lock right after spawning its child instead of after the child's exit. The test
 * suite runs the same lifetime check against it and asserts the check FAILS, which
 * proves the check can detect an early release. Never used outside the tests.
 *
 *   node early-release-wrapper.mjs <script.mjs> [args…]
 */

import { spawn } from 'node:child_process';
import { acquire, holderInfo } from '../../../scripts/test-lock.mjs';

const [script, ...args] = process.argv.slice(2);
const lock = await acquire({ info: holderInfo(['early-release-wrapper', script, ...args]) });
const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
await lock.release(); // BROKEN on purpose: the child is still running
child.once('exit', (code) => process.exit(code ?? 1));
