// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-add-job — the ONE running "Add a plain folder" scan (plan-743 F3).
 *
 * Modelled on `import-job-store.ts`, for the same reason: the job outlives the
 * component that started it. The dashboard can be closed and reopened, and the
 * progress tile remounts onto a scan that never stopped — which it must,
 * because a scan of a large tree takes longer than a user is willing to stare
 * at one screen.
 *
 * Deliberately one job at a time (no queue, no history). {@link startAddScan}
 * answers `false` while another scan runs and the caller says so; a second
 * concurrent DFS would double the I/O for no benefit and make the counter
 * meaningless.
 *
 * Lives in the project domain rather than in HMI: it is scan state, and the
 * only React in it is the `useSyncExternalStore` view at the bottom.
 */

import { useSyncExternalStore } from 'react';
import { scanGlbTree, type ScanProgress, type ScanResult } from './rv-project-scan';

/** How the last scan ended. `null` while idle-with-no-history or running. */
export interface AddJobOutcome {
  kind: 'success' | 'cancelled' | 'error';
  /** The completed scan, for the caller to seed a project from. */
  result: ScanResult | null;
  error: string | null;
}

export interface AddJobSnapshot {
  status: 'idle' | 'running';
  /** Name of the folder being scanned, for the tile's label. */
  folderName: string | null;
  progress: ScanProgress | null;
  outcome: AddJobOutcome | null;
}

const IDLE: AddJobSnapshot = { status: 'idle', folderName: null, progress: null, outcome: null };

// ─── Store state ─────────────────────────────────────────────────────────

let _status: AddJobSnapshot['status'] = 'idle';
let _folderName: string | null = null;
let _progress: ScanProgress | null = null;
let _outcome: AddJobOutcome | null = null;
let _abort: AbortController | null = null;

const _listeners = new Set<() => void>();
let _snapshot: AddJobSnapshot = IDLE;

/**
 * Republish the snapshot.
 *
 * A NEW object every time and the same object between notifies: that is exactly
 * the identity contract `useSyncExternalStore` checks, and the dashboard host
 * documents it at the top of its own file. Deriving the snapshot inside
 * `getAddJobSnapshot` instead would hand React a fresh identity on every render
 * and loop forever.
 */
function _notify(): void {
  _snapshot = {
    status: _status,
    folderName: _folderName,
    progress: _progress,
    outcome: _outcome,
  };
  for (const l of _listeners) {
    try { l(); } catch (e) { console.error('[add-job] listener error:', e); }
  }
}

export function subscribeAddJob(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}

export function getAddJobSnapshot(): AddJobSnapshot {
  return _snapshot;
}

/** React view of the running scan (the progress tile in the Projects header). */
export function useAddProjectJob(): AddJobSnapshot {
  return useSyncExternalStore(subscribeAddJob, getAddJobSnapshot);
}

// ─── Actions ─────────────────────────────────────────────────────────────

/**
 * Cancel the running scan. No-op when idle.
 *
 * The store goes to `cancelled` HERE rather than when the DFS finally unwinds:
 * the scan is over the moment the user says it is, and nothing has been written
 * yet by construction, so there is nothing to undo.
 */
export function abortAddScan(): void {
  const controller = _abort;
  if (!controller) return;
  controller.abort();
  _finish({ kind: 'cancelled', result: null, error: null });
}

/** Clear the last outcome once the caller has consumed it. */
export function dismissAddOutcome(): void {
  if (_outcome === null) return;
  _outcome = null;
  _notify();
}

/**
 * Start the one scan job. Returns `false` (and does nothing) while another scan
 * is still running — the caller shows "a folder is still being scanned".
 *
 * `onDone` fires only for the job that is still current: a scan the user
 * cancelled must not seed a project seconds later.
 */
export function startAddScan(
  dir: FileSystemDirectoryHandle,
  onDone?: (outcome: AddJobOutcome) => void,
): boolean {
  if (_status === 'running') return false;

  const controller = new AbortController();
  _abort = controller;
  _status = 'running';
  _folderName = dir.name ?? '';
  _progress = { visited: 0, found: 0, nestedProjects: 0, current: '' };
  _outcome = null;
  _notify();

  void (async () => {
    try {
      const result = await scanGlbTree(dir, {
        signal: controller.signal,
        // A progress report from a job the user already cancelled must not
        // repaint the tile the cancel just took down.
        onProgress: (p) => { if (_abort === controller) { _progress = p; _notify(); } },
      });
      if (controller.signal.aborted) {
        _finish({ kind: 'cancelled', result: null, error: null }, controller, onDone);
        return;
      }
      _finish({ kind: 'success', result, error: null }, controller, onDone);
    } catch (e) {
      if (controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
        _finish({ kind: 'cancelled', result: null, error: null }, controller, onDone);
        return;
      }
      _finish({
        kind: 'error',
        result: null,
        error: e instanceof Error ? e.message : String(e),
      }, controller, onDone);
    }
  })();

  return true;
}

/**
 * Publish the end of a scan.
 *
 * `owner` is the controller the outcome belongs to. A scan that was cancelled —
 * or superseded — is no longer the current one, and its late outcome is DROPPED
 * rather than allowed to overwrite what the user already sees.
 */
function _finish(
  outcome: AddJobOutcome,
  owner?: AbortController,
  onDone?: (o: AddJobOutcome) => void,
): void {
  if (owner && _abort !== owner) return;
  _abort = null;
  _status = 'idle';
  _progress = null;
  _outcome = outcome;
  _notify();
  if (onDone) {
    try { onDone(outcome); } catch (e) { console.error('[add-job] onDone error:', e); }
  }
}

/** Test-only: hard reset between test cases. */
export function _resetAddJobForTests(): void {
  _abort?.abort();
  _abort = null;
  _status = 'idle';
  _folderName = null;
  _progress = null;
  _outcome = null;
  _notify();
}
