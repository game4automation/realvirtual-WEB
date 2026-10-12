// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `walkRelativeFiles` — the ONE directory walk of the Node tooling
 * (`scripts/lib/rv-fs.mjs`, plan-587 F5).
 *
 * The point of these tests is NOT that the two callers now filter the same way.
 * They deliberately do not, and that is licence relevant: the WEB notices
 * plugin walks the shipped `publicDir` with NO skip and NO depth cap, because
 * every file in there is delivered and a `node_modules` skip could drop a
 * shipped component out of THIRD-PARTY-NOTICES.txt. The CONNECT generator caps
 * at depth 8 and skips `bin*`/`obj`/`node_modules`/`.git`, but only at the root
 * of the project directory.
 *
 * So the tests pin down (a) the traversal mechanism, and (b) that each of the
 * two caller CONFIGURATIONS still produces what its hand-written predecessor
 * produced — in particular that the WEB configuration does NOT skip
 * `node_modules`. The legacy walkers are reproduced here verbatim as oracles.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// `rv-fs.mjs` has no sibling declaration file ON PURPOSE: one would shadow the .mjs for every
// importer, and tests/vite-asset-404-guard.node.test.ts already imports it this way.
// @ts-expect-error — plain JS Node module, no type declarations by design (scripts/lib).
import { walkRelativeFiles } from '../scripts/lib/rv-fs.mjs';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rv-fs-walk-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(rel: string, text = 'x') {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// ── The two legacy walkers, verbatim, as oracles ──────────────────────────

//! `walkFiles` of `scripts/vite-plugin-third-party-notices.mjs:118` before plan-587.
function legacyWebWalk(base: string, rel = '', out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(join(base, rel), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) legacyWebWalk(base, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

//! `walkRel` of `../realvirtual-Connect~/tools/gen-third-party-notices.mjs:226` before plan-587.
function legacyConnectWalk(base: string, rel = '', out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries;
  try { entries = readdirSync(join(base, rel), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (/^(bin.*|obj|node_modules|\.git)$/i.test(entry.name) && depth === 0) continue;
      legacyConnectWalk(base, child, out, depth + 1);
    } else if (entry.isFile()) out.push(child);
  }
  return out;
}

// ── The two caller configurations, as the call sites now spell them ───────

const webConfig = () => walkRelativeFiles(root);
const connectConfig = () => walkRelativeFiles(root, {
  maxDepth: 8,
  skipDirs: (name: string, depth: number) => depth === 0 && /^(bin.*|obj|node_modules|\.git)$/i.test(name),
});

//! A tree that exercises everything the two configurations disagree about: build dirs at the
//! root AND nested, a `node_modules` at both levels, and 12 levels of nesting.
function buildFixture() {
  write('top.txt');
  write('node_modules/shipped-lib/dist/lib.js');
  write('node_modules/shipped-lib/LICENSE');
  write('bin/Release/Connect.dll');
  write('obj/project.assets.json');
  write('.git/HEAD');
  write('src/nested/node_modules/also-shipped/index.js');
  write('src/nested/bin/kept.txt');
  write('src/Connect/tools/third-party/manual-components.json');
  write(`deep/${Array.from({ length: 11 }, (_, i) => `l${i + 1}`).join('/')}/buried.txt`);
}

describe('walkRelativeFiles — the traversal mechanism (plan-587 F5)', () => {
  it('Test_WalkRelativeFiles_NoOptions_ListsEveryFileRelative', () => {
    write('a.txt');
    write('sub/b.txt');
    write('sub/deeper/c.txt');
    expect(walkRelativeFiles(root).sort()).toEqual(['a.txt', 'sub/b.txt', 'sub/deeper/c.txt']);
  });

  it('Test_WalkRelativeFiles_UsesForwardSlashesOnEveryPlatform', () => {
    write('sub/deeper/c.txt');
    expect(walkRelativeFiles(root)).toEqual(['sub/deeper/c.txt']);
  });

  it('Test_WalkRelativeFiles_MissingRoot_ReturnsEmpty', () => {
    expect(walkRelativeFiles(join(root, 'does-not-exist'))).toEqual([]);
  });

  it('Test_WalkRelativeFiles_MaxDepthZero_ListsTheRootOnly', () => {
    write('a.txt');
    write('sub/b.txt');
    expect(walkRelativeFiles(root, { maxDepth: 0 })).toEqual(['a.txt']);
  });

  it('Test_WalkRelativeFiles_SkipDirs_AcceptsRegExpAndArray', () => {
    write('keep.txt');
    write('node_modules/x.js');
    write('sub/node_modules/y.js');
    // A RegExp or an array applies at EVERY depth — the form the CONNECT caller does NOT use.
    expect(walkRelativeFiles(root, { skipDirs: /^node_modules$/ }).sort()).toEqual(['keep.txt']);
    expect(walkRelativeFiles(root, { skipDirs: ['node_modules'] }).sort()).toEqual(['keep.txt']);
  });

  it('Test_WalkRelativeFiles_SkipDirsPredicate_SeesTheDepthOfTheContainingDirectory', () => {
    write('node_modules/root-level.js');
    write('sub/node_modules/nested.js');
    const seen: Array<[string, number]> = [];
    walkRelativeFiles(root, { skipDirs: (name: string, depth: number) => { seen.push([name, depth]); return false; } });
    expect(seen).toContainEqual(['node_modules', 0]);
    expect(seen).toContainEqual(['node_modules', 1]);
    expect(seen).toContainEqual(['sub', 0]);
  });
});

describe('walkRelativeFiles — both caller configurations keep their behaviour', () => {
  beforeEach(buildFixture);

  it('Test_WalkRelativeFiles_WebConfiguration_MatchesTheLegacyWebWalker', () => {
    expect(webConfig().sort()).toEqual(legacyWebWalk(root).sort());
  });

  it('Test_WalkRelativeFiles_ConnectConfiguration_MatchesTheLegacyConnectWalker', () => {
    expect(connectConfig().sort()).toEqual(legacyConnectWalk(root).sort());
  });

  it('Test_WalkRelativeFiles_WebConfiguration_DoesNotSkipNodeModules', () => {
    // THE licence-relevant assertion of F5. `publicDir` is the shipped tree; a file under a
    // `node_modules` in there is DELIVERED, and the manual component list is matched against
    // exactly this set. Introducing a skip here would remove a shipped component from
    // THIRD-PARTY-NOTICES.txt without a single test going red — unless it is this one.
    const files = webConfig();
    expect(files).toContain('node_modules/shipped-lib/dist/lib.js');
    expect(files).toContain('node_modules/shipped-lib/LICENSE');
    expect(files).toContain('src/nested/node_modules/also-shipped/index.js');
  });

  it('Test_WalkRelativeFiles_WebConfiguration_HasNoDepthCap', () => {
    expect(webConfig()).toContain('deep/l1/l2/l3/l4/l5/l6/l7/l8/l9/l10/l11/buried.txt');
  });

  it('Test_WalkRelativeFiles_ConnectConfiguration_SkipsBuildDirsAtTheRootOnly', () => {
    const files = connectConfig();
    // Skipped at the root …
    expect(files).not.toContain('node_modules/shipped-lib/dist/lib.js');
    expect(files).not.toContain('bin/Release/Connect.dll');
    expect(files).not.toContain('obj/project.assets.json');
    expect(files).not.toContain('.git/HEAD');
    // … and deliberately NOT deeper down, which is what `depth === 0` in the predicate says.
    expect(files).toContain('src/nested/node_modules/also-shipped/index.js');
    expect(files).toContain('src/nested/bin/kept.txt');
    expect(files).toContain('src/Connect/tools/third-party/manual-components.json');
  });

  it('Test_WalkRelativeFiles_ConnectConfiguration_CapsAtDepthEight', () => {
    // `deep/l1…/buried.txt` sits in a directory at level 12, past the cap of 8.
    expect(connectConfig()).not.toContain('deep/l1/l2/l3/l4/l5/l6/l7/l8/l9/l10/l11/buried.txt');
    // The boundary itself: a file in the deepest directory that is still listed.
    write('edge/l1/l2/l3/l4/l5/l6/l7/at-eight.txt');
    write('edge/l1/l2/l3/l4/l5/l6/l7/l8/past-eight.txt');
    const files = connectConfig();
    expect(files).toContain('edge/l1/l2/l3/l4/l5/l6/l7/at-eight.txt');
    expect(files).not.toContain('edge/l1/l2/l3/l4/l5/l6/l7/l8/past-eight.txt');
    expect(files.sort()).toEqual(legacyConnectWalk(root).sort());
  });
});
