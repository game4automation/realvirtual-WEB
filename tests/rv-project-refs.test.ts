// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.1 — the reference model (plan-718 §2.1/§2.3).
 *
 * Four properties, and they are the whole feature:
 *
 *  1. the three fields are ADDITIVE — an old manifest is a valid new one;
 *  2. **N:1** needs no modelling: two rows with the same value share the file,
 *     and the reverse direction is a scan, so it cannot go stale;
 *  3. a reference survives a RENAME, because it hangs on a row whose id is
 *     frozen, not on a file name;
 *  4. a reference cannot LEAVE the project — strict containment, the property
 *     "copy the folder and it still works" rests on.
 *
 * The manifest under test is `tests/fixtures/project-refs-vectors.json`, the
 * fixture §9.7 shares with the CONNECT xUnit side, so a schema drift between the
 * TypeScript reader and the C# one fails here rather than in a customer project.
 */

import { describe, it, expect } from 'vitest';
import vectors from './fixtures/project-refs-vectors.json';
import {
  DEFAULT_SECRETS_REF,
  DOCUMENT_REF_FIELDS,
  RefContainmentError,
  assertContainedRef,
  documentForModelUrl,
  documentRefsOf,
  documentsWithRef,
  isContainedRef,
  normalizeRefPath,
  projectConnectRefs,
  readDocumentRef,
  repointDocumentRefs,
  scriptRefForModelUrl,
  setDocumentRefOn,
  type DocumentRefField,
} from '../src/core/project/rv-project-refs';
import { moveDocumentPath } from '../src/core/project/rv-asset-identity';
import type { RvProject } from '../src/core/project/rv-project-types';

const FIXTURE = vectors.manifest as unknown as RvProject;
const EXPECT = vectors.expect;

/** A fresh copy per test — nothing here may mutate the shared fixture. */
function fixture(): RvProject {
  return JSON.parse(JSON.stringify(FIXTURE)) as RvProject;
}

describe('§9.1 — the fields', () => {
  it('reads all three, normalised', () => {
    const doc = fixture().documents!.find(d => d.id === 'ast_m8x')!;
    expect(readDocumentRef(doc, 'connectRef')).toBe('connect/linie-1.connect.json');
    expect(readDocumentRef(doc, 'scriptRef')).toBe('scripts/linie1/index.ts');
    expect(readDocumentRef(doc, 'knowledgeRef')).toBe('knowledge/linie-1.json');
  });

  it('an absent field is not an error — it is "no binding"', () => {
    const doc = fixture().documents!.find(d => d.id === 'ast_c07')!;
    expect(readDocumentRef(doc, 'connectRef')).toBeNull();
    expect(readDocumentRef(doc, 'knowledgeRef')).toBeNull();
    expect(readDocumentRef(doc, 'scriptRef')).toBe('scripts/conveyor.ts');
  });

  it('normalises separators and a leading ./ so N:1 is a string comparison', () => {
    expect(normalizeRefPath('.\\connect\\a.json')).toBe('connect/a.json');
    expect(normalizeRefPath('./connect/a.json')).toBe('connect/a.json');
    expect(normalizeRefPath('connect/a.json/')).toBe('connect/a.json');
  });

  it('lists every reference the manifest sets, escapes excluded', () => {
    const refs = documentRefsOf(fixture());
    // 3 on ast_m8x + 2 on ast_p4q + 1 on ast_c07 + 1 on ast_z12; the escaping
    // one on ast_esc reads as null and is therefore not listed.
    expect(refs).toHaveLength(7);
    expect(refs.some(r => r.documentId === 'ast_esc')).toBe(false);
    expect(DOCUMENT_REF_FIELDS).toEqual(['connectRef', 'scriptRef', 'knowledgeRef']);
  });

  it('project-wide connect refs, with the sidecar default filled in', () => {
    const project = fixture();
    expect(projectConnectRefs(project).agentsRef).toBe(EXPECT.agentsRef);
    expect(projectConnectRefs(project).secretsRef).toBe(EXPECT.secretsRef);
    // The RAG bundle is a reference like the others — no `rag/` folder, and no
    // default when the project ships none (stage 3.3).
    expect(projectConnectRefs(project).ragRef).toBe(EXPECT.ragRef);
    expect(projectConnectRefs({ ...project, connect: { ragRef: '../outside/rag.zip' } }).ragRef)
      .toBeNull();
    // A project that says nothing still gets the default — a default, not a scan.
    expect(projectConnectRefs({ ...project, connect: undefined }).secretsRef)
      .toBe(DEFAULT_SECRETS_REF);
    expect(projectConnectRefs({ ...project, connect: undefined }).ragRef).toBeNull();
    expect(projectConnectRefs(null).agentsRef).toBeNull();
  });
});

describe('§9.1 — N:1', () => {
  it('two documents share one connect file', () => {
    const hits = documentsWithRef(fixture(), 'connectRef', EXPECT.connectRefN1.ref);
    expect(hits.map(d => d.id)).toEqual(EXPECT.connectRefN1.documentIds);
  });

  it('two documents share one script', () => {
    const hits = documentsWithRef(fixture(), 'scriptRef', EXPECT.scriptRefN1.ref);
    expect(hits.map(d => d.id)).toEqual(EXPECT.scriptRefN1.documentIds);
  });

  it('the reverse direction is a scan — there is nothing to keep in sync', () => {
    // Clearing one row's reference removes it from the set, with no second
    // structure to update. That IS the property.
    const after = setDocumentRefOn(fixture(), 'ast_p4q', 'connectRef', null);
    expect(documentsWithRef(after, 'connectRef', EXPECT.connectRefN1.ref).map(d => d.id))
      .toEqual(['ast_m8x']);
  });

  it('a reference nobody uses has an empty set, not an error', () => {
    expect(documentsWithRef(fixture(), 'connectRef', 'connect/nobody.json')).toEqual([]);
    expect(documentsWithRef(fixture(), 'connectRef', '')).toEqual([]);
  });
});

describe('§9.1 — a rename cannot break a binding', () => {
  it('the reference survives the GLB being renamed', () => {
    const before = fixture();
    const renamed = moveDocumentPath(before, 'ast_m8x', 'models/Werk Nord Linie 1.glb');
    const row = renamed.documents!.find(d => d.id === 'ast_m8x')!;
    expect(row.path).toBe('models/Werk Nord Linie 1.glb');
    expect(readDocumentRef(row, 'scriptRef')).toBe('scripts/linie1/index.ts');
    expect(readDocumentRef(row, 'connectRef')).toBe('connect/linie-1.connect.json');
  });

  it('resolves a loading model URL back to its row and its script', () => {
    const project = fixture();
    expect(scriptRefForModelUrl(project, '/projects/x/models/linie1.glb?v=3'))
      .toBe('scripts/linie1/index.ts');
    // The longer path wins where both would match on the tail.
    expect(documentForModelUrl(project, 'https://host/a/models/linie1-detail.glb')?.id)
      .toBe('ast_p4q');
    // A model that is not a document of this project binds nothing.
    expect(scriptRefForModelUrl(project, '/demo/bundled.glb')).toBeNull();
    expect(scriptRefForModelUrl(null, '/models/linie1.glb')).toBeNull();
  });
});

describe('§9.1 — containment is strict', () => {
  const escapes = [
    '../outside.json',
    'connect/../../outside.json',
    '/etc/passwd',
    'C:/secrets/x.json',
    '\\\\server\\share\\x.json',
    'https://example.com/x.json',
    '',
    '   ',
  ];

  it('rejects every way out of the project', () => {
    for (const ref of escapes) expect(isContainedRef(ref)).toBe(false);
  });

  it('accepts an ordinary relative path, including a .. INSIDE a segment', () => {
    expect(isContainedRef('connect/linie-1.connect.json')).toBe(true);
    expect(isContainedRef('models/v..2/a.glb')).toBe(true);
  });

  it('assertContainedRef refuses with a named error', () => {
    expect(() => assertContainedRef('../out.json', 'connectRef'))
      .toThrow(RefContainmentError);
    expect(assertContainedRef('.\\connect\\a.json')).toBe('connect/a.json');
  });

  it('an escaping reference already in a manifest reads as null, never throws', () => {
    const doc = fixture().documents!.find(d => d.id === 'ast_esc')!;
    expect(doc.connectRef).toBe(EXPECT.rejectedRefs[0].ref); // it IS in the file …
    expect(readDocumentRef(doc, 'connectRef')).toBeNull();   // … and it binds nothing
  });

  it('refuses to WRITE one', () => {
    expect(() => setDocumentRefOn(fixture(), 'ast_c07', 'connectRef', '../out.json'))
      .toThrow(RefContainmentError);
  });
});

describe('§9.1 — setting and clearing', () => {
  it('sets a reference on a row and touches nothing else', () => {
    const before = fixture();
    const after = setDocumentRefOn(before, 'ast_z12', 'connectRef', './connect/versand.json');
    expect(after.documents!.find(d => d.id === 'ast_z12')!.connectRef)
      .toBe('connect/versand.json');
    expect(after.documents!.find(d => d.id === 'ast_m8x'))
      .toEqual(before.documents!.find(d => d.id === 'ast_m8x'));
    expect(before.documents!.find(d => d.id === 'ast_z12')!.connectRef).toBeUndefined();
  });

  it('clearing removes the key rather than writing null', () => {
    const after = setDocumentRefOn(fixture(), 'ast_m8x', 'knowledgeRef', null);
    expect('knowledgeRef' in after.documents!.find(d => d.id === 'ast_m8x')!).toBe(false);
  });

  it('returns the SAME object when nothing changes', () => {
    const before = fixture();
    expect(setDocumentRefOn(before, 'ast_c07', 'scriptRef', 'scripts/conveyor.ts')).toBe(before);
    expect(setDocumentRefOn(before, 'ast_c07', 'connectRef', null)).toBe(before);
  });

  it('refuses an unknown document id', () => {
    expect(() => setDocumentRefOn(fixture(), 'nope', 'scriptRef', 'scripts/a.ts'))
      .toThrow(/no document with id/);
  });
});

describe('§9.1 — the backward repoint', () => {
  it('repoints every row that named the moved file (N:1 included)', () => {
    const { project, rewritten } = repointDocumentRefs(fixture(), [
      { from: 'connect/linie-1.connect.json', to: 'connect/lines/linie-1.connect.json' },
    ]);
    expect(rewritten).toBe(2);
    for (const id of EXPECT.connectRefN1.documentIds) {
      expect(project.documents!.find(d => d.id === id)!.connectRef)
        .toBe('connect/lines/linie-1.connect.json');
    }
  });

  it('follows a moved FOLDER, on a segment boundary', () => {
    const { project, rewritten } = repointDocumentRefs(fixture(), [
      { from: 'scripts', to: 'code' },
    ]);
    expect(rewritten).toBe(3); // two rows on linie1/index.ts, one on conveyor.ts
    expect(project.documents!.find(d => d.id === 'ast_c07')!.scriptRef)
      .toBe('code/conveyor.ts');
  });

  it('never captures a sibling that merely shares a prefix', () => {
    const withSibling = fixture();
    withSibling.documents!.push({
      id: 'ast_sib', path: 'models/sib.glb', name: 'Sibling',
      scriptRef: 'scripts/linie10/index.ts',
    });
    const { project } = repointDocumentRefs(withSibling, [
      { from: 'scripts/linie1', to: 'scripts/archive/linie1' },
    ]);
    expect(project.documents!.find(d => d.id === 'ast_sib')!.scriptRef)
      .toBe('scripts/linie10/index.ts');
  });

  it('returns the same object when nothing pointed at anything moved', () => {
    const before = fixture();
    expect(repointDocumentRefs(before, [{ from: 'models/other.glb', to: 'a/other.glb' }]).project)
      .toBe(before);
    expect(repointDocumentRefs(before, []).rewritten).toBe(0);
    // A no-op move (from === to) is filtered out, not counted.
    expect(repointDocumentRefs(before, [{ from: 'scripts', to: 'scripts' }]).rewritten).toBe(0);
  });

  it('leaves an escaping reference alone — it binds nothing to begin with', () => {
    const { project } = repointDocumentRefs(fixture(), [
      { from: '../outside/steal.connect.json', to: 'connect/steal.json' },
    ]);
    expect(project.documents!.find(d => d.id === 'ast_esc')!.connectRef)
      .toBe(EXPECT.rejectedRefs[0].ref);
  });
});

describe('§9.7 — the shared fixture says what both languages must agree on', () => {
  it('names its dead reference and its escape attempt explicitly', () => {
    const dead = EXPECT.deadRefs[0];
    const doc = fixture().documents!.find(d => d.id === dead.documentId)!;
    expect(readDocumentRef(doc, dead.field as DocumentRefField)).toBe(dead.ref);
    // "Dead" is about the file system, not the manifest: the reference is
    // perfectly well-formed, its target is simply not in `presentFiles`.
    expect(EXPECT.presentFiles).not.toContain(dead.ref);
    expect(EXPECT.presentFiles.every(f => isContainedRef(f))).toBe(true);
  });
});
