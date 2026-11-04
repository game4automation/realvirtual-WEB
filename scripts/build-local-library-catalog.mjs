// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * build-local-library-catalog.mjs — Generate the bundled-library manifest.
 *
 * Scans `public/library/` for `.glb` files and writes
 * `public/library/project.json` — the realvirtual library as a normal project
 * (plan-778), which every build ships app-level and the library project loader
 * finds at its built-in location. This is the STANDARD library shipped with
 * every publish; GitHub is NOT a default source.
 *
 * The scan first builds an in-memory catalog (`buildLocalCatalog`, the format
 * external catalogs and the GitHub scan still use) and turns it into the project
 * manifest. Each entry derives:
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
 *   - thumbnail = the saved preview of the entry, when one exists (plan-776):
 *                 `<category>/.thumbnails/<encodedId>.<hash8>.<webp|png>`,
 *                 relative to the library root. Derived from the folder on every
 *                 build, so `prebuild` never drops it; the newest file wins when a
 *                 category holds several for one id. Nothing is rendered here, and
 *                 the planner renders nothing either — an entry without a sidecar
 *                 shows its type placeholder.
 *
 * plan-778: the output is `public/library/project.json` (id `prj_realvirtual_library`).
 * Its document ids are the former catalog ids, every row keeps hash/size/thumbnail/
 * collections (and the planner fields `footprintMm`/`pivotToFloor`/`tags` where an
 * entry has them) and carries `aliases` = the id the GitHub repo scan mints for the
 * same file (`realvirtual-library-<path>-glb`), so references written against the
 * GitHub catalog keep resolving. The bundled `catalog.json` is no longer written
 * (plan-778 Phase 4, last task); a project that still lists its URL is served the
 * library project through the legacy-URL shim (`library-origin.ts`).
 *
 * Run: `node scripts/build-local-library-catalog.mjs`
 * GitHub location (one library, several locations): the same `project.json` for a
 * LOCAL CHECKOUT of the repo — never run against a clone by CI, never pushed here:
 *   `node scripts/build-local-library-catalog.mjs --repo <path-to-checkout> [--repo-name realvirtual-Library]`
 */

import { readdir, writeFile, stat } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256File } from './lib/rv-hash.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LIBRARY_DIR = join(ROOT, 'public', 'library');
const LIBRARY_URL_ROOT = 'public/library';
export const PROJECT_OUTPUT = join(LIBRARY_DIR, 'project.json');
/** Identity of the realvirtual library project — the same in every location (plan-778 Decision 10). */
export const LIBRARY_PROJECT_ID = 'prj_realvirtual_library';
/** The GitHub repository the public copy of the library lives in (scan ids are minted from its name). */
export const GITHUB_REPO_NAME = 'realvirtual-Library';

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
      if (entry.name.startsWith('.')) continue; // .git / .thumbnails — never library content
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
 * gitignored individually. `project.json` itself is checked in and reaches the public
 * mirror and every customer delivery, so those file names must never enter it — the
 * manifest would list them, and the rows would 404 for everyone but the local machine.
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
 * (plan-737). The library is APP-LEVEL (`public/library/project.json`) and the
 * demo merely SUBSCRIBES to it through its `libraries[]` — it does not own it.
 * So there is nothing left to sync into a project manifest, and
 * `syncManifestLibraryRows()` and its `MANIFEST` target went with the rows.
 */
export function libraryAssetId(rel) {
  return slug(rel.replace(/\.glb$/i, ''));
}

/**
 * A document id as a file NAME — the mjs twin of `encodeThumbnailId` in
 * `src/core/library/library-types.ts` (the node test asserts both agree). Every
 * character outside `[A-Za-z0-9._-]` becomes `~` + its UTF-16 unit in fixed
 * four-digit hex; ids longer than 120 encoded chars get a hashed tail.
 */
export function encodeThumbnailId(documentId) {
  const id = typeof documentId === 'string' ? documentId : '';
  const encoded = id.replace(/[^A-Za-z0-9._-]/g, (c) => `~${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (encoded.length <= 120) return encoded;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${encoded.slice(0, 100)}-${h.toString(36)}`;
}

/**
 * The saved preview of catalog entry `id` in `folder` (library-relative, POSIX,
 * '' for the library root), as a library-relative pointer, or null.
 *
 * Only hashed names count (`<encodedId>.<hash8>.<webp|png>`, plan-776 F1): a
 * hash-less legacy `<id>.png` is ignored. Several candidates — a save that
 * could not delete its predecessor — resolve to the NEWEST by mtime.
 */
export function findCatalogThumbnail(libraryDir, folder, id) {
  const dir = join(libraryDir, ...(folder ? folder.split('/') : []), '.thumbnails');
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const prefix = `${encodeThumbnailId(id)}.`;
  let best = null;
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^[0-9a-f]{8}\.(webp|png)$/.test(name.slice(prefix.length))) continue;
    let mtime = 0;
    try { mtime = statSync(join(dir, name)).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime || (mtime === best.mtime && name > best.name)) best = { name, mtime };
  }
  return best ? `${folder ? `${folder}/` : ''}.thumbnails/${best.name}` : null;
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
    const id = slug(rel.replace(/\.glb$/i, ''));
    // Per CATEGORY folder (plan-776 P1): delivery copies whole category folders.
    const thumbnail = findCatalogThumbnail(libraryDir, parts.length > 1 ? parts[0] : '', id);
    return {
      id,
      name: humanize(stem),
      category: humanize(folder),
      glbUrl,
      sha256,
      sizeBytes,
      ...(thumbnail ? { thumbnail } : {}),
    };
  });

  // Stable order: by category, then name.
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  return { version: '1.0', name: 'realvirtual Library', entries };
}

/**
 * The id the GitHub repo scan (`buildCatalogFromGitHub`, library-store.ts) mints for
 * `rel` (a path inside the repo): `<repo>/<path>` lowercased, every non-alphanumeric
 * run collapsed to `-`. References baked against the GitHub catalog carry this form;
 * the library project answers to it as an ALIAS.
 */
export function githubScanId(rel, repoName = GITHUB_REPO_NAME) {
  return `${repoName}/${rel.split(sep).join('/')}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * The library as a project manifest (plan-778 F12). `catalog` is the object
 * `buildLocalCatalog` returned; rows keep its order. Throws when an alias is not unique
 * or collides with any document id (an alias may never shadow a canonical id).
 */
export function buildLibraryProject(catalog, { repoName = GITHUB_REPO_NAME } = {}) {
  const documents = catalog.entries.map((e) => {
    const alias = githubScanId(e.glbUrl, repoName);
    return {
      id: e.id,
      name: e.name,
      path: e.glbUrl,
      sha256: e.sha256,
      sizeBytes: e.sizeBytes,
      ...(e.thumbnail ? { thumbnail: e.thumbnail } : {}),
      collections: [e.category],
      ...(Array.isArray(e.footprintMm) ? { footprintMm: e.footprintMm } : {}),
      ...(typeof e.pivotToFloor === 'boolean' ? { pivotToFloor: e.pivotToFloor } : {}),
      ...(Array.isArray(e.tags) ? { tags: e.tags } : {}),
      aliases: alias === e.id ? [] : [alias],
    };
  });
  const ids = new Set(documents.map((d) => d.id));
  if (ids.size !== documents.length) throw new Error('library project: duplicate document ids');
  const seen = new Set();
  for (const d of documents) {
    for (const a of d.aliases) {
      if (ids.has(a)) throw new Error(`library project: alias "${a}" collides with a document id`);
      if (seen.has(a)) throw new Error(`library project: alias "${a}" is not unique`);
      seen.add(a);
    }
  }
  return {
    schemaVersion: 2,
    id: LIBRARY_PROJECT_ID,
    name: catalog.name ?? 'realvirtual Library',
    kind: 'demo',
    documents,
  };
}

/** `--repo <checkout>`: emit `project.json` into a local checkout of the GitHub library repo. Writes nothing else, pushes nothing. */
async function mainRepo(repoDir) {
  if (!repoDir) { console.error('--repo needs a path to a local checkout'); process.exit(2); }
  const nameIdx = process.argv.indexOf('--repo-name');
  const repoName = nameIdx >= 0 ? process.argv[nameIdx + 1] : GITHUB_REPO_NAME;
  const catalog = await buildLocalCatalog(repoDir, { filterIgnored: false, log: (m) => console.warn(m) });
  const out = join(repoDir, 'project.json');
  await writeFile(out, JSON.stringify(buildLibraryProject(catalog, { repoName }), null, 2) + '\n', 'utf8');
  console.log(`[build-local-library-catalog] wrote ${catalog.entries.length} documents -> ${out} (not committed, not pushed)`);
}

async function main() {
  const repoIdx = process.argv.indexOf('--repo');
  if (repoIdx >= 0) return mainRepo(process.argv[repoIdx + 1]);
  try {
    await stat(LIBRARY_DIR);
  } catch {
    // No bundled library in this checkout (e.g. a public fork) — skip gracefully
    // so `npm run build` (which runs this as prebuild) still succeeds. The planner
    // then has no standard catalog; that's fine.
    console.warn(`[build-local-library-catalog] no library dir (${relative(ROOT, LIBRARY_DIR)}) — skipping the library project.`);
    process.exit(0);
  }

  const catalog = await buildLocalCatalog(LIBRARY_DIR, { log: (m) => console.warn(m) });
  const { entries } = catalog;
  // plan-778 Phase 4: the project manifest is the ONE artefact; no catalog.json any more.
  await writeFile(PROJECT_OUTPUT, JSON.stringify(buildLibraryProject(catalog), null, 2) + '\n', 'utf8');
  console.log(`[build-local-library-catalog] wrote ${entries.length} documents -> ${relative(ROOT, PROJECT_OUTPUT)}`);

  const byCat = entries.reduce((m, e) => ((m[e.category] = (m[e.category] || 0) + 1), m), {});
  for (const [cat, n] of Object.entries(byCat).sort()) console.log(`  ${cat}: ${n}`);
}

// Run only when invoked directly (`node scripts/build-local-library-catalog.mjs`);
// the guard test imports the helpers above and must not trigger a write.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
