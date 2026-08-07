// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-library-save — persist an authored asset into the Custom library.
 *
 * Target: `<project>/library/Custom/<name>.glb` **of the active project**
 * (plan-372 §2.9). A thumbnail goes to `library/.thumbnails/Custom/<name>.png`
 * — the exact path the library scan mirrors — so a saved asset shows up in the
 * planner library (category `custom`, collection `Custom`) after a refresh.
 *
 * The write goes through `ProjectBackend.writeBlob`, so the same code path
 * serves all three backends: a folder project writes to disk, a browser project
 * to OPFS, and a bundled project refuses (it has nowhere to write).
 *
 * ## The File-System-Access guard is backend-specific, and that matters
 *
 * This function used to open with `if (!isSupported()) return 'unsupported'` —
 * a File System Access check as its very first statement, before it was even
 * known which backend was active. On Firefox and Safari, where that API does
 * not exist and the browser backend is therefore the *only* writable route,
 * every save of a user's own asset failed with "unsupported". The guard now
 * lives inside the folder branch only, and `'unsupported'` means what it says:
 * a folder project is active and the API is missing.
 *
 * This module performs NO dialogs and NO catalog refresh — the AssetEditorPlugin
 * orchestrates those around the returned outcome (FS Access calls must run
 * inside the user gesture).
 */

import type { Object3D, Group, WebGLRenderer } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { AssetDocument } from './rv-asset-document';
import { exportAssetGlb } from './rv-asset-glb-export';
import { isSupported } from '../engine/rv-local-filesystem';
import { getProjectStore } from '../project/project-store';
import { ThumbnailRenderer } from '../thumbnails/thumbnail-renderer';

/** Name of the Custom-library subfolder under the project's `library/`. */
export const CUSTOM_LIBRARY_FOLDER = 'Custom';

export type SaveOutcome =
  | {
      kind: 'saved';
      fileName: string;
      relPath: string;                                     // relative to library/
      /** The exported GLB bytes as written. */
      glb: ArrayBuffer;
    }
  /** A FOLDER project is active but the File System Access API is missing. */
  | { kind: 'unsupported' }
  /** No project open, or the open one cannot be written to (e.g. bundled). */
  | { kind: 'no-writable-project'; reason: string }
  | { kind: 'write-denied' }                               // permission refused
  | { kind: 'error'; message: string };

/** Sanitize an asset name into a safe file stem. */
export function sanitizeAssetFileName(name: string): string {
  const stem = name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  return stem || 'Untitled';
}

/**
 * Export the asset and write GLB + thumbnail into the Custom library.
 * Must be called from a user-gesture context (FS Access permission prompts).
 */
export async function saveAssetToCustomLibrary(
  viewer: RVViewer,
  doc: AssetDocument,
  name: string,
): Promise<SaveOutcome> {
  await doc.whenIdle();
  const assetRoot = viewer.currentModelRoot;
  if (!assetRoot) return { kind: 'error', message: 'No asset loaded' };

  const backend = getProjectStore().getBackend();
  if (!backend) {
    return { kind: 'no-writable-project', reason: 'No project is open.' };
  }
  if (!backend.writable) {
    // A bundled deploy is read-only by nature. Saying so beats a silent
    // failure or a generic error the user cannot act on (§2.9).
    return {
      kind: 'no-writable-project',
      reason: backend.kind === 'bundled'
        ? 'This project ships with the application and cannot be written to. Create or open your own project to save assets.'
        : 'The open project is read-only.',
    };
  }
  // Folder projects — and only those — need the File System Access API.
  if (backend.kind === 'folder' && !isSupported()) return { kind: 'unsupported' };

  try {
    const fileName = `${sanitizeAssetFileName(name)}.glb`;
    // The asset name becomes the GLB scene name → the root node name on reload
    // → the planner's placement label. Without it the saved root would inherit
    // whatever the editor's current root happened to be called.
    const glb = await exportAssetGlb(assetRoot, name);

    const relPath = `${CUSTOM_LIBRARY_FOLDER}/${fileName}`;
    // One call for all three backends: folder writes to disk, browser to OPFS,
    // bundled never gets here (rejected above with a reason).
    await backend.writeBlob(
      `library/${relPath}`,
      new Blob([glb], { type: 'model/gltf-binary' }),
    );

    // Thumbnail (best-effort): library/.thumbnails/Custom/<name>.png — the
    // exact mirror path the library scan looks up (lowercased keys).
    try {
      const thumbBlob = renderThumbnailBlob(viewer, assetRoot);
      if (thumbBlob) {
        await backend.writeBlob(
          `library/.thumbnails/${CUSTOM_LIBRARY_FOLDER}/${fileName.replace(/\.glb$/i, '.png')}`,
          await thumbBlob,
        );
      }
    } catch (e) {
      console.warn('[asset-editor] thumbnail write failed (asset saved fine):', e);
    }

    return { kind: 'saved', fileName, relPath, glb };
  } catch (e) {
    console.error('[asset-editor] save failed:', e);
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
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

/** Render a 256px PNG thumbnail of the asset with the main scene's lighting. */
function renderThumbnailBlob(viewer: RVViewer, assetRoot: Object3D): Promise<Blob> | null {
  try {
    const renderer = viewer.renderer as unknown as WebGLRenderer;
    const thumbs = new ThumbnailRenderer(renderer, viewer.scene);
    const dataUrl = thumbs.render(assetRoot as Group, 256);
    thumbs.dispose();
    // null = skipped (WebGPURenderer — thumbnails need the classic WebGLRenderer, plan-271)
    if (!dataUrl) return null;
    return fetch(dataUrl).then((r) => r.blob());
  } catch (e) {
    console.warn('[asset-editor] thumbnail render failed:', e);
    return null;
  }
}
