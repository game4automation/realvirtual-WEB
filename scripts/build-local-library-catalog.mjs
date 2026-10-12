// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * build-local-library-catalog.mjs — Generate the bundled-library manifest.
 *
 * Scans `public/library/` for `.glb` files and writes a
 * `public/library/catalog.json` the planner loads via
 * `loadBundledLibrary` (planner-persistence.ts). This is the STANDARD library
 * shipped with every publish; GitHub is NOT a default source.
 *
 * Without this catalog the planner falls back to a flat glob scan where every
 * asset lands in the "custom" category with a filename-derived label. The
 * catalog instead derives:
 *   - category  = the first sub-folder, humanized (e.g. `PalletHandling`
 *                 -> "Pallet Handling"). Keep sub-folders CamelCase for nice
 *                 display; an all-lowercase folder can't be word-split.
 *   - name      = the file stem, humanized (e.g. `RollConveyor-2m`
 *                 -> "Roll Conveyor 2m").
 *   - glbUrl    = path relative to the library root (resolved at load time).
 *   - sha256 / sizeBytes = the bytes behind glbUrl (plan-508). The browser's
 *                 blob cache keys on the hash and verifies every download
 *                 against it. These are the UNSIGNED dev bytes — correct for
 *                 `vite dev`; a signing deploy re-stamps the shipped catalog
 *                 AFTER signing (`stampCatalogHashes` in `_bunny-lib.mjs`).
 * Thumbnails are rendered at runtime by the planner, so none are emitted here.
 *
 * Run: `node scripts/build-local-library-catalog.mjs`
 */

import { readdir, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256File } from './lib/rv-hash.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LIBRARY_DIR = join(ROOT, 'public', 'library');
const LIBRARY_URL_ROOT = 'public/library';
export const OUTPUT = join(LIBRARY_DIR, 'catalog.json');

/** Insert spaces at camelCase / acronym boundaries and on `-`/`_`, then title-trim. */
export function humanize(s) {
  return s
    .replace(/[_-]+/g, ' ')                     // separators -> space
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')     // camelCase -> "camel Case"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // acronym boundary: ABCFoo -> ABC Foo
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable, URL-safe id from a path-ish string. */
export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Recursively collect all `.glb` files under `dir`, returned as paths relative to `root` (default LIBRARY_DIR). */
export async function collectGlbs(dir, root = LIBRARY_DIR) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectGlbs(full, root));
    } else if (entry.isFile() && /\.glb$/i.test(entry.name)) {
      out.push(relative(root, full));
    }
  }
  return out;
}

/**
 * Git-ignored entries among `relPaths` (relative to LIBRARY_DIR).
 *
 * The library tree also holds local scratch assets and customer CAD imports, which are
 * gitignored individually. `catalog.json` itself is checked in and reaches the public
 * mirror and every customer delivery, so those file names must never enter it — the
 * catalog would list them, and the entries would 404 for everyone but the local machine.
 * Outside a Git checkout (public fork, exported tarball) nothing is filtered.
 */
export function gitIgnored(relPaths) {
  if (relPaths.length === 0) return new Set();
  const toGitPath = (rel) => `${LIBRARY_URL_ROOT}/${rel.split(sep).join('/')}`;
  try {
    const output = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: ROOT, input: relPaths.map(toGitPath).join('\0'), encoding: 'utf8',
    });
    const ignored = new Set(output.split('\0').filter(Boolean));
    return new Set(relPaths.filter((rel) => ignored.has(toGitPath(rel))));
  } catch {
    // Exit 1 means "nothing ignored"; any other failure (no Git, no repository) filters nothing.
    return new Set();
  }
}

/**
 * The stable id of one library file — the identity contract (plan-737).
 *
 * `rel` is LIBRARY_DIR-relative with native separators. It is the SAME
 * derivation the catalog entries above use, exported so the guard test can
 * assert it without re-deriving it: every `AssetReference.assetId` a planner
 * scene ever baked against the bundled catalog resolves by this identity.
 *
 * The demo manifest no longer carries `library/` document rows at all
 * (plan-737). The library is APP-LEVEL (`public/library/catalog.json`) and the
 * demo merely SUBSCRIBES to it through its `libraries[]` — it does not own it.
 * So there is nothing left to sync into a project manifest, and
 * `syncManifestLibraryRows()` and its `MANIFEST` target went with the rows.
 */
export function libraryAssetId(rel) {
  return slug(rel.replace(/\.glb$/i, ''));
}

/**
 * Build the catalog object for `libraryDir` (default: the bundled library).
 *
 * `filterIgnored` drops Git-ignored files; it only makes sense for the real
 * LIBRARY_DIR (the ignore rules are spelled against `public/library`), so a
 * caller scanning another folder (the hash test) passes `false`.
 */
export async function buildLocalCatalog(libraryDir = LIBRARY_DIR, { filterIgnored = libraryDir === LIBRARY_DIR, log = () => {} } = {}) {
  const scanned = (await collectGlbs(libraryDir, libraryDir)).sort();
  const ignored = filterIgnored ? gitIgnored(scanned) : new Set();
  if (ignored.size > 0) {
    log(`[build-local-library-catalog] skipping ${ignored.size} Git-ignored asset(s) — local only, never catalogued.`);
  }
  const relPaths = scanned.filter((rel) => !ignored.has(rel));
  const entries = relPaths.map((rel) => {
    const parts = rel.split(sep);
    const file = parts[parts.length - 1];
    const folder = parts.length > 1 ? parts[0] : 'General';
    const stem = file.replace(/\.glb$/i, '');
    const glbUrl = parts.join('/'); // POSIX-style URL relative to the library root
    const { sha256, sizeBytes } = sha256File(join(libraryDir, rel));
    return {
      id: slug(rel.replace(/\.glb$/i, '')),
      name: humanize(stem),
      category: humanize(folder),
      glbUrl,
      sha256,
      sizeBytes,
    };
  });

  // Stable order: by category, then name.
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  return { version: '1.0', name: 'realvirtual Library', entries };
}

async function main() {
  try {
    await stat(LIBRARY_DIR);
  } catch {
    // No bundled library in this checkout (e.g. a public fork) — skip gracefully
    // so `npm run build` (which runs this as prebuild) still succeeds. The planner
    // then has no standard catalog; that's fine.
    console.warn(`[build-local-library-catalog] no library dir (${relative(ROOT, LIBRARY_DIR)}) — skipping catalog.`);
    process.exit(0);
  }

  const catalog = await buildLocalCatalog(LIBRARY_DIR, { log: (m) => console.warn(m) });
  const { entries } = catalog;
  await writeFile(OUTPUT, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  const byCat = entries.reduce((m, e) => ((m[e.category] = (m[e.category] || 0) + 1), m), {});
  console.log(`[build-local-library-catalog] wrote ${entries.length} entries -> ${relative(ROOT, OUTPUT)}`);
  for (const [cat, n] of Object.entries(byCat).sort()) console.log(`  ${cat}: ${n}`);
}

// Run only when invoked directly (`node scripts/build-local-library-catalog.mjs`);
// the guard test imports the helpers above and must not trigger a write.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
