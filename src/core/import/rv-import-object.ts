// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-import-object.ts — the PLANNER import sink + the canonical Object3D→GLB
 * serializer.
 *
 *   - {@link importObject} → ADDITIVE. Places into the current scene through the
 *     layout planner (`placeComponent` → AddPlacementOp → op log, undo/redo,
 *     autosave). GUARANTEE: never calls `loadModel` or `clearModel` — the
 *     existing scene stays untouched.
 *   - {@link objectToGlb} → the ONE place a Three.js tree becomes GLB bytes.
 *     Used by the CAD providers (STEP/USD conversion) and by
 *     `exportAssetGlb` (asset save).
 *
 * There is deliberately no "replace" / "open as new scene" sink. Editor mode
 * edits ONE library object and has no scene, so an import there is always an
 * addition to the current asset document; "open an arbitrary GLB as the scene"
 * is the model picker's job (`hmi/settings/ModelTab`, `hmi/scene/SceneWindow`).
 *
 * v1 note (plan-238 §2.2 review): `importObject` is a thin facade over the
 * planner's `placeComponent` rather than a duplicate core placement engine —
 * the op log is already plugin-free (`rv-scene-edits.ts`), the placement
 * state is not. Editor-only deploys must therefore include the
 * layout-planner plugin; a missing planner is a hard, visible error.
 */

import { Matrix4, Scene } from 'three';
import type { Object3D, Mesh, BufferGeometry } from 'three';
import type { LibraryCatalogEntry } from '../../plugins/layout-planner/rv-layout-store';
import type { ImportResultItem } from './rv-import-provider';
import { persistImportedGlb } from './rv-import-persistence';
import { weldImportedGlb } from './rv-glb-weld';

// ─── Minimal structural contracts (test-friendly, no hard viewer dep) ───

/** The slice of the layout planner `importObject` relies on. */
export interface ImportPlannerLike {
  placeComponent(
    entry: LibraryCatalogEntry,
    position: [number, number, number],
    opts?: { skipAutoAlign?: boolean },
  ): Promise<string>;
}

/** The slice of RVViewer `importObject` relies on. Structural (unknown
 *  return) so both the real viewer and lightweight test doubles satisfy it. */
export interface ImportViewerLike {
  getPlugin(id: string): unknown;
  resolvePlugin?(id: string): Promise<unknown | null>;
}

// ─── Options / outcome ──────────────────────────────────────────────────

export interface ImportObjectOptions {
  /** Placement position (planner mm-space). Default `[0, 0, 0]`. */
  position?: [number, number, number];
  /**
   * Skip the additive pipeline's AABB floor-center pivot + floor align
   * (`pivotToFloorCenter`/`alignToFloor`). Catalog single objects want the
   * auto-align; multi-part CAD assemblies with a functional CAD origin
   * usually do NOT (plan-238 §2.2 point 4).
   */
  skipAutoAlign?: boolean;
  /** Base name for the persisted GLB / catalog entry (default: item name). */
  name?: string;
}

export interface ImportObjectOutcome {
  /** Placement ids created (one per placed entry). */
  placedIds: string[];
  /** false if at least one item could not be written to the working folder
   *  (fallback blob entry in use — lost on reload). */
  persisted: boolean;
  /** User-facing warnings (non-fatal degradations). */
  warnings: string[];
}

// ─── GLB serialization (the one Object3D→GLB path) ──────────────────────

/**
 * The tree is too large for the browser to encode as one GLB.
 *
 * `GLTFExporter`'s `binary: true` path assembles the file by materialising the
 * whole binary chunk as a Blob, reading it back into an ArrayBuffer, building a
 * SECOND Blob for the container, and reading that back too. Both copies are live
 * at once, on top of the source geometry — so it needs roughly 3× the encoded
 * size and dies well below any glTF format limit. Measured failure with real
 * Chrome: ~2M triangles (160 MB) fine, ~4M (320 MB) fails.
 *
 * Neither failure is an exception. A failed read makes the exporter call
 * `onDone(null)`; a failure on the FIRST read throws inside a FileReader event
 * handler, leaving the promise permanently unsettled. `objectToGlb` converts both
 * into this error.
 */
export class GlbEncodingTooLargeError extends Error {
  constructor(readonly triangles: number, readonly meshes: number) {
    super(
      `Model too large to encode as a single GLB (${meshes.toLocaleString()} meshes, ` +
      `~${triangles.toLocaleString()} triangles). The browser ran out of memory while ` +
      'assembling the file. Re-import with a coarser tessellation quality.',
    );
    this.name = 'GlbEncodingTooLargeError';
  }
}

/** Triangle + mesh totals of a tree, for error messages and size guards. */
function treeStats(root: Object3D): { triangles: number; meshes: number } {
  let triangles = 0;
  let meshes = 0;
  root.traverse((n) => {
    const mesh = n as Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    const geo = mesh.geometry as BufferGeometry | undefined;
    if (geo?.index) triangles += geo.index.count / 3;
    else if (geo?.attributes?.position) triangles += geo.attributes.position.count / 3;
  });
  return { triangles: Math.round(triangles), meshes };
}

const EXPORT_IDENTITY = new Matrix4();

/**
 * True when the node's local TRS is the identity — i.e. there is nothing at
 * this level that would be lost by exporting its children one level up.
 *
 * `updateMatrix()` only where three.js would run it anyway. A node with
 * `matrixAutoUpdate === false` has an authored `matrix` that no longer follows
 * position/quaternion/scale (the layout planner and every frozen drive subtree
 * are in that state), and recomputing it here would silently overwrite the real
 * transform of a LIVE scene mid-export.
 */
function hasIdentityTransform(node: Object3D): boolean {
  if (node.matrixAutoUpdate) node.updateMatrix();
  return node.matrix.equals(EXPORT_IDENTITY);
}

/**
 * Wrap a loaded document root as the FILE'S SCENE, so that saving is the exact
 * inverse of loading (plan-752 F4).
 *
 * The growth this removes. `GLTFLoader` always hands back a `Group` for the
 * file's scene (`GLTFLoader.js:4436`) — the scene itself is not a node and has
 * nowhere else to go. The exporter is asymmetric: `processSceneAsync`
 * (`GLTFExporter.js:2700`) turns only `scene.children` into nodes and never the
 * scene, and a plain `Object3D` handed to `parse()` is wrapped in a synthetic
 * `AuxScene` first (`:2724`). So round-tripping a document through both put the
 * loaded root back as a NODE under a fresh scene — one extra level per save,
 * for ever.
 *
 * Mirroring the load closes the loop: the root's **name becomes the scene
 * name** and the root's **children become the file's nodes**. A freshly saved
 * document is then a FIXPOINT: save → load → save no longer changes its shape.
 *
 * An EXISTING phantom chain is KEPT, not healed — it only stops growing.
 * Measured against the old save (which added one level per round) that is one
 * level less per save, but nothing is peeled off on load and nothing collapses
 * on save, so the level the document already carries stays exactly where it is.
 * A grown document is therefore stable and fully resolvable, not repaired.
 * Pinned by `tests/scene-glb-roundtrip-fixpoint.test.ts` ("stops growing — and
 * is deliberately NOT healed"), which holds `depth(root) === grownDepth`.
 * Healing is left out on purpose: it would take `collapseWrapperChain` (see
 * below), which would tear up stored child paths (plan-752 R7).
 *
 * Child paths are untouched by construction: every path in this code base is
 * resolved root-EXCLUSIVE (`findByScenePath`), and node-id overrides key on a
 * persistent `userData.realvirtual.id` rather than on a path.
 *
 * **A root with a real transform stays a node.** A glTF scene cannot carry a
 * transform, so flattening one away would move the whole document. That case
 * re-stabilises after a single save (the reload then has an identity wrapper
 * above it) and is the reason this is a branch and not a rule.
 *
 * Deliberately NOT `collapseWrapperChain` (`rv-asset-glb-export.ts:290`): that
 * descends through the WHOLE wrapper chain in one step and would tear up stored
 * child paths. This function only ever removes the single topmost level — the
 * one the exporter invents.
 *
 * Children are **borrowed, not re-parented**: `Object3D.add()` detaches from the
 * current parent, and callers hand in the live model root. Pushing onto
 * `children` directly is what three.js itself does in `processObjectsAsync` and
 * for the same reason; the exporter only reads `children` and each node's LOCAL
 * matrix, so a borrowed child serialises identically.
 */
export function sceneMirroringLoad(root: Object3D): Scene {
  const scene = new Scene();
  // glTF scene `extras` are flattened onto the loaded Group's userData by
  // `assignExtrasToUserData`, so the inverse is to put them back on the scene.
  scene.userData = { ...(root.userData as Record<string, unknown>) };
  if (hasIdentityTransform(root)) {
    scene.name = root.name;
    scene.children.push(...root.children);
  } else {
    // The root stays a node, and the scene above it is left ANONYMOUS on
    // purpose. `GLTFLoader` draws scene and node names from one namespace, so
    // naming the scene after the root would make the loader dedup the node
    // itself to `<name>_1` — renaming the very level every stored path starts
    // from. An unnamed scene costs nothing (the level is a phantom in this
    // branch anyway) and keeps the node's own name intact.
    scene.children.push(root);
  }
  return scene;
}

/**
 * Serialize a Three.js tree to binary GLB (lazy GLTFExporter import).
 *
 * `onlyVisible: false` is deliberate: GLTFExporter otherwise DROPS every
 * `visible === false` node, which would silently delete authored-hidden nodes
 * (the editor's eye toggle). Callers that may hold runtime overlay meshes must
 * therefore prune them explicitly first — see `pruneRuntimeHelpers` in
 * `core/editor/rv-asset-glb-export.ts`, which is what `exportAssetGlb` does
 * before delegating here.
 *
 * Throws {@link GlbEncodingTooLargeError} rather than resolving `null` or hanging
 * when the tree exceeds what the exporter can assemble — see that class.
 */
export async function objectToGlb(root: Object3D): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();

  // Upstream leaves the promise unsettled when the FIRST Blob read fails: the
  // resulting `TypeError: ... reading 'byteLength'` is thrown inside a FileReader
  // event handler, where no promise can see it. Catch it on the window so the
  // import fails in seconds instead of hanging forever.
  let onWindowError: ((e: ErrorEvent) => void) | null = null;
  const assemblyFailure = new Promise<never>((_, reject) => {
    onWindowError = (e: ErrorEvent) => {
      if (e.error instanceof TypeError && /byteLength/.test(e.error.message)) {
        e.preventDefault();
        const { triangles, meshes } = treeStats(root);
        reject(new GlbEncodingTooLargeError(triangles, meshes));
      }
    };
    if (typeof window !== 'undefined') window.addEventListener('error', onWindowError);
  });

  try {
    const result = await Promise.race([
      exporter.parseAsync(root, { binary: true, onlyVisible: false }),
      assemblyFailure,
    ]);
    if (!(result instanceof ArrayBuffer)) {
      // `onDone(null)` — the second Blob read failed. Same cause, quieter symptom.
      const { triangles, meshes } = treeStats(root);
      throw new GlbEncodingTooLargeError(triangles, meshes);
    }
    return result;
  } finally {
    if (onWindowError && typeof window !== 'undefined') {
      window.removeEventListener('error', onWindowError);
    }
  }
}

// ─── Additive sink ──────────────────────────────────────────────────────

async function resolvePlanner(viewer: ImportViewerLike): Promise<ImportPlannerLike> {
  let planner = viewer.getPlugin('layout-planner') as ImportPlannerLike | undefined;
  if (!planner && viewer.resolvePlugin) {
    planner = (await viewer.resolvePlugin('layout-planner')) as ImportPlannerLike | null ?? undefined;
  }
  if (!planner || typeof planner.placeComponent !== 'function') {
    throw new Error(
      '[import] Additive import requires the layout-planner plugin. ' +
      'Editor-only deploys must include it (plan-238 §2.2).',
    );
  }
  return planner;
}

/**
 * ADDITIVE import sink. Places one or more resolved import items into the
 * CURRENT scene via the layout planner. Persistence: non-catalog items are
 * written to the local working folder first (§2.2a) so they become regular
 * catalog entries; the placement is recorded as an `AddPlacementOp` by
 * `placeComponent` (undo/redo + reload-safe).
 *
 * NEVER calls `viewer.loadModel()` / `viewer.clearModel()`.
 */
export async function importObject(
  viewer: ImportViewerLike,
  items: ImportResultItem | ImportResultItem[],
  options?: ImportObjectOptions,
): Promise<ImportObjectOutcome> {
  const list = Array.isArray(items) ? items : [items];
  const planner = await resolvePlanner(viewer);

  const position = options?.position ?? [0, 0, 0] as [number, number, number];
  const placeOpts = options?.skipAutoAlign ? { skipAutoAlign: true } : undefined;

  const outcome: ImportObjectOutcome = { placedIds: [], persisted: true, warnings: [] };

  for (const item of list) {
    if (item.kind === 'catalog') {
      // Stable-URL entries (Asset Manager, Onshape docs, …) — place directly.
      for (const entry of item.entries) {
        outcome.placedIds.push(await planner.placeComponent(entry, position, placeOpts));
      }
      continue;
    }

    // Non-catalog item: every provider already resolved to GLB bytes — persist
    // as a regular catalog asset (no second export pass, no format branch).
    const name = options?.name ?? item.suggestedName;

    // Welded first (`rv-glb-weld`), like the editor sink — the stored catalog
    // asset is the small form, whichever provider or route produced the bytes.
    const persistResult = await persistImportedGlb(name, weldImportedGlb(item.bytes, name));
    if (!persistResult.persisted) {
      outcome.persisted = false;
      if (persistResult.warning) outcome.warnings.push(persistResult.warning);
    }

    outcome.placedIds.push(
      await planner.placeComponent(persistResult.entry, position, placeOpts),
    );
  }

  return outcome;
}
