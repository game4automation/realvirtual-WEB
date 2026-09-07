// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-462 B8 / V2 — the shared middle of the two ref migrations.
 *
 * The two adapters keep their own suites (`rv-project-refs-migration.test.ts`,
 * `connect-profile-refs.test.ts`, `migrate-project-manifest.node.test.ts`),
 * which are the golden master: unification is only allowed to be invisible to
 * them, and they are untouched by this plan. So what is pinned HERE is the core
 * itself — the three rules it owns, and the two axes it is parameterised on.
 *
 * The case axis is the interesting one, because the two callers sit on opposite
 * ends of it on purpose: the scriptRef matcher is case-sensitive at runtime and
 * therefore only REPORTS a near miss, while CONNECT's legacy comparison was
 * case-insensitive and therefore BINDS it. A core that quietly picked one would
 * change a customer's manifest.
 */

import { describe, it, expect } from 'vitest';
import {
  applyRefMigration,
  planRefMigration,
  rollbackRefMigration,
  type RefMigrationBinding,
} from '../src/core/project/rv-project-ref-migration-core';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

function row(id: string, path: string, extra: Record<string, unknown> = {}): RvDocumentEntry {
  return { id, path, name: path.split('/').pop() ?? path, ...extra } as unknown as RvDocumentEntry;
}

function project(documents: RvDocumentEntry[]): RvProject {
  return { schemaVersion: 2, id: 'p', name: 'P', documents } as unknown as RvProject;
}

/** The scriptRef side: the document is reduced to its file stem, the key is not. */
const stem = (path: string): string =>
  (path.split('?')[0].split('/').filter(Boolean).pop() ?? '').replace(/\.glb$/i, '');

/** The CONNECT side: leaf name, `.glb` stripped, lowercased. */
const lowerStem = (value: string): string => stem(value).toLowerCase();

const bind = (key: string, ref: string): RefMigrationBinding => ({ key, ref });

describe('planRefMigration — the three rules the core owns', () => {
  it('binds a declaration to the row whose path yields the same name', () => {
    const docs = [row('d1', 'models/Linie1.glb'), row('d2', 'models/Linie2.glb')];

    const plan = planRefMigration(docs, [bind('Linie2', 'scripts/a.js')], {
      field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report',
    });

    expect(plan.assigned).toHaveLength(1);
    expect(plan.assigned[0].documentId).toBe('d2');
    expect(plan.unmatched).toEqual([]);
  });

  it('first row wins when two documents yield the same name', () => {
    // Ambiguous under a name-based comparison — and a name-based comparison is
    // the only thing that could ever have bound them.
    const docs = [row('first', 'a/Linie.glb'), row('second', 'b/Linie.glb')];

    const plan = planRefMigration(docs, [bind('Linie', 'scripts/a.js')], {
      field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report',
    });

    expect(plan.assigned[0].documentId).toBe('first');
  });

  it('never overwrites a reference that is already authored', () => {
    const docs = [row('d1', 'models/Linie.glb', { scriptRef: 'scripts/authored.js' })];

    const plan = planRefMigration(docs, [bind('Linie', 'scripts/new.js')], {
      field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report',
    });

    expect(plan.assigned).toEqual([]);
    // Not "unmatched" either: the row WAS found, it simply had an answer.
    expect(plan.unmatched).toEqual([]);
  });

  it('an empty-string reference is not an authored one', () => {
    const docs = [row('d1', 'models/Linie.glb', { scriptRef: '   ' })];

    const plan = planRefMigration(docs, [bind('Linie', 'scripts/new.js')], {
      field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report',
    });

    expect(plan.assigned).toHaveLength(1);
  });

  it('gives one document at most one reference per run', () => {
    const docs = [row('d1', 'models/Linie.glb')];

    const plan = planRefMigration(
      docs, [bind('Linie', 'scripts/first.js'), bind('Linie', 'scripts/second.js')],
      { field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report' });

    expect(plan.assigned).toHaveLength(1);
    expect(plan.assigned[0].binding.ref).toBe('scripts/first.js');
  });

  it('ignores rows with no path, and rows whose path yields no name', () => {
    const docs = [row('d0', ''), row('d1', 'models/.glb'), row('d2', 'models/Linie.glb')];

    const plan = planRefMigration(docs, [bind('Linie', 'scripts/a.js')], {
      field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report',
    });

    expect(plan.assigned).toHaveLength(1);
    expect(plan.assigned[0].documentId).toBe('d2');
  });
});

describe('planRefMigration — the case axis, both ends of it', () => {
  const docs = [row('d1', 'models/Linie1.glb')];

  it("'report' does not bind a near miss — it hands it back", () => {
    const plan = planRefMigration(docs, [bind('linie1', 'scripts/a.js')], {
      field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report',
    });

    expect(plan.assigned).toEqual([]);
    expect(plan.caseMismatches).toHaveLength(1);
    expect(plan.caseMismatches[0].documentId).toBe('d1');
    expect(plan.caseMismatches[0].documentPath).toBe('models/Linie1.glb');
    // Reported, not unmatched: the caller wants to warn about it by name.
    expect(plan.unmatched).toEqual([]);
  });

  it("'bind' treats the case-insensitive key as the match, with nothing to report", () => {
    const plan = planRefMigration(docs, [bind('models/LINIE1.glb', 'connect/a.connect.json')], {
      field: 'connectRef', documentKey: lowerStem, bindingKey: lowerStem, caseMismatch: 'bind',
    });

    expect(plan.assigned).toHaveLength(1);
    expect(plan.assigned[0].documentId).toBe('d1');
    expect(plan.caseMismatches).toEqual([]);
  });

  it("'report' still records a true miss as unmatched, not as a case mismatch", () => {
    const plan = planRefMigration(docs, [bind('Nowhere', 'scripts/a.js')], {
      field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report',
    });

    expect(plan.caseMismatches).toEqual([]);
    expect(plan.unmatched.map(b => b.key)).toEqual(['Nowhere']);
  });

  it('a binding rejected by isBindable is unmatched and never reaches the index', () => {
    const plan = planRefMigration(docs, [bind('Linie1', '../outside.json')], {
      field: 'connectRef',
      documentKey: lowerStem,
      bindingKey: lowerStem,
      caseMismatch: 'bind',
      isBindable: b => !b.ref.startsWith('..'),
    });

    expect(plan.assigned).toEqual([]);
    expect(plan.unmatched.map(b => b.key)).toEqual(['Linie1']);
  });
});

describe('applyRefMigration', () => {
  it('writes the field on exactly the planned rows and stamps the marker', () => {
    const before = project([row('d1', 'models/A.glb'), row('d2', 'models/B.glb')]);
    const plan = planRefMigration(before.documents!, [bind('A', 'scripts/a.js')], {
      field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report',
    });

    const after = applyRefMigration(before, plan, {
      field: 'scriptRef', markerKey: 'rv-project/test-marker', marker: { at: 'now', assigned: 1 },
    });

    expect(after.documents![0]).toMatchObject({ id: 'd1', scriptRef: 'scripts/a.js' });
    expect(after.documents![1]).not.toHaveProperty('scriptRef');
    expect(after['rv-project/test-marker']).toEqual({ at: 'now', assigned: 1 });
    // Pure: the caller hands the result to `updateManifestCas`, so the input
    // must still be exactly what it was.
    expect(before.documents![0]).not.toHaveProperty('scriptRef');
    expect(before).not.toHaveProperty('rv-project/test-marker');
  });
});

describe('rollbackRefMigration', () => {
  it('removes the marker and the refs on the rows the marker names', () => {
    const migrated = {
      ...project([
        row('d1', 'models/A.glb', { scriptRef: 'scripts/a.js' }),
        row('d2', 'models/B.glb', { scriptRef: 'scripts/human.js' }),
      ]),
      'rv-project/test-marker': { at: 'now', assignedIds: ['d1'] },
    } as unknown as RvProject;

    const back = rollbackRefMigration(migrated, {
      field: 'scriptRef', markerKey: 'rv-project/test-marker', assignedIds: ['d1'],
    });

    expect(back.documents![0]).not.toHaveProperty('scriptRef');
    // A reference a human authored afterwards is not this module's to remove.
    expect(back.documents![1]).toMatchObject({ scriptRef: 'scripts/human.js' });
    expect(back).not.toHaveProperty('rv-project/test-marker');
  });

  it('round-trips a plan: apply then roll back is the manifest it started from', () => {
    const before = project([row('d1', 'models/A.glb'), row('d2', 'models/B.glb')]);
    const plan = planRefMigration(before.documents!, [bind('A', 'scripts/a.js')], {
      field: 'scriptRef', documentKey: stem, bindingKey: k => k, caseMismatch: 'report',
    });
    const marker = { at: 'now', assignedIds: plan.assigned.map(a => a.documentId) };

    const after = applyRefMigration(before, plan, {
      field: 'scriptRef', markerKey: 'rv-project/test-marker', marker,
    });
    const back = rollbackRefMigration(after, {
      field: 'scriptRef', markerKey: 'rv-project/test-marker', assignedIds: marker.assignedIds,
    });

    expect(back).toEqual(before);
  });
});
