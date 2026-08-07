// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-parse — the shared GLTFLoader singleton, node-name reconciliation, and
 * `parseGlbSubtree`: bytes → a bare Object3D subtree.
 *
 * GLB is the single source of truth. Every import (STEP, USD, .glb, catalog)
 * converts to GLB bytes, caches them by content hash, and then loads THOSE bytes
 * — so what enters the scene on import is bit-identical to what returns after a
 * reload. `parseGlbSubtree` is that load step for anything that is added INTO an
 * existing scene/asset (as opposed to `loadGLB`, which builds a whole model with
 * component construction, merging and BVH).
 *
 * Split out of rv-scene-loader.ts so that `rv-asset-executors` and the layout
 * planner can parse GLB bytes without pulling in the loader's entire component
 * side-effect graph.
 */

import { Object3D, Group } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { sanitizeLikeThree, isPureSanitization } from './rv-three-names';
import { unwrapGltfRoot } from './rv-gltf-unwrap';
import { debug } from './rv-debug';

// ─── Singleton loader ────────────────────────────────────────────────────

const dracoLoader = new DRACOLoader();
// Serve the Draco decoder from our own bundle (copied into `<base>draco/` by the
// vite `rv-copy-draco` plugin) instead of the gstatic CDN. The CDN is an external
// dependency that intermittently fails on mobile networks / behind corporate
// proxies — when it does, DRACO-compressed meshes never decode and the user is
// left with a blank scene. Local serving removes that failure mode and works
// offline. BASE_URL respects the deploy sub-path (e.g. `/demo/`).
dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);

/**
 * Override the Draco decoder URL for a library/embed entry.
 *
 * `import.meta.env.BASE_URL` is relative to the HOST document in a third-party
 * embed, not to the CDN module. The embed entry therefore supplies a
 * module-relative absolute URL before any model is loaded.
 */
export function setDracoDecoderPath(path: string): void {
  dracoLoader.setDecoderPath(path);
}

/** The one GLTFLoader used by `loadGLB` and `parseGlbSubtree` alike. */
export const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// ─── Renamed-node reconciliation ─────────────────────────────────────────

/**
 * `userData` key carrying a node's glTF name BEFORE Three.js' file-global dedup
 * appended its `_N` suffix (already sanitized, so it is comparable to
 * `Object3D.name`). Written by {@link detectRenamedNodes}, read by
 * {@link collectRenamedNodes} on every path that registers a subtree into an
 * existing scene. Leading `_` is load-bearing: `sanitizeUserDataForExport`
 * strips exactly those keys, so the marker never reaches a saved GLB.
 */
export const RV_ORIG_NAME_KEY = '_rvOrigName';

/**
 * Rebuild the renamed-node map for an already-parsed subtree from the
 * {@link RV_ORIG_NAME_KEY} stamps its nodes carry.
 *
 * `loadGLB` gets its map straight from {@link detectRenamedNodes}, but the
 * placed-asset / asset-editor paths register a tree that was parsed (and
 * possibly cloned) earlier — this reconstructs the same information from the
 * tree itself, so `registerNodeAliases` works there too (plan-381 F5).
 */
export function collectRenamedNodes(root: Object3D): Map<Object3D, string> {
  const renamed = new Map<Object3D, string>();
  root.traverse((node) => {
    const orig = (node.userData as Record<string, unknown> | undefined)?.[RV_ORIG_NAME_KEY];
    if (typeof orig === 'string' && orig.length > 0) renamed.set(node, orig);
  });
  return renamed;
}

/** The slice of `GLTFLoader`'s parser that name reconciliation needs. */
export interface GltfParserLike {
  /** Values can be `undefined` — see the guard in `detectRenamedNodes`. */
  associations?: Map<Object3D, { nodes?: number } | undefined>;
  json?: { nodes?: { name?: string }[] };
}

/**
 * Reconcile Three.js node names with the ORIGINAL glTF names and build the
 * renamed-node map for the (rare) genuine-deduplication case.
 *
 * Three.js' GLTFLoader passes every node name through
 * `PropertyBinding.sanitizeNodeName` (whitespace → `_`, reserved chars
 * `[ ] . : /` stripped) and additionally appends a `_N` suffix on name
 * collisions. For PLC-driven scenes this breaks exact-name matching: a Siemens
 * signal node `MC04.01I00W` (empty signal `Name` field → falls back to the node
 * name) lands on `Object3D.name` as `MC0401I00W`, while the live interface
 * (MQTT / realvirtual CONNECT) still addresses it as `MC04.01I00W`.
 *
 * Strategy:
 *  - **Pure sanitization** (no dedup suffix, `sanitizeLikeThree(orig) === name`):
 *    RESTORE `obj.name = orig` in place. From here on `registerSignal`
 *    (`node.name`), `computeNodePath`, and rv_extras reference resolution all
 *    use the exact original name — consistent with the interface names. No
 *    alias is needed and none is recorded.
 *  - **Genuine dedup** (Three appended `_N` to resolve a real collision):
 *    leave `obj.name` untouched (restoring would re-collide) and record the
 *    sanitized original in `renamedNodes` so `registerNodeAliases` can still
 *    publish a best-effort path/name alias, exactly as before.
 *
 * This is also what keeps the asset editor's op log stable across a reload: an
 * import and its later replay both go through the same GLB bytes, so both see
 * the same restored names and the same `_N` suffixes.
 *
 * Does NOT register signals — that happens during the main traverse, which now
 * sees the corrected `obj.name`.
 */
export function detectRenamedNodes(gltfParser: GltfParserLike | undefined): Map<Object3D, string> {
  const renamedNodes = new Map<Object3D, string>();
  let restoredCount = 0;
  if (gltfParser?.associations && gltfParser?.json?.nodes) {
    for (const [obj, ref] of gltfParser.associations) {
      // The mapping can be `undefined`: GLTFLoader clones a material for
      // flat-shading / vertex-colors / derivative-tangents and copies the
      // ORIGINAL material's association onto the clone — for the built-in
      // DEFAULT material there is none, so `associations` ends up holding an
      // undefined value. Every material-less GLB hits this (OCCT/CONNECT CAD
      // exports write no `materials` at all), and reading `.nodes` off it
      // failed the whole import with "Cannot read properties of undefined".
      if (!ref) continue;
      if (ref.nodes !== undefined && ref.nodes < gltfParser.json.nodes.length) {
        const origName = gltfParser.json.nodes[ref.nodes].name ?? '';
        if (!origName || obj.name === origName) continue; // nothing changed

        if (isPureSanitization(origName, obj.name)) {
          // Reversible sanitization (e.g. dot stripped, space → '_') with no
          // collision suffix → safe to restore the exact original name so the
          // signal store key matches the PLC/MQTT symbol verbatim.
          obj.name = origName;
          restoredCount++;
        } else {
          // Real Three.js dedup suffix (`_N`) or otherwise non-reversible →
          // keep the sanitized form as an alias for path-based lookups.
          const sanitized = sanitizeLikeThree(origName);
          renamedNodes.set(obj, sanitized);
          // Stamp the pre-dedup name onto the node as well (plan-381 F5). The
          // in-memory Map only survives as long as the parser result: every
          // path that adds a subtree INTO an existing scene either drops it
          // (`parseGlbSubtree`) or works on a `clone()` of a cached tree (the
          // planner's ModelCache), where a Map keyed on the ORIGINAL objects
          // cannot match the clone's objects. A plain string in `userData`
          // survives `Object3D.copy` (three JSON-clones userData) and is
          // stripped again on export by `sanitizeUserDataForExport`, which
          // drops every `_`-prefixed key.
          (obj.userData as Record<string, unknown>)[RV_ORIG_NAME_KEY] = sanitized;
        }
      }
    }
    if (restoredCount > 0) {
      debug('loader', `${restoredCount} node name(s) restored to original glTF names (sanitization reversed)`);
    }
    if (renamedNodes.size > 0) {
      debug('loader', `${renamedNodes.size} node(s) renamed by Three.js (name dedup)`);
    }
  }
  return renamedNodes;
}

/**
 * Map every loaded `Object3D` back to the index of the glTF node it came from.
 *
 * `associations` is the ONLY authoritative route back to the source node.
 * Re-deriving it from names is not safe: Three.js deduplicates names
 * **file-globally, in load order**, and `detectRenamedNodes` then restores a
 * subset of them — reimplementing both would silently write to the wrong node
 * whenever the two drift apart.
 *
 * Used by the GLB bake (`rv-scene-glb-bake.ts`) to turn an overlay's node paths
 * into `nodes[i]` indices. The parser is dropped right after the load, so the
 * map is handed to the `NodeRegistry` and lives as long as the model does.
 * Nodes with no entry — planner placements, op-created nodes — are exactly the
 * structural cases the bake refuses anyway.
 */
export function collectGltfNodeIndices(gltfParser: GltfParserLike | undefined): Map<Object3D, number> {
  const indices = new Map<Object3D, number>();
  if (!gltfParser?.associations) return indices;
  for (const [obj, ref] of gltfParser.associations) {
    // Same guard as detectRenamedNodes: GLTFLoader stores `undefined` for
    // cloned materials that have no association of their own.
    if (!ref || ref.nodes === undefined) continue;
    indices.set(obj, ref.nodes);
  }
  return indices;
}

/**
 * The RAW glTF node names, indexed exactly like `nodes[]` in the file.
 *
 * The companion of {@link collectGltfNodeIndices}: the indices are only
 * meaningful against the file they were read from, and a writer that re-fetches
 * the model needs a way to prove it got the same bytes. Comparing these names
 * against the fetched JSON does that. They are the untouched glTF names — not
 * `Object3D.name`, which `detectRenamedNodes` may already have rewritten.
 */
export function collectGltfNodeNames(gltfParser: GltfParserLike | undefined): (string | undefined)[] {
  return (gltfParser?.json?.nodes ?? []).map((node) => node.name);
}

// ─── Subtree parse ───────────────────────────────────────────────────────

/**
 * Parse binary GLB bytes into a bare Object3D subtree, ready to be added into an
 * existing scene or asset root.
 *
 * Runs `detectRenamedNodes` so purely-sanitized names (`Part.1`, `a b`) come
 * back verbatim, then peels the glTF scene wrapper. Deliberately does NOT run
 * any of `loadGLB`'s phases — no component construction, no signal store, no
 * material dedup, no uber-bake, no merging, no BVH. The caller owns registration
 * (the asset executors call `_registerSubtree`; the planner calls
 * `registerPlaced`).
 */
export async function parseGlbSubtree(bytes: ArrayBuffer): Promise<Object3D> {
  // Self-contained GLB (textures + buffers embedded) → empty resource path.
  const gltf = await gltfLoader.parseAsync(bytes, '');
  const parser = (gltf as unknown as { parser?: GltfParserLike }).parser;
  detectRenamedNodes(parser);
  return unwrapGltfRoot(gltf.scene as Group);
}
