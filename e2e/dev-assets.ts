// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Availability of the internal Development-project assets, for Playwright specs
 * (plan-395 §2.6, R13).
 *
 * The browser suites decide this with an HTTP probe, because that is the only
 * thing a test running inside a page can do. A Playwright spec runs in Node and
 * can simply look, which is both cheaper and more honest: it needs the answer
 * BEFORE it starts a browser and navigates, and a spec that boots the viewer
 * only to discover the model is missing has already spent the two minutes.
 *
 * This is deliberately a SEPARATE constant from `HAS_PRIVATE_SOURCE` in
 * `private-module-url.ts`, even though today both are true or false together.
 * They answer different questions — "is the private source next to us" versus
 * "are the internal test assets there" — and a spec that needs only the assets
 * should not be tied to the source layout. Specs needing both simply state both.
 *
 * The usage is Playwright's own, and it reports `skipped` rather than `passed`:
 *
 * ```ts
 * test.describe('…', () => {
 *   test.skip(!HAS_DEV_ASSETS, DEV_ASSETS_SKIP_REASON);
 *   …
 * });
 * ```
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

//! Same candidate order as `vite.config.ts` → PRIVATE_ROOT_CANDIDATES, so the
//! specs look where the dev server looks.
const DEV_PROJECT_CANDIDATES = [
  resolve(HERE, '../../realvirtual-WebViewer-Private~/projects/Development'),
  resolve(HERE, '../../realvirtual-web-pro/projects/Development'),
];

//! Absolute path of the internal Development project, or `null` without it.
export const DEV_PROJECT_DIR: string | null =
  DEV_PROJECT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

//! `true` when the internal Development project is available to the dev server.
export const HAS_DEV_ASSETS = DEV_PROJECT_DIR !== null;

//! One wording for every spec: a skip whose reason reads "missing fixture"
//! sends the next person hunting a bug that is not there.
export const DEV_ASSETS_SKIP_REASON =
  'needs the private sibling repository (projects/Development assets, plan-395)';

// ─── Named fixtures out of the project's own manifest (plan-458 §9.3) ────

/**
 * The manifest, or `null` when there is no dev project (or it is unreadable).
 *
 * Read HERE rather than hard-coded in a spec: a spec that names a document by
 * a string somebody typed months ago silently stops testing anything the day
 * that document is renamed — it just clicks nothing and times out with a
 * message about a selector. The project says what it holds; the spec asks it.
 */
function readManifest(): { documents?: { path?: string }[]; folders?: string[] } | null {
  if (DEV_PROJECT_DIR === null) return null;
  try {
    return JSON.parse(readFileSync(resolve(DEV_PROJECT_DIR, 'project.json'), 'utf-8'));
  } catch {
    return null;
  }
}

const MANIFEST = readManifest();

/**
 * File name of a document the dev project actually holds — the tail of a
 * `data-card-path`, so a spec can click a NAMED card instead of `first()`.
 */
export const DEV_PROJECT_DOCUMENT: string | null =
  MANIFEST?.documents?.map(d => d.path).find((p): p is string => typeof p === 'string')
    ?.split('/').pop() ?? null;

/**
 * Name of a folder the dev project actually holds — a declared one, else the
 * first directory a document path names.
 */
export const DEV_PROJECT_FOLDER: string | null = (() => {
  const declared = MANIFEST?.folders?.find(f => typeof f === 'string' && f !== '');
  if (declared) return declared.split('/')[0];
  const nested = MANIFEST?.documents
    ?.map(d => d.path)
    .find((p): p is string => typeof p === 'string' && p.includes('/'));
  return nested ? nested.split('/')[0] : null;
})();
