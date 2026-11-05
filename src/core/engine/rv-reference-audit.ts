// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-reference-audit.ts — the load audit of stored node references (plan-610 Phase 3, F9).
 *
 * After a load (viewer, placement settle, asset editor open / recompose) and after every
 * structural edit, every stored reference of the open document is resolved ONCE more,
 * quietly, through the registry's ONE resolution chain
 * ({@link NodeRegistry.resolveWithStage}, with the reference's component type and the
 * referrer's authoring scope). What comes out is a plain list:
 *
 *  - `unresolved` — no node at all answers the written path;
 *  - `rescued`    — a node answers, but only through a genuine fallback lookup
 *                   (`suffix`, `sanitized`, `name-in-scope`): the binding works today and
 *                   may land elsewhere tomorrow.
 *
 * The viewer turns the list into Problems entries (`reference-unresolved` = error,
 * `reference-rescued` = warning).
 *
 * plan-769 Phase 1b: a reference the FILE carries (its decode migrated it) is judged
 * by its file first ({@link ReferenceAuditRegistry.auditStoredReference}): it
 * resolves by address, or it is `unresolved` — never `rescued`, because no guessing
 * stage reads it any more. An ambiguous or generated target is the migration's own
 * problem (`reference-ambiguous` / `reference-target-synthetic`), not repeated here.
 * Only a reference without a file verdict (no identity record, or a path the web
 * wrote this session) still runs the chain below — and can still be `rescued`. This module reports nothing itself and imports nothing
 * from the viewer, the plugins or the HMI layer (engine boundary,
 * `tests/engine-import-boundary.node.test.ts`) — which is also what lets a Node test run it
 * against a registry built straight from GLB JSON.
 *
 * ## What is walked
 *
 * Every registered, NON-alias node carrying `userData.realvirtual`; per component record:
 *  - every `ComponentReference`, however deep it is nested (the reach of the rewrite core,
 *    `rv-node-path-rewrite.mjs` — what the rewrite can write, the audit checks);
 *  - every declared path-string field ({@link PATH_FIELDS}), resolved as a plain node.
 * Referrers inside placed (referenced) content are checked like all others: their
 * references are asset-relative and must resolve in the asset's scope — exactly what
 * passing the referrer as scope does.
 *
 * ## What is NOT a finding (the false-positive rules)
 *
 *  - an empty optional reference (`path` missing or `''`);
 *  - the regular Unity export spelling: root-prefixed or root-stripped paths that resolve
 *    exactly in the authoring scope (`exact`);
 *  - a hit through an `alias` or the `space` normalisation: those spellings are published
 *    BY THE LOADER for the authored names of renamed / sanitized nodes (Three.js name
 *    dedup and sanitizing, the bake's asset-relative alias table for re-parented
 *    kinematics — `rv-node-aliases.ts`, `initSubtree` step 2b). An authored Unity path
 *    through such a node is not a fallback, it is the path as written;
 *  - a typed miss on an EXISTING node (a reference whose target type is not built in this
 *    viewer, or built later — the late-resolution contract of `resolveComponentRefs`):
 *    the node is evaluated instead; the audit is about paths, not about component types;
 *  - a complete miss in a field of {@link LATE_RESOLUTION_FIELDS} (raw paths resolved by
 *    their component later, against content that may not exist at load).
 *  - anything inside an `AssetOverrides` record (keys and values are relative to the
 *    referenced asset, not to the node carrying them — plan-610 decision log).
 */

import type { Object3D } from 'three';
import {
  PATH_FIELDS,
  storedReferenceLabel,
  storedReferenceValue,
  visitReferences,
  type StoredReferenceValue,
  type PathFieldEntry,
  type ReferenceLookupStage,
} from './rv-node-path-rewrite.mjs';
import type { StagedReferenceResolution } from './rv-node-registry';
import { isInsideReference, outermostReference } from './rv-reference-scope';
import { GROUP_KEY_RE, resolveGroupName } from './rv-group-sync';
import { RV_OVERRIDE_BASE_KEY, type OverrideBase } from './rv-asset-reference';

// ─── Types ──────────────────────────────────────────────────────────────

/** One reference the audit reports. */
export interface ReferenceAuditFinding {
  kind: 'unresolved' | 'rescued';
  /** Canonical registry path of the node carrying the reference (the Problems `nodePath`). */
  referrerPath: string;
  /** rv extras key of the component holding the reference (`Drive_Cylinder`, `Kinematic_1`). */
  componentType: string;
  /** Top-level field key of that component. */
  field: string;
  /** Element position when the top-level field is an array. */
  index?: number;
  /** Location below `field[index]` for nested references (`targetObjects[1]`, `source`). */
  subPath?: string;
  /** The path exactly as stored. */
  writtenPath: string;
  /** The reference's own target component type (`realvirtual.Drive`, …); absent for a path-string field. */
  targetComponentType?: string;
  /** Canonical path of the node a `rescued` reference landed on. */
  resolvedPath?: string;
  /** The fallback lookup stage that hit (`rescued` only). */
  stage?: ReferenceLookupStage;
  /**
   * `unresolved` only, and only when true (plan-765 F6): a node answers the
   * written path with a Three.js dedup suffix `_1` … `_3` appended — the mark of
   * a file saved by an editor before plan-765, which wrote the loader's names.
   */
  dedupSuffixExists?: true;
  /**
   * `unresolved` only, plan-774 F7: the referrer is OWNED content of the open
   * document and its target lies inside a PLACED reference whose content is
   * materialised — the subasset's bake did not keep that node (a plain part
   * merged into a chunk). Canonical registry path of that reference node.
   */
  bakedAwayIn?: string;
  /** With {@link bakedAwayIn}: the target address (`<p>#<id>`) when the reference is stored as one. */
  targetAddress?: string;
}

/** The result of one audit walk. */
export interface ReferenceAuditResult {
  findings: ReferenceAuditFinding[];
  counts: {
    /** Registered non-alias nodes with rv extras that were walked. */
    referrers: number;
    /** Non-empty references looked at. */
    references: number;
    unresolved: number;
    rescued: number;
    /** Complete misses swallowed by {@link LATE_RESOLUTION_FIELDS}. */
    lateSkipped: number;
  };
  /** Wall time of the walk (ms). */
  ms: number;
}

/** The registry surface the audit needs — a real `NodeRegistry` satisfies it. */
export interface ReferenceAuditRegistry {
  forEachNode(callback: (path: string, node: Object3D) => void): void;
  getPathForNode(node: Object3D): string | null;
  resolveWithStage(
    ref: { path: string; componentType?: string | null },
    componentType: string | null | undefined,
    scope?: Object3D | null,
  ): StagedReferenceResolution | null;
  /**
   * plan-769 Phase 1b (optional — a registry built from raw JSON has none): the
   * verdict of the reference's FILE. `file` = the file carries the reference and
   * its migration / address decides (a miss is `reference-unresolved`, never
   * `reference-rescued`); `legacy` = no file to judge by, the chain above applies.
   */
  auditStoredReference?(
    ref: { path: string; componentType?: string | null },
    componentType: string | null | undefined,
    referrer: Object3D,
  ): { verdict: 'file'; hit: StagedReferenceResolution | null; reason?: 'missing' | 'ambiguous' | 'synthetic-target' | 'pending'; address?: string }
    | { verdict: 'legacy' };
  /** plan-769 Phase 3 (optional): the verdict of an address-form reference. */
  readStoredRef?(referrer: Object3D, ref: StoredReferenceValue): { status: string; address?: string };
  /** Optional: `NodeRegistry.runtimeSignalLeafFor`. */
  runtimeSignalLeafFor?(referrer: Object3D, ref: unknown): Object3D | null;
  /**
   * plan-774 F7 (optional): the reference node whose materialised content an
   * unresolved target (full address, or written path) points into — see
   * `NodeRegistry.placedContentOfTarget`.
   */
  placedContentOfTarget?(target: { address?: string; path?: string }, referrer: Object3D): Object3D | null;
}

/** One stored reference, as {@link forEachStoredReference} hands it out. */
export interface StoredReference {
  componentType: string;
  field: string;
  index?: number;
  subPath?: string;
  writtenPath: string;
  /** `ComponentReference.componentType`; `undefined` for a declared path-string field. */
  targetComponentType: string | undefined;
  /** `'reference'` = a `ComponentReference` object, `'pathField'` = a declared path string. */
  source: 'reference' | 'pathField';
  /**
   * plan-769 Phase 3: the stored form. `'path'` (absent = path) is judged by its file or
   * the path chain; an `'address'` / `'unresolved'` reference by its verdict alone
   * (`writtenPath` is then its label: the address / the kept path).
   */
  form?: 'path' | 'address' | 'unresolved';
  /** The value a reader hands `readStoredRef` (address / unresolved forms). */
  stored?: StoredReferenceValue;
}

// ─── Rules ──────────────────────────────────────────────────────────────

/**
 * Fields whose raw paths their component resolves LATER, against content that may not
 * exist at load: a complete miss there is not reported (a fallback hit still is).
 * Matched on the component's base type (`_N` dedup suffix stripped) and the top-level field.
 */
export const LATE_RESOLUTION_FIELDS: ReadonlyArray<{ readonly component: string; readonly field: string }> = Object.freeze([
  // Machining tools: `rv-machining-volume.ts` resolves unresolved path strings when the
  // tool registers (two-phase construction, `resolveComponentRefs` keeps the raw path).
  Object.freeze({ component: 'MachiningVolume', field: 'Tools' }),
]);

/** Component records never walked: their content is relative to ANOTHER asset. */
const SKIPPED_COMPONENTS: ReadonlySet<string> = new Set(['AssetOverrides']);

/** Lookup stages that are the path as written (see the module header). */
const REGULAR_STAGES: ReadonlySet<ReferenceLookupStage> = new Set<ReferenceLookupStage>(['exact', 'alias', 'space']);

/** `Kinematic_1` → `Kinematic`. */
function baseType(componentType: string): string {
  return componentType.replace(/_\d+$/, '');
}

function isLateField(componentType: string, field: string): boolean {
  const base = baseType(componentType);
  return LATE_RESOLUTION_FIELDS.some((e) => (e.component === componentType || e.component === base) && e.field === field);
}

// ─── Walk ───────────────────────────────────────────────────────────────

/** `subPath` segments → `a[1].b`. */
function joinSub(segs: readonly (string | number)[]): string | undefined {
  let out = '';
  for (const s of segs) out += typeof s === 'number' ? `[${s}]` : (out === '' ? s : `.${s}`);
  return out === '' ? undefined : out;
}

/**
 * Visit every stored reference of one node's rv extras: every `ComponentReference`
 * (deep) and every declared path-string field. Empty paths are skipped; records in
 * {@link SKIPPED_COMPONENTS} are not entered. Pure — no registry, usable on raw GLB JSON.
 */
export function forEachStoredReference(
  extras: Record<string, unknown> | null | undefined,
  visit: (ref: StoredReference) => void,
  pathFields: ReadonlyArray<PathFieldEntry> = PATH_FIELDS,
): void {
  // THE walk (plan-769 Phase 1, `visitReferences`): every ComponentReference at any
  // depth, then the declared path fields in table order — the audit's historic order.
  visitReferences(extras, (r) => {
    if (r.kind === 'name') return;
    const addressed = r.form !== 'path';
    const written = addressed ? storedReferenceLabel(r.value) : r.path;
    if (typeof written !== 'string' || written.trim() === '') return;
    const ref: StoredReference = {
      componentType: r.componentKey,
      field: r.field,
      writtenPath: written,
      targetComponentType: r.kind === 'ref' ? r.refComponentType : undefined,
      source: r.kind === 'ref' ? 'reference' : 'pathField',
    };
    if (addressed) {
      ref.form = r.form;
      const stored = storedReferenceValue(r.value);
      if (stored !== null) ref.stored = stored;
    }
    let rest: ReadonlyArray<string | number> = r.record ? [...r.trail, 'path'] : r.trail;
    if (typeof rest[0] === 'number') { ref.index = rest[0]; rest = rest.slice(1); }
    const sub = joinSub(rest);
    if (sub !== undefined) ref.subPath = sub;
    visit(ref);
  }, {
    pathFields,
    skipComponent: (key) => SKIPPED_COMPONENTS.has(key) || SKIPPED_COMPONENTS.has(baseType(key)),
    order: 'refs-first',
  });
}

/** Does `componentType.fieldName` of these extras hold at least one stored reference? */
export function fieldHoldsReference(
  extras: Record<string, unknown> | null | undefined,
  componentType: string,
  fieldName: string,
): boolean {
  if (!extras || typeof extras !== 'object') return false;
  const record = extras[componentType];
  if (!record || typeof record !== 'object') return false;
  let found = false;
  forEachStoredReference({ [componentType]: record }, (r) => { if (r.field === fieldName) found = true; });
  return found;
}

/**
 * Resolve one stored reference the way the audit judges it: the reference's own chain
 * first, then — for a typed miss — the plain node. `null` = no node answers at all.
 */
function resolveForAudit(
  registry: ReferenceAuditRegistry,
  ref: StoredReference,
  referrer: Object3D,
): StagedReferenceResolution | null {
  const query = { path: ref.writtenPath };
  const ct = ref.targetComponentType ?? '';
  const hit = registry.resolveWithStage(query, ct, referrer);
  if (hit || ct === '') return hit;
  return registry.resolveWithStage(query, '', referrer);
}

/**
 * Stages that are a full-path answer, not a guess — the probe of
 * {@link dedupSuffixExists} accepts only these. `sanitized` is a full-path match
 * after the ONE transform that maps the authored and the loader spelling onto the
 * same key (`NL6:501_1` → `NL6501_1`); it is needed because the old editor wrote
 * the loader's SANITIZED names while the reference kept the authored ones.
 * `suffix` and `name-in-scope` stay out: they guess.
 */
const PROBE_STAGES: ReadonlySet<ReferenceLookupStage> = new Set<ReferenceLookupStage>(['exact', 'alias', 'space', 'sanitized']);

/**
 * plan-765 F6: does a node answer the written path with a Three.js dedup suffix
 * `_1` … `_3` appended? Three lookups in the referrer's scope, nothing else — a
 * hint for the Problems entry, never a resolution: the reference stays unresolved.
 */
function dedupSuffixExists(registry: ReferenceAuditRegistry, ref: StoredReference, referrer: Object3D): boolean {
  const written = ref.writtenPath.trim();
  if (written === '' || written.endsWith('/')) return false;
  for (let n = 1; n <= 3; n++) {
    const hit = registry.resolveWithStage({ path: `${written}_${n}` }, '', referrer);
    if (hit && PROBE_STAGES.has(hit.stage)) return true;
  }
  return false;
}

/**
 * Audit every stored reference of the registered scene. One walk; no side effects on the
 * registry (quiet resolution, no warnings).
 */
export function auditReferences(
  registry: ReferenceAuditRegistry,
  opts?: { pathFields?: ReadonlyArray<PathFieldEntry> },
): ReferenceAuditResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const findings: ReferenceAuditFinding[] = [];
  const counts = { referrers: 0, references: 0, unresolved: 0, rescued: 0, lateSkipped: 0 };
  const pathFields = opts?.pathFields ?? PATH_FIELDS;

  const referrers: { path: string; node: Object3D; extras: Record<string, unknown> }[] = [];
  registry.forEachNode((path, node) => {
    if (registry.getPathForNode(node) !== path) return; // alias entry
    const extras = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!extras || typeof extras !== 'object') return;
    referrers.push({ path, node, extras });
  });

  for (const { path: referrerPath, node, extras } of referrers) {
    counts.referrers++;
    // plan-774 F7: only the OPEN document's own references can be told "baked
    // away" — a placed asset's own references are that asset's business.
    const owned = !!registry.placedContentOfTarget && !isInsideReference(node);
    const markBakedAway = (miss: ReferenceAuditFinding, target: { address?: string; path?: string }): void => {
      if (!owned) return;
      const placement = registry.placedContentOfTarget!(target, node);
      if (!placement) return;
      miss.bakedAwayIn = registry.getPathForNode(placement) ?? placement.name;
      if (target.address) miss.targetAddress = target.address;
    };
    forEachStoredReference(extras, (ref) => {
      counts.references++;
      // plan-769 Phase 3: an address-form reference has no path to chase — its id
      // resolves, waits for its placement, or it is unresolved (kept / orphaned by id).
      if (ref.form && ref.form !== 'path') {
        const read = ref.form === 'unresolved' || !ref.stored || !registry.readStoredRef
          ? null
          : registry.readStoredRef(node, ref.stored);
        const status = read ? read.status : 'unresolved';
        if (status === 'resolved' || status === 'pending') return;
        if (isRuntimeSignalLeaf(registry, ref, node, ref.stored)) return;
        if (isLateField(ref.componentType, ref.field)) { counts.lateSkipped++; return; }
        counts.unresolved++;
        const miss: ReferenceAuditFinding = {
          kind: 'unresolved', referrerPath, componentType: ref.componentType, field: ref.field, writtenPath: ref.writtenPath,
        };
        if (ref.index !== undefined) miss.index = ref.index;
        if (ref.subPath !== undefined) miss.subPath = ref.subPath;
        if (ref.targetComponentType) miss.targetComponentType = ref.targetComponentType;
        if (read?.address) markBakedAway(miss, { address: read.address });
        findings.push(miss);
        return;
      }
      // plan-769 Phase 1b: a reference the FILE carries is judged by its file —
      // resolved by address / migration, or unresolved. Ambiguous and generated
      // targets are the migration's own problems (`reference-ambiguous`,
      // `reference-target-synthetic`), a pending one is not decided yet.
      const stored = registry.auditStoredReference?.({ path: ref.writtenPath }, ref.targetComponentType ?? '', node);
      const fileVerdict = stored?.verdict === 'file' ? stored : null;
      if (fileVerdict && (fileVerdict.hit || fileVerdict.reason !== 'missing')) return;
      if (fileVerdict && isRuntimeSignalLeaf(registry, ref, node, { path: ref.writtenPath })) return;
      const hit = fileVerdict ? null : resolveForAudit(registry, ref, node);
      const base: ReferenceAuditFinding = {
        kind: 'unresolved',
        referrerPath,
        componentType: ref.componentType,
        field: ref.field,
        writtenPath: ref.writtenPath,
      };
      if (ref.index !== undefined) base.index = ref.index;
      if (ref.subPath !== undefined) base.subPath = ref.subPath;
      if (ref.targetComponentType) base.targetComponentType = ref.targetComponentType;
      if (!hit) {
        if (isLateField(ref.componentType, ref.field)) { counts.lateSkipped++; return; }
        counts.unresolved++;
        if (dedupSuffixExists(registry, ref, node)) base.dedupSuffixExists = true;
        markBakedAway(base, fileVerdict?.address ? { address: fileVerdict.address } : { path: ref.writtenPath });
        findings.push(base);
        return;
      }
      if (REGULAR_STAGES.has(hit.stage)) return;
      const resolvedPath = registry.getPathForNode(hit.node);
      counts.rescued++;
      findings.push({ ...base, kind: 'rescued', resolvedPath: resolvedPath ?? undefined, stage: hit.stage });
    }, pathFields);
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { findings, counts, ms: t1 - t0 };
}

/** A signal ref bound to an FMU runtime leaf is no miss. */
function isRuntimeSignalLeaf(registry: ReferenceAuditRegistry, ref: StoredReference, node: Object3D, stored: unknown): boolean {
  return /Signal|PLC/.test(ref.targetComponentType ?? '') && !!registry.runtimeSignalLeafFor?.(node, stored);
}

/** `Drive_Cylinder.IsIn`, `Connections.connections[2].source` — the field as the Problems panel names it. */
export function describeReferenceLocation(f: Pick<ReferenceAuditFinding, 'componentType' | 'field' | 'index' | 'subPath'>): string {
  let s = `${f.componentType}.${f.field}`;
  if (f.index !== undefined) s += `[${f.index}]`;
  if (f.subPath) s += f.subPath.startsWith('[') ? f.subPath : `.${f.subPath}`;
  return s;
}

// ─── Kinematic groups reaching into placed content (plan-774 F7) ────────

/** One `Kinematic` of the open document whose integrated group has members in placed content. */
export interface KinematicPlacedMemberFinding {
  /** Canonical registry path of the node carrying the `Kinematic`. */
  kinematicPath: string;
  /** Resolved group name (`GroupNamePrefix` node name + `GroupName`). */
  groupName: string;
  /** Members of that group inside placed content. */
  memberCount: number;
  /** Registry paths of the OUTERMOST placed reference nodes those members lie in. */
  placementPaths: string[];
}

/** The registry surface {@link auditKinematicGroupsInPlacedContent} needs. */
export interface KinematicAuditRegistry {
  forEachNode(callback: (path: string, node: Object3D) => void): void;
  getPathForNode(node: Object3D): string | null;
  getNode(path: string): Object3D | null | undefined;
}

const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;

/**
 * plan-774 F7: every `Kinematic` of the OPEN document (owned content) with
 * `IntegrateGroupEnable` whose group — as the viewer's `GroupRegistry` holds it
 * after the placements merged theirs in by name — has members inside a placed
 * reference. Those members belong to an asset that is baked on its own; they are
 * never re-parented under this axis and do not move with it. Only members the
 * open document assigned to the group count (an override on their `Group`); a
 * group the placed asset declares itself under the same name is the asset's own
 * (review round 2, R1). Pure; no reporting.
 */
export function auditKinematicGroupsInPlacedContent(
  registry: KinematicAuditRegistry,
  groups: { get(name: string): { nodes: readonly Object3D[] } | undefined } | null | undefined,
): KinematicPlacedMemberFinding[] {
  const out: KinematicPlacedMemberFinding[] = [];
  if (!groups) return out;
  registry.forEachNode((path, node) => {
    if (registry.getPathForNode(node) !== path) return; // alias entry
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv || typeof rv !== 'object') return;
    for (const key of Object.keys(rv)) {
      if (!KINEMATIC_KEY_RE.test(key)) continue;
      const data = rv[key] as Record<string, unknown> | undefined;
      if (!data || typeof data !== 'object' || data['IntegrateGroupEnable'] !== true) continue;
      // The ONE group-name rule of the live scene (`resolveGroupName`): a
      // disabled Kinematic (`_enabled: false`) and an empty name yield null.
      const resolved = resolveGroupName(data, { getNode: (p) => registry.getNode(p) ?? null });
      if (!resolved) continue;
      if (isInsideReference(node)) return; // a placed asset's own kinematic: its asset's business
      const members = groups.get(resolved)?.nodes ?? [];
      const placements = new Set<string>();
      let memberCount = 0;
      for (const member of members) {
        const outermost = outermostReference(member);
        if (!outermost) continue;
        // Review round 2 (R1): the registry merges groups by NAME, so a placed
        // asset declaring its own group of the same name lands here too — that
        // is the asset's business, not this axis'. Only a membership THIS
        // document assigned (an override on the member's Group) is reported.
        if (!groupAssignedByDocument(member, resolved, registry)) continue;
        memberCount++;
        placements.add(registry.getPathForNode(outermost) ?? outermost.name);
      }
      if (memberCount > 0) out.push({ kinematicPath: path, groupName: resolved, memberCount, placementPaths: [...placements] });
    }
  });
  return out;
}

/**
 * Did the OPEN document put `member` (placed content) into group `name`?
 *
 * True iff one of its live `Group*` components resolves to `name` while the
 * asset's own value of that component — the live data with every field the open
 * file overrode put back to its recorded base (`_rvOverrideBase`; `has: false` =
 * the asset did not set it) — does not. A member without such a component (a
 * Group partition object, a node the asset's own bake registered) is the asset's
 * own membership.
 */
function groupAssignedByDocument(member: Object3D, name: string, registry: KinematicAuditRegistry): boolean {
  const rv = member.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv || typeof rv !== 'object') return false;
  const bases = member.userData?.[RV_OVERRIDE_BASE_KEY] as Record<string, Record<string, OverrideBase>> | undefined;
  const lookup = { getNode: (p: string) => registry.getNode(p) ?? null };
  for (const key of Object.keys(rv)) {
    if (!GROUP_KEY_RE.test(key)) continue;
    const data = rv[key] as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') continue;
    if (resolveGroupName(data, lookup) !== name) continue;
    const base = bases?.[key];
    if (!base) continue; // nothing of it overridden: the asset's own assignment
    const own: Record<string, unknown> = { ...data };
    for (const [field, b] of Object.entries(base)) {
      if (b.has) own[field] = b.value; else delete own[field];
    }
    if (resolveGroupName(own, lookup) !== name) return true;
  }
  return false;
}

// ─── Written-reference count (plan-765 F5) ──────────────────────────────

/** What {@link countWrittenReferences} measured over one tree. */
export interface WrittenReferenceCounts {
  /** Non-empty stored references looked at. */
  references: number;
  /** References whose path names no node of the tree (late-resolution misses excluded). */
  unresolved: number;
  /** `unresolved` per `Component.field` — the key form of `SurvivalCounts.unresolvedByField`. */
  byField: Record<string, number>;
  /** Paths claimed by more than one distinct node (true sibling duplicates). */
  ambiguousPaths: number;
}

/** The resolver's normalisation (`rv-reference-resolver.ts`): trim, no leading `/`, no `//`. */
function normalizeWrittenPath(path: string): string {
  let p = path.trim();
  while (p.startsWith('/')) p = p.slice(1);
  return p.replace(/\/{2,}/g, '/');
}

/**
 * Count the stored references of a tree against the node names a caller chooses —
 * pure, no registry, exact paths only (plan-765 F5, the save guard).
 *
 * The save measures what the serialization loses by running this twice inside one
 * save: over the LIVE tree spelled in authored names (`_rvOrigName ?? name`), with
 * the export's prune predicate as `skip`, and over the export CLONE (after the
 * authored-name restore and both prunes) spelled in its written names. Same
 * iterator ({@link forEachStoredReference}), same late-field rule as the audit,
 * same node set on both sides — so a difference is the file, never an edit.
 *
 * A reference resolves iff its normalised path is a node path of the tree
 * (asset-relative, root = `''`), as written or — the Unity form — with a leading
 * segment equal to the root's own name stripped. No suffix, sanitize or name
 * fallback: a count that guessed would hide exactly the loss it exists to show.
 *
 * `skip(n)` prunes `n` with its whole subtree; it is never asked for the root.
 * Iterative (no recursion depth limit on deep CAD trees); tolerates a node
 * without a `children` array.
 */
export function countWrittenReferences(
  root: Object3D,
  pathOf: (n: Object3D) => string,
  skip?: (n: Object3D) => boolean,
  pathFields: ReadonlyArray<PathFieldEntry> = PATH_FIELDS,
): WrittenReferenceCounts {
  const counts: WrittenReferenceCounts = { references: 0, unresolved: 0, byField: {}, ambiguousPaths: 0 };
  const nodesAtPath = new Map<string, number>();
  const referrers: Record<string, unknown>[] = [];

  const visit = (node: Object3D, path: string): void => {
    const seen = nodesAtPath.get(path) ?? 0;
    if (seen === 1) counts.ambiguousPaths++;
    nodesAtPath.set(path, seen + 1);
    const extras = (node.userData as Record<string, unknown> | undefined)?.realvirtual;
    if (extras && typeof extras === 'object') referrers.push(extras as Record<string, unknown>);
  };
  visit(root, '');
  const stack: Array<{ node: Object3D; path: string }> = [];
  const pushChildren = (node: Object3D, path: string): void => {
    const kids = (node as { children?: unknown }).children;
    if (!Array.isArray(kids)) return;
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i] as Object3D;
      const seg = pathOf(kid);
      stack.push({ node: kid, path: path === '' ? seg : `${path}/${seg}` });
    }
  };
  pushChildren(root, '');
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (skip?.(node)) continue;
    visit(node, path);
    pushChildren(node, path);
  }

  const rootName = pathOf(root);
  const resolves = (written: string): boolean => {
    const p = normalizeWrittenPath(written);
    if (nodesAtPath.has(p)) return true;
    if (rootName === '') return false;
    if (p === rootName) return true;
    return p.startsWith(`${rootName}/`) && nodesAtPath.has(p.slice(rootName.length + 1));
  };

  for (const extras of referrers) {
    forEachStoredReference(extras, (ref) => {
      // plan-769 Phase 3: an address does not live in the name space this guard measures.
      if (ref.form && ref.form !== 'path') return;
      counts.references++;
      if (resolves(ref.writtenPath)) return;
      if (isLateField(ref.componentType, ref.field)) return;
      counts.unresolved++;
      const key = `${ref.componentType}.${ref.field}`;
      counts.byField[key] = (counts.byField[key] ?? 0) + 1;
    }, pathFields);
  }
  return counts;
}
