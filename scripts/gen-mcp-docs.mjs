// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * gen-mcp-docs — regenerate the marked MCP tool-reference blocks (plan-707 F13).
 *
 * The renderer lives in the browser bundle (the tool classes pull Three.js and
 * the viewer), so the only honest way to run it is the browser test suite. This
 * script is therefore a thin wrapper: it runs the drift test with
 * `RV_UPDATE_MCP_DOCS=1`, which flips that test from "compare and fail" to
 * "compare, write the difference back, then pass".
 *
 * `cross-env` is not a dependency of this repo, and one is not worth adding for
 * a single variable — this file is the portable equivalent.
 *
 * The write itself happens Node-side through the `writeMcpDocBlock` command
 * registered in `vite.config.ts`, which only ever touches the six registered
 * files and only between a matching marker pair.
 */

import { spawnSync } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(
  npx,
  ['vitest', 'run', 'tests/rv-mcp-docs-drift.test.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, RV_UPDATE_MCP_DOCS: '1' },
    // Windows resolves npx.cmd only through the shell.
    shell: process.platform === 'win32',
  },
);

process.exit(result.status ?? 1);
