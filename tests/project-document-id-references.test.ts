// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Contract documents-projects 4: a reference into a document hangs off its id.
 * The open project's catalog entries are keyed by the manifest id, a placement
 * is SAVED with that id, and the legacy `project:<path>` form old files carry
 * still resolves — read, never written.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { indexProjectEntries } from '../src/core/library/project-library-entries';
import { registerLibrarySourceProvider, resetLibrarySourceRegistryForTests, type LibrarySource } from '../src/core/library/library-source-registry';
import { documentIdForWrite, isProjectDocumentId } from '../src/core/library/rv-placement-source';
import { placementExtras } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { RV_ASSET_REFERENCE_KEY } from '../src/core/engine/rv-asset-reference';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';

const ROWS = [
  { id: 'doc_belt', path: 'models/belt.glb', name: 'Belt' },
  { path: 'models/no-row-id.glb', name: 'Loose' },
] as unknown as RvDocumentEntry[];

function installOpenProject(): void {
  const index = indexProjectEntries(ROWS, { writable: true }, { keyBy: 'path' });
  const source: LibrarySource = {
    id: 'proj-1', label: 'Plant', kind: 'project', writable: true, loaded: true,
    listEntries: () => index.entries,
    getEntry: (id) => index.byId.get(id) ?? null,
    resolveAsset: async () => ({ url: 'blob:x' }),
  };
  registerLibrarySourceProvider({ id: 'project', listSources: () => [source], subscribe: () => () => {} });
}

afterEach(() => resetLibrarySourceRegistryForTests());

describe('open-project documents are addressed by id', () => {
  it('the catalog entry id IS the manifest id; the path form is only a legacy key (and the key of a row without id)', () => {
    const index = indexProjectEntries(ROWS, { writable: true }, { keyBy: 'path' });
    expect(index.entries.map((e) => e.id)).toEqual(['doc_belt', 'project:models/no-row-id.glb']);
    expect(index.byId.get('doc_belt')?.localPath).toBe('models/belt.glb');
    expect(index.byId.get('project:models/belt.glb')?.id).toBe('doc_belt');   // an old file still resolves
  });

  it('isProjectDocumentId answers for the id and for the legacy path form, not for a foreign id', () => {
    installOpenProject();
    expect(isProjectDocumentId('doc_belt')).toBe(true);
    expect(isProjectDocumentId('project:models/belt.glb')).toBe(true);
    expect(isProjectDocumentId('realvirtual-conveyor-glb')).toBe(false);
  });

  it('a save writes the id — also for a placement that still carries the legacy path form', () => {
    installOpenProject();
    expect(documentIdForWrite('project:models/belt.glb')).toBe('doc_belt');
    expect(documentIdForWrite('doc_belt')).toBe('doc_belt');
    const place = (catalogId: string) => placementExtras({
      id: 'p1', catalogId, label: 'Belt', glbUrl: '', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    } as unknown as PlacedComponent)[RV_ASSET_REFERENCE_KEY] as { assetId: string };
    expect(place('project:models/belt.glb').assetId).toBe('doc_belt');
    expect(place('doc_belt').assetId).toBe('doc_belt');
  });
});
