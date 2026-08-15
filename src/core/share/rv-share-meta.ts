// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `rv_share` — the metadata a shared GLB carries about itself (plan-386 §2.4).
 *
 * ## Why it lives in the file
 *
 * A shared link is one URL and nothing else. There is no sidecar to fetch, no
 * registry to ask: whatever the receiver should know about the thing he is
 * looking at has to travel inside the bytes he already downloaded. The exporter
 * writes the block to `Scene.userData`, which the three.js `GLTFExporter`
 * serialises as `scenes[0].extras` and `GLTFLoader` restores to
 * `scene.userData` — the same proven route `userData.realvirtual` already uses.
 *
 * ## Everything is optional
 *
 * A link to a GLB that was never stamped must still work — that was an explicit
 * user decision (Entscheidungs-Log: "Optional mit Fallbacks"). So this module
 * never throws on a missing, malformed or hostile block: it returns what it can
 * prove and lets the caller fall back to the filename and the origin host. The
 * info card shrinks; it never disappears, because the origin line is the actual
 * security measure (§3.1).
 */

import type { EmbeddedOrigin } from '../engine/rv-glb-flatten';
import { normaliseDocumentLevel, type DocumentLevel } from '../project/rv-document-classification';

/** Key under which the block sits in the GLB scene's `userData`. */
export const RV_SHARE_KEY = 'rv_share';

/**
 * How much of a plant the shared file is — steers the escalation default.
 *
 * Since plan-413 this is the SAME enum a document's `Classification` carries
 * ({@link DocumentLevel}), not a parallel vocabulary. There were already two
 * overlapping ones (`RvShareLevel` and `LibraryCatalogEntry.category`) and a
 * third would have been the mistake that plan exists to undo; a shared file and
 * a stored document say "assembly" in exactly one way now.
 *
 * The v1 spellings `component` and `model` are still READ — every share link
 * minted before this change must keep opening — and mapped to `part` / `plant`
 * on the way in. Nothing writes them again.
 */
export type RvShareLevel = DocumentLevel;

/** Current `rv_share` block version. v1 blocks are read and up-mapped. */
export const RV_SHARE_VERSION = 2;

/** Mirrors `LibraryCatalogEntry['category']`; duplicated to keep this leaf-level. */
export type RvShareCategory =
  'conveyor' | 'robot' | 'machine' | 'fixture' | 'custom' | 'des' | 'splat';

/**
 * The `rv_share` block. Versioned independently of `RvScene.schemaVersion`
 * (R8): the scene schema and what a share says about itself change for
 * unrelated reasons and must be free to move apart.
 */
export interface RvShareMeta {
  /**
   * `2` since plan-413 (shared level enum). A parsed v1 block is reported as
   * `v: 2` with its level already mapped, so no consumer has to know that v1
   * ever existed — the version only tells a WRITER which spelling to emit, and
   * writers emit v2 exclusively.
   */
  v: 1 | 2;
  name?: string;
  author?: string;
  /** SPDX short form, e.g. `CC-BY-4.0`. Displayed verbatim — never interpreted. */
  license?: string;
  level?: RvShareLevel;
  category?: RvShareCategory;
  footprintMm?: [number, number];
  tags?: string[];
  homepage?: string;
  /** ISO 8601 — present ONLY when the provider chose a deletion deadline (F10). */
  expiresAt?: string;
  /** `false` hides the download button at the receiver (F14). Default: allowed. */
  allowDownload?: boolean;
}

const CATEGORIES: readonly string[] =
  ['conveyor', 'robot', 'machine', 'fixture', 'custom', 'des', 'splat'];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map(x => x.trim());
  return out.length > 0 ? out : undefined;
}

function footprint(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const [a, b] = v;
  if (typeof a !== 'number' || typeof b !== 'number') return undefined;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return [a, b];
}

/**
 * Read an `rv_share` block out of a GLB scene's `userData`.
 *
 * Defensive by contract (§9.6 `shareMeta_IgnoresMalformed`): a block that is
 * absent, not an object, of an unknown version, or whose fields have the wrong
 * types yields `null` or a partially-filled record — never an exception. A
 * shared link failing to open because someone hand-edited a JSON blob would be
 * the worst possible trade.
 */
export function parseShareMeta(userData: unknown): RvShareMeta | null {
  if (!userData || typeof userData !== 'object') return null;
  const raw = (userData as Record<string, unknown>)[RV_SHARE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const rec = raw as Record<string, unknown>;
  // An unknown major version is not "best effort" territory: the block might
  // mean something entirely different. Refuse it rather than misreport it.
  // v1 and v2 differ ONLY in the level spelling, which `normaliseDocumentLevel`
  // reconciles below — so both are accepted and both come back as v2.
  if (rec.v !== 1 && rec.v !== 2) return null;

  const meta: RvShareMeta = { v: RV_SHARE_VERSION };
  const name = str(rec.name); if (name) meta.name = name;
  const author = str(rec.author); if (author) meta.author = author;
  const license = str(rec.license); if (license) meta.license = license;

  // Maps the v1 spellings (`component` → `part`, `model` → `plant`) and drops
  // anything unrecognised, exactly as before: an unknown level is no level.
  const level = normaliseDocumentLevel(rec.level);
  if (level) meta.level = level;

  const category = str(rec.category);
  if (category && CATEGORIES.includes(category)) meta.category = category as RvShareCategory;

  const fp = footprint(rec.footprintMm); if (fp) meta.footprintMm = fp;
  const tags = strArray(rec.tags); if (tags) meta.tags = tags;

  // Only http(s) homepages — the block is attacker-controlled data and this
  // string ends up in an anchor href.
  const homepage = str(rec.homepage);
  if (homepage && /^https?:\/\//i.test(homepage)) meta.homepage = homepage;

  // An unparseable date is dropped rather than shown: "expires Invalid Date"
  // is worse than showing no expiry at all, and F5 says the row appears only
  // when there IS a deadline.
  const expiresAt = str(rec.expiresAt);
  if (expiresAt && !Number.isNaN(Date.parse(expiresAt))) meta.expiresAt = expiresAt;

  if (typeof rec.allowDownload === 'boolean') meta.allowDownload = rec.allowDownload;

  return meta;
}

/**
 * Human name for a GLB URL when the file carries no `rv_share.name`
 * (§9.6 `shareMeta_FallsBackToFilename`).
 */
export function filenameFromUrl(url: string): string {
  let path = url;
  try {
    path = new URL(url, 'http://localhost/').pathname;
  } catch {
    // Not URL-shaped — fall back to plain string slicing below.
    path = url.split(/[?#]/)[0] ?? url;
  }
  const last = path.split('/').filter(Boolean).pop() ?? url;
  let decoded = last;
  try { decoded = decodeURIComponent(last); } catch { /* keep raw */ }
  return decoded.replace(/\.glb$/i, '') || url;
}

/**
 * Origin host for the badge (F5). Returns `null` for anything that is not an
 * absolute http(s) URL — the badge then says nothing rather than something
 * wrong.
 */
export function originHostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host || null;
  } catch {
    return null;
  }
}

/** Everything the receiver's info card needs, already reduced to strings. */
export interface SharedGlbInfo {
  /** The URL the bytes actually came from (post-redirect where known). */
  url: string;
  /** `rv_share.name` or, failing that, the filename. Never empty. */
  name: string;
  /** Parsed block, or `null` when the file was never stamped. */
  meta: RvShareMeta | null;
  /** Host the bytes were fetched from, or `null` for a non-http source. */
  originHost: string | null;
  /**
   * Provenance of embedded reference subtrees when the shared file is a flat
   * export (Verifikation 2026-08-08 §2.4). A secondary source next to
   * `rv_share`: it names where each embedded asset originally came from, which
   * is exactly the question "what am I actually looking at" for a flattened
   * assembly.
   */
  embeddedOrigins: readonly EmbeddedOrigin[];
  /** `false` only when the provider explicitly disabled it (F14). */
  downloadAllowed: boolean;
}

/** Assemble the card model from the loaded GLB's scene `userData` plus the URL. */
export function buildSharedGlbInfo(input: {
  url: string;
  userData?: unknown;
  embeddedOrigins?: readonly EmbeddedOrigin[];
}): SharedGlbInfo {
  const meta = parseShareMeta(input.userData);
  return {
    url: input.url,
    name: meta?.name ?? filenameFromUrl(input.url),
    meta,
    originHost: originHostOf(input.url),
    embeddedOrigins: input.embeddedOrigins ?? [],
    downloadAllowed: meta?.allowDownload !== false,
  };
}
