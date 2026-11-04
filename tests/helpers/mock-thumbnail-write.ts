// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mock-thumbnail-write — the ONE stand-in for the save-time thumbnail writer
 * (plan-776 §9.7).
 *
 * The save-routing suites test WHERE a save writes and what it reports, not
 * the picture. Nine of them used to mock `thumbnail-renderer` with a private
 * class each; since plan-776 the save reaches the renderer only through
 * `rv-thumbnail-write`, so they mock that module — and through this helper, so
 * a change of the writer's surface is one edit, not nine:
 *
 * ```ts
 * vi.mock('../src/core/thumbnails/rv-thumbnail-write', async () =>
 *   (await import('./helpers/mock-thumbnail-write')).mockThumbnailWriteModule());
 * ```
 *
 * The mock writes nothing and points at nothing; `thumbnailWriteCalls` records
 * what the save asked for, for a suite that wants to assert it.
 */

/** One call the save made into the (mocked) writer. */
export interface ThumbnailWriteCall {
  kind: 'write' | 'drop';
  documentId: string | null;
  relPath: string | null;
}

/** Every call since the last {@link resetThumbnailWriteCalls}. */
export const thumbnailWriteCalls: ThumbnailWriteCall[] = [];

export function resetThumbnailWriteCalls(): void {
  thumbnailWriteCalls.length = 0;
}

/** The module shape `vi.mock(..., factory)` hands back for `rv-thumbnail-write`. */
export function mockThumbnailWriteModule(): Record<string, unknown> {
  return {
    THUMBNAIL_SIZE: 512,
    SCENE_READY_WAIT_MS: 5000,
    isThumbnailExcludedNode: () => false,
    documentContentRoots: () => [],
    renderThumbnailImage: async () => null,
    writeDocumentThumbnail: async (ctx: {
      documentId?: string | null; relPath?: string | null;
    }) => {
      thumbnailWriteCalls.push({
        kind: 'write',
        documentId: ctx?.documentId ?? null,
        relPath: ctx?.relPath ?? null,
      });
      return null;
    },
    dropDocumentThumbnail: async (ctx: { documentId?: string }) => {
      thumbnailWriteCalls.push({ kind: 'drop', documentId: ctx?.documentId ?? null, relPath: null });
    },
  };
}
