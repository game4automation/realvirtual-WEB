// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Dashboard double-click → editor handoff (field findings 2026-08-18/19).
 *
 * Two defects share this seam, and each gets its pin:
 *
 *  1. **The editor must re-resolve.** The editor decides what it shows only on
 *     mode ACTIVATION (`_resolveOpenPlan`). A double-click with the editor
 *     already active used to load the new model under a standing editor — the
 *     viewport showed the clicked document while the editor's header, op log
 *     and edits still belonged to the previous one. The open therefore leaves
 *     editor mode before the load and re-enters it after the identity is
 *     published — the same leave-and-re-enter `web_editor_open` uses.
 *
 *  2. **The click is an EXPLICIT open.** Re-entering without a pending
 *     identity is a "plain mode entry" to `_resolveOpenPlan`, and a
 *     recoverable crash draft of ANOTHER document then silently opens instead
 *     of the clicked one (lingering drafts of deleted projects made this the
 *     common case, not the corner). The re-entry therefore carries the row's
 *     identity as a pending open, exactly like the catalog's "Edit asset".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const calls: string[] = [];

vi.mock('@rv-private/plugins/asset-editor/shared/pending-open-store', () => ({
  setPendingAssetOpen: (base: unknown) => {
    calls.push(`pending:${JSON.stringify(base)}`);
  },
}));
vi.mock('../src/core/editor/active-asset-store', async (original) => {
  const actual =
    await original<typeof import('../src/core/editor/active-asset-store')>();
  return {
    ...actual,
    setOpenDocumentBase: (base: unknown) => {
      calls.push(`identity:${JSON.stringify(base)}`);
    },
  };
});

import {
  dashboardAssetOpenBase,
  openDocumentAsWorkingScene,
} from '../src/core/hmi/projects/ProjectsDashboardHost';
import type { TieredDocumentEntry } from '../src/core/project/rv-project-tiers';
import { LibraryProjectLoader, setLibraryProjectLoader } from '../src/core/library/library-project-loader';
import { libraryDocumentBaseOf } from '../src/core/library/library-document-edit';
import { LIBRARY_PROJECTS_PROVIDER_ID } from '../src/core/library/library-origin';

const DOCS = [
  { id: 'doc_ddd', name: 'ddd', path: 'ddd.glb', section: 'library' },
] as unknown as readonly TieredDocumentEntry[];

function makeModes(active: string) {
  const modes = {
    activeMode: active as string | null,
    list: () => [
      { id: 'viewer' }, { id: 'hmi' }, { id: 'planner' }, { id: 'editor' },
    ],
    setMode: (id: string) => {
      calls.push(`setMode:${id}`);
      modes.activeMode = id;
    },
    requestMode: (id: string) => {
      calls.push(`requestMode:${id}`);
      modes.activeMode = id;
    },
  };
  return modes;
}

function makeSceneStore() {
  return {
    openScene: async (id: string) => {
      calls.push(`openScene:${id}`);
    },
  };
}

beforeEach(() => { calls.length = 0; });

describe('openDocumentAsWorkingScene — editor active', () => {
  it('leaves the editor BEFORE the load and re-enters AFTER the identity is published', async () => {
    await openDocumentAsWorkingScene(
      { modes: makeModes('editor') }, makeSceneStore(), DOCS, 'doc_ddd');

    expect(calls).toEqual([
      'setMode:viewer',                                     // leave first…
      'openScene:doc_ddd',                                  // …then load…
      // `sceneDocumentBase` publishes path-less on purpose — pairing compares
      // `documentId` alone, and the funnel's own write carries the path.
      'identity:{"kind":"document","documentId":"doc_ddd","path":"","name":"ddd"}',
      'pending:{"kind":"document","documentId":"doc_ddd","path":"ddd.glb","name":"ddd"}',
      'requestMode:editor',                                 // …re-enter LAST
    ]);
  });

  it('the pending identity IS the clicked row — id, name and path', async () => {
    await openDocumentAsWorkingScene(
      { modes: makeModes('editor') }, makeSceneStore(), DOCS, 'doc_ddd');

    const pending = calls.find(c => c.startsWith('pending:'));
    expect(pending).toBeDefined();
    expect(JSON.parse(pending!.slice('pending:'.length))).toEqual({
      kind: 'document', documentId: 'doc_ddd', path: 'ddd.glb', name: 'ddd',
    });
  });

  it('an id without a row still re-enters the editor, but publishes and pends nothing', async () => {
    // The funnel (`SceneStore.openDocument`) already published what it could;
    // guessing an identity here is exactly what the F1 comment forbids.
    await openDocumentAsWorkingScene(
      { modes: makeModes('editor') }, makeSceneStore(), DOCS, 'doc_unknown');

    expect(calls).toEqual([
      'setMode:viewer',
      'openScene:doc_unknown',
      'requestMode:editor',
    ]);
  });
});

describe('openDocumentAsWorkingScene — editor not active', () => {
  it('a scene-mode open touches no mode and sets no pending', async () => {
    await openDocumentAsWorkingScene(
      { modes: makeModes('planner') }, makeSceneStore(), DOCS, 'doc_ddd');

    expect(calls).toEqual([
      'openScene:doc_ddd',
      // `sceneDocumentBase` publishes path-less on purpose — pairing compares
      // `documentId` alone, and the funnel's own write carries the path.
      'identity:{"kind":"document","documentId":"doc_ddd","path":"","name":"ddd"}',
    ]);
  });
});

// ─── plan-780 2.3: a library entry opens as `libraryDocument` (scoped to B) ──

describe('dashboardAssetOpenBase — the base an asset entry opens with (plan-780 2.3)', () => {
  const LIB = { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b', assetId: 'doc_pump' };

  function readyLibrary(documents: Array<{ id: string; path: string; name?: string }>): void {
    const loader = new LibraryProjectLoader({
      factory: { folder: () => null as never, browser: () => null, remote: () => null as never },
      builtinBaseUrl: () => null,
    });
    (loader as unknown as { _nodes: Map<string, unknown> })._nodes.set('prj_b', {
      projectId: 'prj_b', label: 'SharedConveyors', direct: true, placeable: true, neededBy: [], depth: 1,
      state: { kind: 'ready', via: 'folder', backend: null, project: null, documents },
    });
    setLibraryProjectLoader(loader);
  }

  afterEach(() => setLibraryProjectLoader(null));

  it('a library entry → `libraryDocument` base naming B (never the open project\'s row)', () => {
    readyLibrary([{ id: 'doc_pump', path: 'models/pump.glb', name: 'Pump' }]);
    expect(dashboardAssetOpenBase(LIB, 'Pump', null, libraryDocumentBaseOf)).toEqual({
      kind: 'libraryDocument', libraryProjectId: 'prj_b', documentId: 'doc_pump',
      path: 'models/pump.glb', name: 'Pump', libraryLabel: 'SharedConveyors',
    });
  });

  it('a library entry B no longer lists falls back to the provider asset (no guessed row)', () => {
    readyLibrary([]);
    expect(dashboardAssetOpenBase(LIB, 'Pump', null, libraryDocumentBaseOf)).toEqual({
      kind: 'providerAsset', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b', assetId: 'doc_pump', label: 'Pump',
    });
  });

  it('the project\'s own row opens as a `document`; another provider\'s entry as `providerAsset`', () => {
    expect(dashboardAssetOpenBase({ providerId: 'project', sourceId: 'prj_a', assetId: 'doc_a' }, 'A',
      { id: 'doc_a', name: 'Alpha', path: 'models/a.glb' }, libraryDocumentBaseOf))
      .toEqual({ kind: 'document', documentId: 'doc_a', path: 'models/a.glb', name: 'Alpha' });
    expect(dashboardAssetOpenBase({ providerId: 'global', sourceId: 'cat', assetId: 'x' }, 'X', null, libraryDocumentBaseOf))
      .toEqual({ kind: 'providerAsset', providerId: 'global', sourceId: 'cat', assetId: 'x', label: 'X' });
  });
});
