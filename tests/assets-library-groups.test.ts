// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-723 §9.4 — `crossSourceKeyOf`, the canonical cross-source identity.
 *
 * It has existed since plan-702 with no consumer at all, which means it has
 * never had a reference behaviour either. The planner's deploy dedup (F6) is
 * the first thing that turns it into a decision about what a user sees, so its
 * two rules get pinned down here before they carry that weight:
 *
 *  1. the path BELOW the last `library/` segment is the identity — the one
 *     thing a project-relative, a deployed and a legacy `models/library/`
 *     spelling of the same file share;
 *  2. no `library/` segment means no identity, and an entry without an identity
 *     is NEVER deduplicated — a coincidental basename match between two
 *     genuinely different libraries must not hide a card.
 *
 * `selectionPointsIntoGroup` is the file's other surviving rule and is covered
 * here too, since it had no test of its own either.
 */
import { describe, it, expect } from 'vitest';

import {
  crossSourceKeyOf,
  selectionPointsIntoGroup,
} from '../src/core/hmi/projects/assets-library-groups';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';

function entry(over: Partial<LibraryCatalogEntry>): LibraryCatalogEntry {
  return { id: 'e', name: 'E', category: 'custom', ...over };
}

describe('plan-723 §9.4 — crossSourceKeyOf', () => {
  it('derives the same key for project-relative, deployed and legacy models/library spellings', () => {
    const projectRelative = entry({ localPath: 'library/Conveyors/Belt.glb' });
    const deployed = entry({ glbUrl: 'https://cdn.example.com/demo/library/Conveyors/Belt.glb' });
    const legacyNesting = entry({ glbUrl: '/models/library/Conveyors/Belt.glb' });

    const key = crossSourceKeyOf(projectRelative);
    expect(key).toBe('conveyors/belt.glb');
    expect(crossSourceKeyOf(deployed)).toBe(key);
    expect(crossSourceKeyOf(legacyNesting)).toBe(key);
  });

  it('is case-insensitive, so two spellings of one file still collide', () => {
    expect(crossSourceKeyOf(entry({ localPath: 'Library/Conveyors/Belt.glb' })))
      .toBe(crossSourceKeyOf(entry({ localPath: 'library/conveyors/belt.glb' })));
  });

  it('prefers localPath over glbUrl when both are present', () => {
    // The project source carries BOTH for a document it has already resolved
    // once; the local path is the spelling every other source can be compared
    // against, so it has to win.
    expect(crossSourceKeyOf(entry({
      localPath: 'library/Conveyors/Belt.glb',
      glbUrl: 'blob:whatever',
    }))).toBe('conveyors/belt.glb');
  });

  it('falls back to splatUrl when there is neither a local path nor a glbUrl', () => {
    expect(crossSourceKeyOf(entry({ splatUrl: '/library/Scans/Hall.ply' })))
      .toBe('scans/hall.ply');
  });

  it('takes the LAST library/ segment, not the first', () => {
    expect(crossSourceKeyOf(entry({ glbUrl: '/library/mirror/library/Belt.glb' })))
      .toBe('belt.glb');
  });

  it('returns null for entries without a library/ segment (never dedup those)', () => {
    expect(crossSourceKeyOf(entry({ localPath: 'models/Belt.glb' }))).toBeNull();
    expect(crossSourceKeyOf(entry({ localPath: 'scenes/Line.scene.glb' }))).toBeNull();
    expect(crossSourceKeyOf(entry({ glbUrl: 'https://cdn.example.com/parts/Belt.glb' }))).toBeNull();
  });

  it('returns null for an entry with no path at all, and for a bare library/ folder', () => {
    expect(crossSourceKeyOf(entry({}))).toBeNull();
    expect(crossSourceKeyOf(entry({ localPath: 'library/' }))).toBeNull();
  });
});

describe('selectionPointsIntoGroup', () => {
  const group = { providerId: 'global', sourceId: 'https://example.com/catalog.json' };

  it('matches an asset selection inside the same source', () => {
    expect(selectionPointsIntoGroup({ kind: 'asset', ...group }, group)).toBe(true);
  });

  it('rejects another source, another provider and a non-asset selection', () => {
    expect(selectionPointsIntoGroup({ kind: 'asset', providerId: 'global', sourceId: 'other' }, group)).toBe(false);
    expect(selectionPointsIntoGroup({ kind: 'asset', providerId: 'project', sourceId: group.sourceId }, group)).toBe(false);
    expect(selectionPointsIntoGroup({ kind: 'folder', ...group }, group)).toBe(false);
  });
});
