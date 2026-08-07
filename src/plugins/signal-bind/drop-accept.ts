// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-accept.ts — THE single source of truth for "may this dragged signal land
 * on this slot, and if not, why exactly?" (plan-246 F9, restated by plan-341 §2.3).
 *
 * {@link slotRejectReason} is the only rule. {@link slotAcceptsSignal} is a
 * convenience derivation (`reject(p) === null`) and carries no logic of its own,
 * so drag, drop, picker click and picker Enter can never drift apart again.
 *
 * Rules, in evaluation order — the FIRST failing one is reported, so the user
 * always gets the most fundamental cause rather than a downstream symptom:
 *
 *  1. Availability — a slot the component declares without a runtime contract
 *     rejects everything, and says so ({@link DropRejectReason} `unavailable`).
 *  2. Provenance   — a `connect` payload without provider identity is a genuine
 *     defect and is named (`no-provider`); an `internal` model signal is
 *     accepted WITHOUT an interfaceId, because it legitimately has none.
 *     A payload without `origin` at all is a programming error and is rejected
 *     the same way — there is no silent default.
 *  3. Kind — Bool binds to a bool slot, Int→int, Float→float, PLUS the one
 *     mixed pair the rest of the stack has always permitted: an Int signal on a
 *     FLOAT slot ({@link kindFitsSlot}, which carries the full rationale). A
 *     Float signal on an INT slot stays rejected. A signal whose kind cannot be
 *     derived (missing/unknown PLC type) is REJECTED, with `got: 'unknown'`.
 *     (The header of this file used to claim the opposite of what the code
 *     does; it has misled at least one reader.)
 *  4. Direction — a CONNECT `output` (PLC→viewer) binds only to a `plcOutput`
 *     slot, an `input` (viewer→PLC) only to `plcInput`. `unknown` is rejected
 *     with a reason.
 */

import type { SignalLinkDirection } from '../layout-planner/rv-layout-store';
import type { SignalDirection } from '../../core/hmi/rv-signal-badge';

export type SlotKind = 'bool' | 'float' | 'int';

/** Why a slot refuses a payload. `null` (not a member of this union) = accepted. */
export type DropRejectReason =
  | { kind: 'type'; expected: SlotKind; got: SlotKind | 'unknown' }
  | { kind: 'direction'; expected: SignalLinkDirection }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'no-provider' };

/** The slot side of the decision. */
export interface RejectSlotInput {
  type: SlotKind;
  direction: SignalLinkDirection;
  /**
   * Set when the row is a reject-only target: an `unavailable` slot, or a row
   * disabled by the element's bind eligibility. Such a row IS registered as a
   * drop target (plan-341 §2.4) precisely so it can state its reason instead of
   * silently swallowing the pointer.
   */
  unavailableReason?: string;
}

/** The payload side of the decision (a subset of `SignalDragPayload`). */
export interface RejectPayloadInput {
  plcType?: string;
  direction: SignalDirection;
  /** Required on real drags; absent = programming error → `no-provider`. */
  origin?: 'connect' | 'internal';
  interfaceId?: string;
}

/** Derive the value kind from a PLC type string (e.g. "PLCInputBool" → 'bool'). */
export function plcKindOf(plcType: string | undefined): SlotKind | 'unknown' {
  const t = (plcType ?? '').toLowerCase();
  if (t.includes('bool')) return 'bool';
  if (t.includes('int')) return 'int';
  if (t.includes('float') || t.includes('real')) return 'float';
  return 'unknown';
}

/**
 * May a signal of `kind` bind to a slot of `slotType`?
 *
 * Equal kinds, plus ONE mixed pair: an Int signal on a FLOAT slot. That is
 * deliberately the SAME policy the two layers underneath already run, so a link
 * the UI offers can never be refused further down:
 *
 * - runtime: `SignalBindingManager._slotConflict` calls only bool↔numeric and a
 *   float source on an int slot a conflict; an Int source on a float slot passes.
 * - gateway: `SignalCoercion.IsAllowed` (Connect/Core/SignalCoercion.cs) permits
 *   `bool↔int` and `int→float`.
 *
 * Real PLCs address drive setpoints and positions as DINT (`%QD4012`), and this
 * gate was the only layer that said no.
 *
 * The pair is accepted on both slot directions, but the value crosses in
 * opposite directions and only the control leg is lossless:
 * - `plcOutput` slot (PLC→viewer, e.g. Destination/TargetSpeed): a widening,
 *   exact.
 * - `plcInput` slot (viewer→PLC, e.g. a position feedback): the float is
 *   truncated by the integer signal's consumers (`SignalStore.getInt`, and
 *   `SignalValues.Coerce` at the gateway) — which is precisely what a PLC
 *   holding that value in a DINT expects.
 *
 * The reverse pair — a Float SIGNAL on an INT SLOT — stays rejected: there the
 * slot itself cannot represent the value, in either direction.
 */
export function kindFitsSlot(slotType: SlotKind, kind: SlotKind | 'unknown'): boolean {
  if (kind === 'unknown') return false;
  if (kind === slotType) return true;
  return kind === 'int' && slotType === 'float';
}

/**
 * Why this slot refuses this payload — `null` means it accepts.
 * THE single rule; see the module header for the evaluation order.
 */
export function slotRejectReason(
  slot: RejectSlotInput,
  payload: RejectPayloadInput,
): DropRejectReason | null {
  if (slot.unavailableReason) {
    return { kind: 'unavailable', detail: slot.unavailableReason };
  }
  // Internal model signals legitimately have no interfaceId — only a CONNECT
  // origin (or a missing origin) needs provider identity.
  if (payload.origin !== 'internal' && !payload.interfaceId) {
    return { kind: 'no-provider' };
  }
  const kind = plcKindOf(payload.plcType);
  if (!kindFitsSlot(slot.type, kind)) {
    return { kind: 'type', expected: slot.type, got: kind };
  }
  if (payload.direction === 'unknown') {
    return { kind: 'direction', expected: slot.direction };
  }
  if (payload.direction === 'output' && slot.direction !== 'plcOutput') {
    return { kind: 'direction', expected: slot.direction };
  }
  if (payload.direction === 'input' && slot.direction !== 'plcInput') {
    return { kind: 'direction', expected: slot.direction };
  }
  return null;
}

/** True when the dragged signal may be dropped onto the slot. Pure derivation. */
export function slotAcceptsSignal(
  slot: RejectSlotInput,
  payload: RejectPayloadInput,
): boolean {
  return slotRejectReason(slot, payload) === null;
}

const KIND_TEXT: Record<SlotKind | 'unknown', string> = {
  bool: 'Bool',
  int: 'Int',
  float: 'Float',
  unknown: 'an underivable type',
};

const DIRECTION_TEXT: Record<SignalLinkDirection, string> = {
  plcInput: 'a PLC input (viewer writes it)',
  plcOutput: 'a PLC output (the PLC writes it)',
};

/**
 * One human sentence per reason — used identically by the row tooltip, the
 * picker's disabled option and the aria-live announcer, so all three say the
 * same thing. Never encodes the cause in colour (Entscheidungs-Log 29.07.).
 */
export function dropRejectText(reason: DropRejectReason): string {
  switch (reason.kind) {
    case 'unavailable':
      return `Not available — ${reason.detail}`;
    case 'no-provider':
      return 'This signal carries no provider identity — it cannot be linked';
    case 'type':
      return reason.got === 'unknown'
        ? `Type mismatch — this slot expects ${KIND_TEXT[reason.expected]}, the signal has ${KIND_TEXT.unknown}`
        : `Type mismatch — this slot expects ${KIND_TEXT[reason.expected]}, the signal is ${KIND_TEXT[reason.got]}`;
    case 'direction':
      return `Direction mismatch — this slot expects ${DIRECTION_TEXT[reason.expected]}`;
  }
}
