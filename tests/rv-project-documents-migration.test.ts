// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-413 §9.2 — the `documents[]` migration, now the only direction there is.
 *
 * Through §2.4 step A this migration was additive and a mirror re-derived
 * `scenes[]` / `models[]` / `library[]` on every write. Step B (phase 6) ended
 * that: the delivery pipeline reads `documents[]`, so the three arrays are
 * **converted** here — read once, lifted, removed — and never written again.
 *
 * What is at stake is therefore no longer "does the mirror round-trip" but
 * "does anything the customer had survive the lift". The interesting failures
 * are the ones where a field quietly vanishes: an unknown key on one entry, an
 * unknown section at the top level, or an id that changes between two reads of
 * the same unchanged file.
 */

import { describe, it, expect } from 'vitest';
import {
  DOCUMENTS_MIGRATION_MARKER,
  migrateProjectDocuments,
  readDocumentsMigrationMarker,
  rollbackDocumentsMigration,
} from '../src/core/project/rv-project-documents-migration';
import {
  assetDocumentsOf,
  readDocuments,
  sceneDocumentsOf,
  sectionOfDocument,
  stableDocumentId,
} from '../src/core/project/rv-project-documents';
import {
  RV_PROJECT_SCHEMA_VERSION,
  isValidProjectV2,
  type RvProject,
} from '../src/core/project/rv-project-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

/**
 * A manifest of the shape the five customer projects have: scenes with ids,
 * assets without, an unknown field on one entry and an unknown section at the
 * top level. Both unknowns are load-bearing — they are what the
 * forward-compatibility contract is actually about.
 */
function legacyProject(): RvProject {
  return {
    schemaVersion: 1,
    id: 'prj_acme',
    name: 'Acme',
    code: 'acme',
    scenes: [
      {
        id: 'scn_a',
        name: 'Cell A',
        path: 'scenes/cell-a-a.scene.glb',
        modifiedAt: '2026-01-01T00:00:00.000Z',
        format: 'glb',
      },
      {
        id: 'scn_b',
        name: 'Cell B',
        path: 'scenes/cell-b-b.scene.glb',
        // A field this build has never heard of.
        futureField: { anything: true },
      },
    ],
    models: [{ path: 'models/machine.glb', label: 'Machine' }],
    library: [{ path: 'library/conveyor/belt.glb', sha256: 'abc' }],
    somethingNewer: { keep: 'me' },
  } as RvProject;
}

// ─── Migration ──────────────────────────────────────────────────────────

describe('documents migration', () => {
  it('lifts every legacy entry into documents[] and marks the manifest', async () => {
    const result = await migrateProjectDocuments(legacyProject());

    expect(result.outcome).toBe('migrated');
    const docs = readDocuments(result.project)!;
    expect(docs).toHaveLength(4);
    expect(docs.map(d => d.path)).toEqual([
      'scenes/cell-a-a.scene.glb',
      'scenes/cell-b-b.scene.glb',
      'models/machine.glb',
      'library/conveyor/belt.glb',
    ]);
    expect(docs.map(sectionOfDocument)).toEqual(['scenes', 'scenes', 'models', 'library']);

    const marker = readDocumentsMigrationMarker(result.project);
    expect(marker?.schemaVersion).toBe(RV_PROJECT_SCHEMA_VERSION);
    expect(marker?.counts).toEqual({ scenes: 2, models: 1, library: 1 });
    expect(result.project.schemaVersion).toBe(RV_PROJECT_SCHEMA_VERSION);
    expect(isValidProjectV2(result.project)).toBe(true);
  });

  it('mints an id for every entry that has none, and only for those (F2)', async () => {
    const result = await migrateProjectDocuments(legacyProject());
    const docs = readDocuments(result.project)!;

    // The scenes kept theirs.
    expect(docs[0]!.id).toBe('scn_a');
    expect(docs[1]!.id).toBe('scn_b');
    // The two assets were minted for.
    expect(result.mintedIds).toEqual([
      stableDocumentId('models/machine.glb'),
      stableDocumentId('library/conveyor/belt.glb'),
    ]);
    for (const doc of docs) expect(doc.id.trim()).not.toBe('');
  });

  it('mints the SAME id on a second run — ids are derived, never random', async () => {
    // The migration runs inside readManifest() on every read. A random id would
    // hand the same unchanged manifest a different identity every call, and a
    // list whose identities move under it is a list nothing can select in.
    const a = await migrateProjectDocuments(legacyProject());
    const b = await migrateProjectDocuments(legacyProject());
    expect(readDocuments(a.project)!.map(d => d.id))
      .toEqual(readDocuments(b.project)!.map(d => d.id));
  });

  it('carries every field of every entry across, unknown ones included', async () => {
    const before = legacyProject();
    const after = (await migrateProjectDocuments(structuredClone(before))).project;
    const docs = readDocuments(after)!;

    // The scene entries survive verbatim — the projection only adds `section`.
    const beforeScenes = (before as Record<string, unknown>).scenes as Record<string, unknown>[];
    expect(docs[0]).toMatchObject(beforeScenes[0]);
    expect(docs[1]).toMatchObject(beforeScenes[1]);
    expect(docs[1]!.futureField).toEqual({ anything: true });
    // Asset entries keep `label` / `sha256` and gain a name and an id.
    expect(docs[2]).toMatchObject({ path: 'models/machine.glb', label: 'Machine' });
    expect(docs[3]).toMatchObject({ path: 'library/conveyor/belt.glb', sha256: 'abc' });

    // Everything outside the three arrays is untouched.
    expect(after.code).toBe('acme');
    expect((after as Record<string, unknown>).somethingNewer).toEqual({ keep: 'me' });
  });

  it('removes the three legacy arrays — the mirror is gone (§2.4 step B)', async () => {
    const after = (await migrateProjectDocuments(legacyProject())).project;
    const raw = after as Record<string, unknown>;
    expect(raw.scenes).toBeUndefined();
    expect(raw.models).toBeUndefined();
    expect(raw.library).toBeUndefined();
    expect(raw.documentsBaseline).toBeUndefined();
  });

  it('drops a step-A mirror left in a manifest that is already converted', async () => {
    // A manifest saved by the previous release: documents[], marker, AND the
    // derived arrays. The arrays are a frozen copy from that moment; keeping
    // them would leave the manifest disagreeing with itself.
    const stepA = (await migrateProjectDocuments(legacyProject())).project;
    const withMirror = {
      ...stepA,
      scenes: [{ id: 'scn_stale', name: 'Stale', path: 'scenes/stale.scene.glb' }],
      models: [],
      documentsBaseline: { 'scenes:scn_stale': 'deadbeef' },
    } as RvProject;

    const again = await migrateProjectDocuments(withMirror);
    expect(again.outcome).toBe('already');
    const raw = again.project as Record<string, unknown>;
    expect(raw.scenes).toBeUndefined();
    expect(raw.documentsBaseline).toBeUndefined();
    expect(readDocuments(again.project)!.map(d => d.id)).toEqual(
      readDocuments(stepA)!.map(d => d.id),
    );
  });

  it('is idempotent: a second run mints nothing and moves nothing', async () => {
    const once = await migrateProjectDocuments(legacyProject());
    const twice = await migrateProjectDocuments(once.project);

    expect(twice.outcome).toBe('already');
    expect(twice.mintedIds).toEqual([]);
    expect(readDocuments(twice.project)).toEqual(readDocuments(once.project));
  });

  it('leaves a documents[] written by a newer client alone', async () => {
    // No marker + documents[] present means somebody ahead of us authored it.
    // Re-deriving from the legacy arrays would throw away exactly what they added.
    const foreign: RvProject = {
      ...legacyProject(),
      documents: [{ id: 'doc_x', path: 'models/x.glb', name: 'X', tomorrow: 1 }],
    };
    const result = await migrateProjectDocuments(foreign);
    expect(result.outcome).toBe('skipped');
    expect(readDocuments(result.project)!.map(d => d.id)).toEqual(['doc_x']);
  });

  it('gives an empty project an empty list rather than no list', async () => {
    // Since phase 6 `isValidProjectV2` requires `documents[]`, and a project
    // with nothing in it is an ordinary new project, not a broken one. Leaving
    // the field off here would turn "empty" into the F10 refusal.
    const empty: RvProject = { schemaVersion: 1, id: 'prj_e', name: 'Empty' };
    const result = await migrateProjectDocuments(empty);
    expect(result.outcome).toBe('migrated');
    expect(result.project.documents).toEqual([]);
    expect(isValidProjectV2(result.project)).toBe(true);
  });

  it('refuses a non-manifest without throwing', async () => {
    const result = await migrateProjectDocuments(null as unknown as RvProject);
    expect(result.outcome).toBe('failed');
  });
});

// ─── The projections that replaced the mirror ──────────────────

describe('section projections', () => {
  it('hand back exactly the documents of one section, in manifest order', async () => {
    const migrated = (await migrateProjectDocuments(legacyProject())).project;

    expect(sceneDocumentsOf(migrated).map(e => e.id)).toEqual(['scn_a', 'scn_b']);
    expect(assetDocumentsOf(migrated, 'models').map(e => e.path))
      .toEqual(['models/machine.glb']);
    expect(assetDocumentsOf(migrated, 'library').map(e => e.path))
      .toEqual(['library/conveyor/belt.glb']);
  });

  it('are projections, not copies — nothing is stored beside documents[]', async () => {
    const migrated = (await migrateProjectDocuments(legacyProject())).project;
    // The same objects come back, not clones of them: a projection that
    // duplicated its source could go stale, which is the whole failure mode the
    // mirror had and this does not.
    expect(sceneDocumentsOf(migrated)[0]).toBe(readDocuments(migrated)![0]);
    expect(JSON.parse(JSON.stringify(migrated)).scenes).toBeUndefined();
  });

  it('a scene document keeps its display name; an asset keeps its label', async () => {
    const migrated = (await migrateProjectDocuments(legacyProject())).project;
    expect(sceneDocumentsOf(migrated)[0].name).toBe('Cell A');
    expect(assetDocumentsOf(migrated, 'models')[0].label).toBe('Machine');
  });

  it('an empty or absent list projects to nothing rather than throwing', () => {
    expect(sceneDocumentsOf(null)).toEqual([]);
    expect(assetDocumentsOf({ schemaVersion: 2, id: 'p', name: 'P' }, 'models')).toEqual([]);
  });
});

// ─── Rollback ──────────────────────────────────────

describe('rollback', () => {
  it('removes what the migration wrote — and cannot bring the arrays back', async () => {
    const before = legacyProject();
    const migrated = (await migrateProjectDocuments(structuredClone(before))).project;
    const back = rollbackDocumentsMigration(migrated);

    expect(back.documents).toBeUndefined();
    expect(back.documentsBaseline).toBeUndefined();
    expect(back[DOCUMENTS_MIGRATION_MARKER]).toBeUndefined();
    // Everything outside the three arrays is exactly as it was.
    expect(back.code).toBe('acme');
    expect((back as Record<string, unknown>).somethingNewer).toEqual({ keep: 'me' });
    // The conversion is one-way: the arrays are not restored, and pretending
    // otherwise would be the one dishonest line in this module. Recovering them
    // is what `project.json.bak` and the customer's git history are for.
    expect((back as Record<string, unknown>).scenes).toBeUndefined();
    // schemaVersion stays at 2 on purpose: it says what the writer understood.
    expect(back.schemaVersion).toBe(RV_PROJECT_SCHEMA_VERSION);
  });
});
