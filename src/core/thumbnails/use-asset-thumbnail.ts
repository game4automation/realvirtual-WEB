// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * use-asset-thumbnail — the card side of preview generation (plan-372 §2.7/§2.8,
 * Phase 10).
 *
 * `ThumbnailService` renders and caches; `useThumbnailVisibility` says when a
 * card is worth rendering for. This hook is the small piece that was missing
 * between them, and without it the Projects dashboard showed icons for every
 * model and every asset: `AssetCard` is presentational and renders
 * `entry.thumbnailUrl`, nobody filled that field, and nobody asked the service.
 *
 * ## Why a hook and not a change to `AssetCard`
 *
 * The card is deliberately behaviour-free (see its header) — the planner passes
 * it drag handlers, a context menu and its own preview pipeline. Putting a
 * fetch inside it would give every existing caller a second, invisible
 * pipeline. A hook keeps the pull with whoever owns the card, which is the same
 * rule the planner already follows.
 *
 * ## What the caller must provide
 *
 * A **key** (identity, not location — see `thumbnail-key.ts`) and a
 * **resolver** that hands back a loadable URL. The two are separate on purpose:
 * a folder-backed asset's URL is a `blob:` that changes every session, so it
 * can identify nothing, and resolving one costs a file read that must not
 * happen for a card nobody looks at.
 *
 * ## Lifecycle
 *
 * The object URL for the rendered PNG is owned here and revoked on unmount or
 * on key change. The *source* URL is released as soon as the GLB is decoded —
 * a blob URL held for the life of the card would pin every library asset the
 * user ever scrolled past.
 */

import { useEffect, useState } from 'react';
import type { Object3D } from 'three';
import { gltfLoader } from '../engine/rv-glb-parse';
import { useThumbnailVisibility } from './use-thumbnail-visibility';
import { buildThumbnailKey, type ThumbnailKeyParts } from './thumbnail-key';
import type { ThumbnailService } from './thumbnail-service';

/** A loadable URL plus the means to let it go again. */
export interface ResolvedThumbnailSource {
  url: string;
  /** Revokes a blob URL. Absent for a plain HTTP URL, which owns nothing. */
  release?: () => void;
}

export interface AssetThumbnailOptions {
  /**
   * The preview service, or null/undefined when there is none.
   *
   * Optional rather than required: constrained shells and test doubles hand
   * back viewers without one, and a card with no picture is a much better
   * outcome than a dashboard that throws while rendering.
   */
  service: ThumbnailService | null | undefined;
  /** Cache identity. Null disables the request entirely. */
  keyParts: ThumbnailKeyParts | null;
  /** Resolves the GLB to render. Called at most once, only on a cache miss. */
  resolve: (() => Promise<ResolvedThumbnailSource | null>) | null;
  /** Skip when the entry already has a picture of its own. */
  enabled?: boolean;
}

export interface AssetThumbnailResult<E extends HTMLElement> {
  /** Attach to the card so its visibility can schedule the work. */
  ref: React.RefObject<E | null>;
  /** Object URL of the rendered PNG, or null while absent. */
  url: string | null;
}

/**
 * Request the preview for one card, once it is (nearly) on screen.
 *
 * Returns `null` for the whole lifetime of a card whose preview cannot be
 * produced — a WebGPU viewer, a failed decode, a source that cannot be read.
 * That is a normal outcome, not an error, and the card falls back to its icon.
 */
export function useAssetThumbnail<E extends HTMLElement>(
  opts: AssetThumbnailOptions,
): AssetThumbnailResult<E> {
  const { service, keyParts, resolve, enabled = true } = opts;
  const { ref, visible } = useThumbnailVisibility<E>();
  const [url, setUrl] = useState<string | null>(null);

  // The key is a string so it can be an effect dependency; a fresh parts object
  // on every render would restart the effect on every render.
  const key = keyParts ? buildThumbnailKey(keyParts) : null;
  const wanted = enabled && !!key && !!resolve && !!service?.isAvailable;

  useEffect(() => {
    if (!wanted || !key) return;
    if (!visible) {
      // De-prioritise rather than abort: a job already running still lands in
      // the cache, so scrolling back is instant (§2.8).
      service?.cancel(key);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void service!
      .enqueue(key, async (): Promise<Object3D> => {
        const source = await resolve!();
        if (!source) throw new Error('asset could not be resolved');
        try {
          const gltf = await gltfLoader.loadAsync(source.url);
          return gltf.scene;
        } finally {
          // Released the moment the bytes are decoded — holding it would pin
          // every asset the user scrolled past for the life of the panel.
          source.release?.();
        }
      })
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { /* no preview is a normal outcome — keep the icon */ });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // `resolve` is intentionally NOT a dependency: callers build it inline, so
    // a fresh closure per render would re-enqueue forever. The key is what
    // identifies the work, and it is here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, wanted, service]);

  // A key change means a different asset — drop the previous picture rather
  // than showing it under the new card until the new render lands.
  useEffect(() => { setUrl(null); }, [key]);

  return { ref, url };
}
