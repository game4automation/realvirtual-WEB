// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-subtree-instantiate — THE way a subtree is copied with identity (plan-769 F10,
 * Phase 2): Unity's Ctrl+D (D9) for the editor, and the `share` mode a file instance
 * uses.
 *
 *  - **`share`** — the copy keeps the source's ids (an INSTANCE of the same file: the
 *    occurrence chain tells the instances apart, `BakeRegistry.instantiate`).
 *  - **`fresh`** — a DUPLICATE: every copied node loses the source's identity (the
 *    seeded `_rvNodeId` AND an authored `realvirtual.NodeId`) and gets a new UUIDv4
 *    under the runtime key {@link RV_SEEDED_NODE_ID_KEY}. A stored reference INSIDE the
 *    copy that pointed into the copied subtree follows the copy (B'→A'); one that
 *    pointed outside stays where it was.
 *
 * **Determinism (replay, undo/redo, multiuser):** the new ids are a {@link NodeIdMap}
 * (source key → new id). An op carries it in its payload: the first apply mints the
 * missing entries and hands the completed map back, every later apply (redo after a
 * trash flush, draft replay, a remote peer) passes it in and gets the SAME ids. The key
 * of a copied node is its source identity id; a node without one (an empty an op
 * built, a separated part, a merge output) is keyed by the caller (`node`,
 * `part:<i>`, `output:<i>`, `@<preorder index>`).
 *
 * **Nothing is persisted (F17, Phase 2):** the new ids live under the RUNTIME key the
 * sanitizer strips on save. The op log stays path-based (D15); the id map rides
 * alongside it in the op payload. Phase 3's writer promotes the ids into the file.
 *
 * **References.** Phase 2 writes no address (Phase 3 does). A reference in the copy that
 * follows the copy is therefore re-spelled as a PATH to the copy's node (by default:
 * the written path with the copied root's segment replaced — the same spelling, one
 * segment changed), i.e. a path the web wrote in this session (`web-written`, read
 * through the reader's own lookup until Phase 3 writes addresses). A NAME field
 * (`Source.ThisObjectAsMU`) needs no rewrite: it names a node in its owner's
 * subtree, and a web-created owner is not a node of any file (`NodeRegistry`
 * resolves its names through the reader's subtree lookup).
 *
 * Clones that are NO node of any document (ghost, preview, highlight, spawned MU)
 * do not come here: they call `stripIdentity` and are never registered (Phase 1b).
 */

import type { Object3D } from 'three';
import { RV_SEEDED_NODE_ID_KEY } from './rv-authored-keys';
import { identityIdOf, stripIdentity } from './rv-decode-identity';
import { ADDRESS_SEPARATOR, newNodeId, parseNodeAddress } from './rv-node-id';
import { visitReferences, type VisitedReference } from './rv-node-path-rewrite.mjs';

/** Source key → new id of a fresh instantiation; rides in the op payload (replay). */
export type NodeIdMap = Record<string, string>;

/** Options of {@link instantiateSubtree}. */
export interface InstantiateSubtreeOptions {
  /** `share` = keep the source ids (file instance); `fresh` = new ids + internal refs follow (duplicate). */
  ids: 'share' | 'fresh';
  /** `fresh`: the map an earlier apply minted (replay) — entries present are reused, missing ones minted. */
  idMap?: Readonly<NodeIdMap> | null;
  /** The structural copy (default `source.clone(true)`); must keep the node structure 1:1. */
  clone?: (source: Object3D) => Object3D;
  /** Place the copy in the scene (name, parent, index, matrices) BEFORE references are re-spelled. */
  attach?: (copy: Object3D) => void;
  /**
   * `fresh`: the node a stored reference of a SOURCE node names (as the source reads
   * it), or null. Without it references are left as they are.
   */
  resolveTarget?: (sourceReferrer: Object3D, ref: VisitedReference) => Object3D | null;
  /**
   * `fresh`: the written path for a reference that now names `copyTarget` (inside the
   * copy). `defaultPath` is the written path with the copied root's segment replaced
   * (null when the written path does not reach the copied root, or the copy has
   * another parent than the source). Return null to leave the reference as it is.
   */
  spellPath?: (args: {
    written: string;
    sourceTarget: Object3D;
    copyTarget: Object3D;
    copyReferrer: Object3D;
    defaultPath: string | null;
  }) => string | null;
  /** Register the copy's ids (after `attach`): the registry's document-occurrence upkeep. */
  register?: (copy: Object3D) => void;
}

/** What {@link instantiateSubtree} produced. */
export interface InstantiatedSubtree {
  root: Object3D;
  /** The complete id map (`share`: identity). Hand it back to the op payload. */
  idMap: NodeIdMap;
  /** Source node → its copy (preorder pairs). */
  pairs: Map<Object3D, Object3D>;
  /** How many stored references were re-spelled onto the copy. */
  referencesFollowed: number;
}

/** Preorder list of a subtree (the order keys and pairs are taken in). */
function preorder(root: Object3D): Object3D[] {
  const out: Object3D[] = [];
  const walk = (n: Object3D): void => { out.push(n); for (const c of n.children) walk(c); };
  walk(root);
  return out;
}

/**
 * Give `node` a NEW identity `id` — the authored id and the seed go, the runtime key
 * carries the new one (never persisted, F17). The node itself only, not its subtree.
 */
export function assignRuntimeIdentity(node: Object3D, id: string): void {
  const ud = node.userData as Record<string, unknown>;
  const rv = ud.realvirtual as Record<string, unknown> | undefined;
  if (rv && typeof rv === 'object' && 'NodeId' in rv) {
    const next = { ...rv };
    delete next.NodeId;
    ud.realvirtual = next;
  }
  ud[RV_SEEDED_NODE_ID_KEY] = id;
}

/**
 * plan-769 Phase 2 (F11/F12): a planner placement root's identity is its RECORD id —
 * what the planner save writes as the reference node's `NodeId`. An authored NodeId (a
 * placement the file already holds, written with that very id) is kept; otherwise
 * the runtime key carries the record id, replacing whatever the instance brought
 * along (an asset root's seed is the CONTENT's id, never the placement's). Returns
 * the root's identity id.
 */
export function adoptPlacementIdentity(root: Object3D, placementId: string): string {
  const authored = (root.userData?.realvirtual as Record<string, unknown> | undefined)?.NodeId;
  if (typeof authored === 'string' && authored.length > 0) return authored;
  if (typeof placementId !== 'string' || placementId.length === 0) return identityIdOf(root) ?? '';
  (root.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = placementId;
  return placementId;
}

/**
 * The id `key` maps to in `idMap`, minting (and recording) one when absent — the one
 * spot an op's payload map grows. Deterministic for a map that already holds `key`.
 */
export function mintFromIdMap(idMap: NodeIdMap, key: string): string {
  const have = idMap[key];
  if (typeof have === 'string' && have.length > 0) return have;
  const id = newNodeId();
  idMap[key] = id;
  return id;
}

/**
 * `fresh` identities for a subtree IN PLACE (no copy): every node gets the id its key
 * maps to (key = its current identity id, else `@<preorder index>`). For trees an op
 * decoded itself (an `importCad` root: the CAD file's seeds are file-relative, a second
 * import of the same file would collide). Returns the completed map.
 */
export function reidentifySubtree(root: Object3D, idMap?: Readonly<NodeIdMap> | null): NodeIdMap {
  const out: NodeIdMap = { ...(idMap ?? {}) };
  const used = new Set<string>();
  preorder(root).forEach((node, i) => {
    let key = identityIdOf(node) ?? `@${i}`;
    if (used.has(key)) key = `@${i}`;
    used.add(key);
    assignRuntimeIdentity(node, mintFromIdMap(out, key));
  });
  return out;
}

/** Path segments of a written reference path (`/`-split, empty segments dropped). */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * The written path with the segment of the copied root replaced by the copy's name:
 * the last `depth + 1` segments of `written` name the target and its ancestors up to
 * the source root (`depth` = steps from the root down to the target).
 */
function substituteRootSegment(written: string, depth: number, copyRootName: string): string | null {
  const segs = segmentsOf(written);
  const at = segs.length - 1 - depth;
  if (at < 0) return null;
  segs[at] = copyRootName;
  const lead = written.startsWith('/') ? '/' : '';
  return lead + segs.join('/');
}

/** Steps from `root` down to `node` (0 = the root itself), or -1 when not inside. */
function depthBelow(node: Object3D, root: Object3D): number {
  let d = 0;
  for (let n: Object3D | null = node; n; n = n.parent, d++) if (n === root) return d;
  return -1;
}

/**
 * Copy `source` with identity — see the module doc. The copy is NOT registered by
 * itself: pass `register` (or register it yourself after `attach`).
 */
export function instantiateSubtree(source: Object3D, opts: InstantiateSubtreeOptions): InstantiatedSubtree {
  const copy = (opts.clone ?? ((s: Object3D) => s.clone(true)))(source);
  const src = preorder(source);
  const dst = preorder(copy);
  if (src.length !== dst.length) {
    throw new Error(`instantiateSubtree: the clone has ${dst.length} nodes, the source ${src.length}`);
  }
  const pairs = new Map<Object3D, Object3D>();
  for (let i = 0; i < src.length; i++) pairs.set(src[i]!, dst[i]!);

  let idMap: NodeIdMap;
  if (opts.ids === 'share') {
    idMap = {};
    for (const n of src) { const id = identityIdOf(n); if (id) idMap[id] = id; }
  } else {
    idMap = { ...(opts.idMap ?? {}) };
    const used = new Set<string>();
    for (let i = 0; i < src.length; i++) {
      // A malformed source with one id twice: the second gets its position as key.
      let key = identityIdOf(src[i]!) ?? `@${i}`;
      if (used.has(key)) key = `@${i}`;
      used.add(key);
      const node = dst[i]!;
      stripIdentity(node);
      // stripIdentity walks the subtree — fine in preorder: every descendant is
      // re-stamped on its own turn right after.
      assignRuntimeIdentity(node, mintFromIdMap(idMap, key));
    }
  }

  opts.attach?.(copy);

  let referencesFollowed = 0;
  if (opts.ids === 'fresh' && opts.resolveTarget) {
    const sameParent = copy.parent === source.parent;
    for (let i = 0; i < src.length; i++) {
      const srcNode = src[i]!;
      const copyNode = dst[i]!;
      const extras = copyNode.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!extras || typeof extras !== 'object') continue;
      // Positions are visited on the COPY's extras (their setters write the copy) and
      // resolved as the SOURCE reads the same value.
      const edits: Array<{ ref: VisitedReference; next: string }> = [];
      const addressEdits: Array<{ ref: VisitedReference; address: string }> = [];
      visitReferences(extras, (ref) => {
        // A name field AS A NAME needs no rewrite (it names a node in its owner's subtree);
        // as a stored address (plan-769 Phase 3) it follows the copy like any address.
        if (ref.kind === 'name' && ref.form !== 'address') return;
        if (ref.form === 'address') {
          // plan-769 Phase 3: an address into the copied subtree follows the copy by id
          // (D9: B'→A'); one into another occurrence, or outside the copy, stays.
          const target = opts.resolveTarget!(srcNode, ref);
          const copyTarget = target ? pairs.get(target) : undefined;
          const copyId = copyTarget ? identityIdOf(copyTarget) : null;
          if (copyId && parseNodeAddress(ref.address!).occurrence === '') {
            const next = `${ADDRESS_SEPARATOR}${copyId}`;
            if (next !== ref.address) addressEdits.push({ ref, address: next });
          }
          return;
        }
        if (!ref.path) return;
        const target = opts.resolveTarget!(srcNode, ref);
        if (!target) return;
        const copyTarget = pairs.get(target);
        if (!copyTarget) return; // points outside the copied subtree: stays (D9)
        const depth = depthBelow(target, source);
        const defaultPath = sameParent && depth >= 0 ? substituteRootSegment(ref.path, depth, copy.name) : null;
        const next = opts.spellPath
          ? opts.spellPath({ written: ref.path, sourceTarget: target, copyTarget, copyReferrer: copyNode, defaultPath })
          : defaultPath;
        if (next && next !== ref.path) edits.push({ ref, next });
      });
      for (const { ref, address } of addressEdits) {
        ref.set({ ...(ref.value as Record<string, unknown>), address });
        referencesFollowed++;
      }
      if (edits.length === 0) continue;
      // The clone's userData is a JSON copy: writing into it never reaches the source.
      for (const { ref, next } of edits) {
        if (ref.kind === 'ref') ref.set({ ...(ref.value as Record<string, unknown>), path: next });
        else if (ref.record) ref.set({ ...(ref.value as Record<string, unknown>), path: next });
        else ref.set(next);
        referencesFollowed++;
      }
    }
  }

  opts.register?.(copy);
  return { root: copy, idMap, pairs, referencesFollowed };
}
