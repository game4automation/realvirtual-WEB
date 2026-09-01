// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * In-page module URLs for source that lives in the PRIVATE sibling repository.
 *
 * Several e2e specs drive real modules by importing them inside the browser
 * (`page.evaluate(… => import(/* @vite-ignore *\/ path))`). As long as every
 * module sat under this repository's `src/`, a plain server-root URL such as
 * `/src/plugins/asset-editor/…` was enough.
 *
 * The asset editor now lives in `../realvirtual-WebViewer-Private~/src/…`,
 * i.e. OUTSIDE the Vite dev-server root, so those URLs 404. Vite's escape hatch
 * for exactly this case is the `/@fs/<absolute path>` prefix, which is served
 * for any path inside `server.fs.allow` — and `vite.config.ts` already puts the
 * private root on that list (it has to, for the private worker entries).
 *
 * So: resolve the absolute path here in Node, hand the `/@fs/` URL to the page.
 * Nothing about this reaches a production build; it is dev-server-only.
 *
 * A checkout WITHOUT the private repo (the public AGPL mirror) resolves
 * nothing — {@link HAS_PRIVATE_SOURCE} is `false` and the specs that need it
 * skip themselves rather than failing on a 404.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

//! Same candidate order as `vite.config.ts` → PRIVATE_ROOT_CANDIDATES, so the
//! tests look where the dev server looks. A second, divergent list is how
//! "works in the browser, 404 in the test" happens.
const PRIVATE_SRC_CANDIDATES = [
  resolve(HERE, '../../realvirtual-WebViewer-Private~/src'),
  resolve(HERE, '../../realvirtual-web-pro/src'),
];

//! Absolute path of the private `src/`, or `null` in a public-only checkout.
export const PRIVATE_SRC: string | null =
  PRIVATE_SRC_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

//! `true` when the private sibling repository is present next to this one.
export const HAS_PRIVATE_SOURCE = PRIVATE_SRC !== null;

/**
 * Turns a path relative to the private `src/` into a dev-server URL the page
 * can `import()`, e.g.
 * `plugins/asset-editor/pending-open-store.ts`
 *   → `/@fs/<abs>/realvirtual-WebViewer-Private~/src/plugins/asset-editor/pending-open-store.ts`
 *
 * Windows paths are normalised to forward slashes and the leading `/` of a
 * POSIX path is dropped, because Vite re-adds it when it maps `/@fs/…` back to
 * a file system path (a drive letter is recognised and kept as is).
 *
 * Without the private repository it returns the plain server-root path instead
 * of throwing: these constants are built at module scope, so a throw would take
 * down test COLLECTION in a public checkout instead of letting the affected
 * specs skip themselves via {@link HAS_PRIVATE_SOURCE}.
 */
export function privateModuleUrl(relative: string): string {
  if (!PRIVATE_SRC) return `/src/${relative}`;
  const absolute = resolve(PRIVATE_SRC, relative).replace(/\\/g, '/');
  return `/@fs/${encodeURI(absolute.startsWith('/') ? absolute.slice(1) : absolute)}`;
}
