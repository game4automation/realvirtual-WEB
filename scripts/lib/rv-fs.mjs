// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-fs.mjs — file-system predicates shared by the deploy scripts and the
 * Vite dev server (plan-508).
 *
 * Zero dependencies: Node built-ins only.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

//! `existsSync` that also insists on the SPELLING, one path segment at a time,
//! and on the LAST segment being a FILE.
//!
//! `existsSync` alone answers "yes" for `Models/Demo.glb` on Windows and macOS,
//! which is precisely the typo the deploy guard is there to catch — it would
//! survive every local check and break only on the Linux storage zone. The Vite
//! 404 guard (plan-508 F1) asks the same question for every asset request: a
//! wrongly cased path or a directory is "not there", exactly as the CDN would
//! answer.
//!
//! Moved here from `_bunny-lib.mjs` (which re-exports it) so `vite.config.ts`
//! can import it without pulling in the deploy library.
export function existsOnDiskExactly(rootDir, relPath) {
  let current = rootDir;
  const segments = String(relPath ?? '').split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (segment === '..') return false;
    let entries;
    try { entries = readdirSync(current); } catch { return false; }
    if (!entries.includes(segment)) return false;
    current = join(current, segment);
  }
  try { return statSync(current).isFile(); } catch { return false; }
}

//! The Vite dev-server 404 guard (plan-508 F1) as a connect middleware.
//!
//! Vite answers an unknown path with its `index.html` and status 200 (the SPA
//! fallback). Under an asset url that is poison: on 2026-09-26 one such answer,
//! cached once by the planner's blob cache under a GLB url, stayed the "bytes"
//! of `ChainConveyor-1m.glb` for the life of a browser profile. The guard makes
//! a missing asset what it is on the CDN — a 404 with a plain-text body.
//!
//! Responsible for GET/HEAD of `<base>library/**`, `<base>models/**` and every
//! url ending in `.glb`, `.kin.json`, `.splat`, `.ksplat`, `.ply`. Vite-internal
//! and plugin-owned paths (`/@…`, `/__…`, `/src/`, `/node_modules/`,
//! `/private-models/`, `/private-assets/`) are never touched. Existence is
//! checked with `existsOnDiskExactly` against each of `roots` (publicDir first,
//! then the server root, which serves the test fixtures); `exists` replaces
//! that predicate (test seam).
//!
//! Lives here, pure JS, so the node test can import it without type-checking
//! `vite.config.ts`, which re-exports it and registers it as a PRE-hook
//! (`server.middlewares.use` straight in `configureServer`, before the fallback).
const GUARDED_ASSET_EXT = /\.(glb|kin\.json|splat|ksplat|ply)$/i;
const GUARD_EXEMPT_PREFIXES = ['/@', '/__', '/src/', '/node_modules/', '/private-models/', '/private-assets/'];

export function assetNotFoundGuard(options = {}) {
  const rawBase = options.base && options.base !== './' ? options.base : '/';
  const base = (rawBase.startsWith('/') ? rawBase : `/${rawBase}`).replace(/\/?$/, '/');
  const roots = options.roots ?? [];
  const exists = options.exists ?? ((rel) => roots.some((root) => existsOnDiskExactly(root, rel)));
  return (req, res, next) => {
    // Reads only: a POST to a library path is some plugin's endpoint, not a file.
    const method = String(req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') { next(); return; }
    const url = req.url ?? '';
    const pathname = url.split(/[?#]/, 1)[0];
    if (!pathname.startsWith(base)) { next(); return; }
    const rel = pathname.slice(base.length);
    const rooted = `/${rel}`;
    if (GUARD_EXEMPT_PREFIXES.some((prefix) => rooted.startsWith(prefix))) { next(); return; }
    const guarded = rel.startsWith('library/') || rel.startsWith('models/') || GUARDED_ASSET_EXT.test(rel);
    if (!guarded) { next(); return; }
    let decoded;
    try { decoded = decodeURIComponent(rel); } catch { decoded = ''; }
    if (decoded !== '' && exists(decoded)) { next(); return; }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`rv: asset not found: ${decoded || rel}`);
  };
}

//! Lists every FILE below `root` as a `/`-separated relative path — the one
//! recursive `readdirSync` walk of the Node tooling (plan-587 F5).
//!
//! **Both options are deliberately without a default, and that is the point.**
//! The two callers this replaces disagree about what to leave out, and the
//! disagreement is LICENCE RELEVANT, not cosmetic: the WEB notices plugin walks
//! the whole shipped `publicDir` without cap or skip, because every file in
//! there is delivered and a `node_modules` skip or a depth cap could silently
//! drop a shipped component out of THIRD-PARTY-NOTICES.txt. The CONNECT
//! generator caps at depth 8 and skips `bin*`/`obj`/`node_modules`/`.git`, but
//! only at the root of the project directory. Unifying those FILTERS is
//! explicitly not part of plan-587 — this helper supplies the traversal
//! MECHANISM and nothing else, so no caller changes behaviour by moving here.
//!
//! - `maxDepth` — deepest directory level that is still listed, root = 0.
//!   Omitted (or `null`) = unlimited.
//! - `skipDirs` — which directories to not descend into. Omitted = none. A
//!   function `(name, depth) => boolean` gets the depth of the directory the
//!   entry was found IN, which is how the CONNECT caller expresses "root level
//!   only". A `RegExp` or an array of names applies at every depth.
//!
//! An unreadable directory is skipped, never thrown — as in both originals.
//! Symlinks are neither followed nor listed (`isDirectory`/`isFile` only).
export function walkRelativeFiles(root, { maxDepth = null, skipDirs = null } = {}) {
  const skip = typeof skipDirs === 'function'
    ? skipDirs
    : skipDirs instanceof RegExp
      ? (name) => skipDirs.test(name)
      : Array.isArray(skipDirs)
        ? (name) => skipDirs.includes(name)
        : null;
  const out = [];
  const walk = (rel, depth) => {
    if (maxDepth !== null && maxDepth !== undefined && depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skip && skip(entry.name, depth)) continue;
        walk(child, depth + 1);
      } else if (entry.isFile()) out.push(child);
    }
  };
  walk('', 0);
  return out;
}
