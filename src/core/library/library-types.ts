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

/** Subfolder holding persisted preview PNGs next to a local library. */
export const THUMBNAILS_SUBFOLDER = '.thumbnails';

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
