// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ui-blur — the single dial for the HMI's glass blur cost (plan-344 Phase 2).
 *
 * Every `backdrop-filter` in the HMI blurs the 3D canvas behind it. Because the
 * canvas repaints every frame, the compositor has to re-sample and re-blur that
 * backdrop every frame, once per translucent surface — the structural path by
 * which the React overlay attacks the 3D framerate.
 *
 * The dial is a DIMENSIONLESS FACTOR, not an absolute pixel value, and this is
 * deliberate: the blur inventory is not uniform (16px on the main papers, 12px
 * on toolbars/menus, 8px on banners and the touch override, 6px on gates and the
 * orientation gizmo). Every declaration keeps its own base radius and multiplies
 * it:
 *
 *   backdrop-filter: blur(calc(12px * var(--rv-ui-blur-scale, 1)));
 *
 * At the default factor `1` every surface resolves to exactly the value it had
 * before this module existed — the default look is bit-identical. The `Fast`
 * visual preset sets `0.25`, which takes the main papers from 16px to 4px and
 * scales the other three classes proportionally (12→3, 8→2, 6→1.5). The glass
 * stays glass: DESIGN.md's Three-Tier Glass Rule forbids an opaque panel
 * fallback, so this lowers the blur, it never switches it off.
 *
 * The custom property lives on `document.documentElement`, NOT on the HMI root:
 * MUI portals dialogs, menus and popovers into `document.body`, which is outside
 * the HMI root and would not inherit a token set there.
 */

/** CSS custom property carrying the dimensionless blur factor. */
export const UI_BLUR_SCALE_VAR = '--rv-ui-blur-scale';

/** Factor at which every surface keeps its authored base radius. */
export const DEFAULT_UI_BLUR_SCALE = 1;

/** Factor used by the `Fast` visual preset (16px → 4px on the main papers). */
export const FAST_UI_BLUR_SCALE = 0.25;

/** Clamp to a sane range: 0 would read as "no glass" (forbidden by DESIGN.md's
 *  Three-Tier Glass Rule), above 1 only costs compositor time. */
export function clampUIBlurScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_UI_BLUR_SCALE;
  return Math.min(1, Math.max(0.1, n));
}

/**
 * `backdrop-filter` value for an authored base radius, scaled by the live factor.
 * Prefer writing the `blur(calc(...))` literal inline at declaration sites (it
 * keeps the grep invariant in `tests/ui-blur-token.test.ts` mechanical); this
 * helper exists for computed/derived radii.
 */
export function uiBlur(basePx: number): string {
  return `blur(calc(${basePx}px * var(${UI_BLUR_SCALE_VAR}, ${DEFAULT_UI_BLUR_SCALE})))`;
}

/**
 * Write the factor onto `document.documentElement`.
 *
 * Must run synchronously BEFORE the first HMI paint (see `main.ts`), otherwise a
 * user booting with the `Fast` preset gets one frame at full blur.
 */
export function applyUIBlurScale(scale: number): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(UI_BLUR_SCALE_VAR, String(clampUIBlurScale(scale)));
}

/** Current factor as resolved on `document.documentElement` (default when unset). */
export function readUIBlurScale(): number {
  if (typeof document === 'undefined') return DEFAULT_UI_BLUR_SCALE;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(UI_BLUR_SCALE_VAR).trim();
  if (!raw) return DEFAULT_UI_BLUR_SCALE;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_UI_BLUR_SCALE;
}
