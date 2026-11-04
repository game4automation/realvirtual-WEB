// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mode-owned docked panels — and the reconciler that drops their
 * `leftPanelManager` slot whenever the active workspace mode does not own them.
 *
 * Why this exists (plan-640 follow-up, customer hosted link 2026-10-20):
 * the right-docked windows `layout-planner`, `kinematics` and `materials` are
 * rendered by mode-scoped plugins (planner/DES, editor). Their UI is gated to
 * those modes, and the plugins close the slot in their own `onModeDeactivate`.
 * That covered every *switch* — but not a slot that appears WITHOUT a switch
 * out of the owning mode: `leftPanelManager.restore()` at the end of boot
 * reopens whatever the last session in this browser persisted
 * (`rv-left-panel-active` is per ORIGIN, so every hosted customer on
 * web.realvirtual.io shares it). A boot straight into HMI (`from === null`)
 * then held `layout-planner` / 340 px in the right slot, nothing rendered it,
 * and `useViewportInsets` inset `#rv-viewport` by 340 px — the grey strip.
 *
 * The reconciler makes the invariant hold for every path at once (boot
 * restore, a late plugin-side restore, an MCP tool opening a panel, a mode
 * entered at boot or switched later): **a mode-owned slot is open only while
 * an owning mode is active.** It never closes anything while a switch is in
 * flight — the entering mode's `onModeActivate` opens its panel BEFORE
 * `modes.activeMode` flips — and never while no mode has been chosen yet.
 */

import type { ModeId } from '../rv-mode-manager';
import type { LeftPanelSnapshot } from './left-panel-manager';
import { AUTHORING_MODES } from '../../plugins/layout-planner/authoring-modes';

/** Panel id → the modes whose plugin renders it. */
export const MODE_OWNED_PANELS: Readonly<Record<string, readonly ModeId[]>> = {
  'layout-planner': AUTHORING_MODES,
  kinematics: ['editor'],
  materials: ['editor'],
};

/**
 * The open mode-owned panels that `mode` does not own (left or right slot).
 * `mode === null` (nothing chosen yet) answers `[]` — ownership is unknown.
 */
export function orphanedModeOwnedPanels(
  snapshot: Pick<LeftPanelSnapshot, 'left' | 'right'>,
  mode: ModeId | null,
): string[] {
  if (mode === null) return [];
  const out: string[] = [];
  for (const id of [snapshot.left.activePanel, snapshot.right.activePanel]) {
    if (!id) continue;
    const owners = MODE_OWNED_PANELS[id];
    if (owners && !owners.includes(mode)) out.push(id);
  }
  return out;
}

/** The narrow viewer surface the reconciler needs (a real RVViewer fits). */
export interface ModeOwnedPanelHost {
  readonly leftPanelManager: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): LeftPanelSnapshot;
    close(id: string): void;
  };
  readonly modes: { readonly activeMode: ModeId | null };
  on(event: 'mode-changing' | 'mode-changed', cb: () => void): () => void;
}

/**
 * Keep mode-owned panels closed outside their modes. Reconciles immediately,
 * after every completed mode switch and after every panel-manager change that
 * happens outside a switch. Returns the unsubscribe.
 */
export function attachModeOwnedPanelReconciler(host: ModeOwnedPanelHost): () => void {
  const lpm = host.leftPanelManager;
  let switching = false;

  const reconcile = (): void => {
    if (switching) return;
    for (const id of orphanedModeOwnedPanels(lpm.getSnapshot(), host.modes.activeMode)) {
      lpm.close(id); // close() notifies → re-entry finds nothing left to close
    }
  };

  const offChanging = host.on('mode-changing', () => { switching = true; });
  const offChanged = host.on('mode-changed', () => { switching = false; reconcile(); });
  const offLpm = lpm.subscribe(reconcile);
  reconcile();

  return () => { offChanging(); offChanged(); offLpm(); };
}
