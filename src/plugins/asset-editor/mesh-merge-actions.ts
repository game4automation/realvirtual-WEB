// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mesh-merge-actions — the "Merge into one mesh…" entry of the editor context menu
 * (plan-372, Phase 5). The counterpart of `mesh-separator-actions.ts`.
 *
 * Two things decide the shape of this file.
 *
 * **The menu resolver runs synchronously while the menu opens**, so
 * {@link isMergeTarget} may only ask questions that are free. The classification — which
 * walks the whole subtree — happens after the click, behind the preview dialog:
 *
 *   click → dialog (busy) → classify → dialog (ready: N parts → M meshes, K kept)
 *         → user confirms → re-plan → worker bake+merge → `doc.mergeMesh(…, payload)`
 *
 * **The condition hangs off the CLICKED TARGET, not off the selection** (plan-372 finding
 * 11). A right-click on a hierarchy row builds a `ContextMenuTarget` and highlights it but
 * does NOT call `selectionManager.select()`, so a "exactly one selected path" condition —
 * the shape the separator uses — would hide the entry on a hierarchy right-click, or
 * silently apply it to a different node.
 */

import type { BufferGeometry, Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { ContextMenuItem } from '../../core/hmi/context-menu-store';
import type { MergeMeshPayload } from '../../core/editor/rv-asset-executors';
import { planMergeMesh, type MergeMeshPlan } from '../../core/editor/rv-asset-document';
import {
  RVMeshMergeClient,
  isMeshMergeAbort,
  type MeshMergeJob,
} from '../../core/editor/rv-mesh-merge-client';
import { showMergePreview } from './editor-dialog-store';
import { getActiveAssetContext } from './active-asset-store';

/**
 * The free half of the eligibility check: a node with no children can never be merged.
 *
 * Everything else — how many meshes are mergeable, whether a source is multi-material,
 * whether a guard hits — needs the subtree walk and is therefore decided in the dialog.
 */
export function isMergeTarget(node: unknown): node is Object3D {
  const candidate = node as Object3D | null;
  return !!candidate && Array.isArray(candidate.children) && candidate.children.length > 0;
}

// ─── Worker client lifecycle ──────────────────────────────────────────────

let _client: RVMeshMergeClient | null = null;

function mergeClient(): RVMeshMergeClient {
  _client ??= new RVMeshMergeClient();
  return _client;
}

/**
 * Abort anything in flight and terminate the worker.
 *
 * Called when the editor mode is left: the document — and with it the geometry a pending
 * request describes — is gone, so any answer still on its way is void.
 */
export function disposeMergeClient(): void {
  _client?.dispose();
  _client = null;
}

// ─── The flow ─────────────────────────────────────────────────────────────

/** "2 anchors, 1 component, 2 by naming convention" — the WHY behind the kept count. */
function summarizeKept(plan: MergeMeshPlan): string {
  let anchors = 0;
  let byName = 0;
  let byComponent = 0;
  for (const kept of plan.classification.kept) {
    if (kept.role === 'anchor') anchors++;
    else if (kept.reason.startsWith('naming convention')) byName++;
    else byComponent++;
  }
  const parts: string[] = [];
  if (anchors > 0) parts.push(`${anchors} kinematic/CAD anchor${anchors === 1 ? '' : 's'}`);
  if (byComponent > 0) parts.push(`${byComponent} with components`);
  if (byName > 0) parts.push(`${byName} by naming convention`);
  return parts.join(', ');
}

/** The bake jobs for one plan, in output order. */
function jobsFor(plan: MergeMeshPlan): MeshMergeJob[] {
  return plan.outputs.map((output, i) => ({
    sources: output.sourceIndices.map((si) => ({
      geometry: plan.sources[si].geometry as BufferGeometry,
      worldMatrix: plan.sources[si].matrixWorld.clone(),
    })),
    ownerWorld: plan.ownerWorlds[i],
  }));
}

/**
 * Classify, confirm, merge. Resolves when the flow is over — including when the user
 * cancelled or the subtree turned out not to be mergeable.
 */
export async function runMergeFlow(viewer: RVViewer, nodePath: string): Promise<void> {
  const doc = getActiveAssetContext()?.doc;
  if (!doc) return;

  const dialog = showMergePreview(leafOf(nodePath));
  const client = mergeClient();

  try {
    const preview = planMergeMesh(viewer, nodePath);
    if (!preview) {
      dialog.setIneligible('this node is no longer in the tree');
      await dialog.confirmed;
      return;
    }
    if (preview.ineligibleReason) {
      dialog.setIneligible(preview.ineligibleReason);
      await dialog.confirmed;
      return;
    }

    dialog.setReady({
      sourceCount: preview.sourcePaths.length,
      outputCount: preview.outputs.length,
      keptCount: preview.kept.length,
      keptSummary: summarizeKept(preview),
    });
    if (!(await dialog.confirmed)) {
      // Cancel abandons the epoch, so a response already on its way is dropped.
      client.cancel();
      return;
    }

    // Re-plan AFTER the confirmation: the dialog was open for an unbounded time, and the
    // expensive half (the bake) must run against the tree as it is now, not as it was.
    const plan = planMergeMesh(viewer, nodePath);
    if (!plan || plan.ineligibleReason) return;

    const geometries = await client.merge(jobsFor(plan));
    const payload: MergeMeshPayload = {
      sources: plan.sources.map((mesh) => ({
        geometry: mesh.geometry as BufferGeometry,
        vertexCount: (mesh.geometry as BufferGeometry).getAttribute('position')?.count ?? -1,
      })),
      geometries,
    };
    const applied = await doc.mergeMesh(nodePath, payload);
    // The replacement mesh took the subtree's path, so selecting it keeps the user where
    // they were — now with one mesh instead of a tree.
    if (applied) viewer.selectionManager?.select(nodePath);
  } catch (e) {
    // A superseded or disposed request is the documented way out, not a failure.
    if (isMeshMergeAbort(e)) return;
    console.error(`[asset-editor] merge "${nodePath}" failed:`, e);
    dialog.close();
  }
}

/**
 * The single context-menu entry — it serves BOTH surfaces.
 *
 * The hierarchy has no context menu of its own: a right-click on a row synthesises a
 * `ContextMenuTarget` and opens the same `viewer.contextMenu` the 3D view uses. So one
 * registration covers requirement F10 without a second UI layer.
 *
 * Built by a factory rather than inlined at the registration site so the test suite can
 * evaluate the REAL condition and action against a target that is not selected.
 */
export function buildMergeMenuItem(viewer: RVViewer): ContextMenuItem {
  return {
    id: 'editor.merge',
    // Static label: a live part count would need the subtree walk while the menu opens.
    label: 'Merge into one mesh…',
    order: 3.6,
    condition: (target) => viewer.modes.activeMode === 'editor' && isMergeTarget(target.node),
    action: (target) => { void runMergeFlow(viewer, target.path); },
  };
}

function leafOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}

