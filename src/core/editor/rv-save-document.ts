// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-save-document — the ONE save path (plan-709 §2.2, phase 2).
 *
 * ## What it replaces
 *
 * Four modes wrote the same document through two unrelated systems: the editor
 * through `runSaveFlow` into `<workfolder>/library/Custom/` (no revision check,
 * download fallback), everything else through `SceneStore.save()` into the
 * project backend (revision check). "Where does Save put my work" therefore had
 * two answers, and which one you got depended on which mode you happened to be
 * in — not on what the document was.
 *
 * `saveDocument()` gives it one answer: **a document is saved back to where it
 * came from, in the open project.** Everything else follows from the identity
 * of what is open, not from the mode that is active.
 *
 * ## It lives in core, and that is a constraint rather than a preference
 *
 * The Save button belongs to the hierarchy header, which is core UI. Core must
 * not import upward into an optional plugin (`plugins/asset-editor`), so the
 * routing lives here, beside `active-asset-store` — the same seam plan-703 cut
 * for "what is open". The editor plugin CALLS this; it is not called by it.
 *
 * Dialogs are the plugin's business for the same reason: this module never
 * prompts. A caller that may need a name hands in {@link SaveDocumentOptions.requestName},
 * and a caller that cannot prompt (MCP, the exit guard) simply does not.
 *
 * ## The three rules that make a save-at-any-moment button safe (§2.2.1)
 *
 *  1. **The destination is bound at the start and verified at the end.** The
 *     backend used to be resolved at the moment of writing, so a project switch
 *     during a multi-second bake wrote the document into the project the user
 *     had just moved to. Now `(backend, projectId, document identity)` are
 *     captured up front; if any of them moved, the result is discarded rather
 *     than adopted.
 *  2. **One save per document at a time.** The write runs under the document's
 *     own exclusive queue, so no op can interleave with the bake, and a second
 *     click while one is running is a no-op instead of a second writer.
 *  3. **Nothing is declared saved that is not in the file.** The op floor is
 *     read BEFORE the bake; the "clean" baseline is that floor, never the log
 *     as it stands afterwards.
 *
 * ## Compare-and-swap, from the moment the document is READ (plan-710 F6)
 *
 * Every write goes out with an `expectedRevision` (plan-709 §2.3 gave
 * `writeBlob` the capability). The token is the revision this SESSION last saw
 * for that path — and "last saw" now starts at the LOAD, not at the first save:
 * the open path calls {@link noteLoadedRevision} with the bytes it is about to
 * show, so the ledger holds what the user is actually editing.
 *
 * That closes the one gap plan-709 left open and stated here rather than
 * papering over: until this plan nothing recorded a revision at load time, so
 * the first save of a path read the CURRENT bytes to form its precondition —
 * which is the other tab's write, adopted as though it were ours. The window
 * between "the user opened this file" and "the user saved it" is exactly the
 * window in which somebody else's edit has to be noticed, and it was the one
 * window that was not covered. So now:
 *
 *  - the first save of a loaded path is checked against what was LOADED, and a
 *    foreign write in between is reported as a conflict instead of overwritten;
 *  - every later save is checked against what this session wrote last;
 *  - a path this session never read (a copy into a fresh name) writes with
 *    `expectedRevision: null` — "create only" — which is a precondition of its
 *    own rather than an absence of one.
 *
 * ## Two lineages, one routing (plan-710 F5)
 *
 * `saveDocument()` takes either behaviour layer — the editor's document or the
 * scene store — and one {@link decideSaveVerb} answers for both. What is NOT
 * merged is the protection: each lineage keeps the writer that already carries
 * its plan-709 guarantees (binding, `runExclusive`, floor-before-bake, CAS,
 * write queue). The scene branch therefore delegates into `SceneStore.save()`
 * rather than re-implementing a second scene writer here — the routing is what
 * was doubled, never the safety.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { AssetDocument, AssetBase } from './rv-asset-document';
import { exportAssetGlb } from './rv-asset-glb-export';
// Namespace import on purpose: ten save-routing suites `vi.mock` this module with
// a factory that exports `exportAssetGlb` only, and a NAMED import of a missing
// export fails the ESM link in browser mode. The predicate is read only inside
// the export's clone callback, which a stubbed export never calls (plan-765 F5).
import * as assetGlbExport from './rv-asset-glb-export';
import { countWrittenReferences } from '../engine/rv-reference-audit';
import { clearSaveReferenceLoss, reportSaveReferenceLoss } from '../hmi/problems-store';
import { stableDocumentIdOfPath } from './rv-asset-draft-storage';
import { sanitizeAssetFileName, CUSTOM_LIBRARY_FOLDER } from './rv-asset-library-save';
import { getProjectStore } from '../project/project-store';
import { revisionOfBytes, SceneRevisionConflictError } from '../project/rv-scene-record';
import type { ProjectBackend, WriteExpectation } from '../project/backends/project-backend';
import { assertNoDocumentIdCollisions } from '../project/rv-asset-identity';
import { macrosForEmbed } from './rv-macro-store';
import { finishDocumentSave } from './rv-finish-document-save';
import { libraryLabelOf, librarySaveBackend } from '../library/library-save-target';

// ─── The verb, before the click (§2.2.1-6) ──────────────────────────────

/**
 * What Save WILL do, decided before the button is pressed.
 *
 * The third state is the point. A verb that can only be "save" has to express
 * "there is nowhere to put this" as a failed click, and a save button that
 * fails silently is the one thing a document editor must never have. `blocked`
 * lets the card say so up front, with the reason, while the button stays
 * pressable (disabling it would break the keyboard and screen-reader path).
 */
export type SaveVerb = 'save' | 'save-into-project' | 'blocked';

export interface SaveVerbDecision {
  verb: SaveVerb;
  /** Project-relative path the bytes would go to. Absent for `blocked`. */
  relPath?: string;
  /** Why, in a sentence a user can act on. Present for `blocked`. */
  reason?: string;
  /** True when saving would change the document's identity (§2.4). */
  copies?: boolean;
}

/**
 * Everything a save can end in that is NOT "it was written".
 *
 * Shared by both lineages verbatim: a blocked scene and a blocked asset are the
 * same event for the caller, and the card renders them from one branch. Only
 * the success case differs, because only there do the two have something
 * different to say about WHERE the bytes went.
 */
export type SaveOutcome =
  /** Nothing to do: clean and already stored. Not a failure. */
  | { kind: 'no-op' }
  /** A save was already running for this document; this click did nothing. */
  | { kind: 'busy' }
  /** The user was asked for a name and declined. */
  | { kind: 'cancelled' }
  /** No destination could be determined — {@link SaveVerbDecision.reason} says why. */
  | { kind: 'blocked'; reason: string }
  /** Somebody else wrote first. The stored bytes are THEIRS and were kept. */
  | { kind: 'conflict'; message: string }
  /** The destination moved while writing; nothing was adopted (§2.2.1-1). */
  | { kind: 'target-changed' }
  | { kind: 'error'; message: string };

/**
 * What a save's serialization did to the stored references (plan-765 F5):
 * unresolved references over the live tree in authored spelling (`before`) and
 * over the written tree (`after`), both taken inside the same save with the same
 * prune set. `byField` = the per-`Component.field` INCREASE (positive deltas only).
 */
export interface SaveReferenceCounts {
  before: number;
  after: number;
  byField: Record<string, number>;
}

export type SaveDocumentResult =
  /**
   * Written. `base` is the identity the document now has — it may have moved.
   * `references` is absent when the guard could not measure (never a reason not to save).
   */
  | { kind: 'saved'; base: AssetBase; relPath: string; copied: boolean; references?: SaveReferenceCounts }
  | SaveOutcome;

/**
 * The scene lineage's result.
 *
 * Same vocabulary, different success payload: a scene has no `AssetBase` and no
 * project-relative path of its own — it is addressed by catalogue id, and its
 * bytes live in slots the store owns. Inventing an `AssetBase` for it just to
 * share one result shape would be the second identity model plan-709 removed.
 */
export type SavePlannerResult =
  /** Written. `sceneId` is the catalogue id it now has (a first save mints one). */
  | { kind: 'saved'; sceneId: string | null }
  | SaveOutcome;

export interface SaveDocumentOptions {
  /**
   * Ask the user for a name. Only consulted when the document has none of its
   * own — a save of a named document never prompts.
   */
  requestName?: (initial: string) => Promise<string | null>;
  /** Force the prompt even for a named document (the "Save as…" verb). */
  forceNamePrompt?: boolean;
}

// ─── The session's revision ledger ──────────────────────────────────────

/**
 * `<backendId>\0<relPath>` → the revision this session last saw there.
 *
 * Module-level and deliberately keyed by backend id: a project switch replaces
 * the backend object, so its entries simply stop matching rather than leaking a
 * revision from one project into a write against another.
 */
const seenRevisions = new Map<string, string>();

function ledgerKey(backend: ProjectBackend, relPath: string): string {
  return `${backend.id} ${relPath}`;
}

/** Forget everything known about a backend. Called when a project closes. */
export function forgetSavedRevisions(backendId?: string): void {
  if (!backendId) { seenRevisions.clear(); return; }
  for (const key of [...seenRevisions.keys()]) {
    if (key.startsWith(`${backendId} `)) seenRevisions.delete(key);
  }
}

/** Retain the session's conflict precondition when the same bytes move. */
export function adoptRenamedRevision(backend: ProjectBackend, from: string, to: string): void {
  const revision = seenRevisions.get(ledgerKey(backend, from));
  seenRevisions.delete(ledgerKey(backend, to));
  if (revision) seenRevisions.set(ledgerKey(backend, to), revision);
  seenRevisions.delete(ledgerKey(backend, from));
}

/**
 * Record the revision of the bytes a load is about to show (plan-710 F6).
 *
 * Called by the open path, and this is the whole of the fix: the precondition
 * for the first save has to describe what the USER IS LOOKING AT, and the only
 * moment that is knowable is the read. Deriving it later — at save time, from
 * whatever is stored then — cannot distinguish "unchanged" from "somebody else
 * changed it while this was open", and quietly answers the second as the first.
 *
 * Never throws and never blocks the open: a revision that cannot be taken
 * simply leaves the ledger empty, which degrades to exactly the plan-709
 * behaviour rather than to a failed load.
 */
export async function noteLoadedRevision(
  backend: ProjectBackend | null,
  relPath: string,
): Promise<void> {
  if (!backend) return;
  try {
    const bytes = (await backend.readDocument(relPath))?.bytes ?? null;
    if (!bytes) return;
    seenRevisions.set(ledgerKey(backend, relPath), await revisionOfBytes(bytes));
  } catch {
    /* best-effort — see above */
  }
}

/**
 * The precondition for writing `relPath`.
 *
 * `undefined` is never returned: either this session knows what is there — from
 * the load ({@link noteLoadedRevision}) or from its own last write — or it
 * looks, and "nothing is there" is `null`, which is a precondition of its own
 * ("create only") rather than an absence of one.
 *
 * The lookup below is the fallback for a path this session never read, not the
 * normal case: for a loaded document the ledger already answers, which is what
 * makes a foreign write between load and first save a conflict.
 */
async function expectedRevisionFor(
  backend: ProjectBackend,
  relPath: string,
): Promise<WriteExpectation> {
  const known = seenRevisions.get(ledgerKey(backend, relPath));
  if (known) return known;
  // One read, and it already carries the revision — no object URL to own, no
  // second hash of bytes the backend just hashed (plan-736 Phase 1).
  const record = await backend.readDocument(relPath).catch(() => null);
  if (!record) return 'create';
  seenRevisions.set(ledgerKey(backend, relPath), record.revision);
  return record.revision;
}

// ─── Routing (§2.2 step 1, §2.3; one function since plan-710 F5) ────────

/**
 * What {@link decideSaveVerb} needs to know about the document, in either
 * lineage.
 *
 * Deliberately not "an `AssetBase` or a `SceneSnapshot`". The scene half of the
 * decision reads exactly two facts — is something open, and is the workspace
 * transient — and passing the whole snapshot would tie this module to the scene
 * store's shape for no gain. What the union DOES buy is the thing plan-710
 * asked for: one function, so the refusal sentences can never drift apart
 * between a scene and an asset, which is precisely what happened while there
 * were two.
 */
export type SaveSubject =
  | { lineage: 'editor'; base: AssetBase | null; name: string }
  | { lineage: 'planner'; open: boolean; transient: boolean };

/**
 * Where this document's bytes belong, and whether writing them there is
 * possible at all.
 *
 * Pure and synchronous on purpose: the card calls it on every render to label
 * the button, so it may not read a file. Everything it needs is in the identity
 * plus the backend's own `writable` flag.
 *
 * A scene decision carries no `relPath`: the scene lineage addresses its bytes
 * by slot through the store, not by a project-relative path the card could
 * show. `verb` and `reason` are the whole contract there.
 */
export function decideSaveVerb(
  subject: SaveSubject,
  backend: ProjectBackend | null = getProjectStore().getBackend(),
): SaveVerbDecision {
  const open = subject.lineage === 'editor' ? subject.base !== null : subject.open;
  if (!open) return { verb: 'blocked', reason: 'Nothing is open.' };
  // plan-778: a library document is decided on library B's backend, not the caller's.
  if (subject.lineage === 'editor' && subject.base?.kind === 'libraryDocument') {
    return decideLibrarySaveVerb(subject.base, saveTargetBackendOf(subject.base));
  }
  // The three refusals both lineages share, in one place and one wording.
  if (!backend) {
    return { verb: 'blocked', reason: 'No project is open — open or create one to save.' };
  }
  if (!backend.writable) {
    return {
      verb: 'blocked',
      reason: backend.kind === 'bundled'
        ? 'This project ships with the application and cannot be written to. Create or open your own project to save.'
        : 'The open project is read-only.',
    };
  }

  if (subject.lineage === 'planner') {
    // A transient workspace holds somebody else's content and persists nothing
    // (plan-386 §2.5). Saying so beats a Save that appears to work.
    if (subject.transient) {
      return {
        verb: 'blocked',
        reason: 'This workspace holds shared content and is not saved back. '
          + 'Use "Save as…" to keep it as a scene of this project.',
      };
    }
    return { verb: 'save' };
  }

  const { base, name } = subject;
  // The `open` test above already established this; repeated for the narrowing,
  // because `open` is computed and the compiler cannot follow it back.
  if (!base) return { verb: 'blocked', reason: 'Nothing is open.' };
  switch (base.kind) {
    // A DOCUMENT of this project — save it to itself (plan-716 §2.6).
    //
    // The three former owned-content kinds each had their own line here, and
    // the collapse has to keep all three answers WORD FOR WORD (§2.6). It does,
    // through the one distinction `path` carries:
    //
    //  - `''` — addressed by ID through the scene store's body slot, never by a
    //    path. This is the former `sceneDocument`, and the decision must carry
    //    no `relPath` at all: a `relPath` here would be the beginning of the
    //    wrong writer (plan-711 F4 / R2-F-A), and `same-document-base.test.ts`
    //    pins its absence.
    //  - a path — the former `projectDocument` (`models/x.glb`) and
    //    `libraryGlb` (`library/<relPath>`, folded in at construction so the
    //    `library/` prefix is applied exactly once, where the identity is
    //    built rather than everywhere it is read).
    //
    // Neither sets `copies`: a document IS the user's, so saving it is never a
    // "make it mine" copy. That is the whole copy-semantics rule, and the
    // sources below are the only side of it that changes anything.
    case 'document':
      return base.path ? { verb: 'save', relPath: base.path } : { verb: 'save' };
    case 'referencedAsset':
      // A reference reached by path is a project document under another name.
      // One reached through a catalog is somebody else's copy — §2.4 applies.
      if (base.path && !base.providerId) return { verb: 'save', relPath: base.path };
      return {
        verb: 'save-into-project',
        relPath: `models/${modelFileName(name || base.label)}`,
        copies: true,
      };
    // Catalog assets and deploy-served models cannot be written back to their
    // source, so Save means "make it mine" (§2.4) — announced, never silent.
    case 'providerAsset':
    case 'builtinModel':
      return {
        verb: 'save-into-project',
        relPath: `models/${modelFileName(name)}`,
        copies: true,
      };
    // There is no `'empty'` case any more (plan-719 F3). It used to be the
    // third answer here — "a brand-new asset that just needs a name before it
    // has a path" — and it was the whole first-save special case: the one
    // identity whose destination was invented at save time rather than known
    // at open time. New documents are created with a path now, so the switch
    // is down to the two the target semantics describe: a document saves to
    // itself, a source asks once.
    default:
      return { verb: 'blocked', reason: 'This document has no place to be saved to.' };
  }
}

/** The backend a document is written through: library B's for a `libraryDocument` (plan-778), else the open project's. */
export function saveTargetBackendOf(base: AssetBase | null): ProjectBackend | null {
  if (base?.kind === 'libraryDocument') return librarySaveBackend(base.libraryProjectId);
  return getProjectStore().getBackend();
}

/** Save into library B in place, or why not. */
function decideLibrarySaveVerb(
  base: Extract<AssetBase, { kind: 'libraryDocument' }>,
  backend: ProjectBackend | null,
): SaveVerbDecision {
  const label = base.libraryLabel || libraryLabelOf(base.libraryProjectId);
  if (backend?.writable) return { verb: 'save', relPath: base.path };
  return {
    verb: 'blocked',
    reason: backend
      ? `This document belongs to library '${label}' and is read-only here: Edit in library saves into a library `
        + 'folder on this computer, Copy into project changes it for this project only.'
      : `Library '${label}' is not available — grant access or locate its folder first.`,
  };
}

function assetFileName(name: string): string {
  return `${sanitizeAssetFileName(name)}.glb`;
}

function modelFileName(name: string): string {
  return `${sanitizeAssetFileName(name)}.glb`;
}

/**
 * The folder a "Save as…" copy lands in: the open document's own, or the
 * PROJECT ROOT when it has none (plan-744 F7).
 *
 * Only a document that HAS a project path can name a folder. A slot-addressed
 * document (`path === ''`) and a source that was never in the project have no
 * neighbourhood to be saved beside — and the fallback for those used to be
 * `library/Custom`, which was the last place the product treated a folder as a
 * type. It filed a first save under "library" whatever the thing was, in a
 * subfolder the user never asked for and would not find again.
 *
 * The root is the honest answer: the document has no place yet, so it lands
 * where the project starts, and the save dialog's folder picker is where the
 * user says otherwise.
 */
function saveAsFolder(base: AssetBase): string {
  const path = (base.kind === 'document' || base.kind === 'referencedAsset' ? base.path : '') ?? '';
  const slash = path ? path.lastIndexOf('/') : -1;
  return slash > 0 ? path.slice(0, slash) : '';
}

/**
 * `folder` + `file` as one project-relative path — and just `file` at the root.
 *
 * A project path never starts with a slash, so the empty folder
 * {@link saveAsFolder} now returns must not become one through the template
 * that used to interpolate it.
 */
function joinProjectPath(folder: string, file: string): string {
  return folder === '' ? file : `${folder}/${file}`;
}

// ─── The one entry point ────────────────────────────────────────────────

/** Documents currently mid-save. The second click's no-op (§2.2.1-3). */
const saving = new WeakSet<object>();

/**
 * Documents currently mid-PROMPT (plan-719 §2.10, second layer).
 *
 * Separate from {@link saving} because the two cover different windows and the
 * gap between them is where the race lived: `saving` starts when the write
 * does, and a name prompt can stand open for as long as the user looks at it.
 * Marked before the `requestName` await and cleared in a `finally`, so a
 * rejected prompt cannot leave a document permanently "busy".
 */
const prompting = new WeakSet<object>();

/**
 * Woken whenever {@link isSaving} could have changed.
 *
 * The two WeakSets above ARE the card's busy state, but they notify nobody. The
 * last publish of a save happens inside `runExclusive`, i.e. before the
 * `finally` that clears the marker — so the card's Save button kept saying
 * "Saving…" long after the write had landed, until some unrelated document
 * change came along to republish it (field finding 2026-08-26). The markers are
 * announced here so a reader of {@link isSaving} hears them go quiet.
 */
const saveActivityListeners = new Set<() => void>();

/** Subscribe to {@link isSaving} transitions. */
export function subscribeSaveActivity(listener: () => void): () => void {
  saveActivityListeners.add(listener);
  return () => { saveActivityListeners.delete(listener); };
}

/** Copied before iterating — a listener may unsubscribe itself. */
function noteSaveActivity(): void {
  for (const fn of [...saveActivityListeners]) fn();
}

/**
 * The scene lineage as this module needs it — structural, on purpose.
 *
 * `SceneStore` lives in `core/hmi/scene` and already imports the project store
 * this module imports; naming its class here would buy a cycle for nothing.
 * What routing needs is four members, and `lineage` is the discriminant that
 * keeps the choice a compile-time one rather than a duck-type guess.
 */
export interface PlannerSaveFacade {
  readonly lineage: 'planner';
  getSnapshot(): {
    draft: { name: string } | null;
    saved: { id: string } | null;
    isDraft: boolean;
    dirty: boolean;
    transient: boolean;
  } | null;
  /**
   * The store's document identity, when it can state one — the same surface
   * the mode-transition BIND compares (`SceneStore.documentIdentity`).
   * Optional in the facade because only the bound-save routing needs it; a
   * facade without it falls back to `saved.id`, which covers the legacy
   * scene-glb workspace.
   */
  documentIdentity?(): AssetBase | null;
  /** Resolves with what the save DID — see `SceneSaveVerdict`. */
  save(): Promise<'saved' | 'no-op' | 'target-changed'>;
  saveAs(name: string): Promise<string>;
}

/** Either behaviour layer over the one document class (plan-710 F5). */
export type SaveableDocument = AssetDocument | PlannerSaveFacade;

function isPlannerSaveFacade(doc: SaveableDocument): doc is PlannerSaveFacade {
  return (doc as PlannerSaveFacade).lineage === 'planner';
}

/**
 * Save the open document back to where it came from, in the open project.
 *
 * Takes either lineage. The asset branch bakes and writes here; the scene
 * branch routes into `SceneStore.save()`/`saveAs()`, which is where the scene's
 * own plan-709 guarantees live. Merging the ROUTING is the point — the two
 * writers stay separate because their content genuinely is (an authored GLB vs.
 * a scene body baked from an op log against its base bytes).
 *
 * @returns what happened. Never throws for an expected outcome — a conflict, a
 *   read-only source and a cancelled prompt are all results, because the card
 *   has to render each of them differently and an exception carries no state.
 */
export async function saveDocument(
  viewer: RVViewer,
  doc: AssetDocument,
  opts?: SaveDocumentOptions,
): Promise<SaveDocumentResult>;
export async function saveDocument(
  viewer: RVViewer | null,
  doc: PlannerSaveFacade,
  opts?: SaveDocumentOptions,
): Promise<SavePlannerResult>;
export async function saveDocument(
  viewer: RVViewer | null,
  doc: SaveableDocument,
  opts: SaveDocumentOptions = {},
): Promise<SaveDocumentResult | SavePlannerResult> {
  if (isPlannerSaveFacade(doc)) return savePlannerDocument(doc, opts);
  return saveEditorDocument(viewer as RVViewer, doc, opts);
}

/**
 * The scene branch.
 *
 * No second `saving` guard and no second binding check: `SceneStore.save()`
 * runs the whole transaction on the document's own exclusive queue and verifies
 * (workspace, backend, project) after the bake — including the `workspaceAtStart`
 * identity guard that catches a load slipping past the queue through
 * `_installOps`. Adding a WeakSet here would change scene concurrency behaviour,
 * which is not what "one routing" means.
 */
async function savePlannerDocument(
  store: PlannerSaveFacade,
  opts: SaveDocumentOptions,
): Promise<SavePlannerResult> {
  const snap = store.getSnapshot();
  const backend = getProjectStore().getBackend();
  const decision = decideSaveVerb(
    { lineage: 'planner', open: !!snap?.draft, transient: snap?.transient === true },
    backend,
  );
  if (decision.verb === 'blocked' || !snap) {
    return { kind: 'blocked', reason: decision.reason ?? 'This scene cannot be saved.' };
  }

  try {
    // A never-saved draft has no id yet, so it needs a name before it has a
    // place — asked through the caller's prompt rather than minted silently,
    // which is also §2.2.1-4's rule that a stray click may not create a file out
    // of nothing. `forceNamePrompt` is the "Save as…" verb, same as the asset half.
    //
    // `isDraft` ALONE, not `|| !snap.saved`: a workspace bound to a document
    // row reports `saved: null` while having a file to save into
    // (`_resolveSaveTarget` case 1), and `isDraft` is the one flag that says
    // "no place yet". The old disjunction sent every row-opened document
    // through the prompt + `saveAs` fork (field finding 2026-08-14).
    if (opts.forceNamePrompt || snap.isDraft) {
      if (!opts.requestName) {
        return { kind: 'blocked', reason: 'This scene needs a name before it can be saved.' };
      }
      const picked = await opts.requestName(snap.draft?.name ?? '');
      if (picked === null || !picked.trim()) return { kind: 'cancelled' };
      return { kind: 'saved', sceneId: await store.saveAs(picked.trim()) };
    }
    if (!snap.dirty) return { kind: 'no-op' };
    // The verdict, not an assumption: a save whose target moved mid-write
    // adopted nothing, and reporting that as success is how the card ends up
    // telling the user their work is stored when it is not (§2.2.1-1).
    switch (await store.save()) {
      case 'target-changed': return { kind: 'target-changed' };
      case 'no-op':          return { kind: 'no-op' };
      default:
        return { kind: 'saved', sceneId: store.getSnapshot()?.saved?.id ?? null };
    }
  } catch (e) {
    if (e instanceof SceneRevisionConflictError) {
      return { kind: 'conflict', message: e.message };
    }
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The scene store, IF it is still showing the scene `sceneId` names.
 *
 * Dynamically imported on purpose. `SceneStore` lives downstream of this module
 * (it imports the project store this module imports, and `active-asset-store`
 * beside it), which is why the scene lineage reaches this file as the
 * structural {@link PlannerSaveFacade} rather than as a named class. The routing
 * of a BOUND document is the one case that has to go the other way — it starts
 * from an `AssetBase` and needs the instance — so it takes the import at call
 * time and keeps the module graph acyclic.
 *
 * The id check is not ceremony: the editor may have been left open across a
 * scene switch, and saving "the planner's document" into whatever document is open now
 * is precisely the mis-binding the identity work exists to prevent.
 */
async function plannerSaveTargetFor(sceneId: string): Promise<PlannerSaveFacade | null> {
  try {
    const { getSceneStore } = await import('../hmi/scene/scene-store-singleton');
    const store = getSceneStore();
    if (!store) return null;
    // The same identity surface the BIND compared (`documentIdentity()`), not
    // `saved.id`: a document workspace opens with `_saved = null` and only a
    // planner save in THIS session fills it, so a bound editor document was
    // refused as "not the scene that is open" until the planner had saved once
    // — the very document the transition had just handed over. `saved.id`
    // stays as the fallback for the legacy scene-glb workspace, whose identity
    // answers from `saved` anyway.
    const identity = store.documentIdentity?.();
    if (identity?.kind === 'document' && identity.documentId === sceneId) return store;
    return store.getSnapshot()?.saved?.id === sceneId ? store : null;
  } catch {
    return null;
  }
}

async function saveEditorDocument(
  viewer: RVViewer,
  doc: AssetDocument,
  opts: SaveDocumentOptions = {},
): Promise<SaveDocumentResult> {
  // plan-462 B3 — the lock is taken HERE, before the first side effect of the
  // save: before the export, before the write, before `markSaved`. The old
  // guard sat in `save-flow.ts` and covered only the editor's own button; the
  // MCP save tool, the exit-guard save and every other caller reached the
  // export with a test scene in `currentModelRoot` and baked its runtime poses
  // in as the authored zero position.
  //
  // The owner is `save`, which is short-lived and excludes a test START for its
  // duration (`tryLock` is fail-fast, so the test says no rather than waiting)
  // — and is deliberately NOT refused by the document's own mutation guards,
  // because the save legitimately calls `markSaved` from inside it.
  const lock = doc.tryLock('save');
  if (!lock) {
    const owner = doc.lockOwner;
    return {
      kind: 'blocked',
      reason: owner?.kind === 'test-run'
        ? 'A test run is active (in-place test session): the scene shows runtime poses, '
          + 'and saving now would bake them into the GLB as the authored zero position. '
          + 'Stop the test run first, then save.'
        : 'This document is already being saved — wait for that save to finish.',
    };
  }
  try {
    return await saveEditorDocumentLocked(viewer, doc, opts);
  } finally {
    doc.unlock(lock);
  }
}

async function saveEditorDocumentLocked(
  viewer: RVViewer,
  doc: AssetDocument,
  opts: SaveDocumentOptions = {},
): Promise<SaveDocumentResult> {
  // A document addressed BY SLOT is saved by the SCENE writer, whichever
  // lineage holds it (plan-711 R2-F-A, plan-716 §2.6). `decideSaveVerb` states
  // the verb for this identity; this is where the write is actually routed, and
  // it is deliberately unconditional on the caller: the editor's Save button,
  // Ctrl+S and the MCP save tool all arrive here through `AssetDocument`, and
  // each of them must reach the body slot by document id — never the
  // `relPath`/`exportAssetGlb` path, which would write an authored GLB into
  // `models/` and leave the document it came from untouched.
  //
  // The test is `path === '' OR bound`. Path-less is the collapsed spelling of
  // the condition this branch always had (`kind === 'sceneDocument'`). BOUND is
  // the second spelling of the same fact since the identity started carrying
  // the row's path: a bound facade borrows the scene's LIVING document, so its
  // bytes are the scene bake against the op log — the asset writer below would
  // export the authored tree instead and leave the scene store's own state
  // (base bytes, revision notes, draft slots) describing a file it no longer
  // matches. An unbound document WITH a path — the former
  // `projectDocument`/`libraryGlb` — falls through to the asset writer, exactly
  // as it did.
  //
  // Before the `saving` WeakSet on purpose: the scene branch has its own
  // concurrency discipline (`SceneStore.save()` holds the document's exclusive
  // queue and re-verifies its target after the bake), and adding a second guard
  // here would change scene behaviour — the same reasoning `savePlannerDocument`
  // already documents.
  if (doc.base.kind === 'document' && (!doc.base.path || doc.isBound)) {
    const store = await plannerSaveTargetFor(doc.base.documentId);
    if (!store) {
      return {
        kind: 'blocked',
        reason: `"${doc.base.name || 'This scene'}" is not the scene that is open — switch back to it to save.`,
      };
    }
    const result = await savePlannerDocument(store, opts);
    // No post-save step of its own (plan-777 P8): this branch writes through
    // the planner's writer, and the planner's save runs `finishDocumentSave`
    // itself — exactly one announce and one rescan per save.
    // Translated, not re-shaped: the caller asked through the asset overload and
    // reads an `AssetBase` back. `relPath` is the identity's own — the row's
    // path when it carries one, empty for a genuinely slot-addressed document —
    // and the one consumer of an empty one skips it rather than inventing a
    // path (`save-flow.ts`).
    return result.kind === 'saved'
      ? { kind: 'saved', base: doc.base, relPath: doc.base.path, copied: false }
      : result;
  }

  // §2.10, the second layer. `saving` alone was not enough once the prompt
  // became the REGULAR case for a read-only source: the WeakSet used to be set
  // AFTER `requestName` resolved, so a second click during the open dialog
  // sailed through this check and started a second run whose own prompt
  // overwrote the first one's state and orphaned its resolve closure. The
  // public `save-dialog-store` holds the primary guard (one pending slot per
  // document, whichever entry point asks); this covers callers that inject a
  // `requestName` of their own and never reach that store.
  if (saving.has(doc) || prompting.has(doc)) return { kind: 'busy' };

  // §2.2.1-1: bind the destination BEFORE anything long-running starts.
  const store = getProjectStore();
  const baseAtStart = doc.base;
  // plan-778: the TARGET backend, bound before anything long-running.
  const backend = saveTargetBackendOf(baseAtStart);
  const projectIdAtStart = store.getProject()?.id ?? null;
  const library = baseAtStart.kind === 'libraryDocument' ? baseAtStart : null;

  let name = doc.name;
  // Routed BEFORE the prompt, because the verb is what decides whether there is
  // a question to ask at all. A document saves to itself in silence; only a
  // source that cannot be written back has to be placed somewhere first.
  const routed = decideSaveVerb({ lineage: 'editor', base: baseAtStart, name }, backend);
  if (routed.verb === 'blocked' || !backend) {
    return { kind: 'blocked', reason: routed.reason ?? 'This document cannot be saved.' };
  }
  if (library && opts.forceNamePrompt) {
    return { kind: 'blocked', reason: '"Save as…" is not available for a library document — use Copy into project.' };
  }

  /**
   * The ONE prompt (plan-719 F2), and the three reasons it appears:
   *
   *  - `forceNamePrompt` — the explicit "Save as…" verb;
   *  - `save-into-project` — a catalog asset, a built-in model or an unowned
   *    reference. This is the behaviour change: the copy used to happen
   *    SILENTLY into `models/<name>.glb`, choosing the destination for the
   *    user. It is announced on the button and now confirmed in a dialog, and
   *    it happens exactly once — afterwards the document is theirs and F1
   *    applies forever;
   *  - a document with NO name at all (an empty string — a state, not a
   *    naming convention).
   *
   * "Untitled" is deliberately NOT a reason (field decision 2026-08-19): it is
   * a NAME like any other, given by the create verb and changed by Rename. A
   * document called Untitled saves to its own path in silence exactly like
   * one called anything else — treating the string specially is how every
   * fresh document grew its own save behaviour.
   */
  const mustPrompt = opts.forceNamePrompt === true
    || routed.verb === 'save-into-project'
    || !name;

  if (mustPrompt) {
    if (!opts.requestName) {
      // Two different situations, two sentences (F5). A caller that cannot ask
      // is a real dead end, and "needs a name" would be actively misleading for
      // a read-only source: the user has not withheld a name, the SOURCE is the
      // problem, and the way out is choosing where the copy should go.
      return {
        kind: 'blocked',
        reason: routed.verb === 'save-into-project'
          ? 'This asset is read-only. Saving it needs a name for the copy in your project.'
          : 'This document needs a name before it can be saved.',
      };
    }
    // Marked BEFORE the await, cleared in `finally` — the whole point of the
    // guard is to cover the window the dialog is open in, which is precisely
    // the window the old placement (after the await) left uncovered.
    prompting.add(doc);
    noteSaveActivity();
    let picked: string | null;
    try {
      picked = await opts.requestName(name);
    } finally {
      prompting.delete(doc);
      noteSaveActivity();
    }
    // Declining writes NOTHING: no blob, no manifest row, no identity change.
    // The source stays exactly the read-only thing it was.
    if (picked === null || !picked.trim()) return { kind: 'cancelled' };
    name = picked.trim();
  }

  // Re-routed with the CONFIRMED name, because the destination file name is
  // derived from it — routing once with the old name would place the copy
  // under the source's name and ignore what the user just typed.
  const named = decideSaveVerb({ lineage: 'editor', base: baseAtStart, name }, backend);
  // "Save as…" is the user naming a NEW document BESIDE the one that is open —
  // `models/Cell.glb` saves as `models/<name>.glb`, a library asset stays in its
  // own library folder. It used to send every save-as to
  // `library/<Custom>/`, which is the pre-716 "the editor writes into the Custom
  // library" rule surviving in the one branch that overrides the routing: a user
  // saving a copy of a project model found it filed somewhere else entirely.
  // Since plan-744 F7 the PROJECT ROOT is the fallback for a document with no
  // folder of its own (slot-addressed, or a root-level file) — `library/Custom`
  // was the last folder-as-a-type in the save path.
  //
  // It overrides the DESTINATION only, never the refusals: a read-only project
  // stays blocked. And it is a COPY — a new file with an identity of its own, so
  // `copies` is what gives it a free path and a fresh document id instead of
  // forking the source's.
  const decision: SaveVerbDecision = opts.forceNamePrompt && named.verb !== 'blocked'
    ? {
        verb: 'save',
        relPath: joinProjectPath(saveAsFolder(baseAtStart), assetFileName(name)),
        copies: true,
      }
    : named;
  if (decision.verb === 'blocked' || !decision.relPath) {
    return { kind: 'blocked', reason: decision.reason ?? 'This document cannot be saved.' };
  }

  // §2.2.1-4: a clean document that already lives somewhere is a true no-op.
  // Notably it does NOT mint a new identity, which is what made a stray second
  // click on an untouched document produce a second file.
  if (!doc.dirty && !decision.copies && name === doc.name) {
    return { kind: 'no-op' };
  }

  saving.add(doc);
  noteSaveActivity();
  try {
    // §2.2.1-2: the whole transaction holds the op queue. `runExclusive` is
    // what makes "the floor captured before the bake" a fact rather than a
    // hope — no op can be recorded between the two.
    return await doc.document.runExclusive(async () => {
      const relPath = decision.copies
        ? await uniqueProjectPath(backend, decision.relPath!)
        : decision.relPath!;

      // Live-preview holders (drive jog, gizmo drags) put their ephemeral
      // state back BEFORE the tree is cloned — a preview pose must not bake in.
      viewer.emit('asset-editor-pre-export', { source: 'save-document' });

      const assetRoot = viewer.currentModelRoot;
      if (!assetRoot) return { kind: 'error', message: 'No asset is loaded.' } as const;

      const floorAtBakeStart = doc.document.opCount;
      // `exportAssetGlb` runs `pruneComposedReferenceSubtrees` first — the
      // plan-703 Lauf-11 fix. Routing the save through a different exporter is
      // exactly how composed references would get melted back into the parent,
      // so this path deliberately reuses the one that already prunes.
      //
      // plan-765 F5, the save guard: both counts are taken when the export
      // hands out its clone — after the authored-name restore and both prunes,
      // before the sanitizer — so they measure exactly what the serialization
      // loses, not what the user edited (a broken edit is the live audit's
      // `reference-unresolved`). The live tree is untouched at that moment (the
      // export only reads it, and `runExclusive` holds every op). Measured in
      // the callback rather than before the call, so an export stub that never
      // clones (the save-routing tests mock the module) measures nothing.
      let references: SaveReferenceCounts | undefined;
      const glb = await exportAssetGlb(assetRoot, name, undefined, undefined, {
        onClone: (clone) => { references = measureSavedReferences(assetRoot, clone); },
        // plan-641 M5: the document's macros ride in the scene extras.
        macros: macrosForEmbed(doc.document),
        // plan-769 Phase 3: every stored reference is read the way the scene reads it.
        registry: viewer.registry ?? null,
      });
      const bytes = new Uint8Array(glb);

      // A copy goes to a path nothing may occupy; an in-place save replaces
      // what this session last saw there.
      const expectedRevision: WriteExpectation = decision.copies
        ? 'create'
        : await expectedRevisionFor(backend, relPath);

      try {
        await backend.writeDocument(relPath, bytes, { expectedRevision });
      } catch (e) {
        if (e instanceof SceneRevisionConflictError) {
          return { kind: 'conflict', message: e.message } as const;
        }
        throw e;
      }

      // §2.2.1-1, the verification half. The bytes are written and valid; only
      // the ADOPTION is abandoned, so nothing is entered into a project the
      // user has meanwhile moved to.
      if (
        saveTargetBackendOf(doc.base) !== backend
        || (store.getProject()?.id ?? null) !== projectIdAtStart
        || doc.base !== baseAtStart
      ) {
        return { kind: 'target-changed' } as const;
      }

      seenRevisions.set(ledgerKey(backend, relPath), await revisionOfBytes(bytes));

      // The identity the document has from here on. A copy MOVES it (§2.4):
      // the session continues on the copy, so the breadcrumb, the draft
      // keyspace and the next save all follow the new path — that is what
      // `markSaved(nextBase)` does, and why it takes the base rather than
      // assuming the old one.
      // plan-778: a library document keeps its identity in library B.
      const nextBase = library ? { ...library, name } : nextIdentity(baseAtStart, relPath, name);
      // plan-703's collision machinery, not a second one: a copy that lands
      // beside an identically named document must be caught here rather than
      // by whoever reads the manifest next.
      try {
        if (!library) assertNoDocumentIdCollisions(store.getProject());
      } catch (e) {
        console.warn('[save-document] identity collision after save:', e);
      }
      await doc.markSaved(nextBase, name);
      // The floor captured before the bake — NOT the log as it stands now.
      doc.document.markSaved({ floor: floorAtBakeStart });

      // The one post-save step (plan-777 F5/P8): thumbnail → `document-saved`
      // → background rescan, AFTER the identity has moved — the preview is keyed
      // by the id since plan-744 F5, and a subscriber reading the document back
      // sees the state the bytes describe. Announced for every path, which is
      // what makes the planner's cache invalidation correct for `models/**` as
      // well as `library/**` (Defect b). Never able to fail the save.
      // plan-778: into library B — B's row gets the new hash and B is re-read;
      // nothing of A (thumbnail, announce, rescan) describes it.
      if (library) {
        await (await import('../library/library-document-edit')).finishLibraryDocumentSave(
          library.libraryProjectId, backend, relPath, bytes);
      } else {
        await finishDocumentSave({
          viewer, store, backend, documentId: nextBase.documentId, relPath,
        });
      }

      // plan-765 F5: reported once the file is really written and adopted — a
      // conflict or a moved target wrote nothing this document owns. Keyed by
      // the identity the document has NOW; a copy also retires the entry of
      // the identity it was saved from (the session continues on the copy).
      if (references) {
        if (references.after > references.before) {
          reportSaveReferenceLoss(nextBase.documentId, references.before, references.after, references.byField);
        } else {
          clearSaveReferenceLoss(nextBase.documentId);
        }
        const startId = 'documentId' in baseAtStart ? baseAtStart.documentId : null;
        if (startId && startId !== nextBase.documentId) clearSaveReferenceLoss(startId);
      }

      return {
        kind: 'saved',
        base: nextBase,
        relPath,
        copied: decision.copies === true,
        ...(references ? { references } : {}),
      } as const;
    });
  } catch (e) {
    console.error('[save-document] save failed:', e);
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  } finally {
    saving.delete(doc);
    noteSaveActivity();
  }
}

/** The authored name of a node: the loader's dedup stamp when it carries one (plan-734), else its name. */
function authoredNameOf(node: Object3D): string {
  const orig: unknown = node.userData?._rvOrigName;
  return typeof orig === 'string' && orig.length > 0 ? orig : node.name;
}

/**
 * The save guard's two counts (plan-765 F5): the LIVE tree spelled in authored
 * names with the export's own prune predicate, and the export CLONE spelled in
 * the names the file will hold. Never throws — a guard that cannot measure
 * reports nothing and the save goes on (decision Q5: the guard never blocks).
 */
function measureSavedReferences(liveRoot: Object3D, clone: Object3D): SaveReferenceCounts | undefined {
  try {
    const before = countWrittenReferences(liveRoot, authoredNameOf, assetGlbExport.exportPrunePredicate);
    const after = countWrittenReferences(clone, (n) => n.name);
    const byField: Record<string, number> = {};
    for (const [key, n] of Object.entries(after.byField)) {
      const grown = n - (before.byField[key] ?? 0);
      if (grown > 0) byField[key] = grown;
    }
    return { before: before.unresolved, after: after.unresolved, byField };
  } catch (e) {
    console.warn('[save-document] reference guard could not measure this save:', e);
    return undefined;
  }
}

/**
 * True while a save of this document is in flight (the card's busy state).
 *
 * Includes the PROMPT since plan-719: from the user's side "Save into project
 * as…" is part of the save they started, and a card that showed the button
 * back at rest while its own dialog was up would invite the second click the
 * guard then has to swallow.
 */
export function isSaving(doc: object): boolean {
  return saving.has(doc) || prompting.has(doc);
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * The identity a document has after being written to `relPath`.
 *
 * One kind since plan-716 §2.6, so the `library/` special case that used to
 * pick between `libraryGlb` and `projectDocument` is gone with the choice: the
 * collapsed `path` is project-relative for BOTH, which is what made the two
 * kinds a distinction without a difference in the first place.
 *
 * The id is the interesting part. A document that was already ours keeps its
 * `documentId` even when the path changes — a moved or renamed file is the same
 * document, and re-deriving the id here would silently fork it. A SOURCE being
 * copied into the project (`copies: true`) has no id of ours to keep, so it
 * gets one derived from the path it just landed on — the same derivation the
 * migration and the legacy-record upgrade use, so all three agree on what a
 * given path's document id is.
 */
function nextIdentity(
  base: AssetBase,
  relPath: string,
  name: string,
): Extract<AssetBase, { kind: 'document' }> {
  if (base.kind === 'document' && base.documentId) {
    return { kind: 'document', documentId: base.documentId, path: relPath, name };
  }
  return {
    kind: 'document',
    documentId: stableDocumentIdOfPath(relPath),
    path: relPath,
    name,
  };
}

/**
 * A path in the project that nothing occupies yet.
 *
 * Uses the SAME dedup rule as `saveSettingsIntoModel` (`<stem>_1.glb`, …) — the
 * plan is explicit that the read-only copy must not invent a second one, and
 * two spellings of "the name was taken" is how a project ends up with both
 * `Press_1.glb` and `Press (1).glb`.
 */
async function uniqueProjectPath(backend: ProjectBackend, relPath: string): Promise<string> {
  const slash = relPath.lastIndexOf('/');
  const folder = slash >= 0 ? relPath.slice(0, slash) : '';
  const fileName = slash >= 0 ? relPath.slice(slash + 1) : relPath;

  let taken: Set<string>;
  try {
    const documents = await backend.listDocuments();
    taken = new Set(
      documents
        .map(d => (d.path ?? '').toLowerCase())
        .filter(p => p.startsWith(`${folder.toLowerCase()}/`)),
    );
  } catch {
    return relPath;                    // listing is a convenience, never a gate
  }

  const candidate = (n: string): string => (folder ? `${folder}/${n}` : n);
  if (!taken.has(candidate(fileName).toLowerCase())) return candidate(fileName);

  const stem = fileName.replace(/\.glb$/i, '');
  for (let i = 1; ; i++) {
    const next = candidate(`${stem}_${i}.glb`);
    if (!taken.has(next.toLowerCase())) return next;
  }
}
