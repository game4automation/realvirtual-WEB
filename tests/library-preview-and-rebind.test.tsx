// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Library detail view, "No preview" tile, placeholder billboard, catalog-id
 * rebinding and the edit-asset identity (plan-660 SimReady UX + Phase A G3).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AssetCard } from '../src/core/library/AssetCard';
import { AssetPreviewDialog } from '../src/core/library/AssetPreviewDialog';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import { LayoutStore } from '../src/plugins/layout-planner/rv-layout-store';
import { PerspectiveCamera, Raycaster, type Sprite } from 'three';
import { buildPlaceholderNode, disposePlaceholderNode, PLACEHOLDER_LABEL_NAME } from '../src/plugins/layout-planner/placeholder-node';
import { editAssetBaseOf } from '../src/plugins/layout-planner/LayoutLibraryPanel';

afterEach(() => cleanup());

function entry(over: Partial<LibraryCatalogEntry> = {}): LibraryCatalogEntry {
  return { id: 'simready:Vertiv/assets/APM2@' + 'a'.repeat(40), name: 'APM2', category: 'custom', ...over };
}

describe('AssetCard larger preview', () => {
  it('offers a magnifier on the picture that opens the preview without the card click', () => {
    const onPreview = vi.fn();
    const onClick = vi.fn();
    render(<AssetCard entry={entry({ thumbnailUrl: 'blob:t' })} onPreview={onPreview} onClick={onClick} />);
    fireEvent.click(screen.getByTestId('asset-card-preview'));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('has no magnifier without a picture or without a handler', () => {
    render(<AssetCard entry={entry()} onPreview={() => {}} />);
    expect(screen.queryByTestId('asset-card-preview')).toBeNull();
    cleanup();
    render(<AssetCard entry={entry({ thumbnailUrl: 'blob:t' })} />);
    expect(screen.queryByTestId('asset-card-preview')).toBeNull();
  });

  it('states "No preview" when the catalog picture does not load', () => {
    render(<AssetCard entry={entry({ thumbnailUrl: 'http://x/missing.png' })} />);
    fireEvent.error(screen.getByAltText('APM2'));
    expect(screen.getByText('No preview')).toBeTruthy();
  });
});

describe('AssetPreviewDialog', () => {
  it('shows the big picture, creator, license link and the place action', () => {
    const onPlace = vi.fn();
    const onClose = vi.fn();
    render(
      <AssetPreviewDialog
        entry={entry({
          thumbnailUrl: 'blob:small', previewUrl: 'blob:big', noPrefetch: true,
          attribution: { vendor: 'Vertiv', license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', sourceUrl: 'https://huggingface.co/x' },
        })}
        onClose={onClose}
        onPlace={onPlace}
      />,
    );
    expect((screen.getByTestId('asset-preview-image') as HTMLImageElement).getAttribute('src')).toBe('blob:big');
    expect(screen.getByText('Vertiv')).toBeTruthy();
    expect(screen.getByText('CC-BY-4.0').closest('a')?.getAttribute('href')).toContain('creativecommons.org');
    expect(screen.getByText('Known after the first import')).toBeTruthy();
    fireEvent.click(screen.getByTestId('asset-preview-place'));
    expect(onPlace).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('placeholder billboard', () => {
  it('hangs no card picture over a noPrefetch (server-converted) entry', () => {
    const node = buildPlaceholderNode(entry({ thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=', noPrefetch: true }));
    // The wireframe box and the loading label — no card-picture Sprite is ever scheduled.
    expect(node.children.map((c) => c.type)).toEqual(['LineSegments', 'Sprite']);
    expect(node.children[1].name).toBe(PLACEHOLDER_LABEL_NAME);
    disposePlaceholderNode(node);
  });

  it('carries a screen-constant loading label that names the asset and never takes a raycast', () => {
    const node = buildPlaceholderNode(entry({ name: 'machine' }));
    const label = node.children.find((c) => c.name === PLACEHOLDER_LABEL_NAME) as Sprite | undefined;
    expect(label).toBeTruthy();
    // No hit, and no throw without raycaster.camera (a plain Sprite would throw).
    const hits: unknown[] = [];
    label!.raycast(new Raycaster(), hits as never);
    expect(hits).toHaveLength(0);
    // Sized per frame: a far perspective camera gives a larger world size than a near one.
    const renderer = { domElement: { clientHeight: 1000 } } as never;
    const size = (dist: number): number => {
      const cam = new PerspectiveCamera(60, 1, 0.1, 10000);
      cam.position.set(0, 0, dist);
      cam.updateMatrixWorld();
      label!.onBeforeRender(renderer, null as never, cam, null as never, null as never, null as never);
      return label!.scale.y;
    };
    const near = size(10);
    const far = size(1000);
    expect(far / near).toBeGreaterThan(50);
    disposePlaceholderNode(node);
    expect(node.children.some((c) => c.name === PLACEHOLDER_LABEL_NAME)).toBe(false);
  });
});

describe('LayoutStore.rebindCatalogId', () => {
  it('re-points every placement of one catalog id and notifies once', () => {
    const store = new LayoutStore();
    const base = { glbUrl: '', label: 'x', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;
    store.addComponent({ ...base, id: '1', catalogId: 'simready:a' } as never);
    store.addComponent({ ...base, id: '2', catalogId: 'other' } as never);
    store.addComponent({ ...base, id: '3', catalogId: 'simready:a' } as never);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.rebindCatalogId('simready:a', 'project:library/simready/a.glb')).toBe(2);
    expect(store.placed.map((c) => c.catalogId)).toEqual(['project:library/simready/a.glb', 'other', 'project:library/simready/a.glb']);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.rebindCatalogId('simready:a', 'x')).toBe(0);
  });
});

describe('editAssetBaseOf (G3)', () => {
  it('opens a project document by its own path, never library/library/…', () => {
    const base = editAssetBaseOf(entry({ id: 'project:library/simready/APM2.glb', localPath: 'library/simready/APM2.glb' }));
    expect(JSON.stringify(base)).toContain('library/simready/APM2.glb');
    expect(JSON.stringify(base)).not.toContain('library/library/');
  });
  it('keeps the library-relative rule for a local-folder entry', () => {
    const base = editAssetBaseOf(entry({ id: 'local-x', localPath: 'conveyor/belt.glb' }));
    expect(JSON.stringify(base)).toContain('library/conveyor/belt.glb');
  });
});
