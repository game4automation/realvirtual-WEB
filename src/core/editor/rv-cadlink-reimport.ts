// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cadlink-reimport — swap a CAD subtree from a newer revision of the
 * original CAD file while preserving the rv_extras component setup.
 *
 * Matching is by RELATIVE NAME-PATH under the two CAD roots (duplicate sibling
 * names disambiguated by same-name occurrence index — `Bolt#0`, `Bolt#1`),
 * which is stable across re-tessellation because occt names come from the CAD
 * structure itself.
 *
 * The swap is ONE undoable transaction on the AssetDocument:
 *   deleteNode(old root)  → old subtree parks in the trash (undo restores all)
 *   importCad(new root)   → bare geometry, same node name + transform, fresh CADLink
 *   addComponent × N      → every preserved component as its own replay-safe op
 *                           (bare geometry re-materialises by hash on draft
 *                           replay — components must NOT live only in the
 *                           payload tree, or replay would lose them)
 *
 * Old nodes carrying components with NO counterpart in the new tessellation
 * are never silently dropped — they are surfaced in the ReimportReport (and
 * a single undo restores the entire old subtree anyway).
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { AssetDocument } from './rv-asset-document';
import { getCadProvider, cadFormatOfName } from './rv-cad-provider';
import { parseGlbSubtree } from '../engine/rv-glb-parse';
import { assetOpHeader, type CADLinkExtras } from './rv-asset-ops';
import { dedupeSiblingNames } from './rv-asset-executors';
import { deepCloneJSON } from '../ops/rv-op-utils';

export interface ReimportUnmatched {
  /** Relative name-path under the old CAD root. */
  relPath: string;
  /** The rv_extras components that were attached there. */
  components: Record<string, Record<string, unknown>>;
}

export interface ReimportReport {
  /** Old component-bearing nodes whose components were carried over. */
  matched: number;
  /** Old component-bearing nodes with no counterpart in the new tessellation. */
  unmatched: ReimportUnmatched[];
  /** New-tree paths that had no old counterpart (informational). */
  newUnmapped: string[];
}

/**
 * Local match id for a node: the CAD-stable JT handle (`userData.jtHandle`, emitted by the
 * JT reader) when present — so a part matches across a revision even if renamed — otherwise
 * the node name (STEP/occt, whose names come from the CAD structure and are stable). This is
 * why JT re-import keys on the persistent handle, not on node-name + transform.
 */
function localMatchId(o: Object3D): string {
  const h = (o.userData as { jtHandle?: number } | undefined)?.jtHandle;
  return h != null ? ` jtHandle:${h}` : o.name;
}

/**
 * Pure: compute the relative-path map of a CAD subtree. Keys are id-paths relative to (and
 * excluding) `root`, where each segment is {@link localMatchId}; duplicate sibling ids get a
 * `#k` occurrence suffix per parent so every node has a unique key.
 */
export function relativePathMap(root: Object3D): Map<string, Object3D> {
  const map = new Map<string, Object3D>();
  const walk = (parent: Object3D, prefix: string): void => {
    const seen = new Map<string, number>();
    for (const child of parent.children) {
      const id = localMatchId(child);
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      // First occurrence keeps the plain id (the common case); later
      // same-id siblings get the occurrence suffix.
      const key = prefix + (n === 0 ? id : `${id}#${n}`);
      map.set(key, child);
      walk(child, key + '/');
    }
  };
  walk(root, '');
  return map;
}

/**
 * Component types that describe the IMPORTED GEOMETRY rather than a user decision. They are
 * written by the importer on every import, so the freshly tessellated revision already carries
 * the correct values — carrying the old ones over would overwrite new metadata with stale
 * metadata (`_addComponentWithFields` replaces a component wholesale). The new revision wins.
 *
 * `CADLink` itself is handled separately below (it is re-stamped by `importCad`).
 */
const IMPORT_PROVENANCE_TYPES = new Set(['JTData']);

/** Drop import-provenance components from an rv_extras bag (see above). */
function withoutImportProvenance(
  rv: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [type, fields] of Object.entries(rv)) {
    // `JTData_1`-style dedup suffixes belong to the same family.
    const base = type.split('_')[0];
    if (IMPORT_PROVENANCE_TYPES.has(base)) continue;
    out[type] = fields;
  }
  return out;
}

/**
 * Pure: match every old-tree node to its new-tree counterpart by relative
 * name-path (null = no counterpart).
 */
export function matchCadTrees(oldRoot: Object3D, newRoot: Object3D): Map<Object3D, Object3D | null> {
  const oldMap = relativePathMap(oldRoot);
  const newMap = relativePathMap(newRoot);
  const result = new Map<Object3D, Object3D | null>();
  for (const [path, oldNode] of oldMap) {
    result.set(oldNode, newMap.get(path) ?? null);
  }
  return result;
}

/**
 * Where to re-attach a carried-over component, in order of trustworthiness.
 *
 * 1. The registry's own path for the inserted node. Authoritative: it is the path the rest of
 *    the editor uses for this exact object, whatever its key looked like.
 * 2. The key rebuilt as a path (`#k` stripped). Only correct when `localMatchId` fell back to
 *    the node name — STEP and other name-keyed trees. Kept as a fallback so those keep working
 *    even if a node never reached the registry.
 *
 * Returns null when neither resolves, so the caller can report instead of writing into the void.
 */
function resolveCarryOverPath(
  viewer: RVViewer, rootPath: string, relPath: string, newNode: Object3D,
): string | null {
  const registered = viewer.registry?.getPathForNode(newNode);
  if (registered) return registered;
  const byName = `${rootPath}/${relPath.replace(/#\d+/g, '')}`;
  return viewer.registry?.getNode(byName) ? byName : null;
}

/**
 * Re-import a CAD root from a new file revision. Tessellates via the
 * registered CadGeometryProvider, swaps the subtree as one undoable
 * transaction, and returns the preservation report.
 */
export async function reimportCad(
  viewer: RVViewer,
  doc: AssetDocument,
  cadRootPath: string,
  file: File,
  quality: string,
): Promise<ReimportReport> {
  const provider = getCadProvider(cadFormatOfName(file.name));
  if (!provider) {
    throw new Error(
      `No CAD geometry provider registered for ${cadFormatOfName(file.name).toUpperCase()} (private build required)`,
    );
  }

  const oldRoot = viewer.registry?.getNode(cadRootPath);
  if (!oldRoot) throw new Error(`CAD root not found: ${cadRootPath}`);

  // ── The base swap starts HERE, not at the transaction (plan-710 §2.4) ──
  //
  // Everything below until `endBaseSwap` is preparation against the OUTGOING
  // tree, and it takes seconds (tessellation, GLB parse). An edit the user
  // makes in that window targets nodes the transaction is about to delete: it
  // would be applied to a tree on its way out and recorded into the history of
  // the tree coming in. The gate refuses those ops inside the queue — the same
  // contract `SceneStore` has had against a scene load.
  doc.beginBaseSwap();
  let glb: ArrayBuffer;
  let cadlink: CADLinkExtras;
  let newRoot: Object3D;
  let oldMap: Map<string, Object3D>;
  let newMap: Map<string, Object3D>;
  try {
    ({ glb, cadlink } = await provider.importFile(file, quality));
    // Parse the converted GLB once: this tree is BOTH what we diff the old
    // revision against and what the document inserts (handed over via opts.root),
    // so the matching is done on exactly the nodes that end up in the scene.
    newRoot = await parseGlbSubtree(glb);

    // Same sibling-name dedup the importCad executor applies at insertion —
    // done BEFORE matching so old tree (deduped at its own import) and new
    // tree carry identical unique names and carry-over paths target the right
    // instance. The executor re-run on this root is an idempotent no-op.
    dedupeSiblingNames(newRoot);

    // Collect the preservation work BEFORE any mutation.
    oldMap = relativePathMap(oldRoot);
    newMap = relativePathMap(newRoot);
  } finally {
    // Unconditionally: a gate left standing would silently swallow every later
    // edit, which is worse than the hazard it guards. The re-import's own ops
    // run after this point and must apply.
    doc.endBaseSwap();
  }
  const report: ReimportReport = { matched: 0, unmatched: [], newUnmapped: [] };

  /**
   * Components to re-attach, carrying the matched NEW NODE itself — not just its key.
   *
   * The node is what makes the re-attach reliable. Keys are built from `localMatchId`, which
   * for JT nodes is the stable handle rather than the name; turning such a key back into a
   * scene path would address `jtHandle:243` where the scene has the part name, and the add
   * would find nothing. Since `newRoot` is the very tree the document inserts (see `opts.root`
   * below), asking the registry for this node's real path after insertion always works.
   */
  const carryOver: Array<{
    relPath: string;
    newNode: Object3D;
    components: Record<string, Record<string, unknown>>;
  }> = [];
  for (const [relPath, oldNode] of oldMap) {
    const rv = oldNode.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    if (!rv || Object.keys(rv).length === 0) continue;
    const carried = withoutImportProvenance(rv);
    if (Object.keys(carried).length === 0) continue;
    const newNode = newMap.get(relPath);
    if (newNode) {
      carryOver.push({ relPath, newNode, components: deepCloneJSON(carried) });
    } else {
      report.unmatched.push({ relPath, components: deepCloneJSON(carried) });
    }
  }
  for (const relPath of newMap.keys()) {
    if (!oldMap.has(relPath)) report.newUnmapped.push(relPath);
  }
  // Root-level components (everything except the CADLink itself) carry over too.
  const oldRootRv = (oldRoot.userData?.realvirtual ?? {}) as Record<string, Record<string, unknown>>;
  const rootCarryOver: Record<string, Record<string, unknown>> = {};
  for (const [type, fields] of Object.entries(withoutImportProvenance(oldRootRv))) {
    if (type === 'CADLink' || type.startsWith('CADLink_')) continue;
    rootCarryOver[type] = deepCloneJSON(fields);
  }

  // New root inherits the OLD root's name + local transform.
  const oldName = oldRoot.name;
  newRoot.position.copy(oldRoot.position);
  newRoot.quaternion.copy(oldRoot.quaternion);
  newRoot.scale.copy(oldRoot.scale);

  await doc.withTransaction(`Re-import ${file.name}`, async () => {
    // Delete first so the old node name is free for the new root. importCad
    // computes its unique child name at OP-CREATION time, so the delete must
    // have EXECUTED (queue drained) before it — otherwise the new root would
    // be suffixed (`Gearbox_1`) while the old one still occupies the name.
    doc.deleteNode(cadRootPath);
    await doc.whenIdle();
    const rootPath = await doc.importCad({ glb, cadlink }, { name: oldName, root: newRoot });

    for (const [type, fields] of Object.entries(rootCarryOver)) {
      await doc.applyOp({
        ...assetOpHeader(), kind: 'addComponent',
        nodePath: rootPath, componentType: type, fields,
      });
    }
    // The inserted tree must be registered before its nodes can be addressed.
    await doc.whenIdle();

    for (const entry of carryOver) {
      const nodePath = resolveCarryOverPath(viewer, rootPath, entry.relPath, entry.newNode);
      if (!nodePath) {
        // Never drop components silently: `addComponent` on an unknown path is a no-op, so an
        // unresolvable target would look like a successful carry-over in the report while the
        // user's configuration is gone. Report it as unmatched — same meaning to the user
        // (these components did not make it across), and the existing dialog already shows it.
        report.unmatched.push({ relPath: entry.relPath, components: entry.components });
        continue;
      }
      for (const [type, fields] of Object.entries(entry.components)) {
        await doc.applyOp({
          ...assetOpHeader(), kind: 'addComponent',
          nodePath, componentType: type, fields,
        });
      }
      report.matched++;
    }
  });

  return report;
}
