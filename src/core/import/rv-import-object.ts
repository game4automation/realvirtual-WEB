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

import type { Object3D, Mesh, BufferGeometry } from 'three';
import type { LibraryCatalogEntry } from '../../plugins/layout-planner/rv-layout-store';
import type { ImportResultItem } from './rv-import-provider';
import { persistImportedGlb } from './rv-import-persistence';

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

    const persistResult = await persistImportedGlb(name, item.bytes);
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
