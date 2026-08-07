// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-341 §9.6 — the signal value colour token.
 *
 *  - HUE follows the DIRECTION, INTENSITY follows the STATE.
 *  - every combination from §2.3 (bool TRUE/FALSE, numeric !=0 / =0,
 *    `undefined`, NaN, forced) resolves to the defined step.
 *  - the steps are fixed literals, NOT derived with `opacity`.
 *  - every step clears WCAG **3:1** against the worst-case backdrop the module
 *    header documents — recomputed here, never copied from a comment.
 *
 * The floor is 3:1, not 4.5:1, on purpose: a value chip is a state INDICATOR
 * next to a label that already names the state, so SC 1.4.11 (Non-text
 * Contrast) applies, not SC 1.4.3 (User decision 29.07.). The 4.5:1 palette
 * was capped near OKLCH L 0.84, where sRGB allows barely C 0.09 chroma, and it
 * came out pastel; the freed lightness is spent entirely on chroma. Full
 * derivation in the header of `src/core/hmi/signal-colors.ts`.
 */
import { describe, expect, it } from 'vitest';
import signalColorsSource from '../src/core/hmi/signal-colors.ts?raw';
import {
  SIGNAL_VALUE_COLOR,
  SIGNAL_VALUE_NEUTRAL,
  SIGNAL_VALUE_WORST_CASE_BG,
  signalDirectionFromType,
  signalTypeBadgeColor,
  signalValueColor,
  signalValueColorForValue,
} from '../src/core/hmi/signal-colors';

// ── WCAG 2.1 relative luminance / contrast, computed from the literals ───────

function channel(v: number): number {
  const u = v / 255;
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255)
    + 0.7152 * channel((n >> 8) & 255)
    + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every colour the module can hand out. */
const ALL_STEPS: [string, string][] = [
  ['output.strong', SIGNAL_VALUE_COLOR.output.strong],
  ['output.weak', SIGNAL_VALUE_COLOR.output.weak],
  ['input.strong', SIGNAL_VALUE_COLOR.input.strong],
  ['input.weak', SIGNAL_VALUE_COLOR.input.weak],
  ['unknown.strong', SIGNAL_VALUE_COLOR.unknown.strong],
  ['unknown.weak', SIGNAL_VALUE_COLOR.unknown.weak],
  ['neutral', SIGNAL_VALUE_NEUTRAL],
];

describe('signal value colour — hue = direction, intensity = state', () => {
  it('keeps the direction hue on BOTH intensity steps', () => {
    // Green stays greener than it is red on both steps; red stays redder than
    // it is green — i.e. the hue survives the intensity change.
    for (const step of ['strong', 'weak'] as const) {
      const out = parseInt(SIGNAL_VALUE_COLOR.output[step].slice(1), 16);
      const inp = parseInt(SIGNAL_VALUE_COLOR.input[step].slice(1), 16);
      expect(((out >> 8) & 255) - ((out >> 16) & 255)).toBeGreaterThan(0);
      expect(((inp >> 16) & 255) - ((inp >> 8) & 255)).toBeGreaterThan(0);
    }
  });

  it('never reuses one colour for two different meanings', () => {
    const values = ALL_STEPS.map(([, c]) => c.toUpperCase());
    // `neutral` is intentionally the same literal as `unknown.weak` — both mean
    // "no direction, no state". Everything else must be distinct.
    expect(new Set(values).size).toBe(values.length - 1);
    expect(SIGNAL_VALUE_NEUTRAL.toUpperCase())
      .toBe(SIGNAL_VALUE_COLOR.unknown.weak.toUpperCase());
  });

  it('maps active/inactive to strong/weak per direction', () => {
    expect(signalValueColor('output', true)).toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(signalValueColor('output', false)).toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(signalValueColor('input', true)).toBe(SIGNAL_VALUE_COLOR.input.strong);
    expect(signalValueColor('input', false)).toBe(SIGNAL_VALUE_COLOR.input.weak);
    expect(signalValueColor('unknown', true)).toBe(SIGNAL_VALUE_COLOR.unknown.strong);
  });
});

describe('signal value colour — §2.3 state table', () => {
  it('bool TRUE takes the strong step of its direction', () => {
    expect(signalValueColorForValue('output', true)).toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(signalValueColorForValue('input', true)).toBe(SIGNAL_VALUE_COLOR.input.strong);
  });

  it('bool FALSE keeps the direction — it does NOT collapse to a flat grey', () => {
    expect(signalValueColorForValue('output', false)).toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(signalValueColorForValue('input', false)).toBe(SIGNAL_VALUE_COLOR.input.weak);
    // The regression this rule exists for: FALSE used to be #808080 for both
    // directions, so the direction was lost exactly where it still applied.
    expect(signalValueColorForValue('output', false))
      .not.toBe(signalValueColorForValue('input', false));
    expect(signalValueColorForValue('output', false)).not.toBe(SIGNAL_VALUE_NEUTRAL);
  });

  it('numeric != 0 is strong, numeric = 0 is weak', () => {
    expect(signalValueColorForValue('output', 42)).toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(signalValueColorForValue('output', -0.5)).toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(signalValueColorForValue('output', 0)).toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(signalValueColorForValue('input', 0)).toBe(SIGNAL_VALUE_COLOR.input.weak);
  });

  it('undefined / NaN / empty reading take the NEUTRAL step, not the hue', () => {
    for (const raw of [undefined, null, NaN, '', '   ', '—']) {
      expect(signalValueColorForValue('input', raw)).toBe(SIGNAL_VALUE_NEUTRAL);
      expect(signalValueColorForValue('output', raw)).toBe(SIGNAL_VALUE_NEUTRAL);
    }
  });

  it('reads stringified values the same way as raw ones', () => {
    expect(signalValueColorForValue('output', 'true')).toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(signalValueColorForValue('output', 'false')).toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(signalValueColorForValue('output', '0')).toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(signalValueColorForValue('output', '3.5')).toBe(SIGNAL_VALUE_COLOR.output.strong);
  });

  it('a forced value keeps its VALUE colour — force is a separate carrier', () => {
    // Forcing replaces the value shown; it must not introduce a third step.
    expect(signalValueColorForValue('input', true)).toBe(SIGNAL_VALUE_COLOR.input.strong);
    expect(signalValueColorForValue('input', false)).toBe(SIGNAL_VALUE_COLOR.input.weak);
    expect(ALL_STEPS.map(([, c]) => c)).not.toContain('#ffb300');
  });

  it('derives the direction from the PLC type, and type badges are always weak', () => {
    expect(signalDirectionFromType('PLCOutputBool')).toBe('output');
    expect(signalDirectionFromType('PLCInputFloat')).toBe('input');
    expect(signalDirectionFromType('Drive')).toBe('unknown');
    // A type badge names a direction while no value is in play → weak step.
    expect(signalTypeBadgeColor('PLCOutputBool')).toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(signalTypeBadgeColor('PLCInputBool')).toBe(SIGNAL_VALUE_COLOR.input.weak);
  });
});

describe('signal value colour — auditability', () => {
  it('states the intensity with fixed colours, never with opacity', () => {
    for (const [name, colour] of ALL_STEPS) {
      expect(colour, name).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    // No alpha channel, no rgba(), no opacity in the token definitions.
    const tokens = signalColorsSource.slice(
      signalColorsSource.indexOf('export const SIGNAL_VALUE_COLOR'),
    );
    expect(tokens).not.toMatch(/opacity/i);
    expect(tokens).not.toMatch(/rgba\(/);
  });

  it('clears WCAG 1.4.11 (3:1) for EVERY step against the fixed worst-case backdrop', () => {
    // The backdrop is the brightest glass tier over the scene background grey:
    // 0.6 * 30 + 0.4 * 154 = 79.6 -> 80 -> #505050. Recomputed, not trusted.
    const glass = 30, scene = 154, alpha = 0.6;
    const composited = Math.round(alpha * glass + (1 - alpha) * scene);
    expect(SIGNAL_VALUE_WORST_CASE_BG.toUpperCase())
      .toBe('#' + composited.toString(16).padStart(2, '0').repeat(3).toUpperCase());

    for (const [name, colour] of ALL_STEPS) {
      expect(contrast(colour, SIGNAL_VALUE_WORST_CASE_BG), `${name} (${colour})`)
        .toBeGreaterThanOrEqual(3);
    }
  });

  it('spends the 1.4.11 headroom on SATURATION — the steps are not pastel', () => {
    // The point of the 4.5:1 -> 3:1 move (User decision 29.07.): at the old
    // floor every step sat near OKLCH L 0.84, where sRGB barely allows C 0.09,
    // and the palette read as milk. sRGB saturation ((max-min)/max) is the
    // library-free stand-in for chroma here.
    const sat = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      return (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    };
    for (const dir of ['output', 'input'] as const) {
      const strong = sat(SIGNAL_VALUE_COLOR[dir].strong);
      const weak = sat(SIGNAL_VALUE_COLOR[dir].weak);
      // Vivid enough to read as the industrial hue, not as a tint of white...
      expect(strong, `${dir}.strong`).toBeGreaterThan(0.4);
      // ...while the state axis stays wide open between the two steps.
      expect(strong - weak, `${dir} strong-weak`).toBeGreaterThan(0.2);
    }
    // The greys carry no hue at all — that is what makes "no value" readable
    // as absence rather than as a washed-out direction.
    for (const grey of [SIGNAL_VALUE_COLOR.unknown.strong, SIGNAL_VALUE_NEUTRAL]) {
      expect(sat(grey)).toBe(0);
    }
  });

  it('is not blocked by contrast alone — it is blocked by MEANING', () => {
    // This replaces an earlier assertion that all three pre-migration literals
    // failed the floor. At 3:1 that is simply no longer true, so stating it
    // would be false documentation.
    //
    // What still holds: the old FALSE grey and the old red cannot carry a
    // signal value on this backdrop at any threshold we use.
    for (const legacy of ['#ef5350', '#808080']) {
      expect(contrast(legacy, SIGNAL_VALUE_WORST_CASE_BG)).toBeLessThan(3);
    }
    // The old green DOES clear 3:1 — and is still not used here, because that
    // literal already means "component type / sensor / element is live"
    // elsewhere in the product. One literal, one meaning.
    expect(contrast('#66bb6a', SIGNAL_VALUE_WORST_CASE_BG)).toBeGreaterThanOrEqual(3);
    const produced = ALL_STEPS.map(([, c]) => c.toLowerCase());
    for (const legacy of ['#66bb6a', '#ef5350', '#808080']) {
      expect(produced).not.toContain(legacy);
    }
  });
});
