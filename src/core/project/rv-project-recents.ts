// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-recents — the storage-free half of the recent-documents ring
 * (plan-478 Phase 1).
 *
 * Same split as the resume rule (`rv-project-open.ts` vs
 * `rv-project-resume-store.ts`): this module decides WHAT the ring looks like
 * given values; `rv-project-recents-store.ts` is the one place those values
 * meet `localStorage`. Keeping the decisions here is what lets the ring be
 * tested without a browser storage at all.
 *
 * Every function here is total and pure: same input, same output, no clock and
 * no storage. `openedAt` is handed IN rather than read from `Date.now()` here
 * for exactly that reason — a sort key the caller owns is a sort key a test can
 * state.
 */

export const MAX_RECENT_DOCUMENTS = 10;
export const RECENTS_SCHEMA_VERSION = 2;

/**
 * Where the project's bytes live — and therefore which verb brings it back.
 *
 * Carried per entry rather than looked up at click time because the three
 * backends have three different open verbs and one of them (`browser`) cannot
 * be reached through the folder verb at all (`openRecentProject` needs a
 * handle, plan-478 SOL R1 F4).
 */
export type RecentBackend = 'folder' | 'browser' | 'bundled';

export interface RecentDocumentEntry {
  projectId: string;
  backend: RecentBackend;
  documentId: string;
  /** Display only; re-resolved from the manifest when the project is open. */
  documentName: string;
  /**
   * Project-relative path of the document, e.g. `models/line3.glb` (plan-482 F1).
   *
   * MANDATORY, and precisely why the schema was bumped 1 -> 2: an optional
   * field would have saved the old ring but forced every reading side to
   * reckon with "maybe no path" forever. The ring is a convenience list — it
   * may be empty once (user decision 2026-09-13).
   *
   * RECORDED, not resolved: an entry regularly points at a project that is
   * CLOSED, whose manifest is not available at render time (plan-482 §2.3).
   */
  documentPath: string;
  projectName: string;
  /**
   * The ModeId the document was last USED in (F1b) — not the transitional mode
   * of the editor handoff, and not the pre-boot mode. Absent when the viewer
   * has no mode manager (an embedding, a harness).
   */
  mode?: string;
  /** ISO timestamp. Sort key only — deliberately never rendered (§3.1). */
  openedAt: string;
}

export interface RecentsEnvelope {
  version: typeof RECENTS_SCHEMA_VERSION;
  items: RecentDocumentEntry[];
}

/** Is this the same document? Identity is the PAIR, never the id alone. */
function sameDocument(a: RecentDocumentEntry, projectId: string, documentId: string): boolean {
  return a.projectId === projectId && a.documentId === documentId;
}

/**
 * Put `entry` at the front, deduplicated on `(projectId, documentId)`.
 *
 * A re-open MOVES the existing row rather than adding a second one, and the
 * fresh entry wins every field — the mode and the timestamp of the newer open
 * are the whole point of re-recording it.
 */
export function pushRecent(
  items: readonly RecentDocumentEntry[],
  entry: RecentDocumentEntry,
): RecentDocumentEntry[] {
  const rest = items.filter(e => !sameDocument(e, entry.projectId, entry.documentId));
  return [entry, ...rest].slice(0, MAX_RECENT_DOCUMENTS);
}

/**
 * Re-stamp the HEAD entry's mode, and only when the head is that document.
 *
 * The head is "what is open right now" — a mode change while anything else is
 * at the front belongs to a document the ring is no longer tracking, and
 * writing it there is exactly the defect SOL R2 F4 names (the transitional
 * mode of a handoff landing on the document being LEFT). The caller is
 * responsible for not calling this during a handoff; see
 * `rv-project-recents-store.ts` `withOpenIntentMode`.
 */
export function retagHeadMode(
  items: readonly RecentDocumentEntry[],
  projectId: string,
  documentId: string,
  mode: string,
): RecentDocumentEntry[] {
  const head = items[0];
  if (!head || !sameDocument(head, projectId, documentId)) return [...items];
  if (head.mode === mode) return [...items];
  return [{ ...head, mode }, ...items.slice(1)];
}

/**
 * Re-point ONE entry's recorded path after a rename or a move (plan-482 §2.7).
 *
 * Unlike {@link retagHeadMode} this is deliberately NOT head-bound: a renamed
 * document is rarely at position 1, and the whole purpose of the path is to
 * tell two same-named rows apart — a stale path in the middle of the ring is
 * exactly the lie the field was added to prevent.
 *
 * Only the path changes. Order, `mode` and `openedAt` are untouched: a rename
 * is not an open and must not resort the list.
 */
export function retagDocumentPath(
  items: readonly RecentDocumentEntry[],
  projectId: string,
  documentId: string,
  path: string,
): RecentDocumentEntry[] {
  if (!path) return [...items];
  return items.map(e =>
    sameDocument(e, projectId, documentId) && e.documentPath !== path
      ? { ...e, documentPath: path }
      : e);
}

/** Drop every entry of one project (F10). */
export function removeRecentsOfProject(
  items: readonly RecentDocumentEntry[],
  projectId: string,
): RecentDocumentEntry[] {
  return items.filter(e => e.projectId !== projectId);
}

/** Drop one entry (F7 / F8). */
export function removeRecent(
  items: readonly RecentDocumentEntry[],
  projectId: string,
  documentId: string,
): RecentDocumentEntry[] {
  return items.filter(e => !sameDocument(e, projectId, documentId));
}

function isBackend(v: unknown): v is RecentBackend {
  return v === 'folder' || v === 'browser' || v === 'bundled';
}

/**
 * Parse the stored envelope, tolerating everything (`news-store.ts` pattern).
 *
 * A hand-edited entry, a future version or a truncated write is "nothing
 * remembered", never a crash: a convenience list must not be able to break the
 * dashboard it sits on.
 */
export function parseRecents(raw: string | null): RecentDocumentEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  const env = parsed as Partial<RecentsEnvelope>;
  if (env.version !== RECENTS_SCHEMA_VERSION || !Array.isArray(env.items)) return [];
  const out: RecentDocumentEntry[] = [];
  for (const row of env.items) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<RecentDocumentEntry>;
    if (typeof r.projectId !== 'string' || !r.projectId) continue;
    if (typeof r.documentId !== 'string' || !r.documentId) continue;
    if (!isBackend(r.backend)) continue;
    // Mandatory since schema v2 (plan-482 F2): a row without a non-empty path
    // is dropped exactly like a row without a `documentId`. Mandatory means
    // mandatory, hand-written localStorage included.
    if (typeof r.documentPath !== 'string' || !r.documentPath) continue;
    out.push({
      projectId: r.projectId,
      backend: r.backend,
      documentId: r.documentId,
      documentName: typeof r.documentName === 'string' ? r.documentName : r.documentId,
      documentPath: r.documentPath,
      projectName: typeof r.projectName === 'string' ? r.projectName : r.projectId,
      mode: typeof r.mode === 'string' ? r.mode : undefined,
      openedAt: typeof r.openedAt === 'string' ? r.openedAt : new Date(0).toISOString(),
    });
    if (out.length >= MAX_RECENT_DOCUMENTS) break;
  }
  return out;
}

/** Serialise for storage. */
export function serialiseRecents(items: readonly RecentDocumentEntry[]): string {
  const env: RecentsEnvelope = {
    version: RECENTS_SCHEMA_VERSION,
    items: items.slice(0, MAX_RECENT_DOCUMENTS),
  };
  return JSON.stringify(env);
}
