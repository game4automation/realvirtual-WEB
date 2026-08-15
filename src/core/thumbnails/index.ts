// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * core/thumbnails — viewer-owned preview generation (plan-372 §2.7).
 *
 * The renderer, the persistent cache and the queue used to be private to the
 * Layout Planner plugin. They live here because the Projects dashboard needs
 * the same previews while the planner may not be loaded at all.
 */

export { ThumbnailService } from './thumbnail-service';
export type { ThumbnailLoader, ThumbnailServiceOptions } from './thumbnail-service';
export { ThumbnailCache, THUMBNAIL_BUCKET_V4 } from './thumbnail-cache';
export { ThumbnailRenderer } from './thumbnail-renderer';
export { bakeContactShadow } from './thumbnail-contact-shadow';
export type { ContactShadowBake, ContactShadowOptions } from './thumbnail-contact-shadow';
export { buildThumbnailKey, NO_PROJECT } from './thumbnail-key';
export type { ThumbnailKeyParts } from './thumbnail-key';
