// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 §9.8 — the dashboard's row → card mapping (F9), now a pure rule in
 * `dashboard-documents.ts`, and the card it feeds.
 *
 * A row with a pointer becomes a card that shows the resolved picture; a row
 * without one shows the type tile; a picture that fails to load shows the same
 * type tile — never the browser's broken-image icon.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { documentCardPicture } from '../src/core/hmi/projects/dashboard-documents';
import { ProjectCard } from '../src/core/hmi/projects/ProjectCard';
import { AssetCard } from '../src/core/library/AssetCard';
import { resetThumbnailUrlStoreForTests } from '../src/core/thumbnails/rv-thumbnail-url-store';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';

afterEach(() => { cleanup(); resetThumbnailUrlStoreForTests(); });

describe('documentCardPicture — the mapping', () => {
  it('a project row with a pointer: a stand-in entry plus the pointer, no URL guessed', () => {
    const { entry, thumbnailPointer } = documentCardPicture({
      path: 'models/Press.glb', name: 'Press', doc: { id: 'd1', thumbnail: '.thumbnails/d1.3fa9c2d1.webp' },
    });
    expect(entry).toEqual({ id: 'models/Press.glb', name: 'Press', category: 'custom' });
    expect(entry.thumbnailUrl).toBeUndefined();
    expect(thumbnailPointer).toBe('.thumbnails/d1.3fa9c2d1.webp');
  });

  it('a row without a pointer has none — the card shows its type tile', () => {
    expect(documentCardPicture({ path: 'a.glb', name: 'a', doc: { id: 'd' } }).thumbnailPointer).toBeNull();
    expect(documentCardPicture({ path: 'a.glb', name: 'a', doc: { id: 'd', thumbnail: '  ' } }).thumbnailPointer).toBeNull();
  });

  it('a catalog asset brings its own entry and picture', () => {
    const catalogEntry: LibraryCatalogEntry = { id: 'c', name: 'C', category: 'custom', thumbnailUrl: 'https://x/c.webp' };
    expect(documentCardPicture({ path: 'c', name: 'c', catalogEntry })).toEqual({ entry: catalogEntry, thumbnailPointer: null });
  });
});

describe('the card', () => {
  it('shows the resolved picture of a pointer', async () => {
    const backend = {
      kind: 'folder', id: 'map', writable: true, isActive: true,
      readDocumentUrl: async (p: string) => ({ url: `blob:test/${p}`, release: () => {} }),
    } as unknown as ProjectBackend;
    const { entry, thumbnailPointer } = documentCardPicture({
      path: 'models/Press.glb', name: 'Press', doc: { id: 'd1', thumbnail: '.thumbnails/d1.3fa9c2d1.webp' },
    });
    render(createElement(ProjectCard, {
      card: { key: 'k', entry, tier: 'user', selected: false, onSelect: () => {}, thumbnailPointer, thumbnailBackend: backend },
    }));
    await waitFor(() => {
      expect(screen.getByAltText('Press').getAttribute('src')).toBe('blob:test/.thumbnails/d1.3fa9c2d1.webp');
    });
  });

  it('without a pointer shows the type tile', () => {
    const { entry, thumbnailPointer } = documentCardPicture({ path: 'a.glb', name: 'Alpha', doc: { id: 'd' } });
    render(createElement(ProjectCard, {
      card: { key: 'k', entry, tier: 'user', selected: false, onSelect: () => {}, thumbnailPointer },
    }));
    expect(screen.queryByAltText('Alpha')).toBeNull();
    expect(screen.getByTestId('glyph-tile')).toBeTruthy();
  });

  it('a picture that fails to load falls back to the type tile, not the broken-image icon', () => {
    render(createElement(AssetCard, {
      entry: { id: 'x', name: 'Gone', category: 'custom', thumbnailUrl: 'blob:missing' },
    }));
    fireEvent.error(screen.getByAltText('Gone'));
    expect(screen.queryByAltText('Gone')).toBeNull();
    expect(screen.getByTestId('glyph-tile').textContent).toContain('No preview');
    expect(document.querySelector('[data-testid="ImageNotSupportedOutlinedIcon"]')).toBeNull();
  });
});
