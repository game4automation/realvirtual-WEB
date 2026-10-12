// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-info — what a document is ABOUT, written into the bytes that are
 * the document (plan-506 §2.3).
 *
 * ## Why a second block beside `Classification`
 *
 * `Classification` answers "what kind of thing is this" with a level and a
 * handful of tags — facets one filters by. A colleague choosing between forty
 * models needs a sentence, and a customer opening a share link needs a
 * paragraph. That text has the same travel requirement the classification has
 * (plan-413: a GLB travels alone, a share link is one URL, a copy is a byte
 * copy), so it lives in the same place: `extras.realvirtual` of the default
 * scene, beside `Classification`, never in a sidecar. The demo project shows
 * what a sidecar turns into — a manifest row marked `missingSince`.
 *
 * Tags stay in `Classification` on purpose (user decision): one tag list, not
 * two that drift apart.
 *
 * ## Flat strings, stamped by the writer
 *
 * `summary` and `description` are plain string values so Blender and any other
 * glTF tool shows and round-trips them without knowing realvirtual. `updatedAt`
 * and `updatedBy` are stamped by the ONE writer (`rv-document-info-write.ts`),
 * never typed by a user, and are ignored by {@link documentInfoEquals}: two
 * blocks with the same text are the same description, whoever saved it last.
 *
 * ## Everything is optional, nothing ever throws
 *
 * The whole Unity export corpus carries no block (Unity does not author it —
 * user decision), and a GLB can come from a stranger. So the parser follows the
 * `parseClassification` contract to the letter: absent, malformed, hostile or
 * of an unknown version yields `null` — "no description", the same display
 * state as "unclassified" — never an exception. An unknown `v` is ignored, not
 * deleted: the bake writer only ever replaces its OWN key, and only when a user
 * actually writes a description.
 *
 * ## Leaf module on purpose
 *
 * No imports, for the reason `rv-document-classification.ts` gives: it is read
 * by the GLB bake path, the GLB read path, the byte scan, the project manifest,
 * the dashboard, Ask AI and the MCP bridge. A dependency of its own would put a
 * cycle between any two of them.
 */

// ─── Keys and limits ────────────────────────────────────────────────────

/** Key under `extras.realvirtual` of the default scene, beside `Classification`. */
export const RV_DOCUMENT_INFO_KEY = 'DocumentInfo';

/**
 * Upper bound of the Markdown description, in UTF-16 code units.
 *
 * The block is cached whole in every manifest row (the cache mirrors the file),
 * so the bound is what keeps a project with a few hundred described documents
 * well below a few MB of `project.json`. 20 000 characters is several printed
 * pages — a description, not a manual.
 */
export const MAX_DESCRIPTION_CHARS = 20_000;

/** Upper bound of the one-line summary — it has to fit a tooltip header. */
export const MAX_SUMMARY_CHARS = 200;

// ─── Block ──────────────────────────────────────────────────────────────

/** The block as the GLB carries it under `extras.realvirtual` of the default scene. */
export interface DocumentInfo {
  v: 1;
  /** One line, plain text, at most {@link MAX_SUMMARY_CHARS}. */
  summary?: string;
  /** Markdown, at most {@link MAX_DESCRIPTION_CHARS}, LF line breaks only. */
  description?: string;
  /** ISO-8601, stamped by the writer. */
  updatedAt?: string;
  /** Display name of whoever wrote it, stamped by the writer when one is known. */
  updatedBy?: string;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v === '' ? undefined : v;
}

/**
 * The summary is ONE line: every line break a paste brought along becomes a
 * space, then the length bound applies.
 */
function cleanSummary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = cleanString(value.replace(/\s*[\r\n]+\s*/g, ' '));
  return v === undefined ? undefined : v.slice(0, MAX_SUMMARY_CHARS).trimEnd();
}

/** CRLF and lone CR (Windows / old Mac clipboards) become LF, then the bound applies. */
function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = cleanString(value.replace(/\r\n?/g, '\n'));
  return v === undefined ? undefined : v.slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * Normalise a block: trimmed, CRLF → LF, limits enforced, empty strings
 * dropped. Returns `null` when nothing of substance (summary or description)
 * is left — a block with only stamps describes nothing.
 */
export function normaliseDocumentInfo(info: DocumentInfo): DocumentInfo | null {
  const out: DocumentInfo = { v: 1 };
  const summary = cleanSummary(info.summary);
  if (summary) out.summary = summary;
  const description = cleanDescription(info.description);
  if (description) out.description = description;
  if (!summary && !description) return null;
  const updatedAt = cleanString(info.updatedAt);
  if (updatedAt) out.updatedAt = updatedAt;
  const updatedBy = cleanString(info.updatedBy);
  if (updatedBy) out.updatedBy = updatedBy;
  return out;
}

/**
 * Read a block out of an `extras.realvirtual` object.
 *
 * Never throws. Absent, not an object, `v !== 1`, or nothing but empty fields
 * → `null`. Wrongly-typed fields are dropped individually.
 */
export function parseDocumentInfo(rvExtras: unknown): DocumentInfo | null {
  if (!rvExtras || typeof rvExtras !== 'object' || Array.isArray(rvExtras)) return null;
  const raw = (rvExtras as Record<string, unknown>)[RV_DOCUMENT_INFO_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  // An unknown major version might mean something else entirely — refuse to
  // misreport it. The file still loads; it just shows no description.
  if (rec.v !== 1) return null;
  return normaliseDocumentInfo({
    v: 1,
    summary: typeof rec.summary === 'string' ? rec.summary : undefined,
    description: typeof rec.description === 'string' ? rec.description : undefined,
    updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : undefined,
    updatedBy: typeof rec.updatedBy === 'string' ? rec.updatedBy : undefined,
  });
}

/**
 * The block as it goes into the file: normalised, without empty fields.
 *
 * Callers pass a non-empty block (the bake writer turns an empty one into a
 * removal first); for an empty one this returns the bare `{ v: 1 }`.
 */
export function documentInfoPayload(info: DocumentInfo): Record<string, unknown> {
  const n = normaliseDocumentInfo(info);
  const out: Record<string, unknown> = { v: 1 };
  if (!n) return out;
  if (n.summary) out.summary = n.summary;
  if (n.description) out.description = n.description;
  if (n.updatedAt) out.updatedAt = n.updatedAt;
  if (n.updatedBy) out.updatedBy = n.updatedBy;
  return out;
}

/** True when a block carries neither a summary nor a description. */
export function isEmptyDocumentInfo(info: DocumentInfo | null | undefined): boolean {
  if (!info) return true;
  return normaliseDocumentInfo(info) === null;
}

/**
 * Text equality — the blur diff of the editor.
 *
 * Ignores `updatedAt` / `updatedBy`: re-saving the same words is not a change.
 * NOT the cache comparison — the manifest cache must also follow a new stamp,
 * which is what {@link documentInfoCacheEquals} is for.
 */
export function documentInfoEquals(
  a: DocumentInfo | null | undefined,
  b: DocumentInfo | null | undefined,
): boolean {
  const na = a ? normaliseDocumentInfo(a) : null;
  const nb = b ? normaliseDocumentInfo(b) : null;
  if (!na || !nb) return !na && !nb;
  return na.summary === nb.summary && na.description === nb.description;
}

/**
 * Full equality INCLUDING the stamps — the cache comparison (plan-506 F15).
 *
 * The project snapshot is only republished when a row differs; a scan that
 * found the same text with a newer `updatedAt` must still reach the snapshot,
 * or "updated 2 h ago" would lie until the next reload.
 */
export function documentInfoCacheEquals(
  a: DocumentInfo | null | undefined,
  b: DocumentInfo | null | undefined,
): boolean {
  if (!documentInfoEquals(a, b)) return false;
  const na = a ? normaliseDocumentInfo(a) : null;
  const nb = b ? normaliseDocumentInfo(b) : null;
  if (!na || !nb) return true;
  return na.updatedAt === nb.updatedAt && na.updatedBy === nb.updatedBy;
}
