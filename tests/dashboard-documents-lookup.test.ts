// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-777 §9.3 — the dashboard's detail pane resolves a path selection
 * through the one document list.
 *
 * It used to look the path up in the store's `models` view first (a place
 * filter over `documents`) and in `documentByPath` second. The view is gone
 * (P3); `documentForSelectedPath` is the one lookup, and it must keep resolving
 * the rows the view used to: a bundled manifest's URL-style `/models/x.glb`
 * selected from the tree as `models/x.glb`, and a foreign deploy's `https://`
 * row selected verbatim.
 */

import { describe, it, expect } from 'vitest';
import { documentForSelectedPath } from '../src/core/hmi/projects/projects-dashboard-store';
import type { TieredDocumentEntry } from '../src/core/project/rv-project-tiers';

const row = (path: string, name: string, tier: 'bundled' | 'user'): TieredDocumentEntry => ({
  id: `doc_${name.toLowerCase()}`, path, name, tier,
});

const DOCUMENTS: TieredDocumentEntry[] = [
  row('/models/Press.glb', 'Press', 'bundled'),
  row('library/Belt.glb', 'Belt', 'user'),
  row('https://cdn.example.com/customer/models/Robot.glb', 'Robot', 'bundled'),
];

describe('documentForSelectedPath (plan-777 F3)', () => {
  it('resolves a bundled URL-style row from the tree path without the leading slash', () => {
    const doc = documentForSelectedPath(DOCUMENTS, 'models/Press.glb');
    expect(doc?.name).toBe('Press');
    expect(doc?.tier).toBe('bundled');
  });

  it('resolves the same row when the selection carries the slash itself', () => {
    expect(documentForSelectedPath(DOCUMENTS, '/models/Press.glb')?.id).toBe('doc_press');
  });

  it('resolves an ordinary user row, with label and tier from the row', () => {
    const doc = documentForSelectedPath(DOCUMENTS, 'library/Belt.glb');
    expect(doc?.name).toBe('Belt');
    expect(doc?.tier).toBe('user');
  });

  it('resolves a foreign https:// row verbatim', () => {
    const doc = documentForSelectedPath(DOCUMENTS, 'https://cdn.example.com/customer/models/Robot.glb');
    expect(doc?.name).toBe('Robot');
  });

  it('answers undefined for a path no row has', () => {
    expect(documentForSelectedPath(DOCUMENTS, 'models/Nope.glb')).toBeUndefined();
  });
});
