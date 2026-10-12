// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-recents-store — the persisted half of the recent-documents ring
 * (plan-478 Phase 1/2).
 *
 * Best-effort in both directions, the rule `rv-project-resume-store.ts` sets:
 * a private-mode `localStorage`, a quota error or a hand-edited entry is
 * "nothing remembered", never a crash and never a reason for an open to fail.
 *
 * ## The mode a ring entry carries (plan-478 F1b, SOL R2 F1/F4)
 *
 * "The mode the document was last USED in" cannot be read off `activeMode` at
 * the moment the document loads, because two of the three ways a document
 * opens are moving through a mode that is not the answer:
 *
 *  - the **editor handoff** (`openDocumentAsWorkingScene`) LEAVES editor mode
 *    before the load and re-enters after it, so `activeMode` during the load
 *    is a transitional `viewer`/`hmi` that belongs to nobody;
 *  - the **recents chain** activates its target mode LAST (it has to — the
 *    target may be `viewer`, which unmounts the host mid-chain), so
 *    `activeMode` during the load is still the mode the user came FROM.
 *
 * Two mechanisms cover the two, and neither covers both:
 *
 *  1. {@link withOpenIntentMode} — a scope the handoff opens around its whole
 *     leave/load/re-enter dance. Inside it, a record takes the INTENDED mode
 *     rather than the live one, and {@link retagOpenDocumentMode} is inert, so
 *     the transitional `setMode` cannot land on the document being LEFT (which
 *     is still the ring's head while the new one loads — SOL R2 F4).
 *  2. {@link retagOpenDocumentMode} — driven by the viewer's `mode-changed`
 *     event OUTSIDE any such scope. This is what stamps the recents chain's
 *     target mode onto the document it just opened, and what keeps the ring
 *     honest when the user simply switches mode later.
 *
 * Both only ever re-stamp the HEAD entry, and only when the head is the
 * document that is actually open.
 */

import {
  parseRecents,
  pushRecent,
  removeRecent,
  removeRecentsOfProject,
  retagDocumentPath,
  retagHeadMode,
  serialiseRecents,
  type RecentBackend,
  type RecentDocumentEntry,
} from './rv-project-recents';

/**
 * NOT `rv-project/recent`: that key is deleted on every boot by
 * `rv-project-legacy-cleanup.ts` (plan-743). A ring stored under it would be
 * empty at every start and the cause would be invisible.
 */
export const LS_KEY_RECENT_DOCUMENTS = 'rv-project/recent-documents';

let snapshot: RecentDocumentEntry[] | null = null;
const listeners = new Set<() => void>();

function readStorage(): RecentDocumentEntry[] {
  try { return parseRecents(localStorage.getItem(LS_KEY_RECENT_DOCUMENTS)); }
  catch { return []; }
}

function writeStorage(items: readonly RecentDocumentEntry[]): void {
  try { localStorage.setItem(LS_KEY_RECENT_DOCUMENTS, serialiseRecents(items)); }
  catch { /* private mode / quota — the in-memory snapshot still stands */ }
}

function publish(items: RecentDocumentEntry[]): void {
  snapshot = items;
  for (const l of [...listeners]) { try { l(); } catch { /* never break an open */ } }
}

/**
 * Mutate through STORAGE, not through the snapshot (F9).
 *
 * A second tab may have written since this one last looked; reading first
 * costs one `getItem` and is the difference between last-writer-wins on a
 * single ENTRY and last-writer-wins on the whole ring.
 */
function mutate(fn: (items: readonly RecentDocumentEntry[]) => RecentDocumentEntry[]): void {
  const next = fn(readStorage());
  writeStorage(next);
  publish(next);
}

export function readRecents(): RecentDocumentEntry[] {
  if (snapshot === null) snapshot = readStorage();
  return snapshot;
}

export function subscribeRecents(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * Adopt a write made by ANOTHER tab (F9).
 *
 * The `storage` event fires only in the tabs that did NOT write, so this can
 * never loop back on our own `mutate`. Filtered on the key because the event
 * carries every key of the origin — including `rv-active-mode`, which this
 * screen changes constantly — and re-publishing on each of those would repaint
 * the section for nothing.
 *
 * A `null` key is the `localStorage.clear()` event: everything is gone, so the
 * honest snapshot is what storage now says, which is nothing.
 */
export function handleRecentsStorageEvent(e: { key: string | null }): void {
  if (e.key !== null && e.key !== LS_KEY_RECENT_DOCUMENTS) return;
  publish(readStorage());
}

/**
 * Listen for other tabs' writes. Returns the unsubscribe.
 *
 * Attached by the UI that displays the ring rather than at module load: a
 * headless consumer (a test, an embedding that only records) has no list to
 * keep fresh, and a listener nobody removes outlives the screen it served.
 */
export function attachRecentsStorageSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (e: StorageEvent) => handleRecentsStorageEvent(e);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener('storage', onStorage); };
}

export function forgetRecent(projectId: string, documentId: string): void {
  mutate(items => removeRecent(items, projectId, documentId));
}

export function forgetRecentsOfProject(projectId: string): void {
  mutate(items => removeRecentsOfProject(items, projectId));
}

export function clearRecents(): void {
  mutate(() => []);
}

// ─── The open-intent scope ───────────────────────────────────────────────

/**
 * The mode an in-flight open INTENDS to end in, or null outside a scope.
 *
 * A module-level token rather than a parameter because the funnel that records
 * (`SceneStore.openDocument`) sits several frames below the call site that
 * knows the intent, and threading it through every intermediate signature is
 * exactly the coupling `rememberSession` was moved into the funnel to avoid.
 *
 * Depth-counted so nesting is harmless. Concurrent handoffs would interleave,
 * which is why the recents chain holds a single in-flight lock across its whole
 * run (`open-recent-entry.ts`).
 */
interface OpenIntentScope { readonly token: symbol; readonly mode: string | null }

/**
 * The open-intent scopes that are live right now, innermost last.
 *
 * A STACK of tokens, not a depth counter and a single slot (plan-478 R3-2).
 * The counter was correct only while scopes nested perfectly, and two opens
 * that overlap do not: the handoff is async throughout, so an open that starts
 * second can finish FIRST, and a counter decremented by the wrong finaliser
 * either restores a mode that belongs to nobody or leaves the scope standing
 * forever (retagging then silently dead for the rest of the session).
 *
 * Removal is by token identity, never `pop()`, which is what makes the
 * reverse-order completion harmless. `openDocumentAsWorkingScene` additionally
 * SERIALISES handoffs so the overlap is rare — this is the correctness floor
 * under that, not a substitute for it.
 */
const intentScopes: OpenIntentScope[] = [];

/** What the current open intends to end in, or null outside a scope. */
export function currentOpenIntentMode(): string | null {
  return intentScopes.length > 0 ? intentScopes[intentScopes.length - 1].mode : null;
}

/** True while any open-intent scope is active — retagging is inert then. */
export function isOpenIntentActive(): boolean {
  return intentScopes.length > 0;
}

/**
 * Run `fn` inside an open-intent scope.
 *
 * `mode` may be null: that still SUPPRESSES retagging (the point of the scope
 * for a non-editor open) while leaving the recorded mode to the live one.
 */
export async function withOpenIntentMode<T>(
  mode: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const scope: OpenIntentScope = { token: Symbol('rv-open-intent'), mode };
  intentScopes.push(scope);
  try { return await fn(); }
  finally {
    const i = intentScopes.indexOf(scope);
    if (i >= 0) intentScopes.splice(i, 1);
  }
}

// ─── Recording ───────────────────────────────────────────────────────────

export interface RecentOpenFacts {
  projectId: string | null | undefined;
  backend: RecentBackend | null | undefined;
  documentId: string;
  documentName: string;
  /**
   * Project-relative path of the document (plan-482 F3), recorded rather than
   * resolved — see `RecentDocumentEntry.documentPath`. Every recording site
   * already holds it; a missing one is a bug the type catches, not something
   * a silent second source should paper over (§2.4).
   */
  documentPath: string;
  projectName: string;
  /** `viewer.modes.activeMode` at the moment of the open. */
  activeMode: string | null | undefined;
  /** `viewer.modes.lockedMode` — a kiosk records nothing at all (F5). */
  lockedMode?: string | null;
}

/**
 * Record an open at the head of the ring — the call `SceneStore.openDocument`
 * makes, right beside `rememberSession` (the same funnel, for the same reason:
 * `?doc=`, Save and MCP all open past the dashboard).
 *
 * The intent scope wins over the live mode; see the module comment.
 */
export function recordRecentForOpen(facts: RecentOpenFacts): void {
  if ((facts.lockedMode ?? null) !== null) return;          // kiosk: silent (F5)
  if (!facts.projectId || !facts.backend || !facts.documentId) return;
  const mode = currentOpenIntentMode() ?? facts.activeMode ?? undefined;
  const entry: RecentDocumentEntry = {
    projectId: facts.projectId,
    backend: facts.backend,
    documentId: facts.documentId,
    documentName: facts.documentName,
    documentPath: facts.documentPath,
    projectName: facts.projectName,
    mode: mode ?? undefined,
    openedAt: new Date().toISOString(),
  };
  mutate(items => pushRecent(items, entry));
}

/**
 * Re-point a ring entry after a rename or a move inside the OPEN project
 * (plan-482 Phase 1b).
 *
 * Goes through the same `mutate` path as every other write, so a second tab's
 * ring is read before it is rewritten. A no-op for anything the caller could
 * not name — a rename that produced no path is not a reason to fail a rename.
 */
export function retagRecentDocumentPath(
  projectId: string | null | undefined,
  documentId: string | null | undefined,
  path: string | null | undefined,
): void {
  if (!projectId || !documentId || !path) return;
  mutate(items => retagDocumentPath(items, projectId, documentId, path));
}

/**
 * Re-stamp the head entry after a mode change that the user actually settled
 * in. Inert inside an open-intent scope and under a kiosk lock.
 */
export function retagOpenDocumentMode(
  projectId: string | null | undefined,
  documentId: string | null | undefined,
  mode: string | null | undefined,
  lockedMode?: string | null,
): void {
  if ((lockedMode ?? null) !== null) return;
  if (isOpenIntentActive()) return;
  if (!projectId || !documentId || !mode) return;
  mutate(items => retagHeadMode(items, projectId, documentId, mode));
}

/** Minimal shape of the viewer the tracking needs — keeps this testable. */
export interface RecentsModeTrackingHost {
  on(event: 'mode-changed', cb: (data: { from: string | null; to: string }) => void): () => void;
  modes?: { lockedMode?: string | null } | null;
}

/**
 * Wire "the mode the document is used in" to the viewer's `mode-changed`.
 *
 * Returns the unsubscribe. `whatIsOpen()` answers with the currently open
 * `(projectId, documentId)` — the ring only ever retags its head, so a stale
 * answer can at worst do nothing.
 */
export function attachRecentsModeTracking(
  host: RecentsModeTrackingHost,
  whatIsOpen: () => { projectId: string | null; documentId: string | null },
): () => void {
  return host.on('mode-changed', ({ to }) => {
    const open = whatIsOpen();
    retagOpenDocumentMode(open.projectId, open.documentId, to, host.modes?.lockedMode ?? null);
  });
}

/** Tests only: drop the memoised snapshot so the next read hits storage. */
export function __resetRecentsSnapshot(): void {
  snapshot = null;
  intentScopes.length = 0;
}
