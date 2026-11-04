// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 §9.4, guard 1 — browsing cards never loads a GLB.
 *
 * Thumbnails are written by a save and only READ by a card. This mounts the
 * two card surfaces the user browses — the dashboard grid (the
 * `dashboard-documents.ts` mapping + `ProjectCard`) and the planner library
 * (`ThumbnailCard` over normalized catalog entries; the full panel needs the
 * plugin wiring, the same cut as `layout-library-hover-prefetch.test.tsx`) —
 * and asserts both sides:
 *  - negative: no `.glb` in any fetch, resource entry or backend read, and no
 *    GLTFLoader call at all;
 *  - positive: every backend read is a `.thumbnails/` pointer, every card
 *    with a picture shows a decoded image, every card without one its type tile.
 *
 * `<img>` requests are invisible to a fetch stub and blob-URL images create no
 * resource entry, which is why the positive side reads the DOM and the backend
 * spy instead of the network.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { rvDarkTheme } from '../../src/core/hmi/theme';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { ProjectCard } from '../../src/core/hmi/projects/ProjectCard';
import { documentCardPicture } from '../../src/core/hmi/projects/dashboard-documents';
import { ThumbnailCard } from '../../src/plugins/layout-planner/LayoutLibraryPanel';
import { normalizeCatalogEntry } from '../../src/core/library/library-store';
import { resetThumbnailUrlStoreForTests } from '../../src/core/thumbnails/rv-thumbnail-url-store';
import type { LayoutPlannerPlugin } from '../../src/plugins/layout-planner';
import type { ProjectBackend } from '../../src/core/project/backends/project-backend';
import type { RVViewer } from '../../src/core/rv-viewer';

async function pngBytes(color: string): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 8, 8);
  const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(bin)}`;
}

const GRID = { display: 'flex', flexWrap: 'wrap', gap: 2 } as const;
const TILE = { width: 48 } as const;

function wrap(ui: ReactNode): ReactNode {
  const viewer = { on: () => () => {}, highlightByPath: () => {}, clearHighlight: () => {} } as unknown as RVViewer;
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer}>{ui}</RVViewerProvider>
    </ThemeProvider>
  );
}

afterEach(() => {
  cleanup();
  resetThumbnailUrlStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('thumbnails never load a GLB on view', () => {
  it('dashboard grid (20 docs) + library cards: zero .glb reads/fetches, zero parses', async () => {
    const fetched: string[] = [];
    const realFetch = window.fetch.bind(window);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return realFetch(input, init);
    });
    const spies = (['parse', 'load', 'loadAsync'] as const)
      .map((m) => vi.spyOn(GLTFLoader.prototype as never, m as never));

    // Arrange — a folder-like project backend: 20 rows, 15 with a pointer.
    const image = await pngBytes('#4fc3f7');
    const files = new Map<string, Uint8Array>();
    const rows = Array.from({ length: 20 }, (_, i) => {
      const id = `doc_${i}`;
      const path = `models/Doc${i}.glb`;
      files.set(path, new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
      if (i >= 15) return { id, path, name: `Doc ${i}` };
      const thumbnail = `.thumbnails/${id}.0000000${i % 10}.png`;
      files.set(thumbnail, image);
      return { id, path, name: `Doc ${i}`, thumbnail };
    });
    const backend = {
      kind: 'folder', id: 'guard-1', writable: true, isActive: true,
      async readDocumentUrl(ref: string) {
        const bytes = files.get(ref);
        if (!bytes) return null;
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
        return { url, release: () => URL.revokeObjectURL(url) };
      },
    } as unknown as ProjectBackend;
    const readUrl = vi.spyOn(backend, 'readDocumentUrl');

    // A catalog of 12 entries, 8 with a saved picture (plain URLs).
    const dataUrl = bytesToDataUrl(await pngBytes('#ffb74d'));
    const catalog = Array.from({ length: 12 }, (_, i) => normalizeCatalogEntry({
      id: `cat_${i}`,
      name: `Cat ${i}`,
      glbUrl: `PalletHandling/Cat${i}.glb`,
      ...(i < 8 ? { thumbnail: dataUrl } : {}),
    }, 'https://library.example/'));
    const PLANNER_SNAPSHOT = { preparingEntryIds: [] as string[] };
    const plugin = {
      prefetchEntry: vi.fn(),
      // The library card subscribes to the planner store since plan-776 (386b6dcf).
      store: {
        setPlacementMode: vi.fn(),
        subscribe: () => () => {},
        getSnapshot: () => PLANNER_SNAPSHOT,
      },
      setDragEntry: vi.fn(),
      placeComponent: vi.fn(async () => null),
    } as unknown as LayoutPlannerPlugin;

    // Act — mount both card surfaces.
    render(wrap(
      <div>
        {/* Small tiles in a wrapping grid: both surfaces fit near the viewport, so
            the lazy images load without a scroll the headless page cannot see. */}
        <div data-testid="dashboard-grid" style={GRID}>
          {rows.map((doc) => {
            const { entry, thumbnailPointer } = documentCardPicture({ path: doc.path, name: doc.name, doc });
            return (
              <div key={doc.path} style={TILE}>
              <ProjectCard
                card={{
                  key: doc.path, entry, tier: 'user', selected: false, onSelect: () => {},
                  thumbnailPointer, thumbnailBackend: thumbnailPointer ? backend : null,
                }}
              />
              </div>
            );
          })}
        </div>
        <div data-testid="library-grid" style={GRID}>
          {catalog.map((entry) => (
            <div key={entry.id} style={TILE}>
              <ThumbnailCard entry={entry} isPlacing={false} plugin={plugin} />
            </div>
          ))}
        </div>
      </div>,
    ));

    window.scrollTo(0, document.body.scrollHeight);
    await waitFor(() => {
      const imgs = [...document.querySelectorAll('img')] as HTMLImageElement[];
      expect(imgs.filter((i) => i.complete && i.naturalWidth > 0)).toHaveLength(15 + 8);
    }, { timeout: 10_000 });

    // Assert — negative side.
    const resources = performance.getEntriesByType('resource').map((e) => e.name);
    const glb = (u: string) => /\.glb(\?|$)/i.test(u);
    expect([...fetched, ...resources].filter(glb)).toEqual([]);
    expect(readUrl.mock.calls.map(([p]) => String(p)).filter(glb)).toEqual([]);
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());

    // Assert — positive side.
    expect(readUrl.mock.calls.length).toBe(15);
    expect(readUrl.mock.calls.every(([p]) => String(p).startsWith('.thumbnails/'))).toBe(true);
    expect(document.querySelectorAll('[data-testid="glyph-tile"]')).toHaveLength(5 + 4);
  });
});
