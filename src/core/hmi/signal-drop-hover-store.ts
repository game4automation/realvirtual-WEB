// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-drop-hover-store.ts — the React-visible side of a running signal drag
 * (plan-341 §2.3 invariant 6, §2.8 f).
 *
 * The registry writes `data-rv-drop-state` straight onto the DOM, which is
 * exactly right for the hot path but renders NOTHING: an attribute mutation
 * triggers no React update, so the rejection reason could never reach a
 * tooltip or a gutter icon. This tiny store consumes the registry's transition
 * stream and republishes the ONE hovered row, so a row can render its reason.
 *
 * Cost: one snapshot object shared by all rows. A hover transition re-renders
 * the subscribed rows once — transitions happen at human speed, never per
 * pointermove.
 */

import { useSyncExternalStore } from 'react';
import type { DropRejectReason } from '../../plugins/signal-bind/drop-accept';
import { subscribeSignalDropTransitions } from './signal-drop-target';

/** The currently hovered slot row, or null when the pointer is over none. */
export interface SignalDropHover {
  targetId: string;
  accessibleLabel: string;
  /** null = the row accepts the payload. */
  reason: DropRejectReason | null;
}

let hover: SignalDropHover | null = null;
const listeners = new Set<() => void>();

function publish(next: SignalDropHover | null): void {
  hover = next;
  for (const listener of listeners) listener();
}

subscribeSignalDropTransitions((t) => {
  switch (t.phase) {
    case 'enter':
      publish({ targetId: t.targetId, accessibleLabel: t.accessibleLabel, reason: t.reason });
      break;
    case 'leave':
      if (hover?.targetId === t.targetId) publish(null);
      break;
    case 'outcome':
      if (hover !== null) publish(null);
      break;
  }
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): SignalDropHover | null {
  return hover;
}

/** Current hover without React (tests, imperative callers). */
export function getSignalDropHover(): SignalDropHover | null {
  return hover;
}

/**
 * The drop state of ONE row during a drag: `null` when the pointer is
 * elsewhere, otherwise the row's own accept/reject verdict.
 */
export function useSignalDropHover(targetId: string): SignalDropHover | null {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return current?.targetId === targetId ? current : null;
}

/** Test-only: drop the hovered row without going through a drag. */
export function _resetSignalDropHoverForTests(): void {
  hover = null;
}
