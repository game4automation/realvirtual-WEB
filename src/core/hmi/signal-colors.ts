// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-colors.ts — THE single source for the colour of a rendered SIGNAL VALUE
 * (plan-341 Phase 0).
 *
 * ## Two axes, never mixed
 *
 *   HUE       carries the DIRECTION   — green = PLCOutput, red = PLCInput (unchanged).
 *   INTENSITY carries the STATE       — `weak` = FALSE / zero, `strong` = TRUE / non-zero.
 *
 * Binding consequence (Entscheidungs-Log 29.07., DESIGN.md §2 "State-Is-Sacred"):
 * because a saturated red now means "PLC input is TRUE", red may NOT additionally
 * mean "fault" or "invalid drop target". Alarms and rejections are carried by
 * **icon + label**, never by hue.
 *
 * ## Scope — DOM signal values only
 *
 * This module applies exclusively to DOM surfaces that show a signal VALUE:
 * the signal chip (`SignalBadge`), the drag ghost, hierarchy signal badges and
 * inspector signal fields. It deliberately does NOT apply to
 *   - `SIGNAL_BADGE_STATE_COLOR` / `port-marker-texture` (3D) — those show the
 *     BINDING STATE of a whole element and the drop affordance, not a value,
 *     and keep their own semantics and palette (User decision 29.07.);
 *   - `STATE_COLOR` in `SignalBindPopover` (element binding state);
 *   - `componentColor()` / `BADGE_COLORS` (component type, sensor state).
 *
 * ## Why fixed steps and not `opacity`
 *
 * Every stage below is a literal, measured colour. Deriving `weak` by lowering
 * `opacity` would let the visible contrast float with whatever 3D pixels happen
 * to sit behind the translucent glass in that frame — unverifiable by
 * construction. Fixed values stay auditable.
 *
 * ## Contrast — worst case, explicitly fixed
 *
 * WORST-CASE BACKDROP = `#505050`.
 * Derivation: the brightest glass tier that actually carries signal values —
 * the MUI Paper default `rgba(30,30,30,0.6)` (theme.ts, `!important`)
 * — composited over the brightest large-area scene
 * backdrop the viewer produces, the flat scene background grey `#9A9A9A`
 * (`BG_BASE_SCALAR = 0x9a/255` in rv-viewer.ts at `backgroundBrightness = 1`):
 *   0.6 * 30 + 0.4 * 154 = 79.6 → 80 → #505050, relative luminance 0.08022.
 * The docked LeftPanel (`rgba(48,48,48,0.93)` → #373737) is strictly more
 * forgiving, so a token that clears #505050 clears every panel in the product.
 * So is the anchored bind popover since 31.07.: it moved to the dense-window
 * glass `rgba(15,15,15,0.92)` → #1A1A1A (0.92*15 + 0.08*154 = 26). The worst
 * case stays #505050 because the default Paper tier still carries signal
 * values elsewhere — the popover is simply no longer the binding constraint.
 *
 * ## The bar here is WCAG 1.4.11 (3:1), NOT 1.4.3 (4.5:1) — deliberately
 *
 * PRODUCT.md sets WCAG AA (4.5:1) for TEXT, and that still holds for every
 * label, description and value the user has to *read as prose*. A signal value
 * chip is a different thing: it is a UI component whose colour is a *state
 * indicator* next to a label that already names the state in words. For that,
 * WCAG 2.1 SC **1.4.11 Non-text Contrast** is the applicable success criterion
 * and it asks for **3:1**.
 *
 * Why it matters that we moved: the 4.5:1 palette forced every stage above
 * OKLCH L ≈ 0.84, and at that lightness the sRGB gamut allows barely C ≈ 0.09
 * chroma. The result was pastel — six variations of milk — and it read nothing
 * like the industrial green/red operators know (User decision 29.07.). Dropping
 * to the 1.4.11 floor buys ~0.09 OKLCH lightness, and the whole budget is spent
 * on CHROMA, not on darkening:
 *
 *   strong: L 0.84 → 0.75, C 0.095 → 0.145 (+53 %)
 *   weak:   L 0.87 → 0.78, C 0.030 → 0.050 (+67 %)
 *
 * At L 0.75 the sRGB gamut caps hue 27 at C = 0.151, so 0.145 is 96 % of what
 * red can physically be at the lightness the floor permits — red is the binding
 * hue and green simply matches its chroma, so both directions carry the same
 * intensity. The strong/weak chroma RATIO is unchanged (~1:3), so the state
 * axis is not weakened by the move; in absolute terms it widens (ΔC 0.065 →
 * 0.095).
 *
 *   token            OKLCH                    hex       WCAG 2.1   APCA Lc
 *   output.strong    oklch(0.75 0.145 145)    #6EC672   3.83:1     46.0
 *   output.weak      oklch(0.78 0.050 145)    #A4C0A4   4.09:1     49.1
 *   input.strong     oklch(0.75 0.145  27)    #FC877B   3.41:1     40.6
 *   input.weak       oklch(0.78 0.050  27)    #D6ACA6   3.96:1     47.5
 *   unknown.strong   oklch(0.81  0     —)     #C1C1C1   4.48:1     53.9
 *   unknown.weak     oklch(0.755 0     —)     #AFAFAF   3.68:1     43.7
 *   NEUTRAL          = unknown.weak           #AFAFAF   3.68:1     43.7
 *
 * The greys carry no chroma, so for them intensity IS lightness (strong lighter
 * than weak) — the one place the rule flips, because there is no other axis.
 *
 * Every stage clears 3:1 with margin — the tightest is input.strong at 3.41:1,
 * 14 % above the floor. The APCA cross-check (0.98G-4g, light-on-dark branch)
 * moves down with it, to Lc 41-54. That is above APCA's Lc 30 absolute minimum
 * and around its Lc 45 mark for large/bold text, but BELOW the Lc 60 it would
 * want for 11 px body copy — which is precisely why this is booked as a
 * non-text-contrast decision: the colour is the indicator, the adjacent label
 * carries the reading. Where a signal value is set in running text it uses Ink
 * High, not a value hue.
 *
 * `tests/signal-value-color.test.ts` recomputes the WCAG column from the
 * literals — the table above cannot silently rot.
 */

import type { SignalDirection } from './rv-signal-badge';

/** The two intensity steps of one direction hue. */
export interface SignalValueColors {
  /** Value is TRUE / non-zero. */
  strong: string;
  /** Value is FALSE / zero. */
  weak: string;
}

/**
 * The worst-case backdrop every stage above is measured against — exported so
 * the contrast test asserts the same value the header documents.
 */
export const SIGNAL_VALUE_WORST_CASE_BG = '#505050';

/** Hue = direction, intensity = state. See the module header for the derivation. */
export const SIGNAL_VALUE_COLOR: Record<SignalDirection, SignalValueColors> = {
  output: { strong: '#6EC672', weak: '#A4C0A4' },
  input: { strong: '#FC877B', weak: '#D6ACA6' },
  unknown: { strong: '#C1C1C1', weak: '#AFAFAF' },
};

/**
 * "There is no value" — no store, no signal, `undefined`, `NaN`, empty text.
 * Deliberately NOT the direction hue: an unknown value has a direction, but
 * showing the hue would claim a state that nobody measured.
 */
export const SIGNAL_VALUE_NEUTRAL = '#AFAFAF';

/** The colour of a signal value whose truthiness is already known. */
export function signalValueColor(dir: SignalDirection, active: boolean): string {
  const pair = SIGNAL_VALUE_COLOR[dir] ?? SIGNAL_VALUE_COLOR.unknown;
  return active ? pair.strong : pair.weak;
}

/**
 * The colour of a raw signal value, implementing the full state table
 * (plan-341 §2.3):
 *
 *   bool TRUE              → `strong` of the direction
 *   bool FALSE             → `weak` of the direction (previously a flat grey —
 *                            the direction was lost exactly when it still applied)
 *   numeric ≠ 0            → `strong`
 *   numeric = 0            → `weak`
 *   undefined / NaN / ''   → {@link SIGNAL_VALUE_NEUTRAL}
 *
 * A `forced` value keeps its value colour — the force marking is a separate
 * carrier (pin icon / amber chip), never a third colour step.
 */
export function signalValueColorForValue(dir: SignalDirection, raw: unknown): string {
  if (raw === undefined || raw === null) return SIGNAL_VALUE_NEUTRAL;
  if (typeof raw === 'boolean') return signalValueColor(dir, raw);
  if (typeof raw === 'number') {
    if (Number.isNaN(raw)) return SIGNAL_VALUE_NEUTRAL;
    return signalValueColor(dir, raw !== 0);
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    // Em dash is the viewer's canonical "no reading" placeholder.
    if (text === '' || text === '—') return SIGNAL_VALUE_NEUTRAL;
    if (text === 'true') return signalValueColor(dir, true);
    if (text === 'false') return signalValueColor(dir, false);
    const num = Number(text);
    if (!Number.isNaN(num)) return signalValueColor(dir, num !== 0);
    return signalValueColor(dir, true);
  }
  return SIGNAL_VALUE_NEUTRAL;
}

/**
 * A pure TYPE badge — a surface that names a signal's direction while no value
 * is in play at all (e.g. the inspector section header of a PLCInput/PLCOutput
 * component). The hue stays, the intensity is always `weak`, because nothing
 * here reports a state (plan-341 §2.8 b).
 */
export function signalTypeBadgeColor(plcType: string): string {
  return signalValueColor(signalDirectionFromType(plcType), false);
}

/** Direction from a PLC type string (`PLCInputBool` → `input`). */
export function signalDirectionFromType(plcType: string): SignalDirection {
  if (plcType.startsWith('PLCOutput')) return 'output';
  if (plcType.startsWith('PLCInput')) return 'input';
  return 'unknown';
}
