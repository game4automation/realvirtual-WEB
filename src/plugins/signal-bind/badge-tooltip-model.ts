// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * badge-tooltip-model — the hover card of a 3D link badge, as data
 * (plan-422 F5).
 *
 * Kept apart from the React content component for the same reason
 * `slot-row-models` is kept apart from the rows it feeds: the interesting part
 * is WHICH slots and WHAT state, and that is testable without a renderer, a
 * camera or a hover event.
 *
 * The slot set comes from `buildSlotRowModels()` — the one builder the popover
 * and the inspector rows already share — so a badge can never advertise a slot
 * the popover then fails to offer.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { SignalBindingManager } from '../../core/engine/rv-signal-binding-manager';
import type { SlotLiveness } from '../../core/engine/rv-signal-binding-manager';
import type { SignalBadgeTooltipData, SignalBadgeTooltipSlot }
  from '../../core/hmi/tooltip/SignalBadgeTooltipContent';
import { buildSlotRowModels } from './slot-row-models';
import { signalBindTargetId, type SignalBindTarget } from './signal-bind-target';

/**
 * Slot-level liveness in one word each.
 *
 * Deliberately NOT `BINDING_STATE_LABEL`: that record is keyed by
 * `ElementBindingState` (the whole element's roll-up) and has no entry for
 * `hold`, which is a per-slot state only. The words are the slot row's own
 * status tokens, so the hover card and the row agree.
 */
const SLOT_LIVENESS_LABEL: Record<SlotLiveness, string> = {
  pending: 'pending',
  live: 'live',
  hold: 'live · hold',
  disconnected: 'disconnected',
  conflict: 'conflict',
};

/** Marker the badge gizmo carries; identifies a pick as "the plug, not the part". */
export const SIGNAL_BADGE_MARKER = 'rvSignalBadge';

/**
 * The badge gizmo under `mesh`, or null when this pick was the object itself.
 *
 * Badge sprites register as AUXILIARY raycast targets owned by the node they
 * sit on, so a hover over a badge reports the owner as the hovered node — the
 * pick is only distinguishable through the mesh that was actually hit. Walking
 * up from it keeps this working whatever the gizmo's internal shape is.
 */
export function badgeRootOf(mesh: Object3D | null | undefined): Object3D | null {
  for (let current = mesh ?? null; current; current = current.parent) {
    if (current.userData?.[SIGNAL_BADGE_MARKER]) return current;
  }
  return null;
}

/**
 * Build the hover card for the badge on `target`.
 *
 * `state` is the badge's own colour-state word, so the card's header agrees
 * with what the eye already sees on the sprite.
 */
export function buildBadgeTooltipData(
  viewer: Pick<RVViewer, 'signalStore'>,
  mgr: SignalBindingManager,
  target: SignalBindTarget,
  state: string,
  mappings: readonly import('../layout-planner/rv-layout-store').SignalMapping[] = [],
): SignalBadgeTooltipData {
  const rows = buildSlotRowModels(viewer as RVViewer, mgr, signalBindTargetId(target), target.node, mappings);
  const slots: SignalBadgeTooltipSlot[] = rows.map((row) => {
    if (row.kind === 'unavailable') {
      return { label: row.label ?? row.slot, boundTo: null, unavailable: true, reason: row.reason };
    }
    const boundTo = row.mapping?.signal ?? row.targetName ?? null;
    const liveness = row.liveness;
    return {
      label: row.label ?? row.slot,
      boundTo,
      ...(boundTo && liveness ? { state: SLOT_LIVENESS_LABEL[liveness] } : {}),
    };
  });

  return {
    type: 'signal-badge',
    label: target.label ?? target.node.name ?? signalBindTargetId(target),
    state,
    slots,
  };
}
