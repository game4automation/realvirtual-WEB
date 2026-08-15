// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-vocabulary.ts — THE wording source for the signal-binding surfaces
 * (plan-341 Phase 6).
 *
 * Four independent taxonomies describe "is this thing connected, and who writes
 * it?", and they legitimately coexist because each answers about a DIFFERENT
 * subject. What is not legitimate is two spellings of one fact, which is what
 * this module removes:
 *
 * | Taxonomy               | Subject                | Where it shows                          |
 * |------------------------|------------------------|-----------------------------------------|
 * | `ElementBindingState`  | one ELEMENT (aggregate)| 3D badge sprite label, popover header    |
 * | `SlotLiveness` + authority | one SLOT           | slot-row status token (`resolveSlotStatusToken`) |
 * | `SlotAuthority`        | who WRITES one slot    | slot-row tooltip, signal-tooltip note    |
 * | `SignalActivity`       | one SIGNAL's supply    | signal-list status hint (`activityStatusHint`) |
 *
 * The element level and the slot level can be on screen at the same time — the
 * popover header states the element is `Live controlled` while its rows carry a
 * terse `live` token per slot. That is a level distinction, not a duplicate:
 * the header aggregates, the token is per binding. The registers differ on
 * purpose (sentence-case status label vs. lowercase chip token) so the two can
 * never be mistaken for each other.
 *
 * `SignalActivity` deliberately keeps its OWN lowercase wording
 * (`activityLabel` / `activityStatusHint` in `rv-signal-activity.ts` and
 * `rv-signal-badge.tsx`): it describes whether a SIGNAL is supplied at all,
 * which is upstream of any binding, and folding its `live` into
 * `Live controlled` would erase exactly that distinction.
 *
 * Colour is NOT centralised here. `SIGNAL_BADGE_STATE_COLOR` (3D, numeric) and
 * the popover's `STATE_COLOR` (2D, DESIGN.md hex) hold intentionally different
 * values for the same states, because the 3D marker palette and the panel
 * palette are tuned against different backgrounds. See `signal-colors.ts`.
 */

import type { ElementBindingState } from '../engine/rv-signal-binding-manager';

// ── "not linked" — one lexeme, two registers ────────────────────────────────
//
// The words never vary; only the sentence position does. A standalone status
// label and the first word of a sentence are capitalised, a value cell after a
// dash is not. Both live here so the casing is ONE decision rather than three
// independent literals.

/** Standalone status label / sentence start ("Not linked — <reason>"). */
export const NOT_LINKED_LABEL = 'Not linked';

/** The assignment cell of an unbound slot row (a value, not a sentence). */
export const NOT_LINKED_CELL = '– not linked';

// ── Element level: ElementBindingState ─────────────────────────────────────

/**
 * Status label of a whole bind target. THE single definition — the 3D badge
 * sprite (`SIGNAL_BADGE_STATE_LABEL`) and the popover header (`STATE_LABEL`)
 * both alias this record, so a badge and the popover it opens can never
 * disagree about the element they describe.
 */
export const BINDING_STATE_LABEL: Record<ElementBindingState, string> = {
  unbound: NOT_LINKED_LABEL,
  live: 'Live controlled',
  pending: 'Pending — waiting for CONNECT',
  disconnected: 'Source disconnected',
  conflict: 'Conflict',
};

// ── Slot level: who writes this slot ───────────────────────────────────────
//
// One sentence per authority fact. Two surfaces render it at different lengths:
// the roomy slot-row tooltip appends the consequence clause from
// {@link AUTHORITY_CONSEQUENCE}, the compact signal-tooltip note does not. Same
// lexemes either way — the note is a shortening of the tooltip, never a rewording.

/** The bare fact, per `canWriteSlot()` reason. */
export const AUTHORITY_SENTENCE = {
  /** No claim: the component simulates the missing PLC. */
  ok: 'Component simulation writes this slot',
  /**
   * A live binding writes the slot. Deliberately NOT "a live CONNECT binding":
   * an `internal` mapping relaying a model signal claims `bound` just the same
   * and never involves CONNECT.
   */
  bound: 'A live binding writes this slot',
  forced: 'An operator force pins this slot',
  remote: 'A remote session owner writes this slot',
} as const;

/** The consequence clause the slot-row tooltip appends after an em dash. */
export const AUTHORITY_CONSEQUENCE = {
  bound: 'local simulation is displaced',
  forced: 'incoming writes are held',
  remote: 'local writers are pre-empted',
} as const;

/** `<sentence> — <consequence>`, the long form used in slot-row tooltips. */
export function authorityExplanation(key: keyof typeof AUTHORITY_CONSEQUENCE): string {
  return `${AUTHORITY_SENTENCE[key]} — ${AUTHORITY_CONSEQUENCE[key]}`;
}

// ── Provenance block titles: which DIRECTION is being listed ────────────────
//
// The signal tooltip shows both directions at once, and until plan-353 the
// outgoing one was called "Drives" while the incoming one and the property
// inspector's footer both said "Referenced by". "Drives" was too short to be
// read as a direction, so the two blocks looked like variants of one list.
//
// The rule now: the title names the DIRECTION, and the same relation keeps the
// same word wherever it appears.
//
//  - OUTGOING — slots this signal writes → `PROVENANCE_DRIVES_TITLE`.
//    Rows read `componentType · label` (display pair from the binding, see
//    `signalLinkedSlotLabel`) with the node name as a dim qualifier.
//  - INCOMING — components pointing at this object → `PROVENANCE_REFERENCED_TITLE`.
//    Deliberately IDENTICAL in the signal tooltip and the property-inspector
//    footer: both list reverse references, so one term is correct and two would
//    be the drift this module exists to prevent.

/** Title of the outgoing block: slots this signal drives. */
export const PROVENANCE_DRIVES_TITLE = 'Drives these slots';

/** Title of the incoming block: what references this object (tooltip + inspector). */
export const PROVENANCE_REFERENCED_TITLE = 'Referenced by';

// ── Signal level: liveness wording ─────────────────────────────────────────
//
// `activityLabel()` (rv-signal-badge.tsx) and `activityStatusHint()`
// (rv-signal-activity.ts) are two REGISTERS of one taxonomy, not two taxonomies:
//
//  - `activityLabel`      — compact, line 2 of the signal tooltip, with the age
//                           baked in ("live", "stale 45s", "no source").
//  - `activityStatusHint` — the roomier sentence in the signal LIST.
//
// Since plan-353 F5 the compact one is actually rendered; before that it was
// computed, carried in the tooltip model and dropped, which is why a stale value
// could be shown with no indication that it was stale.
