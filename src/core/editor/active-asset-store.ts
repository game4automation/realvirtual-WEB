// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * active-asset-store — module-level handle to the live asset-editor context
 * (viewer + document). Set by the AssetEditorPlugin on mode activate/deactivate;
 * read by the hierarchy header card and the editor dialogs, which are rendered
 * through registries and therefore cannot receive the document as a prop.
 *
 * ── Why this lives in core and not in the plugin (plan-703 Phase 3) ─────────
 *
 * It used to sit in `src/plugins/asset-editor/`, which made core import UPWARDS
 * into an optional plugin (`rv-hierarchy-browser.tsx`). Plan-703 turns this
 * handle into the pointer at the current document — and eventually the current
 * STACK FRAME — so it is the one thing the whole document model hangs off. That
 * cannot live in a plugin that may not be loaded. It now sits next to its
 * scene-lineage twin, `hmi/scene/scene-store-singleton.ts`.
 *
 * The move is deliberately made WITHOUT a re-export shim at the old path: a
 * second name for the one active document is exactly the ambiguity the plan
 * removes.
 */

import type { RVViewer } from '../rv-viewer';
import type { AssetBase, AssetDocument } from './rv-asset-document';
import { stableDocumentIdOfPath } from './rv-asset-draft-storage';

export interface ActiveAssetContext {
  viewer: RVViewer;
  doc: AssetDocument;
}

let _current: ActiveAssetContext | null = null;
let _version = 0;
const _listeners = new Set<() => void>();

export function setActiveAssetContext(ctx: ActiveAssetContext | null): void {
  _current = ctx;
  _version++;
  for (const fn of _listeners) fn();
}

export function getActiveAssetContext(): ActiveAssetContext | null {
  return _current;
}

export function subscribeActiveAsset(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getActiveAssetVersion(): number {
  return _version;
}

// ─── What the scene is showing, across modes (plan-703, Lauf 14) ──────────

/**
 * Identity of the document currently loaded in the viewer, whatever mode put
 * it there — or null when nothing identifiable is loaded.
 *
 * ## Why this is here and not a fifth memory
 *
 * The goal says a mode changes which VERBS are offered, not what is open. That
 * only holds if "what is open" is one fact both sides can read, and it was not:
 * `AssetDocument.base` is the editor's own, `rememberSession` is the
 * dashboard's resume hint (a path string, per project, written to
 * localStorage), and `loadLastEditedAsset` is the editor's memory of the last
 * EDITED asset — none of which the planner writes. So switching planner →
 * editor found nothing and opened "Untitled" on top of a loaded file.
 *
 * This handle is the missing fact, and it sits beside {@link ActiveAssetContext}
 * because that is already documented as "the pointer at the current document".
 * It is deliberately **not** persisted: it describes this tab right now. The
 * persisted answers keep their jobs — `rememberSession` still decides what a
 * REOPENED project resumes into, `loadLastEditedAsset` still decides what the
 * editor opens when the scene holds nothing.
 */
let _openDocument: AssetBase | null = null;

/**
 * Record what the viewer now shows. Called by whoever loads a document —
 * today the projects dashboard for the planner and the asset editor for
 * itself, so neither mode has to know about the other.
 */
export function setOpenDocumentBase(base: AssetBase | null): void {
  _openDocument = base;
}

/** What the viewer shows, for a mode that is about to take over. */
export function getOpenDocumentBase(): AssetBase | null {
  return _openDocument;
}

// ─── Document identity across modes (plan-711 §2.1, F1) ───────────────────

/**
 * The identity of a GLB DOCUMENT (plan-716 §2.6, F6).
 *
 * One constructor rather than object literals, because many sites write this
 * fact — `SceneStore._loadIntoWorkspace` (the funnel every open path goes
 * through), the projects dashboard, the editor's open plan — and a field that
 * drifts between them is a false NEGATIVE in {@link sameDocumentBase}, i.e. a
 * document that fails to recognise itself.
 *
 * `path` defaults to `''`, which is not "unknown" but a statement: this document
 * is addressed by ID through the scene store's body slot rather than by a
 * project-relative path. See the `document` variant's doc in
 * `rv-asset-draft-storage.ts` for why that distinction is load-bearing.
 */
export function documentBase(documentId: string, name: string, path = ''): AssetBase {
  return { kind: 'document', documentId, path, name };
}

/**
 * The identity of a document at a project-relative path.
 *
 * The id is derived from the path rather than looked up, which is the same
 * deterministic derivation the migration and the legacy-record upgrade use — so
 * a document reached by path, by migration and by an old draft record all agree
 * on what its id is without any of them consulting the manifest on a
 * synchronous path.
 */
export function projectDocumentBase(relPath: string, name: string): AssetBase {
  return documentBase(stableDocumentIdOfPath(relPath), name, relPath);
}

/**
 * The identity of a document in the project's `library/` folder.
 *
 * Takes the LIBRARY-relative path — the form every catalogue entry, every menu
 * item and every stored draft already carries — and applies the `library/`
 * prefix here, once. Two kinds used to disagree about whether that prefix was
 * part of the path, and that disagreement was the whole reason
 * {@link sameDocumentBase} had to refuse to bridge them.
 */
export function libraryDocumentBase(libraryRelPath: string, name?: string): AssetBase {
  const path = `library/${libraryRelPath}`;
  const file = libraryRelPath.split('/').pop() ?? libraryRelPath;
  return projectDocumentBase(path, name ?? file.replace(/\.glb$/i, ''));
}

/**
 * The identity of a saved scene — now just a document (plan-716 §2.6).
 *
 * Kept as a NAME rather than deleted: it is the constructor plan-711's bind
 * tests and both writers already call, and plan-716's Phase-3 transition rule
 * (R1-I5) had already made the value it receives the documentId. Phase 4
 * changes what it BUILDS, not who calls it or with what — so the collapse is
 * invisible to every call site and every net that pins the bind.
 *
 * A scene passes no path on purpose (see {@link documentBase}).
 */
export function sceneDocumentBase(documentId: string, name: string): AssetBase {
  return documentBase(documentId, name);
}

/**
 * Do these two identities name the SAME document? (plan-711 F1, plan-716 F6)
 *
 * The one canonical comparison, and deliberately the most conservative one that
 * can be written: same `kind`, then the KEY FIELDS of that kind, compared
 * exactly. Never a heuristic, never a normalisation, never a cross-kind bridge.
 *
 * The reason is asymmetric cost (plan-711 risk 8). A false NEGATIVE costs the
 * user continuity they could have had — the switch falls back to today's
 * save/restore, which is a fully supported path. A false POSITIVE binds a
 * living document to a document it is not, which puts one file's op log on
 * another file's bytes.
 *
 * ## The cross-kind bridge refusal is GONE, because its cause is (plan-716)
 *
 * This function used to refuse two bridges on purpose. Both were symptoms of
 * one defect — a file could carry TWO identities depending on the door it was
 * opened through:
 *
 *  - a `libraryGlb` and a `projectDocument` could quote the same `relPath` and
 *    still be different files (`library/<p>` vs `<p>`), so a path match across
 *    kinds was not a match at all;
 *  - the same file opened as a library asset and as a project document was the
 *    same bytes under two names, and the comparison had to answer "different"
 *    because it could not tell that case from the one above.
 *
 * Both are now unaskable: owned content is one kind with one `documentId`, and
 * a path is not identity. What is deliberately NOT bridged is a document
 * against a SOURCE (`builtinModel`, `providerAsset`, `referencedAsset`) — those
 * name content we do not own, so "the same file" is not even well defined for
 * them, and `assetIdOfBase` (asset-editor/index.ts) documents why resolving a
 * `referencedAsset` to a document would mean a manifest read on a synchronous
 * path.
 *
 * An UNRECOGNISED kind never matches, not even itself. That case used to be
 * `empty` — an untitled document was its own document, and two of them were
 * two — and plan-719 F3 removed the kind but not the rule: a value out of an
 * older record, or one written by a newer build, still reaches this function,
 * and answering "these are the same document" about something we cannot
 * identify is the one wrong answer. `null` on either side is "nothing to
 * compare", which is false rather than an error — callers ask this question
 * about whatever happens to be open, including nothing.
 */
export function sameDocumentBase(a: AssetBase | null, b: AssetBase | null): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'document':
      // `documentId` ALONE. `name` is display only (a renamed document is the
      // same document) and `path` is an address, not an identity — a document
      // that moves keeps its id, and two documents can never share one.
      return a.documentId === (b as typeof a).documentId;
    case 'builtinModel':
      return a.url === (b as typeof a).url;
    case 'providerAsset': {
      const other = b as typeof a;
      // All three, because an asset id is only unique WITHIN its source.
      // `version` is advisory (see the variant's doc) and is not identity.
      return a.providerId === other.providerId
        && a.sourceId === other.sourceId
        && a.assetId === other.assetId;
    }
    case 'referencedAsset': {
      const other = b as typeof a;
      // `assetId` resolves first (the rule `AssetReference` itself prescribes),
      // and the catalog qualification has to agree with it — the same assetId
      // reached through two different libraries is two different files.
      return a.assetId === other.assetId
        && a.providerId === other.providerId
        && a.sourceId === other.sourceId;
    }
    // Not exhaustiveness ceremony: without this the switch RETURNS UNDEFINED
    // for a kind it does not know, and `undefined` is falsy in an `if` but not
    // equal to `false` — so a caller comparing the result, or a test asserting
    // it, sees something that is neither answer. A legacy record has to get a
    // real `false`.
    default:
      return false;
  }
}
