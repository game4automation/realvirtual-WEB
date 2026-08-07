// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-two-tier.test — plan-372 §9.2.
 *
 * The two levels of a project (§2.3) and the four properties that make the
 * design worth having over a one-off seeding:
 *
 *  1. both tiers show up in one list, each entry knowing its `tier`;
 *  2. a bundled entry is read-only, and the first edit forks it, recording
 *     `forkedFrom`;
 *  3. **swapping the entire bundled tier leaves every user key untouched** —
 *     this is the release-upgrade case, and the reason seeding was rejected;
 *  4. `hidden` removes an entry from view without deleting anything, and
 *     `getProjectSceneIds()` is the union of both tiers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import {
  clearAllScenes,
  setDraftScope,
} from '../src/core/hmi/scene/rv-scene-storage';
import {
  forkSceneEntry,
  hiddenIdsOf,
  isReadOnlyEntry,
  mergeAssetTiers,
  mergeSceneTiers,
  withHidden,
  withoutHidden,
} from '../src/core/project/rv-project-tiers';
import type { RvProject, RvProjectSceneEntry } from '../src/core/project/rv-project-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

const entry = (id: string, name: string, extra: Partial<RvProjectSceneEntry> = {}): RvProjectSceneEntry => ({
  id,
  name,
  path: `scenes/${id}.scene.json`,
  ...extra,
});

const project = (over: Partial<RvProject> = {}): RvProject => ({
  schemaVersion: 1,
  id: 'prj_sample',
  name: 'Sample',
  ...over,
});

function noFetch(): typeof fetch {
  return (async () => ({ ok: false, status: 404, json: async () => null } as unknown as Response)) as typeof fetch;
}

// ─── Merge ──────────────────────────────────────────────────────────────

describe('mergeSceneTiers', () => {
  it('shows both tiers in one list, each tagged', () => {
    const { entries } = mergeSceneTiers([entry('b1', 'Demo')], [entry('u1', 'Mine')]);
    expect(entries.map(e => [e.id, e.tier])).toEqual([['b1', 'bundled'], ['u1', 'user']]);
  });

  it('marks bundled entries read-only and user entries writable', () => {
    const { entries } = mergeSceneTiers([entry('b1', 'Demo')], [entry('u1', 'Mine')]);
    expect(isReadOnlyEntry(entries[0]!)).toBe(true);
    expect(isReadOnlyEntry(entries[1]!)).toBe(false);
  });

  it('a fork shadows its original and keeps the original slot in the order', () => {
    const bundled = [entry('b1', 'One'), entry('b2', 'Two')];
    const fork = forkSceneEntry(bundled[0]!, 'u_fork', { name: 'One (edited)' });
    const { entries } = mergeSceneTiers(bundled, [fork]);
    expect(entries.map(e => e.id)).toEqual(['u_fork', 'b2']);
    expect(entries[0]!.tier).toBe('user');
    expect(entries[0]!.forkedFrom).toBe('b1');
    expect(entries[0]!.name).toBe('One (edited)');
  });

  it('a user entry with the same id shadows the bundled one too', () => {
    const { entries } = mergeSceneTiers([entry('b1', 'Demo')], [entry('b1', 'Demo saved')]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tier).toBe('user');
    expect(entries[0]!.name).toBe('Demo saved');
  });

  it('the union of ids covers both tiers, fork and original alike', () => {
    const bundled = [entry('b1', 'One')];
    const { ids } = mergeSceneTiers(bundled, [forkSceneEntry(bundled[0]!, 'u_fork')]);
    expect([...ids].sort()).toEqual(['b1', 'u_fork']);
  });

  it('hidden removes an entry from the list without deleting the source', () => {
    const bundled = [entry('b1', 'One'), entry('b2', 'Two')];
    const { entries, ids } = mergeSceneTiers(bundled, [], ['b1']);
    expect(entries.map(e => e.id)).toEqual(['b2']);
    expect(ids.has('b1')).toBe(false);
    // The source list is untouched — hiding is a view decision, not a delete.
    expect(bundled.map(e => e.id)).toEqual(['b1', 'b2']);
  });

  it('hiding a fork hides the fork, not the original', () => {
    const bundled = [entry('b1', 'One')];
    const fork = forkSceneEntry(bundled[0]!, 'u_fork');
    const { entries } = mergeSceneTiers(bundled, [fork], ['u_fork']);
    expect(entries).toHaveLength(0);
    // …and deleting the fork outright brings the original back.
    expect(mergeSceneTiers(bundled, []).entries.map(e => e.id)).toEqual(['b1']);
  });

  it('replacing the whole bundled tier leaves the user tier untouched', () => {
    const user = [entry('u1', 'Mine')];
    const release1 = mergeSceneTiers([entry('b1', 'Demo v1')], user);
    const release2 = mergeSceneTiers([entry('b9', 'Demo v2')], user);
    expect(release1.entries.map(e => e.id)).toEqual(['b1', 'u1']);
    expect(release2.entries.map(e => e.id)).toEqual(['b9', 'u1']);
    // Same object, never rewritten by the merge.
    expect(user).toEqual([entry('u1', 'Mine')]);
  });

  it('ignores entries with no id rather than emitting a nameless row', () => {
    const { entries } = mergeSceneTiers([entry('', 'ghost')], []);
    expect(entries).toEqual([]);
  });
});

describe('mergeAssetTiers', () => {
  it('keys on path instead of id', () => {
    const { entries } = mergeAssetTiers(
      [{ path: 'models/A.glb', label: 'A' }],
      [{ path: 'models/A.glb', label: 'A (mine)' }],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tier).toBe('user');
    expect(entries[0]!.label).toBe('A (mine)');
  });
});

// ─── Fork ───────────────────────────────────────────────────────────────

describe('forkSceneEntry', () => {
  it('mints a new id and records the origin', () => {
    const fork = forkSceneEntry(entry('b1', 'Demo'), 'u_new');
    expect(fork.id).toBe('u_new');
    expect(fork.forkedFrom).toBe('b1');
    expect(fork.tier).toBe('user');
  });

  it('leaves the original resolvable — that is why the id is not reused', () => {
    const original = entry('b1', 'Demo');
    forkSceneEntry(original, 'u_new');
    expect(original.id).toBe('b1');
    expect(original).not.toHaveProperty('tier');
  });
});

// ─── Hidden list ────────────────────────────────────────────────────────

describe('hidden list', () => {
  it('adds, removes and is idempotent in both directions', () => {
    const p0 = project();
    const p1 = withHidden(p0, 'b1');
    expect(hiddenIdsOf(p1)).toEqual(['b1']);
    expect(withHidden(p1, 'b1')).toBe(p1);
    const p2 = withoutHidden(p1, 'b1');
    expect(hiddenIdsOf(p2)).toEqual([]);
    expect(withoutHidden(p2, 'b1')).toBe(p2);
  });

  it('never mutates the project it was given', () => {
    const p0 = project();
    withHidden(p0, 'b1');
    expect(p0.hidden).toBeUndefined();
  });

  it('tolerates a malformed hidden section instead of throwing', () => {
    expect(hiddenIdsOf(project({ hidden: 'nope' } as unknown as Partial<RvProject>))).toEqual([]);
    expect(hiddenIdsOf(project({ hidden: ['a', 42, ''] } as unknown as Partial<RvProject>))).toEqual(['a']);
    expect(hiddenIdsOf(null)).toEqual([]);
  });
});

// ─── Through the store ──────────────────────────────────────────────────

describe('ProjectStore two-tier snapshot', () => {
  let store: ProjectStore;

  beforeEach(() => {
    clearSceneMutationListeners();
    clearAllScenes();
    setDraftScope(null);
    localStorage.removeItem('rv-project/last');
    resetProjectStore();
    store = new ProjectStore();
  });

  afterEach(async () => {
    await store.closeProject();
    clearSceneMutationListeners();
    clearAllScenes();
    setDraftScope(null);
  });

  it('exposes the bundled tier of the Sample project as tier bundled', async () => {
    const bundled = new BundledBackend({
      fetchImpl: noFetch(),
      publishedScenes: [{ file: 'A.scene.json', urlName: 'A', label: 'Demo A' }],
    });
    await store.resolveActiveProject({ bundledBackend: bundled });
    await store.hydrateProjectScenes();

    const scenes = store.getProjectScenes();
    expect(scenes.map(e => [e.name, e.tier])).toEqual([['Demo A', 'bundled']]);
    expect(store.getProjectSceneIds().has('published:A')).toBe(true);
  });

  it('returns the SAME Set instance until something changes', async () => {
    const bundled = new BundledBackend({
      fetchImpl: noFetch(),
      publishedScenes: [{ file: 'A.scene.json', urlName: 'A', label: 'Demo A' }],
    });
    await store.resolveActiveProject({ bundledBackend: bundled });
    await store.hydrateProjectScenes();

    const first = store.getProjectSceneIds();
    // Any publish must not mint a new identity — under useSyncExternalStore a
    // fresh Set per read is a permanent "changed" signal and re-renders forever.
    store.setConflictPrompt(null);
    expect(store.getProjectSceneIds()).toBe(first);
    expect(store.getProjectScenes()).toBe(store.getProjectScenes());
  });

  it('an empty store hands out an empty, stable Set', () => {
    const a = store.getProjectSceneIds();
    expect(a.size).toBe(0);
    expect(store.getProjectSceneIds()).toBe(a);
  });
});
