// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * edit-refusal-wiring — turn `editor-edit-refused` viewer events into the
 * shared instruction toast (plan-614 F1).
 *
 * The editor layer (`AssetDocument`) must not depend on the HMI: the
 * instruction store pulls in React. So the document only emits the event and
 * logs; this module, installed once at boot next to the signal-rename wiring,
 * says it to the user — the same toast style as a refused hierarchy move.
 */

import type { RVViewer } from '../rv-viewer';
import { showInstruction } from './instruction-store';

/** Instruction id of the refused-edit toast (a second refusal replaces it). */
export const EDIT_REFUSED_TOAST_ID = 'editor-edit-refused';

const _installed = new WeakMap<object, () => void>();

/** Show refused editor edits as a toast. Idempotent per viewer; returns the uninstall function. */
export function installEditRefusalWiring(viewer: Pick<RVViewer, 'on'>): () => void {
  const existing = _installed.get(viewer);
  if (existing) return existing;
  const off = viewer.on('editor-edit-refused', (e) => {
    showInstruction({
      id: EDIT_REFUSED_TOAST_ID,
      text: `${e.verb} of "${e.nodePath}" refused and undone: ${e.message}`,
      anchor: { kind: 'edge', edge: 'bottom' },
      style: 'toast',
      autoClearAfterMs: 6000,
      source: 'editor',
    });
  });
  const uninstall = () => {
    off();
    _installed.delete(viewer);
  };
  _installed.set(viewer, uninstall);
  return uninstall;
}
