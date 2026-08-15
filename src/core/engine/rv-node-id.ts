// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-id — the second addressing axis next to the scene path.
 *
 * A scene path names a node by the chain of names leading to it. Inside one file
 * that is enough. Across files it is not: rename a node in a library asset and
 * every override written against it by whoever references that asset silently
 * points at nothing. `NodeId` closes that gap (rv-ODT specification §5a).
 *
 * Two ways an id comes to exist, and the difference matters:
 *
 *  - **A file we write** (a scene, an asset authored here) gets a random UUID
 *    stamped on save, and that id is CARRIED THROUGH on every later save.
 *    Regenerating it would orphan every override anyone wrote against the file.
 *
 *  - **A file we only read** — the entire pre-existing Unity export corpus, and
 *    every library asset that must stay byte-identical — gets its ids DERIVED:
 *    `sha256(<file sha256> ':' <glTF node index>)`, truncated. Nothing random is
 *    involved, so the same bytes yield the same ids on every load, in every
 *    session, in any consumer that implements the same rule. Stamping random ids
 *    here would be the bug the plan review caught: they could never be written
 *    back, so they would differ on the next load and the parent's overrides would
 *    all verwaisen.
 *
 * When the referenced file DOES change, the derived ids change with it. That is
 * correct: it is the same case as a renamed node, and it surfaces as an orphaned
 * override rather than as an override silently landing on whatever node inherited
 * the index.
 *
 * ## Why an id alone is not an address
 *
 * `NodeId` is unique within its file and deliberately NOT globally unique. Ten
 * references to the same press produce ten subtrees whose nodes all carry the
 * same ids — they come from the same bytes. The full address is therefore a
 * PAIR: the chain of the reference nodes' ids (the *occurrence address*) plus the
 * node's own id. The occurrence address is computed while composing and is never
 * written into a file; no file has to know where it is installed.
 */

import type { Object3D } from 'three';

/** Reserved key under `extras.realvirtual` / `userData.realvirtual`. */
export const RV_NODE_ID_KEY = 'NodeId';

/**
 * Length of a derived id in hex characters. 16 hex chars = 64 bits: for the
 * per-file uniqueness this needs (a file with a few 100k nodes at most), the
 * collision probability is negligible, and it keeps the id short enough that a
 * whole occurrence chain stays readable in a log line.
 */
const DERIVED_ID_HEX_LENGTH = 16;

/** Separator between the occurrence chain and the node's own id. */
export const ADDRESS_SEPARATOR = '#';

/** The occurrence address of the root file: the empty chain. */
export const ROOT_OCCURRENCE = '';

/**
 * The source key of the root file — the file the scene itself IS.
 *
 * A source key names the FILE a node's glTF index belongs to. Every referenced
 * file gets its own key (its content hash), so a writer can never patch
 * `nodes[7]` of the wrong file. Lives here rather than next to composition
 * because the registry needs it and must not depend on the loader.
 */
export const ROOT_SOURCE_KEY = '';

// ─── Read / write on a node ──────────────────────────────────────────────

/** The `realvirtual` extras bag of a node, or undefined when it has none. */
function extrasOf(node: Object3D): Record<string, unknown> | undefined {
  return (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
}

/** The `realvirtual` extras bag of a node, creating it when absent. */
function ensureExtras(node: Object3D): Record<string, unknown> {
  const ud = node.userData as Record<string, unknown>;
  let rv = ud['realvirtual'] as Record<string, unknown> | undefined;
  if (!rv) {
    rv = {};
    ud['realvirtual'] = rv;
  }
  return rv;
}

/** The `NodeId` stamped on a node, or null when it carries none. */
export function getNodeId(node: Object3D): string | null {
  const id = extrasOf(node)?.[RV_NODE_ID_KEY];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Stamp a `NodeId` onto a node.
 *
 * Deliberately WITHOUT a leading underscore: `sanitizeUserDataForExport` strips
 * every `_`-prefixed key as runtime bookkeeping, and an id that does not survive
 * an export is worse than no id at all — the file would come back with different
 * ids and every override against it would orphan.
 */
export function setNodeId(node: Object3D, id: string): void {
  ensureExtras(node)[RV_NODE_ID_KEY] = id;
}

// ─── Minting ─────────────────────────────────────────────────────────────

/** A fresh random id, for a file we own and will write. */
export function newNodeId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Deliberately simple fallback for environments without randomUUID: the value
  // only has to be unique within one file, and it is persisted immediately.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hex SHA-256 of a string. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The deterministic id of a node in a file we must not modify.
 *
 * Normative derivation (specification §5a) — two independent consumers MUST
 * arrive at the same value, so neither the inputs nor the truncation are free
 * to vary: `first 16 hex of SHA-256(fileSha256 + ':' + nodeIndex)`.
 *
 * @param fileSha256 Lowercase hex SHA-256 of the referenced file's bytes.
 * @param gltfNodeIndex The node's index in the file's glTF `nodes[]` array.
 */
export async function deriveNodeId(fileSha256: string, gltfNodeIndex: number): Promise<string> {
  if (!fileSha256) throw new Error('deriveNodeId: fileSha256 is required — a derived id must hang on the file bytes.');
  if (!Number.isInteger(gltfNodeIndex) || gltfNodeIndex < 0) {
    throw new Error(`deriveNodeId: gltfNodeIndex must be a non-negative integer, got ${gltfNodeIndex}.`);
  }
  const full = await sha256Hex(`${fileSha256.toLowerCase()}:${gltfNodeIndex}`);
  return full.slice(0, DERIVED_ID_HEX_LENGTH);
}

/**
 * Stamp derived ids across a subtree that came from a file we do not write.
 *
 * Nodes that already carry a `NodeId` keep it — an authored id always beats a
 * derived one, which is what lets a producer opt into stable identity simply by
 * writing the field. Nodes with no glTF index (op-created nodes, planner
 * placements) are skipped: they have no position in the source file to derive
 * from, and their identity is the writing file's business, not this one's.
 *
 * @param indexOf Maps a node to its index in the source file's `nodes[]` array
 *   — in practice `collectGltfNodeIndices()`'s map.
 * @returns How many ids were stamped.
 */
export async function deriveNodeIdsForSubtree(
  root: Object3D,
  fileSha256: string,
  indexOf: (node: Object3D) => number | null | undefined,
): Promise<number> {
  const pending: Array<{ node: Object3D; index: number }> = [];
  root.traverse((node) => {
    if (getNodeId(node)) return;
    const index = indexOf(node);
    if (index === null || index === undefined) return;
    pending.push({ node, index });
  });
  const ids = await Promise.all(pending.map((p) => deriveNodeId(fileSha256, p.index)));
  for (let i = 0; i < pending.length; i++) setNodeId(pending[i].node, ids[i]);
  return pending.length;
}

/**
 * Stamp random ids on every node of a subtree that has none — for a file we own.
 *
 * Existing ids are preserved, which is the whole point: this runs on every save,
 * and a node keeps the identity it was first given for as long as it exists.
 *
 * @returns How many ids were newly minted.
 */
export function ensureOwnNodeIds(root: Object3D): number {
  let minted = 0;
  root.traverse((node) => {
    if (getNodeId(node)) return;
    setNodeId(node, newNodeId());
    minted++;
  });
  return minted;
}

// ─── Occurrence addressing ───────────────────────────────────────────────

/**
 * The occurrence address of everything below a reference node.
 *
 * Appends the reference node's own id to the parent chain. The reference node
 * lives in exactly one file, where its id IS unique — which is what makes the
 * chain globally unique without any file knowing where it is installed.
 */
export function childOccurrence(parentOccurrence: string, referenceNodeId: string): string {
  if (!referenceNodeId) throw new Error('childOccurrence: the reference node must carry a NodeId.');
  return parentOccurrence ? `${parentOccurrence}/${referenceNodeId}` : referenceNodeId;
}

/** `<occurrence>#<nodeId>` — the full, globally unique address of a node. */
export function fullNodeAddress(occurrence: string, nodeId: string): string {
  return `${occurrence}${ADDRESS_SEPARATOR}${nodeId}`;
}

/** Split a full address back into its two parts. */
export function parseNodeAddress(address: string): { occurrence: string; nodeId: string } {
  const at = address.lastIndexOf(ADDRESS_SEPARATOR);
  if (at < 0) return { occurrence: ROOT_OCCURRENCE, nodeId: address };
  return { occurrence: address.slice(0, at), nodeId: address.slice(at + 1) };
}

/** The occurrence chain as its individual reference-node ids. */
export function occurrenceSegments(occurrence: string): string[] {
  return occurrence ? occurrence.split('/') : [];
}

/** How deep an occurrence sits — 0 for the root file. */
export function occurrenceDepth(occurrence: string): number {
  return occurrenceSegments(occurrence).length;
}
