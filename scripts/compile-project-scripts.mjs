// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * compile-project-scripts — produces the `.js` sibling every `scriptRef` in a
 * project needs for the RUNTIME mode (plan-718 §2.6 mode 2, stage 2b.2).
 *
 * The runtime resolver (`src/core/rv-script-runtime-loader.ts`) imports a
 * compiled `.js` file that sits next to the referenced `.ts`. This is what puts
 * it there.
 *
 * ## Why this is a Node script and not a browser "compile on save"
 *
 * The plan asked for esbuild "beim Speichern", and the honest finding is that
 * the browser half of that is not available without a new dependency:
 *
 *  - `esbuild` IS installed — transitively, via Vite (0.25.x). It is a **native
 *    binary with a Node API**. A browser cannot call it.
 *  - `esbuild-wasm`, the package that would run in a browser, is NOT installed,
 *    and adding it is a new npm dependency the brief rules out (it is also ~10 MB).
 *  - Monaco's TypeScript worker can erase types in the browser and is already a
 *    dependency — but it is configured **globally** for the WebComponent script
 *    editor with `module: None` and `noLib: true` (`src/core/hmi/script/monaco-loader.ts`),
 *    exactly so a top-level `export` is an error there. Producing an ES module
 *    would mean changing those options for every script model in the app, i.e.
 *    breaking the QuickJS editor's contract to serve this one. It also erases
 *    types only — it does not BUNDLE, and a Blob-URL import cannot resolve a
 *    relative `import './util.js'`, so erasure alone would not produce a
 *    loadable artefact anyway.
 *
 * So compilation lives where the toolchain is: here, on the dev/delivery path.
 * In the browser the runtime resolver simply reports "no sibling" and loads
 * nothing — a visible, non-silent failure with an actionable message, rather
 * than a half-working compile.
 *
 * ## What it emits
 *
 * One self-contained ES module per `scriptRef`, bundled (`bundle: true`) —
 * because the artefact is imported from a Blob URL, which has no directory and
 * therefore no way to resolve a relative import. External bare imports are left
 * external: a project script that imports `three` expects the viewer's copy, and
 * inlining a second one would be worse than failing.
 *
 * ## Usage
 *
 *   node scripts/compile-project-scripts.mjs <projectDir> [more dirs…]
 *   node scripts/compile-project-scripts.mjs --projects-root ../realvirtual-WebViewer-Private~/projects
 *   … --check       exit 3 when an artefact is missing or stale (CI / delivery gate)
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_MANIFEST_FILE = 'project.json';

/** Bare specifiers a project script may import — resolved by the host bundle. */
export const EXTERNAL_PACKAGES = ['three', 'react', 'react-dom', '@mui/material', '@mui/icons-material'];

// ─── Reference discovery ────────────────────────────────────────────────

/**
 * Every `scriptRef` in a manifest, normalised and de-duplicated.
 *
 * De-duplication is the N:1 case of the reference model: several documents
 * legitimately name one script, and compiling it three times would only race
 * with itself over the same output file.
 */
export function scriptRefsOf(manifest) {
  const out = [];
  for (const doc of manifest?.documents ?? []) {
    const raw = typeof doc?.scriptRef === 'string' ? doc.scriptRef.trim() : '';
    if (raw === '') continue;
    // Containment, checked on the RAW value: stripping `./` first would also
    // strip the leading `/` of an absolute path and let it through. Same rule
    // as `isContainedRef` in `rv-project-refs.ts`.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) continue;
    const ref = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (ref === '' || ref.split('/').includes('..')) continue;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** `scripts/a.ts` → `scripts/a.js`; a `.js` reference is its own output. */
export function outputRefOf(scriptRef) {
  if (/\.[cm]?js$/i.test(scriptRef)) return scriptRef;
  const m = /^(.*)\.(tsx?|mts|cts)$/i.exec(scriptRef);
  return m ? `${m[1]}.js` : null;
}

/** True when `outPath` is missing or older than `srcPath`. */
export function isStale(srcPath, outPath) {
  if (!existsSync(outPath)) return true;
  try {
    return statSync(outPath).mtimeMs < statSync(srcPath).mtimeMs;
  } catch {
    return true;
  }
}

// ─── Compilation ────────────────────────────────────────────────────────

/**
 * Compile every `scriptRef` of one project directory.
 *
 * `check: true` writes nothing and reports what would be built — the shape a
 * delivery gate wants.
 */
export async function compileProjectDir(projectDir, options = {}) {
  const dir = resolve(projectDir);
  const manifestPath = join(dir, PROJECT_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return { status: 'skipped', reason: `no ${PROJECT_MANIFEST_FILE}`, results: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { status: 'skipped', reason: `unreadable manifest: ${e.message}`, results: [] };
  }

  const refs = scriptRefsOf(manifest);
  if (refs.length === 0) return { status: 'ok', results: [] };

  const results = [];
  let esbuild = null;
  for (const ref of refs) {
    const outRef = outputRefOf(ref);
    if (!outRef) {
      results.push({ ref, status: 'failed', reason: 'not a compilable script reference' });
      continue;
    }
    const srcPath = join(dir, ref);
    const outPath = join(dir, outRef);
    if (outRef === ref) {
      // The project ships compiled code and no source. Nothing to do — but say
      // so, because a missing file here is a dead reference.
      results.push({
        ref, out: outRef,
        status: existsSync(srcPath) ? 'prebuilt' : 'failed',
        reason: existsSync(srcPath) ? undefined : 'referenced .js does not exist',
      });
      continue;
    }
    if (!existsSync(srcPath)) {
      results.push({ ref, out: outRef, status: 'failed', reason: 'source does not exist' });
      continue;
    }
    if (!isStale(srcPath, outPath)) {
      results.push({ ref, out: outRef, status: 'current' });
      continue;
    }
    if (options.check) {
      results.push({ ref, out: outRef, status: 'stale' });
      continue;
    }
    try {
      esbuild ??= await import('esbuild');
      const built = await esbuild.build({
        entryPoints: [srcPath],
        outfile: outPath,
        bundle: true,
        format: 'esm',
        target: 'es2020',
        platform: 'browser',
        sourcemap: false,
        write: true,
        logLevel: 'silent',
        external: EXTERNAL_PACKAGES,
      });
      const warnings = (built.warnings ?? []).map((w) => w.text);
      results.push({ ref, out: outRef, status: 'built', warnings });
    } catch (e) {
      results.push({ ref, out: outRef, status: 'failed', reason: e.message });
    }
  }
  const failed = results.some((r) => r.status === 'failed');
  const stale = results.some((r) => r.status === 'stale');
  return { status: failed ? 'failed' : stale ? 'stale' : 'ok', results };
}

/** Every immediate subdirectory of `root` that holds a project manifest. */
export function projectDirsUnder(root) {
  const dir = resolve(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))
    .filter((p) => existsSync(join(p, PROJECT_MANIFEST_FILE)));
}

// ─── CLI ────────────────────────────────────────────────────────────────

async function main(argv) {
  const check = argv.includes('--check');
  const rootIndex = argv.indexOf('--projects-root');
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : null;
  if (rootIndex >= 0 && !root) {
    console.error('--projects-root needs a directory.');
    return 2;
  }
  const positional = argv.filter((token, index) =>
    !token.startsWith('--') && index !== rootIndex + 1);
  const dirs = positional.length > 0
    ? positional.map((p) => resolve(p))
    : projectDirsUnder(root ?? resolve(dirname(fileURLToPath(import.meta.url)), '../projects'));

  if (dirs.length === 0) {
    console.log('No project directories found — nothing to compile.');
    return 0;
  }

  let exitCode = 0;
  for (const dir of dirs) {
    const { status, reason, results } = await compileProjectDir(dir, { check });
    const name = basename(dir);
    if (status === 'skipped') {
      console.warn(`skip     ${name}: ${reason}`);
      continue;
    }
    for (const r of results) {
      const where = r.out ? relative(dir, join(dir, r.out)).replace(/\\/g, '/') : r.ref;
      if (r.status === 'failed') {
        console.error(`FAIL     ${name}/${r.ref}: ${r.reason}`);
        exitCode = 1;
      } else if (r.status === 'stale') {
        console.error(`STALE    ${name}/${where} is missing or older than its source`);
        exitCode = Math.max(exitCode, 3);
      } else {
        console.log(`${r.status.padEnd(8)} ${name}/${where}`);
        for (const w of r.warnings ?? []) console.warn(`           ${w}`);
      }
    }
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
