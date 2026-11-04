// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-thumbnail-encode — turn a rendered thumbnail canvas into file bytes
 * (plan-776 F2, P3, P4).
 *
 * WebP at quality 0.85 with alpha, where the browser can encode it. Safari
 * cannot: asked for `image/webp` it silently hands back a PNG. So the RESULT's
 * MIME type decides the extension, never the request — a PNG is never written
 * under `.webp`, and no WASM encoder is shipped for the one browser that lacks
 * one (WebKit bug 226950).
 *
 * The hash is the first 8 hex characters of the image's SHA-256
 * (`revisionOfBytes`, the project layer's one hash helper). It goes into the
 * file NAME, which is what makes a changed picture a new URL for every cache on
 * the way (plan-776 #15).
 */

import { revisionOfBytes } from '../project/rv-scene-record';
import type { ThumbnailExt } from '../library/library-types';

/** WebP quality of a saved thumbnail. */
export const THUMBNAIL_WEBP_QUALITY = 0.85;

/** The encoded image, ready to be written as `<id>.<hash8>.<ext>`. */
export interface ThumbnailImage {
  bytes: Uint8Array;
  ext: ThumbnailExt;
  hash8: string;
}

/** Anything that can be encoded: a DOM canvas or an OffscreenCanvas. */
export type EncodableCanvas =
  | HTMLCanvasElement
  | { convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> };

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The thumbnail canvas could not be encoded.'))),
      type,
      quality,
    );
  });
}

/**
 * Encode `canvas` as WebP (PNG where the browser falls back) and hash it.
 *
 * Throws when the canvas cannot be encoded at all — the save path turns that
 * into "no thumbnail" (pointer removed), never into a failed save.
 */
export async function encodeThumbnail(canvas: EncodableCanvas): Promise<ThumbnailImage> {
  const blob = 'convertToBlob' in canvas && typeof canvas.convertToBlob === 'function'
    ? await canvas.convertToBlob({ type: 'image/webp', quality: THUMBNAIL_WEBP_QUALITY })
    : await toBlob(canvas as HTMLCanvasElement, 'image/webp', THUMBNAIL_WEBP_QUALITY);
  const ext: ThumbnailExt = blob.type === 'image/webp' ? 'webp' : 'png';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('The thumbnail encoder returned no bytes.');
  const hash8 = (await revisionOfBytes(bytes)).slice(0, 8);
  return { bytes, ext, hash8 };
}
