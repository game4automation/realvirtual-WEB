// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `cursor-path.mjs` (plan-2004). Required for TS7016 — the node tests
 * import the module statically from TypeScript. Keep in step with the .mjs by hand.
 */

export interface Point { x: number; y: number }
export interface CursorSample { frame: number; t: number; x: number; y: number }

export function moveDuration(distance: number, targetWidth: number): number;
export function moveFrames(distance: number, targetWidth: number, fps: number): number;
export function planMove(
  from: Point,
  to: Point,
  targetWidth: number,
  seed: string,
  fps: number,
): CursorSample[];
