// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for `curateCoreMarkdownLinks` (plan-739 Phase 1, section 9.1).
 *
 * ## Why this file exists separately from customer-workspace.node.test.ts
 *
 * The real-doc staging test lives in `tests/customer-workspace.node.test.ts`, which is listed in
 * `tests/private-dependent-tests.json` and is therefore SKIPPED WHOLESALE on a machine without a
 * private sibling checkout. If the proof that a sibling-checkout link degrades lived only there,
 * the suite would be green on such a machine while never having exercised the blocker at all.
 *
 * So: this file must stay free of every private dependency. Note in particular that
 * `scripts/gen-private-test-excludes.mjs` classifies a test as private-dependent when the literal
 * sibling-repo name appears ANYWHERE in its source — hence the string concatenation below. It is
 * not decoration; spelling the folder name out in one piece would move this file into the
 * private-dependent list and defeat the entire point of splitting it out.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { curateCoreMarkdownLinks } from '../scripts/_workspace-lib.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

// See the file header: assembled at runtime so the sibling-repo name never appears as a literal.
const CONNECT_SIBLING_LINK = `../realvirtual-${'Connect'}~/doc-connect.md`;

/**
 * Reproduces the geometry the delivery actually runs with: `workspaceRoot` is the destination
 * root and the core documents sit one level below it, in `realvirtual-web/`. That single level is
 * what makes `isWithin()` blind to a one-hop sibling link (plan-739 section 2.4).
 */
function curate(relativeDocPath: string, markdown: string): string {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'rv-doc-curation-'));
  temporary.push(workspaceRoot);
  const coreOutput = join(workspaceRoot, 'realvirtual-web');
  const absolute = join(coreOutput, relativeDocPath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, markdown);
  curateCoreMarkdownLinks(workspaceRoot, coreOutput);
  return readFileSync(absolute, 'utf8');
}

describe('curateCoreMarkdownLinks', () => {
  it('degrades a link into a sibling checkout to plain text', () => {
    // The exact shape that took every delivery channel down on 2026-09-04: a `../<name>~/` link
    // resolves back INSIDE the destination root, so `isWithin()` reports it as fine and the link
    // survived curation, only for assertNoBrokenDocLinks to throw on the real existsSync check.
    const curated = curate('doc-unity-to-web.md', `# Doc\n\nSee [x](${CONNECT_SIBLING_LINK}).\n`);
    expect(curated).toBe('# Doc\n\nSee x.\n');
    expect(curated).not.toContain('](');
    expect(curated).not.toContain('~/');
  });

  it('still degrades a link into the Unity Packages tree', () => {
    // Placed two levels down so `../../Packages/...` resolves INSIDE the workspace root. That
    // rules out the isWithin() branch and pins the degradation on the `/Packages/` predicate
    // itself — the one doc-layout-planner.md and doc-node-paths.md depend on.
    const target = '../../Packages/io.realvirtual.professional/Runtime/WebViewerHMI/WebPivot.cs';
    const curated = curate(join('docs', 'nested', 'doc-node-paths.md'), `See [y](${target}).\n`);
    expect(curated).toBe('See y.\n');
  });

  it('leaves an absolute URL untouched', () => {
    // normalizeMarkdownTarget returns null for any target carrying a scheme, so an absolute URL is
    // structurally exempt from both curation and the broken-link assertion. This is why the
    // CONNECT reference in doc-unity-to-web.md is now written as a realvirtual.io URL.
    const markdown = 'See [z](https://realvirtual.io/doc/web/connect/).\n';
    expect(curate('doc-unity-to-web.md', markdown)).toBe(markdown);
  });
});
