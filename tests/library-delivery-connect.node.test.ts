// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.15 (CONNECT half) — the CONNECT embed carries the project's library
 * projects; the `-Public` shell keeps the app-level `/library/`.
 *
 * Separate from library-delivery.node.test.ts because it reads the sibling
 * CONNECT repository (a community checkout has none — the private-dependent
 * list excludes this file there, not the trim tests).
 *
 *  - `tools/stage-project.mjs` parses `--projects-dir` / `--library` and hands
 *    the sources to BOTH shared stagers (it builds for real, so the forwarding is
 *    pinned on the source and the staging behaviour on the CONNECT test below);
 *  - CONNECT's own staging test (`tools/tests/stage-project-deny.test.mjs`) runs
 *    the shared hosted stager exactly as stage-project.mjs calls it and asserts
 *    `p/libraries/<id>/project.json` and the rewritten hint;
 *  - `tools/stage-public.mjs` strips demo content from the `-Public` shell, never `library/`.
 *
 * Runner: `npm run test:node`.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CONNECT = resolve(__dirname, '../../realvirtual-Connect~');
const TOOLS = join(CONNECT, 'tools');

describe('library delivery — CONNECT (plan-778 9.15)', () => {
  it('stage-project.mjs forwards --projects-dir/--library to BOTH shared stagers', () => {
    const source = readFileSync(join(TOOLS, 'stage-project.mjs'), 'utf8');
    expect(source).toMatch(/parseLibrarySourceArgs\(argv\)/);
    const staging = /stageFilteredSourceTree\(\{[\s\S]*?\}\);/.exec(source)?.[0] ?? '';
    const hosted = /stageHostedProject\(\{[\s\S]*?\n\}\);/.exec(source)?.[0] ?? '';
    expect(staging).toMatch(/librarySources/);
    expect(hosted).toMatch(/librarySources/);
  });

  it('the embed staging writes p/libraries/<id>/ (CONNECT\'s own staging test)', () => {
    const run = spawnSync(process.execPath, [join(TOOLS, 'tests', 'stage-project-deny.test.mjs')], { encoding: 'utf8', cwd: CONNECT });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('StageProjectLibrariesTests: passed');
  }, 60_000);

  it('the -Public shell keeps the app-level /library/ (stage-public.mjs strips demo content only)', () => {
    const stagePublic = readFileSync(join(TOOLS, 'stage-public.mjs'), 'utf8');
    const stripped = /for \(const directory of \[([^\]]*)\]/.exec(stagePublic)?.[1] ?? '';
    expect(stripped).toMatch(/'models'/);
    expect(stripped).not.toMatch(/library/);
  });
});
