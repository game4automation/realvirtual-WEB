// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * delete-selection — shared delete path for the editor toolbar button and the
 * Delete/Backspace keyboard shortcut, so both gestures emit the same single
 * undo unit (one Ctrl+Z restores the lot).
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { AssetDocument } from '../../core/editor/rv-asset-document';

/**
 * Drop paths whose ancestor is also in the list — deleting the ancestor
 * trashes the whole subtree, and a second deleteNode op on an already-trashed
 * descendant would be a dangling no-op that breaks undo symmetry.
 * Segment-aware: `A/Conv` is NOT an ancestor of `A/Conv2`.
 */
export function pruneDescendantPaths(paths: string[]): string[] {
  const bySegments = [...paths].sort(
    (a, b) => a.split('/').length - b.split('/').length,
  );
  const kept: string[] = [];
  for (const p of bySegments) {
    if (!kept.some((q) => p === q || p.startsWith(q + '/'))) kept.push(p);
  }
  // Preserve the original selection order among the survivors (dedupe exact
  // repeats — Set.delete admits each survivor once).
  const keptSet = new Set(kept);
  return paths.filter((p) => keptSet.delete(p));
}

/**
 * Delete the current selection from the asset document as ONE undo unit.
 * Skips unresolvable paths (already deleted / trashed), the asset root, and
 * descendants of other selected paths. Clears the selection afterwards —
 * SelectionManager keeps stale paths otherwise, and clearing also detaches
 * the transform gizmo.
 */
export async function deleteSelectedNodes(viewer: RVViewer, doc: AssetDocument): Promise<void> {
  const candidates = [...viewer.selectionManager.selectedPaths].filter((path) => {
    const node = viewer.registry?.getNode(path);
    return !!node && !!node.parent && node !== viewer.currentModelRoot;
  });
  const paths = pruneDescendantPaths(candidates);
  if (paths.length === 0) return;
  await doc.deleteNodes(paths);
  viewer.selectionManager.clear();
}
