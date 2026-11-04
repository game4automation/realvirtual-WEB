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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

// plan-626 F2: the tool-class allowlist CONNECT reads (McpToolClassAllowlist.cs in the Connect repo).
// plan-2211: the convention test registers the commercial experiment.* commands and lives in the
// private sibling since the experiment manager moved there. Without the sibling there is nothing
// to generate — say so instead of letting vitest report "No test files found".
const CLASS_TEST = '../realvirtual-WebViewer-Private~/tests/des-experiments/mcp-tool-class-convention.node.test.ts';
if (!existsSync(fileURLToPath(new URL(`../${CLASS_TEST}`, import.meta.url)))) {
  console.warn(`[gen:mcp-docs] MCP docs regenerated. The tool/command class allowlists were NOT regenerated: `
    + `${CLASS_TEST} is missing (no private sibling checkout). Run gen:mcp-docs in a workspace with realvirtual-WebViewer-Private~.`);
  process.exit(0);
}
const classes = spawnSync(
  npx,
  ['vitest', 'run', '--config', 'vitest.node.config.ts', CLASS_TEST],
  {
    stdio: 'inherit',
    env: { ...process.env, RV_UPDATE_MCP_CLASSES: '1' },
    shell: process.platform === 'win32',
  },
);

process.exit(classes.status ?? 1);
