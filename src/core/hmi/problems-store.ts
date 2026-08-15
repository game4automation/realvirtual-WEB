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
    && previous.nodePath === entry.nodePath) {
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
  for (const m of missing) {
    reportProblem({
      id: missingReferenceProblemId(m.occurrence),
      severity: 'error',
      code: 'missing-reference',
      title: `Referenced asset not found: ${m.label}`,
      detail: missingReferenceDetail(m),
      nodePath: m.nodePath,
    });
  }
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

/** Test seam: restore the module to its initial state. */
export function resetProblemsForTests(): void {
  _entries.clear();
  _listeners.clear();
  _snapshot = [];
  _dirty = true;
}
