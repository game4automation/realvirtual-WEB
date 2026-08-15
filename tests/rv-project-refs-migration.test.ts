// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.3 — `models[] → scriptRef` (plan-718 §2.7, F9).
 *
 * Four outcomes, a marker that travels with the file, and one refusal that is
 * easy to get wrong: a declaration that matches a document only when case is
 * ignored is REPORTED, never bound. The runtime matcher is case-sensitive, so
 * such a declaration binds nothing today, and "fixing" it here would be a
 * behaviour change wearing a migration's clothes (K3).
 */

import { describe, it, expect } from 'vitest';
import {
  SCRIPT_REF_MIGRATION_MARKER,
  migrateProjectScriptRefs,
  modelNameOfDocumentPath,
  readScriptRefMigrationMarker,
  rollbackScriptRefMigration,
  type PluginModuleDeclaration,
} from '../src/core/project/rv-project-refs-migration';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

const NOW = () => '2026-08-14T00:00:00.000Z';

function project(documents: RvDocumentEntry[]): RvProject {
  return {
    schemaVersion: 2, id: 'prj_test', name: 'Test', documents,
  } as unknown as RvProject;
}

const THREE = () => project([
  { id: 'd1', path: 'models/Line1.glb', name: 'Line1' },
  { id: 'd2', path: 'models/Line2.glb', name: 'Line2' },
  { id: 'd3', path: 'models/Other.glb', name: 'Other' },
]);

const DECL: PluginModuleDeclaration[] = [
  { scriptRef: 'plugins/index.ts', models: ['Line1', 'Line2'] },
];

describe('§9.3 — outcome: migrated', () => {
  it('binds every declared row and leaves the rest alone', () => {
    const result = migrateProjectScriptRefs(THREE(), { modules: DECL, now: NOW });
    expect(result.outcome).toBe('migrated');
    const docs = result.project.documents!;
    expect(docs.find(d => d.id === 'd1')!.scriptRef).toBe('plugins/index.ts');
    expect(docs.find(d => d.id === 'd2')!.scriptRef).toBe('plugins/index.ts');
    expect(docs.find(d => d.id === 'd3')!.scriptRef).toBeUndefined();
  });

  it('is N:1 by construction — one module, two rows, one value', () => {
    const result = migrateProjectScriptRefs(THREE(), { modules: DECL, now: NOW });
    const refs = result.project.documents!
      .map(d => d.scriptRef).filter(Boolean);
    expect(refs).toEqual(['plugins/index.ts', 'plugins/index.ts']);
    expect(result.assigned.map(a => a.declared)).toEqual(['Line1', 'Line2']);
  });

  it('records a marker that travels with the manifest', () => {
    const result = migrateProjectScriptRefs(THREE(), { modules: DECL, now: NOW });
    const marker = readScriptRefMigrationMarker(result.project)!;
    expect(marker.at).toBe('2026-08-14T00:00:00.000Z');
    expect(marker.assigned).toBe(2);
    expect(marker.assignedIds).toEqual(['d1', 'd2']);
    expect(result.project[SCRIPT_REF_MIGRATION_MARKER]).toBeDefined();
  });

  it('does not mutate its input', () => {
    const before = THREE();
    migrateProjectScriptRefs(before, { modules: DECL, now: NOW });
    expect(before.documents!.every(d => d.scriptRef === undefined)).toBe(true);
  });

  it('never overwrites a scriptRef the manifest already carries', () => {
    const authored = THREE();
    authored.documents![0].scriptRef = 'scripts/mine.ts';
    const result = migrateProjectScriptRefs(authored, { modules: DECL, now: NOW });
    expect(result.project.documents![0].scriptRef).toBe('scripts/mine.ts');
    expect(result.assigned.map(a => a.documentId)).toEqual(['d2']);
  });

  it('the first row wins when two documents share a model name', () => {
    const twins = project([
      { id: 'd1', path: 'models/Line1.glb', name: 'a' },
      { id: 'd2', path: 'library/Line1.glb', name: 'b' },
    ]);
    const result = migrateProjectScriptRefs(twins, {
      modules: [{ scriptRef: 'plugins/index.ts', models: ['Line1'] }], now: NOW,
    });
    expect(result.assigned.map(a => a.documentId)).toEqual(['d1']);
    expect(result.project.documents![1].scriptRef).toBeUndefined();
  });
});

describe('§9.3 — outcome: already, skipped, failed', () => {
  it('a second run is `already` and changes nothing', () => {
    const first = migrateProjectScriptRefs(THREE(), { modules: DECL, now: NOW });
    const second = migrateProjectScriptRefs(first.project, { modules: DECL, now: NOW });
    expect(second.outcome).toBe('already');
    expect(second.project).toBe(first.project);
  });

  it('`force` runs it again anyway', () => {
    const first = migrateProjectScriptRefs(THREE(), { modules: DECL, now: NOW });
    const forced = migrateProjectScriptRefs(first.project, { modules: DECL, force: true, now: NOW });
    // Nothing left to assign — the rows already carry the value.
    expect(forced.outcome).toBe('skipped');
  });

  it('a read-only backend never migrates (plan-717 §9.0)', () => {
    const result = migrateProjectScriptRefs(THREE(), { modules: DECL, writable: false, now: NOW });
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('read-only backend');
    expect(result.project.documents!.every(d => d.scriptRef === undefined)).toBe(true);
  });

  it('no declarations, no documents, or no match — all `skipped`', () => {
    expect(migrateProjectScriptRefs(THREE(), { modules: [], now: NOW }).outcome).toBe('skipped');
    expect(migrateProjectScriptRefs(project([]), { modules: DECL, now: NOW }).outcome).toBe('skipped');
    expect(migrateProjectScriptRefs(THREE(), {
      modules: [{ scriptRef: 'plugins/index.ts', models: ['Nothing'] }], now: NOW,
    }).outcome).toBe('skipped');
  });

  it('a module outside the project cannot become a reference', () => {
    const result = migrateProjectScriptRefs(THREE(), {
      modules: [{ scriptRef: '../../src/plugins/models/Line1/index.ts', models: ['Line1'] }],
      now: NOW,
    });
    expect(result.outcome).toBe('skipped');
  });

  it('a non-manifest input is `failed`, not a throw', () => {
    expect(migrateProjectScriptRefs(null as unknown as RvProject, { modules: DECL }).outcome)
      .toBe('failed');
    expect(migrateProjectScriptRefs([] as unknown as RvProject, { modules: DECL }).outcome)
      .toBe('failed');
  });
});

describe('§9.3 — case mismatches are reported, not repaired (K3)', () => {
  it('records the mismatch and binds nothing', () => {
    const lower = project([{ id: 'd1', path: 'models/line1.glb', name: 'line1' }]);
    const result = migrateProjectScriptRefs(lower, {
      modules: [{ scriptRef: 'plugins/index.ts', models: ['Line1'] }], now: NOW,
    });
    expect(result.outcome).toBe('migrated'); // there IS something to record
    expect(result.assigned).toEqual([]);
    expect(result.caseMismatches).toEqual([{
      declared: 'Line1', scriptRef: 'plugins/index.ts',
      documentId: 'd1', documentPath: 'models/line1.glb',
    }]);
    expect(result.project.documents![0].scriptRef).toBeUndefined();
    expect(readScriptRefMigrationMarker(result.project)!.caseMismatches).toHaveLength(1);
  });

  it('an exact match beside a case-only one still binds the exact one', () => {
    const both = project([
      { id: 'd1', path: 'models/line1.glb', name: 'lower' },
      { id: 'd2', path: 'models/Line1.glb', name: 'exact' },
    ]);
    const result = migrateProjectScriptRefs(both, {
      modules: [{ scriptRef: 'plugins/index.ts', models: ['Line1'] }], now: NOW,
    });
    expect(result.assigned.map(a => a.documentId)).toEqual(['d2']);
    expect(result.caseMismatches).toEqual([]);
  });
});

describe('§9.3 — rollback', () => {
  it('removes exactly what the migration wrote', () => {
    const before = THREE();
    const migrated = migrateProjectScriptRefs(before, { modules: DECL, now: NOW }).project;
    const rolled = rollbackScriptRefMigration(migrated);
    expect(rolled[SCRIPT_REF_MIGRATION_MARKER]).toBeUndefined();
    expect(rolled.documents!.every(d => d.scriptRef === undefined)).toBe(true);
  });

  it('leaves a scriptRef a human authored afterwards alone', () => {
    const migrated = migrateProjectScriptRefs(THREE(), { modules: DECL, now: NOW }).project;
    migrated.documents![2].scriptRef = 'scripts/authored-later.ts';
    const rolled = rollbackScriptRefMigration(migrated);
    expect(rolled.documents![2].scriptRef).toBe('scripts/authored-later.ts');
  });

  it('is a no-op on a project that was never migrated', () => {
    const before = THREE();
    expect(rollbackScriptRefMigration(before)).toBe(before);
  });
});

describe('§9.3 — the model name a path carries', () => {
  it('is the file stem without .glb, case preserved', () => {
    expect(modelNameOfDocumentPath('models/Line1.glb')).toBe('Line1');
    expect(modelNameOfDocumentPath('a/b/Werk Nord.GLB')).toBe('Werk Nord');
    expect(modelNameOfDocumentPath('scenes/x.scene.glb')).toBe('x.scene');
    expect(modelNameOfDocumentPath('')).toBe('');
  });
});
