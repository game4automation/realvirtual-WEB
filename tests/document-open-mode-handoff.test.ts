// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-513 §9.5 — the editor handoff with a DECIDED target mode.
 *
 * The chain has asked the exit guards for exactly one transition; the handoff
 * carries it out with no intermediate modes and no second question — except
 * the editor's own re-entry in the editor → editor case, whose refusal travels
 * back to the chain. Every load is `modeDecidedByCaller`, and the recording
 * sees the target through the open-intent scope.
 *
 * Without a target the handoff is the one `dashboard-open-into-editor.test.ts`
 * pins, unchanged.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls: string[] = [];

vi.mock('@rv-private/plugins/asset-editor/pending-open-store', () => ({
  setPendingAssetOpen: (base: { documentId: string }) => {
    calls.push(`pending:${base.documentId}`);
  },
}));
vi.mock('../src/core/editor/active-asset-store', async (original) => {
  const actual =
    await original<typeof import('../src/core/editor/active-asset-store')>();
  return {
    ...actual,
    setOpenDocumentBase: (base: { documentId: string } | null) => {
      calls.push(`identity:${base?.documentId ?? 'null'}`);
    },
  };
});

import { openDocumentAsWorkingScene } from '../src/core/hmi/projects/ProjectsDashboardHost';
import { currentOpenIntentMode } from '../src/core/project/rv-project-recents-store';
import type { TieredDocumentEntry } from '../src/core/project/rv-project-tiers';
import HOST_SOURCE from '../src/core/hmi/projects/ProjectsDashboardHost.tsx?raw';

const DOCS = [
  { id: 'doc_a', name: 'A', path: 'a.glb', section: 'library', mode: 'planner' },
] as unknown as readonly TieredDocumentEntry[];

function makeModes(active: string, reentry: boolean = true) {
  const modes = {
    activeMode: active as string | null,
    list: () => [{ id: 'viewer' }, { id: 'hmi' }, { id: 'planner' }, { id: 'editor' }],
    setMode: (id: string) => {
      calls.push(`setMode:${id}`);
      modes.activeMode = id;
    },
    requestMode: async (id: string) => {
      calls.push(`requestMode:${id}`);
      if (reentry) modes.activeMode = id;
      return reentry;
    },
  };
  return modes;
}

function makeSceneStore() {
  return {
    openScene: async (id: string, opts?: { modeDecidedByCaller?: boolean }) => {
      calls.push(`openScene:${id}:${opts?.modeDecidedByCaller ? 'decided' : 'row'}`);
      calls.push(`intent:${currentOpenIntentMode() ?? 'none'}`);
    },
  };
}

beforeEach(() => { calls.length = 0; });

describe('openDocumentAsWorkingScene with a decided target', () => {
  it('(a) editor → hmi: exactly one setMode, straight into hmi, no park, no requestMode', async () => {
    const modes = makeModes('editor');
    const ok = await openDocumentAsWorkingScene({ modes }, makeSceneStore(), DOCS, 'doc_a', undefined, 'hmi');
    expect(ok).toBe(true);
    expect(calls).toEqual([
      'setMode:hmi',
      'openScene:doc_a:decided',
      'intent:hmi',
      'identity:doc_a',
    ]);
    expect(modes.activeMode).toBe('hmi');
  });

  it('(b) hmi → editor: the pending asset is set BEFORE setMode(editor), no requestMode', async () => {
    const modes = makeModes('hmi');
    const ok = await openDocumentAsWorkingScene({ modes }, makeSceneStore(), DOCS, 'doc_a', undefined, 'editor');
    expect(ok).toBe(true);
    expect(calls).toEqual([
      'openScene:doc_a:decided',
      'intent:editor',
      'identity:doc_a',
      'pending:doc_a',
      'setMode:editor',
    ]);
    expect(calls.some(c => c.startsWith('requestMode:'))).toBe(false);
  });

  it('(c) editor → editor: the path as before — park, load, pending, requestMode with the token', async () => {
    const modes = makeModes('editor');
    const token = Symbol('lock');
    const request = vi.spyOn(modes, 'requestMode');
    const ok = await openDocumentAsWorkingScene({ modes }, makeSceneStore(), DOCS, 'doc_a', token, 'editor');
    expect(ok).toBe(true);
    expect(calls).toEqual([
      'setMode:viewer',
      'openScene:doc_a:decided',
      'intent:editor',
      'identity:doc_a',
      'pending:doc_a',
      'requestMode:editor',
    ]);
    expect(request).toHaveBeenCalledWith('editor', token);
  });

  it('(c) a refused re-entry is reported back as false', async () => {
    const modes = makeModes('editor', false);
    const ok = await openDocumentAsWorkingScene({ modes }, makeSceneStore(), DOCS, 'doc_a', Symbol('lock'), 'editor');
    expect(ok).toBe(false);
  });

  it('(d) hmi → planner: load, then setMode(planner)', async () => {
    const modes = makeModes('hmi');
    await openDocumentAsWorkingScene({ modes }, makeSceneStore(), DOCS, 'doc_a', undefined, 'planner');
    expect(calls).toEqual([
      'openScene:doc_a:decided',
      'intent:planner',
      'identity:doc_a',
      'setMode:planner',
    ]);
  });

  it('(d) the target already active: no setMode at all', async () => {
    const modes = makeModes('hmi');
    await openDocumentAsWorkingScene({ modes }, makeSceneStore(), DOCS, 'doc_a', undefined, 'hmi');
    expect(calls.filter(c => c.startsWith('setMode:'))).toEqual([]);
  });

  it('the intent scope is closed afterwards', async () => {
    await openDocumentAsWorkingScene({ modes: makeModes('hmi') }, makeSceneStore(), DOCS, 'doc_a', undefined, 'planner');
    expect(currentOpenIntentMode()).toBeNull();
  });
});

describe('openDocumentAsWorkingScene without a target — unchanged', () => {
  it('loads without the option, so the row applies its own mode as before', async () => {
    const modes = makeModes('hmi');
    const ok = await openDocumentAsWorkingScene({ modes }, makeSceneStore(), DOCS, 'doc_a');
    expect(ok).toBe(true);
    expect(calls).toEqual(['openScene:doc_a:row', 'intent:none', 'identity:doc_a']);
  });
});

// ─── The host's callers (source) ─────────────────────────────────────────
//
// The host is not renderable in a test; what can silently go wrong there is
// which path a click takes, so that is pinned over the source.


describe('the host routes every deliberate open through the chain (plan-513 F8)', () => {
  const HOST = HOST_SOURCE.replace(/\r\n/g, '\n');
  const block = (start: string) => {
    const from = HOST.indexOf(start);
    expect(from).toBeGreaterThan(0);
    return HOST.slice(from, HOST.indexOf('\n  }, [', from));
  };

  it('a card opens through openProjectDocument with the stored last mode, the dirty guard only once', () => {
    const openScene = block('const openScene = useCallback((id: string) => {');
    const chain = openScene.indexOf('openProjectDocument(');
    const fallback = openScene.indexOf('trySwitch(');
    expect(openScene).toContain('readDocumentMode(backend, projectId, id)');
    expect(chain).toBeGreaterThan(0);
    // `trySwitch` survives only as the no-project fallback, AFTER the chain's return.
    expect(fallback).toBeGreaterThan(chain);
    expect(openScene.slice(chain, fallback)).toContain('return;');
    // The already-open short-circuit still comes first.
    expect(openScene.indexOf('closeProjectsDashboard();')).toBeLessThan(chain);
  });

  it('a search hit hands the stored mode as lastMode and the index mode as display only', () => {
    const hit = block('const openModelHit = useCallback(');
    expect(hit).toContain('readDocumentMode(entry.backend, entry.projectId, entry.doc.id)');
    expect(hit).toContain('indexedDeclaredMode: entry.doc.mode');
    expect(hit).not.toContain('declaredMode: entry.doc.mode }');
  });

  it('the chain deps pass the decided target to the handoff', () => {
    expect(HOST).toContain(
      'openDocumentAsWorkingScene(viewer, sceneStore!, store.getSnapshot().documents, id, token, targetMode)');
  });
});
