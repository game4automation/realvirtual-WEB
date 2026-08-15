// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-manifest-hardcut.node.test.ts — plan-703 phase 9 (§9.11, decision 20).
 *
 * The Node half of the manifest hardcut. Phase 6 made `documents[]` the
 * manifest's one list in the *browser*; the Node scripts kept deriving
 * additively, which after the mirror was gone meant writing back the second,
 * staler answer the hardcut existed to delete. This file pins the three
 * properties that inversion turns on:
 *
 * 1. WRITE side — `documents[]` is the SOURCE. An entry already in the list is
 *    never rewritten from a legacy array, and a half-migrated list is completed
 *    rather than returned early. Both matter only because the arrays are
 *    dropped afterwards: before phase 9 an early return cost nothing, now it
 *    would delete data.
 * 2. READ side — `withDerivedDocuments()` projects an unmigrated manifest into
 *    one document list without touching the file. This is what let the publish
 *    path delete its private `scenes[]` fallback.
 * 3. Read ACCEPTANCE is deliberately not cut. `validate-project.mjs` must keep
 *    passing both shapes: a customer repository nobody has opened in a current
 *    client is an unmigrated project, not an invalid one, and the gate must not
 *    fail a delivery over that. Checked against the real validator, not a
 *    reimplementation of it.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  deriveDocuments,
  documentsOf,
  withDerivedDocuments,
  withoutLegacyArrays,
  stableDocumentId,
  LEGACY_DOCUMENT_KEYS,
} from '../scripts/_rv-manifest.mjs';
import { validateProject } from '../scripts/validate-project.mjs';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rv-hardcut-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A manifest carrying only the three pre-phase-6 arrays. */
const LEGACY_ONLY = {
  schemaVersion: 1, id: 'prj_x', name: 'P', canonicalName: 'p',
  scenes: [{ id: 'scn_a', name: 'Cell A', path: 'scenes/a.scene.glb' }],
  models: [{ path: 'models/machine.glb', label: 'Machine' }],
  library: [{ path: 'library/gripper.glb' }],
};

/** Writes a project folder with the given manifest and files, returns its path. */
function project(name: string, manifest: unknown, files: string[] = []): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const rel of files) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'glTF');
  }
  return dir;
}

// ─── 1. The write side: documents[] is the source ────────────────────────

describe('deriveDocuments — documents[] is the source, not the mirror', () => {
  it('lifts a pure legacy manifest to the same documents as before the hardcut', () => {
    // The unchanged half. Nothing about a manifest with no `documents[]` moved:
    // all three arrays are lifted, in section order, with the same ids.
    const derived = deriveDocuments(LEGACY_ONLY, { now: '2026-08-10T00:00:00.000Z' });
    expect(derived).not.toBeNull();
    expect(derived!.existing).toBe(0);
    expect(derived!.documents.map(d => [d.section, d.path, d.id])).toEqual([
      ['scenes', 'scenes/a.scene.glb', 'scn_a'],
      ['models', 'models/machine.glb', stableDocumentId('models/machine.glb')],
      ['library', 'library/gripper.glb', stableDocumentId('library/gripper.glb')],
    ]);
    expect(derived!.marker).toEqual({
      at: '2026-08-10T00:00:00.000Z', schemaVersion: 2,
      counts: { scenes: 1, models: 1, library: 1 },
    });
  });

  it('carries an existing entry through byte-for-byte, never from the array', () => {
    // THE case the inversion exists for. The array holds the stale answer — an
    // old name, no classification — and the list holds the current one. Reading
    // the array for a path the list already speaks for is exactly the overwrite
    // the hardcut makes impossible.
    const current = {
      id: 'scn_a', name: 'Renamed By The User', path: 'scenes/a.scene.glb',
      section: 'scenes', baseKind: 'published',
      classification: { v: 1, level: 'scene' },
      somethingANewerClientWrote: 42,
    };
    const derived = deriveDocuments({
      ...LEGACY_ONLY,
      documents: [current],
      scenes: [{ id: 'scn_a', name: 'Stale Mirror Name', path: 'scenes/a.scene.glb' }],
    });
    expect(derived).not.toBeNull();
    expect(derived!.existing).toBe(1);
    expect(derived!.documents[0]).toEqual(current);
    // …and the same path is not lifted a second time alongside it.
    expect(derived!.documents.filter(d => d.path === 'scenes/a.scene.glb')).toHaveLength(1);
  });

  it('matches an existing entry regardless of a leading ./ or stray whitespace', () => {
    const derived = deriveDocuments({
      documents: [{ id: 'd1', path: 'models/machine.glb', section: 'models' }],
      models: [{ path: './models/machine.glb ' }],
    });
    // Nothing left to add — the two spellings are one document.
    expect(derived).toBeNull();
  });

  it('completes a half-migrated list instead of returning early', () => {
    // Before phase 9 this returned null on sight of a non-empty `documents[]`,
    // which was harmless while the arrays stayed on disk. Now the caller drops
    // them, so an early return would delete the two entries the list is missing.
    const derived = deriveDocuments({
      ...LEGACY_ONLY,
      documents: [{ id: 'scn_a', name: 'Cell A', path: 'scenes/a.scene.glb', section: 'scenes' }],
    });
    expect(derived).not.toBeNull();
    expect(derived!.existing).toBe(1);
    expect(derived!.documents.map(d => d.path)).toEqual([
      'scenes/a.scene.glb', 'models/machine.glb', 'library/gripper.glb',
    ]);
  });

  it('returns null when the list is already complete — "nothing to add"', () => {
    // The changed meaning of null. It no longer says "there is a documents[]",
    // it says "the list speaks for everything the arrays hold", which is what
    // makes dropping the arrays afterwards lossless.
    const complete = deriveDocuments(LEGACY_ONLY)!.documents;
    expect(deriveDocuments({ ...LEGACY_ONLY, documents: complete })).toBeNull();
    expect(deriveDocuments({ documents: complete })).toBeNull();
    expect(deriveDocuments({ schemaVersion: 2, id: 'p', name: 'P' })).toBeNull();
    expect(deriveDocuments(null)).toBeNull();
  });

  it('is idempotent: deriving twice yields the same list', () => {
    const once = deriveDocuments(LEGACY_ONLY)!.documents;
    const twice = withDerivedDocuments(LEGACY_ONLY) as Record<string, unknown>;
    expect(twice.documents).toEqual(once);
    expect(withDerivedDocuments(twice)).toEqual(twice);
  });
});

// ─── 2. The read side: derive in memory, touch nothing ───────────────────

describe('withDerivedDocuments — the one read boundary', () => {
  it('projects an unmigrated schemaVersion:1 manifest into one document list', () => {
    const projected = withDerivedDocuments(LEGACY_ONLY) as Record<string, unknown>;
    expect((projected.documents as Array<Record<string, unknown>>).map(d => d.path)).toEqual([
      'scenes/a.scene.glb', 'models/machine.glb', 'library/gripper.glb',
    ]);
    // The arrays are gone from the projection: nothing downstream may read a
    // second, older answer to the same question.
    for (const key of LEGACY_DOCUMENT_KEYS) expect(projected[key]).toBeUndefined();
    // Everything else survives untouched — `code`, `settings` and the rest are
    // what the publish path actually runs on.
    expect(projected.schemaVersion).toBe(1);
    expect(projected.id).toBe('prj_x');
    // A derivation, not a migration: no marker is minted.
    expect(Object.keys(projected).some(k => k.includes('documents-migration'))).toBe(false);
  });

  it('does not mutate its input and does not write anything', () => {
    const dir = project('p', LEGACY_ONLY);
    const before = readFileSync(join(dir, 'project.json'), 'utf8');
    const parsed = JSON.parse(before);
    const projected = withDerivedDocuments(parsed);
    expect(projected).not.toBe(parsed);
    // The parsed original still carries its arrays…
    expect(parsed.scenes).toEqual(LEGACY_ONLY.scenes);
    expect(parsed.documents).toBeUndefined();
    // …and the file on disk is byte-identical.
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(before);
  });

  it('strips the arrays even when there is nothing to derive', () => {
    // An already-migrated manifest that still carries a leftover array must not
    // hand it downstream just because `deriveDocuments` had nothing to add.
    const complete = deriveDocuments(LEGACY_ONLY)!.documents;
    const projected = withDerivedDocuments({
      documents: complete, scenes: LEGACY_ONLY.scenes, documentsBaseline: [{ path: 'x' }],
    }) as Record<string, unknown>;
    expect(projected.documents).toEqual(complete);
    expect(projected.scenes).toBeUndefined();
    expect(projected.documentsBaseline).toBeUndefined();
  });

  it('passes a non-object through rather than inventing a manifest', () => {
    expect(withDerivedDocuments(null)).toBeNull();
    expect(withoutLegacyArrays(null)).toBeNull();
    expect(withDerivedDocuments([1, 2])).toEqual([1, 2]);
  });
});

// ─── 3. Read acceptance is deliberately NOT cut ──────────────────────────

describe('validate-project accepts both shapes (the read acceptance stays)', () => {
  it('passes a migrated manifest carrying only documents[]', () => {
    const dir = project('p', {
      schemaVersion: 2, id: 'prj_x', name: 'P', canonicalName: 'p',
      documents: [
        { id: 'scn_a', name: 'Cell A', path: 'scenes/a.scene.glb', section: 'scenes' },
        { id: 'doc_m', name: 'Machine', path: 'models/machine.glb', section: 'models' },
      ],
    }, ['scenes/a.scene.glb', 'models/machine.glb']);
    const r = validateProject(dir);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('passes an unmigrated manifest carrying only the three legacy arrays', () => {
    // The gate must not fail a delivery over an unmigrated customer repository.
    const dir = project('p', LEGACY_ONLY,
      ['scenes/a.scene.glb', 'models/machine.glb', 'library/gripper.glb']);
    const r = validateProject(dir);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('passes a half-migrated manifest carrying both', () => {
    const dir = project('p', {
      ...LEGACY_ONLY, schemaVersion: 2,
      documents: [{ id: 'scn_a', name: 'Cell A', path: 'scenes/a.scene.glb', section: 'scenes' }],
    }, ['scenes/a.scene.glb', 'models/machine.glb', 'library/gripper.glb']);
    const r = validateProject(dir);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still refuses a documents[] entry without an id (plan-413 F2 stands)', () => {
    // Acceptance of the old shape is not acceptance of a broken new one.
    const dir = project('p', {
      schemaVersion: 2, id: 'prj_x', name: 'P', canonicalName: 'p',
      documents: [{ name: 'Cell A', path: 'scenes/a.scene.glb', section: 'scenes' }],
    }, ['scenes/a.scene.glb']);
    const r = validateProject(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /has no "id"/.test(e))).toBe(true);
  });

  it('validates the projection of an unmigrated manifest just as happily', () => {
    // What the publish path actually sees after `loadProject()`: the same
    // project, one list, no arrays — and the gate is content with either.
    const dir = project('p', withDerivedDocuments(LEGACY_ONLY),
      ['scenes/a.scene.glb', 'models/machine.glb', 'library/gripper.glb']);
    const r = validateProject(dir);
    expect(r.errors).toEqual([]);
    expect(documentsOf(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')))).toHaveLength(3);
  });
});
