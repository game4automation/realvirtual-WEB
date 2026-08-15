// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Decision (a) of 2026-08-10: a descend opens the child from ITS OWN bytes, and
 * this pins WHICH bytes (plan-703 §2.7.3).
 *
 * The interesting assertion is the ORDER — manifest-by-id above path — because
 * that is the whole return on Phase 5's mint: a reference written before the
 * file moved must still open the right file while its own relative path has
 * gone stale. Everything else here follows from it.
 */
import { describe, it, expect } from 'vitest';
import {
  planReferencedAssetOpen,
  resolveReferencePath,
} from '../src/core/project/rv-referenced-asset-open';
import type { RvProject } from '../src/core/project/rv-project-types';

function project(documents: Array<{ id: string; path: string }>): RvProject {
  return { schemaVersion: 2, name: 'p', documents } as unknown as RvProject;
}

describe('resolveReferencePath', () => {
  it('resolves against the FOLDER of the owning file, not the file itself', () => {
    expect(resolveReferencePath('machines/Filler.glb', 'parts/Gripper.glb'))
      .toBe('machines/parts/Gripper.glb');
  });

  it('walks up through ..', () => {
    expect(resolveReferencePath('machines/sub/Filler.glb', '../../parts/Gripper.glb'))
      .toBe('parts/Gripper.glb');
  });

  it('drops . segments and empty ones', () => {
    expect(resolveReferencePath('a/b/Owner.glb', './/c/./D.glb')).toBe('a/b/c/D.glb');
  });

  it('resolves against the project root when there is no owner', () => {
    expect(resolveReferencePath(null, 'parts/Gripper.glb')).toBe('parts/Gripper.glb');
  });

  it('leaves an absolute path and an external URL untouched', () => {
    expect(resolveReferencePath('a/Owner.glb', '/parts/G.glb')).toBe('parts/G.glb');
    expect(resolveReferencePath('a/Owner.glb', 'https://cdn.example/g.glb'))
      .toBe('https://cdn.example/g.glb');
    expect(resolveReferencePath('a/Owner.glb', 'blob:abc')).toBe('blob:abc');
  });

  it('answers empty for an empty path rather than inventing the owner folder', () => {
    expect(resolveReferencePath('a/Owner.glb', '')).toBe('');
    expect(resolveReferencePath('a/Owner.glb', '   ')).toBe('');
  });
});

describe('planReferencedAssetOpen', () => {
  it('a catalog-qualified reference resolves through its library', () => {
    const plan = planReferencedAssetOpen(
      { assetId: 'a1', providerId: 'cloud', sourceId: 's1', path: 'parts/G.glb' },
      project([{ id: 'a1', path: 'other/G.glb' }]),
      'machines/Filler.glb',
    );
    expect(plan).toEqual({ via: 'catalog', providerId: 'cloud', sourceId: 's1', assetId: 'a1' });
  });

  it('the manifest row wins over the reference’s own path', () => {
    // The point of the mint: the file MOVED, so `path` is stale and the id is not.
    const plan = planReferencedAssetOpen(
      { assetId: 'a1', path: 'parts/Gripper.glb' },
      project([{ id: 'a1', path: 'moved/elsewhere/Gripper.glb' }]),
      'machines/Filler.glb',
    );
    expect(plan).toEqual({ via: 'manifest', assetId: 'a1', relPath: 'moved/elsewhere/Gripper.glb' });
  });

  it('falls back to the path when the id is not in this project', () => {
    const plan = planReferencedAssetOpen(
      { assetId: 'unknown', path: '../parts/Gripper.glb' },
      project([{ id: 'a1', path: 'x.glb' }]),
      'machines/Filler.glb',
    );
    expect(plan).toEqual({ via: 'path', relPath: 'parts/Gripper.glb' });
  });

  it('an id with neither a row nor a path is unresolvable, not guessed at', () => {
    const plan = planReferencedAssetOpen({ assetId: 'ghost' }, project([]), 'a/Owner.glb');
    expect(plan).toEqual({ via: 'unresolvable', reason: 'unknown-asset' });
  });

  it('a reference with nothing at all reports no-locator', () => {
    const plan = planReferencedAssetOpen({ assetId: '' }, project([]), null);
    expect(plan).toEqual({ via: 'unresolvable', reason: 'no-locator' });
  });

  it('a null project degrades to the path rather than refusing', () => {
    const plan = planReferencedAssetOpen(
      { assetId: 'a1', path: 'parts/G.glb' }, null, 'machines/Filler.glb',
    );
    expect(plan).toEqual({ via: 'path', relPath: 'machines/parts/G.glb' });
  });

  it('a manifest row with an empty path does not win — the path fallback runs', () => {
    const plan = planReferencedAssetOpen(
      { assetId: 'a1', path: 'parts/G.glb' },
      project([{ id: 'a1', path: '' }]),
      null,
    );
    expect(plan).toEqual({ via: 'path', relPath: 'parts/G.glb' });
  });
});
