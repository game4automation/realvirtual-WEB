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
    // The action is part of the content: same headline, different argument list (the names a
    // repair would act on) is a changed entry, and the button must follow it.
    && sameAction(previous.action, entry.action)) {
    _entries.set(entry.id, previous);
    return previous;
  }
  notify();
  return entry;
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
  addressing: 'nodeId' | 'path' | 'trs';
  /** The NodeId or asset-relative path that did not resolve. */
  key: string;
  /** Component types the override would have touched (empty for a transform). */
  componentTypes: readonly string[];
  /**
   * plan-757 Phase 2b: WHY a path override orphaned when the reason is known.
   * `'nested-reference'` = the path leads into a reference node INSIDE the
   * placed asset (a nested placement): an override on the outer reference node
   * does not reach into the referenced asset's own references (F6, no byPath
   * routing for depth ≥ 2). `nestedReferencePath` names that node.
   */
  reason?: 'nested-reference';
  nestedReferencePath?: string;
}

/** The problem id of an orphaned override — one per (node, addressing, key), so a re-apply replaces. */
export function overrideOrphanedProblemId(nodePath: string, addressing: string, key: string): string {
  return `override-orphaned:${nodePath}:${addressing}:${key}`;
}

/** Report ONE orphaned override. Re-reporting the same triple replaces. */
export function reportOverrideOrphaned(m: OverrideOrphanedReport): void {
  const what = m.addressing === 'trs'
    ? `The moved part (NodeId "${m.key}")`
    : m.addressing === 'path'
      ? `The override target "${m.key}" (path relative to the asset)`
      : `The override target with NodeId "${m.key}"`;
  const fields = m.componentTypes.length > 0 ? ` for ${m.componentTypes.join(', ')}` : '';
  const detail = m.reason === 'nested-reference'
    ? `${what}${fields} leads into "${m.nestedReferencePath ?? '?'}", a reference INSIDE the placed asset "${m.assetId}" `
      + '— a nested placement. An override on this reference node does not reach into a referenced asset\'s own '
      + 'references (plan-757: no byPath routing below the first level), so it is not applied. Open the referenced '
      + 'asset and change the value there, or place the inner asset directly.'
    : `${what}${fields} does not exist in the baked asset "${m.assetId}" — the part was merged into a chunk, `
      + 'renamed, or removed from the file. The override is not applied. Give the part a component or a `BakeRole` '
      + 'in the asset, or revert the override on the reference node.';
  reportProblem({
    id: overrideOrphanedProblemId(m.nodePath, m.addressing, m.key),
    severity: 'warning',
    code: 'override-orphaned',
    title: m.reason === 'nested-reference'
      ? `Override targets a nested reference in ${m.label}`
      : `Override has no target in ${m.label}`,
    detail,
    nodePath: m.nodePath,
  });
}

/** Drop every orphaned-override problem — the document changed. */
export function clearOverrideOrphanedProblems(): void {
  clearProblemsOfCode('override-orphaned');
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
  const byCategory = new Map<string, string[]>();
  for (const entry of report.entries) {
    if (!(entry.category in RECONCILE_PROBLEM_KIND)) continue;
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
} as const;

export type NestedReferenceRefusalReason = keyof typeof NESTED_REFERENCE_PROBLEM_CODES;

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
  if (m.reason === 'cycle') {
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

/** Test seam: restore the module to its initial state. */
export function resetProblemsForTests(): void {
  _entries.clear();
  _listeners.clear();
  _snapshot = [];
  _dirty = true;
}
