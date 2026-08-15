// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-doc-alias — the permanent `sceneId → documentId` map (plan-716 §2.4, F4).
 *
 * The eager migration of §2.3 gives every catalogue scene a new identity. Every
 * reference to the OLD one keeps existing regardless: a `?scene=scn_…` URL in
 * somebody's bookmarks, the `rv-scenes/active` pointer of the session that was
 * interrupted by the update, an IndexedDB draft frame keyed `scene:scn_…`. This
 * module is what those keep resolving through.
 *
 * ## Permanent, and why that is not laziness
 *
 * There is no expiry and no purge step, deliberately. An alias is two short
 * strings; a thousand migrated scenes cost well under 100 kB of a 5 MB budget,
 * which is cheaper than the one support case caused by a link that stopped
 * working. More to the point, there is no moment at which it becomes *safe* to
 * drop one — a bookmark has no lifetime, so any expiry date is a guess about
 * somebody else's browser.
 *
 * ## Profile-bound is not a regression (R1-I3)
 *
 * The map lives in localStorage, so it resolves only in the profile that ran the
 * migration. That is exactly the reach the data itself always had: the scene
 * catalogue was localStorage too, and a `?scene=scn_…` link has never resolved
 * on a machine that did not hold the scene. The alias has to work where the
 * bytes were, and nowhere else.
 *
 * ## One key per alias, not one map
 *
 * A single JSON blob would be marginally smaller and would fail as a UNIT: the
 * migration writes aliases one row at a time, and a quota refusal halfway
 * through a rewrite of the whole map could lose aliases for rows that were
 * migrated in an earlier run. Per-key writes fail only the row being written,
 * which is precisely the granularity §2.3d needs to abort exactly one row.
 *
 * ## Failure posture: the one store here that THROWS
 *
 * Every other localStorage helper in this codebase swallows a quota error,
 * because a marker or a hint is worth less than the operation it accompanies.
 * This one is the opposite: an alias that was not written means "the document
 * exists and every link to it is dead". {@link writeDocumentAlias} therefore
 * throws, and the migration uses that to abort the row BEFORE retiring anything
 * (§2.3d, R1-S3).
 */

// ─── Keyspace ───────────────────────────────────────────────────────────

/**
 * Prefix of every alias key. Its own namespace, sharing a prefix with nothing:
 * not `rv-scenes/` (swept by the catalogue enumerators), not `rv-scene-glb/`
 * (walked by `listSceneGlbIds`), not `rv-scenes-retired/` (the migration's own
 * graveyard, which a later release purges — and an alias must survive that).
 */
export const LS_KEY_DOC_ALIAS_PREFIX = 'rv-doc-alias/';

function aliasKey(sceneId: string): string {
  return LS_KEY_DOC_ALIAS_PREFIX + sceneId;
}

/** What one alias records. */
export interface DocumentAlias {
  /** The document the old id now names. */
  documentId: string;
  /** ISO timestamp of the migration run that wrote it. Diagnostics only. */
  at: string;
}

// ─── Read ───────────────────────────────────────────────────────────────

/**
 * The document id an old scene id resolves to, or null when there is no alias.
 *
 * STRICT: a null means "no alias recorded", never "this is already a document
 * id". That is what makes it usable as the migration's state question — §2.3a
 * asks exactly this to decide whether steps b–d have already run for a row.
 * Callers that want "the id to use, alias or not" want
 * {@link resolveDocumentId} instead.
 */
export function resolveDocumentAlias(idOrScn: string | null | undefined): string | null {
  if (!idOrScn) return null;
  return readDocumentAlias(idOrScn)?.documentId ?? null;
}

/** The full record, or null. */
export function readDocumentAlias(sceneId: string): DocumentAlias | null {
  if (!sceneId) return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(aliasKey(sceneId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DocumentAlias> | null;
    if (!parsed || typeof parsed.documentId !== 'string' || parsed.documentId === '') return null;
    return {
      documentId: parsed.documentId,
      at: typeof parsed.at === 'string' ? parsed.at : '',
    };
  } catch {
    return null;
  }
}

/**
 * The document id to use for `idOrScn` — TOLERANT.
 *
 * Returns the alias target when there is one and the input unchanged otherwise,
 * so a call site that only wants "address the right document" does not have to
 * know whether it is holding an old id or a new one. This is the form the
 * `readActiveId` restore and the frame-key lookup use.
 */
export function resolveDocumentId(idOrScn: string): string;
export function resolveDocumentId(idOrScn: string | null): string | null;
export function resolveDocumentId(idOrScn: string | null): string | null {
  if (!idOrScn) return idOrScn;
  return resolveDocumentAlias(idOrScn) ?? idOrScn;
}

/** True when this id has been migrated away — the "moved, not conflicted" test. */
export function hasDocumentAlias(idOrScn: string | null | undefined): boolean {
  return resolveDocumentAlias(idOrScn) !== null;
}

// ─── Write ──────────────────────────────────────────────────────────────

/**
 * Record `sceneId → documentId`. **Throws** when it cannot be stored.
 *
 * Idempotent for an identical mapping (the timestamp is refreshed, the answer is
 * not), and deliberately NOT idempotent for a conflicting one: an alias that
 * already points somewhere else means two migration runs disagreed about a row,
 * and silently repointing it would orphan whichever document lost. The caller
 * gets an error and the row is left alone.
 */
export function writeDocumentAlias(
  sceneId: string,
  documentId: string,
  now: () => string = () => new Date().toISOString(),
): void {
  if (!sceneId) throw new Error('writeDocumentAlias needs a scene id.');
  if (!documentId) throw new Error('writeDocumentAlias needs a document id.');
  const existing = resolveDocumentAlias(sceneId);
  if (existing && existing !== documentId) {
    throw new Error(
      `"${sceneId}" already resolves to ${existing}; refusing to repoint it at ${documentId}.`,
    );
  }
  const record: DocumentAlias = { documentId, at: now() };
  try {
    localStorage.setItem(aliasKey(sceneId), JSON.stringify(record));
  } catch (e) {
    // The one throw of this module — see the file header. "Document written,
    // link dead" is the state this refuses to reach silently.
    throw new Error(`The link for "${sceneId}" could not be recorded: ${String(e)}`);
  }
}

// ─── Routing (§2.4) ─────────────────────────────────────────────────────

/**
 * What an old `?scene=<id>` link resolves to today.
 *
 *  - `document` — the alias resolved AND the project lists the row. The router
 *    normalises the address bar and opens it.
 *  - `missing`  — the alias resolved and the row is not there. Rare and always a
 *    real fault (a manifest lost between the migration and this boot, a document
 *    deleted since), and it gets its OWN outcome rather than folding into null:
 *    the router must not fall through to `openScene(scn_…)` for it, because that
 *    id's body has been retired and the "scene" would open empty with no
 *    explanation. §9.2 pins the visible fallback.
 *  - `null`     — no alias. Not migrated (or never a scene id at all); the
 *    caller's existing path is correct and untouched.
 */
export type DocumentRouteTarget =
  | { kind: 'document'; documentId: string; relPath: string; name: string }
  | { kind: 'missing'; documentId: string };

/**
 * Resolve an old scene id against a project's document list.
 *
 * Takes the project rather than reaching for the store, so the routing rule is
 * a pure function of (id, manifest) and can be tested without a boot.
 */
export function resolveSceneRoute(
  sceneId: string | null | undefined,
  documents: readonly { id: string; path: string; name?: string }[],
): DocumentRouteTarget | null {
  const documentId = resolveDocumentAlias(sceneId);
  if (!documentId) return null;
  const row = documents.find(d => d.id === documentId);
  if (!row) return { kind: 'missing', documentId };
  return {
    kind: 'document',
    documentId,
    relPath: row.path,
    name: row.name && row.name !== '' ? row.name : documentId,
  };
}

/**
 * Rewrite `?scene=<old>` to `?doc=<documentId>`, leaving every other parameter
 * exactly where it was.
 *
 * Its own function so the rule is testable without a boot, and so `?option=`,
 * `?mode=`, `?project=` and the rest are demonstrably preserved rather than
 * preserved by inspection of a URL built inline.
 */
export function sceneUrlToDocumentUrl(href: string, documentId: string): string {
  const url = new URL(href);
  url.searchParams.delete('scene');
  url.searchParams.set('doc', documentId);
  return url.toString();
}

// ─── Enumeration / housekeeping ─────────────────────────────────────────

/** Every scene id that has an alias. */
export function listDocumentAliasIds(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_KEY_DOC_ALIAS_PREFIX)) {
        out.push(k.slice(LS_KEY_DOC_ALIAS_PREFIX.length));
      }
    }
  } catch { /* ignore */ }
  return out;
}

/** Every alias as a plain map. Diagnostics, the restore snippet, and tests. */
export function readAllDocumentAliases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of listDocumentAliasIds()) {
    const alias = resolveDocumentAlias(id);
    if (alias) out[id] = alias;
  }
  return out;
}

/**
 * Drop one alias.
 *
 * Not reachable from any production path — the map is permanent (see the file
 * header). Exported for the migration's own rollback story and for tests.
 */
export function clearDocumentAlias(sceneId: string): void {
  if (!sceneId) return;
  try {
    localStorage.removeItem(aliasKey(sceneId));
  } catch { /* ignore */ }
}

/** Drop every alias. Tests and "clear site data" only. */
export function clearAllDocumentAliases(): void {
  for (const id of listDocumentAliasIds()) clearDocumentAlias(id);
}
