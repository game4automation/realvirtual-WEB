// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * problems-store — the one list of things wrong with the OPEN DOCUMENT
 * (plan-703 Phase 8, §2.8, F16).
 *
 * ## Not the ErrorStore, and the difference is the lifetime
 *
 * `engine/rv-error-store.ts` holds *machine* alarms: an entry is active exactly
 * while a PLC signal is high, it clears itself, and it is emptied on every model
 * switch. A problem here is the opposite in all three respects — it is a
 * statement about the file the user has open ("this reference points at nothing"),
 * it does not go away on its own, and it is only ever resolved by the user
 * changing the project. Folding the two together would mean a missing asset
 * competing for attention with a jammed conveyor, and one of them going quiet
 * the moment a signal dropped.
 *
 * ## Every entry says what was looked for
 *
 * F16 is explicit that a placeholder without a findable cause does not satisfy
 * it. So {@link ProblemEntry.detail} is not a free-text field a caller may leave
 * empty: for a missing reference it names the `assetId` and, when the reference
 * carried one, the `path`. That is the only information the user can act on —
 * it is what they would type into the tree's search box.
 *
 * ## Keyed by `id`, replaced not appended
 *
 * A composition runs again on every reload, and a reload of an unfixed project
 * must not double the list. The id of a missing-reference problem is its
 * occurrence chain, which is stable across reloads by construction (that is what
 * `rv-node-id.ts` builds it for), so re-reporting overwrites.
 *
 * ## React-free on purpose
 *
 * The reporter is `rv-scene-loader.ts`, which is core-bundle code. A
 * `useSyncExternalStore` import here would drag React in behind it — the same
 * mistake Phase 1 made with the asset executor. The hook lives in
 * `ProblemsPanel.tsx`, where React already is.
 */

export type ProblemSeverity = 'error' | 'warning' | 'info';

/** One actionable statement about the open document. */
export interface ProblemEntry {
  /** Stable across reloads — re-reporting the same problem replaces it. */
  id: string;
  severity: ProblemSeverity;
  /** Machine-readable kind, for grouping and for tests. */
  code: 'missing-reference' | 'duplicate-asset-id' | string;
  /** One line, the headline. */
  title: string;
  /** What was looked for / what the user can act on. Never empty (F16). */
  detail: string;
  /** Node path of the offending node, when there is one. */
  nodePath?: string;
  /**
   * The ONE repair this problem offers, as a command (plan-589 §2.7).
   *
   * A command id and its arguments rather than a callback: the store is React-free and serialisable,
   * the rule lives in the command (so the MCP tool and a button are the same verb, plan-499), and a
   * problem re-reported by a later run cannot leave a stale closure behind. `ProblemsPanel` renders
   * it as a button and dispatches it; no entry is obliged to carry one.
   */
  action?: { label: string; commandId: string; args: unknown };
  /**
   * Not news (plan-628 8.11g): the panel does not open by itself for this entry;
   * it is listed and counted as usual. For live findings whose marker already
   * sits in the 3D view (path-network info / warning).
   */
  quiet?: boolean;
  /** When it was reported (ms epoch), so the panel can order stably. */
  at: number;
}

/** What a caller hands in; `at` is stamped here so two callers cannot disagree. */
export type ProblemInput = Omit<ProblemEntry, 'at'> & { at?: number };

const _entries = new Map<string, ProblemEntry>();
const _listeners = new Set<() => void>();
let _snapshot: ProblemEntry[] = [];
let _dirty = true;

function notify(): void {
  _dirty = true;
  for (const l of _listeners) {
    try { l(); } catch { /* a subscriber must never break the reporter */ }
  }
}

/** Are two problem actions the same offer? Compared by value, arguments included. */
function sameAction(a: ProblemEntry['action'], b: ProblemEntry['action']): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.label !== b.label || a.commandId !== b.commandId) return false;
  try {
    return JSON.stringify(a.args) === JSON.stringify(b.args);
  } catch {
    return a.args === b.args;
  }
}

/** Report (or re-report) one problem. Same `id` replaces, never appends. */
export function reportProblem(input: ProblemInput): ProblemEntry {
  const entry: ProblemEntry = { ...input, at: input.at ?? Date.now() };
  const previous = _entries.get(entry.id);
  _entries.set(entry.id, entry);
  // A no-op re-report (identical everything but the timestamp) must not wake
  // React: composition re-runs on every reload of an unchanged, unfixed project.
  if (previous
    && previous.severity === entry.severity
    && previous.code === entry.code
    && previous.title === entry.title
    && previous.detail === entry.detail
    && previous.nodePath === entry.nodePath
    && previous.quiet === entry.quiet
    // The action is part of the content: same headline, different argument list (the names a
    // repair would act on) is a changed entry, and the button must follow it.
    && sameAction(previous.action, entry.action)) {
    _entries.set(entry.id, previous);
    return previous;
  }
  notify();
  return entry;
}

/** The current entry of one problem id, `undefined` when none is reported. */
export function getProblem(id: string): ProblemEntry | undefined {
  return _entries.get(id);
}

/** Drop one problem by id. No-op when unknown. */
export function clearProblem(id: string): void {
  if (!_entries.delete(id)) return;
  notify();
}

/**
 * Drop every problem of one `code`.
 *
 * The reload idiom: a fresh composition clears `missing-reference` and reports
 * what it found, so a reference the user just fixed leaves the list without
 * anyone having to remember which id it had.
 */
export function clearProblemsOfCode(code: string): void {
  let removed = false;
  for (const [id, entry] of _entries) {
    if (entry.code !== code) continue;
    _entries.delete(id);
    removed = true;
  }
  if (removed) notify();
}

export function clearAllProblems(): void {
  if (_entries.size === 0) return;
  _entries.clear();
  notify();
}

/** Stable snapshot for `useSyncExternalStore` — same array until something changes. */
export function getProblems(): ProblemEntry[] {
  if (_dirty) {
    _snapshot = Array.from(_entries.values()).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    _dirty = false;
  }
  return _snapshot;
}

export function subscribeProblems(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

// ─── Summary line (plan-778 §2.7) ───────────────────────────────────────
// One short line ("2 libraries unavailable — Show") for problems that are
// `quiet` on purpose: the panel must not pop open over a project that just
// opened, but the user should still learn, once, that something is missing.
// One announcement at a time; the panel renders it and "Show" opens the panel
// filtered to the announcement's `code`.

/** A one-line summary of quiet problems, with the code the panel filters to on "Show". */
export interface ProblemsAnnouncement {
  /** Identity — re-announcing the same key with the same text is a no-op. */
  key: string;
  message: string;
  /** The problem `code` "Show" filters the panel to. */
  code: string;
  /** Per announcement; dismissals key on it. */
  readonly seq?: number;
}

let _announcement: ProblemsAnnouncement | null = null;
let _announcementSeq = 0;
const _announcementListeners = new Set<() => void>();

function notifyAnnouncement(): void {
  for (const l of _announcementListeners) {
    try { l(); } catch { /* a subscriber must never break the reporter */ }
  }
}

/** Put up (or replace) the summary line. */
export function announceProblems(a: ProblemsAnnouncement): void {
  if (_announcement && _announcement.key === a.key && _announcement.message === a.message && _announcement.code === a.code) return;
  _announcement = { ...a, seq: ++_announcementSeq };
  notifyAnnouncement();
}

/** Take the summary line down — only when it is still the one with `key` (null = any). */
export function withdrawProblemsAnnouncement(key: string | null = null): void {
  if (!_announcement) return;
  if (key !== null && _announcement.key !== key) return;
  _announcement = null;
  notifyAnnouncement();
}

/** Stable snapshot for `useSyncExternalStore`. */
export function getProblemsAnnouncement(): ProblemsAnnouncement | null { return _announcement; }

export function subscribeProblemsAnnouncement(listener: () => void): () => void {
  _announcementListeners.add(listener);
  return () => { _announcementListeners.delete(listener); };
}

// ─── Open document ──────────────────────────────────────────────────────
// Which document the list is about. Set by the viewer when a load STARTS, so it
// is already current while that load reports. The panel keys the user's "close"
// on it: closed for one model stays closed for that model, not for the next one.

let _documentKey: string | null = null;
const _documentListeners = new Set<() => void>();

export function setProblemsDocument(key: string | null): void {
  if (_documentKey === key) return;
  _documentKey = key;
  for (const l of _documentListeners) {
    try { l(); } catch { /* a subscriber must never break the loader */ }
  }
}

export function getProblemsDocument(): string | null { return _documentKey; }

export function subscribeProblemsDocument(listener: () => void): () => void {
  _documentListeners.add(listener);
  return () => { _documentListeners.delete(listener); };
}

// ─── Missing references ─────────────────────────────────────────────────

/** The subset of `MissingReference` this store needs — no `Object3D` import. */
export interface MissingReferenceReport {
  assetId: string;
  path?: string | undefined;
  occurrence: string;
  label: string;
  nodePath?: string | undefined;
  /**
   * Why the asset could not be brought in, when the failure was a LOAD and
   * not a lookup — the message of the error the loader / bake threw. A
   * reference that resolved to a url and then failed to decode is a
   * different repair (bytes, cache, network) from one nobody could find,
   * and the panel must not call the first one "not found".
   */
  reason?: string | undefined;
}

/**
 * The one-line, human-readable form of a thrown load error for a Problems
 * entry. The stack stays in the console; the panel gets the message.
 */
export function describeLoadError(err: unknown): string {
  const raw = err instanceof Error ? (err.message || err.name) : String(err ?? '');
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return 'unknown error';
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

/** The problem id of a missing reference — its occurrence chain, verbatim. */
export function missingReferenceProblemId(occurrence: string): string {
  return `missing-reference:${occurrence}`;
}

/**
 * "What was looked for", spelled out (F16).
 *
 * Both keys when both exist, because they fail independently: an `assetId` that
 * no manifest row claims is a different repair (re-import, or fix the id) from a
 * `path` that points outside the project (move the file back, or re-place it).
 * A message that named only one would send the user to fix the wrong thing.
 */
export function missingReferenceDetail(ref: { assetId?: string; path?: string }): string {
  const parts: string[] = [];
  const id = (ref.assetId ?? '').trim();
  const path = (ref.path ?? '').trim();
  if (id) parts.push(`assetId "${id}"`);
  if (path) parts.push(`path "${path}"`);
  if (parts.length === 0) return 'Searched for: nothing — the reference carries neither an assetId nor a path.';
  return `Searched for: ${parts.join(' and ')}.`;
}

/**
 * Replace the missing-reference problems with exactly what this composition found.
 *
 * **Retire-then-report, not clear-then-report.** The obvious implementation —
 * `clearProblemsOfCode` followed by a loop — notifies twice for a list that did
 * not change, which is the normal case: composition runs again on every reload,
 * and a project the user has not fixed reports the identical set. Two
 * notifications per reload mean a fresh snapshot array, which means React
 * re-renders the panel for nothing. So: drop only the ids this composition did
 * NOT report, then let {@link reportProblem}'s own dirty-check absorb the rest.
 */
export function reportMissingReferences(missing: readonly MissingReferenceReport[]): void {
  const wanted = new Set(missing.map(m => missingReferenceProblemId(m.occurrence)));
  for (const [id, entry] of [..._entries]) {
    if (entry.code !== 'missing-reference' || wanted.has(id)) continue;
    _entries.delete(id);
    notify();
  }
  for (const m of missing) reportMissingReference(m);
}

/**
 * Report ONE missing reference, additively (plan-753: a deferred planner
 * placement whose asset the planner could not load, reported after the
 * loader's own list). The next composition retires it like any other entry.
 */
export function reportMissingReference(m: MissingReferenceReport): void {
  const reason = (m.reason ?? '').trim();
  reportProblem({
    id: missingReferenceProblemId(m.occurrence),
    severity: 'error',
    code: 'missing-reference',
    title: reason
      ? `Referenced asset could not be loaded: ${m.label}`
      : `Referenced asset not found: ${m.label}`,
    detail: reason
      ? `${missingReferenceDetail(m)} Load failed: ${reason}`
      : missingReferenceDetail(m),
    nodePath: m.nodePath,
  });
}

// ─── Gated placed logic (plan-757 F6) ───────────────────────────────────

/** What a placement whose OWN signature gates its logic reports. */
export interface LogicGatedReport {
  /** Registry path of the placement root — the problem id. */
  nodePath: string;
  label: string;
  assetId: string;
  /** The asset's own verdict (`BakedAsset.signatureState`). */
  signatureState: string;
  /** The document's verdict the asset was weighed against. */
  documentState: string;
}

/** The problem id of a gated placement — its root path, verbatim. */
export function logicGatedProblemId(nodePath: string): string {
  return `logic-gated:${nodePath}`;
}

/**
 * Report ONE placement whose logic is held back by the trust gate (plan-757
 * F6, D8): its components exist and its geometry renders, but neither `init()`
 * nor its LogicSteps run — the same treatment a composed frame gets when it is
 * less trusted than the scene. Re-reporting the same root replaces.
 */
export function reportLogicGated(m: LogicGatedReport): void {
  reportProblem({
    id: logicGatedProblemId(m.nodePath),
    severity: 'warning',
    code: 'logic-gated',
    title: `Logic of placed asset disabled: ${m.label}`,
    detail: `The asset "${m.assetId}" is ${m.signatureState === 'none' ? 'unsigned' : m.signatureState}`
      + ` while the document is ${m.documentState}; its drives and sequences are constructed but held.`
      + ' Reload with untrusted logic allowed, or place a signed copy of the asset.',
    nodePath: m.nodePath,
  });
}

/** Drop every gated-logic problem — the document changed. */
export function clearLogicGatedProblems(): void {
  clearProblemsOfCode('logic-gated');
  clearProblemsOfCode('logic-instant-loop');
}

// ─── Orphaned asset overrides (plan-757 F9 / D13) ───────────────────────

/**
 * One `AssetOverrides` entry whose target does not exist in the baked asset —
 * a part that was merged away, renamed, or never existed. Reported wherever
 * overrides are applied (the placement instance and the composed frame alike),
 * never dropped with a console line.
 */
export interface OverrideOrphanedReport {
  /** Registry path of the reference / placement node the override sits on — part of the id. */
  nodePath: string;
  label: string;
  assetId: string;
  /** How the override addressed its target (`OrphanedOverride.addressing`). */
  addressing: 'address' | 'path';
  /** The address (`#<id>`) or the legacy relative path that did not resolve. */
  key: string;
  /** Component types the override would have touched. */
  componentTypes: readonly string[];
  /**
   * WHY the override orphaned when it is more than "no such node" (plan-769 4b):
   * `'ambiguous'` — the id names two nodes of the asset, none is guessed;
   * `'missing'` — it is aimed into a nested placement that never materialised
   * (the verdict falls once no placement is pending);
   * `'placement-missing'` / `'placement-cap'` / `'placement-refused'` — that
   * nested placement failed to load, was cut by the per-load cap, or was refused
   * (cycle / depth). Overrides into nested placements are routed since 4b; the
   * plan-757 `'nested-reference'` refusal is gone.
   */
  reason?: 'ambiguous' | 'missing' | 'placement-missing' | 'placement-cap' | 'placement-refused';
}

/** The problem id of an orphaned override — one per (node, addressing, key), so a re-apply replaces. */
export function overrideOrphanedProblemId(nodePath: string, addressing: string, key: string): string {
  return `override-orphaned:${nodePath}:${addressing}:${key}`;
}

/** Report ONE orphaned override. Re-reporting the same triple replaces. */
export function reportOverrideOrphaned(m: OverrideOrphanedReport): void {
  const what = m.addressing === 'path'
    ? `The override target "${m.key}" (path relative to the asset)`
    : `The override target "${m.key}" (address in the asset)`;
  const fields = m.componentTypes.length > 0 ? ` for ${m.componentTypes.join(', ')}` : '';
  const why: Record<NonNullable<OverrideOrphanedReport['reason']>, string> = {
    ambiguous: `${what}${fields} names more than one node in "${m.assetId}" — none is guessed, the override is not `
      + 'applied. Make the ids in the asset unique, or revert the override.',
    missing: `${what}${fields} is aimed into a nested placement of "${m.assetId}" that never appeared — the nested `
      + 'reference was removed or renamed in the asset. The override is not applied; revert it on the reference node.',
    'placement-missing': `${what}${fields} is aimed into a nested placement of "${m.assetId}" whose asset could not `
      + 'be loaded. It applies again once that asset is available.',
    'placement-cap': `${what}${fields} is aimed into a nested placement of "${m.assetId}" that was not built because `
      + 'the per-load placement cap was reached.',
    'placement-refused': `${what}${fields} is aimed into a nested placement of "${m.assetId}" that was refused `
      + '(reference cycle or nesting too deep).',
  };
  const detail = m.reason
    ? why[m.reason]
    : `${what}${fields} does not exist in the baked asset "${m.assetId}" — the part was merged into a chunk, `
      + 'renamed, or removed from the file. The override is not applied. Give the part a component or a `BakeRole` '
      + 'in the asset, or revert the override on the reference node.';
  reportProblem({
    id: overrideOrphanedProblemId(m.nodePath, m.addressing, m.key),
    severity: 'warning',
    code: 'override-orphaned',
    title: m.reason === 'ambiguous'
      ? `Override target is ambiguous in ${m.label}`
      : `Override has no target in ${m.label}`,
    detail,
    nodePath: m.nodePath,
  });
}

/** Drop every orphaned-override problem — the document changed. */
export function clearOverrideOrphanedProblems(): void {
  clearProblemsOfCode('override-orphaned');
  clearProblemsOfCode(OVERRIDE_TRANSFORMS_DROPPED_CODE);
  clearNestedTransformRefusedProblems();
  clearPlacementTransformOrphanedProblems();
}

// ─── Removed part moves (plan-769 F14) ───────────────────────────────────

/** Problem code: an old file's reference node carried `trsByNodeId` part moves, which are no longer applied. */
export const OVERRIDE_TRANSFORMS_DROPPED_CODE = 'override-transforms-dropped';

/**
 * Report that a reference node of an old file carried `count` part moves
 * (`trsByNodeId`). They are not applied (plan-769 F14 — a part inside a placement
 * keeps the position its asset gives it) and the next save does not write them
 * back. One problem per reference node; a re-apply replaces.
 */
export function reportOverrideTransformsDropped(m: {
  nodePath: string; label: string; assetId: string; count: number;
}): void {
  reportProblem({
    id: `${OVERRIDE_TRANSFORMS_DROPPED_CODE}:${m.nodePath}`,
    severity: 'warning',
    code: OVERRIDE_TRANSFORMS_DROPPED_CODE,
    title: `${m.count} moved part${m.count === 1 ? '' : 's'} in ${m.label} no longer applied`,
    detail: `This file moved ${m.count} part${m.count === 1 ? '' : 's'} inside the placed asset "${m.assetId}" `
      + '(trsByNodeId). Moving a part inside a placement is no longer supported: the parts stay where the asset '
      + 'puts them, and saving the document drops the old moves. Move the part in the asset itself, or place it '
      + 'as its own asset.',
    nodePath: m.nodePath,
  });
}

/** Drop every `nested-transform-refused` problem — a new save attempt, or the document changed. */
export function clearNestedTransformRefusedProblems(): void {
  clearProblemsOfCode(NESTED_TRANSFORM_REFUSED_CODE);
}

/** Problem code: a transform edit on a node inside a placement was refused (plan-769 D11). */
export const NESTED_TRANSFORM_REFUSED_CODE = 'nested-transform-refused';

// ─── Moves of placements the file no longer holds (plan-769 Phase 7) ─────

/** Problem code: a move of a placement the saved file held could not be written — its node is gone. */
export const PLACEMENT_TRANSFORM_ORPHANED_CODE = 'placement-transform-orphaned';

/**
 * Report that a save could not write the move of placement `placementId`: the
 * file being written holds no placement node with that id any more (plan-769
 * D23). One problem per placement; the next save attempt replaces the set.
 */
export function reportPlacementTransformOrphaned(m: { placementId: string }): void {
  reportProblem({
    id: `${PLACEMENT_TRANSFORM_ORPHANED_CODE}:${m.placementId}`,
    severity: 'warning',
    code: PLACEMENT_TRANSFORM_ORPHANED_CODE,
    title: 'A moved placement could not be saved',
    detail: `The placement ${m.placementId} was moved, but the document file no longer contains it, so the move `
      + 'was not written. Reopen the document and place the asset again if it is still needed.',
  });
}

/** Drop every `placement-transform-orphaned` problem — a new save attempt, or the document changed. */
export function clearPlacementTransformOrphanedProblems(): void {
  clearProblemsOfCode(PLACEMENT_TRANSFORM_ORPHANED_CODE);
}

/**
 * Report a refused part move inside a placement (plan-769 D11/F14). Only component
 * values may be overridden inside placed content; a transform has no vocabulary
 * there. One problem per refused node; the next refusal of the same node replaces.
 */
export function reportNestedTransformRefused(m: { nodePath: string; placementPath: string }): void {
  reportProblem({
    id: `${NESTED_TRANSFORM_REFUSED_CODE}:${m.nodePath}`,
    severity: 'warning',
    code: NESTED_TRANSFORM_REFUSED_CODE,
    title: 'A part inside a placement cannot be moved',
    detail: `"${m.nodePath}" belongs to the placement "${m.placementPath}". Inside placed content only component `
      + 'values can be changed; move the whole placement, or move the part in its asset.',
    nodePath: m.nodePath,
  });
}

// ─── Stored node references (plan-610 F9) ───────────────────────────────

/** Problem codes of the reference audit (`engine/rv-reference-audit.ts`). */
export const REFERENCE_PROBLEM_CODES = Object.freeze({
  /** No node answers the stored path — error. */
  unresolved: 'reference-unresolved',
  /** A node answers only through a fallback lookup (suffix, sanitized, name) — warning. */
  rescued: 'reference-rescued',
} as const);

/**
 * Most entries per code; the rest is ONE summary entry. A badly broken document must
 * not bury every other problem under thousands of rows.
 */
export const REFERENCE_PROBLEM_CAP = 200;

/** Where a stored reference sits — the subset of an audit finding the store needs. */
export interface ReferenceProblemLocation {
  /** Registry path of the node carrying the reference (the entry's `nodePath`). */
  referrerPath: string;
  /** rv extras key of the component (`Drive_Cylinder`). */
  componentType: string;
  /** Top-level field key. */
  field: string;
  /** Element position of an array field. */
  index?: number | undefined;
  /** Location below `field[index]` (`targetObjects[1]`). */
  subPath?: string | undefined;
  /** The path as stored. */
  writtenPath: string;
  /** The reference's own target component type, when it carries one. */
  targetComponentType?: string | undefined;
}

/** A reference no node answers. */
export interface ReferenceUnresolvedReport extends ReferenceProblemLocation {
  /**
   * plan-765 F6: a node exists under the written path with a Three.js dedup
   * suffix (`_1` … `_3`) — the mark of a file saved by an editor before
   * plan-765. Adds {@link DEDUP_SUFFIX_HINT} to the detail; nothing else changes.
   */
  dedupSuffixExists?: boolean | undefined;
}

/** The F6 sentence, verbatim — one wording for the panel and the tests. */
export const DEDUP_SUFFIX_HINT = 'A node exists under this path with a `_N` suffix: the file was saved by an editor '
  + 'before plan-765 and should be re-exported from its source.';

/** A reference that resolved only through a fallback lookup. */
export interface ReferenceRescuedReport extends ReferenceProblemLocation {
  /** Canonical path of the node it landed on. */
  resolvedPath: string;
  /** The fallback stage that hit (`suffix`, `sanitized`, `name-in-scope`). */
  stage: string;
}

function referenceLocationKey(componentType: string, field: string, index?: number, subPath?: string): string {
  let s = `${componentType}.${field}`;
  if (index !== undefined) s += `[${index}]`;
  if (subPath) s += subPath.startsWith('[') ? subPath : `.${subPath}`;
  return s;
}

/** The problem id of an unresolved reference — one per (referrer, component, field, element). */
export function referenceUnresolvedProblemId(
  referrerPath: string, componentType: string, field: string, index?: number, subPath?: string,
): string {
  return `${REFERENCE_PROBLEM_CODES.unresolved}:${referrerPath}:${referenceLocationKey(componentType, field, index, subPath)}`;
}

/** The problem id of a rescued reference — one per (referrer, component, field, element). */
export function referenceRescuedProblemId(
  referrerPath: string, componentType: string, field: string, index?: number, subPath?: string,
): string {
  return `${REFERENCE_PROBLEM_CODES.rescued}:${referrerPath}:${referenceLocationKey(componentType, field, index, subPath)}`;
}

/** Report ONE unresolved reference (error). Re-reporting the same location replaces. */
export function reportReferenceUnresolved(m: ReferenceUnresolvedReport): void {
  const where = referenceLocationKey(m.componentType, m.field, m.index, m.subPath);
  const target = m.targetComponentType ? ` (${m.targetComponentType})` : '';
  reportProblem({
    id: referenceUnresolvedProblemId(m.referrerPath, m.componentType, m.field, m.index, m.subPath),
    severity: 'error',
    code: REFERENCE_PROBLEM_CODES.unresolved,
    title: `Reference not found: ${m.writtenPath}`,
    detail: `${where} on "${m.referrerPath}" points at "${m.writtenPath}"${target} — no node with this path exists `
      + 'in its asset or in the scene. The reference stays unbound. Fix the path, or restore the node it named.'
      + (m.dedupSuffixExists === true ? ` ${DEDUP_SUFFIX_HINT}` : ''),
    nodePath: m.referrerPath,
  });
}

/** Report ONE reference found only by a fallback lookup (warning). Re-reporting replaces. */
export function reportReferenceRescued(m: ReferenceRescuedReport): void {
  const where = referenceLocationKey(m.componentType, m.field, m.index, m.subPath);
  reportProblem({
    id: referenceRescuedProblemId(m.referrerPath, m.componentType, m.field, m.index, m.subPath),
    severity: 'warning',
    code: REFERENCE_PROBLEM_CODES.rescued,
    title: `Reference found by name only: ${m.writtenPath} → ${m.resolvedPath}`,
    detail: `${where} on "${m.referrerPath}": "${m.writtenPath}" does not exist as written; a ${m.stage} lookup `
      + `bound it to "${m.resolvedPath}". It works now but may bind a different node once the scene changes — `
      + `change the path to "${m.resolvedPath}".`,
    nodePath: m.referrerPath,
  });
}

/** One summary entry for the findings beyond {@link REFERENCE_PROBLEM_CAP}. */
function reportReferenceOverflow(code: string, severity: ProblemSeverity, more: number): void {
  reportProblem({
    id: `${code}:+more`,
    severity,
    code,
    title: code === REFERENCE_PROBLEM_CODES.unresolved
      ? `${more} more references not found`
      : `${more} more references found by name only`,
    detail: `The list shows the first ${REFERENCE_PROBLEM_CAP}; ${more} further references of this kind were found `
      + 'and are not listed one by one.',
  });
}

/** One audit finding as {@link reportReferenceAudit} takes it (an engine `ReferenceAuditFinding` fits). */
export interface ReferenceAuditProblemInput extends ReferenceProblemLocation {
  kind: 'unresolved' | 'rescued';
  resolvedPath?: string | undefined;
  stage?: string | undefined;
  /** `unresolved` only — see {@link ReferenceUnresolvedReport.dedupSuffixExists}. */
  dedupSuffixExists?: boolean | undefined;
  /**
   * `unresolved` only, plan-774 F7: the target lies inside this PLACED reference
   * (registry path) and its bake did not keep it — reported as
   * {@link REFERENCE_TARGET_BAKED_AWAY_CODE} instead of `reference-unresolved`.
   */
  bakedAwayIn?: string | undefined;
  /** With {@link bakedAwayIn}: the stored target address, when there is one. */
  targetAddress?: string | undefined;
}

/**
 * Replace the reference problems with exactly what this audit found
 * (retire-then-report, like {@link reportMissingReferences}: an unchanged document
 * re-audited after every edit must not wake the panel).
 */
export function reportReferenceAudit(findings: readonly ReferenceAuditProblemInput[]): void {
  const wanted = new Set<string>();
  const unresolved: ReferenceUnresolvedReport[] = [];
  const rescued: ReferenceRescuedReport[] = [];
  const bakedAway: ReferenceTargetBakedAwayReport[] = [];
  for (const f of findings) {
    if (f.kind === 'unresolved' && typeof f.bakedAwayIn === 'string') {
      bakedAway.push({ ...f, placementPath: f.bakedAwayIn, targetAddress: f.targetAddress });
    } else if (f.kind === 'unresolved') unresolved.push(f);
    else if (typeof f.resolvedPath === 'string' && typeof f.stage === 'string') {
      rescued.push({ ...f, resolvedPath: f.resolvedPath, stage: f.stage });
    }
  }
  const uShown = unresolved.slice(0, REFERENCE_PROBLEM_CAP);
  const rShown = rescued.slice(0, REFERENCE_PROBLEM_CAP);
  for (const m of uShown) wanted.add(referenceUnresolvedProblemId(m.referrerPath, m.componentType, m.field, m.index, m.subPath));
  for (const m of rShown) wanted.add(referenceRescuedProblemId(m.referrerPath, m.componentType, m.field, m.index, m.subPath));
  if (unresolved.length > REFERENCE_PROBLEM_CAP) wanted.add(`${REFERENCE_PROBLEM_CODES.unresolved}:+more`);
  if (rescued.length > REFERENCE_PROBLEM_CAP) wanted.add(`${REFERENCE_PROBLEM_CODES.rescued}:+more`);

  let removed = false;
  for (const [id, entry] of [..._entries]) {
    if (entry.code !== REFERENCE_PROBLEM_CODES.unresolved && entry.code !== REFERENCE_PROBLEM_CODES.rescued) continue;
    if (wanted.has(id)) continue;
    _entries.delete(id);
    removed = true;
  }
  if (removed) notify();
  for (const m of uShown) reportReferenceUnresolved(m);
  for (const m of rShown) reportReferenceRescued(m);
  if (unresolved.length > REFERENCE_PROBLEM_CAP) {
    reportReferenceOverflow(REFERENCE_PROBLEM_CODES.unresolved, 'error', unresolved.length - REFERENCE_PROBLEM_CAP);
  }
  if (rescued.length > REFERENCE_PROBLEM_CAP) {
    reportReferenceOverflow(REFERENCE_PROBLEM_CODES.rescued, 'warning', rescued.length - REFERENCE_PROBLEM_CAP);
  }
  reportReferenceTargetsBakedAway(bakedAway);
}

// ─── Honest references into placed content (plan-774 F7) ────────────────

/**
 * Problem code (F7): a reference of the OPEN document (a `ComponentReference`,
 * a path field, a mechanism body / anchor) points at a node inside a placed
 * reference that the referenced asset's bake did not keep — a plain part merged
 * into a chunk. Same as at runtime: the reference stays unbound until the part
 * carries a component in its own asset.
 */
export const REFERENCE_TARGET_BAKED_AWAY_CODE = 'reference-target-baked-away';

/** One reference whose target was baked away inside a placed asset. */
export interface ReferenceTargetBakedAwayReport extends ReferenceProblemLocation {
  /** Registry path of the placed reference node the target lies in. */
  placementPath: string;
  /** The stored target address (`<p>#<id>`), when the reference is stored as one. */
  targetAddress?: string | undefined;
}

/** One entry per (referrer, component, field, element) — like `reference-unresolved`. */
export function referenceTargetBakedAwayProblemId(
  referrerPath: string, componentType: string, field: string, index?: number, subPath?: string,
): string {
  return `${REFERENCE_TARGET_BAKED_AWAY_CODE}:${referrerPath}:${referenceLocationKey(componentType, field, index, subPath)}`;
}

/**
 * Replace the `reference-target-baked-away` entries with exactly `list`
 * (retire-then-report; the audit re-runs per materialisation and per edit).
 */
export function reportReferenceTargetsBakedAway(list: readonly ReferenceTargetBakedAwayReport[]): void {
  const shown = list.slice(0, REFERENCE_PROBLEM_CAP);
  const wanted = new Set(shown.map((m) => referenceTargetBakedAwayProblemId(m.referrerPath, m.componentType, m.field, m.index, m.subPath)));
  let removed = false;
  for (const [id, entry] of [..._entries]) {
    if (entry.code !== REFERENCE_TARGET_BAKED_AWAY_CODE || wanted.has(id)) continue;
    _entries.delete(id);
    removed = true;
  }
  if (removed) notify();
  for (const m of shown) {
    const where = referenceLocationKey(m.componentType, m.field, m.index, m.subPath);
    const target = m.targetAddress ?? m.writtenPath;
    const placed = lastSegmentOf(m.placementPath);
    reportProblem({
      id: referenceTargetBakedAwayProblemId(m.referrerPath, m.componentType, m.field, m.index, m.subPath),
      severity: 'error',
      code: REFERENCE_TARGET_BAKED_AWAY_CODE,
      title: `Reference into placed asset ${placed} has no target: ${target}`,
      detail: `${where} on "${m.referrerPath}" points at "${target}" inside the placed asset "${m.placementPath}". `
        + 'That node is a plain part, which the asset\'s bake merges away — only nodes with a component stay '
        + 'addressable inside a placed asset. Open that asset (double-click the reference), give the part a '
        + 'component there and save it, or point the reference at a node that has one.',
      nodePath: m.referrerPath,
    });
  }
}

/**
 * Problem code (F7): a `Kinematic` of the open document integrates a group
 * (`IntegrateGroupEnable`) that has members inside a placed reference. A
 * placed asset is baked on its own; its parts are never re-parented under the
 * open document's kinematic axis, so they do not move with it.
 */
export const KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE = 'kinematic-member-in-placed-content';

/** One kinematic node whose group reaches into placed content. */
export interface KinematicMemberInPlacedContentReport {
  /** Registry path of the node carrying the `Kinematic`. */
  kinematicPath: string;
  /** Resolved group name. */
  groupName: string;
  /** How many members of the group lie inside placed content. */
  memberCount: number;
  /** Registry paths (or names) of the placed reference nodes they lie in. */
  placementPaths: string[];
}

/** One entry per (kinematic node, group). */
export function kinematicMemberInPlacedContentProblemId(kinematicPath: string, groupName: string): string {
  return `${KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE}:${kinematicPath}:${groupName}`;
}

/** Replace the `kinematic-member-in-placed-content` entries with exactly `list`. */
export function reportKinematicMembersInPlacedContent(list: readonly KinematicMemberInPlacedContentReport[]): void {
  const wanted = new Set(list.map((m) => kinematicMemberInPlacedContentProblemId(m.kinematicPath, m.groupName)));
  let removed = false;
  for (const [id, entry] of [..._entries]) {
    if (entry.code !== KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE || wanted.has(id)) continue;
    _entries.delete(id);
    removed = true;
  }
  if (removed) notify();
  for (const m of list) {
    const assets = m.placementPaths.map((p) => `"${p}"`).join(', ');
    reportProblem({
      id: kinematicMemberInPlacedContentProblemId(m.kinematicPath, m.groupName),
      severity: 'warning',
      code: KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE,
      title: `Kinematic group ${m.groupName} reaches into a placed asset`,
      detail: `The Kinematic on "${m.kinematicPath}" integrates group "${m.groupName}", and ${m.memberCount} of its `
        + `member${m.memberCount === 1 ? '' : 's'} lie inside the placed asset${m.placementPaths.length === 1 ? '' : 's'} ${assets}. `
        + 'A placed asset is baked on its own, so those parts do not move with this axis. Move the group into the '
        + 'asset (open it with a double-click on the reference) or take the group off the placed parts.',
      nodePath: m.kinematicPath,
    });
  }
}

/** Last path segment — the display name of a placement path. */
function lastSegmentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Drop every unresolved-reference problem. */
export function clearReferenceUnresolvedProblems(): void {
  clearProblemsOfCode(REFERENCE_PROBLEM_CODES.unresolved);
}

/** Drop every rescued-reference problem. */
export function clearReferenceRescuedProblems(): void {
  clearProblemsOfCode(REFERENCE_PROBLEM_CODES.rescued);
}

/** Drop every reference-audit code — the document changed (plan-774: incl. the placed-content findings). */
export function clearReferenceAuditProblems(): void {
  clearReferenceUnresolvedProblems();
  clearReferenceRescuedProblems();
  clearProblemsOfCode(REFERENCE_TARGET_BAKED_AWAY_CODE);
  clearProblemsOfCode(KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE);
}

// ─── Reference migration on load (plan-769 Phase 1a, F4) ────────────────

/**
 * Problem codes of the migration on load (`rv-decode-identity.ts`): what the
 * file's authored index says about a stored path that the path audit cannot see.
 * A MISSING target stays the audit's `reference-unresolved` — since plan-769 Phase 1b
 * never `reference-rescued`: a reference the file carries is not read by a guessing
 * stage any more.
 */
export const REFERENCE_MIGRATION_PROBLEM_CODES = Object.freeze({
  /** The written path names more than one node of its file — kept, never guessed. */
  ambiguous: 'reference-ambiguous',
  /** The written path exists only in the loader's (Three.js) spelling, not in the authored names. */
  legacySpelling: 'reference-legacy-spelling',
  /** The written path names a node the bake created (a partition / chunk), not one of the file. */
  syntheticTarget: 'reference-target-synthetic',
} as const);

/** One finding of the migration on load, located in the live scene. */
export interface ReferenceMigrationProblem {
  kind: keyof typeof REFERENCE_MIGRATION_PROBLEM_CODES;
  /** Registry path of the node carrying the reference. */
  referrerPath: string;
  /** rv extras key of the component. */
  componentType: string;
  /** Location label (`steps[0].targetObjects[1]`). */
  field: string;
  /** The path as stored. */
  writtenPath: string;
}

/** The problem id of a migration finding — one per (code, referrer, component, field). */
export function referenceMigrationProblemId(m: ReferenceMigrationProblem): string {
  return `${REFERENCE_MIGRATION_PROBLEM_CODES[m.kind]}:${m.referrerPath}:${m.componentType}.${m.field}`;
}

const MIGRATION_DETAIL: Readonly<Record<ReferenceMigrationProblem['kind'], string>> = {
  ambiguous: 'matches more than one node of its file (two parts share this path). The reference is kept as written '
    + 'and not bound by guessing; make the names unique in the source and re-export.',
  legacySpelling: 'exists only in the loader\'s renamed spelling (a `_N` / sanitized name), not in the names the '
    + 'file authored. It binds, but a re-export or rename can break it; write the authored path in the source.',
  syntheticTarget: 'names a node the viewer created while optimising the model (a merged chunk or group '
    + 'partition), not a part of the file. Such nodes have no identity; point the reference at a real part.',
};

/**
 * Report migration findings (add / replace by id). Capped per code at
 * {@link REFERENCE_PROBLEM_CAP}; the rest is one summary entry per code. Dropped by
 * {@link clearReferenceMigrationProblems} in `clearModel()`.
 */
export function reportReferenceMigrationProblems(list: readonly ReferenceMigrationProblem[]): void {
  if (list.length === 0) return;
  const shown = new Map<string, number>();
  for (const e of _entries.values()) {
    if (Object.values(REFERENCE_MIGRATION_PROBLEM_CODES).includes(e.code as never) && !e.id.endsWith(':+more')) {
      shown.set(e.code, (shown.get(e.code) ?? 0) + 1);
    }
  }
  const more = new Map<string, number>();
  for (const m of list) {
    const id = referenceMigrationProblemId(m);
    const code = REFERENCE_MIGRATION_PROBLEM_CODES[m.kind];
    if (!_entries.has(id) && (shown.get(code) ?? 0) >= REFERENCE_PROBLEM_CAP) {
      more.set(code, (more.get(code) ?? 0) + 1);
      continue;
    }
    if (!_entries.has(id)) shown.set(code, (shown.get(code) ?? 0) + 1);
    reportProblem({
      id,
      severity: m.kind === 'legacySpelling' ? 'warning' : 'error',
      code: REFERENCE_MIGRATION_PROBLEM_CODES[m.kind],
      title: m.kind === 'ambiguous'
        ? `Reference is ambiguous (kept): ${m.writtenPath}`
        : m.kind === 'legacySpelling'
          ? `Reference uses a renamed spelling: ${m.writtenPath}`
          : `Reference targets a generated node: ${m.writtenPath}`,
      detail: `${m.componentType}.${m.field} on "${m.referrerPath}": "${m.writtenPath}" ${MIGRATION_DETAIL[m.kind]}`,
      nodePath: m.referrerPath,
    });
  }
  for (const [code, n] of more) {
    const id = `${code}:+more`;
    const prev = Number(/^(\d+)/.exec(_entries.get(id)?.title ?? '')?.[1] ?? 0);
    reportProblem({
      id,
      severity: 'warning',
      code,
      title: `${prev + n} more references (${code})`,
      detail: `The list shows the first ${REFERENCE_PROBLEM_CAP}; further references of this kind were found and `
        + 'are not listed one by one.',
    });
  }
}

/** Drop every migration finding — the document changed. */
export function clearReferenceMigrationProblems(): void {
  for (const code of Object.values(REFERENCE_MIGRATION_PROBLEM_CODES)) clearProblemsOfCode(code);
  for (const code of Object.values(ID_VERSION_PROBLEM_CODES)) clearProblemsOfCode(code);
  for (const code of Object.values(USER_PATH_PROBLEM_CODES)) clearProblemsOfCode(code);
  for (const code of Object.values(SAVE_IDENTITY_PROBLEM_CODES)) clearProblemsOfCode(code);
}

// ─── Id format of a document (plan-769 Phase 1b, 9.19) ─────────────────

/** Problem codes of a document's `idVersion` (`scenes[0].extras.realvirtual.idVersion`). */
export const ID_VERSION_PROBLEM_CODES = Object.freeze({
  /** The file was written by a NEWER viewer: its references are read as they are, not migrated. */
  newer: 'id-version-newer',
} as const);

/**
 * Report a document whose id format is newer than this viewer's (9.19): a warning,
 * its references stay as stored. One entry per file. Cleared with the model.
 */
export function reportIdVersionNewer(m: { file: string; idVersion: number; supported: number; nodePath?: string }): void {
  reportProblem({
    id: `${ID_VERSION_PROBLEM_CODES.newer}:${m.file}`,
    severity: 'warning',
    code: ID_VERSION_PROBLEM_CODES.newer,
    title: `Document written by a newer viewer (id format ${m.idVersion})`,
    detail: `"${m.file}" stores node ids in format ${m.idVersion}; this viewer reads format ${m.supported}. `
      + 'Its references are read as stored (not migrated) — what this viewer does not understand stays '
      + 'unresolved. Open the document with a current viewer.',
    ...(m.nodePath ? { nodePath: m.nodePath } : {}),
  });
}

// ─── Paths typed by plugins / users (plan-769 F9) ───────────────────────

/**
 * Problem codes of a PATH INPUT (`NodeRegistry.findNodeForUser`) that a plugin or a
 * load script resolves: nothing answers, or only a guessing stage does (until
 * plan-770). Never a stored reference — those are `reference-*`.
 */
export const USER_PATH_PROBLEM_CODES = Object.freeze({
  notFound: 'plugin-path-not-found',
  guessed: 'plugin-path-guessed',
} as const);

/**
 * Report a plugin's path input that missed or only bound through a guess (F9). A
 * guessed hit is still used for the input — the entry makes it visible before it
 * could ever be stored. One entry per (plugin, path). Cleared with the model.
 */
export function reportPluginPathProblem(m: {
  plugin: string;
  path: string;
  kind: keyof typeof USER_PATH_PROBLEM_CODES;
  /** Registry path of the node a guess landed on. */
  matchedPath?: string;
  /** What the plugin wanted the node for. */
  purpose?: string;
}): void {
  const code = USER_PATH_PROBLEM_CODES[m.kind];
  const what = m.purpose ? ` (${m.purpose})` : '';
  reportProblem({
    id: `${code}:${m.plugin}:${m.path}`,
    severity: 'warning',
    code,
    title: m.kind === 'notFound'
      ? `Plugin path not found: ${m.path}`
      : `Plugin path matched only by guessing: ${m.path}`,
    detail: m.kind === 'notFound'
      ? `Plugin "${m.plugin}" looks for "${m.path}"${what}, but no node of the loaded model has this path — `
        + 'neither as shown in the hierarchy nor as authored in the file. The plugin feature does nothing; '
        + 'update the path in the plugin.'
      : `Plugin "${m.plugin}" looks for "${m.path}"${what}; only a fallback lookup matched `
        + `"${m.matchedPath ?? '?'}". It is used for now, but may be the wrong part — write the exact path in the plugin.`,
    ...(m.matchedPath ? { nodePath: m.matchedPath } : {}),
  });
}

// ─── Ids and references written by a save (plan-769 Phase 3) ──────────

/** Problem codes of the id / reference writer of a save (`rv-reference-writer.ts`). */
export const SAVE_IDENTITY_PROBLEM_CODES = Object.freeze({
  /** Two exported nodes carried one NodeId; the later one was given a new id. */
  duplicateReminted: 'node-id-duplicate-reminted',
  /** A reference written this session reached its target only through a guessing stage (F9). */
  savedFromGuess: 'reference-saved-from-guess',
  /** F21: a reference into another document names an id that document has not saved yet. */
  targetUnsaved: 'reference-target-unsaved',
} as const);

/**
 * plan-769 F21 — warn that a reference was written to a node whose id exists only in this
 * session, inside another document: save that document first, or the reference is an
 * orphan after the next reload. One entry per (referrer, address). Cleared with the model.
 */
export function reportReferenceTargetUnsaved(m: { referrerPath: string; address: string; targetPath: string; documentName: string }): void {
  reportProblem({
    id: `${SAVE_IDENTITY_PROBLEM_CODES.targetUnsaved}:${m.referrerPath}:${m.address}`,
    severity: 'warning',
    code: SAVE_IDENTITY_PROBLEM_CODES.targetUnsaved,
    title: `Save document "${m.documentName}" first`,
    detail: `"${m.referrerPath}" now references "${m.targetPath}" in "${m.documentName}", whose id was created in this `
      + `session and is not in that document's file yet. Save "${m.documentName}" before this document, or the reference `
      + 'is lost on the next load.',
    nodePath: m.referrerPath,
  });
}

/**
 * Report what the save's writer had to decide on its own: re-minted duplicate ids, and
 * references stored as the address of a GUESSED target (F9 — written, but visible,
 * because the guess is now permanent). One entry per id / per (referrer, field, path).
 * Cleared with the model ({@link clearReferenceMigrationProblems}).
 */
export function reportSaveIdentityProblems(m: {
  reminted: ReadonlyArray<{ id: string; reminted: string; nodePath: string }>;
  guessed: ReadonlyArray<{
    referrerPath: string; componentType: string; field: string; writtenPath: string; targetPath: string; stage?: string;
  }>;
}): void {
  for (const d of m.reminted.slice(0, REFERENCE_PROBLEM_CAP)) {
    reportProblem({
      id: `${SAVE_IDENTITY_PROBLEM_CODES.duplicateReminted}:${d.id}:${d.nodePath}`,
      severity: 'warning',
      code: SAVE_IDENTITY_PROBLEM_CODES.duplicateReminted,
      title: `Duplicate node id re-minted: ${d.nodePath}`,
      detail: `"${d.nodePath}" carried the id ${d.id}, which another node of the document also carries. `
        + `It was saved with the new id ${d.reminted}; references to ${d.id} keep naming the other node.`,
      nodePath: d.nodePath,
    });
  }
  for (const g of m.guessed.slice(0, REFERENCE_PROBLEM_CAP)) {
    reportProblem({
      id: `${SAVE_IDENTITY_PROBLEM_CODES.savedFromGuess}:${g.referrerPath}:${g.componentType}.${g.field}:${g.writtenPath}`,
      severity: 'warning',
      code: SAVE_IDENTITY_PROBLEM_CODES.savedFromGuess,
      title: `Reference saved from a guess: ${g.writtenPath}`,
      detail: `${g.componentType}.${g.field} on "${g.referrerPath}": "${g.writtenPath}" matched "${g.targetPath}" `
        + `only through the "${g.stage ?? 'fallback'}" lookup stage. It is now stored as that node's id — `
        + 'check it is the intended part, or set the reference again.',
      nodePath: g.referrerPath,
    });
  }
}

/** Drop every plugin path finding. Also part of {@link clearReferenceMigrationProblems}. */
export function clearPluginPathProblems(): void {
  for (const code of Object.values(USER_PATH_PROBLEM_CODES)) clearProblemsOfCode(code);
}


// ─── Signal name collisions (plan-589) ──────────────────────────────────

/** The problem id of a colliding signal name — ONE entry per name. */
export function signalNameCollisionProblemId(name: string): string {
  return `signal-name-collision:${name}`;
}

/**
 * Report that several MODEL nodes claim the same PLC signal name.
 *
 * An AUTHORED signal name stays raw, placement or not (plan-589, user decision
 * 2026-10-11: a placement must not break existing CONNECT configurations). The
 * price is that two copies of the same asset really do share their authored
 * symbols — a binding then drives the foreign node too, and the store's
 * `getPath()` answers with whichever copy registered last. That is worth a
 * warning, not an error: the model still loads and runs.
 *
 * ONE entry per name (re-reporting replaces), every claiming path in `detail`,
 * `nodePath` on the one that triggered the report.
 */
export function reportSignalNameCollision(
  name: string, paths: readonly string[], nodePath?: string,
): void {
  const list = [...paths].sort();
  reportProblem({
    id: signalNameCollisionProblemId(name),
    severity: 'warning',
    code: 'signal-name-collision',
    title: `Signal name "${name}" is used by ${list.length} nodes`,
    detail: `These nodes all register the PLC signal "${name}": ${list.join(', ')}. `
      + 'An authored signal name is used verbatim, so two placed copies of the same asset share it — '
      + 'a binding or a PLC interface reaches only one of them. Give the signals distinct names in the '
      + 'asset, or declare the symbol global (a leading "/") if sharing it is intended.',
    ...(nodePath ? { nodePath } : {}),
  });
}

/** Drop every signal-name-collision problem — the model is being rebuilt. */
export function clearSignalNameCollisionProblems(): void {
  clearProblemsOfCode('signal-name-collision');
}

// ─── Instruction targets (CustomRuntimeInstruction, plan-769 Phase 0a) ──

/** Problem code: a CustomRuntimeInstruction step names a target node the loaded model does not have. */
export const UNRESOLVED_INSTRUCTION_TARGET_CODE = 'unresolved-instruction-target';

/**
 * Drop every unresolved-instruction-target problem — the document changed.
 * The instruction reports its targets at init; without this clear an entry of
 * the previous model stayed in the panel after a model switch (plan-769 F16).
 */
export function clearUnresolvedInstructionTargetProblems(): void {
  clearProblemsOfCode(UNRESOLVED_INSTRUCTION_TARGET_CODE);
}

// ─── Instance collisions (plan-559 Phase 2a) ────────────────────────────
//
// Two warnings about copies of the same asset that are NOT placements (embedded
// in the document): they report, they never change behaviour (decision D7/A1 —
// warn, don't auto-instance, don't forbid). Both are per-document: they are
// dropped when another document starts loading (below), and a path component
// drops its own entry when it leaves the scene.

/** Problem code: one scoped signal name is claimed by several component nodes outside a placement. */
export const INSTANCE_SIGNAL_COLLISION_CODE = 'instance-signal-collision';

/** Problem code: several path nodes register the same (global) path id. */
export const PATH_ID_COLLISION_CODE = 'path-id-collision';

/** The problem id of a colliding instance signal name — ONE entry per name. */
export function instanceSignalCollisionProblemId(name: string): string {
  return `${INSTANCE_SIGNAL_COLLISION_CODE}:${name}`;
}

/**
 * Report that several nodes OUTSIDE any placement claim the same PLC signal
 * name — typically two embedded copies of one asset without an `InstanceScope`
 * marker, whose generated signals (`Flow.Run`, …) then share one symbol. A
 * warning: the model loads and runs, and the copies keep sharing the signal.
 *
 * ONE entry per name (re-reporting replaces), every claiming node path in
 * `detail`, `nodePath` on the one that triggered the report.
 */
export function reportInstanceSignalCollision(
  name: string, paths: readonly string[], nodePath?: string,
): void {
  const list = [...paths].sort();
  reportProblem({
    id: instanceSignalCollisionProblemId(name),
    severity: 'warning',
    code: INSTANCE_SIGNAL_COLLISION_CODE,
    title: `Signal "${name}" is claimed by ${list.length} components`,
    detail: `These nodes all register the PLC signal "${name}": ${list.join(', ')}. `
      + 'They are not placements, so nothing separates their signals — they share ONE signal, and a '
      + 'binding or a PLC interface drives all of them together. If they are copies of one asset that '
      + 'should run independently, add an InstanceScope component to the root of each copy (its name, or '
      + 'the name of its PrefixNode, becomes the signal prefix).',
    ...(nodePath ? { nodePath } : {}),
  });
}

/** Drop every instance-signal-collision problem. */
export function clearInstanceSignalCollisionProblems(): void {
  clearProblemsOfCode(INSTANCE_SIGNAL_COLLISION_CODE);
}

/** The problem id of a colliding path id — ONE entry per id. */
export function pathIdCollisionProblemId(id: string): string {
  return `${PATH_ID_COLLISION_CODE}:${id}`;
}

/**
 * Report that several path nodes register the same path id. Path ids are
 * global in the path network (the last registration wins the id), so routing
 * follows only one of them. A warning; nothing about the routing changes.
 */
export function reportPathIdCollision(
  id: string, paths: readonly string[], nodePath?: string,
): void {
  const list = [...new Set(paths)].sort();
  reportProblem({
    id: pathIdCollisionProblemId(id),
    severity: 'warning',
    code: PATH_ID_COLLISION_CODE,
    title: `Path id "${id}" is used by ${list.length} paths`,
    detail: `These path nodes all register the path id "${id}": ${list.join(', ')}. `
      + 'Path ids are global: the path network keeps only the last one registered, so vehicles and '
      + 'successor links reach only that path. Give each path a unique id.',
    ...(nodePath ? { nodePath } : {}),
  });
}

/** Drop the path-id-collision problem of one id. */
export function clearPathIdCollisionProblem(id: string): void {
  clearProblem(pathIdCollisionProblemId(id));
}

/** Drop every path-id-collision problem. */
export function clearPathIdCollisionProblems(): void {
  clearProblemsOfCode(PATH_ID_COLLISION_CODE);
}

// Per-document: a new document starts without the previous one's collisions.
// (The viewer sets the document when a load STARTS, before anything reports.)
subscribeProblemsDocument(() => {
  clearInstanceSignalCollisionProblems();
  clearPathIdCollisionProblems();
});

// ─── Signal reconcile (plan-589 F6) ─────────────────────────────────────

/** Problem code of every reconcile finding — one `clearProblemsOfCode` clears the lot. */
export const SIGNAL_RECONCILE_CODE = 'signal-reconcile';

/** Command the `plc-only` entry's action dispatches (descriptor: `editor-command-descriptors.ts`). */
export const SIGNALS_CREATE_FROM_INTERFACE_COMMAND = 'editor.signalsCreateFromInterface';

// ─── Signal rename (plan-590 F7) ────────────────────────────────────────

/**
 * Commands the signal-rename Problems entries dispatch (descriptors: `editor-command-descriptors.ts`,
 * coordinator: `rv-signal-rename-coordinator.ts`). Here for the same reason as the line above: the
 * entry's `action` names them and this store stays dependency-free.
 */
export const SIGNAL_RENAME_COMMAND = 'editor.signalRename';
export const SIGNAL_RENAME_REPAIR_COMMAND = 'editor.signalRenameRepair';
export const SIGNAL_RENAME_RECHECK_COMMAND = 'editor.signalRenameRecheck';

/** Names listed in `detail` before it says "+N more" — a panel line, not a database dump. */
const RECONCILE_DETAIL_NAMES = 12;

/** ONE problem per (interface, category) — never one per signal (plan-589 §5.2). */
export function signalReconcileProblemId(interfaceId: string, category: string): string {
  return `${SIGNAL_RECONCILE_CODE}:${interfaceId}:${category}`;
}

/**
 * The reconcile categories worth a Problems entry, with their severity and wording.
 *
 * `mapped` is absent on purpose: the normal case is not a problem. `no-address` is a `warning`
 * because the gateway stated it needs one (plan-589 §"Adressbasierte Schnittstelle ohne Adresse");
 * `plc-only` is an `info` — the interface knowing more signals than the model is a normal stage of
 * building a model, and it is the one entry that offers to fix itself.
 */
const RECONCILE_PROBLEM_KIND: Record<string, { severity: ProblemSeverity; title: string; hint: string }> = {
  'name-variant': {
    severity: 'warning',
    title: 'only a name variant',
    hint: 'A quoted and an unquoted spelling are two different keys to the gateway, so these are NOT coupled. '
      + 'Rename one side so both spell the symbol identically.',
  },
  'missing-in-plc': {
    severity: 'warning',
    title: 'not configured on the interface',
    hint: 'The model drives these signals but the interface carries no place for them — '
      + 'add them on the interface (or bind them to another one).',
  },
  'plc-only': {
    severity: 'info',
    title: 'not present in the model',
    hint: 'The interface carries these signals but no model signal claims them.',
  },
  'type-mismatch': {
    severity: 'warning',
    title: 'type mismatch',
    hint: 'Direction, value kind or data type differ between the model signal and the interface signal. '
      + 'Values will not arrive as expected.',
  },
  'no-address': {
    severity: 'warning',
    title: 'no address',
    hint: 'This interface type needs a protocol address per signal; without one the gateway skips the signal.',
  },
};

/** The report shape this store consumes — structural, so no import of the reconcile module. */
export interface SignalReconcileSummary {
  interfaceId: string;
  interfaceType: string;
  counts: Record<string, number>;
  entries: readonly { category: string; name: string; suggestion?: string | undefined }[];
}

/**
 * Turn ONE interface's reconcile report into at most five Problems entries.
 *
 * Grouped by category with the count in the title and the names in `detail`: a model with 400
 * unconfigured signals must produce ONE line, not 400 (plan-589 §5.2 — the Problems flood is the
 * failure mode this grouping exists to prevent). An entry for a category that is now empty is
 * cleared, so a fixed interface leaves the panel without anyone tracking ids.
 *
 * @param creatable Names the `plc-only` action may actually create (the caller filters out the
 *   types the model cannot register); an empty list means the action is not offered.
 */
export function reportSignalReconcileProblems(
  report: SignalReconcileSummary,
  creatable: readonly string[] = [],
): void {
  // An interface the model couples to NOT ONE signal of (nothing mapped, no variant, no
  // mismatch, no missing address) is unrelated to this model — e.g. another project's gateway
  // config. "Your N model signals are not configured on it" is then noise, not a finding.
  const coupled = report.entries.some((e) => e.category !== 'missing-in-plc' && e.category !== 'plc-only');
  const byCategory = new Map<string, string[]>();
  for (const entry of report.entries) {
    if (!(entry.category in RECONCILE_PROBLEM_KIND)) continue;
    if (entry.category === 'missing-in-plc' && !coupled) continue;
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry.name);
    byCategory.set(entry.category, list);
  }

  for (const category of Object.keys(RECONCILE_PROBLEM_KIND)) {
    const id = signalReconcileProblemId(report.interfaceId, category);
    const names = byCategory.get(category);
    if (!names || names.length === 0) {
      clearProblem(id);
      continue;
    }
    const kind = RECONCILE_PROBLEM_KIND[category];
    const shown = names.slice(0, RECONCILE_DETAIL_NAMES).join(', ');
    const more = names.length > RECONCILE_DETAIL_NAMES ? ` +${names.length - RECONCILE_DETAIL_NAMES} more` : '';
    const action = category === 'plc-only' && creatable.length > 0
      ? {
        label: `Create ${creatable.length} model signal(s)`,
        commandId: SIGNALS_CREATE_FROM_INTERFACE_COMMAND,
        args: { interfaceId: report.interfaceId, names: [...creatable] },
      }
      : undefined;
    reportProblem({
      id,
      severity: kind.severity,
      code: SIGNAL_RECONCILE_CODE,
      title: `${report.interfaceId}: ${names.length} signal(s) ${kind.title}`,
      detail: `${shown}${more} — ${kind.hint}`,
      ...(action ? { action } : {}),
    });
  }
}

/** Drop the reconcile entries of ONE interface (it was deleted, or the gateway went away). */
export function clearSignalReconcileProblems(interfaceId?: string): void {
  if (interfaceId === undefined) {
    clearProblemsOfCode(SIGNAL_RECONCILE_CODE);
    return;
  }
  for (const category of Object.keys(RECONCILE_PROBLEM_KIND)) {
    clearProblem(signalReconcileProblemId(interfaceId, category));
  }
}

// ─── Nested references the instancer refused (plan-757 Phase 2) ─────────

/** Problem codes of a refused nested reference, by reason (one entry per node). */
export const NESTED_REFERENCE_PROBLEM_CODES = {
  cycle: 'reference-cycle',
  depth: 'reference-depth',
  // plan-650 Phase 5b: the same refusals for nested child FAMILIES.
  'parametric-cycle': 'parametric-cycle',
  'parametric-depth': 'parametric-depth',
  'parametric-budget': 'parametric-budget',
} as const;

export type NestedReferenceRefusalReason = keyof typeof NESTED_REFERENCE_PROBLEM_CODES;

/** plan-650 Phase 5b: a nested child family is not available in the project. */
export const PARAMETRIC_CHILD_MISSING_CODE = 'parametric-child-missing';

/** Report a missing child family (plan-650 Phase 5b) - the parent variant stays standing. */
export function reportParametricChildMissing(m: { family: string; nodePath: string; parentId: string }): void {
  reportProblem({
    id: `${PARAMETRIC_CHILD_MISSING_CODE}:${m.nodePath}`,
    severity: 'error',
    code: PARAMETRIC_CHILD_MISSING_CODE,
    title: `Child family "${m.family}" is missing`,
    detail: `The parametric placement "${m.parentId}" places the child family "${m.family}", which is not in this project. `
      + 'The parent stands without the child - import the family bundle again or add the child family to the project library.',
    nodePath: m.nodePath,
  });
}

/**
 * plan-650 Phase 5b: child families a share export could not bundle, or an
 * import could not find - one entry per family, same code as at load time.
 */
export function reportParametricBundleMissing(m: { families: string[]; phase: 'export' | 'import'; document?: string }): void {
  for (const family of m.families) {
    reportProblem({
      id: `${PARAMETRIC_CHILD_MISSING_CODE}:${m.phase}:${family}`,
      severity: 'warning',
      code: PARAMETRIC_CHILD_MISSING_CODE,
      title: `Child family "${family}" is missing`,
      detail: m.phase === 'export'
        ? `The shared file${m.document ? ` "${m.document}"` : ''} declares the child family "${family}", but its exact document `
          + '(the declared DocHash) is not in this project - the receiver will see the parent without it.'
        : `The imported file${m.document ? ` "${m.document}"` : ''} declares the child family "${family}", which neither the bundle `
          + 'nor this project contains - the parent stands without it.',
    });
  }
}

/** The ONE aggregated per-load entry of the placement cap (F9). */
export const PLACEMENT_CAP_PROBLEM_CODE = 'placement-cap';
/** A host's registration of a materialised placement threw (F11). */
export const PLACEMENT_REGISTER_FAILED_CODE = 'placement-register-failed';

/**
 * A reference node inside a placed asset that the instancer did NOT turn into a
 * placement: the referenced asset is already on the nesting chain (a cycle) or
 * the nesting is deeper than `MAX_REFERENCE_DEPTH`. The node shows a labelled
 * placeholder (the hole you can see); the entry says why.
 */
export interface NestedReferenceRefusedReport {
  reason: NestedReferenceRefusalReason;
  /** Registry path of the refused reference node — part of the id. */
  nodePath: string;
  label: string;
  /** `sourceOf(ref).key` of the refused reference. */
  assetKey: string;
  /** Asset keys outer → inner, parent asset included. */
  chain: readonly string[];
  depth: number;
}

/** One problem per (node, reason) — a re-run of the same load replaces. */
export function nestedReferenceProblemId(nodePath: string, reason: NestedReferenceRefusalReason): string {
  return `${NESTED_REFERENCE_PROBLEM_CODES[reason]}:${nodePath}`;
}

/** Report ONE refused nested reference (cycle / depth). */
export function reportNestedReferenceRefused(m: NestedReferenceRefusedReport): void {
  const where = m.chain.length > 0 ? ` (nesting: ${[...m.chain, m.assetKey].join(' → ')})` : '';
  let title: string;
  let detail: string;
  if (m.reason === 'parametric-cycle') {
    title = `Parametric family cycle at ${m.label}`;
    detail = `Family "${m.assetKey}" places itself as a child through its nesting${where}. The child shows a placeholder - `
      + 'remove the child from the family rules or use a different child family.';
  } else if (m.reason === 'parametric-depth') {
    title = `Parametric families nested too deep at ${m.label}`;
    detail = `The child family "${m.assetKey}" would be nested deeper than 4 family levels${where}. The child shows a placeholder - `
      + 'flatten the family hierarchy.';
  } else if (m.reason === 'parametric-budget') {
    title = `Parametric child budget exceeded at ${m.label}`;
    detail = `The child family "${m.assetKey}" exceeds the combined budget of its placement (child placements or vertices over all levels)${where}. `
      + 'The child shows a placeholder - reduce the number or size of child families.';
  } else if (m.reason === 'cycle') {
    title = `Reference cycle at ${m.label}`;
    detail = `Asset "${m.assetKey}" references itself through its nesting${where}. The reference shows a placeholder — `
      + 'remove the reference from the asset, or reference a different asset.';
  } else {
    title = `Reference nesting too deep at ${m.label}`;
    detail = `The reference to "${m.assetKey}" sits ${m.depth} levels deep${where}; the viewer resolves at most `
      + `${m.depth - 1} levels. The reference shows a placeholder — flatten the asset hierarchy.`;
  }
  reportProblem({
    id: nestedReferenceProblemId(m.nodePath, m.reason),
    severity: 'error',
    code: NESTED_REFERENCE_PROBLEM_CODES[m.reason],
    title,
    detail,
    nodePath: m.nodePath,
  });
}

/** The placement cap of a load was hit — ONE aggregated report (F9). */
export interface PlacementCapReport {
  cap: number;
  /** Nested references refused so far in this load. */
  refused: number;
  /** Registry paths of the first refused reference nodes (≤ 5). */
  nodePaths: readonly string[];
}

/** The fixed id of the one cap entry per document. */
export const PLACEMENT_CAP_PROBLEM_ID = PLACEMENT_CAP_PROBLEM_CODE;

/**
 * Report the placement cap — idempotent per document: a later scan that
 * refuses more replaces the entry with the grown numbers instead of adding
 * one entry per node (a document with 3 000 refused references is ONE row).
 */
export function reportPlacementCapReached(m: PlacementCapReport): void {
  const more = m.refused > m.nodePaths.length ? `, … (+${m.refused - m.nodePaths.length} more)` : '';
  reportProblem({
    id: PLACEMENT_CAP_PROBLEM_ID,
    severity: 'warning',
    code: PLACEMENT_CAP_PROBLEM_CODE,
    title: `Placement cap reached: ${m.refused} nested reference(s) left empty`,
    detail: `This document would need more than ${m.cap} placements once every nested reference is instantiated; `
      + `${m.refused} reference(s) are left empty: ${m.nodePaths.join(', ')}${more}. Place fewer copies of the asset, `
      + 'or reference less inside it.',
    nodePath: m.nodePaths[0],
  });
}

/** A host registration threw for a materialised placement (F11). */
export interface PlacementRegisterFailedReport {
  nodePath: string;
  label: string;
  assetId: string;
  error: unknown;
}

export function placementRegisterFailedProblemId(nodePath: string): string {
  return `${PLACEMENT_REGISTER_FAILED_CODE}:${nodePath}`;
}

/** Report a placement whose runtime / host registration threw — the instance is in the scene, its wiring is not. */
export function reportPlacementRegisterFailed(m: PlacementRegisterFailedReport): void {
  const reason = m.error instanceof Error ? m.error.message : String(m.error);
  reportProblem({
    id: placementRegisterFailedProblemId(m.nodePath),
    severity: 'error',
    code: PLACEMENT_REGISTER_FAILED_CODE,
    title: `Placement ${m.label} is not wired`,
    detail: `Registering the placed asset "${m.assetId}" failed: ${reason}. Its geometry is in the scene, but its `
      + 'components, signals and nested content may not run. Reload the document; if it persists, report it.',
    nodePath: m.nodePath,
  });
}

// ─── Placement naming (plan-758) ────────────────────────────────────────

export const PLACEMENT_NAME_COLLISION_CODE = 'placement-name-collision';
export const PLACEMENT_NAME_EMPTY_CODE = 'placement-name-empty';

export function placementNameCollisionProblemId(placementId: string): string {
  return `${PLACEMENT_NAME_COLLISION_CODE}:${placementId}`;
}

/**
 * A record-driven placement (reload, legacy restore, undo/redo replay) kept its
 * recorded name although a sibling already carries it. Nothing is renamed —
 * the record is the truth — but two nodes now share a hierarchy path, and the
 * registry resolves that path to the LAST one registered.
 */
export function reportPlacementNameCollision(m: { placementId: string; name: string; nodePath?: string }): void {
  reportProblem({
    id: placementNameCollisionProblemId(m.placementId),
    severity: 'warning',
    code: PLACEMENT_NAME_COLLISION_CODE,
    title: `Two placements are named "${m.name}"`,
    detail: `The placement kept its recorded name "${m.name}", but another object under the same parent already `
      + 'has it. Both stay in the scene; the hierarchy path now resolves to only one of them. Copy or delete one '
      + 'of the two to give them distinct names.',
    ...(m.nodePath ? { nodePath: m.nodePath } : {}),
  });
}

export function placementNameEmptyProblemId(placementId: string): string {
  return `${PLACEMENT_NAME_EMPTY_CODE}:${placementId}`;
}

/** A placement record reached the save with an empty name; the fallback was written instead. */
export function reportPlacementNameEmpty(m: { placementId: string; fallback: string }): void {
  reportProblem({
    id: placementNameEmptyProblemId(m.placementId),
    severity: 'warning',
    code: PLACEMENT_NAME_EMPTY_CODE,
    title: `A placement had no name — saved as "${m.fallback}"`,
    detail: `Placement ${m.placementId} carried an empty name when the document was saved. It was written as `
      + `"${m.fallback}" so the file stays loadable. This should not happen; if it repeats, report it.`,
  });
}

/** Drop every nested-reference / cap / register-failed problem — the document changed. */
export function clearNestedReferenceProblems(): void {
  for (const code of Object.values(NESTED_REFERENCE_PROBLEM_CODES)) clearProblemsOfCode(code);
  clearProblemsOfCode(PLACEMENT_CAP_PROBLEM_CODE);
  clearProblemsOfCode(PLACEMENT_REGISTER_FAILED_CODE);
  // plan-774: per-document as well (F11 legacy content, F3 join budget).
  clearProblemsOfCode(REFERENCE_CONTENT_DISCARDED_CODE);
  clearProblemsOfCode(PLACEMENTS_STILL_LOADING_CODE);
  clearProblemsOfCode(REPLAY_OP_SKIPPED_CODE);
}

// ─── Editor loads defer references (plan-774) ───────────────────────────

/**
 * Problem code (F11): a non-embedded reference node of the file already carried
 * children. A reference is a placement — its content comes from the referenced
 * asset — so the stored children (an old double-graft, a hand edit) were
 * discarded at load instead of being shown twice.
 */
export const REFERENCE_CONTENT_DISCARDED_CODE = 'reference-content-discarded';

/** One entry per reference node; a re-load replaces. */
export function referenceContentDiscardedProblemId(nodePath: string): string {
  return `${REFERENCE_CONTENT_DISCARDED_CODE}:${nodePath}`;
}

/** Report the stored children of one reference node that the load discarded. */
export function reportReferenceContentDiscarded(m: { nodePath: string; label: string; count: number }): void {
  reportProblem({
    id: referenceContentDiscardedProblemId(m.nodePath),
    severity: 'warning',
    code: REFERENCE_CONTENT_DISCARDED_CODE,
    title: `Stored content under reference ${m.label} was ignored`,
    detail: `The reference node "${m.label}" carried ${m.count} child node${m.count === 1 ? '' : 's'} in the file. `
      + 'A reference shows the content of the asset it points at, so the stored copy was not loaded — '
      + 'otherwise it would appear twice. Saving the document writes the reference without it. To change '
      + 'the referenced asset, open it (double-click the reference) and edit it there.',
    nodePath: m.nodePath,
  });
}

/**
 * Problem code (F3): the editor's authoring join ran out of its time budget
 * before every placed reference was materialised. The editor is usable; edits
 * inside placed content wait until the references have arrived.
 */
export const PLACEMENTS_STILL_LOADING_CODE = 'placements-still-loading';

/** Report that the placements of the open document are still loading. ONE entry per document. */
export function reportPlacementsStillLoading(m: { label: string; pending: number; total: number }): void {
  reportProblem({
    id: PLACEMENTS_STILL_LOADING_CODE,
    severity: 'warning',
    code: PLACEMENTS_STILL_LOADING_CODE,
    title: `${m.pending} of ${m.total} placed reference${m.total === 1 ? '' : 's'} still loading`,
    detail: `"${m.label}" opened before all of its placed references were ready. They keep loading in the `
      + 'background; changes inside them are applied once they have arrived. If this entry does not go away, '
      + 'a referenced file could not be fetched — reopen the document.',
  });
}

/** Drop the still-loading entry — the placements arrived, or the document changed. */
export function clearPlacementsStillLoading(): void {
  clearProblemsOfCode(PLACEMENTS_STILL_LOADING_CODE);
}

/**
 * Problem code (F8): a replayed edit (recovered draft, undo-by-recompose,
 * projection switch) targets a node INSIDE a placed reference that is not
 * there — typically an old draft whose path pointed into grafted CAD parts
 * that the placed asset's bake merges away. The edit was not applied.
 */
export const REPLAY_OP_SKIPPED_CODE = 'replay-op-skipped';

/** One skipped op as the replay reports it. */
export interface ReplayOpSkippedReport {
  /** The op kind (`setField`, …). */
  kind: string;
  /** The target path the op carried. */
  nodePath: string;
  /**
   * Why it did not land (plan-774 review fix E4): `baked-away` (default) — the
   * placement is there, its bake merged the node away; `not-loaded` — the
   * placement did not materialise (placeholder), the edit is kept; `still-loading`
   * — the placement was still materialising when the wait ran out, the edit is kept.
   */
  reason?: 'baked-away' | 'not-loaded' | 'still-loading';
}

/** The problem id of a skipped replay op — one per (path, op kind). */
export function replayOpSkippedProblemId(nodePath: string, kind: string): string {
  return `${REPLAY_OP_SKIPPED_CODE}:${nodePath}:${kind}`;
}

/** Report the ops of one replay that were skipped under a reference — one entry per (path, kind). */
export function reportReplayOpsSkipped(skips: readonly ReplayOpSkippedReport[], documentLabel: string): void {
  const byId = new Map<string, { m: ReplayOpSkippedReport; count: number }>();
  for (const m of skips) {
    const id = replayOpSkippedProblemId(m.nodePath, m.kind);
    const hit = byId.get(id);
    if (hit) hit.count++;
    else byId.set(id, { m, count: 1 });
  }
  for (const [id, { m, count }] of byId) {
    const edits = `${count === 1 ? 'A recorded edit' : `${count} recorded edits`} (${m.kind}) of "${documentLabel}" target`;
    const reason = m.reason ?? 'baked-away';
    const detail = reason === 'baked-away'
      ? `${edits} "${m.nodePath}", which lies inside a placed asset and does not exist there. A placed asset is baked: `
        + 'only nodes with a component stay addressable. The edit was skipped. To make it, open that asset '
        + '(double-click the reference) and change it there.'
      : reason === 'not-loaded'
        ? `${edits} "${m.nodePath}", inside a placed asset that is not loaded (its file could not be opened). `
          + 'The edit was not applied, but it is kept: it applies as soon as the asset loads again.'
        : `${edits} "${m.nodePath}", inside a placed asset that is still loading. `
          + 'The edit was not applied yet, but it is kept: reopen the document once the asset has loaded.';
    reportProblem({
      id,
      severity: 'warning',
      code: REPLAY_OP_SKIPPED_CODE,
      title: reason === 'baked-away'
        ? `Edit not applied: ${m.kind} on ${m.nodePath}`
        : `Edit not applied (placement ${reason === 'not-loaded' ? 'not loaded' : 'still loading'}): ${m.kind} on ${m.nodePath}`,
      detail,
      nodePath: m.nodePath,
    });
  }
}

// ─── Plugin bake claims on a placement (plan-757 §2.6 / D5) ─────────────

/**
 * A `RVViewerPlugin.bakeClaims()` claim whose path lies inside a PLACEMENT.
 * Claims are a main-model input only (D5): a placed asset is baked by the
 * `ModelCache` without a plugin layer, so the claim kept nothing there.
 */
export interface PluginClaimNotApplicableReport {
  /** Registry path of the placement root — part of the id. */
  nodePath: string;
  label: string;
  assetId: string;
  claimPath: string;
  role: string;
  pluginId?: string;
}

export function pluginClaimNotApplicableProblemId(nodePath: string, claimPath: string): string {
  return `plugin-claim-not-applicable:${nodePath}:${claimPath}`;
}

export function reportPluginClaimNotApplicable(m: PluginClaimNotApplicableReport): void {
  reportProblem({
    id: pluginClaimNotApplicableProblemId(m.nodePath, m.claimPath),
    severity: 'info',
    code: 'plugin-claim-not-applicable',
    title: `Plugin claim not applied inside placement ${m.label}`,
    detail: `${m.pluginId ? `Plugin "${m.pluginId}"` : 'A plugin'} claims "${m.claimPath}" (${m.role}), which lies inside `
      + `the placed asset "${m.assetId}". Bake claims are a main-model input only — a placement is baked without a `
      + 'plugin layer, so the claim kept nothing. Give the node a component or a `BakeRole` in the asset\'s own file.',
    nodePath: m.nodePath,
  });
}

export function clearPluginClaimProblems(): void {
  clearProblemsOfCode('plugin-claim-not-applicable');
}

// ─── Failed bake (plan-757 mental model 6 / D7, Phase 3 commit A) ────────

/**
 * One asset whose destructive bake threw. There is no unbaked runtime to fall
 * back to: the load rejects (`BakeFailedError`, rv-scene-loader.ts) and this
 * entry is what tells the user WHICH file and WHY — the console is the only
 * other place the cause goes, and on mobile it is invisible. An ABORT
 * (`BakeAbortedError`, a superseded load) is never reported here.
 */
export interface BakeFailedReport {
  /** The asset's id — the url the bytes came from. Part of the id. */
  assetId: string;
  /** The thrown error's message. */
  message: string;
}

/** The problem id of a failed bake — the asset id, verbatim. */
export function bakeFailedProblemId(assetId: string): string {
  return `bake-failed:${assetId}`;
}

/** Report ONE failed bake. Re-reporting the same asset replaces. */
export function reportBakeFailed(m: BakeFailedReport): void {
  reportProblem({
    id: bakeFailedProblemId(m.assetId),
    severity: 'error',
    code: 'bake-failed',
    title: `Model could not be baked: ${m.assetId}`,
    detail: `The bake of "${m.assetId}" failed: ${m.message || 'unknown error'}. The model was not loaded — `
      + 'there is no unbaked runtime to fall back to. Re-export or repair the file; if the failure is a viewer '
      + 'defect, report it together with the console output.',
  });
}

/** Drop every failed-bake problem — the document changed. */
export function clearBakeFailedProblems(): void {
  clearProblemsOfCode('bake-failed');
}

// ─── Editor test run could not restore the authoring scene (2026-11-06) ──

/** Problem code: a stopped editor test run could not put the authoring scene back. */
export const EDITOR_TEST_RESTORE_FAILED_CODE = 'editor-test-restore-failed';

/**
 * Report that the editor is still showing the TEST COPY of a document.
 *
 * Without this the failure was a console line and a toast: the editor kept
 * running on the copy, whose paths and names differ from the document, and
 * every later measurement, edit and save worked on the wrong scene without a
 * visible reason. Retired by the next load (`clearModel`) — reloading the
 * original document is exactly the remedy the entry names.
 */
export function reportEditorTestRestoreFailed(documentName: string, message: string): void {
  reportProblem({
    id: `${EDITOR_TEST_RESTORE_FAILED_CODE}:${documentName}`,
    severity: 'error',
    code: EDITOR_TEST_RESTORE_FAILED_CODE,
    title: 'Editor is still on the test copy - reload the original',
    detail: `Stopping the test run of "${documentName}" could not restore the editor: ${message || 'unknown error'}. `
      + 'The scene on screen is the test copy, not the document. Reload the original document before you edit, '
      + 'measure or save; your authored changes are kept in the document draft.',
  });
}

/** Drop the entry — the next load replaced the scene. */
export function clearEditorTestRestoreProblems(): void {
  clearProblemsOfCode(EDITOR_TEST_RESTORE_FAILED_CODE);
}

// ─── References lost by a save (plan-765 F5) ────────────────────────────

/** Problem code of the save guard: the written file resolves fewer references than the document it came from. */
export const SAVE_REFERENCE_LOSS_CODE = 'save-reference-loss';

/** The problem id of a save's reference loss — one per document, so the next save replaces or clears it. */
export function saveReferenceLossProblemId(documentId: string): string {
  return `${SAVE_REFERENCE_LOSS_CODE}:${documentId}`;
}

/**
 * Report that a save wrote a file in which `after - before` more references are
 * unresolved than in the tree it was written from (warning). The file WAS
 * written — the guard never blocks (plan-765 decision Q5); this entry is how
 * the user learns the file lost something. `byField` is the per-field increase
 * (`Component.field` → count). A non-positive delta clears instead.
 *
 * Not cleared on a model change (unlike the load-time codes): it describes a
 * FILE that now exists, and the next save of the same document is what retires it.
 */
export function reportSaveReferenceLoss(
  documentId: string,
  before: number,
  after: number,
  byField: Readonly<Record<string, number>>,
): void {
  const delta = after - before;
  if (delta <= 0) { clearSaveReferenceLoss(documentId); return; }
  const fields = Object.entries(byField)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
  reportProblem({
    id: saveReferenceLossProblemId(documentId),
    severity: 'warning',
    code: SAVE_REFERENCE_LOSS_CODE,
    title: `Save left ${delta} reference(s) unresolved`,
    detail: `The file written for "${documentId}" has ${after} unresolved reference(s), the document it was saved `
      + `from had ${before}${fields ? ` — ${fields}` : ''}. The file was written; the lost references name nodes `
      + 'under a spelling the file no longer contains. Keep the previous file, and report this together with it.',
  });
}

/** Drop the reference-loss entry of one document — its latest save lost nothing. */
export function clearSaveReferenceLoss(documentId: string): void {
  clearProblem(saveReferenceLossProblemId(documentId));
}

// ─── Duplicate asset ids (plan-703 §2.5, Phase 5) ───────────────────────

/** One id claimed by more than one document, as `findLocalIdCollisions` reports it. */
export interface DocumentIdCollisionReport {
  id: string;
  /** Every path claiming the id, in manifest order. */
  paths: readonly string[];
}

/** The problem id of a collision — the claimed asset id, verbatim. */
export function documentIdCollisionProblemId(id: string): string {
  return `duplicate-asset-id:${id}`;
}

/**
 * Replace the duplicate-id problems with exactly what this project has.
 *
 * Retire-then-report, same as {@link reportMissingReferences} and for the same
 * reason: opening the same project twice reports the identical set, and two
 * notifications for an unchanged list re-render the panel for nothing.
 *
 * Reporting rather than throwing is the deliberate half of §2.5's rule. The
 * *rule* is "a collision is an error with a message, never a silent alias" —
 * {@link assertNoDocumentIdCollisions} is the throwing form, for a caller that
 * must not proceed. At project-open there is nothing to abort: the project is
 * already open and refusing to show it would be worse than showing it with a
 * problem attached. So the message lands where the user can act on it.
 */
export function reportDocumentIdCollisions(
  collisions: readonly DocumentIdCollisionReport[],
): void {
  const wanted = new Set(collisions.map(c => documentIdCollisionProblemId(c.id)));
  for (const [id, entry] of [..._entries]) {
    if (entry.code !== 'duplicate-asset-id' || wanted.has(id)) continue;
    _entries.delete(id);
    notify();
  }
  for (const collision of collisions) {
    reportProblem({
      id: documentIdCollisionProblemId(collision.id),
      severity: 'error',
      code: 'duplicate-asset-id',
      title: `Two documents claim the same id: ${collision.id}`,
      // Naming both paths is the whole value: the repair is to re-import or
      // rename ONE of them, and the user cannot pick which without seeing both.
      detail: `Claimed by ${collision.paths.map(p => `"${p}"`).join(' and ')}. `
        + 'A copied file must get its own id — rename or re-import one of them.',
    });
  }
}

// ─── FMU components (plan-498) ──────────────────────────────────────────

/** Problem codes of the `Fmu` component. */
export const FMU_PROBLEM_CODES = {
  /** info — the FMU is shown but cannot run: no CONNECT transport (standalone). */
  notRunnable: 'fmu-not-runnable',
  /** info — variables of a type the viewer has no signal for (String). */
  variableUnsupported: 'fmu-variable-unsupported',
  /** warning — no package attached, or the package bytes are missing. */
  unsupported: 'fmu-unsupported',
  /** warning — CONNECT's parse of modelDescription.xml differs from the browser's (CONNECT wins). */
  metadataDrift: 'fmu-metadata-drift',
  /** error — provisioning or the running FMU failed in CONNECT (plan-498 Phase 3). */
  error: 'fmu-error',
  /** info — a stored start-value override matches no allowed variable of the package (plan-502). */
  overrideOrphaned: 'fmu-override-orphaned',
} as const;

/** Identity of one FMU instance in the Problems panel. */
export interface FmuProblemSubject {
  /** `RVFmu.instanceKey` — one problem entry per instance and code. */
  instanceKey: string;
  nodePath: string;
  /** Node name shown in the title. */
  label: string;
  modelName: string;
}

function fmuProblemId(code: string, instanceKey: string): string {
  return `${code}:${instanceKey}`;
}

/** Standalone (or a non-CONNECT transport): the FMU is visible but does not run. */
export function reportFmuNotRunnable(m: FmuProblemSubject): void {
  reportProblem({
    id: fmuProblemId(FMU_PROBLEM_CODES.notRunnable, m.instanceKey),
    severity: 'info',
    code: FMU_PROBLEM_CODES.notRunnable,
    title: `${m.label} — FMU not runnable in standalone mode`,
    detail: `The FMU "${m.modelName || m.label}" is a compiled native binary and only runs in realvirtual CONNECT. `
      + 'Its signals show their start values until the viewer is connected to CONNECT.',
    nodePath: m.nodePath,
  });
}

/** Variables without a signal type (String) — listed, never silently dropped. */
export function reportFmuVariablesUnsupported(m: FmuProblemSubject & { variables: readonly string[] }): void {
  if (m.variables.length === 0) {
    clearProblem(fmuProblemId(FMU_PROBLEM_CODES.variableUnsupported, m.instanceKey));
    return;
  }
  reportProblem({
    id: fmuProblemId(FMU_PROBLEM_CODES.variableUnsupported, m.instanceKey),
    severity: 'info',
    code: FMU_PROBLEM_CODES.variableUnsupported,
    title: `${m.label} — ${m.variables.length} FMU variable(s) without signal`,
    detail: `Not supported as signals (v1 maps Real/Integer/Enumeration/Boolean only): ${m.variables.join(', ')}.`,
    nodePath: m.nodePath,
  });
}

/** No package attached, or its bytes are missing (saved without them). */
export function reportFmuUnsupported(m: FmuProblemSubject & { reason: string }): void {
  reportProblem({
    id: fmuProblemId(FMU_PROBLEM_CODES.unsupported, m.instanceKey),
    severity: 'warning',
    code: FMU_PROBLEM_CODES.unsupported,
    title: `${m.label} — FMU cannot be used`,
    detail: `${m.reason} Attach the .fmu again in the editor (Attach FMU…).`,
    nodePath: m.nodePath,
  });
}

/** The FMU failed in CONNECT (upload, trust, instance or the worker itself). */
export function reportFmuError(m: FmuProblemSubject & { reason: string }): void {
  reportProblem({
    id: fmuProblemId(FMU_PROBLEM_CODES.error, m.instanceKey),
    severity: 'error',
    code: FMU_PROBLEM_CODES.error,
    title: `${m.label} — FMU failed in CONNECT`,
    detail: m.reason,
    nodePath: m.nodePath,
  });
}

/**
 * CONNECT's parse of the package differs from the browser's (plan-498
 * decision log: CONNECT is authoritative). `detail` names what differs.
 */
export function reportFmuMetadataDrift(m: FmuProblemSubject & { detail: string }): void {
  reportProblem({
    id: fmuProblemId(FMU_PROBLEM_CODES.metadataDrift, m.instanceKey),
    severity: 'warning',
    code: FMU_PROBLEM_CODES.metadataDrift,
    title: `${m.label} — FMU variables differ between the viewer and CONNECT`,
    detail: `${m.detail} CONNECT's parse is authoritative; re-attach the .fmu in the editor to refresh the viewer's copy.`,
    nodePath: m.nodePath,
  });
}

/**
 * Start-value overrides that match no allowed variable (renamed/removed after a
 * re-attach, type changed, not overridable). They stay in the document but are
 * never sent to CONNECT; the inspector shows them as conflict rows (plan-502).
 */
export function reportFmuOverridesOrphaned(m: FmuProblemSubject & { overrides: readonly string[] }): void {
  const id = fmuProblemId(FMU_PROBLEM_CODES.overrideOrphaned, m.instanceKey);
  if (m.overrides.length === 0) {
    clearProblem(id);
    return;
  }
  reportProblem({
    id,
    severity: 'info',
    code: FMU_PROBLEM_CODES.overrideOrphaned,
    title: `${m.label} — ${m.overrides.length} start-value override(s) without a matching FMU variable`,
    detail: `Not applied: ${m.overrides.join(', ')}. Remove them in the inspector (FMU › Conflicts) or attach a package that has these variables.`,
    nodePath: m.nodePath,
  });
}

/** Drop every FMU problem of one instance (it was disposed or re-initialised). */
export function clearFmuProblems(instanceKey: string): void {
  for (const code of Object.values(FMU_PROBLEM_CODES)) clearProblem(fmuProblemId(code, instanceKey));
}

// ─── Signal units at a binding (plan-512) ──────────────────────────────

/** Problem codes of the unit auto-scale (plan-512 F7). */
export const UNIT_PROBLEM_CODES = Object.freeze({
  /** Signal unit and slot unit are not convertible by a factor (rad → mm, degC → K). */
  mismatch: 'unit-mismatch',
  /** The signal's unit is known to neither its source nor the built-in table. */
  unknown: 'unit-unknown',
  /** A scale field shared by several slots would need two different factors. */
  conflict: 'unit-scale-conflict',
  /** The factor is right but the feedback formula would ignore or distort it. */
  notEffective: 'unit-scale-not-effective',
  /** v1 boundary: the target (a planner placement) takes no automatic write. */
  notApplied: 'unit-scale-not-applied',
});

const UNIT_PROBLEM_PREFIX = 'unit:';

/**
 * The problem id of one bound slot — stable across reloads, so a reconcile
 * replaces instead of appending: `unit:<targetId>:<componentPath>:<slot>`.
 */
export function unitProblemId(targetId: string, componentPath: string, slot: string): string {
  return `${UNIT_PROBLEM_PREFIX}${targetId}:${componentPath}:${slot}`;
}

/** Report (or re-report) the unit problem of one bound slot. */
export function reportUnitProblem(m: {
  id: string;
  code: string;
  title: string;
  detail: string;
  nodePath?: string;
  severity?: ProblemSeverity;
}): void {
  reportProblem({
    id: m.id,
    severity: m.severity ?? 'warning',
    code: m.code,
    title: m.title,
    detail: m.detail,
    ...(m.nodePath !== undefined ? { nodePath: m.nodePath } : {}),
  });
}

/** Drop the unit problem of one bound slot. No-op when there is none. */
export function clearUnitProblem(id: string): void {
  clearProblem(id);
}

/** Ids of the unit problems currently listed for one target. */
export function unitProblemIdsOf(targetId: string): string[] {
  const prefix = `${UNIT_PROBLEM_PREFIX}${targetId}:`;
  const out: string[] = [];
  for (const id of _entries.keys()) if (id.startsWith(prefix)) out.push(id);
  return out;
}

/** Drop every unit problem — of one target, or (no argument) all of them (model switch). */
export function clearUnitProblems(targetId?: string): void {
  const prefix = targetId === undefined ? UNIT_PROBLEM_PREFIX : `${UNIT_PROBLEM_PREFIX}${targetId}:`;
  let removed = false;
  for (const id of [..._entries.keys()]) {
    if (!id.startsWith(prefix)) continue;
    _entries.delete(id);
    removed = true;
  }
  if (removed) notify();
}

// ─── Grip: seat occupied (plan-577 F7/F8) ───────────────────────────────

/** Code of the "seat occupied" warning a Grip raises at a `LoadOnCarrier` GripTarget. */
export const SEAT_OCCUPIED_CODE = 'grip-seat-occupied';

/** One id per grip + target: a repeated place flank replaces, never appends. */
export function seatOccupiedProblemId(gripKey: string, targetKey: string): string {
  return `${SEAT_OCCUPIED_CODE}:${gripKey}:${targetKey}`;
}

/** What a refused `LoadOnCarrier` place reports. Names, not objects — no engine import. */
export interface SeatOccupiedReport {
  id: string;
  grip: string;
  target: string;
  part: string;
  /** The MU the part would have rested on, when one was found. */
  carrier: string | null;
  /** The MU in the way (the second seat when `ambiguous`). */
  obstacle: string;
  /** The part would rest on two MUs at once. */
  ambiguous: boolean;
}

/** Report (or re-report — same id replaces) a refused place as a warning. */
export function reportSeatOccupied(r: SeatOccupiedReport): void {
  const where = r.carrier ? `target ${r.target} on carrier ${r.carrier}` : `target ${r.target}`;
  const why = r.ambiguous
    ? `${where} is ambiguous: part ${r.part} would rest on both ${r.carrier ?? '?'} and ${r.obstacle}.`
    : `${where} is occupied by ${r.obstacle}.`;
  reportProblem({
    id: r.id,
    severity: 'warning',
    code: SEAT_OCCUPIED_CODE,
    title: 'Grip could not place part — seat occupied',
    detail: `Grip ${r.grip}: ${why} Part ${r.part} stays in the gripper.`,
  });
}

/** Drop every "seat occupied" warning (simulation reset, model unload). */
export function clearSeatOccupiedProblems(): void {
  clearProblemsOfCode(SEAT_OCCUPIED_CODE);
}

// ─── Robot IK: the degradations that used to be silent ──────────────────

/**
 * Problem codes of the robot IK (`RobotIK`, `IKPath`, `IKTarget`).
 *
 * Every one of these was a `console.warn` at best and a bare `return null` at
 * worst. A rig whose kinematic chain cannot be derived, whose TCP does not
 * resolve, or whose OPW parameters are unusable keeps replaying its baked joint
 * angles and therefore LOOKS like it works: there is no LIN motion, no
 * interactive re-solve and no honest reachability colouring, and nothing said
 * so. These entries are the saying-so — none of them changes what the IK
 * computes.
 *
 * Severity follows one rule: an entry is an `error` when the IK cannot do its
 * job for that robot (no chain, no tool pose, no analytic parameters, no axes),
 * and a `warning` when the motion still runs but is quietly less than it looks
 * (a wrist type guessed from the default, one waypoint without baked angles).
 */
export const IK_PROBLEM_CODES = Object.freeze({
  /** error — `RobotIK.Axis` resolved to no drives at all: the robot cannot move. */
  axesUnresolved: 'robot-ik-axes-unresolved',
  /** error — the axes are there but no serial 6-revolute chain can be derived from them. */
  chainUnresolved: 'robot-ik-chain-unresolved',
  /** error — `RobotIK.TCP` is written in the file but resolves to no node. */
  tcpUnresolved: 'robot-ik-tcp-unresolved',
  /** error — no usable OPW parameters (no finite `a1`): no LIN, no reach colouring. */
  opwUnusable: 'robot-ik-opw-unusable',
  /** warning — no `WristType` in the file, so the `Spherical` default is assumed. */
  wristTypeMissing: 'robot-ik-wrist-type-missing',
  /** warning — an `IKTarget` carries no usable `AxisPos`; the waypoint moves nothing. */
  targetNoAngles: 'robot-ik-target-no-angles',
});

/** Identity of one robot (or one IK path) in the Problems panel. */
export interface RobotIkProblemSubject {
  /** Node path of the reporting node — the id component, and what the user searches for. */
  nodePath: string;
  /** Node name shown in the title. */
  label: string;
}

/** One entry per subject and code: a second load replaces, never appends. */
function ikProblemId(code: string, nodePath: string): string {
  return `${code}:${nodePath}`;
}

/** `RobotIK.Axis` named no resolvable drive — nothing can move this robot. */
export function reportRobotIkAxesUnresolved(m: RobotIkProblemSubject & { declared: number }): void {
  reportProblem({
    id: ikProblemId(IK_PROBLEM_CODES.axesUnresolved, m.nodePath),
    severity: 'error',
    code: IK_PROBLEM_CODES.axesUnresolved,
    title: `${m.label} — robot has no axis drives`,
    detail: m.declared > 0
      ? `RobotIK.Axis lists ${m.declared} entr${m.declared === 1 ? 'y' : 'ies'}, none of which resolves to a Drive component. `
        + 'The robot cannot move at all: no replay, no LIN, no interactive solve. '
        + 'Re-export the robot with its Axis references assigned, or repair them in the editor.'
      : 'RobotIK.Axis is empty or missing in the file. The robot cannot move at all: no replay, no LIN, '
        + 'no interactive solve. Assign Axis[0..5] on the RobotIK component and export again.',
    nodePath: m.nodePath,
  });
}

/**
 * No serial 6-revolute chain could be derived from the axis drives.
 *
 * `reason` is not optional padding: without it the entry says "it broke" and
 * leaves the user with the whole rig to search. The deriving code knows exactly
 * which axis failed and why, so it says so.
 */
export function reportRobotIkChainUnresolved(m: RobotIkProblemSubject & { reason: string }): void {
  reportProblem({
    id: ikProblemId(IK_PROBLEM_CODES.chainUnresolved, m.nodePath),
    severity: 'error',
    code: IK_PROBLEM_CODES.chainUnresolved,
    title: `${m.label} — kinematic chain cannot be derived`,
    detail: `${m.reason} Without a chain the robot only replays its baked joint angles: no linear (LIN) motion, `
      + 'no interactive re-solve, and reachability cannot be checked. The axis nodes must be nested inside one '
      + 'another in axis order (each axis a descendant of the previous one, axis 0 a descendant of the robot).',
    nodePath: m.nodePath,
  });
}

/** `RobotIK.TCP` is written in the file but names no node in the loaded scene. */
export function reportRobotIkTcpUnresolved(m: RobotIkProblemSubject & { written: string }): void {
  reportProblem({
    id: ikProblemId(IK_PROBLEM_CODES.tcpUnresolved, m.nodePath),
    severity: 'error',
    code: IK_PROBLEM_CODES.tcpUnresolved,
    title: `${m.label} — TCP reference resolves to nothing`,
    detail: `RobotIK.TCP is written as "${m.written}", which names no node in the loaded document. `
      + 'The tool pose silently collapses onto the axis-6 flange, so every solved and every reported pose is '
      + 'off by the whole tool length and orientation. Check that the TCP node exists and survives the load.',
    nodePath: m.nodePath,
  });
}

/** `getOpwParams()` is null — the analytic parameters are absent or not finite. */
export function reportRobotIkOpwUnusable(m: RobotIkProblemSubject): void {
  reportProblem({
    id: ikProblemId(IK_PROBLEM_CODES.opwUnusable, m.nodePath),
    severity: 'error',
    code: IK_PROBLEM_CODES.opwUnusable,
    title: `${m.label} — no usable OPW parameters`,
    detail: 'The RobotIK extras carry no finite `a1`, so the analytic (OPW/Pieper) parameters are unusable. '
      + 'Linear (LIN) segments fall back to joint-space replay and waypoint reachability cannot be decided — '
      + 'its markers are shown as unknown rather than reachable. Re-export the robot from Unity with its '
      + 'OPW parameters computed.',
    nodePath: m.nodePath,
  });
}

/** No `WristType` in the file: the default is `Spherical`, which may be the wrong model. */
export function reportRobotIkWristTypeMissing(m: RobotIkProblemSubject & { assumed: string }): void {
  reportProblem({
    id: ikProblemId(IK_PROBLEM_CODES.wristTypeMissing, m.nodePath),
    severity: 'warning',
    code: IK_PROBLEM_CODES.wristTypeMissing,
    title: `${m.label} — no WristType in the file, assuming ${m.assumed}`,
    detail: `The RobotIK extras carry no WristType, so "${m.assumed}" is assumed. A cobot (non-spherical wrist) `
      + 'exported before this field existed is then solved with the wrong kinematic model, which lands near the '
      + 'target instead of on it. Set WristType on the RobotIK component and export again.',
    nodePath: m.nodePath,
  });
}

/** An `IKTarget` the replay has to skip because it carries no usable `AxisPos`. */
export function reportIkTargetNoAngles(m: RobotIkProblemSubject & { pathLabel: string; axisCount: number }): void {
  reportProblem({
    id: ikProblemId(IK_PROBLEM_CODES.targetNoAngles, m.nodePath),
    severity: 'warning',
    code: IK_PROBLEM_CODES.targetNoAngles,
    title: `${m.label} — waypoint without baked joint angles`,
    detail: `IKPath "${m.pathLabel}" reaches this target with no usable AxisPos for its ${m.axisCount} axes `
      + '(absent, too short, or all zero). The waypoint is skipped: the drives stay where they are and the path '
      + 'continues to the next target, so the robot silently visits a different pose sequence. '
      + 'Solve the path in Unity and export again.',
    nodePath: m.nodePath,
  });
}

/** Drop every IK problem of one subject (a fresh diagnosis replaces it). */
export function clearRobotIkProblems(nodePath: string): void {
  for (const code of Object.values(IK_PROBLEM_CODES)) clearProblem(ikProblemId(code, nodePath));
}

/** Drop every IK problem of the document (model switch). */
export function clearIkProblems(): void {
  for (const code of Object.values(IK_PROBLEM_CODES)) clearProblemsOfCode(code);
}

/** Test seam: restore the module to its initial state. */
export function resetProblemsForTests(): void {
  _entries.clear();
  _listeners.clear();
  _snapshot = [];
  _dirty = true;
  _announcement = null;
}

/** Stable subject key; independent of elapsed time and explanatory text. */
export function blockageProblemId(cls: string, chainKey: string): string {
  return `blockage-${cls}:${chainKey}`;
}
export const BLOCKAGE_PROBLEM_CODES = Object.freeze({
  deadlock: 'blockage-deadlock', stall: 'blockage-stall', coverage: 'blockage-coverage-gap',
});
export function clearBlockageProblems(): void {
  clearProblemsOfCode('blockage-deadlock');
  clearProblemsOfCode('blockage-stall');
  clearProblemsOfCode('blockage-coverage-gap');
}

// ─── Collision start overlaps (plan-781 F6/F7) ─────────────────────────

/** Two still bodies overlap in the authored layout — never an alarm. */
export const COLLISION_AUTHORED_OVERLAP_CODE = 'collision-authored-overlap';
/** A pair touched in the start pose — quiet until it separates once. */
export const COLLISION_START_OVERLAP_CODE = 'collision-start-overlap';

/** One quiet pair of a collision overlap entry. */
export interface CollisionOverlapPair {
  aLabel: string;
  aRole: string;
  bLabel: string;
  bRole: string;
}

/** At most this many pairs are spelled out in one entry's detail. */
const COLLISION_OVERLAP_LISTED = 20;

/**
 * Report (or replace) the ONE entry of `code` listing the quiet pairs — info,
 * `quiet: true` (the panel does not open by itself). `nodePath` is the real
 * node path of the first pair's body, never a chunk or partition path
 * (contract bake-picking rules 12/13). An empty list clears the entry.
 */
export function reportCollisionOverlaps(
  code: 'collision-authored-overlap' | 'collision-start-overlap',
  pairs: readonly CollisionOverlapPair[],
  nodePath: string | undefined,
): void {
  if (pairs.length === 0) {
    clearProblem(code);
    return;
  }
  const listed = pairs.slice(0, COLLISION_OVERLAP_LISTED)
    .map((p) => `${p.aLabel} (${p.aRole}) ↔ ${p.bLabel} (${p.bRole})`);
  const more = pairs.length - listed.length;
  const authored = code === COLLISION_AUTHORED_OVERLAP_CODE;
  reportProblem({
    id: code,
    severity: 'info',
    code,
    title: authored
      ? `Collision: parts overlap in the authored layout (${pairs.length})`
      : `Collision: parts touch in the start pose (${pairs.length}) — quiet until they separate`,
    detail: listed.join(' · ') + (more > 0 ? ` · and ${more} more` : '')
      + (authored
        ? '. Neither part moves, so this is never reported as a collision.'
        : '. These pairs raise no collision until they have been apart once.'),
    ...(nodePath ? { nodePath } : {}),
    quiet: true,
  });
}

/** Model change: drop both collision overlap entries. */
export function clearCollisionOverlapProblems(): void {
  clearProblemsOfCode(COLLISION_AUTHORED_OVERLAP_CODE);
  clearProblemsOfCode(COLLISION_START_OVERLAP_CODE);
}
