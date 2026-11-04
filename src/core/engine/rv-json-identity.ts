// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-json-identity — ids and addresses for a GLB the writer holds as JSON (plan-769
 * Phase 3b, F1/F2): the planner save (`bakeIntoGlb`, both the JSON-patch fast path and
 * the re-exported full path) and every other writer that ends in a glTF JSON chunk.
 *
 * The editor export works on the live tree (`rv-reference-writer.ts`); a planner save
 * works on the FILE — the source bytes plus the materialised edits — so its pass reads
 * the file's own JSON, exactly as the decode does:
 *
 *  1. **Ids.** `seedNodeIdsForFile` over the final JSON: an id the file carries stays,
 *     every other reachable node gets the seed of its canonical authored path. Seeds are
 *     path-based (order-independent), so they equal what the viewer seeded at load for
 *     every node the source had; placements and op-created nodes carry their ids already
 *     (record id / `idMap.node`). A duplicated id is re-minted deterministically on every
 *     node but the first (`node-id-duplicate-reminted`).
 *  2. **References.** Every stored reference position (`visitReferences`: ComponentReference,
 *     PATH_FIELDS, NAME fields) in PATH form is migrated through the file's authored index
 *     (the migration on load: as written, content root, root-stripped — never a guess) to
 *     `{ address }`, else kept as `{ unresolvedPath, reason }`. Address forms stay.
 *     `AssetOverrides` (relative to another asset) and content of foreign (referenced)
 *     nodes are not entered.
 *  3. `scenes[0].extras.realvirtual.idVersion = 1`.
 */

import { seedNodeId, seedNodeIdsForFile } from './rv-node-id-seed.mjs';
import {
  createMigrationContext,
  insideReferenceJson,
  listReferrers,
  sceneParents,
  type MigrationGltfJson,
} from './rv-reference-migration.mjs';
import { visitReferences } from './rv-node-path-rewrite.mjs';
import { ADDRESS_SEPARATOR, RV_NODE_ID_KEY } from './rv-node-id';
import { ID_VERSION_CURRENT, ID_VERSION_KEY } from './rv-decode-identity';
import { canonicalizeAssetOverridesIn } from './rv-asset-reference';

/** What {@link stampJsonIdentity} did to one file. */
export interface JsonIdentityReport {
  nodes: number;
  /** Ids written now (a seed, or a re-minted duplicate). */
  written: number;
  reminted: Array<{ index: number; id: string; reminted: string; name: string }>;
  references: number;
  addresses: number;
  unresolved: number;
}

type JsonNode = { name?: string; extras?: Record<string, unknown> };

function rvOf(holder: { extras?: Record<string, unknown> }): Record<string, unknown> {
  const extras = (holder.extras ??= {});
  const rv = extras['realvirtual'];
  if (rv && typeof rv === 'object' && !Array.isArray(rv)) return rv as Record<string, unknown>;
  const fresh: Record<string, unknown> = {};
  extras['realvirtual'] = fresh;
  return fresh;
}

/**
 * plan-769 Phase 3b — a writer that serialises a LIVE tree without the editor export's
 * sanitizer (the scene store's take-away export with embedded references) carries the
 * runtime keys into `nodes[].extras`. Before {@link stampJsonIdentity}: every node gets
 * its AUTHORED name back (`_rvOrigName`, the loader's dedup stamp — the name space the
 * references are written in), a seeded `_rvNodeId` becomes its `NodeId` when it has none,
 * and every `_` key is dropped (F17: nothing runtime reaches a file).
 * @returns how many nodes carried runtime keys.
 */
export function promoteRuntimeKeysInJson(json: Record<string, unknown>): number {
  let touched = 0;
  const holders: Array<{ name?: string; extras?: Record<string, unknown> }> = [
    ...((json.nodes as JsonNode[] | undefined) ?? []),
    ...((json.scenes as Array<{ name?: string; extras?: Record<string, unknown> }> | undefined) ?? []),
  ];
  for (const h of holders) {
    const extras = h.extras;
    if (!extras) continue;
    const keys = Object.keys(extras).filter((k) => k.startsWith('_'));
    if (keys.length === 0) continue;
    touched++;
    const orig = extras['_rvOrigName'];
    if (typeof orig === 'string' && orig.length > 0) h.name = orig;
    const seeded = extras['_rvNodeId'];
    if (typeof seeded === 'string' && seeded) {
      const rv = rvOf(h);
      if (typeof rv[RV_NODE_ID_KEY] !== 'string' || !rv[RV_NODE_ID_KEY]) rv[RV_NODE_ID_KEY] = seeded;
    }
    for (const k of keys) delete extras[k];
  }
  return touched;
}

const SKIPPED = (key: string): boolean => key === 'AssetOverrides' || /^AssetOverrides_\d+$/.test(key);

/**
 * Stamp ids, addresses and `idVersion` into a glTF JSON object IN PLACE (see the module
 * doc). Idempotent: a second pass over its own output changes nothing.
 */
export function stampJsonIdentity(json: Record<string, unknown>): JsonIdentityReport {
  const gltf = json as unknown as MigrationGltfJson;
  const nodes = (json.nodes as JsonNode[] | undefined) ?? [];
  const sceneIndex = (json.scene as number | undefined) ?? 0;
  const scenes = (json.scenes as Array<{ extras?: Record<string, unknown> }> | undefined) ?? [];
  const scene = scenes[sceneIndex];
  const report: JsonIdentityReport = { nodes: nodes.length, written: 0, reminted: [], references: 0, addresses: 0, unresolved: 0 };
  if (!scene) return report;

  // 1. Ids — the decode's two-pass seed over THIS json, duplicates re-minted.
  const seed = seedNodeIdsForFile(gltf, sceneIndex);
  const ids = [...seed.ids] as Array<string | undefined>;
  const taken = new Set<string>(ids.filter((x): x is string => !!x));
  taken.add(seed.rootId);
  const rank = new Map<string, number>();
  for (const dup of seed.duplicates) {
    if (dup.index < 0) continue;
    const k = (rank.get(dup.id) ?? 0) + 1;
    rank.set(dup.id, k);
    let id = seedNodeId(`\u0000reminted\u0000${dup.id}\u0000${k}`);
    for (let n = 1; taken.has(id); n++) id = seedNodeId(`\u0000reminted\u0000${dup.id}\u0000${k}\u0000${n}`);
    taken.add(id);
    ids[dup.index] = id;
    report.reminted.push({ index: dup.index, id: dup.id, reminted: id, name: nodes[dup.index]?.name ?? '' });
  }
  for (let i = 0; i < nodes.length; i++) {
    const id = ids[i];
    if (!id) continue;
    const rv = rvOf(nodes[i]!);
    if (rv[RV_NODE_ID_KEY] !== id) { rv[RV_NODE_ID_KEY] = id; report.written++; }
  }
  const sceneRv = rvOf(scene);
  if (sceneRv[RV_NODE_ID_KEY] !== seed.rootId) { sceneRv[RV_NODE_ID_KEY] = seed.rootId; report.written++; }

  // 1b. Overrides in the 769 form (F14): `byNodeId` → `byAddress`, `trsByNodeId` dropped.
  for (const node of nodes) {
    const rv = node.extras?.['realvirtual'];
    if (rv && typeof rv === 'object' && !Array.isArray(rv)) canonicalizeAssetOverridesIn(rv as Record<string, unknown>);
  }

  // 2. References — migrated through the file's authored index (no legacy names: a
  //    JSON-only pass; the live writers store addresses already, F9 input never reaches here).
  const parent = sceneParents(gltf);
  const ctx = createMigrationContext(gltf, { parent, legacyPaths: null });
  const addressOf = (idx: number): string | null => {
    const id = idx === -1 ? seed.rootId : ids[idx];
    return id ? `${ADDRESS_SEPARATOR}${id}` : null;
  };
  const isForeign = (i: number): boolean => i >= 0 && insideReferenceJson(gltf, parent, i);
  for (const r of listReferrers(gltf, parent, isForeign)) {
    visitReferences(r.extras, (pos) => {
      if (pos.form !== 'path' || pos.path.trim() === '') return;
      report.references++;
      const verdict = pos.kind === 'name' ? ctx.migrateName(pos.path, r.idx) : ctx.migratePath(pos.path);
      const address = verdict.idx !== undefined ? addressOf(verdict.idx) : null;
      const form = address
        ? { address }
        : { unresolvedPath: pos.path, reason: verdict.via === 'unresolved' ? verdict.reason : 'missing' };
      if ('address' in form) report.addresses++; else report.unresolved++;
      if (pos.kind === 'ref') {
        const v = pos.value as Record<string, unknown>;
        const out: Record<string, unknown> = { type: 'ComponentReference', ...form };
        if (typeof v.componentType === 'string') out.componentType = v.componentType;
        if (typeof v.componentIndex === 'number' && 'address' in form) out.componentIndex = v.componentIndex;
        pos.set(out);
      } else {
        pos.set({ ...form });
      }
    }, { skipComponent: SKIPPED });
  }

  // 3. The id format.
  sceneRv[ID_VERSION_KEY] = ID_VERSION_CURRENT;
  return report;
}
