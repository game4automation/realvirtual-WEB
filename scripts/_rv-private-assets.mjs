// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

/**
 * MIME types for static assets served from private projects — and, by being the
 * only place a type is named, the allowlist of what may be served at all.
 *
 * Lives here rather than in `vite.config.ts` because the resolver below is the
 * thing that consults it, and a guard whose allowlist sits in another file is a
 * guard with two places to get it wrong.
 */
export const PRIVATE_ASSET_MIME = Object.freeze({
  '.glb': 'model/gltf-binary',
  '.aasx': 'application/asset-administration-shell-package',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
});

/**
 * Resolves `<project>/<relative path>` inside `projectsDir`, or `null` when the
 * request is not one the dev server is willing to answer (plan-395 §2.5).
 *
 * This is the ONE place a request path becomes a filesystem path. The route it
 * guards is recursive by design — `/private-assets/<project>/<path...>` serves
 * `docs/` and `aasx/`, and since plan-395 also the internal Development
 * project's `fixtures/`, `models/`, `library/` and `scratch/`. Until now it
 * composed that path with a bare `join()` and no containment check at all,
 * which made traversal out of the projects directory a matter of typing `..`.
 *
 * The rules, in the order they are cheapest to apply:
 *
 *  - **No NUL byte.** A truncating byte in a path is never a real request.
 *  - **A project is one path segment.** No separator, no `.`, no `..`.
 *  - **No `..` segment, no absolute path, no drive letter, no backslash** in the
 *    asset path. Callers decode percent-escapes first, so `%2e%2e%2f` arrives
 *    here as `../` and is caught with it.
 *  - **Known file type only** — {@link PRIVATE_ASSET_MIME} is the allowlist, so
 *    a `.env` or a `.secrets.json` sidecar is a 404 by construction.
 *  - **Containment, twice.** Once on the resolved path, once on its `realpath`
 *    — the second is what catches a symlink inside a project pointing out of it.
 *
 * The resolved REAL path is returned and the caller opens exactly that, so
 * there is no check-then-open window in which the name could change meaning.
 *
 * @param {string} projectsDir absolute path of the private `projects/` root
 * @param {string} project one path segment: the project folder name
 * @param {string} assetPath decoded, project-relative POSIX path
 * @returns {{ path: string, mime: string } | null}
 */
export function resolvePrivateAsset(projectsDir, project, assetPath) {
  if (typeof projectsDir !== 'string' || !projectsDir) return null;
  if (typeof project !== 'string' || typeof assetPath !== 'string') return null;
  if (!project || !assetPath) return null;
  // A NUL byte, matched via escape so this file itself stays plain text.
  // Spaces are deliberately NOT excluded: 'Side Cutting.glb' is a real name.
  if (/\u0000/.test(project) || /\u0000/.test(assetPath)) return null;
  if (project.includes('/') || project.includes('\\')) return null;
  if (project === '.' || project === '..') return null;
  if (assetPath.includes('\\')) return null;
  if (assetPath.startsWith('/') || /^[a-zA-Z]:/.test(assetPath)) return null;
  if (assetPath.split('/').some((segment) => segment === '..')) return null;

  const mime = PRIVATE_ASSET_MIME[extname(assetPath).toLowerCase()];
  if (!mime) return null;

  const root = resolve(projectsDir);
  const candidate = resolve(root, project, assetPath);
  if (!candidate.startsWith(root + sep)) return null;

  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  if (!real.startsWith(realRoot + sep)) return null;

  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return { path: real, mime };
}

/**
 * The decoded `<project>` / `<assetPath>` pair of a `/private-assets/` URL, or
 * `null` when the URL itself is refused.
 *
 * Separate from {@link resolvePrivateAsset} because the two refuse different
 * things: this one judges the URL (query, fragment, encoding), the other judges
 * the path it decodes to. Keeping them apart is what lets a Node test exercise
 * the traversal rules without an HTTP server.
 *
 * A query or fragment is refused rather than stripped: nothing that
 * legitimately reads these assets sends one, so its presence means the request
 * is not what it appears to be.
 *
 * @param {string} url the raw request URL, starting with `/private-assets/`
 * @returns {{ project: string, assetPath: string } | null}
 */
export function parsePrivateAssetUrl(url) {
  const PREFIX = '/private-assets/';
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) return null;
  if (url.includes('?') || url.includes('#')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // Malformed percent-encoding ('%zz', a lone '%'). Refused, and deliberately
    // with the same answer as a missing file: a distinct status would be a
    // probing oracle, and the request is not served either way.
    return null;
  }
  const stripped = decoded.slice(PREFIX.length);
  const slashIdx = stripped.indexOf('/');
  if (slashIdx <= 0) return null;
  return { project: stripped.substring(0, slashIdx), assetPath: stripped.substring(slashIdx + 1) };
}

/** True when `dir` exists and is a directory. Convenience for the plugin gate. */
export function isDirectory(dir) {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
