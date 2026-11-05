// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  nextDocumentSelection,
  selectedDocumentIds,
  selectionOfDocumentIds,
} from '../src/core/hmi/projects/document-multi-select';
import type { ProjectsSelection } from '../src/core/hmi/projects/projects-dashboard-store';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const PLAIN = { toggle: false, range: false };
const CTRL = { toggle: true, range: false };
const SHIFT = { toggle: false, range: true };
const CTRL_SHIFT = { toggle: true, range: true };
const one = (id: string): ProjectsSelection => ({ kind: 'document', documentId: id });

describe('document multi-select', () => {
  it('a plain click selects only that document and anchors there', () => {
    const current: ProjectsSelection = { kind: 'documents', documentIds: ['a', 'b'] };
    expect(nextDocumentSelection(current, 'a', 'd', PLAIN, ORDER))
      .toEqual({ selection: one('d'), anchorId: 'd' });
  });

  it('Ctrl adds and removes, and collapses to a single or no selection', () => {
    let r = nextDocumentSelection(one('a'), 'a', 'c', CTRL, ORDER);
    expect(r.selection).toEqual({ kind: 'documents', documentIds: ['a', 'c'] });
    r = nextDocumentSelection(r.selection, r.anchorId, 'a', CTRL, ORDER);
    expect(r.selection).toEqual(one('c'));
    r = nextDocumentSelection(r.selection, r.anchorId, 'c', CTRL, ORDER);
    expect(r.selection).toEqual({ kind: 'none' });
  });

  it('Ctrl from a non-document selection starts a fresh document set', () => {
    const folder: ProjectsSelection = { kind: 'folder', rootId: 'r', relPath: 'x' };
    expect(nextDocumentSelection(folder, null, 'b', CTRL, ORDER).selection).toEqual(one('b'));
  });

  it('Shift selects the visible range from the anchor, in both directions, and keeps the anchor', () => {
    expect(nextDocumentSelection(one('b'), 'b', 'd', SHIFT, ORDER))
      .toEqual({ selection: { kind: 'documents', documentIds: ['b', 'c', 'd'] }, anchorId: 'b' });
    expect(nextDocumentSelection(one('d'), 'd', 'a', SHIFT, ORDER).selection)
      .toEqual({ kind: 'documents', documentIds: ['a', 'b', 'c', 'd'] });
  });

  it('Shift replaces the selection, Ctrl+Shift adds the range to it', () => {
    const current: ProjectsSelection = { kind: 'documents', documentIds: ['e', 'a'] };
    expect(nextDocumentSelection(current, 'a', 'b', SHIFT, ORDER).selection)
      .toEqual({ kind: 'documents', documentIds: ['a', 'b'] });
    expect(nextDocumentSelection(current, 'b', 'c', CTRL_SHIFT, ORDER).selection)
      .toEqual({ kind: 'documents', documentIds: ['e', 'a', 'b', 'c'] });
  });

  it('Shift without a visible anchor selects only the clicked document', () => {
    expect(nextDocumentSelection(one('x'), 'x', 'c', SHIFT, ORDER))
      .toEqual({ selection: one('c'), anchorId: 'c' });
    expect(nextDocumentSelection({ kind: 'none' }, null, 'c', SHIFT, ORDER).selection).toEqual(one('c'));
  });

  it('ids round-trip and duplicates collapse', () => {
    expect(selectedDocumentIds({ kind: 'documents', documentIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(selectedDocumentIds({ kind: 'project', projectId: 'p' })).toEqual([]);
    expect(selectionOfDocumentIds(['a', 'a'])).toEqual(one('a'));
  });
});
