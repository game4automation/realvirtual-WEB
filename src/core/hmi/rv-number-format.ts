// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-number-format.ts — the ONE decimal parser/formatter of the HMI (plan-510).
 *
 * Every inspector number field goes through here, so "0,5" and "0.5" mean the
 * same thing everywhere (before this, `parseFloat("9,81")` silently gave 9).
 *
 * Rules:
 *  - Input accepts dot OR comma as the decimal separator, an optional leading
 *    minus and an exponent (`1e-7`, `1,5e3`) — editor drafts are seeded with
 *    `String(value)`, which may carry one.
 *  - NO thousands separators: `1.000,5` / `1,000.5` are invalid, never guessed.
 *  - Display is always a dot. `formatDecimal` is for READ-ONLY display only; an
 *    editable draft keeps `String(value)` (lossless — rounding a draft would
 *    commit a changed value without any input).
 *
 * Contract: `parseDecimal(String(v)) === v` for every finite `v`.
 */

/** A complete decimal: digits with an optional fraction, or a bare fraction; optional exponent. */
const COMPLETE_RE = /^-?(\d+([.,]\d+)?|[.,]\d+)([eE][+-]?\d+)?$/;
/** Also accepted by the parser: a trailing separator ("1," → 1). Still "incomplete" while typing. */
const PARSEABLE_RE = /^-?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/;
/** Drafts on the way to a number ("", "-", ".", "-,", "1e", "1e-"): not an error while typing. */
const PARTIAL_RE = /^(-?[.,]?|-?(\d+([.,]\d*)?|[.,]\d+)[eE][+-]?)$/;

/**
 * Parses "0.5", "0,5", "-3", ".5", "1e-7", "1,5e3" (a trailing separator is accepted
 * as incomplete input, "1," → 1). No thousands separators. Null when not a number.
 */
export function parseDecimal(input: string): number | null {
  const s = input.trim();
  if (!PARSEABLE_RE.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** True when the draft is a complete number (commits live while typing). */
export function isCompleteDecimal(input: string): boolean {
  return COMPLETE_RE.test(input.trim()) && parseDecimal(input) !== null;
}

/**
 * True when a draft can never become a number by typing on — the field shows
 * its error state (e.g. "1.000,5"). Empty and partial drafts ("-", "1e") are not errors.
 */
export function isInvalidDecimalDraft(input: string): boolean {
  const s = input.trim();
  if (PARTIAL_RE.test(s)) return false;
  return parseDecimal(s) === null;
}

/**
 * READ-ONLY display only: dot, up to 12 significant digits, trims float noise
 * (0.1 + 0.2 → "0.3"); `digits` = fixed fraction digits. Never used to seed an
 * editable draft (rounding would commit a changed value).
 */
export function formatDecimal(value: number, digits?: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (digits !== undefined) return value.toFixed(digits);
  // Integers are exact already — never round an ID or a counter.
  if (Number.isInteger(value)) return String(Object.is(value, -0) ? 0 : value);
  const trimmed = Number(value.toPrecision(12));
  return String(Object.is(trimmed, -0) ? 0 : trimmed);
}

const SUPERSCRIPT: Record<string, string> = { '2': '²', '3': '³' };

/**
 * A unit as it is displayed: exponents as superscripts (`m/s2` → `m/s²`,
 * `m2` → `m²`, `m3` → `m³`, `kg.m2` → `kg.m²`). Only a 2 or 3 that directly
 * follows a letter is an exponent; other text is returned unchanged.
 */
export function formatUnit(unit: string | undefined): string | undefined {
  if (!unit) return unit;
  return unit.replace(/([A-Za-z])([23])(?![0-9])/g, (_m, letter: string, exp: string) => letter + SUPERSCRIPT[exp]);
}
