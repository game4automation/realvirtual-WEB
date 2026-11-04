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
  /** A loadable picture URL — a catalog's resolved `thumbnail`, or a source's absolute URL. */
  thumbnailUrl?: string;
  /**
   * The saved preview of a PROJECT document (plan-776): the row's relative
   * `thumbnail` pointer (`.thumbnails/<id>.<hash8>.webp`). Not a URL — the card
   * resolves it through the project backend (`resolveThumbnailUrl`), which is
   * what lets a folder or browser project hand out a blob URL. Absent = placeholder.
   */
  thumbnailPointer?: string;
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
   *  scanned `library/` subfolder (e.g. "conveyor/belt.glb"). */
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
   * The registry identity of the source that minted this entry, stamped by a
   * provider whose references must be QUALIFIED (plan-778: a library project,
   * `providerId: 'library-projects'`, `sourceId` = the library's project id).
   * `entryOriginOf()` reads it; a placement made from such an entry stores both
   * halves and resolves only there. Absent on every other entry (legacy form).
   */
  libraryOrigin?: { providerId: string; sourceId: string };
  /**
   * Legacy ids this entry answers to for UNQUALIFIED references (plan-778 F5) —
   * the manifest row's `aliases`. Never a key of a qualified lookup.
   */
  aliases?: string[];
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
  /**
   * Resolving this entry is expensive or has side effects — e.g. a server-side
   * download + conversion that writes the result into the project (plan-660,
   * SimReady). The library panel then never warms it speculatively on hover or
   * pointer-down; only an actual placement or drag resolves it.
   */
  noPrefetch?: boolean;
  /**
   * A larger picture for the detail view (lightbox) of the library panel; the
   * card itself keeps `thumbnailUrl`. Absent = the detail view shows the thumbnail.
   */
  previewUrl?: string;
  /**
   * Who made the asset and under which license — shown in the detail view.
   * Remote catalogs with an attribution duty (SimReady, CC-BY-4.0, plan-660) fill it.
   */
  attribution?: LibraryEntryAttribution;
  /**
   * A procedural path building block (plan-628 8.1): no GLB, the geometry comes
   * from code. Placing the entry goes through the path network's
   * `layout.path.place` / `layout.path.junction` (a `PathBlock` node under
   * `PathNetwork`), never through the planner's GLB placement. `params` are the
   * block parameters (`lengthM`, `radiusM`, `degrees`, `side`, …).
   */
  pathBlock?: LibraryPathBlock;
}

/** Kinds of a library path building block (plan-628 8.1). */
export type LibraryPathBlockKind = 'straight' | 'curve' | 'diverge' | 'merge' | 'stub';

/** The procedural path-block payload of a catalog entry (plan-628 8.1). */
export interface LibraryPathBlock {
  kind: LibraryPathBlockKind;
  params?: Record<string, unknown>;
}

/** Creator + license of a catalog entry (detail view of the library panel). */
export interface LibraryEntryAttribution {
  vendor?: string;
  license?: string;
  licenseUrl?: string;
  /** Page of the asset at its origin (e.g. the dataset folder on Hugging Face). */
  sourceUrl?: string;
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

/**
 * Folder holding persisted preview images (plan-776): `.thumbnails/` at the
 * PROJECT ROOT for documents, `<Category>/.thumbnails/` inside a library
 * catalog. Written only by a save, never by a viewer.
 */
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

/** The two image formats a save writes (WebP; PNG where the browser cannot encode WebP). */
export type ThumbnailExt = 'webp' | 'png';

/** The tail of a sidecar file name after `<encodedId>.`: 8 hex chars of content hash + extension. */
const SIDECAR_TAIL = /^[0-9a-f]{8}\.(webp|png)$/;

/**
 * Where a document's preview lives (plan-776 F1):
 * `<dir>/.thumbnails/<encodeThumbnailId(id)>.<hash8>.<webp|png>`.
 *
 * Keyed by IDENTITY, not by location (plan-744 F5) — an id is frozen at birth
 * (plan-717), so a move or a rename keeps the picture. The 8 hex characters are
 * the start of the image's SHA-256: a changed picture is a changed file NAME, so
 * every cache on the way (browser, CDN — Bunny ignores query strings) sees a new
 * key without any `?v=` trick, and the manifest pointer alone is the cache key.
 *
 * `dir` is the folder that owns the `.thumbnails/` folder: empty for the
 * project root, a category folder (`PalletHandling`) for a library catalog.
 */
export function thumbnailSidecarPath(
  documentId: string,
  hash8: string,
  ext: ThumbnailExt,
  dir = '',
): string {
  const prefix = dir ? `${dir.replace(/\/+$/, '')}/` : '';
  return `${prefix}${THUMBNAILS_SUBFOLDER}/${encodeThumbnailId(documentId)}.${hash8}.${ext}`;
}

/**
 * The hash-less PNG an older build wrote for this id (plan-744:
 * `.thumbnails/<id>.png`). Never read (plan-776 F12) — only deleted, by a save
 * of the same id that writes its successor.
 */
export function legacyThumbnailSidecarPath(documentId: string): string {
  return `${THUMBNAILS_SUBFOLDER}/${encodeThumbnailId(documentId)}.png`;
}

/** True when `pointer` contains a `..` segment, a backslash or a NUL — never a sidecar. */
function hasUnsafeSegment(pointer: string): boolean {
  return pointer.includes('\\') || pointer.includes('\0')
    || pointer.split('/').some(seg => seg === '..' || seg === '.');
}

/** A URL scheme (`https:`, `data:`, `blob:` …) or an absolute path — something this plan never wrote. */
export function isExternalThumbnailPointer(pointer: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(pointer) || pointer.startsWith('/');
}

/**
 * Is `pointer` a relative sidecar path the READ side may resolve (plan-776 F7)?
 *
 * It must sit in a `.thumbnails/` folder at the root (`.thumbnails/x`) or one
 * level down (`<Category>/.thumbnails/x`, catalogs), with no `..` anywhere.
 * Anything else relative is not ours and resolves to nothing (placeholder).
 */
export function isReadableThumbnailPointer(pointer: string): boolean {
  if (!pointer || isExternalThumbnailPointer(pointer) || hasUnsafeSegment(pointer)) return false;
  const segments = pointer.split('/');
  if (segments.length === 2) return segments[0] === THUMBNAILS_SUBFOLDER && segments[1] !== '';
  if (segments.length === 3) {
    return segments[0] !== '' && segments[1] === THUMBNAILS_SUBFOLDER && segments[2] !== '';
  }
  return false;
}

/**
 * The delete-safety rule of plan-776 F3: may a save/delete of `documentId`
 * remove the file at `pointer`?
 *
 * Only a project-root sidecar of exactly THIS id: `.thumbnails/<enc(id)>.<hash8>.<ext>`
 * or the legacy `.thumbnails/<enc(id)>.png`. The whole tail is matched, not a
 * prefix — `encodeThumbnailId` keeps `.` literal, so a prefix test would let a
 * save of `doc` delete the picture of `doc.a`. A URL, an absolute path, a `..`
 * or any other folder is never deleted, whoever wrote it into the manifest.
 */
export function isOwnThumbnailSidecar(pointer: unknown, documentId: string): boolean {
  if (typeof pointer !== 'string' || typeof documentId !== 'string' || documentId === '') return false;
  if (isExternalThumbnailPointer(pointer) || hasUnsafeSegment(pointer)) return false;
  const prefix = `${THUMBNAILS_SUBFOLDER}/${encodeThumbnailId(documentId)}.`;
  if (!pointer.startsWith(prefix)) return false;
  const tail = pointer.slice(prefix.length);
  return tail === 'png' || SIDECAR_TAIL.test(tail);
}

/** `hash8` + `ext` of a hashed sidecar name, or null for anything else. */
export function parseThumbnailSidecarTail(pointer: string): { hash8: string; ext: ThumbnailExt } | null {
  const file = pointer.split('/').pop() ?? '';
  const m = /\.([0-9a-f]{8})\.(webp|png)$/.exec(file);
  return m ? { hash8: m[1], ext: m[2] as ThumbnailExt } : null;
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
}
