// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Build / version metadata for realvirtual WEB.
 *
 * All values are injected at build time by Vite `define` (see vite.config.ts):
 * - `version`   — framework-synced semantic version (from package.json, kept in
 *                 step with the Unity realvirtual release, e.g. "6.3.0").
 * - `webBuild`  — web-specific build number = commit count of THIS repo
 *                 (realvirtual-WEB-DEV), independent of the Unity framework.
 * - `commit`    — short git hash of the built commit ("" if git unavailable).
 * - `buildDate` — date of the built commit, "YYYY-MM-DD".
 */
export interface RVVersionInfo {
  version: string;
  webBuild: string;
  commit: string;
  buildDate: string;
}

/** The version info for the current build. */
export const RV_VERSION: RVVersionInfo = {
  version: __RV_VERSION__,
  webBuild: __RV_WEB_BUILD__,
  commit: __RV_COMMIT__,
  buildDate: __RV_BUILD_DATE__,
};

/** Short label, e.g. "v6.3.0 · build 1247". */
export function formatVersionShort(v: RVVersionInfo = RV_VERSION): string {
  return `v${v.version} · build ${v.webBuild}`;
}

/**
 * Full label incl. commit + date, e.g.
 * "v6.3.0 · web build 1247 (a1b2c3d) · 2026-07-01".
 * Commit and date segments are omitted when unavailable.
 */
export function formatVersionFull(v: RVVersionInfo = RV_VERSION): string {
  let build = `web build ${v.webBuild}`;
  if (v.commit) build += ` (${v.commit})`;
  const segments = [`v${v.version}`, build];
  if (v.buildDate) segments.push(v.buildDate);
  return segments.join(' · ');
}
