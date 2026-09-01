// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-library-save — the download fallback, and two names.
 *
 * ## What this file stopped being (plan-719 F9)
 *
 * It used to hold `saveAssetToCustomLibrary()`, a second writer with a third
 * outcome vocabulary of its own. By the time this plan reached it, it had
 * ZERO production callers — every save had already been routed through
 * `rv-save-document.ts` by plan-709 — so what remained was a fully maintained
 * parallel implementation of "write an asset into the project" that nothing
 * called and that every reader of the save path had to rule out first. It is
 * gone, and with it the `SaveOutcome` union that was one of the three
 * competing vocabularies plan-719 F4 collapses.
 *
 * What survives is what is genuinely used elsewhere: {@link downloadAssetGlb}
 * — the way out when a project cannot be written to at all —
 * {@link sanitizeAssetFileName}, and {@link CUSTOM_LIBRARY_FOLDER}, which is
 * still where the explicit "Save as…" verb places a new asset.
 */

import type { Object3D, Group, WebGLRenderer } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { AssetDocument } from './rv-asset-document';
import { exportAssetGlb } from './rv-asset-glb-export';
import { ThumbnailRenderer } from '../thumbnails/thumbnail-renderer';

/** Name of the Custom-library subfolder under the project's `library/`. */
export const CUSTOM_LIBRARY_FOLDER = 'Custom';

/** Sanitize an asset name into a safe file stem. */
export function sanitizeAssetFileName(name: string): string {
  const stem = name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  return stem || 'Untitled';
}

/** Download the asset as a .glb file — the fallback when no work folder /
 *  unsupported browser. The document stays dirty (draft-safe). */
export async function downloadAssetGlb(viewer: RVViewer, doc: AssetDocument, name: string): Promise<boolean> {
  await doc.whenIdle();
  const assetRoot = viewer.currentModelRoot;
  if (!assetRoot) return false;
  try {
    const glb = await exportAssetGlb(assetRoot, name);
    const blob = new Blob([glb], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeAssetFileName(name)}.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch (e) {
    console.error('[asset-editor] GLB download failed:', e);
    return false;
  }
}

/**
 * Render a 512px PNG thumbnail of the asset in the frozen thumbnail look
 * (plan-712 — same size and look as the browser-cached previews, so a saved
 * custom asset does not stand out next to the generated ones).
 *
 * This builds a throw-away ThumbnailRenderer per save, so the cached composer
 * never applies here; a full build + dispose per custom-library save is the
 * accepted cost of a rare, explicit user action.
 */
function renderThumbnailBlob(viewer: RVViewer, assetRoot: Object3D): Promise<Blob> | null {
  try {
    const renderer = viewer.renderer as unknown as WebGLRenderer;
    const thumbs = new ThumbnailRenderer(renderer, viewer.scene);
    const dataUrl = thumbs.render(assetRoot as Group, 512);
    thumbs.dispose();
    // null = skipped (WebGPURenderer — thumbnails need the classic WebGLRenderer, plan-271)
    if (!dataUrl) return null;
    return fetch(dataUrl).then((r) => r.blob());
  } catch (e) {
    console.warn('[asset-editor] thumbnail render failed:', e);
    return null;
  }
}
