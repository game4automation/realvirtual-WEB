// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-draft-storage — the SHAPE of an asset-editor draft. Types only.
 *
 * ## What this file stopped being (plan-710 Phase 2)
 *
 * It used to be a second draft store: one slot (`'current'`) in IndexedDB plus
 * its own shelf, opened against the same database `rv-document-drafts` owns.
 * Two stores, two writers, one keyspace question answered twice. The single
 * slot is now GONE — not migrated, discarded (user decision, §2.3) — and the
 * shelf moved to `rv-document-drafts` beside the frames it shelves FROM, where
 * "put on the shelf and clear the frame" is one transaction over one database
 * rather than a cross-module handshake.
 *
 * What survives is the part nothing else can own: {@link AssetDraft} and
 * {@link AssetDraftBase} describe what the EDITOR can open. `RvDraftBase` (the
 * storage form) carries one extra variant the editor must refuse — the scene
 * lineage's baked-bytes slot — so the two unions stay field-identical twins
 * rather than one type, and `assetDraftOfFrame` is the one place that narrows.
 */

import type { RvOp } from '../ops/rv-unified-ops';

/** A draft in the shape the editor's open path speaks. */
export interface AssetDraft {
  shell: {
    id: string;
    name: string;
    base: AssetDraftBase;
    createdAt: number;
  };
  /**
   * The op log, in the ONE vocabulary (plan-710 Phase 1).
   *
   * Records written before the merge stay readable without conversion: every
   * asset-lineage kind is byte-identical across it (the single reshaped kind,
   * the scene transform, cannot occur in an asset document). That is why this
   * declaration could change from `AssetOp[]` to `RvOp[]` with no migration and
   * no read-side branch — including for entries already sitting on the shelf,
   * which is what `tests/draft-single-writer.test.ts` pins.
   */
  ops: RvOp[];
  savedAt: number;
}

/** Where the document started from (mirrors AssetBase, kept JSON-local here). */
export type AssetDraftBase =
  | { kind: 'empty' }
  /**
   * A GLB DOCUMENT the user owns — the one identity for owned bytes
   * (plan-716 §2.6, F6).
   *
   * ## What collapsed into this, and why it could
   *
   * Three variants used to name owned content: `sceneDocument` (a catalogue
   * row, keyed by `scn_` id), `projectDocument` (a manifest row, keyed by
   * project-relative path) and `libraryGlb` (the same manifest, keyed by a
   * path relative to `library/`). They were three names for one thing — a file
   * of this project the user may write to — and keeping them apart cost real
   * correctness: a file carried TWO identities depending on which door it was
   * opened through, so {@link sameDocumentBase} had to refuse to bridge kinds
   * (active-asset-store.ts, the "two known bridges" note) and a document could
   * fail to recognise itself across a mode switch.
   *
   * Since plan-716 a document has exactly ONE id, so the bridge problem is not
   * solved — it is dissolved.
   *
   * ## The fields
   *
   * `documentId` is the identity and the ONLY thing compared. `name` is display
   * only, so a rename never breaks a bind.
   *
   * `path` is the project-relative address the bytes are written to, and it is
   * NOT identity — two documents can never share an id, and a document that
   * moves keeps its id. The empty string is meaningful rather than missing: it
   * says "this document is addressed by ID through the scene store's body slot,
   * not by a path", which is what the former `sceneDocument` was. That single
   * distinction is what lets `decideSaveVerb` keep all three former routings
   * word for word (`''` → the scene verb with no `relPath`; a path → save to
   * that path).
   *
   * ## Sources are NOT documents
   *
   * `builtinModel`, `providerAsset` and `referencedAsset` deliberately did not
   * collapse. They name content the user does not own, cannot write back to,
   * and whose "Save" means "make me a copy" (`copies: true`). A source has no
   * `documentId` because there is no row of ours behind it.
   */
  | { kind: 'document'; documentId: string; path: string; name: string }
  /**
   * A built-in or published model, addressed by its stable deploy-served URL.
   *
   * Closes the identity gap the `projectDocument` variant left open: a builtin
   * demo (`?scene=builtin:…`) or published example loaded by the planner still
   * had no AssetBase name, so switching to the editor dropped the scene and
   * opened "Untitled" — the same defect, one base kind further left. Recorded
   * by `SceneStore._loadIntoWorkspace`, the one place every open path funnels
   * through. `blob:`/`data:` URLs are never recorded (dead after a reload —
   * the same reasoning under which `providerAsset` stores no URL).
   */
  | { kind: 'builtinModel'; url: string; name: string }
  /**
   * An asset that came from a registered library source (plan-372 §2.6.6).
   *
   * Stores the *identity* — provider, source, asset — and never a URL. Cloud
   * adapters hand out `blob:` URLs that are dead after a reload, so a
   * persisted URL would make every draft reopen fail silently. On reopen the
   * editor re-resolves through `getLibrarySource(providerId, sourceId)`.
   *
   * `version` is advisory: a mismatch does NOT block reopening, it only lets
   * the editor tell the user the source has moved on.
   */
  | {
      kind: 'providerAsset';
      providerId: string;
      sourceId: string;
      assetId: string;
      version?: string;
      label: string;
    }
  /**
   * An asset reached by DESCENDING into an `AssetReference` (plan-703 §2.7.3,
   * decision (a) of 2026-08-10).
   *
   * The fields are deliberately field-identical to {@link AssetReference}
   * (`rv-asset-reference.ts:63-71`) plus a `label` for the breadcrumb chip: the
   * reference in the parent file already carries exactly this information, and a
   * descend passes it through rather than translating it into a second
   * vocabulary.
   *
   * Why this variant has to exist at all: `AssetDocument` is anchored to
   * `viewer.currentModelRoot`, so a descend CANNOT span a document over the
   * grafted child subtree inside the parent tree — its ops would resolve their
   * paths against the whole parent, and a save would export the parent. The
   * child is therefore opened from its OWN bytes, which is also the only reading
   * under which `RECOMPOSE_STRATEGY = 'full-parent-reload'` makes sense (the
   * parent is reloaded on Back *because it was unloaded on descend*).
   *
   * `sha256` is deliberately NOT carried: it is not a resolution key
   * (`rv-asset-reference.ts` header — library corrections must reach every
   * referencing file), so pinning a descend to it would open stale bytes.
   */
  | {
      kind: 'referencedAsset';
      /** Primary resolution key — the referenced asset's document id. */
      assetId: string;
      /** Set together with {@link sourceId} when the asset lives in a catalog. */
      providerId?: string;
      sourceId?: string;
      /**
       * The RESOLVED, project-relative path — not the reference's own relative
       * path.
       *
       * `AssetReference.path` is relative to the file the reference is written
       * in, and that file is nowhere in this record. A draft written three
       * levels down and reopened after a crash would have nothing to resolve
       * against, so the descend resolves it once (against the parent it
       * actually had) and stores the answer.
       */
      path?: string;
      /** Display name for the breadcrumb chip and dialog copy. */
      label: string;
    };

// ─── Reading what an older build wrote (plan-716 §2.6) ──────────────────

/**
 * The three owned-content kinds that {@link AssetDraftBase}'s `document`
 * variant replaced.
 *
 * Deliberately a SEPARATE union rather than three deprecated members of the
 * live one. Membership in `AssetDraftBase` is what the compiler uses to decide
 * whether a value may be WRITTEN, and the whole point of the collapse is that
 * nothing writes these again — leaving them in with a `@deprecated` tag would
 * be a comment where a type error belongs. Keeping them here instead makes the
 * rule mechanical: a record of one of these kinds can be read (through
 * {@link upgradeLegacyAssetBase}) and can never be produced.
 *
 * Read tolerance lasts ONE release generation (plan-716 §2.6). It exists for
 * records already on disk — draft shells in IndexedDB, the last-edited pointer
 * in localStorage — written by the build the user is upgrading FROM.
 */
export type LegacyAssetDraftBase =
  | { kind: 'sceneDocument'; sceneId: string; sceneName: string }
  | { kind: 'projectDocument'; relPath: string; name: string }
  | { kind: 'libraryGlb'; fileName: string; relPath: string };

/**
 * Is this a COMPLETE record an older build wrote for owned content?
 *
 * Field-checked, not just kind-checked, and that matters: a half-written legacy
 * record must be REFUSED rather than upgraded, because the upgrade would turn
 * missing fields into a plausible-looking new record (a `libraryGlb` with no
 * `relPath` becomes the path `library/undefined`, which is a document id that
 * names nothing and compares equal to any other record with the same defect).
 * Refusing is what the old field-by-field validators did, and read tolerance
 * must not quietly relax it.
 */
export function isLegacyAssetBase(value: unknown): value is LegacyAssetDraftBase {
  if (!value || typeof value !== 'object') return false;
  const base = value as Record<string, unknown>;
  const str = (k: string): boolean => typeof base[k] === 'string' && base[k] !== '';
  switch (base['kind']) {
    case 'sceneDocument':   return str('sceneId') && typeof base['sceneName'] === 'string';
    case 'projectDocument': return str('relPath') && typeof base['name'] === 'string';
    case 'libraryGlb':      return str('relPath') && str('fileName');
    default:                return false;
  }
}

/**
 * How a legacy record's identity is recovered, injected rather than imported.
 *
 * The two lookups this needs — an alias (`scn_` → document id) and the open
 * project's manifest (path → row) — live DOWNSTREAM of this module, which is a
 * plain storage-shape file that the draft layer, the editor and the scene store
 * all read. Taking them as parameters keeps the upgrade a pure function of
 * (record, world), which is also what lets the tests state the interesting
 * cases without booting a project.
 */
export interface LegacyBaseResolver {
  /** Document id for an old `scn_` id, or null when nothing is recorded. */
  documentIdForSceneId?: (sceneId: string) => string | null;
  /** Document id for a project-relative path, or null when the row is gone. */
  documentIdForPath?: (path: string) => string | null;
  /** Project-relative path of a document id, or null when unknown. */
  pathForDocumentId?: (documentId: string) => string | null;
}

/**
 * Read a legacy record as the `document` it always was.
 *
 * ## Why a missing id is not a failure
 *
 * A `projectDocument`/`libraryGlb` record stores a PATH and no id, so the id has
 * to be recovered from the manifest. When the manifest cannot answer — the row
 * was deleted, no project is open yet, the record predates the manifest — the
 * upgrade falls back to {@link stableDocumentIdOfPath}, the same deterministic
 * path→id derivation the migration uses. Two independent derivations from the
 * same path therefore agree, and a derivation that does NOT match the real row
 * produces a false NEGATIVE in `sameDocumentBase`: the document fails to
 * recognise itself and the mode switch falls back to save/restore, which is a
 * supported path. That is the safe direction, and it is the direction the
 * comparison's own doc comment says to prefer (asymmetric cost, plan-711 risk 8).
 *
 * A `sceneDocument` record is the easy case: `scn_` ids resolve through the
 * permanent alias map, and an id with no alias is already a document id (the
 * R1-I5 transition wrote document ids through `sceneDocumentBase`).
 */
export function upgradeLegacyAssetBase(
  legacy: LegacyAssetDraftBase,
  resolve: LegacyBaseResolver = {},
): Extract<AssetDraftBase, { kind: 'document' }> {
  if (legacy.kind === 'sceneDocument') {
    const documentId = resolve.documentIdForSceneId?.(legacy.sceneId) ?? legacy.sceneId;
    return {
      kind: 'document',
      documentId,
      // A scene was addressed by id through the body slot, never by a path —
      // `''` is that statement, and `decideSaveVerb` reads it as such.
      path: resolve.pathForDocumentId?.(documentId) ?? '',
      name: legacy.sceneName,
    };
  }
  const path = legacy.kind === 'libraryGlb'
    // `libraryGlb.relPath` was always relative to `library/`; the collapsed
    // `path` is project-relative, which is the very difference that made a
    // cross-kind path match a false positive and the bridge illegal.
    ? `library/${legacy.relPath}`
    : legacy.relPath;
  const name = legacy.kind === 'libraryGlb'
    ? stemOfPath(legacy.fileName || legacy.relPath)
    : legacy.name || stemOfPath(path);
  return {
    kind: 'document',
    documentId: resolve.documentIdForPath?.(path) ?? stableDocumentIdOfPath(path),
    path,
    name,
  };
}

/**
 * Deterministic path → document id, duplicated from `rv-project-documents`.
 *
 * Copied rather than imported on purpose: this module is read by the storage
 * layer at a point where importing the project package would close a cycle
 * (project → documents → drafts → project). The two MUST agree, so
 * `tests/same-document-base.test.ts` asserts them equal rather than trusting
 * the comment.
 */
export function stableDocumentIdOfPath(path: string): string {
  const clean = (path ?? '').trim();
  const slug = clean
    .toLowerCase()
    .replace(/\.(scene\.)?(glb|gltf|json|splat|ksplat|ply)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  let hash = 0x811c9dc5;
  for (let i = 0; i < clean.length; i++) {
    hash ^= clean.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `doc_${slug || 'unnamed'}_${hash.toString(36)}`;
}

function stemOfPath(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.glb$/i, '') || file;
}
