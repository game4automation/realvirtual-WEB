// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-reference — the three rv-ODT components that make a GLB able to
 * reference other GLBs: `AssetReference`, `AssetOverrides`, `SceneCamera`.
 *
 * All three are ordinary `extras.realvirtual` components (rv-ODT §7d.8–7d.10) —
 * no glTF extension handler is involved, which is exactly what rv-ODT prescribes
 * and what keeps a referencing file readable by every standard glTF loader (a
 * reference node simply shows up empty there).
 *
 * ## The division of labour
 *
 * A **reference node** carries `AssetReference` and says *which* asset belongs
 * under it. It carries `AssetOverrides` and says *what this file changes* in
 * that asset. The referenced file itself is never touched — that was the user's
 * decision, and it is what forces the addressing to be by `NodeId` (rv-node-id):
 * an id we cannot write back into a file has to be derivable from it.
 *
 * ## Why the overrides live on the reference node
 *
 * Because they do, their `byNodeId` keys are unambiguous by construction: they
 * only ever address inside ONE referenced subtree, where a `NodeId` is unique.
 * The occurrence chain that tells ten copies of the same asset apart is built
 * during composition and never written into a file — no file has to know where
 * it is installed.
 *
 * ## Strength ordering
 *
 * When several layers touch the same field, the outer file wins
 * ({@link OVERRIDE_STRENGTH}). Applying them weakest-first — which is all
 * {@link applyOverrideLayers} does — produces exactly that, because a later
 * write replaces an earlier one.
 */

import type { Object3D } from 'three';
import type { ModelCameraStart } from '../hmi/camera-startpos-types';
import { getNodeId } from './rv-node-id';

// ─── Component keys ──────────────────────────────────────────────────────

export const RV_ASSET_REFERENCE_KEY = 'AssetReference';
export const RV_ASSET_OVERRIDES_KEY = 'AssetOverrides';
export const RV_SCENE_CAMERA_KEY = 'SceneCamera';
export const RV_PLACEMENT_META_KEY = 'PlacementMeta';
export const RV_SCENE_SETTINGS_KEY = 'SceneSettings';

/** Guard against a malformed or hostile file turning composition into a hang. */
export const MAX_REFERENCE_DEPTH = 16;

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * On a reference node: the subtree lives in another file.
 *
 * `assetId` resolves first, `path` is the fallback and is relative TO THE FILE
 * THE REFERENCE IS WRITTEN IN — never to the root of the composition. `sha256`
 * detects that the asset changed and is deliberately NOT a resolution key: the
 * user decided that library corrections must reach every referencing file, and a
 * hash key would pin each file to the bytes it last saw.
 */
export interface AssetReference {
  assetId: string;
  providerId?: string;
  sourceId?: string;
  path?: string;
  sha256?: string;
  /** Set by the flat export: the subtree is inlined, do not resolve again. */
  embedded?: boolean;
  /**
   * Local-space extents the referenced subtree had when the reference was
   * authored (plan-703 §2.8). **Additive and optional in every direction.**
   *
   * It exists for exactly one reader: the placeholder drawn when the reference
   * cannot be resolved. A wireframe box the size of the missing machine says
   * something a fixed marker cannot — that the hole in the layout is two metres
   * wide — and there is no other way to know that, because the bytes that would
   * answer are the bytes we failed to load.
   *
   * Deliberately NOT a resolution input and never compared: a stale bounds is a
   * slightly wrong placeholder, which is the cheapest possible failure. Absent
   * bounds is the normal case for every file written before this field existed,
   * and it falls back to the fixed marker.
   */
  bounds?: RvReferenceBounds;
}

/** Axis-aligned extents in the reference node's own local space, in metres. */
export interface RvReferenceBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Read a `[x,y,z]` triple, or null when the value is not one. */
function readTriple(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const out = v.map(n => (typeof n === 'number' && Number.isFinite(n) ? n : NaN));
  if (out.some(Number.isNaN)) return null;
  return [out[0], out[1], out[2]];
}

/**
 * Parse an `AssetReference.bounds` value, or null.
 *
 * Rejects a box that is not ordered (`min <= max` on every axis) rather than
 * silently normalising it: an inverted box in a file means the writer was
 * confused, and a placeholder drawn from a guess about what it meant would hide
 * that. A rejected bounds falls back to the fixed marker, which is honest.
 */
export function parseReferenceBounds(raw: unknown): RvReferenceBounds | null {
  if (!isPlainObject(raw)) return null;
  const min = readTriple(raw.min);
  const max = readTriple(raw.max);
  if (!min || !max) return null;
  for (let i = 0; i < 3; i++) if (min[i] > max[i]) return null;
  return { min, max };
}

/**
 * RFC 7396 JSON Merge Patch over a node's `extras.realvirtual`:
 * componentType → fieldName → value, where `null` DELETES the field.
 * Identical semantics to `RVExtrasOverlay.nodes[path]`.
 */
export type ComponentPatch = Record<string, Record<string, unknown>>;

/**
 * A local transform this file gives one node of the referenced subtree.
 *
 * glTF-native local TRS of the TARGET node, in the referenced file's own frame
 * — exactly the numbers the editor produces when the user drags a part, so
 * applying it is a `set`, never a conversion. Every field is optional and
 * independent: an override that only moves a part leaves its rotation and
 * scale as the asset authored them.
 */
export interface TrsOverride {
  position?: [number, number, number];
  quaternion?: [number, number, number, number];
  scale?: [number, number, number];
}

/**
 * On the same reference node: what this file changes in the referenced subtree.
 *
 * `trsByNodeId` is a SIBLING of `byNodeId`, not a key inside it, and that is a
 * correctness point rather than a layout preference: `byNodeId[nodeId]` IS the
 * flat `ComponentPatch` map, so a `trs` key living in there would be handed to
 * {@link applyComponentPatch} as a component type and written into the target's
 * `extras.realvirtual.trs` — a fake component in every file we save. A sibling
 * field is invisible to the patch path by construction, which is what makes the
 * addition genuinely additive (proven by `rv-asset-override-compat.test.ts`,
 * not asserted here).
 */
export interface AssetOverrides {
  /** NodeId within the referenced file → patch. The primary addressing. */
  byNodeId: Record<string, ComponentPatch>;
  /** Fallback: path RELATIVE TO THE REFERENCE NODE → patch. */
  byPath?: Record<string, ComponentPatch>;
  /**
   * NodeId within the referenced file → local transform (plan-444 F3/F4).
   *
   * The answer to "I moved a part after importing CAD and could not save".
   * A transform is glTF-native data on `nodes[i]` rather than an
   * `extras.realvirtual` component, so it could not ride in a `ComponentPatch`
   * and used to be refused outright (`UnwritableTransformError`). It is stored
   * on the reference node, so the referenced asset still stays untouched and
   * ten instances of the same assembly still move independently.
   *
   * Absent in every file written before this existed — which is the default,
   * and means "no override" (F6).
   */
  trsByNodeId?: Record<string, TrsOverride>;
}

/**
 * A scale component this close to zero collapses the node's matrix.
 *
 * A zero scale makes `matrixWorld` singular: raycasting inverts it, and the
 * NaNs that come back poison every picking test for the rest of the session
 * with no error anywhere near the cause. A degenerate scale in a file is a
 * writer bug, so the scale is REJECTED (the asset's own stays) rather than
 * clamped to a number nobody asked for — see {@link parseTrsOverride}.
 */
const MIN_ABS_SCALE = 1e-6;

function readQuad(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const out = v.map(n => (typeof n === 'number' && Number.isFinite(n) ? n : NaN));
  if (out.some(Number.isNaN)) return null;
  return [out[0], out[1], out[2], out[3]];
}

/**
 * Parse one `trsByNodeId` entry, or null when nothing usable is in it.
 *
 * Per-field defence, not all-or-nothing: a malformed rotation must not throw
 * away a perfectly good position, because the two were written by the same
 * save and the position is what the user actually moved. A quaternion of
 * length ~0 is rejected — normalising it would invent a rotation, and applying
 * it verbatim produces a NaN matrix.
 */
export function parseTrsOverride(raw: unknown): TrsOverride | null {
  if (!isPlainObject(raw)) return null;
  const out: TrsOverride = {};

  const position = readTriple(raw.position);
  if (position) out.position = position;

  const quaternion = readQuad(raw.quaternion);
  if (quaternion) {
    const lengthSq = quaternion[0] ** 2 + quaternion[1] ** 2 + quaternion[2] ** 2 + quaternion[3] ** 2;
    if (lengthSq > 1e-12) out.quaternion = quaternion;
  }

  const scale = readTriple(raw.scale);
  if (scale && scale.every(s => Math.abs(s) >= MIN_ABS_SCALE)) out.scale = scale;

  return out.position || out.quaternion || out.scale ? out : null;
}

/** Parse a whole `trsByNodeId` block, dropping entries that carry nothing. */
function parseTrsByNodeId(raw: unknown): Record<string, TrsOverride> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, TrsOverride> = {};
  for (const [nodeId, value] of Object.entries(raw)) {
    const trs = parseTrsOverride(value);
    if (trs) out[nodeId] = trs;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Apply one `TrsOverride` to a node's LOCAL transform.
 *
 * `updateMatrix` right here rather than leaving it to the render loop: the
 * composition hands the tree to bounds computation, auto-align and the node
 * registry before a frame is ever drawn, and each of those reads `matrix`.
 *
 * @returns true when anything was set.
 */
export function applyTrsOverride(node: Object3D, trs: TrsOverride): boolean {
  let changed = false;
  if (trs.position) { node.position.set(trs.position[0], trs.position[1], trs.position[2]); changed = true; }
  if (trs.quaternion) {
    node.quaternion.set(trs.quaternion[0], trs.quaternion[1], trs.quaternion[2], trs.quaternion[3]);
    changed = true;
  }
  if (trs.scale) { node.scale.set(trs.scale[0], trs.scale[1], trs.scale[2]); changed = true; }
  if (changed) node.updateMatrix();
  return changed;
}

/**
 * On the scene root: the authored camera start preset.
 *
 * Field-identical to {@link ModelCameraStart} on purpose. The first draft of
 * this plan invented a different shape and would have dropped `duration`,
 * `savedAt` and `source` on the way into the file; the user decided all three
 * are model-relevant, so the migration is a straight copy in both directions.
 */
export interface SceneCamera {
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
  duration?: number;
  savedAt?: number;
  source?: 'user' | 'author';
}

// ─── extras access ───────────────────────────────────────────────────────

function extrasOf(node: Object3D): Record<string, unknown> | undefined {
  return (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
}

function ensureExtras(node: Object3D): Record<string, unknown> {
  const ud = node.userData as Record<string, unknown>;
  let rv = ud['realvirtual'] as Record<string, unknown> | undefined;
  if (!rv) {
    rv = {};
    ud['realvirtual'] = rv;
  }
  return rv;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── AssetReference ──────────────────────────────────────────────────────

/**
 * The `AssetReference` on a node, or null.
 *
 * A reference without an `assetId` AND without a `path` can never resolve; it is
 * rejected here rather than half-accepted, so composition does not have to
 * decide what an empty reference means.
 */
export function getAssetReference(node: Object3D): AssetReference | null {
  const raw = extrasOf(node)?.[RV_ASSET_REFERENCE_KEY];
  if (!isPlainObject(raw)) return null;
  const assetId = typeof raw.assetId === 'string' ? raw.assetId : '';
  const path = typeof raw.path === 'string' ? raw.path : undefined;
  if (!assetId && !path) return null;

  const ref: AssetReference = { assetId };
  if (typeof raw.providerId === 'string' && raw.providerId) ref.providerId = raw.providerId;
  if (typeof raw.sourceId === 'string' && raw.sourceId) ref.sourceId = raw.sourceId;
  if (path) ref.path = path;
  if (typeof raw.sha256 === 'string' && raw.sha256) ref.sha256 = raw.sha256;
  if (raw.embedded === true) ref.embedded = true;
  const bounds = parseReferenceBounds(raw.bounds);
  if (bounds) ref.bounds = bounds;
  return ref;
}

/** Write an `AssetReference` onto a node, dropping empty optional fields. */
export function setAssetReference(node: Object3D, ref: AssetReference): void {
  const out: Record<string, unknown> = { assetId: ref.assetId };
  if (ref.providerId) out.providerId = ref.providerId;
  if (ref.sourceId) out.sourceId = ref.sourceId;
  if (ref.path) out.path = ref.path;
  if (ref.sha256) out.sha256 = ref.sha256;
  if (ref.embedded) out.embedded = true;
  if (ref.bounds) out.bounds = { min: [...ref.bounds.min], max: [...ref.bounds.max] };
  ensureExtras(node)[RV_ASSET_REFERENCE_KEY] = out;
}

/**
 * Is this a reference node that composition still has to resolve?
 *
 * An `embedded` reference is NOT: the flat export already inlined its subtree
 * and left the reference behind purely as a provenance note. Resolving it again
 * would graft a second copy under a node that already has one.
 */
export function isUnresolvedReferenceNode(node: Object3D): boolean {
  const ref = getAssetReference(node);
  return ref !== null && ref.embedded !== true;
}

/** Every reference node in a subtree, in traversal order. */
export function collectReferenceNodes(root: Object3D): Array<{ node: Object3D; ref: AssetReference }> {
  const found: Array<{ node: Object3D; ref: AssetReference }> = [];
  root.traverse((node) => {
    const ref = getAssetReference(node);
    if (ref && ref.embedded !== true) found.push({ node, ref });
  });
  return found;
}

// ─── AssetOverrides ──────────────────────────────────────────────────────

/**
 * The `AssetOverrides` on a node, or null when it carries none.
 *
 * "Carries none" counts all THREE blocks: a node whose only override is a
 * transform still has overrides. Answering null there is what would make the
 * compose hook skip the block entirely and a moved part snap back on reload.
 */
export function getAssetOverrides(node: Object3D): AssetOverrides | null {
  const raw = extrasOf(node)?.[RV_ASSET_OVERRIDES_KEY];
  if (!isPlainObject(raw)) return null;
  const byNodeId = isPlainObject(raw.byNodeId) ? (raw.byNodeId as Record<string, ComponentPatch>) : {};
  const byPath = isPlainObject(raw.byPath) ? (raw.byPath as Record<string, ComponentPatch>) : undefined;
  const trsByNodeId = parseTrsByNodeId(raw.trsByNodeId);
  if (Object.keys(byNodeId).length === 0
    && (!byPath || Object.keys(byPath).length === 0)
    && !trsByNodeId) return null;

  const out: AssetOverrides = { byNodeId };
  if (byPath) out.byPath = byPath;
  if (trsByNodeId) out.trsByNodeId = trsByNodeId;
  return out;
}

/**
 * Write `AssetOverrides` onto a node; an empty override set removes the key.
 *
 * Every read-modify-write in the codebase runs through this pair, so a block
 * missing HERE is a block silently dropped on the next unrelated field edit
 * ({@link writeOverride} in rv-reference-guard is exactly that pattern) — which
 * is why `trsByNodeId` is carried through both halves and not only the reader.
 */
export function setAssetOverrides(node: Object3D, overrides: AssetOverrides | null): void {
  const rv = ensureExtras(node);
  const empty = !overrides
    || (Object.keys(overrides.byNodeId ?? {}).length === 0
      && Object.keys(overrides.byPath ?? {}).length === 0
      && Object.keys(overrides.trsByNodeId ?? {}).length === 0);
  if (empty) {
    delete rv[RV_ASSET_OVERRIDES_KEY];
    return;
  }
  const out: Record<string, unknown> = { byNodeId: overrides!.byNodeId ?? {} };
  if (overrides!.byPath && Object.keys(overrides!.byPath).length > 0) out.byPath = overrides!.byPath;
  if (overrides!.trsByNodeId && Object.keys(overrides!.trsByNodeId).length > 0) {
    out.trsByNodeId = overrides!.trsByNodeId;
  }
  rv[RV_ASSET_OVERRIDES_KEY] = out;
}

// ─── Patch application (RFC 7396) ────────────────────────────────────────

/**
 * Apply one merge patch to a node's `extras.realvirtual`.
 *
 * RFC 7396 semantics, identical to `applyOverlayToNode`: a value replaces, a
 * `null` deletes. This is the single implementation both the path-keyed overlay
 * and the NodeId-keyed asset overrides run through — two copies of "what does
 * null mean here" is exactly how the two paths would drift apart.
 *
 * @returns true when anything actually changed.
 */
export function applyComponentPatch(node: Object3D, patch: ComponentPatch): boolean {
  let changed = false;
  const rv = ensureExtras(node) as Record<string, Record<string, unknown>>;

  for (const [componentType, fields] of Object.entries(patch)) {
    if (!isPlainObject(fields)) continue;
    if (!rv[componentType]) rv[componentType] = {};
    const target = rv[componentType];

    for (const [fieldName, value] of Object.entries(fields)) {
      if (value === null) {
        if (fieldName in target) {
          delete target[fieldName];
          changed = true;
        }
      } else if (target[fieldName] !== value) {
        target[fieldName] = value;
        changed = true;
      }
    }
  }
  return changed;
}

// ─── Strength ordering ───────────────────────────────────────────────────

/**
 * The strength ordering of composition (rv-ODT §5b), weakest first.
 *
 * Without a fixed order, nested references make it unpredictable whose value
 * wins — the lesson USD paid for with LIVERPS. The numbers are the sort key;
 * only their ORDER is meaningful.
 */
export const OVERRIDE_STRENGTH = {
  /** The value as it stands in the referenced file. */
  REFERENCED_FILE: 0,
  /** `AssetOverrides` of an inner referencing file. */
  INNER_REFERENCE: 1,
  /** `AssetOverrides` of an outer referencing file. */
  OUTER_REFERENCE: 2,
  /** The running session's own edits — always strongest. */
  SESSION: 3,
} as const;

export type OverrideStrength = typeof OVERRIDE_STRENGTH[keyof typeof OVERRIDE_STRENGTH];

/** One layer of values competing for the same fields. */
export interface OverrideLayer {
  strength: OverrideStrength;
  /**
   * Nesting depth of the referencing file, used to order several
   * `INNER_REFERENCE` layers among themselves: the OUTER one (smaller depth)
   * is the stronger, per the "the outer file always wins" rule.
   */
  depth?: number;
  patch: ComponentPatch;
}

/**
 * Apply competing layers to one node in strength order.
 *
 * Weakest first, so a stronger layer simply overwrites what a weaker one wrote —
 * no per-field arbitration needed. Layers of equal strength keep their relative
 * order (`Array.prototype.sort` is stable), which is what makes the caller's
 * ordering meaningful rather than accidental.
 */
export function applyOverrideLayers(node: Object3D, layers: OverrideLayer[]): boolean {
  const ordered = [...layers].sort((a, b) => {
    if (a.strength !== b.strength) return a.strength - b.strength;
    // Same strength class: the DEEPER file is weaker, so it goes first.
    return (b.depth ?? 0) - (a.depth ?? 0);
  });
  let changed = false;
  for (const layer of ordered) {
    if (applyComponentPatch(node, layer.patch)) changed = true;
  }
  return changed;
}

// ─── Override application with orphan reporting ──────────────────────────

/** An override whose target no longer exists. Reported, never silently dropped. */
export interface OrphanedOverride {
  /**
   * How it addressed its target.
   *
   * `'trs'` is a NodeId-addressed TRANSFORM override (plan-444) and is kept
   * apart from `'nodeId'` on purpose: the two orphan for the same reason but
   * read completely differently to a user. "Drive.TargetSpeed no longer has a
   * target" is a setting that will not apply; "the part you moved is gone" is a
   * hole in the layout. One shared label would have described neither.
   */
  addressing: 'nodeId' | 'path' | 'trs';
  /** The NodeId or relative path that did not resolve. */
  key: string;
  /** Occurrence address of the reference node the override sits on. */
  occurrence: string;
  /** assetId of the reference, for the user-facing message. */
  assetId: string;
  /** Component types the override would have touched. */
  componentTypes: string[];
}

export interface ApplyOverridesResult {
  /** How many target nodes were actually changed. */
  applied: number;
  /** Overrides that found no target. Never empty-and-ignored — F9. */
  orphaned: OrphanedOverride[];
  /**
   * How many of `applied` were TRANSFORM overrides (plan-444).
   *
   * Reported separately because the caller has to do something extra for
   * exactly these: a component patch changes data, a transform changes the
   * matrix, and the grafted subtree's `matrixWorld` has to be refreshed before
   * anything measures it. Zero means the caller can skip that walk entirely.
   */
  transformsApplied: number;
}

/** How a target is looked up inside one referenced subtree. */
export interface OverrideResolvers {
  byNodeId: (nodeId: string) => Object3D | null;
  byPath: (relativePath: string) => Object3D | null;
}

/**
 * Resolvers that search a single parsed subtree, with no registry involved.
 *
 * Enough for composition, which applies a subtree's overrides right after
 * parsing it and before anything global exists. Paths are relative to
 * `subtreeRoot`, which is the reference node's content — the same frame the
 * `byPath` keys were written in.
 */
export function makeSubtreeResolvers(subtreeRoot: Object3D): OverrideResolvers {
  const byId = new Map<string, Object3D>();
  const byPath = new Map<string, Object3D>();

  const walk = (node: Object3D, prefix: string): void => {
    if (prefix) byPath.set(prefix, node);
    const id = getNodeId(node);
    // First registration wins, matching NodeRegistry: a duplicated id in a
    // malformed file must not make the resolution order depend on traversal.
    if (id && !byId.has(id)) byId.set(id, node);
    for (const child of node.children) {
      walk(child, prefix ? `${prefix}/${child.name}` : child.name);
    }
  };
  walk(subtreeRoot, '');

  return {
    byNodeId: (id) => byId.get(id) ?? null,
    byPath: (p) => byPath.get(p) ?? null,
  };
}

/**
 * Apply a reference node's `AssetOverrides` to the subtree grafted under it.
 *
 * Resolution order is the plan's: `NodeId` first, then the relative-path
 * fallback, then orphan. `byPath` is tried for a `byNodeId` key too — a file
 * written before ids existed may address the same node either way, and falling
 * through costs one map lookup.
 *
 * Orphans are RETURNED, not logged away: the user decided a verwaister Override
 * must be visible, and swallowing it here is what would make that impossible
 * further up.
 */
export function applyAssetOverrides(
  overrides: AssetOverrides,
  resolvers: OverrideResolvers,
  context: { occurrence: string; assetId: string },
): ApplyOverridesResult {
  const orphaned: OrphanedOverride[] = [];
  let applied = 0;
  let transformsApplied = 0;

  for (const [nodeId, patch] of Object.entries(overrides.byNodeId ?? {})) {
    const target = resolvers.byNodeId(nodeId);
    if (!target) {
      orphaned.push({
        addressing: 'nodeId',
        key: nodeId,
        occurrence: context.occurrence,
        assetId: context.assetId,
        componentTypes: Object.keys(patch ?? {}),
      });
      continue;
    }
    if (applyComponentPatch(target, patch)) applied++;
  }

  for (const [relPath, patch] of Object.entries(overrides.byPath ?? {})) {
    const target = resolvers.byPath(relPath);
    if (!target) {
      orphaned.push({
        addressing: 'path',
        key: relPath,
        occurrence: context.occurrence,
        assetId: context.assetId,
        componentTypes: Object.keys(patch ?? {}),
      });
      continue;
    }
    if (applyComponentPatch(target, patch)) applied++;
  }

  // Transforms LAST, and NodeId-addressed only. Last because a component patch
  // must never be able to overwrite the position the user dragged a part to;
  // NodeId-only because `byPath` exists as a bridge for files written before
  // ids existed, and no such file can carry a transform override.
  for (const [nodeId, trs] of Object.entries(overrides.trsByNodeId ?? {})) {
    const target = resolvers.byNodeId(nodeId);
    if (!target) {
      orphaned.push({
        addressing: 'trs',
        key: nodeId,
        occurrence: context.occurrence,
        assetId: context.assetId,
        componentTypes: [],
      });
      continue;
    }
    if (applyTrsOverride(target, trs)) { applied++; transformsApplied++; }
  }

  return { applied, orphaned, transformsApplied };
}

/** One line per orphan, for the non-blocking status row (§3.2 of the plan). */
export function describeOrphanedOverride(o: OrphanedOverride): string {
  const where = o.occurrence ? ` in occurrence ${o.occurrence}` : '';
  if (o.addressing === 'trs') {
    // Said as a fact about the layout, not about the storage: the user moved a
    // part, the part is no longer in the asset, and the move therefore has
    // nowhere to land. Naming the asset is what makes it actionable.
    return `moved part → node "${o.key}" no longer exists in asset "${o.assetId}"${where}`
      + ' — its saved position was dropped';
  }
  const what = o.componentTypes.length > 0 ? o.componentTypes.join(', ') : 'override';
  return `${what} → ${o.addressing === 'nodeId' ? 'node' : 'path'} "${o.key}" no longer exists `
    + `in asset "${o.assetId}"${where}`;
}

// ─── SceneCamera ─────────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The `SceneCamera` on a node, or null.
 *
 * Rejects a preset with a non-finite coordinate rather than handing the viewer a
 * NaN camera position — the same defence `isValidPreset` applies to the
 * localStorage side, kept identical so a preset does not survive one path and
 * die on the other.
 */
export function getSceneCamera(node: Object3D): SceneCamera | null {
  const raw = extrasOf(node)?.[RV_SCENE_CAMERA_KEY];
  if (!isPlainObject(raw)) return null;
  const { px, py, pz, tx, ty, tz } = raw;
  if (![px, py, pz, tx, ty, tz].every(isFiniteNumber)) return null;

  const cam: SceneCamera = {
    px: px as number, py: py as number, pz: pz as number,
    tx: tx as number, ty: ty as number, tz: tz as number,
  };
  if (isFiniteNumber(raw.duration) && raw.duration > 0) cam.duration = raw.duration;
  if (isFiniteNumber(raw.savedAt)) cam.savedAt = raw.savedAt;
  if (raw.source === 'user' || raw.source === 'author') cam.source = raw.source;
  return cam;
}

/** Write a `SceneCamera` onto the scene root; `null` removes it. */
export function setSceneCamera(node: Object3D, camera: SceneCamera | null): void {
  const rv = ensureExtras(node);
  if (!camera) {
    delete rv[RV_SCENE_CAMERA_KEY];
    return;
  }
  const out: Record<string, unknown> = {
    px: camera.px, py: camera.py, pz: camera.pz,
    tx: camera.tx, ty: camera.ty, tz: camera.tz,
  };
  if (camera.duration !== undefined) out.duration = camera.duration;
  if (camera.savedAt !== undefined) out.savedAt = camera.savedAt;
  if (camera.source !== undefined) out.source = camera.source;
  rv[RV_SCENE_CAMERA_KEY] = out;
}

/**
 * `ModelCameraStart` → `SceneCamera`, the migration out of
 * `rv-camera-start:<modelKey>`.
 *
 * A field-for-field copy, which is the point: the user decided `duration`,
 * `savedAt` and `source` are model-relevant, so the migration must not quietly
 * normalise any of them away.
 */
export function sceneCameraFromCameraStart(preset: ModelCameraStart): SceneCamera {
  const cam: SceneCamera = {
    px: preset.px, py: preset.py, pz: preset.pz,
    tx: preset.tx, ty: preset.ty, tz: preset.tz,
  };
  if (preset.duration !== undefined) cam.duration = preset.duration;
  if (preset.savedAt !== undefined) cam.savedAt = preset.savedAt;
  if (preset.source !== undefined) cam.source = preset.source;
  return cam;
}

/** `SceneCamera` → `ModelCameraStart`, the way back out of the file. */
export function cameraStartFromSceneCamera(camera: SceneCamera): ModelCameraStart {
  const preset: ModelCameraStart = {
    px: camera.px, py: camera.py, pz: camera.pz,
    tx: camera.tx, ty: camera.ty, tz: camera.tz,
  };
  if (camera.duration !== undefined) preset.duration = camera.duration;
  if (camera.savedAt !== undefined) preset.savedAt = camera.savedAt;
  if (camera.source !== undefined) preset.source = camera.source;
  return preset;
}

// ─── PlacementMeta ───────────────────────────────────────────────────────
//
// The precondition phase 6 could not be started without.
//
// A planner placement becomes an `AssetReference` node (rv-ODT §7d.8) — but an
// `AssetReference` says one thing only: *which GLB belongs under this node*.
// Three pieces of a placement are not that, and until they had a home in the
// file they would have been silently dropped the moment the op log stopped
// being persisted:
//
//  - a **Gaussian splat** placement has no GLB at all, so it carries no
//    `AssetReference` whatsoever and its catalog identity has nowhere else to
//    live;
//  - **signal mappings** bind a placement to live CONNECT/model signals;
//  - **`visible: false`** survives no glTF round-trip on its own — glTF has no
//    visibility flag and `GLTFExporter` writes none.
//
// `PlacementMeta` is therefore also the *marker*: a node carrying it was made
// by the layout planner, which is how a reader tells a placement apart from a
// reference node an author wrote by hand. It is written on every placement,
// even an otherwise empty one, precisely so that test stays cheap and total.

/**
 * One live-signal binding of a placement.
 *
 * Deliberately typed as an open record rather than importing the planner's
 * `SignalMapping`: rv-ODT stores these verbatim and the planner owns their
 * shape. Narrowing them here would mean a planner field added tomorrow is
 * quietly dropped on the way into the file — the exact failure this component
 * exists to prevent. The fields the planner uses today are documented in
 * rv-odt.json.
 */
export type PlacementSignalMapping = Record<string, unknown>;

/** On a planner placement node: what an `AssetReference` cannot express. */
export interface PlacementMeta {
  /**
   * Catalog entry id, written ONLY when the node carries no `AssetReference`
   * to hold it (the splat case). Duplicating `AssetReference.assetId` would
   * create two sources of truth for the same fact.
   */
  catalogId?: string;
  /** Set when the placement's geometry is a Gaussian splat, not a GLB. */
  splatUrl?: string;
  /** False when the user hid the placement. Absent means visible. */
  visible?: boolean;
  /** Live-signal bindings, stored verbatim. */
  signalMappings?: PlacementSignalMapping[];
}

/** The `PlacementMeta` on a node, or null when the node is not a placement. */
export function getPlacementMeta(node: Object3D): PlacementMeta | null {
  const raw = extrasOf(node)?.[RV_PLACEMENT_META_KEY];
  if (!isPlainObject(raw)) return null;

  const meta: PlacementMeta = {};
  if (typeof raw.catalogId === 'string' && raw.catalogId) meta.catalogId = raw.catalogId;
  if (typeof raw.splatUrl === 'string' && raw.splatUrl) meta.splatUrl = raw.splatUrl;
  if (raw.visible === false) meta.visible = false;
  if (Array.isArray(raw.signalMappings)) {
    const mappings = raw.signalMappings.filter(isPlainObject);
    if (mappings.length > 0) meta.signalMappings = mappings;
  }
  return meta;
}

/** Write a `PlacementMeta`; `null` removes it. An EMPTY meta is still written. */
export function setPlacementMeta(node: Object3D, meta: PlacementMeta | null): void {
  const rv = ensureExtras(node);
  if (!meta) {
    delete rv[RV_PLACEMENT_META_KEY];
    return;
  }
  const out: Record<string, unknown> = {};
  if (meta.catalogId) out.catalogId = meta.catalogId;
  if (meta.splatUrl) out.splatUrl = meta.splatUrl;
  if (meta.visible === false) out.visible = false;
  if (meta.signalMappings && meta.signalMappings.length > 0) out.signalMappings = meta.signalMappings;
  rv[RV_PLACEMENT_META_KEY] = out;
}

/** True when this node was written as a layout placement. */
export function isPlacementNode(node: Object3D): boolean {
  return isPlainObject(extrasOf(node)?.[RV_PLACEMENT_META_KEY]);
}

// ─── SceneSettings ───────────────────────────────────────────────────────

/**
 * On the scene root: the workspace settings of a scene.
 *
 * The second hole the same precondition uncovered. `materialise()` returns
 * seven categories and `SceneEditsSettings` is none of them — it hangs off
 * `RvScene.edits.settings`, beside the op array rather than inside it. So a
 * scene written as a GLB would have kept its every edit and lost the library
 * catalogues it was built from and the grid it was laid out on.
 */
export interface SceneSettings {
  /** Library catalogue URLs the scene draws its placements from. */
  catalogUrls?: string[];
  /** Layout grid / translation snap step, in millimetres. */
  gridSizeMm?: number;
}

/** The `SceneSettings` on the scene root, or null. */
export function getSceneSettings(node: Object3D): SceneSettings | null {
  const raw = extrasOf(node)?.[RV_SCENE_SETTINGS_KEY];
  if (!isPlainObject(raw)) return null;

  const settings: SceneSettings = {};
  if (Array.isArray(raw.catalogUrls)) {
    settings.catalogUrls = raw.catalogUrls.filter((u): u is string => typeof u === 'string');
  }
  if (isFiniteNumber(raw.gridSizeMm) && raw.gridSizeMm > 0) settings.gridSizeMm = raw.gridSizeMm;
  return settings;
}

/** Write `SceneSettings` onto the scene root; `null` removes it. */
export function setSceneSettings(node: Object3D, settings: SceneSettings | null): void {
  const rv = ensureExtras(node);
  if (!settings) {
    delete rv[RV_SCENE_SETTINGS_KEY];
    return;
  }
  const out: Record<string, unknown> = {};
  if (settings.catalogUrls) out.catalogUrls = [...settings.catalogUrls];
  if (settings.gridSizeMm !== undefined) out.gridSizeMm = settings.gridSizeMm;
  rv[RV_SCENE_SETTINGS_KEY] = out;
}
