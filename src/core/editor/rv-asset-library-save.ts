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

import type { RVViewer } from '../rv-viewer';
import type { AssetDocument } from './rv-asset-document';
import { exportAssetGlb } from './rv-asset-glb-export';

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
  // plan-462 B3 — refused BEFORE the first side effect, not after the export.
  // While a test run owns the document, `viewer.currentModelRoot` IS the
  // materialised test scene: exporting it would hand the user a GLB with
  // runtime poses baked in as the authored state. Same reason the save path
  // refuses, and the download is just as irreversible once the file is on disk.
  const owner = doc.lockOwner;
  if (owner?.kind === 'test-run') {
    console.warn(
      '[asset-editor] GLB download refused: a test run is active, so the scene shows runtime '
      + 'poses rather than the authored state. Stop the test run first.');
    return false;
  }
  await doc.whenIdle();
  const assetRoot = viewer.currentModelRoot;
  if (!assetRoot) return false;
  try {
    const glb = await exportAssetGlb(assetRoot, name, undefined, undefined, { registry: viewer.registry ?? null });
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

