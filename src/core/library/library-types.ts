// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-types — the vocabulary of the library layer (plan-372 §2.6).
 *
 * These types used to live in `plugins/layout-planner/rv-layout-store.ts`, which
 * made the Layout Planner plugin the owner of a concept the Projects dashboard
 * also needs. Phase 4 moves the vocabulary — and the state that goes with it —
 * into `core/`; `rv-layout-store.ts` re-exports every name it used to export, so
 * none of its ~60 importers had to change.
 *
 * Nothing here holds state or touches the network. The store lives in
 * `library-store.ts`, the registry in `library-source-registry.ts`.
 */

// ─── Catalog vocabulary ─────────────────────────────────────────────────

export interface LibraryCatalog {
  version: '1.0';
  name: string;
  entries: LibraryCatalogEntry[];
  baseUrl?: string;
}

export interface LibraryCatalogEntry {
  id: string;
  name: string;
  category: 'conveyor' | 'robot' | 'machine' | 'fixture' | 'custom' | 'des' | 'splat';
  glbUrl?: string;
  splatUrl?: string;
  thumbnailUrl?: string;
  footprintMm?: [number, number];
  tags?: string[];
  pivotToFloor?: boolean;
  plugin?: string;
  // Virtual DES components (no GLB — rendered as gizmos)
  virtual?: boolean;
  desType?: string;                        // 'DESConveyor', 'DESStation', etc.
  desConfig?: Record<string, unknown>;     // default rv_extras values
  gizmoSize?: [number, number, number];    // visual box size in mm [x, y, z]
  /** Virtual snap-point nodes. Positions use catalog millimetres [x, y, z]. */
  virtualPorts?: { name: string; position: [number, number, number] }[];
  /** Virtual convention nodes. Positions and optional sizes use millimetres. */
  virtualChildren?: {
    name: string;
    kind: 'carrier' | 'path';
    position: [number, number, number];
    size?: [number, number, number];
  }[];
  /** For Local-Folder entries: path of the source GLB relative to the
   *  scanned `library/` subfolder (e.g. "conveyor/belt.glb"). Used to
   *  persist generated thumbnails alongside the asset. */
  localPath?: string;
  /** Free-form group names this entry belongs to. Mirrors the Asset
   *  Manager "Collections" concept and is rendered as filter chips in
   *  the Local-Folder tab. For local libraries, derived from the
   *  immediate parent subfolder under `library/` (case preserved). */
  collections?: string[];
  /**
   * Manifest document id, for entries that ARE a project document
   * (plan-413 §2.7).
   *
   * A project-library entry's `id` is path-derived (`project:<path>`), which is
   * the right key for the panel and the wrong one for a reference: move the
   * document to another project and the path — and with it that key — changes,
   * while the document id does not. A source that carries this field answers to
   * both, which is what makes "a placement still resolves after a move" true
   * rather than aspirational.
   */
  documentId?: string;
  /**
   * SHA-256 (hex, lowercase, 64 chars) of the file behind `glbUrl` / `splatUrl`
   * (plan-508). Cache key + integrity check of the blob cache — NEVER a
   * resolution key (`rv-glb-reference-resolver.ts`). Written by both catalog
   * builders and re-stamped by the deploy after signing; optional, a catalog
   * without it keeps the url-keyed, revalidating cache behaviour.
   */
  sha256?: string;
  /** Size in bytes of the file behind `glbUrl` / `splatUrl` (plan-508). */
  sizeBytes?: number;
}

// ─── Origin policy (§2.6.3) ─────────────────────────────────────────────

/**
 * Where a library subscription came from — the input to the persistence
 * decision.
 *
 *  - `user`            — the human added it in the UI. The ONLY origin that is
 *                        persisted into the global localStorage list.
 *  - `config`          — a build/deploy default or a constructor option, and
 *                        also a legacy scene's `catalogUrls` (read-compat only).
 *  - `urlParam`        — a `?library=<url>` deep link, valid for this session.
 *  - `projectManifest` — `project.json.libraries[]`; it travels with the project
 *                        (git / zip / deploy), so persisting it globally would
 *                        leak one project's libraries into every other one.
 */
export type LibraryOrigin = 'user' | 'config' | 'urlParam' | 'projectManifest';

/**
 * Promotion rank. Promotion is **monotone**: an origin may only move up this
 * ladder, never down. Without that, a library the user explicitly added would
 * silently lose its persistence the next time the same URL arrived from a
 * project manifest or a deep link.
 */
const ORIGIN_RANK: Record<LibraryOrigin, number> = {
  config: 0,
  urlParam: 1,
  projectManifest: 2,
  user: 3,
};

/** The higher-ranked of two origins (monotone promotion, §2.6.3). */
export function promoteOrigin(current: LibraryOrigin, next: LibraryOrigin): LibraryOrigin {
  return ORIGIN_RANK[next] > ORIGIN_RANK[current] ? next : current;
}

/** True when an origin is persisted into the global library list. */
export function isPersistedOrigin(origin: LibraryOrigin): boolean {
  return origin === 'user';
}

// ─── localStorage keys ──────────────────────────────────────────────────

/** Global library subscriptions (user origin only). Unchanged key. */
export const LS_KEY_URLS = 'rv-layout-library-urls';
/** Last selected library tab. Unchanged key. */
export const LS_KEY_ACTIVE_TAB = 'rv-layout-active-tab';
/** `url -> LibraryOrigin` map. New in plan-372 §2.6.3 ("origin pro URL persistiert"). */
export const LS_KEY_ORIGINS = 'rv-layout-library-origins';

// ─── Local-folder constants ─────────────────────────────────────────────

/** Subfolder holding persisted preview PNGs — at the PROJECT ROOT (plan-744 F5). */
export const THUMBNAILS_SUBFOLDER = '.thumbnails';

/**
 * A document id as a file NAME — injective, and safe on every file system.
 *
 * A document id is a path-id since plan-717, so it can carry `/`; on Windows
 * `\ : * ? " < > |` are reserved as well. Replacing all of them with the same
 * filler would be the obvious thing and the wrong one: `a/b` and `a:b` would
 * become one file, and one asset's preview would overwrite another's.
 *
 * So every character outside `[A-Za-z0-9._-]` becomes `~` plus its UTF-16 code
 * unit in FIXED four-digit hex, `~` itself included. Two details carry the
 * argument: the escape character is one the safe set does NOT contain, so an
 * escape can never be read as literal text; and the width is FIXED, because
 * with a variable width a three-digit code point and a two-digit one followed
 * by a literal `0` would produce the same name.
 *
 * `_` stays literal on purpose: every minted id carries one
 * (`doc_press_1a2b`), and escaping it would turn every sidecar name into
 * noise for no gain.
 *
 * Very long ids get a hashed tail rather than a path the file system refuses.
 * The hash is over the WHOLE id, so two ids sharing a 100-character prefix
 * still differ.
 */
export function encodeThumbnailId(documentId: string): string {
  const id = typeof documentId === 'string' ? documentId : '';
  const encoded = id.replace(
    /[^A-Za-z0-9._-]/g,
    c => `~${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  if (encoded.length <= 120) return encoded;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${encoded.slice(0, 100)}-${h.toString(36)}`;
}

/**
 * Where a document's preview PNG lives: `<project>/.thumbnails/<id>.png`.
 *
 * Keyed by IDENTITY, not by location (plan-744 F5). The previous convention
 * mirrored the asset's PATH under `library/.thumbnails/`, which meant a move
 * or a rename silently orphaned the picture — and it only ever existed for
 * `library/**`, so a model or a scene had no persisted preview at all. An id
 * is frozen at birth (plan-717), so the sidecar survives both.
 */
export function thumbnailSidecarPath(documentId: string): string {
  return `${THUMBNAILS_SUBFOLDER}/${encodeThumbnailId(documentId)}.png`;
}

/**
 * The pre-plan-744 path-mirrored sidecar for a document, or null when the
 * document never had one.
 *
 * Only `library/**` did: the old writer refused everything else. Read by the
 * lazy migration in `resolve-document-thumbnail.ts` and by nothing that
 * writes.
 */
export function legacyLibraryThumbnailPath(documentPath: string): string | null {
  const path = typeof documentPath === 'string' ? documentPath : '';
  if (!path.startsWith('library/')) return null;
  const relative = path.slice('library/'.length);
  if (relative === '') return null;
  return `library/${THUMBNAILS_SUBFOLDER}/${relative.replace(/\.glb$/i, '.png')}`;
}

/** File extensions recognized as Gaussian Splat formats. */
export const SPLAT_EXTENSIONS = new Set(['.splat', '.ksplat', '.ply']);

// ─── Store snapshot ─────────────────────────────────────────────────────

/**
 * The library half of what used to be a single `LayoutSnapshot`.
 *
 * `LayoutStore._createSnapshot()` combines this with its planner-only fields,
 * so every existing React consumer keeps reading the same flat shape (§2.6.2).
 */
export interface LibrarySnapshot {
  catalogs: Map<string, LibraryCatalog>;
  catalogUrls: string[];
  catalogErrors: Map<string, string>;
  activeTabUrl: string | null;
  /** Entry ids whose preview thumbnail is currently being auto-generated. */
  thumbnailPending: ReadonlySet<string>;
}
