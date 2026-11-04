// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Stored form of a declared path-string field (documentation only — the walker handles all alike). */
export type PathFieldShape = 'path' | 'pathArray' | 'deep';

export interface PathFieldEntry {
  /** rv extras key of the component (`_N` dedup keys fall back to the base type). */
  readonly component: string;
  /** Field; a dotted name walks into records / arrays of records (`connections.source`). */
  readonly field: string;
  readonly shape: PathFieldShape;
}

export interface NameFieldEntry {
  readonly component: string;
  /** Top-level field holding a node NAME (not a path). */
  readonly field: string;
}

export const PATH_FIELDS: ReadonlyArray<PathFieldEntry>;
export const NAME_FIELDS: ReadonlyArray<NameFieldEntry>;

/**
 * A raw rv-ODT `ComponentReference` in any stored form (plan-769 Phase 3): `path`
 * (Unity / written this session), `address` (`#id`, `p#id`, `p/b#id`) or
 * `unresolvedPath` + `reason` (kept, never guessed). Read the form through
 * {@link storedReferenceForm}; `path` is absent on the two newer forms.
 */
export interface RawComponentReference {
  type: 'ComponentReference';
  path?: string;
  address?: string;
  unresolvedPath?: string;
  reason?: StoredUnresolvedReason;
  componentType?: string;
  componentIndex?: number;
  [key: string]: unknown;
}

/** Why a stored reference is kept as `unresolvedPath` (F4). */
export type StoredUnresolvedReason = 'missing' | 'ambiguous' | 'synthetic-target';

/** The stored form of one reference value ({@link storedReferenceForm}). */
export type StoredReferenceForm =
  | { form: 'path'; path: string }
  | { form: 'address'; address: string }
  | { form: 'unresolved'; unresolvedPath: string; reason: StoredUnresolvedReason };

/** The value a reader hands `readStoredRef`: a path string, `{ address }` or `{ unresolvedPath, reason }`. */
export type StoredReferenceValue =
  | string
  | { address: string }
  | { unresolvedPath: string; reason: StoredUnresolvedReason };

export function storedReferenceForm(v: unknown): StoredReferenceForm | null;
export function storedReferenceValue(v: unknown): StoredReferenceValue | null;
export function storedReferenceLabel(v: unknown): string | null;

/** Spelling a reference was written in. An unscoped path is `'relative'` with scope root `''`. */
export type ReferenceSpelling = 'relative' | 'root-prefixed';

/** The lookup stage that actually hit — kept separate from the spelling. */
export type ReferenceLookupStage = 'exact' | 'alias' | 'space' | 'suffix' | 'sanitized' | 'name-in-scope';

export function isComponentReference(v: unknown): v is RawComponentReference;
export function matchesPrefix(path: string, oldPath: string): boolean;
/** Written tail (minus the head for `'root-prefixed'`) equals the last segments of `canonical`. */
export function writtenTailMatches(writtenPath: string, canonical: string, spelling: ReferenceSpelling): boolean;
export function respell(
  writtenPath: string,
  oldCanonical: string,
  newCanonical: string,
  spelling: ReferenceSpelling,
  scopeRootPath?: string,
): string | null;

export interface ReferenceRewriteReferrer {
  /** Canonical path of the referrer in the state BEFORE the change. */
  nodePath: string;
  /** The node's `userData.realvirtual` (component key → record). Never mutated. */
  extras: Record<string, unknown> | null | undefined;
}

export interface ResolveOldQuery {
  /** The path exactly as written. */
  path: string;
  /** Target component type of a ComponentReference; `undefined` for a path-string field. */
  componentType: string | undefined;
  /** Canonical (pre-change) path of the referrer — the caller derives the authoring scope. */
  referrerPath: string;
}

export interface ResolveOldHit {
  /** Canonical path of the target in the state BEFORE the change. */
  canonical: string;
  spelling: ReferenceSpelling;
  /** Lookup stage that hit; absent = `'exact'`. Anything else is healed onto the exact new path. */
  stage?: ReferenceLookupStage;
  /**
   * Canonical path of the authoring scope root (`''` = unscoped). Required to heal a
   * fallback hit; for an exact hit it is derived from the written spelling when absent.
   */
  scopeRootPath?: string;
  /**
   * The target's pre-change path in AUTHORED names (`_rvOrigName ?? name` per segment),
   * when it differs from `canonical` (plan-765 F2b). Used only with
   * {@link ReferenceRewriteInput.authoredMoves}.
   */
  authoredCanonical?: string;
}

export interface ResolveNameQuery {
  name: string;
  componentType: string;
  field: string;
  referrerPath: string;
}

export interface ResolveNameHit {
  /** Canonical path of the uniquely named target, `null` when ambiguous. */
  canonical: string | null;
  /** True when the name matches more than one node in the lookup scope. */
  ambiguous?: boolean;
}

export interface ReferenceRewriteInput {
  referrers: Iterable<ReferenceRewriteReferrer>;
  /** Old canonical → new canonical. Entries for subtree roots suffice; descendants map by prefix. */
  moves: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /**
   * The same change in AUTHORED names (plan-765 F2b): old authored path → new authored
   * path, prefix-mapped like `moves`. A fallback hit whose written tail equals the
   * target's {@link ResolveOldHit.authoredCanonical} is rewritten through it, in that
   * spelling, instead of being healed onto the current names. Only consulted for a node
   * `moves` already maps.
   */
  authoredMoves?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  resolveOld(query: ResolveOldQuery): ResolveOldHit | null;
  /** Resolver for {@link NAME_FIELDS}; without it a name field naming a renamed node is a warning. */
  resolveName?(query: ResolveNameQuery): ResolveNameHit | null;
  /** True for a referrer inside foreign (referenced) content — skipped entirely. */
  isForeign?(referrerPath: string): boolean;
  /** Override the field tables (tests). */
  pathFields?: ReadonlyArray<PathFieldEntry>;
  nameFields?: ReadonlyArray<NameFieldEntry>;
}

export interface ReferenceRewriteStep {
  /** POST-change path of the referrer — where the `setField` addresses it. */
  nodePath: string;
  /** PRE-change path of the referrer. */
  oldNodePath: string;
  /** rv extras key of the component. */
  componentType: string;
  /** Top-level field key. */
  field: string;
  /** Complete new field value (all hits in this field merged). */
  value: unknown;
  /** Previous field value (the very same object as in the input extras). */
  prev: unknown;
}

export type ReferenceRewriteWarningCode =
  | 'reference-heal-needs-scope'
  | 'reference-left-scope'
  | 'name-field-ambiguous'
  | 'name-field-unchecked';

export interface ReferenceRewriteWarning {
  code: ReferenceRewriteWarningCode;
  nodePath: string;
  componentType: string;
  field: string;
  /** The written path / name concerned. */
  path: string;
  message: string;
}

export interface ReferenceRewriteCounts {
  referrers: number;
  skippedForeign: number;
  referencesSeen: number;
  referencesRewritten: number;
  /** Subset of `referencesRewritten` that resolved only by a fallback stage. */
  referencesHealed: number;
  unresolved: number;
  nameFieldsRewritten: number;
}

export interface ReferenceRewritePlan {
  steps: ReferenceRewriteStep[];
  nameSteps: ReferenceRewriteStep[];
  warnings: ReferenceRewriteWarning[];
  counts: ReferenceRewriteCounts;
}

export function planReferenceRewrite(input: ReferenceRewriteInput): ReferenceRewritePlan;

/** Kind of a stored reference position (plan-769 {@link visitReferences}). */
export type VisitedReferenceKind = 'ref' | 'path' | 'name';

/** One stored reference position, as {@link visitReferences} hands it out. */
export interface VisitedReference {
  /** rv extras key of the component (`Kinematic_1`). */
  componentKey: string;
  /** Top-level field key of that component. */
  field: string;
  /** Location below `field`: array indices as numbers, record keys as strings. */
  trail: ReadonlyArray<string | number>;
  kind: VisitedReferenceKind;
  /**
   * The written path (`ref` / `path`) or node name (`name`) — empty strings included.
   * `''` for the address / kept forms (plan-769 Phase 3): read `form` first.
   */
  path: string;
  /** Stored form of the position (plan-769 Phase 3); `'path'` for every Unity export. */
  form: 'path' | 'address' | 'unresolved';
  /** The stored address (`form: 'address'`). */
  address?: string;
  /** The kept path and its reason (`form: 'unresolved'`). */
  unresolvedPath?: string;
  reason?: StoredUnresolvedReason;
  /** `ComponentReference.componentType` of a `ref`, when it carries one. */
  refComponentType?: string;
  /** Dotted table entry (`steps.targetObjects`) of a `path` / `name` position. */
  declared?: string;
  /** True for a legacy `{ path }` record in a path field (`value` is the record). */
  record?: true;
  /** The value at the position (the reference object, the record or the string). */
  value: unknown;
  /** Replace the value at this position in place. */
  set(next: unknown): void;
}

export interface VisitReferencesOptions {
  pathFields?: ReadonlyArray<PathFieldEntry>;
  nameFields?: ReadonlyArray<NameFieldEntry>;
  /** Component records not entered (e.g. `AssetOverrides` — relative to another asset). */
  skipComponent?(componentKey: string): boolean;
  /**
   * `'by-key'` (default): per top-level key, its references, then its declared path
   * fields. `'refs-first'`: every key's references, then the declared path fields in
   * table order (the reference audit's historic order). Name fields always come last.
   */
  order?: 'by-key' | 'refs-first';
}

/** THE walk over every stored reference position of one extras bag (plan-769 F1). */
export function visitReferences(
  extras: Record<string, unknown> | null | undefined,
  visit: (ref: VisitedReference) => void,
  opts?: VisitReferencesOptions,
): void;
