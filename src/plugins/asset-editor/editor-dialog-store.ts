// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-dialog-store — imperative promise-based dialogs for the asset editor.
 *
 * The mode exit guard and the Save flow run OUTSIDE React (ModeManager guard,
 * plugin code) but need modal answers. This store exposes awaitable prompts;
 * the `AssetEditorDialogs` overlay component renders whatever is pending and
 * resolves the promise on user choice.
 */

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

export interface ReimportReportData {
  fileName: string;
  matched: number;
  /** Old component-bearing nodes without a counterpart in the new tessellation. */
  unmatched: Array<{ relPath: string; components: Record<string, Record<string, unknown>> }>;
  newUnmapped: string[];
}

/** The three states the mesh-separator preview can be in (plan-331 §3.1). */
export type SeparatePreviewStatus = 'busy' | 'ready' | 'ineligible';

export interface SeparatePreviewDialog {
  kind: 'separate-preview';
  nodeName: string;
  mode: 'islands' | 'groups';
  status: SeparatePreviewStatus;
  /** Parts the split would create — meaningful in status `ready`. */
  partCount: number;
  /** Why the mesh cannot be split — meaningful in status `ineligible`. */
  reason: string;
  resolve: (confirmed: boolean) => void;
}

/** The three states the mesh-merge preview can be in (plan-372 §3.1). */
export type MergePreviewStatus = 'busy' | 'ready' | 'ineligible';

/** What the ready state reports — the numbers requirement F6 asks for. */
export interface MergePreviewCounts {
  sourceCount: number;
  outputCount: number;
  keptCount: number;
  /** Human summary of WHY nodes are kept, e.g. "2 anchors, 1 component, 2 by name". */
  keptSummary: string;
}

export interface MergePreviewDialog extends MergePreviewCounts {
  kind: 'merge-preview';
  nodeName: string;
  status: MergePreviewStatus;
  /** Why the subtree cannot be merged — meaningful in status `ineligible`. */
  reason: string;
  resolve: (confirmed: boolean) => void;
}

export type PendingDialog =
  | { kind: 'unsaved'; assetName: string; resolve: (c: UnsavedChoice) => void }
  | { kind: 'name'; initial: string; title: string; resolve: (name: string | null) => void }
  | {
      kind: 'save-fallback';
      reason: 'unsupported' | 'no-writable-project' | 'write-denied' | 'error';
      message?: string;
      resolve: (c: 'download' | 'cancel') => void;
    }
  | { kind: 'reimport-report'; report: ReimportReportData; resolve: () => void }
  | { kind: 'cad-missing'; fileNames: string[]; resolve: () => void }
  | SeparatePreviewDialog
  | MergePreviewDialog
  | { kind: 'merge-unapplied'; reasons: string[]; resolve: () => void }
  | null;

let _pending: PendingDialog = null;
let _version = 0;
const _listeners = new Set<() => void>();

function _set(next: PendingDialog): void {
  _pending = next;
  _version++;
  for (const fn of _listeners) fn();
}

/** Ask Save / Discard / Cancel for unsaved changes. */
export function askUnsavedChoice(assetName: string): Promise<UnsavedChoice> {
  return new Promise((resolve) => {
    _set({ kind: 'unsaved', assetName, resolve: (c) => { _set(null); resolve(c); } });
  });
}

/** Ask for an asset name (null = cancelled). */
export function askAssetName(initial: string, title = 'Save asset'): Promise<string | null> {
  return new Promise((resolve) => {
    _set({ kind: 'name', initial, title, resolve: (n) => { _set(null); resolve(n); } });
  });
}

/** Explain why saving to the Custom library is unavailable; offer download. */
export function askSaveFallback(
  reason: 'unsupported' | 'no-writable-project' | 'write-denied' | 'error',
  message?: string,
): Promise<'download' | 'cancel'> {
  return new Promise((resolve) => {
    _set({ kind: 'save-fallback', reason, message, resolve: (c) => { _set(null); resolve(c); } });
  });
}

/** Show the CADLink re-import preservation report (resolves on close). */
export function showReimportReport(report: ReimportReportData): Promise<void> {
  return new Promise((resolve) => {
    _set({ kind: 'reimport-report', report, resolve: () => { _set(null); resolve(); } });
  });
}

/**
 * Tell the user that some imported CAD geometry could not be restored (both the
 * converted-GLB cache and the original CAD bytes are gone) and that they need to
 * re-import those files. Previously this condition was swallowed into a
 * `console.warn` and the geometry just silently vanished.
 */
export function showCadMissing(fileNames: string[]): Promise<void> {
  return new Promise((resolve) => {
    _set({ kind: 'cad-missing', fileNames, resolve: () => { _set(null); resolve(); } });
  });
}

/** Live handle on an open separate-mesh preview (see {@link showSeparatePreview}). */
export interface SeparatePreviewHandle {
  /** Resolves true when the user hit Separate, false on cancel/close/error. */
  readonly confirmed: Promise<boolean>;
  /** Analysis done: show the part count and the confirm button. */
  setReady(partCount: number): void;
  /** Analysis says no: show the reason and a single Close button. */
  setIneligible(reason: string): void;
  /** Close the dialog from code (resolves `confirmed` with false). */
  close(): void;
}

/**
 * Open the mesh-separator preview in its BUSY state and return a handle that
 * moves it on.
 *
 * Why not `ConfirmActionDialog`: that component always requires `confirmLabel` +
 * `onConfirm` and always renders Cancel + Confirm, so neither the busy state nor
 * the close-only state of an unsplittable mesh can be expressed with it. This
 * follows the store's own `askUnsavedChoice` pattern instead, extended with
 * in-place updates because the analysis lands after the dialog is already up.
 *
 * Every update is ignored once the dialog has been resolved or superseded, so a
 * late worker answer can never re-open or rewrite a newer dialog.
 */
export function showSeparatePreview(
  nodeName: string,
  mode: 'islands' | 'groups',
): SeparatePreviewHandle {
  let settled = false;
  let entry!: SeparatePreviewDialog;

  const confirmed = new Promise<boolean>((resolve) => {
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (_pending === entry) _set(null);
      resolve(ok);
    };
    entry = {
      kind: 'separate-preview',
      nodeName, mode,
      status: 'busy', partCount: 0, reason: '',
      resolve: finish,
    };
    _set(entry);
  });

  const patch = (next: Partial<SeparatePreviewDialog>): void => {
    if (settled || _pending !== entry) return;
    entry = { ...entry, ...next };
    _set(entry);
  };

  return {
    confirmed,
    setReady: (partCount) => patch({ status: 'ready', partCount }),
    setIneligible: (reason) => patch({ status: 'ineligible', reason }),
    close: () => entry.resolve(false),
  };
}

/** Live handle on an open merge preview (see {@link showMergePreview}). */
export interface MergePreviewHandle {
  /** Resolves true when the user hit Merge, false on cancel/close/error. */
  readonly confirmed: Promise<boolean>;
  /** Classification done: show the counts and the confirm button. */
  setReady(counts: MergePreviewCounts): void;
  /** Classification says no: show the reason and a single Close button. */
  setIneligible(reason: string): void;
  /** Close the dialog from code (resolves `confirmed` with false). */
  close(): void;
}

/**
 * Open the mesh-merge preview in its BUSY state and return a handle that moves it on.
 *
 * Same shape as {@link showSeparatePreview}, and for the same reason: the context-menu
 * resolver runs synchronously while the menu opens, so the analysis cannot happen there —
 * it lands after the dialog is already up.
 */
export function showMergePreview(nodeName: string): MergePreviewHandle {
  let settled = false;
  let entry!: MergePreviewDialog;

  const confirmed = new Promise<boolean>((resolve) => {
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (_pending === entry) _set(null);
      resolve(ok);
    };
    entry = {
      kind: 'merge-preview',
      nodeName,
      status: 'busy',
      sourceCount: 0, outputCount: 0, keptCount: 0, keptSummary: '',
      reason: '',
      resolve: finish,
    };
    _set(entry);
  });

  const patch = (next: Partial<MergePreviewDialog>): void => {
    if (settled || _pending !== entry) return;
    entry = { ...entry, ...next };
    _set(entry);
  };

  return {
    confirmed,
    setReady: (counts) => patch({ status: 'ready', ...counts }),
    setIneligible: (reason) => patch({ status: 'ineligible', reason }),
    close: () => entry.resolve(false),
  };
}

/**
 * Tell the user that a recorded merge could not be reproduced on the live tree.
 *
 * The draft still holds the op, so the tree and its history disagree — silently swallowing
 * that is exactly what the collected-failure contract exists to prevent.
 */
export function showMergeUnapplied(reasons: string[]): Promise<void> {
  return new Promise((resolve) => {
    _set({ kind: 'merge-unapplied', reasons, resolve: () => { _set(null); resolve(); } });
  });
}

export function getPendingDialog(): PendingDialog {
  return _pending;
}

export function subscribeEditorDialogs(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getEditorDialogsVersion(): number {
  return _version;
}
