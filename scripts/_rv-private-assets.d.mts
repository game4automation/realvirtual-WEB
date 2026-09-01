// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `_rv-private-assets.mjs`.
 *
 * Required because `vite.config.ts` imports the module from TypeScript. Keep in
 * step with the `.mjs` by hand — nothing checks that they agree (same
 * arrangement as `_rv-guards.d.mts`).
 */

/** MIME types of the servable asset kinds — and thereby the allowlist. */
export const PRIVATE_ASSET_MIME: Readonly<Record<string, string>>;

/** The real path and MIME of a private asset, or `null` when refused. */
export function resolvePrivateAsset(
  projectsDir: string,
  project: string,
  assetPath: string,
): { path: string; mime: string } | null;

/** The decoded project / asset-path pair of a `/private-assets/` URL. */
export function parsePrivateAssetUrl(
  url: string,
): { project: string; assetPath: string } | null;

/** True when `dir` exists and is a directory. */
export function isDirectory(dir: string): boolean;
