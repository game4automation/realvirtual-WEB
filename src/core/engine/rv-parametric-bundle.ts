// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-650 Phase 5b — child families travel WITH their parent ("Weitergeben =
 * eine Datei").
 *
 * A family that places child families (`ParametricComponent.Uses`) is shared
 * as ONE GLB: the share export appends every child family document as a
 * bufferView of the parent's BIN chunk (the plan-498 binary-resource pattern,
 * `rebuildGlbAppendingBufferViews`) and lists them in
 * `asset.extras.realvirtual.parametricChildren`. Children of children are
 * collected transitively and bundled FLAT next to them (each family once,
 * cycle-safe), so the import unpacks the whole tree into the project library.
 *
 * A child the export has no bytes for is reported (`missing`), never invented;
 * at load time a child that is still absent is the Problems entry
 * `parametric-child-missing` and the parent variant stays standing.
 *
 * Pure byte functions, no viewer / library access — the callers bring the
 * lookup and the write.
 */

import { extractGlbBufferViews, readGlbJson, rebuildGlbAppendingBufferViews } from './rv-binary-resources';
import { sha256HexBytes } from './rv-parametric-hash';
import { PARAMETRIC_COMPONENT_TYPE, type ParametricUse } from './rv-parametric-component';
import { RV_NODE_ID_KEY } from './rv-node-id';

/** Key of the bundle manifest in `asset.extras.realvirtual`. */
export const PARAMETRIC_CHILDREN_MANIFEST_KEY = 'parametricChildren';

/** One bundled child family in the manifest. */
export interface BundledChildRecord {
  Family: string;
  DocHash: string;
  Path?: string;
  bufferView: number;
  byteLength: number;
}

/** One unpacked child family document. */
export interface UnpackedChildFamily {
  Family: string;
  DocHash: string;
  Path?: string;
  bytes: Uint8Array;
}

export interface BundleResult {
  glb: Uint8Array;
  /** Families embedded (this level and below). */
  bundled: string[];
  /** Declared families the lookup had no bytes for. */
  missing: string[];
}

type Json = Record<string, unknown>;
const isRec = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function rvOfNode(node: unknown): Json | null {
  if (!isRec(node) || !isRec(node.extras) || !isRec(node.extras.realvirtual)) return null;
  return node.extras.realvirtual;
}

/** Every declared child family (`Uses`) of every family node in a GLB's JSON, unique by `Family`. */
export function declaredUsesOf(json: Json | null): ParametricUse[] {
  const out = new Map<string, ParametricUse>();
  const nodes = Array.isArray(json?.nodes) ? json!.nodes as unknown[] : [];
  for (const n of nodes) {
    const pc = rvOfNode(n)?.[PARAMETRIC_COMPONENT_TYPE];
    if (!isRec(pc) || !Array.isArray(pc.Uses)) continue;
    for (const u of pc.Uses) {
      if (!isRec(u) || typeof u.Family !== 'string' || typeof u.DocHash !== 'string' || typeof u.FamilyNodeId !== 'string') continue;
      if (out.has(u.Family)) continue;
      const use: ParametricUse = { Family: u.Family, FamilyNodeId: u.FamilyNodeId, DocHash: u.DocHash };
      if (typeof u.Path === 'string') use.Path = u.Path;
      out.set(u.Family, use);
    }
  }
  return [...out.values()];
}

/** The bundle manifest of a GLB (empty when none). */
export function bundledChildrenOf(json: Json | null): BundledChildRecord[] {
  const asset = isRec(json?.asset) ? json!.asset as Json : null;
  const rv = asset && isRec(asset.extras) && isRec(asset.extras.realvirtual) ? asset.extras.realvirtual : null;
  const list = rv?.[PARAMETRIC_CHILDREN_MANIFEST_KEY];
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is BundledChildRecord =>
    isRec(r) && typeof r.Family === 'string' && typeof r.DocHash === 'string'
    && typeof r.bufferView === 'number' && typeof r.byteLength === 'number');
}

/**
 * Derive a `Uses` entry from a child family document: `DocHash` = SHA-256 of
 * its bytes, `FamilyNodeId` = the NodeId of its (first) family node. Throws
 * when the document has no parametric family or the family node no NodeId.
 */
export async function familyUseFromGlb(bytes: Uint8Array, family: string, path?: string): Promise<ParametricUse> {
  const json = readGlbJson(bytes);
  if (!json) throw new Error(`"${family}" is not a readable GLB`);
  const nodes = Array.isArray(json.nodes) ? json.nodes as unknown[] : [];
  let nodeId: string | null = null;
  for (const n of nodes) {
    const rv = rvOfNode(n);
    if (!rv || !isRec(rv[PARAMETRIC_COMPONENT_TYPE])) continue;
    const id = rv[RV_NODE_ID_KEY];
    if (typeof id === 'string' && id) { nodeId = id; break; }
    throw new Error(`the family node of "${family}" has no NodeId - save the child family once in the editor`);
  }
  if (!nodeId) throw new Error(`"${family}" contains no parametric family`);
  const use: ParametricUse = { Family: family, FamilyNodeId: nodeId, DocHash: await sha256HexBytes(bytes) };
  if (path) use.Path = path;
  return use;
}

/**
 * Bundle every child family `glb` needs - its declared `Uses` and, through
 * `lookup`, their `Uses` in turn - FLAT into `glb`: each family once, its
 * bytes verbatim (so `DocHash` stays the SHA of exactly those bytes). Cycles
 * end at the first repeat. A GLB without `Uses` comes back unchanged.
 */
export function bundleChildFamilies(
  glb: Uint8Array,
  lookup: (use: ParametricUse) => Uint8Array | null | undefined,
): BundleResult {
  const bundled: string[] = [];
  const missing: string[] = [];
  const records: Omit<BundledChildRecord, 'bufferView'>[] = [];
  const payloads: Uint8Array[] = [];
  const seen = new Set<string>();
  const queue = [...declaredUsesOf(readGlbJson(glb))];
  while (queue.length > 0) {
    const use = queue.shift()!;
    if (seen.has(use.Family)) continue;
    seen.add(use.Family);
    const bytes = lookup(use);
    if (!bytes) { missing.push(use.Family); continue; }
    bundled.push(use.Family);
    const rec: Omit<BundledChildRecord, 'bufferView'> = { Family: use.Family, DocHash: use.DocHash, byteLength: bytes.byteLength };
    if (use.Path) rec.Path = use.Path;
    records.push(rec);
    payloads.push(bytes);
    queue.push(...declaredUsesOf(readGlbJson(bytes)));
  }
  if (payloads.length === 0) return { glb, bundled, missing };
  const out = rebuildGlbAppendingBufferViews(glb, payloads, (json, indices) => {
    const asset = (isRec(json.asset) ? json.asset : (json.asset = { version: '2.0' })) as Json;
    const extras = (isRec(asset.extras) ? asset.extras : (asset.extras = {})) as Json;
    const rv = (isRec(extras.realvirtual) ? extras.realvirtual : (extras.realvirtual = {})) as Json;
    rv[PARAMETRIC_CHILDREN_MANIFEST_KEY] = records.map((r, i) => ({ ...r, bufferView: indices[i] }));
  });
  return { glb: out, bundled, missing };
}

/**
 * Unpack the bundled child families of `glb` (flat, manifest order). The
 * import writes them into the project library.
 */
export function unpackChildFamilies(glb: Uint8Array): UnpackedChildFamily[] {
  const records = bundledChildrenOf(readGlbJson(glb));
  const out: UnpackedChildFamily[] = [];
  for (const rec of records) {
    const [slice] = extractGlbBufferViews(glb, [{ bufferView: rec.bufferView, byteLength: rec.byteLength, sha256: rec.DocHash }]);
    if (!slice) continue;
    const child: UnpackedChildFamily = { Family: rec.Family, DocHash: rec.DocHash, bytes: slice.bytes };
    if (rec.Path) child.Path = rec.Path;
    out.push(child);
  }
  return out;
}

/** Declared child families of `glb` that `has` does not know - the `parametric-child-missing` candidates. */
export function missingChildFamilies(glb: Uint8Array, has: (family: string) => boolean): string[] {
  return declaredUsesOf(readGlbJson(glb)).map((u) => u.Family).filter((f) => !has(f));
}
