// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * import-job-store.ts — the ONE running import job behind the Unified Import
 * Dialog and the floating outcome tile.
 *
 * The job runs here — a module-level singleton that survives dialog
 * unmounts — never inside a component. The dialog (which stays open as a
 * blocking modal while the job runs) and the outcome tile are two VIEWS of
 * this store, subscribed via `useSyncExternalStore`.
 *
 * Deliberately one job at a time (no queue, no history): a second import can
 * start once the first finished or was cancelled. Simple, predictable, and it
 * respects the WASM heap that a parallel STEP tessellation would exhaust.
 */

import { useSyncExternalStore } from 'react';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import {
  resolveProviderSafe,
  type CadImportProvider,
  type ImportProgress,
  type ImportProviderInput,
  type ImportResultItem,
} from '../../core/import/rv-import-provider';
import { importObject } from '../../core/import/rv-import-object';

/** The slice of AssetEditorPlugin the editor sink needs (avoids a hard import). */
type AssetEditorLike = RVViewerPlugin & {
  importItems(items: ImportResultItem[]): Promise<string[]>;
};

/** How the last job ended. `null` while idle-with-no-history or running. */
export interface ImportJobOutcome {
  kind: 'success' | 'warning' | 'error' | 'cancelled';
  errors: string[];
  warnings: string[];
  /** Suggested names of the items that WERE imported (success/warning). */
  importedNames: string[];
}

export interface ImportJobSnapshot {
  status: 'idle' | 'running';
  /** Provider label of the running/last job, e.g. "STEP". */
  providerLabel: string | null;
  progress: ImportProgress | null;
  outcome: ImportJobOutcome | null;
}

export interface StartImportOptions {
  /** true → asset-editor sink; false → planner scene placement. */
  isEditor: boolean;
  /** Planner sink only: auto-align the placed object to the floor. */
  alignToFloor: boolean;
}

// ─── Store state ─────────────────────────────────────────────────────────

let _status: ImportJobSnapshot['status'] = 'idle';
let _providerLabel: string | null = null;
let _progress: ImportProgress | null = null;
let _outcome: ImportJobOutcome | null = null;
let _abort: AbortController | null = null;

const _listeners = new Set<() => void>();
let _snapshot: ImportJobSnapshot = { status: 'idle', providerLabel: null, progress: null, outcome: null };

function _notify(): void {
  _snapshot = { status: _status, providerLabel: _providerLabel, progress: _progress, outcome: _outcome };
  for (const l of _listeners) {
    try { l(); } catch (e) { console.error('[import-job] listener error:', e); }
  }
}

export function subscribeImportJob(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

export function getImportJobSnapshot(): ImportJobSnapshot {
  return _snapshot;
}

/** React view of the import job (dialog, tile, toolbar button). */
export function useImportJob(): ImportJobSnapshot {
  return useSyncExternalStore(subscribeImportJob, getImportJobSnapshot);
}

// ─── Actions ─────────────────────────────────────────────────────────────

/** Abort the running job (the Cancel button in dialog and tile). No-op when idle. */
export function abortImportJob(): void {
  _abort?.abort();
}

/** Clear the last outcome (tile dismissed / dialog consumed the result). */
export function dismissImportOutcome(): void {
  if (_outcome === null) return;
  _outcome = null;
  _notify();
}

/**
 * Start the one import job. Returns false (and does nothing) while another
 * job is still running — the UI keeps the Import button disabled, this guard
 * is the backstop.
 *
 * The whole run — resolve, then sink — happens here so it survives the
 * dialog collapsing into the progress tile.
 */
export function startImportJob(
  viewer: RVViewer,
  provider: CadImportProvider,
  input: ImportProviderInput,
  opts: StartImportOptions,
): boolean {
  if (_status === 'running') return false;

  const controller = new AbortController();
  _abort = controller;
  _status = 'running';
  _providerLabel = provider.label;
  _progress = null;
  _outcome = null;
  _notify();

  void (async () => {
    let errors: string[] = [];
    const warnings: string[] = [];
    const importedNames: string[] = [];
    try {
      const result = await resolveProviderSafe(
        provider, input,
        (p) => { _progress = p; _notify(); },
        controller.signal,
      );
      if (controller.signal.aborted) {
        _finish({ kind: 'cancelled', errors: [], warnings: [], importedNames: [] });
        return;
      }
      errors = result.failed.map(f => `${f.id}: ${f.error}`);

      if (result.ok.length > 0) {
        // Handing the bytes to the sink is itself measurable work (cache write +
        // GLB parse), so keep the bar alive instead of letting it sit at 100 %.
        _progress = { percent: null, label: opts.isEditor ? 'Adding to asset' : 'Placing in scene' };
        _notify();
        for (const item of result.ok) {
          if (item.kind === 'glb') importedNames.push(item.suggestedName);
        }
        if (opts.isEditor) {
          // Editor mode edits ONE asset and has no scene — always an addition.
          const assetEditor = viewer.getPlugin<AssetEditorLike>('asset-editor');
          if (!assetEditor) throw new Error('[import] Editor mode requires the asset-editor plugin.');
          await assetEditor.importItems(result.ok);
        } else {
          const outcome = await importObject(viewer, result.ok, { skipAutoAlign: !opts.alignToFloor });
          warnings.push(...outcome.warnings);
        }
      } else if (errors.length === 0) {
        errors.push('Nothing to import — the source resolved to no items.');
      }

      _finish({
        kind: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'success',
        errors, warnings, importedNames,
      });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      _finish({ kind: 'error', errors, warnings, importedNames });
    }
  })();

  return true;
}

function _finish(outcome: ImportJobOutcome): void {
  _abort = null;
  _status = 'idle';
  _progress = null;
  _outcome = outcome;
  _notify();
}

/** Test-only: hard reset between test cases. */
export function _resetImportJobForTests(): void {
  _abort?.abort();
  _abort = null;
  _status = 'idle';
  _providerLabel = null;
  _progress = null;
  _outcome = null;
  _notify();
}
