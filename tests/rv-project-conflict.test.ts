// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-conflict.test — the per-scene decision, exhaustively.
 *
 * This is the function that decides whether a user's work survives opening a
 * project folder, so it is built pure (no DOM, no handle) precisely so a test
 * can reach every branch. The case that matters most is the one Blocker B3
 * named: an unsaved draft outranks every timestamp, because someone who
 * edited but never pressed Save has their work *only* there.
 */

import { describe, it, expect } from 'vitest';
import {
  cacheModifiedAt,
  compareTimestamps,
  hasUnsavedDraft,
  resolveSceneConflict,
} from '../src/core/project/rv-project-conflict';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

const T0 = '2025-01-01T10:00:00.000Z';
const T1 = '2025-01-01T11:00:00.000Z';
const T2 = '2025-01-01T12:00:00.000Z';

function scene(overrides: Partial<RvScene> = {}): RvScene {
  return {
    id: 'scn_a',
    name: 'Cell A',
    createdAt: T0,
    modifiedAt: T0,
    schemaVersion: 3,
    base: { kind: 'empty' },
    edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
    ...overrides,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

describe('compareTimestamps', () => {
  it('orders two ISO timestamps', () => {
    expect(compareTimestamps(T0, T1)).toBeLessThan(0);
    expect(compareTimestamps(T2, T1)).toBeGreaterThan(0);
    expect(compareTimestamps(T1, T1)).toBe(0);
  });

  it('treats null as older, and two nulls as indistinguishable', () => {
    expect(compareTimestamps(null, T0)).toBeLessThan(0);
    expect(compareTimestamps(T0, null)).toBeGreaterThan(0);
    expect(compareTimestamps(null, null)).toBe(0);
  });

  it('falls back to a string compare rather than throwing on garbage', () => {
    expect(compareTimestamps('not-a-date', 'zzz')).toBeLessThan(0);
    expect(compareTimestamps('not-a-date', 'not-a-date')).toBe(0);
  });

  it('resolves a millisecond difference — clock drift is not rounded away', () => {
    expect(compareTimestamps('2025-01-01T10:00:00.001Z', '2025-01-01T10:00:00.000Z'))
      .toBeGreaterThan(0);
  });
});

describe('cacheModifiedAt', () => {
  it('is the newer of saved and draft, not the saved record alone', () => {
    expect(cacheModifiedAt(scene({ modifiedAt: T0 }), scene({ modifiedAt: T2 }))).toBe(T2);
    expect(cacheModifiedAt(scene({ modifiedAt: T2 }), scene({ modifiedAt: T0 }))).toBe(T2);
  });

  it('copes with either side missing', () => {
    expect(cacheModifiedAt(scene({ modifiedAt: T1 }), null)).toBe(T1);
    expect(cacheModifiedAt(null, scene({ modifiedAt: T1 }))).toBe(T1);
    expect(cacheModifiedAt(null, null)).toBeNull();
  });
});

describe('hasUnsavedDraft', () => {
  it('is false without a draft, and false for a draft that matches the save', () => {
    expect(hasUnsavedDraft(scene(), null)).toBe(false);
    expect(hasUnsavedDraft(scene(), scene({ modifiedAt: T2 }))).toBe(false); // modifiedAt ignored
  });

  it('is true for a draft whose content diverges, and for a draft with no save', () => {
    expect(hasUnsavedDraft(scene(), scene({ name: 'Cell A (edited)' }))).toBe(true);
    expect(hasUnsavedDraft(null, scene())).toBe(true);
  });
});

// ─── The four outcomes ──────────────────────────────────────────────────

describe('resolveSceneConflict — nothing on one side', () => {
  it('takes the folder when the scene is not cached at all', () => {
    expect(resolveSceneConflict({
      saved: null, draft: null, folder: { modifiedAt: T1 },
    })).toBe('folder-wins');
  });

  it('is equal when neither side has anything', () => {
    expect(resolveSceneConflict({ saved: null, draft: null, folder: null })).toBe('equal');
    expect(resolveSceneConflict({ saved: null, draft: null, folder: {} })).toBe('equal');
  });

  it('keeps the cache when the folder entry carries nothing usable', () => {
    expect(resolveSceneConflict({
      saved: scene(), draft: null, folder: null,
    })).toBe('cache-wins');
    expect(resolveSceneConflict({
      saved: scene(), draft: null, folder: { modifiedAt: '   ' },
    })).toBe('cache-wins');
  });
});

describe('resolveSceneConflict — B3: an unsaved draft always prompts', () => {
  it('prompts even when the folder is much newer', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T0 }),
      draft: scene({ name: 'Cell A (edited)', modifiedAt: T0 }),
      folder: { modifiedAt: T2 },
    })).toBe('prompt');
  });

  it('prompts even when the folder body is available and newer', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T0 }),
      draft: scene({ name: 'Cell A (edited)' }),
      folder: { modifiedAt: T2, scene: scene({ name: 'Folder version', modifiedAt: T2 }) },
    })).toBe('prompt');
  });

  it('prompts for a draft that has no saved record behind it at all', () => {
    expect(resolveSceneConflict({
      saved: null,
      draft: scene({ modifiedAt: T1 }),
      folder: { modifiedAt: T2 },
    })).toBe('prompt');
  });

  it('does NOT prompt for a draft that merely mirrors the saved record', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T1 }),
      draft: scene({ modifiedAt: T1 }),
      folder: { modifiedAt: T1 },
    })).toBe('equal');
  });
});

describe('resolveSceneConflict — timestamps', () => {
  it('folder newer → folder wins', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T0 }), draft: null, folder: { modifiedAt: T2 },
    })).toBe('folder-wins');
  });

  it('cache newer → prompt, never a silent discard of local work', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T2 }), draft: null, folder: { modifiedAt: T0 },
    })).toBe('prompt');
  });

  it('same timestamp with no body available → equal', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T1 }), draft: null, folder: { modifiedAt: T1 },
    })).toBe('equal');
  });

  it('uses max(saved, draft) as the cache side even when the draft is not unsaved work', () => {
    // The draft matches the save structurally, but is the newer stamp: the
    // folder is older than it, so this is a cache-newer case, not folder-wins.
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T0 }),
      draft: scene({ modifiedAt: T2 }),
      folder: { modifiedAt: T1 },
    })).toBe('prompt');
  });
});

describe('resolveSceneConflict — content beats clocks (scenesEqual fallback)', () => {
  it('same timestamp but different content → prompt', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T1 }),
      draft: null,
      folder: { modifiedAt: T1, scene: scene({ name: 'Folder version', modifiedAt: T1 }) },
    })).toBe('prompt');
  });

  it('same timestamp and identical content → equal', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T1 }),
      draft: null,
      folder: { modifiedAt: T1, scene: scene({ modifiedAt: T1 }) },
    })).toBe('equal');
  });

  it('folder newer but content identical → equal (the hydration timestamp bump)', () => {
    // Hydrating a scene rewrites the cache `modifiedAt` to "now". Without the
    // content check every untouched project would raise a conflict on reopen.
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T0 }),
      draft: null,
      folder: { modifiedAt: T2, scene: scene({ modifiedAt: T2 }) },
    })).toBe('equal');
  });

  it('cache newer but content identical → equal', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: T2 }),
      draft: null,
      folder: { modifiedAt: T0, scene: scene({ modifiedAt: T0 }) },
    })).toBe('equal');
  });

  it('a body with no timestamp at all is decided on content', () => {
    expect(resolveSceneConflict({
      saved: scene(), draft: null, folder: { scene: scene() },
    })).toBe('equal');
    expect(resolveSceneConflict({
      saved: scene(), draft: null, folder: { scene: scene({ name: 'Other' }) },
    })).toBe('prompt');
  });

  it('a folder body under a different id is a divergence, not a match', () => {
    expect(resolveSceneConflict({
      saved: scene({ id: 'scn_a', modifiedAt: T1 }),
      draft: null,
      folder: { modifiedAt: T1, scene: scene({ id: 'scn_b', modifiedAt: T1 }) },
    })).toBe('prompt');
  });
});

describe('resolveSceneConflict — clock drift is prompted, never discarded', () => {
  it('a folder one millisecond ahead of differing local content still wins only on evidence', () => {
    // Folder ahead, content differs → the folder is taken (a git pull).
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: '2025-01-01T10:00:00.000Z' }),
      draft: null,
      folder: {
        modifiedAt: '2025-01-01T10:00:00.001Z',
        scene: scene({ name: 'Pulled', modifiedAt: '2025-01-01T10:00:00.001Z' }),
      },
    })).toBe('folder-wins');
  });

  it('a cache one millisecond ahead prompts rather than overwriting the folder', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: '2025-01-01T10:00:00.001Z' }),
      draft: null,
      folder: {
        modifiedAt: '2025-01-01T10:00:00.000Z',
        scene: scene({ name: 'Folder', modifiedAt: '2025-01-01T10:00:00.000Z' }),
      },
    })).toBe('prompt');
  });

  it('unparseable timestamps on both sides fall back to a string compare', () => {
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: 'aaa' }), draft: null, folder: { modifiedAt: 'bbb' },
    })).toBe('folder-wins');
    expect(resolveSceneConflict({
      saved: scene({ modifiedAt: 'ccc' }), draft: null, folder: { modifiedAt: 'bbb' },
    })).toBe('prompt');
  });
});
