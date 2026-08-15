// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-classification — what a document *is*, written into the bytes
 * that are the document (plan-413 §2.3).
 *
 * ## Why it lives in the GLB and not in a manifest
 *
 * Since plan-397 every model is a GLB, and since plan-386 a GLB travels alone:
 * a share link is one URL, a copy between libraries is a byte copy, an export
 * is a download. Anything the receiving side has to know about the file has to
 * be *inside* the file, because there is no sidecar on the other end of a link.
 * That was the user's explicit decision ("sollten die glbs die klassifikationen
 * nicht selbst enthalten / transportabel?"), and it makes the project manifest
 * and the library sidecar what they should have been all along: caches. When a
 * cache and the file disagree, the file wins — always, without a merge.
 *
 * ## One enum, not a third one
 *
 * Two overlapping vocabularies already existed: `RvShareLevel`
 * (`component|assembly|model`) and `LibraryCatalogEntry.category`. Introducing
 * a third would have been the mistake this plan exists to undo, so
 * {@link DocumentLevel} *is* the share level from here on. `rv_share` v2 writes
 * these values; v1 values are mapped on read ({@link LEGACY_LEVEL_MAP}) and
 * never written again. `category` stays what it is — an orthogonal catalogue
 * facet of external sources, treated like a tag in search.
 *
 * ## Everything is optional, nothing ever throws
 *
 * The entire Unity export corpus carries no classification and must keep
 * loading unchanged (F5). So this module follows the `parseShareMeta` contract
 * to the letter: a block that is absent, malformed, hostile or of an unknown
 * version yields `null` or a partially-filled record — never an exception.
 * A missing level means "unclassified", which is a display state, not an error.
 *
 * ## Leaf module on purpose
 *
 * No imports. It is read by the GLB bake path, the GLB read path, the share
 * meta parser, the project manifest and the library sidecar; a dependency of
 * its own would put a cycle between any two of them.
 */

// ─── Keys ───────────────────────────────────────────────────────────────

/**
 * Key under `extras.realvirtual` of the default scene — the same block
 * `SceneCamera`, `SceneSettings` and `Connections` live in.
 *
 * Deliberately NOT `asset.extras`, which the glTF idiom would suggest: every
 * other file-level realvirtual datum sits at the default scene, three.js hands
 * scene extras through as `scene.userData`, and the whole existing load path
 * consumes exactly that. A second metadata location would recreate the
 * fragmentation this plan removes (§7 Alternative 1).
 */
export const RV_CLASSIFICATION_KEY = 'Classification';

// ─── Level ──────────────────────────────────────────────────────────────

/**
 * The fixed structural level of a document.
 *
 * Four values, ordered from small to large, plus `scene` for the thing one
 * opens rather than places. `model` is deliberately absent: the word names
 * nothing that `plant` and `scene` do not already cover, and retiring it from
 * the data model is half the point of plan-413.
 */
export type DocumentLevel = 'part' | 'assembly' | 'plant' | 'scene';

/** All levels, in display order. */
export const DOCUMENT_LEVELS: readonly DocumentLevel[] =
  ['part', 'assembly', 'plant', 'scene'] as const;

/**
 * `rv_share` v1 values → {@link DocumentLevel}.
 *
 * Read-only by contract: a v1 share link written before this plan must keep
 * opening exactly as it did, so its levels are mapped here on the way in and
 * the mapped value is what gets written back out. Nothing writes `component`
 * or `model` again.
 */
export const LEGACY_LEVEL_MAP: Readonly<Record<string, DocumentLevel>> = {
  component: 'part',
  model: 'plant',
};

/** Human label for a level. English, matching the rest of the dashboard. */
export const DOCUMENT_LEVEL_LABEL: Readonly<Record<DocumentLevel, string>> = {
  part: 'Part',
  assembly: 'Assembly',
  plant: 'Plant',
  scene: 'Scene',
};

/** Shown wherever a document has no level at all. */
export const UNCLASSIFIED_LABEL = 'Unclassified';

/**
 * Coerce an unknown value to a {@link DocumentLevel}, mapping legacy values.
 *
 * Returns `undefined` for anything unrecognised rather than guessing — an
 * unknown level is "unclassified", which is a state the UI already renders.
 */
export function normaliseDocumentLevel(value: unknown): DocumentLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  if ((DOCUMENT_LEVELS as readonly string[]).includes(v)) return v as DocumentLevel;
  return LEGACY_LEVEL_MAP[v];
}

/** Display label for a level that may be absent. */
export function documentLevelLabel(level: DocumentLevel | undefined | null): string {
  return level ? DOCUMENT_LEVEL_LABEL[level] : UNCLASSIFIED_LABEL;
}

// ─── Classification ─────────────────────────────────────────────────────

/**
 * The `Classification` block. Source of truth; manifest and sidecar mirror it.
 *
 * Versioned independently of the manifest schema and of `RvScene`, for the same
 * reason `rv_share` is: what a file says about itself and how a project lists
 * its files change for unrelated reasons.
 */
export interface DocumentClassification {
  v: 1;
  /** Absent means "unclassified" — a display state, never an error. */
  level?: DocumentLevel;
  /** Free-form. The UI offers autocomplete from the project's existing tags. */
  tags?: string[];
}

/**
 * Normalise a tag list: trimmed, non-empty, de-duplicated, order preserved.
 *
 * De-duplication is case-sensitive on purpose. `Presse` and `presse` being one
 * tag would mean deciding which spelling survives, and silently rewriting what
 * a user typed is worse than showing him two chips he can merge himself.
 */
export function normaliseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Read a classification out of a `extras.realvirtual` object.
 *
 * Defensive by contract (§9.1): absent, not an object, unknown version or
 * wrongly-typed fields yield `null` or a partial record — never a throw. A GLB
 * failing to open because someone hand-edited a JSON blob would be the worst
 * possible trade, and it is the same trade `parseShareMeta` already refused.
 */
export function parseClassification(rvExtras: unknown): DocumentClassification | null {
  if (!rvExtras || typeof rvExtras !== 'object' || Array.isArray(rvExtras)) return null;
  const raw = (rvExtras as Record<string, unknown>)[RV_CLASSIFICATION_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const rec = raw as Record<string, unknown>;
  // An unknown major version might mean something else entirely. Refuse it
  // rather than misreport it — the file still loads, it is just unclassified.
  if (rec.v !== 1) return null;

  const out: DocumentClassification = { v: 1 };
  const level = normaliseDocumentLevel(rec.level);
  if (level) out.level = level;
  const tags = normaliseTags(rec.tags);
  if (tags) out.tags = tags;
  return out;
}

/**
 * The block as it goes into the file: normalised, without empty fields.
 *
 * Empty fields are omitted rather than written as `undefined`/`[]` so that
 * "never classified" and "classified as nothing" stay the same thing on disk —
 * the manifest cache compares these payloads.
 */
export function classificationPayload(
  classification: DocumentClassification,
): Record<string, unknown> {
  const out: Record<string, unknown> = { v: 1 };
  const level = normaliseDocumentLevel(classification.level);
  if (level) out.level = level;
  const tags = normaliseTags(classification.tags);
  if (tags) out.tags = [...tags];
  return out;
}

/** True when a classification carries nothing beyond its version. */
export function isEmptyClassification(
  classification: DocumentClassification | null | undefined,
): boolean {
  if (!classification) return true;
  return !normaliseDocumentLevel(classification.level) && !normaliseTags(classification.tags);
}

/**
 * Value equality for the cache-vs-file comparison of §2.5.
 *
 * Compared over the normalised payload, so a manifest that stored the tags in
 * a different order or with stray whitespace does not read as a conflict and
 * trigger a pointless rewrite.
 */
export function classificationEquals(
  a: DocumentClassification | null | undefined,
  b: DocumentClassification | null | undefined,
): boolean {
  const ea = isEmptyClassification(a);
  const eb = isEmptyClassification(b);
  if (ea || eb) return ea === eb;
  const pa = classificationPayload(a!);
  const pb = classificationPayload(b!);
  if (pa.level !== pb.level) return false;
  const ta = (pa.tags as string[] | undefined) ?? [];
  const tb = (pb.tags as string[] | undefined) ?? [];
  return ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}
