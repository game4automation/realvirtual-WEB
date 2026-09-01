// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * active-document-view — the VIEW seam of the open document (plan-709 §2.1.1).
 *
 * ## Why a seam and not "the card reads the stack"
 *
 * The first draft of plan-709 had the document card read
 * `getDocumentStackSnapshot()` directly. Three facts killed that:
 *
 *  - `document-stack-store.ts` lives in the **editor plugin** and is only ever
 *    populated while that plugin is active. A card mounted in the core
 *    hierarchy header that imported it would be the core→plugin upward import
 *    that plan-703 already had to undo once for `active-asset-store`.
 *  - Scene documents — planner, HMI, DES, i.e. three of the four modes — have
 *    no `RvDocumentStack` at all. The card would have read the empty snapshot
 *    forever and rendered nothing.
 *  - `RvStackSnapshot` carries neither `busy` nor `saveVerb` nor a thumbnail
 *    identity, so even in the editor the card would have needed two more
 *    sources.
 *
 * So this is the same move plan-703 made one level down: **one small core fact,
 * many writers, one reader.** The writers sit where the state already exists —
 * the scene side in core (`hmi/scene/scene-document-view.ts`), the editor side
 * in the plugin (`plugins/asset-editor/editor-document-view.ts`); a plugin MAY
 * write into core, it just may not be imported by it. The card knows about
 * neither SceneStore nor RvDocumentStack.
 *
 * ## The writer contract (§2.1.1, R2-S)
 *
 * "Last writer wins" is not enough: `SceneStore` is a singleton and keeps
 * running behind an active editor, so a background autosave finishing at the
 * wrong moment would repaint the card with the scene's state while the user is
 * editing an asset. Two independent guards, both testable:
 *
 *  1. every writer is HARD-gated on its own mode and publishes nothing outside
 *     it — and clears only what it published ({@link clearActiveDocumentViewFor});
 *  2. every view carries {@link ActiveDocumentView.sourceMode}, and the reader
 *     discards a view whose mode is not the active one
 *     ({@link resolveActiveDocumentView}).
 *
 * ## Never empty while something is open
 *
 * During a mode switch there is a window in which the outgoing writer has
 * cleared and the incoming one has not published yet. The card must not blink
 * out there, so the resolver falls back to `getOpenDocumentBase()` — plan-703's
 * "what is open, whatever mode put it there" — and renders a placeholder that
 * is honest about being mid-handover (busy, and Save blocked with a reason)
 * rather than a card that looks live and is not.
 */

import type { RvStackCrumb } from '../ops/rv-document-stack';
import type { ThumbnailKeyParts } from '../thumbnails/thumbnail-key';
import type { SaveVerb } from './rv-save-document';
import type { AssetBase } from './rv-asset-document';
import { getOpenDocumentBase } from './active-asset-store';

// ─── What the card renders ──────────────────────────────────────────────

/** Ask the user for a name. Supplied by the card, used by verbs that need one. */
export type NamePrompt = (initial: string, title: string) => Promise<string | null>;

/** What a save attempt did. Drives the live region, never an exception. */
export type ActiveDocumentSaveOutcome =
  | { status: 'saved' }
  /** Clean and already stored — nothing was written and nothing is wrong. */
  | { status: 'no-op' }
  | { status: 'cancelled' }
  /** There is nowhere to write. `reason` is a sentence the user can act on. */
  | { status: 'blocked'; reason: string }
  | { status: 'error'; message: string };

/**
 * One entry of the card's overflow menu.
 *
 * `prompt` moves the name dialog into the card so that neither writer has to
 * own React: a writer says "this verb needs a name", the card asks, and the
 * answer comes back through `run`. A returned string is shown to the user —
 * that is how "Save settings into model" reports its long outcome sentence.
 */
export interface ActiveDocumentVerb {
  id: string;
  label: string;
  /** Second line under the label, for a verb whose consequence needs saying. */
  secondary?: string;
  disabled?: boolean;
  /** Renders in the error ink — destructive verbs only. */
  danger?: boolean;
  prompt?: { title: string; initial: string };
  run(name?: string): void | Promise<void | string>;
}

/** Share capability — the card renders the core `ShareDialog` for it. */
export interface ActiveDocumentShare {
  getBytes(meta: unknown): Promise<ArrayBuffer>;
  suggestedName: string;
  /** `RvShareLevel`; kept loose so the seam does not import the share module. */
  level: 'assembly' | 'plant' | 'scene' | (string & {});
}

/** Export capability — the card renders the embed/flat choice for it. */
export interface ActiveDocumentExport {
  /** Size preview, resolved BEFORE the dialog opens. Null when unavailable. */
  estimate?(): Promise<{
    totalBytes: number; baseBytes: number; distinctAssets: number; occurrences: number;
  } | null>;
  run(opts: { embedReferences: boolean }): Promise<ArrayBuffer | Uint8Array>;
  fileName: string;
}

/**
 * The verbs of the open document.
 *
 * Part of the seam rather than reachable from the card directly, for exactly
 * the reason the state is: a card that had to call `SceneStore.save()` or
 * `runSaveFlow()` itself would have to know which one applies, which is the
 * mode knowledge this whole seam removes.
 */
export interface ActiveDocumentActions {
  /** The one save. Routed by whoever published this view. */
  save(prompt?: NamePrompt): Promise<ActiveDocumentSaveOutcome>;
  undo?: () => void | Promise<void>;
  redo?: () => void | Promise<void>;
  menu?: ActiveDocumentVerb[];
  /** Breadcrumb chip click — the stack bar's Back/Descend handler, shared. */
  onCrumb?: (crumb: RvStackCrumb) => void | Promise<void>;
  /** Hero: double-click the preview reopens in the last active mode (§3.2). */
  openPreview?: () => void | Promise<void>;
  share?: ActiveDocumentShare;
  exportGlb?: ActiveDocumentExport;
}

export interface ActiveDocumentView {
  name: string;
  /** Scene: exactly ONE chip. Editor: the occurrence chain. */
  crumbs: RvStackCrumb[];
  /**
   * Where the document LIVES, as leading breadcrumb segments.
   *
   * {@link crumbs} answers "which document, and how deep did the descend go" —
   * it never answered "where is this". A card showing a bare leaf name two
   * levels down reads as an orphan, so every writer states the storage location
   * and the card renders it in front of the chain. Location, not navigation:
   * these segments are never clickable.
   */
  location?: string[];
  dirty: boolean;
  busy: boolean;
  /** Editor: `stack.anyDirty`. Scene: identical to {@link dirty}. */
  stackDirty: boolean;
  /** A lower frame of the same asset saved under this one (§2.2.1-5). */
  stale: boolean;
  saveVerb: SaveVerb;
  /** Why Save is blocked. Present exactly when `saveVerb === 'blocked'`. */
  saveReason?: string;
  /** The mode that published this view. The reader discards foreign ones. */
  sourceMode: string;
  canUndo?: boolean;
  canRedo?: boolean;
  undoLabel?: string | null;
  redoLabel?: string | null;
  /**
   * Preview identity of the document.
   *
   * Carried by the seam because it belongs to the document, not to the place
   * it is rendered; the hero uses it to key its preview slot so a switch
   * cannot leave the previous document's picture standing.
   */
  thumbnailKey?: ThumbnailKeyParts;
  actions: ActiveDocumentActions;
}

// ─── The store ──────────────────────────────────────────────────────────

let _view: ActiveDocumentView | null = null;
let _version = 0;
const _listeners = new Set<() => void>();

function _notify(): void {
  _version++;
  for (const fn of _listeners) fn();
}

/** Publish this writer's view of the open document, or clear it with `null`. */
export function setActiveDocumentView(view: ActiveDocumentView | null): void {
  _view = view;
  _notify();
}

/**
 * Clear, but only what `sourceMode` itself published.
 *
 * The deactivating writer must not wipe a view the incoming one has already
 * put up — the order of "mode changed" and "mode deactivated" is the mode
 * manager's business, and the card must survive either.
 */
export function clearActiveDocumentViewFor(sourceMode: string): void {
  if (!_view || _view.sourceMode !== sourceMode) return;
  _view = null;
  _notify();
}

/** The published view, unfiltered. Prefer {@link resolveActiveDocumentView}. */
export function getActiveDocumentView(): ActiveDocumentView | null {
  return _view;
}

export function subscribeActiveDocumentView(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** `useSyncExternalStore` snapshot. A number, so identity is never a hazard. */
export function getActiveDocumentViewVersion(): number {
  return _version;
}

// ─── One instance, two writers (plan-711 F6) ────────────────────────────

/**
 * Are both writers describing the SAME `RvDocument` instance right now?
 *
 * Set by the binder (`AssetEditorPlugin._bindSceneDocument`) and cleared on the
 * way back. A plugin may write into core; core may not read the plugin — so
 * this is a fact deposited here, exactly like `setOpenDocumentBase` next door,
 * and never a lookup into the editor.
 *
 * It is deliberately a BOOLEAN and not a document handle. The seam does not
 * need to know which document is shared: the whole consequence is that a view
 * carrying another mode's `sourceMode` is no longer foreign truth, because
 * `dirty`, `canUndo`, `canRedo` and the save routing all come out of the one
 * instance both projections are showing.
 */
let _sharedProjection = false;

export function setSharedDocumentProjection(shared: boolean): void {
  if (_sharedProjection === shared) return;
  _sharedProjection = shared;
  _notify();
}

/** True while scene and editor are projections of one document instance. */
export function isSharedDocumentProjection(): boolean {
  return _sharedProjection;
}

/**
 * Drop the published view. Tests only — production writers clear their own.
 *
 * Deliberately keeps the listeners: a component still mounted when this runs
 * would otherwise stop hearing about the next write, which turns a teardown
 * order mistake into a mysteriously stale render.
 */
export function resetActiveDocumentViewForTests(): void {
  _view = null;
  // The binding is part of the seam's state, and a test that left it on would
  // silently change how the NEXT test's foreign-mode view resolves.
  _sharedProjection = false;
  _notify();
}

// ─── The reader's half of the contract ──────────────────────────────────

/**
 * The view the card should render for `activeMode`.
 *
 * `null` for `activeMode` means "do not filter" — the hero in the projects
 * dashboard is a place, not a mode, and filtering there would blank the card
 * exactly where the user went to look at it.
 */
export function resolveActiveDocumentView(
  activeMode: string | null | undefined,
): ActiveDocumentView | null {
  const view = _view;
  if (view && (activeMode == null || view.sourceMode === activeMode)) return view;
  // plan-711 F6 — the GLEICH-Fall. There is no handover to report when nothing
  // is handed over: both writers describe one `RvDocument`, so the view still
  // standing from the other projection states this document's dirty state,
  // undo depth and save routing correctly. What it does NOT know is whether the
  // recompose has finished, so it is passed through BUSY — which is also the
  // answer to a Save pressed in that window (`saveDocument()` answers busy as a
  // no-op with a reason, plan-710), rather than a card that blocks with a
  // sentence about a handover that is not happening.
  if (view && isSharedDocumentProjection()) {
    return { ...view, busy: true, sourceMode: activeMode ?? view.sourceMode };
  }
  const base = getOpenDocumentBase();
  if (!base) return null;
  return handoverView(base, activeMode ?? '');
}

/**
 * The card during a mode handover.
 *
 * Deliberately busy and deliberately blocked: something IS open (that is what
 * `getOpenDocumentBase` means), so the card stays — but nothing about it can be
 * acted on until a writer publishes, and a Save button that silently did
 * nothing would be worse than one that says why.
 */
function handoverView(base: AssetBase, sourceMode: string): ActiveDocumentView {
  const name = nameOfAssetBase(base);
  return {
    name,
    crumbs: [{
      index: 0,
      label: name,
      occurrence: '',
      referenceNodeId: null,
      dirty: false,
      stale: false,
      current: true,
    }],
    location: documentLocationCrumbs(base),
    dirty: false,
    busy: true,
    stackDirty: false,
    stale: false,
    saveVerb: 'blocked',
    saveReason: 'The document is being handed over between modes — try again in a moment.',
    sourceMode,
    actions: {
      save: async () => ({
        status: 'blocked',
        reason: 'The document is being handed over between modes — try again in a moment.',
      }),
    },
  };
}

/**
 * Where an identity lives, as {@link ActiveDocumentView.location} segments.
 *
 * Next to {@link nameOfAssetBase} because it answers the other half of the same
 * question about the same value: that one says WHAT is open, this one says
 * where it came from, and both writers plus the handover card need both.
 */
export function documentLocationCrumbs(base: AssetBase | null | undefined): string[] {
  if (!base) return [];
  switch (base.kind) {
    // One kind, three crumb shapes — the same three the collapsed variants had,
    // now read off `path` instead of off the kind (plan-716 §2.6). The literal
    // display strings are unchanged on purpose: this is an identity collapse,
    // not a relabelling of the UI.
    case 'document':
      // No path — a legacy slot-addressed identity. There is no "Scenes"
      // section to point at any more (a document is a file wherever it sits),
      // so the honest crumb for an identity that names no folder is none.
      if (!base.path) return [];
      // `library/` is shown capitalised, exactly as the former `libraryGlb`
      // crumb did, and the prefix itself is never printed as a folder.
      if (base.path.startsWith('library/')) {
        return ['Library', ...folderSegments(base.path.slice('library/'.length))];
      }
      return folderSegments(base.path);
    case 'builtinModel':    return ['Built-in models'];
    case 'providerAsset':   return ['Library', base.providerId, base.sourceId];
    case 'referencedAsset':
      // A descend has a resolved project-relative path only when the reference
      // was resolvable; without one the honest statement is that we are inside
      // another file, not a folder we cannot name.
      return base.path ? folderSegments(base.path) : ['Referenced'];
    // There is no `'empty'` case any more (plan-719 F3): an asset that lived
    // nowhere and printed "Unsaved" as its location cannot occur, because a
    // document is created with a folder before it is ever opened.
    default:                return [];
  }
}

/** The directory part of a document path — the file itself is the leaf chip. */
function folderSegments(path: string): string[] {
  return path.split('/').slice(0, -1).filter(Boolean);
}

/** Display name of an identity, for the handover card and for writers. */
export function nameOfAssetBase(base: AssetBase): string {
  switch (base.kind) {
    // The document's own name (plan-711, Triage R2-F-B). It is carried IN the
    // identity precisely so this line exists: a document id is a storage key,
    // and deriving a label from it would print a uuid at the user. The file
    // stem is the fallback the former path-keyed kinds already used.
    case 'document': return base.name || fileStem(base.path) || 'Untitled';
    case 'builtinModel': return base.name || 'Model';
    case 'providerAsset': return base.label;
    case 'referencedAsset': return base.label;
    default: return 'Untitled';
  }
}

function fileStem(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.glb$/i, '') || file;
}
