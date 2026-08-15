// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-document-view — the SCENE writer of the view seam (plan-709 §2.1.1).
 *
 * Three of the four modes (planner, HMI, DES) work on a scene document, and a
 * scene has no `RvDocumentStack` at all. This is what publishes their half of
 * {@link ActiveDocumentView}: one chip, `stackDirty === dirty`, and the verbs
 * the (never-mounted) `SceneActiveCard` used to offer — which is how
 * `saveSettingsIntoModel` gets a caller back (plan-709 decision log).
 *
 * ## The mode gate is the point, not an optimisation
 *
 * `SceneStore` is a singleton and keeps running behind an active asset editor.
 * A background autosave settling at the wrong moment would otherwise repaint
 * the card with the scene while the user is editing an asset. So this writer
 * publishes **only while the editor mode is not active**, and it clears only
 * what it published itself ({@link clearActiveDocumentViewFor}) — the two
 * orders in which a mode switch can arrive are then both safe, and the card
 * never blinks empty in between (§2.1.1, R2-S).
 */

import type { RVViewer } from '../../rv-viewer';
import type { ProjectBackend } from '../../project/backends/project-backend';
import { getProjectStore } from '../../project/project-store';
import {
  clearActiveDocumentViewFor,
  documentLocationCrumbs,
  setActiveDocumentView,
  type ActiveDocumentSaveOutcome,
  type ActiveDocumentVerb,
  type ActiveDocumentView,
  type NamePrompt,
} from '../../editor/active-document-view';
import { decideSaveVerb, saveDocument, type SaveVerb } from '../../editor/rv-save-document';
import type { SceneSnapshot, SceneStore } from './scene-store';

/** The mode whose writer owns the seam instead of this one. */
export const EDITOR_MODE = 'editor';

/**
 * Fallback source mode when no mode is active yet (boot, headless test).
 *
 * The published `sourceMode` is otherwise the ACTIVE mode — planner, hmi, des —
 * and not a constant "scene": the card's guard compares it against the mode it
 * renders in, so a constant would make every scene view look foreign and be
 * discarded everywhere.
 */
export const SCENE_SOURCE_MODE = 'scene';

// ─── The verb, before the click ─────────────────────────────────────────

/**
 * What Save will do for a scene, decided without touching a file.
 *
 * There used to be a second verb function here, mirroring the asset half
 * clause for clause and repeating its three refusal sentences. That is the
 * duplication plan-710 F5 removes: `decideSaveVerb` now answers for both
 * lineages, and a scene simply describes itself to it. The refusals therefore
 * cannot drift apart any more — they have one source.
 */
function sceneSaveDecision(
  snap: SceneSnapshot | null,
  backend: ProjectBackend | null,
): { verb: SaveVerb; reason?: string } {
  return decideSaveVerb(
    { lineage: 'scene', open: !!snap?.draft, transient: snap?.transient === true },
    backend,
  );
}

// ─── The view ───────────────────────────────────────────────────────────

/**
 * The scene's view of itself.
 *
 * Pure: snapshot plus backend in, view out. That is what lets the parity and
 * exit-guard tests assert against it without a store, a viewer or a renderer —
 * and it is also why the card can never disagree with the exit guard, since
 * `dirty` here IS `snap.dirty`, the value `trySwitch` reads.
 */
export function sceneDocumentView(
  store: SceneStore,
  snap: SceneSnapshot | null,
  backend: ProjectBackend | null,
  sourceMode: string = SCENE_SOURCE_MODE,
): ActiveDocumentView | null {
  const draft = snap?.draft;
  if (!snap || !draft) return null;

  const decision = sceneSaveDecision(snap, backend);
  const savedId = snap.saved?.id ?? null;

  const menu: ActiveDocumentVerb[] = [
    {
      id: 'save-as',
      label: 'Save as…',
      prompt: {
        title: 'Save as new scene',
        initial: snap.isDraft ? draft.name : `${draft.name} (copy)`,
      },
      run: async (name) => { if (name) await store.saveAs(name); },
    },
    {
      id: 'rename',
      label: 'Rename…',
      disabled: !savedId,
      prompt: { title: 'Rename scene', initial: snap.saved?.name ?? draft.name },
      run: (name) => { if (savedId && name) store.rename(savedId, name); },
    },
    {
      id: 'duplicate',
      label: 'Duplicate',
      disabled: !savedId,
      run: async () => { if (savedId) await store.duplicate(savedId); },
    },
    {
      id: 'discard',
      label: 'Discard changes',
      danger: true,
      disabled: !snap.dirty,
      run: async () => { await store.discard(); },
    },
    {
      id: 'save-into-model',
      label: 'Save settings into model…',
      secondary: 'Settings travel with the file',
      disabled: snap.busy,
      prompt: { title: 'Save settings into model', initial: draft.name },
      run: async (name) => {
        if (!name) return;
        return describeSaveIntoModel(await store.saveSettingsIntoModel(name));
      },
    },
  ];

  return {
    name: draft.name,
    // A scene is a single document: one chip, never a chain. The shape is the
    // stack's so the card renders one row for both lineages.
    crumbs: [{
      index: 0,
      label: draft.name,
      occurrence: '',
      referenceNodeId: null,
      dirty: snap.dirty,
      stale: false,
      current: true,
    }],
    // WHERE the document lives — its identity carries the row's path now, so
    // the crumb names the real folder (root files: none at all). There is no
    // "Scenes" any more: a document is a file wherever it sits. Only a DRAFT,
    // which genuinely exists nowhere yet, still says so. `documentIdentity` is
    // read defensively because the parity tests hand in a stub store.
    location: (() => {
      const identity = store.documentIdentity?.() ?? null;
      return identity ? documentLocationCrumbs(identity) : ['Unsaved'];
    })(),
    dirty: snap.dirty,
    busy: snap.busy,
    // No stack, so "any frame dirty" and "this document is dirty" are the same
    // statement — spelled out rather than left undefined, because the exit
    // guard reads it.
    stackDirty: snap.dirty,
    stale: false,
    saveVerb: decision.verb,
    ...(decision.reason ? { saveReason: decision.reason } : {}),
    sourceMode,
    canUndo: snap.canUndo,
    canRedo: snap.canRedo,
    undoLabel: snap.undoLabel,
    redoLabel: snap.redoLabel,
    actions: {
      save: (prompt?: NamePrompt) => saveScene(store, prompt),
      undo: () => store.undo(),
      redo: () => store.redo(),
      menu,
      exportGlb: {
        estimate: () => store.estimateFlatExport(),
        run: (opts) => store.exportSceneGlb(opts),
        fileName: `${draft.name.replace(/[\\/:*?"<>|]+/g, '_') || 'scene'}.glb`,
      },
    },
  };
}

/**
 * Save the scene — through the ONE save path (plan-710 F5).
 *
 * This function used to BE the scene's save routing: its own no-op rule, its
 * own "needs a name" refusal, its own error wrapping, all a second copy of what
 * `saveDocument()` already did for the asset lineage. Now it hands the store to
 * `saveDocument()` and does the one thing that genuinely belongs to the card —
 * turning the result into the outcome vocabulary the card renders, and lifting
 * the card's `NamePrompt` (which carries a dialog title) into the plain
 * `requestName` callback the core path speaks.
 */
async function saveScene(
  store: SceneStore,
  prompt?: NamePrompt,
): Promise<ActiveDocumentSaveOutcome> {
  const result = await saveDocument(null, store, {
    ...(prompt ? { requestName: (initial: string) => prompt(initial, 'Save scene') } : {}),
  });
  switch (result.kind) {
    case 'saved':      return { status: 'saved' };
    case 'no-op':      return { status: 'no-op' };
    case 'cancelled':  return { status: 'cancelled' };
    case 'busy':       return { status: 'cancelled' };
    case 'blocked':    return { status: 'blocked', reason: result.reason };
    case 'conflict':   return { status: 'error', message: result.message };
    case 'target-changed':
      return {
        status: 'error',
        message: 'The project changed while saving — nothing was adopted. Try again.',
      };
    default:           return { status: 'error', message: result.message };
  }
}

/**
 * Turn the outcome into something the user can act on.
 *
 * Moved here from `SceneActiveCard` unchanged: every refusal names its cause —
 * "nothing happened" with no reason is the one response that leaves someone
 * stuck.
 */
export function describeSaveIntoModel(
  outcome: Awaited<ReturnType<SceneStore['saveSettingsIntoModel']>>,
): string {
  switch (outcome.kind) {
    case 'saved': {
      const scope = `${outcome.fields} setting(s) across ${outcome.nodes} object(s)`;
      const signature = outcome.signatureDropped
        ? ' The original signature no longer matches the edited file and was removed.'
        : '';
      return `Saved ${scope} into ${outcome.fileName}. `
        + `The scene now uses this model and has no unsaved edits.${signature}`;
    }
    case 'nothing-to-save':
      return 'This scene has no settings to save — the model file would be an exact copy.';
    case 'structural-ops':
      return `These edits cannot be stored inside a model file: ${outcome.details.join(', ')}. `
        + 'Only component properties and signal links can be. Save the scene instead.';
    case 'no-model-base':
      return 'This scene is not based on a model file, so there is nothing to save into.';
    case 'no-writable-project':
      return outcome.reason;
    case 'unsupported':
      return 'Folder projects need the File System Access API, which this browser does not support. '
        + 'Use a browser project instead.';
    case 'scene-changed':
      return `The scene was switched while ${outcome.fileName} was being written. `
        + 'The file is in the project and is complete, but this scene was left as it was.';
    case 'error':
      return outcome.message;
  }
}

// ─── Installation ───────────────────────────────────────────────────────

/**
 * Keep the seam in step with the scene, for as long as the app runs.
 *
 * Subscribes to the store AND to the mode manager: the store because the state
 * changes there, the modes because leaving the editor is what hands the seam
 * back to this writer — without that subscription the card would stay on the
 * editor's last view until the next scene edit.
 */
export function installSceneDocumentView(viewer: RVViewer, store: SceneStore): () => void {
  /** What this writer last put on the seam — the only thing it may clear. */
  let published: string | null = null;

  // Optional on purpose, and duck-typed rather than assumed: the store is
  // created early in boot and a constrained host (or a test double) may hand in
  // a viewer with no mode manager, or a partial one. No modes means no mode
  // gate — the writer simply owns the seam. Installing the scene store must
  // never fail because of a card.
  const modes: Partial<RVViewer['modes']> | undefined = viewer.modes;
  const subscribeModes = typeof modes?.subscribe === 'function'
    ? modes.subscribe.bind(modes)
    : null;

  const publish = (): void => {
    if (modes?.activeMode === EDITOR_MODE) {
      // Not ours while the editor is up. Deliberately not a clear either: the
      // editor's own writer owns the seam then, and clearing here would blank
      // the card for one frame on every scene notification behind it.
      return;
    }
    const sourceMode = modes?.activeMode ?? SCENE_SOURCE_MODE;
    const backend = getProjectStore().getBackend();
    const view = sceneDocumentView(store, store.getSnapshot(), backend, sourceMode);
    if (view) {
      setActiveDocumentView(view);
      published = sourceMode;
      return;
    }
    if (published) { clearActiveDocumentViewFor(published); published = null; }
  };

  const unsubStore = store.subscribe(publish);
  const unsubModes = subscribeModes?.(publish);
  publish();

  return () => {
    unsubStore();
    unsubModes?.();
    if (published) { clearActiveDocumentViewFor(published); published = null; }
  };
}
