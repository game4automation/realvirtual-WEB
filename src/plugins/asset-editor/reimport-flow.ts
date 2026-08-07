// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * reimport-flow — "Re-import CAD…" orchestration for a CADLink node: pick a
 * (newer) CAD file, swap the subtree via rv-cadlink-reimport, and show the
 * preservation report. Triggered from the CADLink inspector section's action
 * button (editor mode only; requires the private CadGeometryProvider).
 */

import type { RVViewer } from '../../core/rv-viewer';
import { reimportCad } from '../../core/editor/rv-cadlink-reimport';
import { getActiveAssetContext } from './active-asset-store';
import { showReimportReport } from './editor-dialog-store';

/** Pick a STEP/STP file — FS Access picker with an <input type=file> fallback. */
async function pickCadFile(): Promise<File | null> {
  const w = window as unknown as {
    showOpenFilePicker?: (opts: unknown) => Promise<Array<{ getFile(): Promise<File> }>>;
  };
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({
        types: [{ description: 'STEP CAD files', accept: { 'application/step': ['.step', '.stp'] } }],
        multiple: false,
      });
      return handle ? await handle.getFile() : null;
    } catch {
      return null; // user cancelled
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.step,.stp';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // Cancel (no change event) simply never resolves a file; resolve null on focus loss.
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Run the full re-import flow for the CADLink at `nodePath`. */
export async function runReimportFlow(
  viewer: RVViewer,
  nodePath: string,
  quality: string,
): Promise<void> {
  const ctx = getActiveAssetContext();
  if (!ctx) {
    console.warn('[asset-editor] re-import ignored — no active asset document');
    return;
  }
  const file = await pickCadFile();
  if (!file) return;

  try {
    const report = await reimportCad(viewer, ctx.doc, nodePath, file, quality);
    await showReimportReport({
      fileName: file.name,
      matched: report.matched,
      unmatched: report.unmatched,
      newUnmapped: report.newUnmapped,
    });
  } catch (e) {
    console.error('[asset-editor] CAD re-import failed:', e);
  }
}
