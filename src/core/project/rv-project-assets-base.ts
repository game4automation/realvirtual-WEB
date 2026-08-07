// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-assets-base — where a project's docs and AASX files are served
 * from (plan-372 Phase 14, the remainder of plan-370 Phase 4).
 *
 * Datasheets and AAS submodels used to resolve against one deployment-wide
 * `projectAssetsPath`. Once several projects can be open in turn, that is the
 * wrong base: switching project would keep serving the previous project's
 * datasheets, and the mismatch is invisible — a PDF opens, it is simply the
 * wrong PDF.
 *
 * ## A directory, not an index
 *
 * `project.json` carries `docs: { indexRef?, basePath? }` and the same for
 * `aasx`. Deliberately **no index parsing happens here** (370 §3.6 correction):
 * `indexRef` stays a plain string for the zipper and the validator to move
 * around. All this module does is answer "which directory", which is the only
 * question the AAS resolver and the PDF link map actually ask.
 *
 * ## Precedence, and why it ends where it does
 *
 * 1. an explicit per-model `assetsBasePath` from the model config — the most
 *    specific statement anyone made, and it must keep winning;
 * 2. the active project's `docs.basePath` / `aasx.basePath`;
 * 3. the deployment-wide `projectAssetsPath` fallback.
 *
 * Falling back rather than failing matters: a bundled deploy has no project
 * manifest at all, and its datasheets must keep working exactly as before.
 */

import type { RvProject } from './rv-project-types';

/** Which family of project assets a caller wants the base for. */
export type ProjectAssetKind = 'docs' | 'aasx';

/** Ensure a base path ends in exactly one '/', so callers can concatenate. */
function withTrailingSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * The base path a project declares for `kind`, or null when it declares none.
 *
 * A relative `basePath` is resolved against `fallbackBase` (normally the
 * deployment's asset root) so a manifest can say `docs/` and stay portable —
 * hard-coding an absolute URL in a manifest is precisely what breaks when the
 * project is zipped and opened somewhere else.
 */
export function projectAssetsBase(
  project: RvProject | null,
  kind: ProjectAssetKind,
  fallbackBase: string,
): string | null {
  const declared = project?.[kind]?.basePath;
  if (typeof declared !== 'string' || !declared.trim()) return null;
  const base = declared.trim();
  if (base.startsWith('http://') || base.startsWith('https://') || base.startsWith('/')) {
    return withTrailingSlash(base);
  }
  return withTrailingSlash(`${withTrailingSlash(fallbackBase)}${base}`);
}

/**
 * Resolve the effective assets base, applying the precedence above.
 *
 * `explicit` is the per-model override (`pluginConfig['aas-link'].assetsBasePath`
 * today). It wins outright — a model that names its own asset directory is
 * making a more specific statement than the project it happens to sit in.
 */
export function resolveAssetsBase(opts: {
  explicit?: string | null | undefined;
  project: RvProject | null;
  kind: ProjectAssetKind;
  fallbackBase: string;
}): string {
  const { explicit, project, kind, fallbackBase } = opts;
  if (typeof explicit === 'string' && explicit.trim()) return withTrailingSlash(explicit.trim());
  return projectAssetsBase(project, kind, fallbackBase) ?? withTrailingSlash(fallbackBase);
}
