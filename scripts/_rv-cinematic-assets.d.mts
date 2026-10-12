// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `_rv-cinematic-assets.mjs` (plan-553 F8).
 */

export const PRIVATE_LOOSE_ASSETS: Array<{ folder: string; files: string[] }>;
export const CINEMATIC_BUNDLE_MARKER: RegExp;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cinematicAssetsPlugin(privateRoot: string): any;
