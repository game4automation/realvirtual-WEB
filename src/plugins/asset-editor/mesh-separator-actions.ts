// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mesh-separator-actions — the "Separate ▸" branch of the editor context menu
 * (plan-331, Phase 3).
 *
 * The order of work here is the whole point. Context-menu resolvers run
 * SYNCHRONOUSLY while the menu opens, so {@link buildSeparateMenuItems} must not
 * analyze anything — it only asks the two questions that are free (is this a
 * mesh, does it have material groups) and returns static labels. Everything
 * expensive happens after the click, off the main thread, behind the preview
 * dialog:
 *
 *   click → dialog (busy) → worker `analyze` → dialog (ready: N parts)
 *         → user confirms → worker `extract` → `doc.separateMesh(…, payload)`
 *
 * The analysis result is carried into the op rather than recomputed, and the
 * executor identity-checks it against the live geometry before trusting it.
 */

import type { BufferGeometry, Mesh } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { ContextMenuItem, ContextMenuTarget } from '../../core/hmi/context-menu-store';
import type { SeparateMeshPayload } from '../../core/editor/rv-asset-executors';
import {
  DEFAULT_WELD_THRESHOLD,
  REASON_MULTI_MATERIAL,
  REASON_SINGLE_PART,
  groupModeIneligibility,
  unsupportedMeshShapeReason,
  type SeparateMode,
} from '../../core/editor/rv-mesh-separator';
import {
  RVMeshSeparatorClient,
  isMeshSeparatorAbort,
} from '../../core/editor/rv-mesh-separator-client';
import { showSeparatePreview } from './editor-dialog-store';
import { getActiveAssetContext } from './active-asset-store';

/** True when the node is a plain mesh the separator could even look at. */
export function isSeparableTarget(node: unknown): node is Mesh {
  return !!(node as { isMesh?: boolean } | null)?.isMesh;
}

/** True when the mesh carries a group table worth offering the group mode for. */
function hasMaterialGroups(mesh: Mesh): boolean {
  return ((mesh.geometry as BufferGeometry | undefined)?.groups?.length ?? 0) >= 2;
}

/**
 * The two leaf items under "Separate ▸".
 *
 * Static labels on purpose: a live part count would have to run the union-find
 * while the menu is opening, and the menu resolver has no way to wait.
 */
export function buildSeparateMenuItems(
  viewer: RVViewer,
  target: ContextMenuTarget,
): ContextMenuItem[] {
  const mesh = target.node;
  if (!isSeparableTarget(mesh)) return [];
  const items: ContextMenuItem[] = [
    {
      id: 'editor.separate.islands',
      label: 'Into parts…',
      order: 1,
      action: () => { void runSeparateFlow(viewer, target.path, 'islands'); },
    },
  ];
  if (hasMaterialGroups(mesh)) {
    items.push({
      id: 'editor.separate.groups',
      label: 'By material group…',
      order: 2,
      action: () => { void runSeparateFlow(viewer, target.path, 'groups'); },
    });
  }
  return items;
}

// ─── Worker client lifecycle ──────────────────────────────────────────────

let _client: RVMeshSeparatorClient | null = null;

function separatorClient(): RVMeshSeparatorClient {
  _client ??= new RVMeshSeparatorClient();
  return _client;
}

/**
 * Abort anything in flight and terminate the worker.
 *
 * Called when the editor mode is left: the document (and with it the geometry
 * a pending request describes) is gone, so any answer still on its way is void.
 */
export function disposeSeparatorClient(): void {
  _client?.dispose();
  _client = null;
}

// ─── The flow ─────────────────────────────────────────────────────────────

/** The cheap, synchronous half of the eligibility check — no union-find. */
function shapeIneligibility(mesh: Mesh, mode: SeparateMode): string | null {
  if (mode === 'groups') return groupModeIneligibility(mesh);
  const shape = unsupportedMeshShapeReason(mesh);
  if (shape) return shape;
  return Array.isArray(mesh.material) ? REASON_MULTI_MATERIAL : null;
}

/**
 * Analyze, confirm, split. Resolves when the flow is over — including when the
 * user cancelled or the mesh turned out not to be separable.
 */
export async function runSeparateFlow(
  viewer: RVViewer,
  nodePath: string,
  mode: SeparateMode,
): Promise<void> {
  const doc = getActiveAssetContext()?.doc;
  const mesh = viewer.registry?.getNode(nodePath) ?? null;
  if (!doc || !isSeparableTarget(mesh)) return;

  const geometry = mesh.geometry as BufferGeometry;
  const dialog = showSeparatePreview(mesh.name || leafOf(nodePath), mode);
  const client = separatorClient();

  try {
    const reason = shapeIneligibility(mesh, mode);
    if (reason) {
      dialog.setIneligible(reason);
      await dialog.confirmed;
      return;
    }

    const partitions = await client.analyze(geometry, mode, DEFAULT_WELD_THRESHOLD);
    if (partitions.length < 2) {
      dialog.setIneligible(REASON_SINGLE_PART);
      await dialog.confirmed;
      return;
    }

    dialog.setReady(partitions.length);
    if (!(await dialog.confirmed)) {
      // Cancel abandons the epoch, so a response already on its way is dropped.
      client.cancel();
      return;
    }

    const geometries = await client.extract(geometry, partitions);
    const payload: SeparateMeshPayload = {
      sourceGeometry: geometry,
      vertexCount: geometry.getAttribute('position')?.count ?? -1,
      partitions,
      geometries,
    };
    await doc.separateMesh(nodePath, mode, undefined, payload);
    // The Group took the source's path, so selecting it keeps the user where
    // they were — now with the parts one level below.
    viewer.selectionManager?.select(nodePath);
  } catch (e) {
    // A superseded or disposed request is the documented way out, not a failure.
    if (isMeshSeparatorAbort(e)) return;
    console.error(`[asset-editor] separate "${nodePath}" failed:`, e);
    dialog.close();
  }
}

function leafOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}
