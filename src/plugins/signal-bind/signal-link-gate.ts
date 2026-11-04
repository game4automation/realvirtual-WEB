// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-link-gate.ts — the ONE place that decides in which workspace modes
 * signal linking (binding model slots to PLC / internal signals) exists.
 *
 * Signal linking is engineering work. The operator workspaces (`hmi`, `viewer`)
 * must not show any of it: no link-mode button, no bindings overview, no slot
 * rows in the inspector, no bulk actions, no "Link signal…" context entry, no
 * popover (Thomas, 2026-10-24: "Im HMI-Modus hat Signal-Linking nichts zu
 * suchen."). Every signal-bind UI surface asks this module instead of carrying
 * its own mode list.
 *
 * Existing bindings keep WORKING in every mode — this gates the authoring UI,
 * never the binding manager.
 */

import { useSyncExternalStore } from 'react';
import { modeContext, type ModeId } from '../../core/rv-mode-manager';

/** The workspaces in which signal linking is offered. */
export const SIGNAL_LINK_MODES: readonly ModeId[] = ['commissioning', 'editor', 'planner', 'des'];

/** `mode:<id>` contexts for declarative `visibilityRule.shownOnlyInAny`. */
export const SIGNAL_LINK_MODE_CONTEXTS: readonly string[] = SIGNAL_LINK_MODES.map(modeContext);

/**
 * The workspaces whose floating TOOLBAR carries the two signal buttons (link
 * mode toggle, bindings overview). DES is deliberately NOT one of them (Thomas,
 * 2026-10-27, plan-2010): the DES toolbar is for simulation and analysis. Signal
 * linking itself is still offered in DES — inspector slot rows, drag-linking and
 * the "Link signal…" context entry follow {@link SIGNAL_LINK_MODES} — but a
 * link mode that is switched on RESTS there (no badges, normal object tooltips)
 * because its switch is not on screen; see `setSignalLinkModeSuspended`.
 */
export const SIGNAL_LINK_TOOLBAR_MODES: readonly ModeId[] = SIGNAL_LINK_MODES.filter((m) => m !== 'des');

/** `mode:<id>` contexts of {@link SIGNAL_LINK_TOOLBAR_MODES} for the two toolbar entries. */
export const SIGNAL_LINK_TOOLBAR_CONTEXTS: readonly string[] = SIGNAL_LINK_TOOLBAR_MODES.map(modeContext);

/** Workspace in which a switched-on link mode rests (its toolbar switch is hidden). */
export const SIGNAL_LINK_REST_MODE: ModeId = 'des';

/** Minimal mode surface of the viewer (tests may pass a viewer without one). */
interface ModesLike {
  readonly activeMode: ModeId | null;
  subscribe?: (cb: () => void) => () => void;
  getSnapshot?: () => unknown;
}
interface ViewerLike { readonly modes?: ModesLike | null }

/**
 * Whether signal linking is offered in `mode`. `null` (no mode chosen yet / no
 * workspace system) does not restrict.
 */
export function isSignalLinkingAllowedInMode(mode: ModeId | null | undefined): boolean {
  return mode == null || SIGNAL_LINK_MODES.includes(mode);
}

/** Whether signal linking is offered in the viewer's active workspace mode. */
export function isSignalLinkingAllowed(viewer: ViewerLike | null | undefined): boolean {
  return isSignalLinkingAllowedInMode(viewer?.modes?.activeMode ?? null);
}

const noopSubscribe = () => () => {};
const noopSnapshot = () => 0;

/** React binding of {@link isSignalLinkingAllowed} — re-renders on a mode switch. */
export function useSignalLinkingAllowed(viewer: ViewerLike | null | undefined): boolean {
  const modes = viewer?.modes ?? null;
  const subscribe = modes?.subscribe && modes.getSnapshot ? modes.subscribe : noopSubscribe;
  const getSnapshot = modes?.subscribe && modes.getSnapshot ? modes.getSnapshot : noopSnapshot;
  useSyncExternalStore(subscribe, getSnapshot);
  return isSignalLinkingAllowed(viewer);
}
