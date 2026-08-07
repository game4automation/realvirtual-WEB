// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * slot-display-label.ts — the display-name layer for bindable slots (plan-341
 * Phase 4).
 *
 * A slot has TWO names and they must never be confused:
 *
 *  - the RAW slot name is its IDENTITY. It is the rv_extras/C# field name, it
 *    keys `SignalMapping.slot` in persisted projects, it composes `slotRowKey()`,
 *    `makeSlotId()` and every `data-testid`, and it feeds the auto-matcher
 *    tokens. It is never rewritten — rewriting it breaks existing bindings.
 *  - the DISPLAY name is what a human reads. It may correct a C# spelling that
 *    the GLB contract has to keep verbatim (`Drive_Simple.Accelaration`).
 *
 * This mirrors the pattern already used for signals: `SignalBadge.displayName`
 * next to the store key `signalName`, and `DiscoveredSignal.displayName` next
 * to the sanitised `signalName`.
 *
 * Two sources are consulted, because slots reach the UI through two independent
 * paths:
 *
 *  1. {@link SLOT_DESCRIPTORS} — the hand-authored descriptors (Conveyor
 *     `Flow.*`, Drive_DestinationMotor, Sensor …). A descriptor may carry its
 *     own `label`.
 *  2. the GENERIC schema iteration in `rv-binding-slot-resolver.ts`, which
 *     yields every `componentRef + signal` field of a registered component
 *     schema. Those slots have no descriptor at all — `Drive_Simple` declares
 *     only `Forward`/`Backward` as descriptors, while its schema also exposes
 *     `Speed`, `Accelaration`, `IsAtPosition`, … . The misspelling this layer
 *     was built for lives HERE, which is why {@link SLOT_DISPLAY_LABELS} exists
 *     alongside the descriptor `label`.
 *
 * Missing entry → the raw name is returned, so every slot that is not listed
 * behaves exactly as before.
 */

import { SLOT_DESCRIPTORS } from './slot-descriptors';

/**
 * Display names for slots that have NO descriptor — i.e. slots discovered by
 * the generic schema iteration. Keyed by rv_extras component type, then by the
 * raw slot name (the identity, never changed).
 *
 * Keep this table minimal: it exists to repair names the GLB contract cannot
 * fix, not to re-word the component vocabulary.
 */
export const SLOT_DISPLAY_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // `Accelaration` is the C# field name kept verbatim for GLB parity
  // (see rv-drive-simple.ts). Identity stays misspelled, the UI does not.
  Drive_Simple: { Accelaration: 'Acceleration' },
};

/**
 * The declared display name of a slot, or `undefined` when the raw name is
 * already what should be shown.
 *
 * Resolution order: descriptor `label` → {@link SLOT_DISPLAY_LABELS}. A
 * descriptor wins because it sits next to the slot definition itself.
 *
 * This is what the RESOLVER stores on a slot: only a genuine deviation is
 * carried, so a slot without a display entry keeps exactly the shape it had
 * before this layer existed. Presence of `label` therefore means "the display
 * name differs from the identity".
 */
export function slotLabelOverride(componentType: string, rawSlot: string): string | undefined {
  if (!rawSlot || !componentType) return undefined;
  const descriptorLabel = SLOT_DESCRIPTORS[componentType]
    ?.find((descriptor) => descriptor.slot === rawSlot)?.label;
  return descriptorLabel ?? SLOT_DISPLAY_LABELS[componentType]?.[rawSlot];
}

/**
 * Human-readable name of a slot — what a row prints. `componentType` is the
 * rv_extras component key that owns the slot; `rawSlot` is the slot IDENTITY.
 * Falls back to the raw name, which is the behaviour of every slot that
 * declares no display name.
 */
export function slotDisplayLabel(componentType: string, rawSlot: string): string {
  return slotLabelOverride(componentType, rawSlot) ?? rawSlot;
}
