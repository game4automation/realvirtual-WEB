// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `glb-paths.mjs`.
 *
 * Required because the vitest browser tests import the module statically from
 * TypeScript; without it `npx tsc --noEmit` fails with TS7016. Keep in step with
 * the `.mjs` — there is no compiler check tying the two together (same
 * arrangement as `scripts/_rv-guards.d.mts`).
 */

/** Absolute URL paths (not file names) of the internal GLB assets. */
export const DEV_GLB: {
  readonly tests: string;
  readonly physicsZone: string;
  readonly mechanismDelta: string;
  readonly mechanismFourbar: string;
  readonly mechanismScissor: string;
  readonly robotIK: string;
  readonly europalletEmpty: string;
};
