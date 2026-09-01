// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-446 §9.3 — the "Used by" list of a `*.connect.json` row.
 *
 * ## A query, not a stored back-reference
 *
 * plan-718 gives the manifest one author and one direction: a document names its configuration
 * file. The reverse direction — which documents use THIS file — is therefore derived on every
 * render, and this suite pins that derivation at the three cardinalities the plan names (0, 1, N)
 * plus the spelling tolerances that decide whether the list agrees with the gateway.
 *
 * The pure function is the whole feature: the pane is a `map` over its result, and the chip's click
 * is a selection by the id it carries.
 */

import { describe, it, expect } from 'vitest';
import { documentsUsingRef } from '../src/core/hmi/projects/dashboard-documents';
import type { TieredDocumentEntry } from '../src/core/project/rv-project-tiers';

/** A manifest row, as thin as the reader needs it. */
function doc(
  id: string,
  path: string,
  refs: { connectRef?: string; knowledgeRef?: string } = {},
  name?: string,
): TieredDocumentEntry {
  return {
    id,
    path,
    name: name ?? '',
    tier: 'project',
    ...refs,
  } as unknown as TieredDocumentEntry;
}

const LINE1 = 'connect/linie-1.connect.json';
const LINE2 = 'connect/linie-2.connect.json';

describe('documentsUsingRef — the reverse of documents[].connectRef', () => {
  it('reports nothing when no document references the file', () => {
    const documents = [doc('d1', 'models/a.glb'), doc('d2', 'models/b.glb', { connectRef: LINE2 })];
    expect(documentsUsingRef(documents, 'connectRef', LINE1)).toEqual([]);
  });

  it('reports the single user of a 1:1 binding', () => {
    const documents = [
      doc('d1', 'models/a.glb', { connectRef: LINE1 }, 'Linie 1'),
      doc('d2', 'models/b.glb', { connectRef: LINE2 }, 'Linie 2'),
    ];
    expect(documentsUsingRef(documents, 'connectRef', LINE1)).toEqual([{ id: 'd1', name: 'Linie 1' }]);
  });

  //! The N:1 case plan-718 F1 exists for: two models sharing one CONNECT configuration. The list is
  //! the ONLY place in the viewer that makes that arrangement visible.
  it('reports every user of an N:1 binding, in manifest order', () => {
    const documents = [
      doc('d1', 'models/a.glb', { connectRef: LINE1 }, 'Linie 1'),
      doc('d2', 'models/b.glb', { connectRef: LINE2 }, 'Linie 2'),
      doc('d3', 'models/c.glb', { connectRef: LINE1 }, 'Linie 1 Variante'),
    ];
    expect(documentsUsingRef(documents, 'connectRef', LINE1)).toEqual([
      { id: 'd1', name: 'Linie 1' },
      { id: 'd3', name: 'Linie 1 Variante' },
    ]);
  });

  //! CONNECT compares these paths OrdinalIgnoreCase after normalising separators; a viewer that
  //! disagreed would show "not referenced" for a file the gateway happily binds.
  it('matches the way CONNECT does — separators, a leading ./ and case', () => {
    const documents = [
      doc('d1', 'models/a.glb', { connectRef: 'connect\\Linie-1.CONNECT.json' }),
      doc('d2', 'models/b.glb', { connectRef: './connect/linie-1.connect.json' }),
    ];
    const found = documentsUsingRef(documents, 'connectRef', LINE1).map(u => u.id);
    expect(found).toEqual(['d1', 'd2']);
  });

  it('falls back to the file name for a row without a name', () => {
    const documents = [doc('d1', 'models/cell-a.glb', { connectRef: LINE1 })];
    expect(documentsUsingRef(documents, 'connectRef', LINE1)).toEqual([
      { id: 'd1', name: 'cell-a.glb' },
    ]);
  });

  it('reads only the field it was asked for', () => {
    const documents = [
      doc('d1', 'models/a.glb', { knowledgeRef: LINE1 }),
      doc('d2', 'models/b.glb', { connectRef: LINE1 }),
    ];
    expect(documentsUsingRef(documents, 'connectRef', LINE1).map(u => u.id)).toEqual(['d2']);
    expect(documentsUsingRef(documents, 'knowledgeRef', LINE1).map(u => u.id)).toEqual(['d1']);
  });

  //! An escaping reference is not a match. `readDocumentRef` refuses anything that leaves the
  //! project, so a row pointing at `../../etc/x` can never claim to use a file inside it.
  it('ignores rows whose reference escapes the project', () => {
    const documents = [doc('d1', 'models/a.glb', { connectRef: `../${LINE1}` })];
    expect(documentsUsingRef(documents, 'connectRef', `../${LINE1}`)).toEqual([]);
  });

  it('answers empty for an absent or blank path instead of matching everything', () => {
    const documents = [doc('d1', 'models/a.glb', { connectRef: LINE1 })];
    expect(documentsUsingRef(documents, 'connectRef', null)).toEqual([]);
    expect(documentsUsingRef(documents, 'connectRef', undefined)).toEqual([]);
    expect(documentsUsingRef(documents, 'connectRef', '   ')).toEqual([]);
  });

  it('answers empty for an empty project', () => {
    expect(documentsUsingRef([], 'connectRef', LINE1)).toEqual([]);
  });
});
