// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// The tier diff gate of plan-434 §2.4.
//
// With `defaults: "commercial"` a brand-new file under the private src/ tree ships to
// every customer the moment it is written. That is intended for a product feature and
// catastrophic for an internal spike, so the last delivery's inventory is diffed
// against this one and NEW paths must be confirmed by name. The five cases below are
// the full semantics; everything is local (temp dirs + a local git repo, no network).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPrivateSourceInventory,
  collectPrivateSourceInventory,
  diffPrivateSourceInventory,
  inventoryDigest,
  parseBaselineSourceInventory,
  readBaselineSourceInventory,
} from '../scripts/_workspace-lib.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

/** A staged workspace carrying exactly the given private source files. */
function stagedWorkspace(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-tier-diff-'));
  temporary.push(root);
  for (const rel of files) {
    const absolute = join(root, 'realvirtual-web-pro', 'src', ...rel.split('/'));
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, `export const x = '${rel}';\n`);
  }
  return root;
}

/** A baseline delivery manifest whose inventory names the given files. */
function baselineManifest(files: string[]): string {
  const paths = files.map((rel) => `realvirtual-web-pro/src/${rel}`).sort();
  return JSON.stringify({
    viewerVersion: '1.2.3',
    privateSources: { count: paths.length, sha256: inventoryDigest(paths), paths },
  });
}

describe('private source inventory', () => {
  it('collects every staged file, sorted, with a digest over the path list', () => {
    const root = stagedWorkspace(['b.ts', 'a.ts', 'plugins/deep/c.ts']);
    const inventory = collectPrivateSourceInventory(root);
    expect(inventory.paths).toEqual([
      'realvirtual-web-pro/src/a.ts',
      'realvirtual-web-pro/src/b.ts',
      'realvirtual-web-pro/src/plugins/deep/c.ts',
    ]);
    expect(inventory.count).toBe(3);
    expect(inventory.sha256).toBe(inventoryDigest(inventory.paths));
    // The digest covers the inventory, not the file contents: editing a file leaves it alone.
    writeFileSync(join(root, 'realvirtual-web-pro', 'src', 'a.ts'), 'export const x = 2;\n');
    expect(collectPrivateSourceInventory(root).sha256).toBe(inventory.sha256);
  });

  it('reports an empty inventory for a core-tier workspace without a private tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-tier-diff-empty-'));
    temporary.push(root);
    expect(collectPrivateSourceInventory(root)).toEqual({ count: 0, sha256: inventoryDigest([]), paths: [] });
  });
});

describe('tier diff gate', () => {
  it('does not gate a first delivery (no baseline tag)', () => {
    const current = collectPrivateSourceInventory(stagedWorkspace(['a.ts', 'b.ts']));
    const diff = assertPrivateSourceInventory(null, current, { acceptNew: false });
    expect(diff.gated).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('fails closed on a baseline that predates the inventory', () => {
    const current = collectPrivateSourceInventory(stagedWorkspace(['a.ts']));
    const baseline = parseBaselineSourceInventory(JSON.stringify({ viewerVersion: '1.0.0' }));
    expect(baseline?.trusted).toBe(false);
    expect(baseline?.reason).toMatch(/no privateSources inventory/);
    // Everything reads as new, so the delivery stops and asks instead of guessing.
    expect(() => assertPrivateSourceInventory(baseline, current)).toThrow(/realvirtual-web-pro\/src\/a\.ts/);
    expect(() => assertPrivateSourceInventory(baseline, current)).toThrow(/treated as new/);
    expect(assertPrivateSourceInventory(baseline, current, { acceptNew: true }).added).toHaveLength(1);
  });

  it('fails closed on a damaged inventory whose digest does not match its paths', () => {
    const current = collectPrivateSourceInventory(stagedWorkspace(['a.ts']));
    const tampered = parseBaselineSourceInventory(JSON.stringify({
      privateSources: {
        count: 1,
        sha256: inventoryDigest(['realvirtual-web-pro/src/a.ts']),
        // Somebody edited the list without recomputing the digest.
        paths: ['realvirtual-web-pro/src/a.ts', 'realvirtual-web-pro/src/smuggled.ts'],
      },
    }));
    expect(tampered?.trusted).toBe(false);
    expect(tampered?.reason).toMatch(/does not match its own sha256/);
    expect(() => assertPrivateSourceInventory(tampered, current)).toThrow();
    // Unparsable JSON is the same class of damage, never a first delivery.
    expect(parseBaselineSourceInventory('{ not json')?.trusted).toBe(false);
  });

  it('aborts on a new file and names it, unless the flag is passed', () => {
    const current = collectPrivateSourceInventory(stagedWorkspace(['a.ts', 'spike.ts']));
    const baseline = parseBaselineSourceInventory(baselineManifest(['a.ts']));
    expect(baseline?.trusted).toBe(true);
    expect(() => assertPrivateSourceInventory(current && baseline, current))
      .toThrow(/realvirtual-web-pro\/src\/spike\.ts/);
    // An accepted run still returns the diff so the caller can log what it let through.
    const accepted = assertPrivateSourceInventory(baseline, current, { acceptNew: true });
    expect(accepted.added).toEqual(['realvirtual-web-pro/src/spike.ts']);
    expect(accepted.removed).toEqual([]);
  });

  it('never gates a removal, and reports it', () => {
    const current = collectPrivateSourceInventory(stagedWorkspace(['a.ts']));
    const baseline = parseBaselineSourceInventory(baselineManifest(['a.ts', 'retired.ts']));
    const diff = assertPrivateSourceInventory(baseline, current);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(['realvirtual-web-pro/src/retired.ts']);
  });

  it('treats a rename as an add plus a delete and gates only the add', () => {
    const current = collectPrivateSourceInventory(stagedWorkspace(['renamed.ts']));
    const baseline = parseBaselineSourceInventory(baselineManifest(['original.ts']));
    const diff = diffPrivateSourceInventory(baseline, current);
    expect(diff.added).toEqual(['realvirtual-web-pro/src/renamed.ts']);
    expect(diff.removed).toEqual(['realvirtual-web-pro/src/original.ts']);
    expect(() => assertPrivateSourceInventory(baseline, current)).toThrow(/renamed\.ts/);
    expect(() => assertPrivateSourceInventory(baseline, current)).not.toThrow(/original\.ts/);
  });

  it('does not gate a content change at a known path', () => {
    const root = stagedWorkspace(['a.ts']);
    const baseline = parseBaselineSourceInventory(baselineManifest(['a.ts']));
    writeFileSync(join(root, 'realvirtual-web-pro', 'src', 'a.ts'), 'export const x = 99;\n');
    const diff = assertPrivateSourceInventory(baseline, collectPrivateSourceInventory(root));
    expect(diff).toMatchObject({ gated: true, added: [], removed: [] });
  });
});

describe('baseline inventory read from the customer clone', () => {
  function repoWithTag(manifestJson: string | null, tag: string): string {
    const root = mkdtempSync(join(tmpdir(), 'rv-tier-diff-git-'));
    temporary.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    if (manifestJson !== null) writeFileSync(join(root, 'delivery-manifest.json'), manifestJson);
    else writeFileSync(join(root, 'README.md'), 'no manifest here\n');
    git('add', '-A');
    git('commit', '-m', 'baseline');
    git('tag', tag);
    return root;
  }

  it('returns null without a baseline tag, so a first delivery is never gated', () => {
    const clone = repoWithTag(baselineManifest(['a.ts']), 'delivery/1.2.3');
    expect(readBaselineSourceInventory(clone, null)).toBeNull();
  });

  it('reads the inventory of the tagged manifest', () => {
    const clone = repoWithTag(baselineManifest(['a.ts', 'b.ts']), 'delivery/1.2.3');
    const baseline = readBaselineSourceInventory(clone, 'delivery/1.2.3');
    expect(baseline?.trusted).toBe(true);
    expect(baseline?.paths).toEqual(['realvirtual-web-pro/src/a.ts', 'realvirtual-web-pro/src/b.ts']);
  });

  it('fails closed when the tag exists but carries no manifest', () => {
    const clone = repoWithTag(null, 'delivery/1.2.3');
    const baseline = readBaselineSourceInventory(clone, 'delivery/1.2.3');
    expect(baseline?.trusted).toBe(false);
    const current = collectPrivateSourceInventory(stagedWorkspace(['a.ts']));
    expect(() => assertPrivateSourceInventory(baseline, current)).toThrow();
  });
});
