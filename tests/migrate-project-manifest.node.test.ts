// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * migrate-project-manifest — the offline manifest migrator (plan-700 Phase 1).
 *
 * Fixtures are synthetic on purpose (plan-370 requirement R5): the six real
 * projects live in the private sibling repo, so a test that reached for them
 * would silently pass by matching nothing in a public-only checkout.
 *
 * The properties worth pinning are all about NOT losing things: legacy deploy
 * fields, unknown future sections, and the customer's own folders.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  migrateManifest,
  migrateProjectDir,
  migrateProjectsRoot,
  discoverScenes,
  discoverPluginModules,
  canonicalNameOf,
} from '../scripts/migrate-project-manifest.mjs';
import { vendorGlobProblems, CUSTOMER_OWNED_FOLDERS } from '../scripts/_rv-guards.mjs';
import {
  DOCUMENTS_MIGRATION_MARKER,
  DOCUMENT_REF_FIELDS,
  SCRIPT_REF_MIGRATION_MARKER,
  deriveScriptRefs,
  documentRefsOf,
  isContainedRef,
  projectConnectRefs,
  readDocumentRef,
  stableDocumentId,
} from '../scripts/_rv-manifest.mjs';
import { stableDocumentId as tsStableDocumentId } from '../src/core/project/rv-project-documents';
// The TypeScript twin, imported so 'the two must agree' is asserted and not hoped.
import { isContainedRef as tsIsContainedRef } from '../src/core/project/rv-project-refs';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rv-migrate-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Writes a project folder with the given manifest and returns its path. */
function project(name: string, manifest: unknown, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

/** The shape of every project.json in the wild before plan-370. */
const LEGACY = {
  name: 'Mauser 3D HMI',
  code: 'a9d6c728c2a7006e52e55c03a174efbf',
  created: '2026-04-03',
  lastPublished: '2026-07-21T10:22:17Z',
  settings: { defaultModel: 'MauserCageline30.glb' },
};

describe('migrateManifest', () => {
  it('adds the rv-project/2 core fields to a legacy manifest', () => {
    const { manifest, changes } = migrateManifest(LEGACY, {
      folderName: 'mauser3dhmi', now: '2026-08-06T00:00:00.000Z', mintId: () => 'prj_fixed',
    });
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.id).toBe('prj_fixed');
    expect(manifest.canonicalName).toBe('mauser3dhmi');
    expect(manifest.createdAt).toBe('2026-04-03');
    expect(manifest.modifiedAt).toBe('2026-04-03');
    expect(changes.length).toBeGreaterThan(0);
  });

  it('keeps every legacy deploy field (_bunny-lib still reads them)', () => {
    const { manifest } = migrateManifest(LEGACY, { folderName: 'mauser3dhmi' });
    expect(manifest.code).toBe(LEGACY.code);
    expect(manifest.created).toBe(LEGACY.created);
    expect(manifest.lastPublished).toBe(LEGACY.lastPublished);
    expect(manifest.settings).toEqual(LEGACY.settings);
    expect(manifest.name).toBe('Mauser 3D HMI');
  });

  it('carries unknown and future sections through untouched', () => {
    const { manifest } = migrateManifest(
      { ...LEGACY, somethingFromTheFuture: { deep: [1, 2, { x: true }] } },
      { folderName: 'p' },
    );
    expect(manifest.somethingFromTheFuture).toEqual({ deep: [1, 2, { x: true }] });
  });

  it('does NOT invent models[] or library[] — the folder is the source of truth (P0-3)', () => {
    const { manifest } = migrateManifest(LEGACY, { folderName: 'p' });
    expect(manifest.models).toBeUndefined();
    expect(manifest.library).toBeUndefined();
  });

  it('adds a conservative vendor block that cannot reach customer folders', () => {
    const { manifest } = migrateManifest(LEGACY, { folderName: 'p' });
    const vendor = manifest.vendor as { managed: string[]; handover: string[] };
    expect(vendorGlobProblems(vendor)).toEqual([]);
    for (const folder of CUSTOMER_OWNED_FOLDERS) {
      expect(vendor.managed.some(g => g.startsWith(folder + '/'))).toBe(false);
    }
  });

  it('never rewrites a field that is already there', () => {
    const already = {
      ...LEGACY, schemaVersion: 2, id: 'prj_mine', canonicalName: 'custom-slug',
      createdAt: 'A', modifiedAt: 'B', kind: 'customer', vendor: { managed: ['models/**'] },
    };
    const { manifest, changes } = migrateManifest(already, { folderName: 'other' });
    expect(changes).toEqual([]);
    expect(manifest).toEqual(already);
  });

  it('rejects a manifest that is not a JSON object', () => {
    expect(() => migrateManifest([] as unknown as Record<string, unknown>)).toThrow();
    expect(() => migrateManifest(null as unknown as Record<string, unknown>)).toThrow();
  });
});

describe('scene indexing', () => {
  it('indexes the scene files using the id inside the file', () => {
    const dir = project('p', LEGACY, {
      'scenes/cell-scn_a.scene.json': JSON.stringify({ id: 'scn_a', name: 'Cell' }),
      'scenes/line-scn_b.scene.json': JSON.stringify({ id: 'scn_b', name: 'Line' }),
      'scenes/notes.txt': 'not a scene',
    });
    expect(discoverScenes(dir)).toEqual([
      { id: 'scn_a', name: 'Cell', path: 'scenes/cell-scn_a.scene.json' },
      { id: 'scn_b', name: 'Line', path: 'scenes/line-scn_b.scene.json' },
    ]);
  });

  it('indexes an unparseable scene file rather than pretending it is not there', () => {
    const dir = project('p', LEGACY, { 'scenes/broken-scn_x.scene.json': '{ truncated' });
    expect(discoverScenes(dir)).toEqual([
      { id: 'broken-scn_x', name: 'broken-scn_x', path: 'scenes/broken-scn_x.scene.json' },
    ]);
  });

  it('adds missing scene files to an existing index without touching the entries there', () => {
    // plan-703 phase 9: the index the scene files land in is `documents[]`, not
    // `scenes[]` — the additive rule is unchanged, only one level down.
    const existing = { id: 'scn_a', name: 'Renamed By User', path: 'scenes/a.scene.json', tags: ['keep'] };
    const { manifest } = migrateManifest({ ...LEGACY, scenes: [existing] }, {
      folderName: 'p',
      scenes: [
        { id: 'scn_a', name: 'Cell', path: 'scenes/a.scene.json' },
        { id: 'scn_b', name: 'Line', path: 'scenes/b.scene.json' },
      ],
    });
    const documents = manifest.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(2);
    // Every field of the entry the user annotated survives; `section` is the
    // one addition, and it says where the bytes live, not what they are called.
    expect(documents[0]).toEqual({ ...existing, section: 'scenes' });
    expect(documents[1].path).toBe('scenes/b.scene.json');
    expect(manifest.scenes).toBeUndefined();
  });
});

describe('migrateProjectDir', () => {
  it('writes nothing without --apply (dry run is the default)', () => {
    const dir = project('p', LEGACY);
    const before = readFileSync(join(dir, 'project.json'), 'utf8');
    expect(migrateProjectDir(dir).status).toBe('migrated');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(before);
  });

  it('is idempotent: a second apply produces a byte-identical file', () => {
    const dir = project('p', LEGACY);
    migrateProjectDir(dir, { apply: true });
    const first = readFileSync(join(dir, 'project.json'), 'utf8');
    expect(migrateProjectDir(dir, { apply: true }).status).toBe('unchanged');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(first);
  });

  it('migrates a half-migrated manifest (schemaVersion AND legacy fields) idempotently', () => {
    const dir = project('p', {
      ...LEGACY, schemaVersion: 2, id: 'prj_x', canonicalName: 'p', createdAt: 'A', modifiedAt: 'B',
    });
    const first = migrateProjectDir(dir, { apply: true });
    expect(first.changes).toEqual([
      'kind: set to "internal" (one of customer/demo/internal)',
      'vendor: conservative default added (sharpen per project)',
    ]);
    const contents = readFileSync(join(dir, 'project.json'), 'utf8');
    expect(migrateProjectDir(dir, { apply: true }).status).toBe('unchanged');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(contents);
  });

  it('skips a folder without a manifest instead of failing', () => {
    const dir = join(root, 'scratch');
    mkdirSync(dir, { recursive: true });
    expect(migrateProjectDir(dir).status).toBe('skipped');
  });

  it('skips a manifest that is not valid JSON, and leaves it alone', () => {
    const dir = join(root, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.json'), '{ truncated');
    expect(migrateProjectDir(dir, { apply: true }).status).toBe('skipped');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe('{ truncated');
  });
});

describe('migrateProjectsRoot', () => {
  it('reports one result per folder and does not stop at a bad one', () => {
    project('alpha', LEGACY);
    project('beta', { ...LEGACY, name: 'Beta' });
    mkdirSync(join(root, 'scratch'), { recursive: true });
    const results = migrateProjectsRoot(root, { apply: true });
    expect(results.map(r => r.project)).toEqual(['alpha', 'beta', 'scratch']);
    expect(results.filter(r => r.status === 'migrated')).toHaveLength(2);
    expect(results.find(r => r.project === 'scratch')?.status).toBe('skipped');
    expect(existsSync(join(root, 'alpha', 'project.json'))).toBe(true);
  });
});

describe('canonicalNameOf', () => {
  it('agrees with the browser slug rules', () => {
    expect(canonicalNameOf('Toray OEE Showcase')).toBe('toray-oee-showcase');
    expect(canonicalNameOf('mauser3dhmi')).toBe('mauser3dhmi');
    expect(canonicalNameOf('  ---  ')).toBe('project');
  });
});

// ─── plan-413 phase 6: the Node pipeline speaks documents[] ──────────────

describe('documents[] derivation (plan-413 §2.4 step A, offline)', () => {
  const WITH_LISTS = {
    ...LEGACY, schemaVersion: 1, id: 'prj_x', canonicalName: 'p',
    createdAt: 'A', modifiedAt: 'B', vendor: { managed: ['models/**'] },
    scenes: [{ id: 'scn_a', name: 'Cell A', path: 'scenes/a.scene.glb' }],
    models: [{ path: 'models/machine.glb', label: 'Machine' }],
    library: [{ path: 'library/gripper.glb' }],
  };

  it('lifts all three arrays into one documents[] and marks the project', () => {
    const { manifest } = migrateManifest(WITH_LISTS, {
      folderName: 'p', now: '2026-08-08T00:00:00.000Z',
    });
    expect(manifest.documents.map((d: Record<string, unknown>) => [d.section, d.path])).toEqual([
      ['scenes', 'scenes/a.scene.glb'],
      ['models', 'models/machine.glb'],
      ['library', 'library/gripper.glb'],
    ]);
    expect(manifest[DOCUMENTS_MIGRATION_MARKER]).toEqual({
      at: '2026-08-08T00:00:00.000Z', schemaVersion: 2,
      counts: { scenes: 1, models: 1, library: 1 },
    });
  });

  it('drops the three legacy arrays — the hardcut (plan-703 decision 20)', () => {
    // The inversion of the pre-phase-9 expectation, and deliberately so. While
    // the browser still mirrored the arrays out of `documents[]`, keeping them
    // was the only way the two halves of the migration agreed. Phase 6 removed
    // that mirror and `withoutLegacyArrays()` now strips them on every browser
    // save, so a migrator that kept them would write back, on the next
    // delivery, precisely what the last save deleted.
    const { manifest, changes } = migrateManifest(WITH_LISTS, { folderName: 'p' });
    expect(manifest.scenes).toBeUndefined();
    expect(manifest.models).toBeUndefined();
    expect(manifest.library).toBeUndefined();
    // Nothing is lost by the drop: everything the arrays held is in the list.
    expect((manifest.documents as Array<Record<string, unknown>>).map(d => d.path)).toEqual([
      'scenes/a.scene.glb', 'models/machine.glb', 'library/gripper.glb',
    ]);
    // And the drop is reported, so a dry run shows what an --apply would do.
    expect(changes.filter((c: string) => /dropped/.test(c))).toHaveLength(3);
  });

  it('writes no documentsBaseline — nothing here mirrors, and "no evidence" is the safe read', () => {
    const { manifest } = migrateManifest(WITH_LISTS, { folderName: 'p' });
    expect(manifest.documentsBaseline).toBeUndefined();
  });

  it('keeps an id an entry already has, and derives one for an entry without', () => {
    const { manifest } = migrateManifest(WITH_LISTS, { folderName: 'p' });
    const [scene, model] = manifest.documents as Array<Record<string, unknown>>;
    expect(scene.id).toBe('scn_a');
    expect(model.id).toBe(stableDocumentId('models/machine.glb'));
  });

  it('agrees with the browser id rule, character for character', () => {
    // The browser migration runs inside readManifest() on every open. If the
    // two rules disagreed, the same file would have two identities depending on
    // which of the two migrators saw it first.
    for (const path of ['models/machine.glb', 'scenes/a.scene.glb', 'library/sub/x.glb', '']) {
      expect(stableDocumentId(path)).toBe(tsStableDocumentId(path));
    }
  });

  it('is idempotent: a manifest that already has documents[] is not re-derived', () => {
    const once = migrateManifest(WITH_LISTS, { folderName: 'p' }).manifest;
    const twice = migrateManifest(once, { folderName: 'p' }).manifest;
    expect(twice.documents).toEqual(once.documents);
    expect(twice[DOCUMENTS_MIGRATION_MARKER]).toEqual(once[DOCUMENTS_MIGRATION_MARKER]);
  });

  it('adds nothing to an empty project', () => {
    const { manifest } = migrateManifest(LEGACY, { folderName: 'p' });
    expect(manifest.documents).toBeUndefined();
    expect(manifest[DOCUMENTS_MIGRATION_MARKER]).toBeUndefined();
  });
});

describe('discoverScenes finds the GLB bodies plan-413 phase 3 produced', () => {
  it('indexes a .scene.glb by its filename', () => {
    const dir = project('p', LEGACY, { 'scenes/cell.scene.glb': 'glTF-ish' });
    expect(discoverScenes(dir)).toEqual([
      { id: 'cell', name: 'cell', path: 'scenes/cell.scene.glb' },
    ]);
  });

  it('prefers the GLB over a .scene.json sibling instead of listing the scene twice', () => {
    const dir = project('p', LEGACY, {
      'scenes/cell.scene.glb': 'glTF-ish',
      'scenes/cell.scene.json': JSON.stringify({ id: 'scn_old', name: 'Old' }),
    });
    expect(discoverScenes(dir)).toEqual([
      { id: 'cell', name: 'cell', path: 'scenes/cell.scene.glb' },
    ]);
  });

  it('still indexes an unconverted .scene.json on its own', () => {
    const dir = project('p', LEGACY, {
      'scenes/legacy.scene.json': JSON.stringify({ id: 'scn_l', name: 'Legacy' }),
    });
    expect(discoverScenes(dir)).toEqual([
      { id: 'scn_l', name: 'Legacy', path: 'scenes/legacy.scene.json' },
    ]);
  });
});

/**
 * plan-718 §2.5 — the Node twin learns the reference fields (K11).
 *
 * The delivery pipeline sees a `project.json` ONLY through `_rv-manifest.mjs`.
 * A reference field the twin does not know is a binding a delivery cannot see,
 * so "the two must agree" has to be asserted here and not assumed.
 */
describe('reference fields (plan-718)', () => {
  it('reads all three, and normalises them the way the TypeScript does', () => {
    const entry = {
      id: 'a', path: 'models/a.glb',
      connectRef: '.\\connect\\a.connect.json',
      scriptRef: 'plugins/index.ts',
      knowledgeRef: './knowledge/a.json',
    };
    expect(readDocumentRef(entry, 'connectRef')).toBe('connect/a.connect.json');
    expect(readDocumentRef(entry, 'scriptRef')).toBe('plugins/index.ts');
    expect(readDocumentRef(entry, 'knowledgeRef')).toBe('knowledge/a.json');
    expect(DOCUMENT_REF_FIELDS).toEqual(['connectRef', 'scriptRef', 'knowledgeRef']);
  });

  it('agrees with the TypeScript on containment, escape for escape', () => {
    for (const bad of ['../out.json', 'a/../../out.json', '/etc/x', 'C:/x.json', '', 'https://x/y']) {
      expect(isContainedRef(bad), bad).toBe(tsIsContainedRef(bad));
      expect(isContainedRef(bad), bad).toBe(false);
    }
    for (const good of ['connect/a.json', 'models/v..2/a.glb']) {
      expect(isContainedRef(good), good).toBe(tsIsContainedRef(good));
      expect(isContainedRef(good), good).toBe(true);
    }
  });

  it('lists an escaping reference as NOT contained rather than hiding it', () => {
    const manifest = {
      documents: [
        { id: 'a', path: 'models/a.glb', connectRef: 'connect/a.json' },
        { id: 'b', path: 'models/b.glb', connectRef: '../outside.json' },
      ],
    };
    const refs = documentRefsOf(manifest);
    expect(refs).toHaveLength(2);
    expect(refs.find(r => r.documentId === 'b')!.contained).toBe(false);
  });

  it('fills in the secrets sidecar default, and rejects an escaping one', () => {
    expect(projectConnectRefs({}).secretsRef).toBe('connect/secrets.local.json');
    expect(projectConnectRefs({ connect: { agentsRef: 'connect/agents.json' } }).agentsRef)
      .toBe('connect/agents.json');
    expect(projectConnectRefs({ connect: { agentsRef: '../a.json' } }).agentsRef).toBeNull();
  });
});

describe('models[] → scriptRef, offline (plan-718 §2.7)', () => {
  const withDocs = (documents: unknown[]) => ({
    ...LEGACY, schemaVersion: 2, id: 'prj_x', canonicalName: 'p', documents,
  });

  it('reads a project plugin module and what it declares', () => {
    const dir = project('p', LEGACY, {
      'plugins/index.ts': 'export const models = [\'Line1\', "Line2"];\n',
    });
    expect(discoverPluginModules(dir)).toEqual([
      { scriptRef: 'plugins/index.ts', models: ['Line1', 'Line2'] },
    ]);
  });

  it('a module with no declaration yields an entry with no models', () => {
    const dir = project('p', LEGACY, { 'plugins/index.ts': 'export function x() {}\n' });
    expect(discoverPluginModules(dir)).toEqual([{ scriptRef: 'plugins/index.ts', models: [] }]);
  });

  it('binds the declared rows and records the marker', () => {
    const derived = deriveScriptRefs(
      withDocs([
        { id: 'd1', path: 'models/Line1.glb' },
        { id: 'd2', path: 'models/Line2.glb' },
        { id: 'd3', path: 'models/Other.glb' },
      ]),
      [{ scriptRef: 'plugins/index.ts', models: ['Line1', 'Line2'] }],
      { now: '2026-08-14T00:00:00.000Z' },
    )!;
    expect(derived.assigned.map(a => a.documentId)).toEqual(['d1', 'd2']);
    expect(derived.documents.find(d => d.id === 'd3')!.scriptRef).toBeUndefined();
    expect(derived.marker.assignedIds).toEqual(['d1', 'd2']);
  });

  it('reports a case mismatch instead of binding it (K3)', () => {
    const derived = deriveScriptRefs(
      withDocs([{ id: 'd1', path: 'models/line1.glb' }]),
      [{ scriptRef: 'plugins/index.ts', models: ['Line1'] }],
    )!;
    expect(derived.assigned).toEqual([]);
    expect(derived.caseMismatches).toEqual([
      { declared: 'Line1', scriptRef: 'plugins/index.ts', documentId: 'd1', documentPath: 'models/line1.glb' },
    ]);
  });

  it('never overwrites a scriptRef the manifest already carries', () => {
    const derived = deriveScriptRefs(
      withDocs([{ id: 'd1', path: 'models/Line1.glb', scriptRef: 'scripts/mine.ts' }]),
      [{ scriptRef: 'plugins/index.ts', models: ['Line1'] }],
    );
    expect(derived).toBeNull();
  });

  it('refuses a scriptRef that would leave the project', () => {
    const derived = deriveScriptRefs(
      withDocs([{ id: 'd1', path: 'models/Line1.glb' }]),
      [{ scriptRef: '../elsewhere/index.ts', models: ['Line1'] }],
    );
    expect(derived).toBeNull();
  });

  it('the migrator writes it once and is idempotent on the second run', () => {
    const dir = project('p', withDocs([{ id: 'd1', path: 'models/Line1.glb', name: 'Line1' }]), {
      'plugins/index.ts': 'export const models = [\'Line1\'];\n',
      'models/Line1.glb': 'GLB',
    });
    const first = migrateProjectDir(dir, { apply: true });
    expect(first.status).toBe('migrated');
    const written = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(written.documents[0].scriptRef).toBe('plugins/index.ts');
    expect(written[SCRIPT_REF_MIGRATION_MARKER].assigned).toBe(1);

    const second = migrateProjectDir(dir, { apply: true });
    expect(second.status).toBe('unchanged');
  });

  it('names a case mismatch in the change log rather than fixing it', () => {
    const dir = project('p', withDocs([{ id: 'd1', path: 'models/line1.glb', name: 'line1' }]), {
      'plugins/index.ts': 'export const models = [\'Line1\'];\n',
      'models/line1.glb': 'GLB',
    });
    const result = migrateProjectDir(dir, { apply: false });
    expect(result.changes.some(c => /case differs, NOT bound/.test(c))).toBe(true);
  });

  it('a project with no plugin module is untouched by this step', () => {
    const dir = project('p', withDocs([{ id: 'd1', path: 'models/Line1.glb', name: 'Line1' }]), {
      'models/Line1.glb': 'GLB',
    });
    const after = migrateProjectDir(dir, { apply: true });
    const written = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(written[SCRIPT_REF_MIGRATION_MARKER]).toBeUndefined();
    expect(after.status).not.toBe('skipped');
  });
});

/**
 * plan-434 §2.6 — the migrator fills in `kind`.
 *
 * The default direction is the whole point. The field's one consumer is the
 * foreign-customer-name guard, and it errs safely when a folder is under-claimed
 * (`internal`) and dangerously when it is over-claimed (`customer`): a wrong
 * `internal` costs a guard that did not fire on a name nobody was hiding, a
 * wrong `customer` aborts every delivery whose tree happens to contain the word.
 */
describe('project kind (plan-434 §2.6)', () => {
  it('defaults to internal — the direction where a mistake is cheap', () => {
    const { manifest, changes } = migrateManifest(LEGACY, { folderName: 'p' });
    expect(manifest.kind).toBe('internal');
    expect(changes.some(c => c.startsWith('kind:'))).toBe(true);
  });

  it('takes the kind the caller names', () => {
    for (const kind of ['customer', 'demo', 'internal'] as const) {
      expect(migrateManifest(LEGACY, { folderName: 'p', kind }).manifest.kind).toBe(kind);
    }
  });

  it('ignores a kind outside the enum rather than writing it', () => {
    // Deliberately off-type: the guard exists for a caller that is NOT typed —
    // the CLI, a JSON file, a hand-written script.
    const seed = 'seed' as unknown as 'internal';
    expect(migrateManifest(LEGACY, { folderName: 'p', kind: seed }).manifest.kind).toBe('internal');
  });

  it('never overwrites a kind that is already there, not even a wrong one', () => {
    // Reporting an unknown kind is `validate-project.mjs`'s job (it fails on it).
    // A migrator that "fixed" it would change meaning behind the author's back —
    // and `customer` → `internal` is exactly the silent downgrade that turns the
    // leak guard off for a real customer.
    for (const kind of ['customer', 'seed']) {
      const { manifest, changes } = migrateManifest({ ...LEGACY, kind }, { folderName: 'p', kind: 'demo' });
      expect(manifest.kind).toBe(kind);
      expect(changes.some(c => c.startsWith('kind:'))).toBe(false);
    }
  });
});
