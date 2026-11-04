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
import { childOccurrence, getNodeId } from './rv-node-id';
import { isUnsafeObjectKey, ownExtrasOf, ownValue } from './rv-safe-keys';

/** Occurrence segment of a reference node without identity — no override key can contain NUL. */
const UNADDRESSABLE_OCCURRENCE = '\u0000unaddressable';

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
 * On the same reference node: what this file changes in the referenced subtree
 * (plan-769 Phase 4, F13/F14). Component VALUES only — a structural edit or a part
 * move has no vocabulary here (D11: `trsByNodeId` was removed; a part move inside a
 * placement is refused with `nested-transform-refused`).
 *
 * Keys are ADDRESSES relative to the referenced asset (§ 2.3): `#<id>` = a node of
 * that asset, `<b>#<id>` = a node inside its nested reference `b`. The patch is an
 * RFC 7396 merge patch over the target's `extras.realvirtual`.
 */
export interface AssetOverrides {
  /** Address relative to the referenced asset → patch. The only addressing a writer produces. */
  byAddress: Record<string, ComponentPatch>;
  /**
   * Read-only bridge for a file written before ids existed (`byPath`): path RELATIVE
   * TO THE REFERENCE NODE → patch. Resolved when applied and migrated to
   * {@link byAddress} in memory; an entry that resolves nowhere stays here (an orphan,
   * reported, and written back as it was — never dropped).
   */
  legacyByPath?: Record<string, ComponentPatch>;
  /**
   * How many part moves (`trsByNodeId`) an old file carried. They are not applied any
   * more (F14) and never written again; the count is what the load reports.
   */
  droppedTransforms?: number;
}

/** Address key of a node id of the referenced asset (`#<id>`). */
export function overrideAddressOf(nodeId: string): string {
  return `#${nodeId}`;
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
  return ownExtrasOf(node.userData);
}

function ensureExtras(node: Object3D): Record<string, unknown> {
  const ud = node.userData as Record<string, unknown>;
  let rv = ownExtrasOf(ud);
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
 * The `AssetOverrides` on a node, or null when it carries none (plan-769 Phase 4).
 *
 * Reads every form a file may carry: `byAddress` (since 769), the legacy
 * `byNodeId` (read as `#<id>` — the address of that id in the asset; a `byAddress`
 * entry for the same key wins field by field), the legacy `byPath` (kept as
 * {@link AssetOverrides.legacyByPath}) and the removed `trsByNodeId` (counted only).
 */
export function getAssetOverrides(node: Object3D): AssetOverrides | null {
  return readAssetOverridesRecord(extrasOf(node)?.[RV_ASSET_OVERRIDES_KEY]);
}

/**
 * {@link getAssetOverrides} over a raw `AssetOverrides` record — a node's extras, a
 * glTF JSON node, or an override set handed around in memory (a layout record of an
 * older session). Idempotent: the in-memory form normalises to itself.
 */
export function readAssetOverridesRecord(raw: unknown): AssetOverrides | null {
  if (!isPlainObject(raw)) return null;
  const byAddress: Record<string, ComponentPatch> = {};
  if (isPlainObject(raw.byNodeId)) {
    for (const [id, patch] of Object.entries(raw.byNodeId)) {
      // Content-safe (rv-safe-keys.ts): no prototype-slot keys at any level.
      if (isUnsafeObjectKey(id) || !isPlainObject(patch)) continue;
      byAddress[overrideAddressOf(id)] = clonePatch(patch as ComponentPatch);
    }
  }
  if (isPlainObject(raw.byAddress)) {
    for (const [address, patch] of Object.entries(raw.byAddress)) {
      if (isUnsafeObjectKey(address) || !isPlainObject(patch)) continue;
      byAddress[address] = mergePatches(
        ownValue(byAddress, address) as ComponentPatch | undefined, patch as ComponentPatch);
    }
  }
  // The stored `byPath` and the in-memory `legacyByPath` (this reader is idempotent:
  // a record already in the in-memory form — e.g. a layout record — normalises to itself).
  const legacySource = isPlainObject(raw.legacyByPath) ? raw.legacyByPath
    : isPlainObject(raw.byPath) ? raw.byPath : null;
  let legacyByPath: Record<string, ComponentPatch> | undefined;
  if (legacySource) {
    const kept: Record<string, ComponentPatch> = {};
    for (const [path, patch] of Object.entries(legacySource)) {
      if (!isUnsafeObjectKey(path) && isPlainObject(patch)) kept[path] = clonePatch(patch as ComponentPatch);
    }
    if (Object.keys(kept).length > 0) legacyByPath = kept;
  }
  const droppedTransforms = isPlainObject(raw.trsByNodeId) ? Object.keys(raw.trsByNodeId).length
    : typeof raw.droppedTransforms === 'number' && raw.droppedTransforms > 0 ? raw.droppedTransforms : 0;
  if (Object.keys(byAddress).length === 0 && !legacyByPath && droppedTransforms === 0) return null;
  const out: AssetOverrides = { byAddress };
  if (legacyByPath) out.legacyByPath = legacyByPath;
  if (droppedTransforms > 0) out.droppedTransforms = droppedTransforms;
  return out;
}

/** A copy of a component patch (componentType → { field → value }). */
function clonePatch(patch: ComponentPatch): ComponentPatch {
  const out: ComponentPatch = {};
  for (const [componentType, fields] of Object.entries(patch)) {
    if (!isUnsafeObjectKey(componentType) && isPlainObject(fields)) out[componentType] = ownFieldsOf(fields);
  }
  return out;
}

/** The OWN, safe-keyed fields of a component record (rv-safe-keys.ts). */
function ownFieldsOf(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (!isUnsafeObjectKey(k)) out[k] = v;
  return out;
}

/** `base` ⊕ `over` per component, field by field (`over` wins). */
export function mergeComponentPatches(base: ComponentPatch | undefined, over: ComponentPatch): ComponentPatch {
  return mergePatches(base, over);
}

function mergePatches(base: ComponentPatch | undefined, over: ComponentPatch): ComponentPatch {
  const out = base ? clonePatch(base) : {};
  for (const [componentType, fields] of Object.entries(over)) {
    if (isUnsafeObjectKey(componentType) || !isPlainObject(fields)) continue;
    // OWN reads only: an inherited record must never be copied into an own entry.
    const prev = ownValue(out, componentType);
    out[componentType] = { ...(isPlainObject(prev) ? prev : {}), ...ownFieldsOf(fields) };
  }
  return out;
}

/**
 * Write `AssetOverrides` onto a node; an empty override set removes the key.
 *
 * Writes the 769 form only: `byAddress`, plus the legacy `byPath` entries that did not
 * resolve (kept so an orphan is never silently dropped). Never `byNodeId`, never
 * `trsByNodeId` (F14).
 */
export function setAssetOverrides(node: Object3D, overrides: AssetOverrides | null): void {
  const rv = ensureExtras(node);
  const record = assetOverridesRecordOf(overrides);
  if (record) rv[RV_ASSET_OVERRIDES_KEY] = record;
  else delete rv[RV_ASSET_OVERRIDES_KEY];
}

/** The stored record of `overrides` (the 769 form), or null when nothing is left to store. */
function assetOverridesRecordOf(overrides: AssetOverrides | null): Record<string, unknown> | null {
  const byAddress = overrides?.byAddress ?? {};
  const legacy = overrides?.legacyByPath ?? {};
  if (Object.keys(byAddress).length === 0 && Object.keys(legacy).length === 0) return null;
  // An empty `byAddress` is not stored: a file with only unresolved legacy paths keeps
  // exactly its `byPath` record.
  const out: Record<string, unknown> = {};
  if (Object.keys(byAddress).length > 0) out.byAddress = byAddress;
  if (Object.keys(legacy).length > 0) out.byPath = legacy;
  return out;
}

/**
 * Bring one stored `AssetOverrides` record into the 769 form in place (plan-769 F14):
 * `byNodeId` → `byAddress['#id']`, `trsByNodeId` dropped, unresolved `byPath` kept.
 * The save writers call it on the extras they write, so no file is written with
 * `trsByNodeId` or `byNodeId` again, even for a reference node that was never applied.
 * Returns true when the record changed.
 */
export function canonicalizeAssetOverridesIn(rv: Record<string, unknown>): boolean {
  const raw = rv[RV_ASSET_OVERRIDES_KEY];
  if (raw === undefined) return false;
  const record = assetOverridesRecordOf(readAssetOverridesRecord(raw));
  if (record && JSON.stringify(record) === JSON.stringify(raw)) return false;
  if (record) rv[RV_ASSET_OVERRIDES_KEY] = record;
  else delete rv[RV_ASSET_OVERRIDES_KEY];
  return true;
}

/** {@link canonicalizeAssetOverridesIn} over every node of a tree. Returns how many records changed. */
export function canonicalizeAssetOverridesInTree(root: Object3D): number {
  let changed = 0;
  root.traverse((node) => {
    const rv = extrasOf(node);
    if (rv && canonicalizeAssetOverridesIn(rv)) changed++;
  });
  return changed;
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
    // Content-safe (rv-safe-keys.ts): no prototype-slot keys, OWN records only.
    if (isUnsafeObjectKey(componentType) || !isPlainObject(fields)) continue;
    if (!isPlainObject(ownValue(rv, componentType))) rv[componentType] = {};
    const target = rv[componentType];

    for (const [fieldName, value] of Object.entries(fields)) {
      if (isUnsafeObjectKey(fieldName)) continue;
      if (value === null) {
        if (Object.prototype.hasOwnProperty.call(target, fieldName)) {
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
    // plan-774 F1: what the OPEN file's patch replaces is the asset's own value
    // (inner layers already applied) — kept so a Revert can put it back live.
    if (layer.strength === OVERRIDE_STRENGTH.OUTER_REFERENCE) recordOverrideBases(node, layer.patch);
    if (applyComponentPatch(node, layer.patch)) changed = true;
  }
  return changed;
}

// ─── The asset's own value under an instance override (plan-774 F1) ─────

/**
 * Runtime key (never saved — `_` keys are stripped on export) holding, per
 * component field, the value a node of placed content had BEFORE the open file's
 * override replaced it: `{ [componentType]: { [fieldName]: OverrideBase } }`.
 */
export const RV_OVERRIDE_BASE_KEY = '_rvOverrideBase';

/** The asset's own value of one field: `has: false` = the asset does not set it. */
export interface OverrideBase { has: boolean; value?: unknown }

function cloneJsonValue<T>(v: T): T {
  return v === undefined || v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)) as T;
}

/**
 * The asset's own value of `componentType.fieldName` on `node` — recorded when
 * the open file's override was first applied (load) or first written (editor
 * session) — or null when it was never recorded.
 */
export function overrideBaseOf(node: Object3D, componentType: string, fieldName: string): OverrideBase | null {
  const all = node.userData?.[RV_OVERRIDE_BASE_KEY] as Record<string, Record<string, OverrideBase>> | undefined;
  const base = all?.[componentType]?.[fieldName];
  return base ? { has: base.has, ...(base.has ? { value: cloneJsonValue(base.value) } : {}) } : null;
}

/**
 * Record the asset's own value of one field, unless one is recorded already —
 * the FIRST recording is the asset's value; a later one would capture an
 * override or a session edit.
 */
export function recordOverrideBase(node: Object3D, componentType: string, fieldName: string, base: OverrideBase): void {
  if (isUnsafeObjectKey(componentType) || isUnsafeObjectKey(fieldName)) return;
  const ud = node.userData as Record<string, unknown>;
  const all = (ud[RV_OVERRIDE_BASE_KEY] ??= {}) as Record<string, Record<string, OverrideBase>>;
  if (!isPlainObject(ownValue(all, componentType))) all[componentType] = {};
  const fields = all[componentType]!;
  if (ownValue(fields, fieldName)) return;
  fields[fieldName] = base.has ? { has: true, value: cloneJsonValue(base.value) } : { has: false };
}

/** {@link recordOverrideBase} for every field a patch is about to replace on `node`. */
function recordOverrideBases(node: Object3D, patch: ComponentPatch): void {
  const rv = extrasOf(node) as Record<string, Record<string, unknown> | undefined> | undefined;
  for (const [componentType, fields] of Object.entries(patch)) {
    if (!isPlainObject(fields)) continue;
    if (isUnsafeObjectKey(componentType)) continue;
    const current = ownValue(rv, componentType) as Record<string, unknown> | undefined;
    for (const fieldName of Object.keys(fields)) {
      if (isUnsafeObjectKey(fieldName)) continue;
      const has = !!current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, fieldName);
      recordOverrideBase(node, componentType, fieldName, has ? { has, value: current[fieldName] } : { has: false });
    }
  }
}

// ─── Override application with orphan reporting ──────────────────────────

/** An override whose target no longer exists. Reported, never silently dropped. */
export interface OrphanedOverride {
  /** How it addressed its target: an address (`byAddress` / legacy `byNodeId`) or a legacy path. */
  addressing: 'address' | 'path';
  /** The address or relative path that did not resolve. */
  key: string;
  /** Occurrence address of the reference node the override sits on. */
  occurrence: string;
  /** assetId of the reference, for the user-facing message. */
  assetId: string;
  /** Component types the override would have touched. */
  componentTypes: string[];
  /**
   * plan-769 Phase 4b: why, when it is more than "no such node" —
   * `ambiguous` (the id names two nodes of the asset, none is guessed) or the
   * flush reason of a nested override whose occurrence never materialised.
   */
  reason?: OrphanReason;
}

/** Why an override found no target (absent = the node is not in the asset). */
export type OrphanReason = 'ambiguous' | 'missing' | 'placement-missing' | 'placement-cap' | 'placement-refused';

/**
 * plan-769 Phase 4b (F13): one override aimed past the referenced asset into one
 * of ITS references — `<b>#<id>` / `<b>/<c>#<id>`, or a legacy path that leads
 * through a reference node. The caller routes it to that nested occurrence.
 */
export interface NestedOverride {
  /** Occurrence segments below the reference node (identity ids of the nested reference nodes). */
  segments: string[];
  /** The remainder inside the nested occurrence's asset: an address (`#<id>`) … */
  address?: string;
  /** … or a legacy path relative to the nested reference node. */
  path?: string;
  patch: ComponentPatch;
  /** The key exactly as the outer reference node stores it (problem ids, reports). */
  key: string;
  addressing: 'address' | 'path';
}

export interface ApplyOverridesResult {
  /** How many target nodes were actually changed. */
  applied: number;
  /** Overrides that found no target. Never empty-and-ignored — F9. */
  orphaned: OrphanedOverride[];
  /**
   * plan-769 9.22: legacy `byPath` keys that resolved, with the address they now have
   * (`#<id>`, `<b>#<id>`). The caller migrates the reference node's overrides in memory
   * ({@link migrateLegacyOverridePaths}); the next save writes `byAddress` only.
   */
  migratedPaths: Record<string, string>;
  /** The old file's part moves that were not applied (F14) — the caller reports them. */
  droppedTransforms: number;
  /** Overrides aimed into a nested occurrence that this subtree does not hold (4b) — the caller routes them. */
  nested: NestedOverride[];
}

/** One resolved override: the node and the patch for it. */
export interface OverrideHit {
  target: Object3D;
  patch: ComponentPatch;
}

/** {@link resolveAssetOverrides}: the hits plus everything {@link ApplyOverridesResult} reports. */
export interface ResolvedOverrides extends Omit<ApplyOverridesResult, 'applied'> {
  hits: OverrideHit[];
}

/** How a target is looked up inside one referenced subtree. */
export interface OverrideResolvers {
  /**
   * An address relative to the referenced asset (`#<id>`, `<b>#<id>`). A resolver
   * that holds the nested content (composition grafts it) answers nested addresses
   * too; one that does not (a placement instance) answers null and the override is
   * routed as {@link NestedOverride}.
   */
  byAddress: (address: string) => Object3D | null;
  /** A legacy path relative to the reference node. */
  byPath: (relativePath: string) => Object3D | null;
  /** The address a resolved node has in the referenced asset (for the `byPath` migration). */
  addressOf: (node: Object3D) => string | null;
  /** True when `address` names more than one node (reported as `ambiguous`, never guessed). */
  isAmbiguous?: (address: string) => boolean;
}

/** True for a node that opens another asset's content (an `AssetReference` that is not embedded). */
function isOpeningReference(node: Object3D): boolean {
  const ref = extrasOf(node)?.[RV_ASSET_REFERENCE_KEY];
  return isPlainObject(ref) && ref.embedded !== true;
}

/**
 * plan-769 Phase 4b — the override address of `node` relative to the asset that
 * `referenceNode` opens: the identity ids of the reference nodes between the two
 * (outermost first) as occurrence segments, then `#<id>` of the node itself.
 * `''` segments = a node of that asset directly. Null when `node` is not below
 * `referenceNode` or an id on the way is missing.
 */
export function overrideAddressInReference(
  referenceNode: Object3D,
  node: Object3D,
  identityOf: (node: Object3D) => string | null,
): string | null {
  if (node === referenceNode) return null;
  const id = identityOf(node);
  if (!id) return null;
  const segments: string[] = [];
  let cur = node.parent;
  while (cur && cur !== referenceNode) {
    if (isOpeningReference(cur)) {
      const seg = identityOf(cur);
      if (!seg) return null;
      segments.unshift(seg);
    }
    cur = cur.parent;
  }
  if (!cur) return null;
  return `${segments.join('/')}#${id}`;
}

/**
 * Resolvers that search a single parsed subtree, with no registry involved.
 *
 * Enough for composition, which applies a subtree's overrides once the subtree —
 * its own nested references grafted — is complete. Paths are relative to
 * `subtreeRoot`, the reference node's content — the frame the `byPath` keys were
 * written in. Ids are the nodes' IDENTITY (`identityOf`): the authored NodeId,
 * else the seed of the decode — a Unity asset has no authored ids.
 *
 * plan-769 Phase 4b: addresses are SCOPED. `#<id>` is a node of this asset; the
 * content of a nested reference node `b` answers only as `b#<id>` (F13) — an id
 * deeper down never answers the flat form. A duplicated id within one scope is
 * ambiguous (reported, not "first wins").
 */
export function makeSubtreeResolvers(
  subtreeRoot: Object3D,
  identityOf: (node: Object3D) => string | null = getNodeId,
): OverrideResolvers {
  const byAddress = new Map<string, Object3D>();
  const ambiguous = new Set<string>();
  const addressOfNode = new Map<Object3D, string>();
  const byPath = new Map<string, Object3D>();

  // `occurrence` is the node-address occurrence chain (`<refId>/<refId>`), NOT a
  // signal-symbol scope — it is built by `childOccurrence`, the one producer.
  const walk = (node: Object3D, prefix: string, occurrence: string): void => {
    if (prefix) byPath.set(prefix, node);
    const id = identityOf(node);
    if (id) {
      const address = `${occurrence}#${id}`;
      if (byAddress.has(address)) ambiguous.add(address);
      else byAddress.set(address, node);
      addressOfNode.set(node, address);
    }
    // The content below a nested reference node is another occurrence (F13).
    // A reference node without an identity opens an occurrence no key can name.
    let childOcc = occurrence;
    if (node !== subtreeRoot && isOpeningReference(node)) {
      childOcc = childOccurrence(occurrence, identityOf(node) || UNADDRESSABLE_OCCURRENCE);
    }
    for (const child of node.children) {
      walk(child, prefix ? `${prefix}/${child.name}` : child.name, childOcc);
    }
  };
  walk(subtreeRoot, '', '');

  return {
    byAddress: (address) => (ambiguous.has(address) ? null : byAddress.get(address) ?? null),
    byPath: (p) => byPath.get(p) ?? null,
    addressOf: (node) => addressOfNode.get(node) ?? null,
    isAmbiguous: (address) => ambiguous.has(address),
  };
}

/** `<occ>#<id>` → its occurrence segments and the local `#<id>`; null for a malformed key. */
function splitOverrideAddress(address: string): { segments: string[]; local: string } | null {
  const hash = address.lastIndexOf('#');
  if (hash < 0 || hash === address.length - 1) return null;
  const occ = address.slice(0, hash);
  return { segments: occ ? occ.split('/').filter(Boolean) : [], local: address.slice(hash) };
}

/**
 * Resolve a reference node's `AssetOverrides` against one subtree WITHOUT applying
 * them (plan-769 Phase 4b): the hits, the orphans, the legacy paths that migrated,
 * the overrides that go into a nested occurrence this subtree does not hold.
 * Precedence between several override sets is the caller's — {@link applyOverrideLayers}.
 */
export function resolveAssetOverrides(
  overrides: AssetOverrides,
  resolvers: OverrideResolvers,
  context: { occurrence: string; assetId: string },
): ResolvedOverrides {
  const hits: OverrideHit[] = [];
  const orphaned: OrphanedOverride[] = [];
  const nested: NestedOverride[] = [];
  const migratedPaths: Record<string, string> = {};
  const orphan = (addressing: 'address' | 'path', key: string, patch: ComponentPatch, reason?: OrphanReason): void => {
    orphaned.push({
      addressing, key, occurrence: context.occurrence, assetId: context.assetId,
      componentTypes: Object.keys(patch ?? {}), ...(reason ? { reason } : {}),
    });
  };

  for (const [address, patch] of Object.entries(overrides.byAddress ?? {})) {
    const target = resolvers.byAddress(address);
    if (target) { hits.push({ target, patch }); continue; }
    if (resolvers.isAmbiguous?.(address)) { orphan('address', address, patch, 'ambiguous'); continue; }
    const split = splitOverrideAddress(address);
    if (split && split.segments.length > 0) {
      nested.push({ segments: split.segments, address: split.local, patch, key: address, addressing: 'address' });
      continue;
    }
    orphan('address', address, patch);
  }

  for (const [relPath, patch] of Object.entries(overrides.legacyByPath ?? {})) {
    const target = resolvers.byPath(relPath);
    if (target) {
      hits.push({ target, patch });
      const address = resolvers.addressOf(target);
      if (address) migratedPaths[relPath] = address;
      continue;
    }
    // A path through a nested reference node (`Cell_1/Slide` with a reference `Cell_1`):
    // the remainder belongs to that occurrence — routed, no longer refused (4b).
    const segs = relPath.split('/').filter(Boolean);
    let routed = false;
    for (let n = segs.length - 1; n >= 1; n--) {
      const node = resolvers.byPath(segs.slice(0, n).join('/'));
      if (!node || !isOpeningReference(node)) continue;
      const own = resolvers.addressOf(node);
      const split = own ? splitOverrideAddress(own) : null;
      if (!split) break;
      nested.push({
        segments: [...split.segments, split.local.slice(1)],
        path: segs.slice(n).join('/'), patch, key: relPath, addressing: 'path',
      });
      routed = true;
      break;
    }
    if (!routed) orphan('path', relPath, patch);
  }

  return { hits, orphaned, migratedPaths, droppedTransforms: overrides.droppedTransforms ?? 0, nested };
}

/**
 * Apply a reference node's `AssetOverrides` to the subtree grafted under it — ONE
 * set, so {@link applyOverrideLayers} with a single layer per target. `byAddress`
 * first, then the legacy `byPath` bridge (each resolved key reported in
 * `migratedPaths` with its address), then orphan. Part moves of an old file are NOT
 * applied (F14) — their count comes back for the caller to report.
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
  const { hits, ...rest } = resolveAssetOverrides(overrides, resolvers, context);
  const [applied] = applyResolvedOverrideSets([{ hits, depth: 0 }]);
  return { applied: applied ?? 0, ...rest };
}

/** The strength class of an override set whose record lives in a file at `depth` (0 = the document). */
export function overrideStrengthAt(depth: number): OverrideStrength {
  return depth <= 0 ? OVERRIDE_STRENGTH.OUTER_REFERENCE : OVERRIDE_STRENGTH.INNER_REFERENCE;
}

/**
 * Apply several resolved override sets in precedence order — THE precedence point
 * of composition and placements (plan-769 Phase 4b, F13): hits are grouped per
 * target node and each group goes through {@link applyOverrideLayers}, so the
 * outer file wins whatever order the sets arrived in.
 * @returns per set, how many of its hits changed their node.
 */
export function applyResolvedOverrideSets(
  sets: ReadonlyArray<{ hits: readonly OverrideHit[]; depth: number }>,
): number[] {
  const byTarget = new Map<Object3D, Array<OverrideLayer & { set: number }>>();
  sets.forEach((s, set) => {
    for (const hit of s.hits) {
      let layers = byTarget.get(hit.target);
      if (!layers) { layers = []; byTarget.set(hit.target, layers); }
      layers.push({ strength: overrideStrengthAt(s.depth), depth: s.depth, patch: hit.patch, set });
    }
  });
  const applied = sets.map(() => 0);
  for (const [target, layers] of byTarget) {
    if (!applyOverrideLayers(target, layers)) continue;
    for (const set of new Set(layers.map((l) => l.set))) applied[set]!++;
  }
  return applied;
}

/**
 * plan-769 9.22 — `overrides` with every legacy `byPath` key that resolved moved to its
 * address (merged under an existing `byAddress` entry, which wins). Unresolved paths stay.
 */
export function migrateLegacyOverridePaths(overrides: AssetOverrides, migrated: Record<string, string>): AssetOverrides {
  if (Object.keys(migrated).length === 0) return overrides;
  const byAddress: Record<string, ComponentPatch> = { ...overrides.byAddress };
  const legacy: Record<string, ComponentPatch> = { ...(overrides.legacyByPath ?? {}) };
  for (const [relPath, address] of Object.entries(migrated)) {
    const patch = legacy[relPath];
    if (!patch) continue;
    byAddress[address] = byAddress[address] ? mergePatches(patch, byAddress[address]!) : clonePatch(patch);
    delete legacy[relPath];
  }
  const out: AssetOverrides = { byAddress };
  if (Object.keys(legacy).length > 0) out.legacyByPath = legacy;
  return out;
}

/** Runtime key (never saved — `_` keys are stripped on export) of {@link recordOverridePathMigration}. */
export const RV_OVERRIDE_PATH_MIGRATION_KEY = '_rvOverridePathMigration';

/**
 * plan-769 9.22 — remember on the reference node which legacy `byPath` keys of ITS
 * FILE resolved to which address. The planner save works on the file's JSON, not on
 * the live tree; it reads this to write those keys as `byAddress` (never `byPath`).
 */
export function recordOverridePathMigration(node: Object3D, migrated: Readonly<Record<string, string>>): void {
  if (Object.keys(migrated).length === 0) return;
  const ud = node.userData as Record<string, unknown>;
  const prior = isPlainObject(ud[RV_OVERRIDE_PATH_MIGRATION_KEY]) ? ud[RV_OVERRIDE_PATH_MIGRATION_KEY] as Record<string, string> : {};
  ud[RV_OVERRIDE_PATH_MIGRATION_KEY] = { ...prior, ...migrated };
}

/** The migrations {@link recordOverridePathMigration} remembered on `node`, or null. */
export function overridePathMigrationOf(node: Object3D): Readonly<Record<string, string>> | null {
  const m = (node.userData as Record<string, unknown> | undefined)?.[RV_OVERRIDE_PATH_MIGRATION_KEY];
  return isPlainObject(m) ? m as Record<string, string> : null;
}

/**
 * The same migration over a STORED record (glTF JSON extras): every `byPath` key in
 * `migrated` moves under its address (an existing `byAddress` entry wins field by
 * field); the rest stays. Returns true when the record changed.
 */
export function migrateStoredOverridePaths(rv: Record<string, unknown>, migrated: Readonly<Record<string, string>>): boolean {
  const current = readAssetOverridesRecord(rv[RV_ASSET_OVERRIDES_KEY]);
  if (!current?.legacyByPath) return false;
  const relevant: Record<string, string> = {};
  for (const k of Object.keys(current.legacyByPath)) if (migrated[k]) relevant[k] = migrated[k]!;
  if (Object.keys(relevant).length === 0) return false;
  const record = assetOverridesRecordOf(migrateLegacyOverridePaths(current, relevant));
  if (record) rv[RV_ASSET_OVERRIDES_KEY] = record; else delete rv[RV_ASSET_OVERRIDES_KEY];
  return true;
}

/** One line per orphan, for the non-blocking status row (§3.2 of the plan). */
export function describeOrphanedOverride(o: OrphanedOverride): string {
  const where = o.occurrence ? ` in occurrence ${o.occurrence}` : '';
  const what = o.componentTypes.length > 0 ? o.componentTypes.join(', ') : 'override';
  return `${what} → ${o.addressing === 'address' ? 'node' : 'path'} "${o.key}" no longer exists `
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
  /**
   * The library qualifier of a SPLAT placement (plan-778): written, like
   * `catalogId`, only when the node carries no `AssetReference` to hold it.
   */
  providerId?: string;
  sourceId?: string;
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
  if (typeof raw.providerId === 'string' && raw.providerId) meta.providerId = raw.providerId;
  if (typeof raw.sourceId === 'string' && raw.sourceId) meta.sourceId = raw.sourceId;
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
  if (meta.providerId) out.providerId = meta.providerId;
  if (meta.sourceId) out.sourceId = meta.sourceId;
  if (meta.splatUrl) out.splatUrl = meta.splatUrl;
  if (meta.visible === false) out.visible = false;
  if (meta.signalMappings && meta.signalMappings.length > 0) out.signalMappings = meta.signalMappings;
  rv[RV_PLACEMENT_META_KEY] = out;
}

/** True when this node was written as a layout placement. */
export function isPlacementNode(node: Object3D): boolean {
  return isPlainObject(extrasOf(node)?.[RV_PLACEMENT_META_KEY]);
}

// ─── Deferred placement (plan-753, Reload = Planner-Instanzen) ──────────

/**
 * Session-only marker (`userData`, never `realvirtual` extras) on a placement
 * root whose referenced asset composition did NOT graft: the loader leaves the
 * root empty and the layout planner instantiates the asset's shared
 * `BakedAsset` under it after the load — the same door a live placement takes.
 *
 * Lives in `userData` so it can never reach a file: `objectToGlb` writes
 * `userData` as extras, but a save rebuilds placement nodes from their records
 * (`rv-scene-glb-bake.ts`), and the planner clears the mark the moment it takes
 * the node over.
 */
export const RV_DEFERRED_PLACEMENT_KEY = '_rvDeferredPlacement';

export interface DeferredPlacementMark {
  /** The occurrence chain composition assigned — the missing-reference problem id. */
  occurrence: string;
  /**
   * The reference's `path` resolved against the containing file (plan-757
   * Phase 2b, `DeferredReference.resolvedPath`); absent when the reference has
   * no path or the mark predates the field. The instancer prefers it over the
   * raw `path`, so a RELATIVE path of a deferred document reference resolves
   * exactly as the graft would have resolved it.
   */
  resolvedPath?: string;
}

/** Mark a placement root as "pending instantiate" (composition skipped it). */
export function markDeferredPlacement(node: Object3D, occurrence: string, resolvedPath?: string): void {
  node.userData[RV_DEFERRED_PLACEMENT_KEY] = resolvedPath ? { occurrence, resolvedPath } : { occurrence };
}

/** The deferred mark on a node, or null. */
export function getDeferredPlacement(node: Object3D): DeferredPlacementMark | null {
  const raw = node.userData[RV_DEFERRED_PLACEMENT_KEY];
  if (!isPlainObject(raw)) return null;
  const mark: DeferredPlacementMark = { occurrence: typeof raw.occurrence === 'string' ? raw.occurrence : '' };
  if (typeof raw.resolvedPath === 'string' && raw.resolvedPath) mark.resolvedPath = raw.resolvedPath;
  return mark;
}

/**
 * plan-774 F5: runtime key on a deferred reference node — the `LayoutObject`
 * record the FILE wrote on it (a JSON copy), or `false` when it wrote none.
 * The instancer stamps its own record on every placement root it materialises
 * (`stampPlacementMarkers`, overwriting `Label` / `CatalogId` / `Locked`); the
 * asset editor's save writes back what the file had, never that runtime stamp.
 * `_`-prefixed, so it never reaches a file itself.
 */
export const RV_AUTHORED_LAYOUT_OBJECT_KEY = '_rvAuthoredLayoutObject';

/**
 * plan-774 review fix E2: runtime key on a placement root — the PURE
 * `LayoutObject` stamp of `stampPlacementMarkers` (`{ Label, CatalogId, Locked }`),
 * before any authored record is merged in. The editor's save drops exactly the
 * fields whose live value is still this stamp and the file did not author.
 */
export const RV_LAYOUT_OBJECT_STAMP_KEY = '_rvLayoutObjectStamp';

/** Record whether the file wrote a `LayoutObject` on this reference node (before any stamp). */
export function recordAuthoredLayoutObject(node: Object3D): void {
  if (RV_AUTHORED_LAYOUT_OBJECT_KEY in node.userData) return;
  const rv = node.userData.realvirtual as Record<string, unknown> | undefined;
  const authored = rv && typeof rv === 'object' ? rv.LayoutObject : undefined;
  node.userData[RV_AUTHORED_LAYOUT_OBJECT_KEY] = authored === undefined ? false : JSON.parse(JSON.stringify(authored));
}

/** Remove the deferred mark — the planner owns the node from here on. */
export function clearDeferredPlacement(node: Object3D): void {
  delete node.userData[RV_DEFERRED_PLACEMENT_KEY];
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
