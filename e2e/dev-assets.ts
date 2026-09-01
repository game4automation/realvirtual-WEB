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

import { existsSync } from 'node:fs';
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
