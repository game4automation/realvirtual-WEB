// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * patch-vendor-handover-connect — the one-off that reaches existing customers
 * (plan-725 Phase 6).
 *
 * `migrate-project-manifest.mjs` writes the default `vendor` block only where
 * none exists, on purpose, so every already-migrated customer project would miss
 * the new connect-config handover globs. This script is the deliberate
 * counterpart; what has to hold for it is narrow and testable:
 *
 *  - it adds the missing pairs,
 *  - a second run is a no-op,
 *  - it touches `vendor.handover` and nothing else, and
 *  - a manifest without a `vendor` block is refused rather than invented.
 *
 * Fixtures are synthetic: the real customer manifests live in the customers' own
 * Forgejo repositories, which no test may reach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applicableGlobs,
  compactDiff,
  zoneOf,
  patchManifest,
  patchProjectDir,
  patchProjectsRoot,
} from '../scripts/patch-vendor-handover-connect.mjs';
import {
  CONNECT_CONFIG_HANDOVER_GLOBS,
  DEFAULT_VENDOR_BLOCK,
  vendorGlobProblems,
} from '../scripts/_rv-guards.mjs';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rv-patch-handover-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A migrated customer manifest as it looks BEFORE plan-725. */
function legacyManifest(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    id: 'p-1',
    name: 'Linie 1',
    kind: 'customer',
    createdAt: 'A',
    modifiedAt: 'B',
    documents: [{ id: 'd1', name: 'Linie 1', path: 'models/linie1.glb' }],
    vendor: {
      managed: ['models/**', 'library/**', 'docs/**', 'connect/**', 'plugins/**', 'rag/**'],
      handover: ['connect/secrets.local.json', 'models/custom/**'],
    },
    ...extra,
  };
}

/** Writes a project folder and returns its path. */
function project(name: string, manifest: unknown): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

function readManifest(dir: string): any {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
}

describe('patchManifest', () => {
  it('adds the missing zone pairs to an existing handover list', () => {
    const result = patchManifest(legacyManifest());
    expect(result.status).toBe('patched');
    expect(result.added).toEqual([...CONNECT_CONFIG_HANDOVER_GLOBS]);
    expect(result.manifest!.vendor.handover).toEqual([...DEFAULT_VENDOR_BLOCK.handover]);
    expect(vendorGlobProblems(result.manifest!.vendor)).toEqual([]);
  });

  it('is a no-op on a manifest that already has them', () => {
    const once = patchManifest(legacyManifest());
    const twice = patchManifest(once.manifest!);
    expect(twice.status).toBe('unchanged');
    expect(twice.added).toEqual([]);
  });

  it('leaves every other vendor field and every other manifest field untouched', () => {
    const before = legacyManifest({ code: 'legacy', settings: { a: 1 } });
    (before.vendor as Record<string, unknown>).note = 'sharpened by hand 2025-11';
    const result = patchManifest(before);
    expect(result.status).toBe('patched');
    const after = result.manifest!;
    // vendor.managed is a human judgement per project and is never rewritten.
    expect(after.vendor.managed).toEqual(before.vendor.managed);
    expect(after.vendor.note).toBe('sharpened by hand 2025-11');
    // Everything outside `vendor` is carried through by identity.
    for (const key of Object.keys(before)) {
      if (key === 'vendor') continue;
      expect(after[key], key).toEqual((before as Record<string, unknown>)[key]);
    }
    // And the input itself was not mutated — the function is pure.
    expect(before.vendor.handover).toEqual(['connect/secrets.local.json', 'models/custom/**']);
  });

  it('refuses a manifest without a vendor block', () => {
    const { vendor, ...withoutVendor } = legacyManifest();
    const result = patchManifest(withoutVendor);
    expect(result.status).toBe('refused');
    expect(result.reason).toMatch(/migrate-project-manifest/);
    expect(result.added).toEqual([]);
  });

  it('refuses a malformed vendor block instead of repairing it', () => {
    expect(patchManifest(legacyManifest({ vendor: 'yes' })).status).toBe('refused');
    expect(patchManifest(legacyManifest({ vendor: ['models/**'] })).status).toBe('refused');
    expect(patchManifest({ vendor: { managed: ['models/**'], handover: 'no' } }).status).toBe('refused');
    expect(patchManifest({ vendor: { managed: 'no' } }).status).toBe('refused');
    expect(patchManifest(null).status).toBe('refused');
  });

  it('creates the handover list when the vendor block has only managed', () => {
    const result = patchManifest({ vendor: { managed: ['models/**'] } });
    expect(result.status).toBe('patched');
    expect(result.manifest!.vendor.handover).toEqual(['models/*.connect.json', 'models/**/*.connect.json']);
  });

  it('only adds globs the project\'s own managed list actually claims', () => {
    // A project whose vendor block was narrowed by hand. Adding docs/ or rag/
    // entries here would leave vendorGlobProblems() reporting dead globs.
    const result = patchManifest(legacyManifest({
      vendor: { managed: ['models/**'], handover: ['models/custom/**'] },
    }));
    expect(result.status).toBe('patched');
    expect(result.added).toEqual(['models/*.connect.json', 'models/**/*.connect.json']);
    expect(result.skipped.length).toBe(CONNECT_CONFIG_HANDOVER_GLOBS.length - 2);
    expect(vendorGlobProblems(result.manifest!.vendor)).toEqual([]);
  });

  it('adds only what is missing when the list is half-patched', () => {
    const half = legacyManifest();
    half.vendor.handover.push('models/*.connect.json');
    const result = patchManifest(half);
    expect(result.status).toBe('patched');
    expect(result.added).not.toContain('models/*.connect.json');
    expect(result.added).toHaveLength(CONNECT_CONFIG_HANDOVER_GLOBS.length - 1);
    // No duplicate crept in.
    const handover: string[] = result.manifest!.vendor.handover;
    expect(new Set(handover).size).toBe(handover.length);
  });
});

describe('applicableGlobs', () => {
  it('returns nothing for a project that manages nothing', () => {
    expect(applicableGlobs([])).toEqual([]);
    expect(applicableGlobs(undefined)).toEqual([]);
  });

  it('returns all twelve for the default managed list', () => {
    expect(applicableGlobs([...DEFAULT_VENDOR_BLOCK.managed])).toEqual([...CONNECT_CONFIG_HANDOVER_GLOBS]);
  });

  it('covers a zone the default block never mentions', () => {
    // Real case: Toray's manifest manages `cad/**`. A fixed twelve-glob list
    // would leave a configuration under cad/ classified as ours — the exact
    // overwrite F8 exists to prevent.
    const globs = applicableGlobs([...DEFAULT_VENDOR_BLOCK.managed, 'cad/**']);
    expect(globs).toContain('cad/*.connect.json');
    expect(globs).toContain('cad/**/*.connect.json');
  });

  it('ignores a managed glob that names no folder', () => {
    // Real case: wmyb's manifest manages `*.glb` at the project root.
    expect(applicableGlobs(['*.glb'])).toEqual([]);
  });
});

describe('zoneOf', () => {
  it('takes the literal folder prefix', () => {
    expect(zoneOf('models/**')).toBe('models');
    expect(zoneOf('models/vendor/**')).toBe('models/vendor');
    expect(zoneOf('cad/**')).toBe('cad');
  });

  it('has no zone for a wildcard first segment or a plain file', () => {
    expect(zoneOf('*.glb')).toBeNull();
    expect(zoneOf('**/*.json')).toBeNull();
    // A glob with no wildcard at all names a FILE, so its last segment drops.
    expect(zoneOf('notes.md')).toBeNull();
    expect(zoneOf('connect/secrets.local.json')).toBe('connect');
    expect(zoneOf(42)).toBeNull();
  });

  it('does not let a single managed FILE buy its whole folder a handover glob', () => {
    // zoneOf says `connect`, and the validator gate then throws both candidates
    // out, because `managed` claims one file in that folder and not the folder.
    expect(applicableGlobs(['connect/secrets.local.json'])).toEqual([]);
  });
});

describe('patchProjectDir', () => {
  it('is a dry run by default and writes with --apply', () => {
    const dir = project('linie1', legacyManifest());
    const dry = patchProjectDir(dir);
    expect(dry.status).toBe('patched');
    expect(readManifest(dir).vendor.handover).toHaveLength(2);   // untouched on disk

    const wet = patchProjectDir(dir, { apply: true });
    expect(wet.status).toBe('patched');
    expect(readManifest(dir).vendor.handover).toEqual([...DEFAULT_VENDOR_BLOCK.handover]);
  });

  it('the second apply changes nothing', () => {
    const dir = project('linie1', legacyManifest());
    patchProjectDir(dir, { apply: true });
    const after = readFileSync(join(dir, 'project.json'), 'utf8');
    const second = patchProjectDir(dir, { apply: true });
    expect(second.status).toBe('unchanged');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(after);
  });

  it('produces a diff confined to the handover list', () => {
    const dir = project('linie1', legacyManifest());
    const result = patchProjectDir(dir);
    expect(result.reformats).toBe(false);

    // The whole textual change: twelve added lines plus the previously-last
    // entry, which now needs a trailing comma. Nothing else may move.
    const removed = result.diff.filter((l) => l.startsWith('- '));
    const added = result.diff.filter((l) => l.startsWith('+ '));
    expect(removed).toEqual(['-       "models/custom/**"']);
    expect(added).toHaveLength(CONNECT_CONFIG_HANDOVER_GLOBS.length + 1);
    for (const line of added) expect(line).toMatch(/\.connect\.json|models\/custom/);

    // And structurally: the two documents differ in vendor.handover alone.
    const before = JSON.parse(result.before!);
    const after = JSON.parse(result.after!);
    delete before.vendor.handover;
    delete after.vendor.handover;
    expect(after).toEqual(before);
  });

  it('keeps a manifest that has no trailing newline without one', () => {
    // Not hypothetical: every delivered customer manifest is written by the
    // browser save path and ends without one. Imposing a newline would put a
    // spurious one-byte change into each customer repository.
    const dir = join(root, 'no-eof');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.json'), JSON.stringify(legacyManifest(), null, 2));
    const result = patchProjectDir(dir, { apply: true });
    expect(result.status).toBe('patched');
    expect(result.reformats).toBe(false);
    const written = readFileSync(join(dir, 'project.json'), 'utf8');
    expect(written.endsWith('\n')).toBe(false);
    expect(JSON.parse(written).vendor.handover).toEqual([...DEFAULT_VENDOR_BLOCK.handover]);
  });

  it('flags a manifest whose formatting the write would normalise', () => {
    const dir = join(root, 'compact');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.json'), JSON.stringify(legacyManifest()));   // one line
    const result = patchProjectDir(dir);
    expect(result.status).toBe('patched');
    expect(result.reformats).toBe(true);
  });

  it('skips a folder without a manifest and one with broken JSON', () => {
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(patchProjectDir(empty).status).toBe('skipped');

    const broken = join(root, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'project.json'), '{ not json');
    expect(patchProjectDir(broken).status).toBe('skipped');
  });

  it('refuses a project without a vendor block and writes nothing', () => {
    const { vendor, ...withoutVendor } = legacyManifest();
    const dir = project('unmigrated', withoutVendor);
    const before = readFileSync(join(dir, 'project.json'), 'utf8');
    const result = patchProjectDir(dir, { apply: true });
    expect(result.status).toBe('refused');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(before);
  });
});

describe('patchProjectsRoot', () => {
  it('reports every project below a root, in order', () => {
    project('a-legacy', legacyManifest());
    const { vendor, ...withoutVendor } = legacyManifest();
    project('b-unmigrated', withoutVendor);
    const results = patchProjectsRoot(root);
    expect(results.map((r) => r.project)).toEqual(['a-legacy', 'b-unmigrated']);
    expect(results[0].status).toBe('patched');
    expect(results[1].status).toBe('refused');
  });
});

describe('compactDiff', () => {
  it('trims to the block that actually differs', () => {
    expect(compactDiff('a\nb\nc\n', 'a\nb\nx\nc\n')).toEqual(['+ x']);
    expect(compactDiff('a\n', 'a\n')).toEqual([]);
  });
});
