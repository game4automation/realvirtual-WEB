// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-glb-bake — write ALL SEVEN `materialise()` categories into a GLB.
 *
 * `writeSettingsIntoModel` persists exactly ONE of them (`overlay`). Everything
 * else — planner placements, the camera preset, op-created nodes, moved nodes,
 * connections and connection types — lived only in the op log, which is why a
 * scene has never been a file. Closing that gap is the actual work of plan-397;
 * the reference model is the answer to just one of the six missing categories.
 *
 * ## Two paths, chosen by what was MATERIALISED
 *
 * The switch cannot hang on op kinds: by the time anything reaches a writer the
 * ops are gone and only {@link MaterialisedEdits} is left (plan §2.6, review
 * finding 10). It therefore hangs on which categories came back non-empty:
 *
 *  - **Fast** — categories 1, 3, 5, 6, 7 only. The JSON chunk is rewritten and
 *    the BIN chunk is copied as an opaque tail, so not one vertex is re-encoded
 *    and the geometry is bit-identical to the source.
 *  - **Full** — category 2 (`placements`) or 4 (`addedNodes`). The node ARRAY
 *    grows, so the file is rebuilt through `objectToGlb()` /`GLTFExporter`.
 *    plan-628 8.7 adds `removedNodes` (authored path-network nodes the user
 *    deleted): the node array SHRINKS, which the JSON patcher cannot do either —
 *    the subtree is detached from the re-parsed tree, so the exporter never
 *    writes it.
 *    Expensive, and only paid when the tree shape actually changed.
 *
 * Both paths end in the same file-level write, so `SceneCamera` and the
 * `Connections` block land in the normative place either way — the exporter
 * wraps a `Group` in its own `AuxScene`, and a camera preset stranded one level
 * below the scene root would silently never be found again.
 *
 * ## A referenced file is never written to
 *
 * The user's decision was that a referenced asset stays untouched. So an
 * override on a node that came out of a referenced file does NOT go into that
 * file: it becomes an `AssetOverrides.byAddress` entry (`#<id>`) on the reference node in
 * the file being written (§2.6). {@link BakeResolver} is what tells the two
 * cases apart, and a reference node that itself lives in a referenced file is a
 * refusal ({@link ReferencedFileWriteError}) rather than a guess.
 *
 * A MOVED node of a referenced file is refused (plan-769 D11/F14,
 * {@link NestedTransformRefusedError}): inside placed content only component
 * values are overridable. plan-444's `trsByNodeId` is gone — an old file's moves
 * are reported on load and never written again.
 *
 * ## What it refuses, and why refusing is the feature
 *
 * A bake that half-succeeds produces a file that looks complete and silently is
 * not — the one outcome worth preventing. Hence hard errors for a changed source
 * file, a value JSON would mangle, an edit (component or transform) whose owning
 * reference node itself lives in a referenced file, and a reference that would
 * make the saved file reference itself.
 */

import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { isUnsafeObjectKey, ownValue } from '../../engine/rv-safe-keys';
import {
  defaultSceneExtras,
  ensureDefaultSceneExtras,
  parseGlbChunks,
  rebuildGlbWithJson,
  type GlbChunks,
} from '../../persistence/rv-glb-chunks';
import {
  ModelSourceChangedError,
  NodeNotFoundError,
  UnrepresentableValueError,
  unrepresentableReason,
  warnDroppedUndefined,
} from './rv-scene-settings-into-model';
import type { MaterialisedEdits, NodeSpec, PlacementTransform } from './rv-scene-edits';
import type { PlacedComponent } from '../../../plugins/layout-planner/rv-layout-store';
import type { RvConnection, ConnectionType } from '../../engine/rv-connection-registry';
import {
  RV_ASSET_OVERRIDES_KEY,
  RV_ASSET_REFERENCE_KEY,
  RV_PLACEMENT_META_KEY,
  RV_SCENE_CAMERA_KEY,
  RV_SCENE_SETTINGS_KEY,
  sceneCameraFromCameraStart,
  type PlacementMeta,
  type SceneSettings,
} from '../../engine/rv-asset-reference';
import type { WrittenGlbReference } from '../../project/rv-asset-identity';
import {
  RV_CLASSIFICATION_KEY,
  classificationPayload,
  isEmptyClassification,
  type DocumentClassification,
} from '../../project/rv-document-classification';
import {
  RV_DOCUMENT_INFO_KEY,
  documentInfoPayload,
  isEmptyDocumentInfo,
  type DocumentInfo,
} from '../../project/rv-document-info';
import { RV_NODE_ID_KEY, ROOT_SOURCE_KEY } from '../../engine/rv-node-id';
import {
  clearNestedTransformRefusedProblems, clearPlacementTransformOrphanedProblems, reportNestedTransformRefused,
  reportPlacementNameEmpty, reportPlacementTransformOrphaned,
} from '../problems-store';
import {
  canonicalizeAssetOverridesIn, getAssetReference, migrateStoredOverridePaths, overrideAddressInReference,
  overrideAddressOf, overridePathMigrationOf,
} from '../../engine/rv-asset-reference';
import { identityIdOf } from '../../engine/rv-decode-identity';
import { isPlacementRoot } from '../../engine/rv-placement-instancer';
import type { NodeRegistry } from '../../engine/rv-node-registry';
import type { ComposedFrame } from '../../engine/rv-glb-compose';
import { RV_MACROS_KEY } from '../../editor/rv-macro-store';
import {
  RV_PLANNING_SCENARIOS_KEY, isEmptyScenarioBlock, planningScenariosPayload, type PlanningScenarioBlock,
} from '../../planning/rv-planning-scenario';
import { stampJsonIdentity, type JsonIdentityReport } from '../../engine/rv-json-identity';
import { storedSignalMappingsOf } from '../../engine/rv-signal-mapping-address';
import { reportSaveIdentityProblems } from '../problems-store';
import { isQualifiedRef } from '../../library/library-origin';

/** plan-769 Phase 3b: a re-minted duplicate id of a planner save is a visible Problem. */
function reportJsonIdentity(r: JsonIdentityReport): void {
  if (r.reminted.length === 0) return;
  reportSaveIdentityProblems({
    reminted: r.reminted.map((d) => ({ id: d.id, reminted: d.reminted, nodePath: d.name || `#${d.index}` })),
    guessed: [],
  });
}

/** Component key of the rv-ODT connections block, as carried in node extras. */
const RV_CONNECTIONS_KEY = 'Connections';

// ─── Errors ──────────────────────────────────────────────────────────────

/**
 * A write would have had to land inside a referenced file.
 *
 * Only reachable through a nested reference: an override on a node two files
 * down has to be recorded on the reference node that owns it, and if THAT node
 * came out of a referenced file too, the only file we may write cannot express
 * it. Writing into the referenced asset instead is precisely what the user ruled
 * out, and dropping the override quietly is what F9 exists to prevent.
 */
export class ReferencedFileWriteError extends Error {
  constructor(public readonly paths: string[]) {
    super(
      `${paths.length} edit(s) belong to a referenced asset and cannot be written from here — `
      + paths.slice(0, 8).join(', ') + (paths.length > 8 ? `, … (+${paths.length - 8} more)` : '')
      + '. Open the referenced asset and change it there.',
    );
    this.name = 'ReferencedFileWriteError';
  }
}

/**
 * A moved node lies too deep for any file we may write.
 *
 * The part is not in the file being written at all (`unknown`), or — the
 * subclass {@link NestedTransformRefusedError} — it sits inside placed content,
 * where a move has no vocabulary since plan-769 removed `trsByNodeId` (D11/F14).
 * Writing into the referenced asset instead is what the user ruled out (it would
 * move the part in every other instance too), and dropping the move quietly is
 * what F9 exists to prevent.
 *
 * The message names the way out because the dialog shows it verbatim
 * (`SaveDialogs.tsx` renders the reason it is handed, and a raw
 * "cannot be stored as an override" told the user nothing they could act on).
 */
export class UnwritableTransformError extends Error {
  /**
   * @param paths   every moved node that could not be written, in op order
   * @param unknown the subset the resolver could not place AT ALL — not nested,
   *   simply absent from the file being written. A different fault with a
   *   different way out, so it gets its own sentence: telling the user to open
   *   a referenced asset that does not exist sent them looking for nothing.
   */
  constructor(public readonly paths: string[], public readonly unknown: readonly string[] = []) {
    const list = (items: readonly string[]): string =>
      items.slice(0, 8).join(', ') + (items.length > 8 ? `, … (+${items.length - 8} more)` : '');
    const nested = paths.filter((path) => !unknown.includes(path));
    const parts: string[] = [];
    if (nested.length > 0) {
      parts.push(
        `${nested.length} moved part(s) sit inside an asset that is itself referenced by another `
        + `asset, so this file has nowhere to record the move: ${list(nested)}`
        + '.\nOpen the referenced asset (double-click it) and move the part there — '
        + 'the change then applies to every instance. Or undo the move and save again.',
      );
    }
    if (unknown.length > 0) {
      parts.push(
        `${unknown.length} moved part(s) are not part of the file being written: ${list(unknown)}`
        + '.\nThe part was added in this session in a way this save cannot store. '
        + 'Use "Download .glb" to keep the work, and report this — it is a defect, not a limit.',
      );
    }
    super(parts.join('\n'));
    this.name = 'UnwritableTransformError';
  }
}

/**
 * A moved part sits inside a placement (plan-769 D11/F14, `nested-transform-refused`).
 *
 * Inside placed content only component VALUES can be overridden — at any depth.
 * A part move has no vocabulary there any more (`trsByNodeId` was removed), so
 * the save refuses it by name instead of dropping it.
 */
export class NestedTransformRefusedError extends UnwritableTransformError {
  readonly code = 'nested-transform-refused';
  /**
   * @param paths     every moved node inside placed content, in op order
   * @param owners    the placement (reference node) path of each, same order
   * @param unknown   moved nodes absent from the file being written (see the base class)
   */
  constructor(paths: string[], public readonly owners: readonly string[], unknown: readonly string[] = []) {
    super([...paths, ...unknown], unknown);
    const list = (items: readonly string[]): string =>
      items.slice(0, 8).join(', ') + (items.length > 8 ? `, … (+${items.length - 8} more)` : '');
    const head = `${paths.length} moved part(s) sit inside a placement: ${list(paths)}`
      + '.\nInside placed content only component values can be changed. Undo the move, then move the '
      + 'whole placement — or open the referenced asset (double-click it) and move the part there; '
      + 'the change then applies to every instance.';
    this.message = unknown.length > 0 ? `${head}\n${this.message.split('\n').slice(-2).join('\n')}` : head;
    this.name = 'NestedTransformRefusedError';
  }
}

/**
 * The file being saved would reference itself.
 *
 * Composition detects a cycle on LOAD and refuses the whole model. Detecting the
 * same thing on SAVE is what keeps an unloadable file from being produced in the
 * first place (F10) — the load-side check would otherwise be the user's first
 * notice, one session too late.
 */
export class SaveReferenceCycleError extends Error {
  constructor(public readonly trail: string[]) {
    super(`Reference cycle on save: ${trail.join(' → ')}`);
    this.name = 'SaveReferenceCycleError';
  }
}

// ─── Where a scene path lives ────────────────────────────────────────────

/** A node of the file being written: patch `nodes[index]` directly. */
export interface RootBakeLocation {
  kind: 'root';
  index: number;
}

/**
 * A node that came out of a referenced file.
 *
 * `referenceNodePath` is the scene path of the reference node that owns this
 * occurrence; `nodeId` is the node's id INSIDE the referenced file, which is
 * unambiguous there even when the same asset is referenced ten times (§2.3).
 */
export interface ReferencedBakeLocation {
  kind: 'referenced';
  referenceNodePath: string;
  nodeId: string;
  sourceKey: string;
  /**
   * plan-769 Phase 4b — the override key on that reference node: `#<nodeId>`, or
   * `<b>#<nodeId>` when the node is content of a nested reference `b` of the
   * referenced asset (any depth, F13). Absent = `#<nodeId>`.
   */
  address?: string;
}

/** The `byAddress` key of a referenced location. */
function locationAddress(location: ReferencedBakeLocation): string {
  return location.address ?? overrideAddressOf(location.nodeId);
}

export type BakeLocation = RootBakeLocation | ReferencedBakeLocation;

/**
 * How the bake finds out where an edit belongs.
 *
 * Injected rather than reaching into `NodeRegistry` directly: the bake is a pure
 * bytes-in/bytes-out function, and a test must be able to state "this path is in
 * the root file at index 3" without standing up a loaded scene.
 * {@link makeRegistryBakeResolver} is the production wiring.
 */
export interface BakeResolver {
  locate(nodePath: string): BakeLocation | null;
  /**
   * The planner placement id of a LIVE placement root at `nodePath` (null =
   * not a live placement root). Placements added in the CURRENT session have no
   * composition frame and no base gltf node, so `locate` cannot see them —
   * but their rv_extras overrides (e.g. an Agv's PathId/ServiceTime, plan-921)
   * belong INSIDE the placement extras this very bake writes. Since plan-757
   * Phase 2 (4a) so do the edits INSIDE such a placement: `locate` routes a
   * content node to `{ kind: 'referenced', referenceNodePath: <its placement
   * root> }`, and when that root is live the bake asks here for the record
   * the `AssetOverrides` go into. Exact node, never climbed: what climbs is
   * `locate`. Optional: a test resolver without placements simply omits it.
   */
  livePlacementIdOf?(nodePath: string): string | null;
  /**
   * plan-769 9.22 — the legacy `byPath` keys the LIVE reference node loaded from
   * `nodes[index]` migrated (path → address), or null. The bake writes them as
   * `byAddress`, so a migrated path never goes back into the file as a path.
   */
  overridePathMigrationAt?(index: number): Readonly<Record<string, string>> | null;
}

// ─── Options / result ────────────────────────────────────────────────────

export interface BakeOptions {
  /**
   * The root file's raw glTF node names, indexed like `nodes[]`, captured when
   * the model was LOADED. Proves the bytes being patched are still the file the
   * indices were derived from — see {@link ModelSourceChangedError}.
   */
  expectedNames?: readonly (string | undefined)[];
  /**
   * Identity of the file being written: its asset id and/or its path. A written
   * reference matching either is a cycle.
   */
  self?: { assetId?: string; path?: string };
  /**
   * Treat `cameraStart: null` as "remove the preset" rather than "no opinion".
   *
   * Only correct for a writer whose materialised state is the COMPLETE truth of
   * the file — the scene write of Phase 6. For a bake that merely folds some
   * edits into an existing model it would delete an authored preset on the first
   * unrelated save, which is why it is off by default.
   */
  clearCameraWhenUnset?: boolean;
  /**
   * Node name for a placement whose label is empty. Only reached by a malformed
   * placement; exposed so the fallback is testable rather than magic.
   */
  fallbackPlacementName?: string;
  /**
   * The scene's workspace settings, written as a `SceneSettings` component on
   * the scene root.
   *
   * `SceneEditsSettings` is not one of the seven materialised categories — it
   * sits beside the op array on `RvScene.edits`, so nothing in
   * {@link MaterialisedEdits} carries it. A scene written as a GLB without this
   * would keep every edit and lose the catalogues it was built from. Optional
   * because a bake that only folds some edits into an existing model has no
   * opinion about them; `null` clears the block.
   */
  settings?: SceneSettings | null;
  /**
   * What this document *is* — level plus tags, written as a `Classification`
   * component on the scene root (plan-413 §2.3).
   *
   * Three-state exactly like {@link BakeOptions.settings}, and for the identical
   * reason: `undefined` means "no opinion" and leaves an authored block alone,
   * so folding an unrelated field edit into a model cannot strip the
   * classification a user set; `null` clears it; a value replaces it.
   *
   * This is the one field of the block that makes it the SOURCE of truth —
   * every write goes through here first, and the manifest cache is derived
   * afterwards ("sidecar follows the bytes", §2.5).
   */
  classification?: DocumentClassification | null;
  /**
   * What this document is ABOUT — a one-line summary and a Markdown
   * description, written as a `DocumentInfo` block beside `Classification`
   * (plan-506 §2.3).
   *
   * Same three states as {@link BakeOptions.classification}, for the same
   * reason: `undefined` leaves an authored block alone (an unrelated field edit
   * must not strip a description), `null` removes it, a value replaces it.
   */
  documentInfo?: DocumentInfo | null;
  /**
   * plan-641 M5 — the document's macros, written as `Macros` beside `DocumentInfo`.
   * Same three states: `undefined` leaves an authored block alone (a save of a
   * document whose macros nobody touched keeps them byte-identical), `null`
   * removes it, an array replaces it.
   */
  macros?: readonly unknown[] | null;
  /**
   * plan-630 §2.8 — the planning scenarios, written as `PlanningScenarios` beside
   * `DocumentInfo`. Same three states: `undefined` leaves an authored block alone (every
   * save that has no opinion about scenarios keeps them), `null` — or a block with only the
   * empty default scenario — removes it, a block replaces it.
   */
  planningScenarios?: PlanningScenarioBlock | null;
  /**
   * plan-2013 §2.8 — the document's variants, written as `Variants` beside `DocumentInfo`.
   * The SERIALISED block (`serializeVariantsBlock`), so the bake never imports variant code.
   * Same three states: `undefined` leaves an authored block alone (every save that has no
   * opinion about variants keeps them — also a document whose variants were never loaded
   * because the preference is off), `null` removes it, an object replaces it.
   */
  variants?: Record<string, unknown> | null;
}

export interface BakeResult {
  /** The baked GLB. */
  glb: Uint8Array;
  /** Which of the two paths ran. */
  path: 'fast' | 'full';
  /** True when the BIN chunk was copied verbatim — the fast path's guarantee. */
  binChunkUnchanged: boolean;
  /** glTF nodes that received at least one overlay field. */
  nodes: number;
  /** Individual fields written or deleted (overlay + routed overrides). */
  fields: number;
  /** Overlay entries routed to an `AssetOverrides` block instead of a node. */
  referenceOverrides: number;
  /** `AssetReference` nodes created from planner placements. */
  placements: number;
  /** Nodes created from `addNode` specs. */
  addedNodes: number;
  /** plan-628 8.7: authored subtrees dropped from the file (`removedNodes`). */
  removedNodes: number;
  /** plan-769 Phase 7: base-file placement nodes whose TRS was patched (`baselinePlacementTransforms`). */
  placementsMoved: number;
  /** plan-769 Phase 7: base-file placement nodes dropped by `NodeId` (`removedPlacementIds`). */
  placementsRemoved: number;
  /** Node transforms written as glTF-native TRS on this file's own nodes. */
  transforms: number;
  connections: number;
  connectionTypes: number;
  /** True when a `SceneCamera` was written (false also when one was removed). */
  cameraWritten: boolean;
  /** True when a `SceneSettings` block was written (false when cleared/omitted). */
  settingsWritten: boolean;
  /**
   * True when a `Classification` block was written (false when cleared/omitted).
   *
   * The manifest cache-writer reads this: only a bake that actually stamped the
   * bytes may update the cached classification, which is the write-through
   * ordering of §2.5 expressed as a return value.
   */
  classificationWritten: boolean;
  /**
   * True when a `DocumentInfo` block was written (false when cleared/omitted),
   * the plan-506 sibling of {@link classificationWritten}.
   */
  documentInfoWritten: boolean;
  /**
   * Placements that already existed in the source as a node with the same
   * `NodeId` and were updated in place instead of added a second time.
   */
  placementsUpdated: number;
  /** A now-invalid `rv_sig` was dropped from the default scene extras. */
  signatureDropped: boolean;
  /**
   * Every unresolved `AssetReference` that is IN THE RETURNED BYTES.
   *
   * Read from the final JSON chunk rather than counted while writing, so it
   * describes the file as it now stands — references the source already carried
   * are in here too, not only the ones this bake added. That is the point: it is
   * the input of the plan-703 §2.5 mint, whose rule is "a reference written in
   * bytes gets an identity", and a list of only the new ones would leave a
   * reference that was written by an older build permanently unimprinted.
   *
   * `embedded` references are excluded by {@link collectJsonReferences} — a flat
   * export inlined that subtree, so there is no separate file to identify.
   */
  writtenReferences: WrittenGlbReference[];
  /**
   * Data the bake could not express, one line each. Reported, never silent —
   * today only planner metadata that has no rv-ODT home yet (splat placements,
   * per-placement signal mappings).
   */
  warnings: string[];
}

// ─── Category classification ─────────────────────────────────────────────

/**
 * Could this edit state change the node ARRAY?
 *
 * The fast/full decision as far as the materialised shape alone can tell it
 * (plan §2.6): categories 1, 3, 5, 6 and 7 all write into existing JSON; 2 and 4
 * add nodes, which the JSON-chunk patcher cannot do without also inventing the
 * geometry the exporter owns.
 *
 * The bake itself decides one step later and knows more: a placement the source
 * file ALREADY carries is patched in place, so a re-save that only moves
 * existing placements stays on the fast path. This predicate is the conservative
 * answer for a caller holding no source — it never says "fast" where the bake
 * would say "full".
 */
export function bakeRequiresFullPath(edits: MaterialisedEdits): boolean {
  return edits.placements.length > 0 || edits.addedNodes.length > 0 || (edits.removedNodes?.length ?? 0) > 0
    || (edits.removedPlacementIds?.length ?? 0) > 0;
}

/** True when nothing at all would be written. */
export function bakeIsEmpty(edits: MaterialisedEdits): boolean {
  return Object.keys(edits.overlay.nodes).length === 0
    && edits.placements.length === 0
    && edits.addedNodes.length === 0
    && (edits.removedNodes?.length ?? 0) === 0
    && (edits.baselinePlacementTransforms?.size ?? 0) === 0
    && (edits.removedPlacementIds?.length ?? 0) === 0
    && edits.nodeTransforms.length === 0
    && edits.connections.length === 0
    && edits.connectionTypes.length === 0
    && edits.cameraStart === null;
}

// ─── glTF JSON shapes ────────────────────────────────────────────────────

interface GltfNode {
  name?: string;
  children?: number[];
  extras?: Record<string, unknown>;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

function rvExtrasOf(node: { extras?: Record<string, unknown> }): Record<string, Record<string, unknown>> {
  const extras = (node.extras ??= {});
  return (extras.realvirtual ??= {}) as Record<string, Record<string, unknown>>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `obj[key]` as an OWN plain record, created when absent (never an inherited object). */
function ownRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const cur = ownValue(obj, key);
  if (isPlainObject(cur)) return cur;
  const fresh: Record<string, unknown> = {};
  obj[key] = fresh;
  return fresh;
}

// ─── Category 1: overlay (split into own-file and reference overrides) ───

interface SplitOverlay {
  /** glTF node index → the merge patch to apply to its `extras.realvirtual`. */
  own: Map<number, Record<string, Record<string, unknown>>>;
  /** Reference node index → override address → patch, merged into its `AssetOverrides.byAddress`. */
  routed: Map<number, Record<string, Record<string, Record<string, unknown>>>>;
  routedEntries: number;
}

/**
 * Decide, per overlay entry, whether it is a write into this file or an override
 * on a referenced one — and refuse everything that is neither.
 *
 * All three failure modes are collected before any is thrown, so one run reports
 * the whole problem instead of one path per attempt.
 */
function splitOverlay(
  overlay: MaterialisedEdits['overlay'],
  resolver: BakeResolver,
  gltfNodes: GltfNode[],
  expected: readonly (string | undefined)[] | null,
): SplitOverlay {
  const own = new Map<number, Record<string, Record<string, unknown>>>();
  const routed = new Map<number, Record<string, Record<string, Record<string, unknown>>>>();
  const unresolved: string[] = [];
  const unwritable: string[] = [];
  const unrepresentable: string[] = [];
  /** `undefined` object properties JSON drops losslessly — warn, never refuse. */
  const droppedUndefined: string[] = [];
  const scratch: string[] = [];
  let routedEntries = 0;

  const checkIdentity = (index: number): void => {
    if (!expected) return;
    const node = gltfNodes[index];
    if (node?.name !== expected[index]) {
      throw new ModelSourceChangedError(
        `node ${index} is now "${node?.name ?? '<unnamed>'}" instead of "${expected[index] ?? '<unnamed>'}"`,
      );
    }
  };

  for (const [nodePath, patch] of Object.entries(overlay.nodes)) {
    for (const [componentType, fields] of Object.entries(patch)) {
      for (const [fieldName, value] of Object.entries(fields)) {
        scratch.length = 0;
        const why = unrepresentableReason(value, new Set(), scratch);
        for (const prop of scratch) {
          droppedUndefined.push(`${nodePath} → ${componentType}.${fieldName}${prop}`);
        }
        if (why) {
          unrepresentable.push(
            `${nodePath} → ${componentType}.${fieldName}`
            + (why.startsWith('.') || why.startsWith('[') ? why : `: ${why}`),
          );
        }
      }
    }

    const location = resolver.locate(nodePath);
    if (!location) { unresolved.push(nodePath); continue; }

    if (location.kind === 'root') {
      if (!gltfNodes[location.index]) { unresolved.push(nodePath); continue; }
      checkIdentity(location.index);
      const target = own.get(location.index) ?? {};
      mergePatchInto(target, patch);
      own.set(location.index, target);
      continue;
    }

    // A referenced node: the override belongs on the reference node, which must
    // itself live in the file we are writing.
    const owner = resolver.locate(location.referenceNodePath);
    if (!owner) { unresolved.push(location.referenceNodePath); continue; }
    if (owner.kind !== 'root' || !gltfNodes[owner.index]) { unwritable.push(nodePath); continue; }
    checkIdentity(owner.index);
    const block = routed.get(owner.index) ?? {};
    const key = locationAddress(location);
    const existing = block[key] ?? {};
    mergePatchInto(existing, patch);
    block[key] = existing;
    routed.set(owner.index, block);
    routedEntries++;
  }

  if (unresolved.length > 0) throw new NodeNotFoundError(unresolved);
  if (unwritable.length > 0) throw new ReferencedFileWriteError(unwritable);
  if (unrepresentable.length > 0) throw new UnrepresentableValueError(unrepresentable);
  warnDroppedUndefined('scene-bake', droppedUndefined);

  return { own, routed, routedEntries };
}

/** Merge one component patch into another, per component type. */
function mergePatchInto(
  target: Record<string, Record<string, unknown>>,
  patch: Record<string, Record<string, unknown>>,
): void {
  for (const [componentType, fields] of Object.entries(patch)) {
    if (isUnsafeObjectKey(componentType)) continue;
    const slot = ownRecord(target, componentType);
    for (const [k, v] of Object.entries(fields)) if (!isUnsafeObjectKey(k)) slot[k] = v;
  }
}

/**
 * Apply a merge patch to a glTF node's `extras.realvirtual`.
 *
 * RFC 7396, identical to `applyOverlayToNode` and `applyComponentPatch`: a value
 * replaces, `null` deletes, and the component object is created even when every
 * field in it was deleted — so the written file behaves exactly like the scene
 * the user was looking at.
 */
function applyPatchToGltfNode(
  node: GltfNode,
  patch: Record<string, Record<string, unknown>>,
): { touched: boolean; fields: number } {
  const rv = rvExtrasOf(node);
  let touched = false;
  let fields = 0;
  for (const [componentType, componentFields] of Object.entries(patch)) {
    // Content-safe (rv-safe-keys.ts): no prototype-slot keys, OWN records only.
    if (isUnsafeObjectKey(componentType)) continue;
    const target = ownRecord(rv, componentType);
    for (const [fieldName, value] of Object.entries(componentFields)) {
      if (isUnsafeObjectKey(fieldName)) continue;
      if (value === null) {
        if (Object.prototype.hasOwnProperty.call(target, fieldName)) { delete target[fieldName]; fields++; touched = true; }
      } else {
        target[fieldName] = value;
        fields++;
        touched = true;
      }
    }
  }
  return { touched, fields };
}

/**
 * Merge routed overrides into a reference node's `AssetOverrides.byAddress` (plan-769):
 * key `#<id>` = the node's id in the referenced asset. The record is brought into the
 * 769 form first (`byNodeId` read as `#id`, `trsByNodeId` dropped, unresolved `byPath` kept).
 */
function applyRoutedOverrides(
  node: GltfNode,
  block: Record<string, Record<string, Record<string, unknown>>>,
): number {
  const rv = rvExtrasOf(node);
  canonicalizeAssetOverridesIn(rv);
  const overrides = (rv[RV_ASSET_OVERRIDES_KEY] ??= {}) as Record<string, unknown>;
  const byAddress = isPlainObject(overrides.byAddress)
    ? overrides.byAddress as Record<string, Record<string, Record<string, unknown>>>
    : {};
  overrides.byAddress = byAddress;

  let fields = 0;
  for (const [address, patch] of Object.entries(block)) {
    if (isUnsafeObjectKey(address)) continue;
    const slot = ownRecord(byAddress, address) as Record<string, Record<string, unknown>>;
    for (const [componentType, componentFields] of Object.entries(patch)) {
      if (isUnsafeObjectKey(componentType)) continue;
      const target = ownRecord(slot, componentType);
      for (const [fieldName, value] of Object.entries(componentFields)) {
        if (isUnsafeObjectKey(fieldName)) continue;
        target[fieldName] = value;
        fields++;
      }
    }
  }
  return fields;
}

// ─── Category 5: node transforms → glTF-native TRS ──────────────────────

const IDENTITY_QUATERNION = [0, 0, 0, 1] as const;

/**
 * Write a local transform onto `nodes[i]`.
 *
 * glTF forbids `matrix` alongside TRS, so a node that carries one is decomposed
 * first — dropping the matrix outright would silently discard the scale the op
 * deliberately does not touch (`SetNodeTransformOp` stores position and rotation
 * only, because a GLB node may carry mirror scale that must survive).
 */
function writeNodeTransform(
  node: GltfNode,
  position: readonly [number, number, number],
  quaternion: readonly [number, number, number, number],
): void {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    const scale = new Vector3();
    new Matrix4().fromArray(node.matrix).decompose(new Vector3(), new Quaternion(), scale);
    delete node.matrix;
    if (scale.x !== 1 || scale.y !== 1 || scale.z !== 1) node.scale = [scale.x, scale.y, scale.z];
  }
  if (position[0] === 0 && position[1] === 0 && position[2] === 0) delete node.translation;
  else node.translation = [position[0], position[1], position[2]];

  const isIdentity = quaternion.every((v, i) => v === IDENTITY_QUATERNION[i]);
  if (isIdentity) delete node.rotation;
  else node.rotation = [quaternion[0], quaternion[1], quaternion[2], quaternion[3]];
}

// ─── Categories 6/7: the Connections block ──────────────────────────────

/**
 * Merge edit-op connections into the file's `Connections` block.
 *
 * The block lives in the default scene extras — the normative file-level place.
 * A connection the file already authored on some NODE and that the edits also
 * define is dropped from that node: the registry keys edges by id, so leaving
 * both in would make the winner depend on traversal order, which is exactly the
 * kind of "sometimes it saves right" bug that never gets reported cleanly.
 */
function writeConnections(
  json: Record<string, unknown>,
  connections: readonly RvConnection[],
  connectionTypes: readonly ConnectionType[],
): void {
  if (connections.length === 0 && connectionTypes.length === 0) return;

  const editedIds = new Set(connections.map((c) => c.id));
  const editedTypes = new Set(connectionTypes.map((t) => t.type));

  const nodes = (json.nodes as GltfNode[] | undefined) ?? [];
  for (const node of nodes) {
    const rv = node.extras?.realvirtual;
    if (!isPlainObject(rv)) continue;
    const block = rv[RV_CONNECTIONS_KEY];
    if (!isPlainObject(block)) continue;
    if (Array.isArray(block.connections)) {
      block.connections = (block.connections as RvConnection[])
        .filter((c) => !isPlainObject(c) || !editedIds.has(c.id));
    }
    if (Array.isArray(block.connectionTypes)) {
      block.connectionTypes = (block.connectionTypes as ConnectionType[])
        .filter((t) => !isPlainObject(t) || !editedTypes.has(t.type));
    }
  }

  const sceneExtras = ensureDefaultSceneExtras(json);
  const rv = (sceneExtras.realvirtual ??= {}) as Record<string, unknown>;
  const block = isPlainObject(rv[RV_CONNECTIONS_KEY])
    ? rv[RV_CONNECTIONS_KEY] as Record<string, unknown>
    : {};
  rv[RV_CONNECTIONS_KEY] = block;

  const existingEdges = Array.isArray(block.connections) ? block.connections as RvConnection[] : [];
  const existingTypes = Array.isArray(block.connectionTypes)
    ? block.connectionTypes as ConnectionType[]
    : [];

  block.connections = [
    ...existingEdges.filter((c) => !isPlainObject(c) || !editedIds.has(c.id)),
    ...connections,
  ];
  block.connectionTypes = [
    ...existingTypes.filter((t) => !isPlainObject(t) || !editedTypes.has(t.type)),
    ...connectionTypes,
  ];
}

// ─── Category 3: SceneCamera ────────────────────────────────────────────

/**
 * Write (or clear) the camera preset in the default scene extras.
 *
 * `cameraStart: null` is ambiguous by construction — it means both "the user
 * cleared the camera" and "no `setCamera` op was ever recorded", and the
 * materialised shape cannot tell them apart. Deleting on every save would throw
 * away an authored preset the moment anyone edits an unrelated field, so the
 * default is to leave it alone. A writer whose materialised state IS the whole
 * truth of the file — the Phase 6 scene write — opts into the destructive
 * reading with {@link BakeOptions.clearCameraWhenUnset}.
 */
function writeSceneCamera(
  json: Record<string, unknown>,
  edits: MaterialisedEdits,
  clearWhenUnset: boolean,
): boolean {
  if (!edits.cameraStart) {
    if (!clearWhenUnset) return false;
    const existing = defaultSceneExtras(json);
    const rv = existing?.realvirtual;
    if (isPlainObject(rv)) delete rv[RV_SCENE_CAMERA_KEY];
    return false;
  }
  const sceneExtras = ensureDefaultSceneExtras(json);
  const rv = (sceneExtras.realvirtual ??= {}) as Record<string, unknown>;
  rv[RV_SCENE_CAMERA_KEY] = { ...sceneCameraFromCameraStart(edits.cameraStart) };
  return true;
}

// ─── Workspace settings ─────────────────────────────────────────────────

/**
 * Write (or clear) the `SceneSettings` block in the default scene extras.
 *
 * `undefined` means "no opinion" and leaves an authored block alone — the same
 * distinction {@link BakeOptions.clearCameraWhenUnset} draws for the camera, and
 * for the same reason: a bake that only folds a field change into a model must
 * not delete settings it was never told about.
 */
function writeSceneSettings(
  json: Record<string, unknown>,
  settings: SceneSettings | null | undefined,
): boolean {
  if (settings === undefined) return false;
  if (settings === null) {
    const rv = defaultSceneExtras(json)?.realvirtual;
    if (isPlainObject(rv)) delete rv[RV_SCENE_SETTINGS_KEY];
    return false;
  }
  const sceneExtras = ensureDefaultSceneExtras(json);
  const rv = (sceneExtras.realvirtual ??= {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (settings.catalogUrls) out.catalogUrls = [...settings.catalogUrls];
  if (settings.gridSizeMm !== undefined) out.gridSizeMm = settings.gridSizeMm;
  rv[RV_SCENE_SETTINGS_KEY] = out;
  return true;
}

// ─── Classification (plan-413) ──────────────────────────────────────────

/**
 * Write (or clear) the `Classification` block in the default scene extras.
 *
 * Third function after {@link writeSceneCamera} and {@link writeSceneSettings}
 * and deliberately identical in shape: `undefined` leaves an authored block
 * alone, `null` deletes it, a value replaces it. An empty classification —
 * no level, no tags — is treated as `null`, because "classified as nothing" and
 * "never classified" must not be two different things on disk; otherwise the
 * cache comparison of §2.5 would flap between them forever.
 *
 * Only the JSON chunk is touched. The BIN tail is copied byte-for-byte by
 * {@link rebuildGlbWithJson}, which is what lets a classification be stamped
 * onto a 100 MB model without re-encoding a single mesh.
 */
export function writeClassification(
  json: Record<string, unknown>,
  classification: DocumentClassification | null | undefined,
): boolean {
  if (classification === undefined) return false;
  if (classification === null || isEmptyClassification(classification)) {
    const rv = defaultSceneExtras(json)?.realvirtual;
    if (isPlainObject(rv)) delete rv[RV_CLASSIFICATION_KEY];
    return false;
  }
  const sceneExtras = ensureDefaultSceneExtras(json);
  const rv = (sceneExtras.realvirtual ??= {}) as Record<string, unknown>;
  rv[RV_CLASSIFICATION_KEY] = classificationPayload(classification);
  return true;
}

// ─── DocumentInfo (plan-506) ────────────────────────────────────────────

/**
 * Write (or clear) the `DocumentInfo` block in the default scene extras.
 *
 * The fourth sister of {@link writeSceneCamera}, {@link writeSceneSettings} and
 * {@link writeClassification}, identical in shape on purpose. Only the OWN key
 * is replaced or deleted: a block of an unknown future version written by a
 * newer viewer sits under the same key and is replaced only when the user
 * actually writes a description here — never touched by a bake that had no
 * opinion (`undefined`). An empty block is `null`, so "never described" and
 * "described as nothing" stay one state on disk.
 */
export function writeDocumentInfo(
  json: Record<string, unknown>,
  info: DocumentInfo | null | undefined,
): boolean {
  if (info === undefined) return false;
  if (info === null || isEmptyDocumentInfo(info)) {
    const rv = defaultSceneExtras(json)?.realvirtual;
    if (isPlainObject(rv)) delete rv[RV_DOCUMENT_INFO_KEY];
    return false;
  }
  const sceneExtras = ensureDefaultSceneExtras(json);
  const rv = (sceneExtras.realvirtual ??= {}) as Record<string, unknown>;
  rv[RV_DOCUMENT_INFO_KEY] = documentInfoPayload(info);
  return true;
}

// ─── Macros (plan-641 M5) ───────────────────────────────────────────────

/**
 * Write (or clear) the `Macros` block in the default scene extras — the sister
 * of {@link writeDocumentInfo}, identical in its three states.
 */
export function writeMacros(json: Record<string, unknown>, macros: readonly unknown[] | null | undefined): boolean {
  if (macros === undefined) return false;
  if (macros === null || macros.length === 0) {
    const rv = defaultSceneExtras(json)?.realvirtual;
    if (isPlainObject(rv)) delete rv[RV_MACROS_KEY];
    return false;
  }
  const sceneExtras = ensureDefaultSceneExtras(json);
  const rv = (sceneExtras.realvirtual ??= {}) as Record<string, unknown>;
  rv[RV_MACROS_KEY] = JSON.parse(JSON.stringify(macros));
  return true;
}

// ─── PlanningScenarios (plan-630 §2.8) ──────────────────────────────────

/**
 * Write (or clear) the `PlanningScenarios` block in the default scene extras — the sister
 * of {@link writeDocumentInfo}, identical in its three states. Only the own key is touched.
 */
export function writePlanningScenarios(
  json: Record<string, unknown>,
  block: PlanningScenarioBlock | null | undefined,
): boolean {
  if (block === undefined) return false;
  if (block === null || isEmptyScenarioBlock(block)) {
    const rv = defaultSceneExtras(json)?.realvirtual;
    if (isPlainObject(rv)) delete rv[RV_PLANNING_SCENARIOS_KEY];
    return false;
  }
  const sceneExtras = ensureDefaultSceneExtras(json);
  const rv = (sceneExtras.realvirtual ??= {}) as Record<string, unknown>;
  rv[RV_PLANNING_SCENARIOS_KEY] = planningScenariosPayload(block);
  return true;
}

// ─── Variants (plan-2013 §2.8) ──────────────────────────────────────────

/** Scene-extras key of the variants block (the model module re-exports the same name). */
const RV_VARIANTS_KEY = 'Variants';

/** Write (or clear) the `Variants` block — three states like {@link writePlanningScenarios}. */
export function writeVariants(json: Record<string, unknown>, payload: Record<string, unknown> | null | undefined): boolean {
  if (payload === undefined) return false;
  if (payload === null) {
    const rv = defaultSceneExtras(json)?.realvirtual;
    if (isPlainObject(rv)) delete rv[RV_VARIANTS_KEY];
    return false;
  }
  const sceneExtras = ensureDefaultSceneExtras(json);
  const rv = (sceneExtras.realvirtual ??= {}) as Record<string, unknown>;
  rv[RV_VARIANTS_KEY] = JSON.parse(JSON.stringify(payload));
  return true;
}

// ─── File-level pass (shared by both paths) ─────────────────────────────

/** Everything that belongs to the FILE rather than to one node. */
function writeFileLevel(
  json: Record<string, unknown>,
  edits: MaterialisedEdits,
  options: BakeOptions,
): {
  cameraWritten: boolean;
  settingsWritten: boolean;
  classificationWritten: boolean;
  documentInfoWritten: boolean;
} {
  const cameraWritten = writeSceneCamera(json, edits, options.clearCameraWhenUnset === true);
  writeConnections(json, edits.connections, edits.connectionTypes);
  const settingsWritten = writeSceneSettings(json, options.settings);
  const classificationWritten = writeClassification(json, options.classification);
  const documentInfoWritten = writeDocumentInfo(json, options.documentInfo);
  writeMacros(json, options.macros);
  writePlanningScenarios(json, options.planningScenarios);
  writeVariants(json, options.variants);
  return { cameraWritten, settingsWritten, classificationWritten, documentInfoWritten };
}

/**
 * Drop a signature the edit just invalidated.
 *
 * `rv_sig` covers the whole file, so any JSON edit breaks it. Leaving it would
 * make the result report as tampered and gate all component logic on load;
 * re-signing, where a delivery needs it, belongs after this step.
 */
function dropSignature(json: Record<string, unknown>): boolean {
  const sceneExtras = defaultSceneExtras(json);
  const present = !!sceneExtras && Object.prototype.hasOwnProperty.call(sceneExtras, 'rv_sig');
  if (present) delete sceneExtras!.rv_sig;
  return present;
}

// ─── Save-time cycle check (F10) ────────────────────────────────────────

/** Every `AssetReference` in the JSON, with the node index that carries it. */
function collectJsonReferences(
  json: Record<string, unknown>,
): Array<{ index: number; assetId: string; path: string }> {
  const nodes = (json.nodes as GltfNode[] | undefined) ?? [];
  const out: Array<{ index: number; assetId: string; path: string }> = [];
  nodes.forEach((node, index) => {
    const rv = node.extras?.realvirtual;
    if (!isPlainObject(rv)) return;
    const ref = rv[RV_ASSET_REFERENCE_KEY];
    if (!isPlainObject(ref)) return;
    if (ref.embedded === true) return;
    out.push({
      index,
      assetId: typeof ref.assetId === 'string' ? ref.assetId : '',
      path: typeof ref.path === 'string' ? ref.path : '',
    });
  });
  return out;
}

/**
 * The same list, in the shape the identity mint takes (plan-703 §2.5).
 *
 * A thin projection rather than a second traversal: "which references are in
 * these bytes" must have exactly one answer, or the cycle check and the mint
 * could disagree about what was written.
 */
function writtenReferencesOf(json: Record<string, unknown>): WrittenGlbReference[] {
  return collectJsonReferences(json).map(({ assetId, path }) => ({ assetId, path }));
}

/**
 * Refuse a file that would reference itself, directly or through its own tree.
 *
 * Only the part that is decidable WITHOUT fetching: a reference back to this
 * file, and a reference nested under another reference to the same asset within
 * this one file. The full transitive check needs the referenced bytes and is
 * where composition's `ReferenceCycleError` takes over on load.
 */
function assertNoSaveCycle(json: Record<string, unknown>, self: BakeOptions['self']): void {
  const references = collectJsonReferences(json);
  if (references.length === 0) return;

  const selfKeys = new Set<string>();
  if (self?.assetId) selfKeys.add(`id:${self.assetId}`);
  if (self?.path) selfKeys.add(`url:${self.path}`);

  const keyOf = (ref: { assetId: string; path: string }): string =>
    ref.assetId ? `id:${ref.assetId}` : `url:${ref.path}`;

  const label = self?.assetId || self?.path || '<this file>';
  for (const ref of references) {
    if (selfKeys.has(keyOf(ref))) {
      throw new SaveReferenceCycleError([label, ref.assetId || ref.path || '<unnamed>']);
    }
  }

  // Nested references to the same asset inside this one file: walk the node
  // graph and carry the ancestor set down. Cheap, and it catches the shape a
  // "wrap the selection into a reference" action can produce by accident.
  const nodes = (json.nodes as GltfNode[] | undefined) ?? [];
  const byIndex = new Map(references.map((r) => [r.index, r]));
  const seenOnPath = new Set<string>();
  const trail: string[] = [label];
  const visit = (index: number, depth: number): void => {
    if (depth > 512) return; // malformed graph; composition refuses it on load
    const node = nodes[index];
    if (!node) return;
    const ref = byIndex.get(index);
    let pushed: string | null = null;
    if (ref) {
      const key = keyOf(ref);
      const name = ref.assetId || ref.path || '<unnamed>';
      if (seenOnPath.has(key)) throw new SaveReferenceCycleError([...trail, name]);
      seenOnPath.add(key);
      trail.push(name);
      pushed = key;
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
    if (pushed) {
      seenOnPath.delete(pushed);
      trail.pop();
    }
  };

  const sceneIndex = (json.scene as number | undefined) ?? 0;
  const scenes = json.scenes as Array<{ nodes?: number[] }> | undefined;
  const roots = scenes?.[sceneIndex]?.nodes ?? nodes.map((_, i) => i);
  for (const root of roots) visit(root, 0);
}

// ─── Fast path ──────────────────────────────────────────────────────────

interface NodeLevelCounts {
  nodes: number;
  fields: number;
  referenceOverrides: number;
  transforms: number;
}

/** Categories 1 and 5 — everything that patches an EXISTING `nodes[]` entry. */
function writeNodeLevel(
  chunks: GlbChunks,
  edits: MaterialisedEdits,
  resolver: BakeResolver,
  options: BakeOptions,
): NodeLevelCounts {
  const gltfNodes = (chunks.json.nodes as GltfNode[] | undefined) ?? [];

  // An EMPTY expectedNames array means "nothing was captured", not "the file has
  // no nodes" — treating it as the latter refuses every model whose load path
  // did not record names, blaming a change that never happened.
  const expected = options.expectedNames?.length ? options.expectedNames : null;
  if (expected && gltfNodes.length !== expected.length) {
    throw new ModelSourceChangedError(
      `it now has ${gltfNodes.length} nodes instead of ${expected.length}`,
    );
  }

  // plan-769 9.22: legacy paths the live reference node resolved are written as addresses.
  if (resolver.overridePathMigrationAt) {
    gltfNodes.forEach((n, index) => {
      const rv = n.extras?.realvirtual as Record<string, unknown> | undefined;
      if (!rv || !(RV_ASSET_OVERRIDES_KEY in rv)) return;
      const migrated = resolver.overridePathMigrationAt!(index);
      if (migrated) migrateStoredOverridePaths(rv, migrated);
    });
  }

  const split = splitOverlay(edits.overlay, resolver, gltfNodes, expected);

  let nodes = 0;
  let fields = 0;
  for (const [index, patch] of split.own) {
    const result = applyPatchToGltfNode(gltfNodes[index], patch);
    fields += result.fields;
    if (result.touched) nodes++;
  }
  for (const [index, block] of split.routed) {
    fields += applyRoutedOverrides(gltfNodes[index], block);
  }

  // Category 5. Two outcomes, decided the same way category 1 decides it — by
  // where the node lives:
  //
  //  - own file          → glTF-native TRS on `nodes[i]`, as it always was;
  //  - inside a placement (referenced, any depth) → refused by name
  //                        ({@link NestedTransformRefusedError}, plan-769 D11/F14:
  //                        `trsByNodeId` is gone, only component values are overridable).
  //
  // The nodeTransforms array is ALREADY coalesced to the final TRS per node —
  // `materialise` keys it by nodePath.
  const unknown: string[] = [];
  const refused: string[] = [];
  const refusedOwners: string[] = [];
  let transforms = 0;
  for (const entry of edits.nodeTransforms) {
    const location = resolver.locate(entry.nodePath);
    if (!location) { unknown.push(entry.nodePath); continue; }

    if (location.kind === 'root') {
      if (!gltfNodes[location.index]) {
        unknown.push(entry.nodePath);
        continue;
      }
      if (expected && gltfNodes[location.index].name !== expected[location.index]) {
        throw new ModelSourceChangedError(
          `node ${location.index} is now "${gltfNodes[location.index].name ?? '<unnamed>'}" `
          + `instead of "${expected[location.index] ?? '<unnamed>'}"`,
        );
      }
      writeNodeTransform(gltfNodes[location.index], entry.position, entry.quaternion);
      transforms++;
      continue;
    }

    refused.push(entry.nodePath);
    refusedOwners.push(location.referenceNodePath);
  }
  if (refused.length > 0) {
    // The save dialog shows the error; the Problems panel keeps one entry per refused
    // node until the next save attempt or a document change.
    refused.forEach((nodePath, i) => reportNestedTransformRefused({ nodePath, placementPath: refusedOwners[i]! }));
    throw new NestedTransformRefusedError(refused, refusedOwners, unknown);
  }
  if (unknown.length > 0) throw new UnwritableTransformError(unknown, unknown);

  return {
    nodes,
    fields,
    referenceOverrides: split.routedEntries,
    transforms,
  };
}

// ─── Full path: structural categories 2 and 4 ───────────────────────────

const DEG_TO_RAD = Math.PI / 180;

/** Find a node in a freshly parsed tree by the scene path an edit recorded. */
function findByScenePath(root: Object3D, path: string): Object3D | null {
  if (!path) return root;
  const segments = path.split('/').filter(Boolean);

  const walk = (from: Object3D, start: number): Object3D | null => {
    let node: Object3D = from;
    for (let i = start; i < segments.length; i++) {
      const next = node.children.find((c) => c.name === segments[i]);
      if (!next) return null;
      node = next;
    }
    return node;
  };

  // Registry paths may or may not carry the GLB root's own name as the first
  // segment, depending on how the tree was mounted. Try both before giving up.
  const direct = walk(root, 0);
  if (direct) return direct;
  if (segments[0] === root.name) {
    const skipped = walk(root, 1);
    if (skipped) return skipped;
  }

  // Last resort: a unique node of that name anywhere. Ambiguity is NOT resolved
  // by picking the first — that is how an edit lands on the wrong machine part.
  const leaf = segments[segments.length - 1];
  const matches: Object3D[] = [];
  root.traverse((n) => { if (n.name === leaf) matches.push(n); });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The rv-ODT extras of one placement: identity, what it points at, and what an
 * `AssetReference` cannot express.
 *
 * A **splat** placement gets no `AssetReference` at all. A reference points at a
 * glTF asset by definition, and composition would spend a resolution attempt on
 * every splat only to report it missing. Its catalog identity moves into
 * `PlacementMeta.catalogId` instead — the one case where that field is written.
 */
export function placementExtras(placement: PlacedComponent): Record<string, unknown> {
  const isSplat = !!placement.splatUrl;

  const meta: PlacementMeta = {};
  if (isSplat) {
    meta.splatUrl = placement.splatUrl;
    if (placement.catalogId) meta.catalogId = placement.catalogId;
    // plan-778: a splat has no AssetReference — its qualifier rides in the meta.
    if (placement.providerId) meta.providerId = placement.providerId;
    if (placement.sourceId) meta.sourceId = placement.sourceId;
  }
  if (placement.visible === false) meta.visible = false;
  if (placement.signalMappings?.length) {
    // plan-769 F15: stored by ADDRESS (`componentAddress` / `sourceAddress`).
    meta.signalMappings = storedSignalMappingsOf(placement) as unknown as Record<string, unknown>[];
  }

  const out: Record<string, unknown> = { [RV_NODE_ID_KEY]: placement.id };
  if (!isSplat) {
    const reference: Record<string, unknown> = { assetId: placement.catalogId };
    // plan-778 F4: the qualifier as stored on the record — a qualified one
    // (library project) is written WITHOUT a `path`: the library resolves it,
    // a path could only ever point somewhere else. A legacy pair (pre-778
    // `global` + catalog URL) is kept as it was written, never upgraded.
    if (placement.providerId) reference.providerId = placement.providerId;
    if (placement.sourceId) reference.sourceId = placement.sourceId;
    const qualified = isQualifiedRef(placement);
    // A blob: URL is a session artifact (ResolvedAsset contract: volatile,
    // NEVER persisted) — dead on the next load, where it would shadow the
    // assetId resolution with a guaranteed fetch failure (plan-921 finding).
    if (!qualified && placement.glbUrl && !placement.glbUrl.startsWith('blob:')) reference.path = placement.glbUrl;
    // The authoring half of plan-703 §2.8: the extents measured when the asset
    // was placed travel into the file, so a later load that cannot resolve it
    // still knows how big to draw the hole. Additive — a placement recorded
    // before the field existed simply omits it.
    if (placement.bounds) {
      reference.bounds = {
        min: [...placement.bounds.min],
        max: [...placement.bounds.max],
      };
    }
    out[RV_ASSET_REFERENCE_KEY] = reference;
  }
  // Written even when empty: its PRESENCE is what marks the node as a planner
  // placement, which is how a reader tells one from a reference node an author
  // wrote by hand. An absent-when-empty marker would make that test conditional
  // on data that has nothing to do with it.
  out[RV_PLACEMENT_META_KEY] = { ...meta };
  return out;
}

/**
 * A planner placement becomes a reference node: identity, location, transform —
 * and no geometry at all, because composition fetches the referenced file on
 * load. That is what makes F11 more than a rename: the placement stops being a
 * record that only the planner understands and becomes ordinary scene structure.
 *
 * `visible` is carried in `PlacementMeta`, not on the node: glTF has no
 * visibility flag and `GLTFExporter` writes none, so a hidden placement would
 * come back visible on the next load. (`objectToGlb` passes `onlyVisible:false`,
 * which is what keeps it in the file at all.)
 */
/**
 * The reference node's name IS the record's name (plan-758: record is the
 * truth, `label === node.name` at every creation path). The fallback exists
 * only so a record that somehow reached the save nameless does not produce an
 * unloadable file — and it is LOUD, because every producer is supposed to have
 * made this impossible. Shared by the full bake and the incremental re-save.
 */
function placementNodeName(placement: PlacedComponent, fallbackName: string): string {
  const name = placement.label?.trim();
  if (name) return name;
  console.error(`[SceneSave] placement ${placement.id} has an empty name — writing "${fallbackName}"`);
  reportPlacementNameEmpty({ placementId: placement.id, fallback: fallbackName });
  return fallbackName;
}

function buildPlacementNode(
  placement: PlacedComponent,
  fallbackName: string,
  patch?: Record<string, Record<string, unknown>>,
): Object3D {
  const node = new Object3D();
  node.name = placementNodeName(placement, fallbackName);
  node.position.set(placement.position[0], placement.position[1], placement.position[2]);
  node.quaternion.setFromEuler(new Euler(
    placement.rotation[0] * DEG_TO_RAD,
    placement.rotation[1] * DEG_TO_RAD,
    placement.rotation[2] * DEG_TO_RAD,
    'XYZ',
  ));
  node.scale.set(placement.scale[0], placement.scale[1], placement.scale[2]);
  if (placement.visible === false) node.visible = false;
  const rv = placementExtras(placement);
  if (patch) mergePlacementPatch(rv, patch);
  node.userData.realvirtual = rv;
  return node;
}

/**
 * Merge a component-config overlay patch (plan-921) into placement extras:
 * `{Agv: {PathId: 'PathSouth'}}` becomes `realvirtual.Agv.PathId` on the
 * reference node — where the behavior's config bag reads it after a reload.
 * Per-component shallow merge; the placement identity keys are never touched
 * (a patch carries component types, not RV_* markers).
 */
function mergePlacementPatch(
  rv: Record<string, unknown>,
  patch: Record<string, Record<string, unknown>>,
): void {
  for (const [componentType, fields] of Object.entries(patch)) {
    if (isUnsafeObjectKey(componentType)) continue;
    // plan-757 Phase 2 (4a): the routed `AssetOverrides` of a live placement
    // merge PER ADDRESS (byAddress per component, plan-769)
    // into what the node already carries — a shallow assign would drop every
    // override of a node the patch does not mention.
    if (componentType === RV_ASSET_OVERRIDES_KEY) {
      rv[componentType] = mergeAssetOverrides(rv[componentType], fields);
      continue;
    }
    const existing = ownValue(rv, componentType);
    const target: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
    for (const [k, v] of Object.entries(fields)) if (!isUnsafeObjectKey(k)) target[k] = v;
    rv[componentType] = target;
  }
}

/** `AssetOverrides` ⊕ patch: `byAddress` per address per component (plan-769); the base in the 769 form. */
function mergeAssetOverrides(existing: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const holder: Record<string, unknown> = { [RV_ASSET_OVERRIDES_KEY]: existing };
  canonicalizeAssetOverridesIn(holder);
  const base = isPlainObject(holder[RV_ASSET_OVERRIDES_KEY])
    ? { ...(holder[RV_ASSET_OVERRIDES_KEY] as Record<string, unknown>) }
    : {};
  const byAddress = isPlainObject(base.byAddress)
    ? { ...(base.byAddress as Record<string, Record<string, Record<string, unknown>>>) }
    : {};
  for (const [address, components] of Object.entries((patch.byAddress as Record<string, Record<string, Record<string, unknown>>> | undefined) ?? {})) {
    const slot = { ...(byAddress[address] ?? {}) };
    mergePatchInto(slot, components);
    byAddress[address] = slot;
  }
  return { ...base, ...patch, byAddress };
}

/** An op-created node becomes an ordinary glTF node with its components — and its id (plan-769: `idMap.node`). */
function buildSpecNode(spec: NodeSpec, nodeId?: string): Object3D {
  const node = new Object3D();
  node.name = spec.name;
  node.position.set(spec.position[0], spec.position[1], spec.position[2]);
  node.quaternion.set(spec.quaternion[0], spec.quaternion[1], spec.quaternion[2], spec.quaternion[3]);
  node.scale.set(spec.scale[0], spec.scale[1], spec.scale[2]);
  node.userData.realvirtual = JSON.parse(JSON.stringify(spec.components)) as Record<string, unknown>;
  if (nodeId) (node.userData.realvirtual as Record<string, unknown>)[RV_NODE_ID_KEY] = nodeId;
  return node;
}

// ─── Category 2, in-place half: reconcile with what the file already has ─

/**
 * Update the placements the source file already contains, and report the rest.
 *
 * Once a baked GLB becomes the base a scene is edited on — which is the whole
 * point of phase 6 — every subsequent save materialises the SAME placements
 * again, because they are still placements. Appending them unconditionally
 * would double the layout on the first re-save and quadruple it on the second.
 *
 * A placement is "already there" when a node carries its id as `NodeId`, which
 * is exactly the identity {@link placementExtras} wrote. Such a node is patched
 * in place: transform, name and the placement's own components. Everything else
 * on it — most importantly an `AssetOverrides` block just written by
 * {@link applyRoutedOverrides} — is left untouched, because a placement knows
 * nothing about it and a wholesale replace would silently drop it.
 */
function reconcilePlacements(
  json: Record<string, unknown>,
  placements: readonly PlacedComponent[],
  fallbackName: string,
  placementPatches?: ReadonlyMap<string, Record<string, Record<string, unknown>>>,
): { updated: number; remaining: PlacedComponent[] } {
  if (placements.length === 0) return { updated: 0, remaining: [] };

  const gltfNodes = (json.nodes as GltfNode[] | undefined) ?? [];
  const byNodeId = new Map<string, GltfNode>();
  for (const node of gltfNodes) {
    const rv = node.extras?.realvirtual;
    if (!isPlainObject(rv)) continue;
    const id = rv[RV_NODE_ID_KEY];
    if (typeof id === 'string' && id && !byNodeId.has(id)) byNodeId.set(id, node);
  }

  const remaining: PlacedComponent[] = [];
  let updated = 0;

  for (const placement of placements) {
    const node = byNodeId.get(placement.id);
    if (!node) { remaining.push(placement); continue; }

    node.name = placementNodeName(placement, fallbackName);

    const quaternion = new Quaternion().setFromEuler(new Euler(
      placement.rotation[0] * DEG_TO_RAD,
      placement.rotation[1] * DEG_TO_RAD,
      placement.rotation[2] * DEG_TO_RAD,
      'XYZ',
    ));
    writeNodeTransform(
      node,
      placement.position,
      [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    );
    const [sx, sy, sz] = placement.scale;
    if (sx === 1 && sy === 1 && sz === 1) delete node.scale;
    else node.scale = [sx, sy, sz];

    const rv = rvExtrasOf(node);
    const fresh = placementExtras(placement);
    // A splat placement has no AssetReference; a placement that stopped being a
    // splat has one again. Clearing the key the fresh extras do NOT carry is
    // what keeps the two shapes from being merged into a contradiction.
    if (!(RV_ASSET_REFERENCE_KEY in fresh)) delete rv[RV_ASSET_REFERENCE_KEY];
    for (const [key, value] of Object.entries(fresh)) {
      rv[key] = value as Record<string, unknown>;
    }
    // Plan-921: live-placement component config (see mergePlacementPatch).
    const patch = placementPatches?.get(placement.id);
    if (patch) mergePlacementPatch(rv, patch);
    updated++;
  }

  return { updated, remaining };
}

// ─── plan-769 Phase 7: edits on placements the base file already holds ──

/** `NodeId` → glTF node; the first occurrence wins, as in {@link reconcilePlacements}. */
function gltfNodesByNodeId(json: Record<string, unknown>): Map<string, GltfNode> {
  const byNodeId = new Map<string, GltfNode>();
  for (const node of (json.nodes as GltfNode[] | undefined) ?? []) {
    const rv = node.extras?.realvirtual;
    if (!isPlainObject(rv)) continue;
    const id = rv[RV_NODE_ID_KEY];
    if (typeof id === 'string' && id && !byNodeId.has(id)) byNodeId.set(id, node);
  }
  return byNodeId;
}

/** A glTF node that is a placement / reference node (planner marker or `AssetReference`). */
function isPlacementGltfNode(node: GltfNode): boolean {
  const rv = node.extras?.realvirtual;
  return isPlainObject(rv) && (RV_PLACEMENT_META_KEY in rv || RV_ASSET_REFERENCE_KEY in rv);
}

/**
 * Move placements of the BASE file (D23): a TRS-only patch of the node that
 * carries the placement id as `NodeId`. Nothing else on the node is touched —
 * `AssetReference` (with its `bounds`), `PlacementMeta`, `AssetOverrides` stay
 * as the file holds them; the planner never authored them in this session, so a
 * wholesale rewrite from a record would lose what it does not know.
 *
 * An id the file does not hold as a placement is reported in `orphaned`: the
 * move cannot be written, and saying so is the rule for every unresolvable edit.
 */
function patchBaselinePlacementTransforms(
  json: Record<string, unknown>,
  transforms: ReadonlyMap<string, PlacementTransform> | undefined,
): { moved: number; orphaned: string[] } {
  if (!transforms || transforms.size === 0) return { moved: 0, orphaned: [] };
  const byNodeId = gltfNodesByNodeId(json);
  const orphaned: string[] = [];
  let moved = 0;
  for (const [id, t] of transforms) {
    const node = byNodeId.get(id);
    if (!node || !isPlacementGltfNode(node)) { orphaned.push(id); continue; }
    const quaternion = new Quaternion().setFromEuler(new Euler(
      t.rotation[0] * DEG_TO_RAD,
      t.rotation[1] * DEG_TO_RAD,
      t.rotation[2] * DEG_TO_RAD,
      'XYZ',
    ));
    writeNodeTransform(node, t.position, [quaternion.x, quaternion.y, quaternion.z, quaternion.w]);
    const [sx, sy, sz] = t.scale;
    if (sx === 1 && sy === 1 && sz === 1) delete node.scale;
    else node.scale = [sx, sy, sz];
    moved++;
  }
  return { moved, orphaned };
}

/**
 * The base-file placements a save must drop: the removed ids the source still
 * holds as a placement node. An id the file no longer holds is already in the
 * target state — after "save as new" the saved bytes become the base while the
 * log keeps its ops, so the same removal reaches every later save and must stay
 * silent there.
 */
function presentRemovedPlacementIds(json: Record<string, unknown>, removed: readonly string[] | undefined): Set<string> {
  const present = new Set<string>();
  if (!removed || removed.length === 0) return present;
  const byNodeId = gltfNodesByNodeId(json);
  for (const id of removed) {
    const node = byNodeId.get(id);
    if (node && isPlacementGltfNode(node)) present.add(id);
  }
  return present;
}

/**
 * Does the unresolvable edit path `nodePath` lie under (or on) a removed
 * placement of the source file? Walked through the source's own names — the
 * live registry can no longer answer, the placement is gone from the scene.
 * Registry paths may carry the root's name as the first segment (the rule of
 * {@link findByScenePath}), so both spellings are tried.
 */
function pathUnderRemovedPlacement(
  json: Record<string, unknown>,
  nodePath: string,
  removed: ReadonlySet<string>,
): boolean {
  const nodes = (json.nodes as GltfNode[] | undefined) ?? [];
  const scenes = (json.scenes as Array<{ nodes?: number[] }> | undefined) ?? [];
  const sceneIndex = typeof json.scene === 'number' ? json.scene : 0;
  const roots = scenes[sceneIndex]?.nodes ?? [];
  const segments = nodePath.split('/').filter(Boolean);
  const isRemoved = (index: number): boolean => {
    const rv = nodes[index]?.extras?.realvirtual;
    const id = isPlainObject(rv) ? rv[RV_NODE_ID_KEY] : undefined;
    return typeof id === 'string' && removed.has(id);
  };
  const walk = (start: number): boolean => {
    let level = roots;
    for (let i = start; i < segments.length; i++) {
      const next = level.find((n) => nodes[n]?.name === segments[i]);
      if (next === undefined) return false;
      if (isRemoved(next)) return true;
      level = nodes[next]?.children ?? [];
    }
    return false;
  };
  return walk(0) || (segments.length > 1 && walk(1));
}

/**
 * Edits under a removed base-file placement leave with it (D23): a component
 * override on `P/Child`, then P removed — the entry no longer resolves in the
 * live scene and would refuse the whole save (`NodeNotFoundError`). Only
 * entries the live scene cannot place are dropped; a NEW placement that reuses
 * the removed one's name keeps its own edits.
 */
function dropEditsUnderRemovedPlacements(
  json: Record<string, unknown>,
  edits: MaterialisedEdits,
  resolver: BakeResolver,
  removed: ReadonlySet<string>,
): void {
  if (removed.size === 0) return;
  const resolvesLive = (nodePath: string): boolean =>
    !!resolver.locate(nodePath) || !!resolver.livePlacementIdOf?.(nodePath);
  for (const nodePath of Object.keys(edits.overlay.nodes)) {
    if (!resolvesLive(nodePath) && pathUnderRemovedPlacement(json, nodePath, removed)) {
      delete edits.overlay.nodes[nodePath];
    }
  }
  edits.nodeTransforms = edits.nodeTransforms.filter(
    (t) => resolvesLive(t.nodePath) || !pathUnderRemovedPlacement(json, t.nodePath, removed),
  );
}

// ─── The bake ───────────────────────────────────────────────────────────

/**
 * Write every materialised category into `source` and return the new GLB.
 *
 * @param source   the original GLB bytes; never mutated
 * @param edits    `materialise(ops)` — all seven categories
 * @param resolver where each edited scene path lives (root file vs. referenced)
 */
export async function bakeIntoGlb(
  source: ArrayBuffer | Uint8Array,
  edits: MaterialisedEdits,
  resolver: BakeResolver,
  options: BakeOptions = {},
): Promise<BakeResult> {
  // plan-769: a refused part move is reported per save attempt (see category 5).
  clearNestedTransformRefusedProblems();
  clearPlacementTransformOrphanedProblems();
  const chunks = parseGlbChunks(source);

  // plan-769 Phase 7 (D23): placements of the base file the log removed. Only
  // the ones the source still holds need work (absent = already the target
  // state); edits under any of them leave with them before anything resolves.
  const removedPlacements = presentRemovedPlacementIds(chunks.json, edits.removedPlacementIds);
  dropEditsUnderRemovedPlacements(chunks.json, edits, resolver, removedPlacements);

  // Plan-921 — rv_extras overrides on LIVE planner placements: a placement
  // added THIS session has no composition frame and no base gltf node, so the
  // node-level pass would refuse the whole body over it (NodeNotFoundError —
  // exactly the bug that silently kept scene bodies out of project folders).
  // Those patches belong INSIDE the placement extras this bake writes; split
  // them off the overlay (edits is a fresh materialise() product per save).
  const placementPatches = new Map<string, Record<string, Record<string, unknown>>>();
  if (resolver.livePlacementIdOf) {
    for (const nodePath of Object.keys(edits.overlay.nodes)) {
      const location = resolver.locate(nodePath);
      if (!location) {
        const placementId = resolver.livePlacementIdOf(nodePath);
        if (!placementId) continue;
        placementPatches.set(placementId, edits.overlay.nodes[nodePath]);
        delete edits.overlay.nodes[nodePath];
        continue;
      }
      // plan-757 Phase 2 (4a): an edit INSIDE a live placement — `locate`
      // climbed to the placement root, which has no gltf node yet. It goes
      // into that placement's `AssetOverrides.byAddress`, exactly where the
      // same edit lands for a placement the file already holds
      // (`applyRoutedOverrides`), and where `applyOverrides` reads it back.
      // An owner that is itself a nested reference (`locate` non-null, not
      // root) is left to `splitOverlay`, which refuses it by name (4b).
      if (location.kind !== 'referenced' || resolver.locate(location.referenceNodePath)) continue;
      const placementId = resolver.livePlacementIdOf(location.referenceNodePath);
      if (!placementId) continue;
      const patch = placementPatches.get(placementId) ?? {};
      const overrides = (patch[RV_ASSET_OVERRIDES_KEY] ??= {}) as Record<string, unknown>;
      const byAddress = (overrides.byAddress ??= {}) as Record<string, Record<string, Record<string, unknown>>>;
      mergePatchInto(byAddress[locationAddress(location)] ??= {}, edits.overlay.nodes[nodePath]);
      placementPatches.set(placementId, patch);
      delete edits.overlay.nodes[nodePath];
    }
    // A moved node inside a live placement is NOT routed (plan-769 F14): it stays in
    // `nodeTransforms`, and category 5 refuses it by name (`nested-transform-refused`).
  }

  const counts = writeNodeLevel(chunks, edits, resolver, options);
  const fallbackName = options.fallbackPlacementName ?? 'Placement';

  // Placements the file already holds are patched here, in the JSON, so a
  // re-save of an already-baked scene neither duplicates them nor drags the
  // whole file through the exporter for a transform change.
  const reconciled = reconcilePlacements(chunks.json, edits.placements, fallbackName, placementPatches);
  // plan-769 Phase 7 (D23): moves of base-file placements — TRS only, in the JSON.
  const baseline = patchBaselinePlacementTransforms(chunks.json, edits.baselinePlacementTransforms);
  const warnings: string[] = [];
  for (const id of baseline.orphaned) {
    warnings.push(`Moved placement ${id} is not in the file any more — the move was not saved.`);
    reportPlacementTransformOrphaned({ placementId: id });
  }
  const removedPaths = edits.removedNodes ?? [];
  const needsFullPath = reconciled.remaining.length > 0 || edits.addedNodes.length > 0 || removedPaths.length > 0
    || removedPlacements.size > 0;

  if (!needsFullPath) {
    const fileLevel = writeFileLevel(chunks.json, edits, options);
    // plan-769 Phase 3b: ids, addresses and `idVersion` — the file is written ID-only.
    const identity = stampJsonIdentity(chunks.json);
    reportJsonIdentity(identity);
    const signatureDropped = dropSignature(chunks.json);
    assertNoSaveCycle(chunks.json, options.self);
    return {
      glb: rebuildGlbWithJson(chunks),
      writtenReferences: writtenReferencesOf(chunks.json),
      path: 'fast',
      binChunkUnchanged: true,
      nodes: counts.nodes,
      fields: counts.fields,
      referenceOverrides: counts.referenceOverrides,
      placements: reconciled.updated,
      placementsUpdated: reconciled.updated,
      addedNodes: 0,
      removedNodes: 0,
      placementsMoved: baseline.moved,
      placementsRemoved: 0,
      transforms: counts.transforms,
      connections: edits.connections.length,
      connectionTypes: edits.connectionTypes.length,
      cameraWritten: fileLevel.cameraWritten,
      settingsWritten: fileLevel.settingsWritten,
      classificationWritten: fileLevel.classificationWritten,
      documentInfoWritten: fileLevel.documentInfoWritten,
      signatureDropped,
      warnings,
    };
  }

  // Structural: the node array grows, so the file is rebuilt. The node-level
  // categories are already in `chunks`, so the re-parse below sees them.
  //
  // plan-769 Phase 3b: ids + addresses are stamped HERE, on the source JSON, under the
  // AUTHORED names: the re-parse below runs through the raw loader (sanitized, `_N`
  // dedup names), so the authored index of the re-exported file would no longer find
  // what the references say. The NodeIds ride through the re-parse as extras.
  const sourceIdentity = stampJsonIdentity(chunks.json);
  const intermediate = rebuildGlbWithJson(chunks);

  const [{ gltfLoader }, { objectToGlb, sceneMirroringLoad }, binaryResourcesModule, decodeIdentityModule] = await Promise.all([
    import('../../engine/rv-glb-parse'),
    import('../../import/rv-import-object'),
    import('../../engine/rv-binary-resources'),
    import('../../engine/rv-decode-identity'),
  ]);
  // plan-498: FMU packages of the planner document's OWN `Fmu` nodes are glTF
  // bufferViews nothing in the node graph references — the exporter below
  // would drop them. They are taken from the SOURCE bytes here and appended
  // again after the export by the same writer the asset editor uses.
  const sourceFmuBytes = new Map<string, Uint8Array>();
  for (const res of binaryResourcesModule.extractGlbBufferViews(
    source, binaryResourcesModule.collectFmuEmbeds(chunks.json),
  )) sourceFmuBytes.set(res.sha256, res.bytes);

  const gltf = await gltfLoader.parseAsync(
    intermediate.buffer.slice(
      intermediate.byteOffset,
      intermediate.byteOffset + intermediate.byteLength,
    ) as ArrayBuffer,
    '',
  );
  const tree = gltf.scene as unknown as Object3D;

  // `GLTFLoader` flattens `scenes[i].extras` into the scene object's userData,
  // and the exporter will write that userData onto the WRAPPER node it invents
  // for a Group. File-level data would therefore quietly sink one level and
  // never be found again — so it is taken off the tree here and put back into
  // the output's scene extras below.
  const carriedSceneExtras = { ...(tree.userData as Record<string, unknown>) };
  tree.userData = {};
  // plan-769 F2 (Inventur D4): the writer's re-parse is a decode like every other.
  // Since Phase 3b every source node arrives WITH its `NodeId` (stamped on the source
  // JSON above), so nothing is seeded here; the runtime keys are stripped before the
  // export below and the re-exported JSON gets its own pass (added nodes, idVersion).
  decodeIdentityModule.decodeIdentity(gltf as unknown as import('../../engine/rv-decode-identity').DecodedGltfLike, {
    fileKey: 'scene-save', migrate: false,
  });

  // plan-769 Phase 7 (D23): base-file placements the log removed, dropped by
  // `NodeId` — their own step, not `removedNodes`, whose eligibility rule is
  // the path network's. A reference node carries no geometry of its own (the
  // placed asset is fetched on load), so dropping it drops the placement.
  // BEFORE the records below are added: an `addPlacement` with a removed id
  // took that id out of the set in `materialise`, so nothing collides.
  let placementsRemoved = 0;
  if (removedPlacements.size > 0) {
    const targets: Object3D[] = [];
    tree.traverse((node) => {
      const id = identityIdOf(node);
      if (id && removedPlacements.has(id) && node !== tree) targets.push(node);
    });
    for (const node of targets) {
      node.parent?.remove(node);
      placementsRemoved++;
    }
  }

  for (const placement of reconciled.remaining) {
    tree.add(buildPlacementNode(placement, fallbackName, placementPatches.get(placement.id)));
  }

  // plan-628 8.7: authored removals BEFORE the added nodes (an added node may
  // reuse a removed name). The eligibility rule is the core's — a subtree it does
  // not admit stays in the file and is reported, never silently dropped.
  let removedNodes = 0;
  if (removedPaths.length > 0) {
    const { isAuthoredSubtreeRemovable } = await import('../../engine/rv-scene-loader');
    for (const removedPath of removedPaths) {
      const target = findByScenePath(tree, removedPath);
      if (!target || target === tree) continue; // already gone with an ancestor, or unknown
      if (!isAuthoredSubtreeRemovable(target)) {
        warnings.push(`Removed node ${removedPath} is not a path-network node — kept in the file.`);
        continue;
      }
      target.parent?.remove(target);
      removedNodes++;
    }
  }

  const missingParents: string[] = [];
  let addedNodes = 0;
  for (const added of edits.addedNodes) {
    const parent = findByScenePath(tree, added.spec.parentPath);
    if (!parent) { missingParents.push(added.spec.parentPath); continue; }
    parent.add(buildSpecNode(added.spec, added.idMap?.node));
    addedNodes++;
  }
  if (missingParents.length > 0) throw new NodeNotFoundError(missingParents);

  // plan-769 Phase 3b (the editor export's plan-765 F1 rule): the raw re-parse renamed
  // the file's nodes (sanitized, `_N` dedup); every node of the SOURCE gets its authored
  // name back before the export, so the file keeps the name space it was written in.
  // AFTER the added nodes were attached — their parents are found by the runtime names.
  const associations = (gltf as unknown as { parser?: { associations?: Map<unknown, { nodes?: number } | undefined> } })
    .parser?.associations;
  const sourceNodes = (chunks.json.nodes as GltfNode[] | undefined) ?? [];
  if (associations) {
    for (const [obj, ref] of associations) {
      const o = obj as Object3D;
      if (!o?.isObject3D || !ref || ref.nodes === undefined) continue;
      const raw = sourceNodes[ref.nodes]?.name;
      if (typeof raw === 'string' && raw !== o.name) o.name = raw;
    }
  }

  // Save is the exact inverse of load (plan-752 F4): `tree` IS the file's
  // scene, so it is exported as one — its name becomes the scene name and its
  // children become the file's nodes. Without this the exporter made `tree`
  // itself a node under an invented `AuxScene` and every save added a level.
  decodeIdentityModule.stripSeededNodeIds(tree);
  let exported = await objectToGlb(sceneMirroringLoad(tree));
  const fmu = binaryResourcesModule.embedFmuBufferViews(
    exported,
    (sha) => sourceFmuBytes.get(sha) ?? binaryResourcesModule.binaryResources.get(sha)?.bytes,
  );
  exported = fmu.glb;
  for (const sha of fmu.missing) {
    warnings.push(`FMU package ${sha.slice(0, 12)}… not found in the source file — saved without its bytes (bufferView -1).`);
  }

  // File-level data is written AFTER the export. With `sceneMirroringLoad` the
  // extras would now land on the scene correctly by themselves, but the carry
  // stays until the wrapper is proven gone for every input — including the one
  // case that still produces a node level, a `tree` with a real transform. The
  // merge below is write-if-absent, so it is a no-op when the export already
  // put them there.
  const outChunks = parseGlbChunks(exported);
  const outSceneExtras = ensureDefaultSceneExtras(outChunks.json);
  for (const [key, value] of Object.entries(carriedSceneExtras)) {
    if (!(key in outSceneExtras)) outSceneExtras[key] = value;
  }
  const fileLevel = writeFileLevel(outChunks.json, edits, options);
  // plan-769 Phase 3b: the nodes this bake added (placements, `addNode`) and `idVersion`;
  // every source node already carries its id and its addresses (stamped above).
  const outIdentity = stampJsonIdentity(outChunks.json);
  reportJsonIdentity({ ...outIdentity, reminted: [...sourceIdentity.reminted, ...outIdentity.reminted] });
  const signatureDropped = dropSignature(outChunks.json);
  assertNoSaveCycle(outChunks.json, options.self);

  return {
    glb: rebuildGlbWithJson(outChunks),
    writtenReferences: writtenReferencesOf(outChunks.json),
    path: 'full',
    binChunkUnchanged: false,
    nodes: counts.nodes,
    fields: counts.fields,
    referenceOverrides: counts.referenceOverrides,
    placements: edits.placements.length,
    placementsUpdated: reconciled.updated,
    addedNodes,
    removedNodes,
    placementsMoved: baseline.moved,
    placementsRemoved,
    transforms: counts.transforms,
    connections: edits.connections.length,
    connectionTypes: edits.connectionTypes.length,
    cameraWritten: fileLevel.cameraWritten,
    settingsWritten: fileLevel.settingsWritten,
    classificationWritten: fileLevel.classificationWritten,
    documentInfoWritten: fileLevel.documentInfoWritten,
    signatureDropped,
    warnings,
  };
}

// ─── Production wiring ──────────────────────────────────────────────────

/** The nearest placement root strictly ABOVE `node` — a planner record's root or a nested one. */
function outermostOwnerAbove(node: Object3D): Object3D | null {
  let owner: Object3D | null = null;
  for (let cur: Object3D | null = node.parent; cur; cur = cur.parent) {
    const ref = getAssetReference(cur);
    if (isPlacementRoot(cur) || (ref && ref.embedded !== true)) owner = cur;
  }
  return owner;
}

/**
 * The resolver the running viewer uses: `NodeRegistry` for the index, the
 * composition's frames for "which reference node owns this occurrence".
 *
 * A node whose `sourceKey` is not the root file is looked up among the frames by
 * subtree membership — the frame knows both the reference node and the grafted
 * clone, which is the only place that mapping exists at all.
 */
export function makeRegistryBakeResolver(
  registry: NodeRegistry,
  frames: readonly ComposedFrame[] = [],
): BakeResolver {
  // node → frame, built once: a traversal per lookup would be quadratic on a
  // scene with many references, and a bake touches every edited path.
  const frameOf = new Map<Object3D, ComposedFrame>();
  for (const frame of frames) {
    frame.subtreeRoot.traverse((node) => {
      if (!frameOf.has(node)) frameOf.set(node, frame);
    });
  }

  return {
    locate(nodePath: string): BakeLocation | null {
      const location = registry.getGltfLocation(nodePath);
      if (location && location.sourceKey === ROOT_SOURCE_KEY) {
        return { kind: 'root', index: location.index };
      }

      const node = registry.getNode(nodePath);
      if (!node) return null;

      // plan-769 Phase 4b (F13): a node of referenced content — a composed frame or a
      // placement instance, at ANY depth — belongs on the OUTERMOST reference node
      // above it, the one the file being written holds (or a live record the
      // pre-pass routes), addressed through the nested references in between
      // (`<b>#<id>`). The plan-757 refusal of depth ≥ 2 for component values is gone;
      // a MOVE in there stays refused (category 5, `nested-transform-refused`).
      const owner = outermostOwnerAbove(node);
      if (!owner) return location ? { kind: 'root', index: location.index } : null;
      const nodeId = identityIdOf(node);
      if (!nodeId) return null;
      const address = overrideAddressInReference(owner, node, identityIdOf);
      if (!address) return null;
      const referenceNodePath = registry.getPathForNode(owner);
      if (!referenceNodePath) return null;
      const ownerFrame = frames.find((f) => f.referenceNode === owner);
      return {
        kind: 'referenced',
        referenceNodePath,
        nodeId,
        sourceKey: ownerFrame?.sourceKey ?? getAssetReference(owner)?.assetId ?? frameOf.get(node)?.sourceKey ?? '',
        address,
      };
    },

    overridePathMigrationAt(index: number): Readonly<Record<string, string>> | null {
      const node = registry.getNodeAtGltfIndex(index);
      return node ? overridePathMigrationOf(node) : null;
    },

    livePlacementIdOf(nodePath: string): string | null {
      const node = registry.getNode(nodePath);
      const id = node?.userData?._layoutId;
      return typeof id === 'string' && id ? id : null;
    },
  };
}
