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
 * - `buildTime` — when the build itself ran, local time "YYYY-MM-DD HH:MM".
 *
 * A deploy does not build in the repository but in a filtered staging tree that
 * carries no `.git`. It therefore reads these values in the SOURCE repository and
 * hands them to the build as RV_WEB_BUILD / RV_COMMIT / RV_BUILD_DATE /
 * RV_BUILD_TIME, which take precedence over the git calls in vite.config.ts.
 */
export interface RVVersionInfo {
  version: string;
  webBuild: string;
  commit: string;
  buildDate: string;
  buildTime: string;
}

/** The version info for the current build. */
export const RV_VERSION: RVVersionInfo = {
  version: __RV_VERSION__,
  webBuild: __RV_WEB_BUILD__,
  commit: __RV_COMMIT__,
  buildDate: __RV_BUILD_DATE__,
  buildTime: __RV_BUILD_TIME__,
};

/** Short label, e.g. "v6.3.0 · build 1247". */
export function formatVersionShort(v: RVVersionInfo = RV_VERSION): string {
  return `v${v.version} · build ${v.webBuild}`;
}

/**
 * Full label incl. commit + build timestamp, e.g.
 * "v6.3.0 · web build 1247 (a1b2c3d) · 2026-07-01 21:34".
 *
 * The last segment is the BUILD TIME when one was injected (local time, to the
 * minute) — that is what tells two builds of the same day apart. Without it the
 * commit date is shown as before, and with neither the segment is omitted.
 */
export function formatVersionFull(v: RVVersionInfo = RV_VERSION): string {
  let build = `web build ${v.webBuild}`;
  if (v.commit) build += ` (${v.commit})`;
  const segments = [`v${v.version}`, build];
  const stamp = v.buildTime || v.buildDate;
  if (stamp) segments.push(stamp);
  return segments.join(' · ');
}
