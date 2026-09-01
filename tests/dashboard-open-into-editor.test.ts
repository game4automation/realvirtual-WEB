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

import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls: string[] = [];

vi.mock('@rv-private/plugins/asset-editor/pending-open-store', () => ({
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
  openDocumentAsWorkingScene,
} from '../src/core/hmi/projects/ProjectsDashboardHost';
import type { TieredDocumentEntry } from '../src/core/project/rv-project-tiers';

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
