// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Local analysis build of the hosted demo entry (plan-652 Phase 0).
 *
 * The real demo build (`bunny-deploy --demo` → `runBuild(..., { mode: 'demo' })`) deletes
 * `RV_SOURCEMAP` on purpose: a `.map` next to the commercial chunks IS the private source.
 * That production rule stays. This script reproduces the same staging — `stageFilteredSourceTree`
 * with `DEMO_PROFILE`, public demo content, generated files, no workspace files — into a temp
 * directory under `RV_DELIVER_TMP` (`<WS>/rv-tmp`), builds it there WITH hidden source maps and
 * an `outDir` inside that temp directory, and attributes the entry chunk's bytes to their
 * sources. The output is never `dist/` and never deployable; the temp tree is removed unless
 * `--keep` is given.
 *
 * Usage:
 *   node scripts/analyze-demo-entry.mjs [--keep] [--top 40] [--json <file>] [--out <dir>] [--public-only]
 *
 * `--public-only` (plan-680): the COMMUNITY build instead — the core staged alone (no private
 * sibling, `tier: core`), so the build resolves `@rv-private` to the public stubs exactly as a
 * public-only checkout does. Needs no private manifest.
 *
 * Prints the entry path, the size of every JS chunk, the number of `*.register` chunks and the
 * entry composition (per source group, plus the plan-652 feature sums: asset-editor, des,
 * register-des-runner, features/*.register).
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageFilteredSourceTree } from './_workspace-lib.mjs';
import { DEMO_PROFILE } from './bunny-deploy.mjs';
import { DEFAULT_OUTPUT as FEATURES_JSON_FILE, generateFeatures } from './gen-features-json.mjs';
import { tmpDir } from './lib/rv-machine-paths.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PRIVATE_ROOT = resolve(ROOT, '..', 'realvirtual-WebViewer-Private~');
const require = createRequire(import.meta.url);

//! Maps one source-map source path to a group key. Understands both the checkout names
//! (`realvirtual-WebViewer~`, `realvirtual-WebViewer-Private~`) and the staged names
//! (`realvirtual-web`, `realvirtual-web-pro`).
export function groupSource(source) {
  const s = String(source).replace(/\\/g, '/');
  let m = s.match(/node_modules\/((@[^/]+\/)?[^/]+)/);
  if (m) return `npm:${m[1]}`;
  m = s.match(/(?:realvirtual-WebViewer-Private~|realvirtual-web-pro)\/src\/(.*)/);
  if (m) { const p = m[1].split('/'); return `private:${p.slice(0, Math.min(p.length - 1, 2)).join('/')}`; }
  m = s.match(/(?:realvirtual-WebViewer~|realvirtual-web)\/src\/(.*)/);
  if (m) { const p = m[1].split('/'); return `src:${p.slice(0, Math.min(p.length - 1, 2)).join('/')}`; }
  return `other:${s.slice(-60)}`;
}

//! The plan-652 feature buckets. A source can count in several (e.g. a private stub).
export const FEATURE_BUCKETS = {
  'asset-editor (private plugins/asset-editor/**)': /(?:realvirtual-WebViewer-Private~|realvirtual-web-pro)\/src\/plugins\/asset-editor\/(?!shared\/)/,
  // plan-652 Phase 4: the leaf stores startup code imports on purpose (section 2.4.5).
  'asset-editor/shared (editor leaf stores, startup)': /(?:realvirtual-WebViewer-Private~|realvirtual-web-pro)\/src\/plugins\/asset-editor\/shared\//,
  // plan-652 Phase 0: six inline PNGs (~260 KB) whose only importer is the editor's
  // material-presets.ts - they belong to the editor body and must leave with it.
  'roller-textures (editor material presets, inline PNG)': /(?:realvirtual-WebViewer-Private~|realvirtual-web-pro)\/src\/assets\/roller-textures\//,
  // plan-680: feature bodies live in BOTH trees now (des.body is core).
  'features/*.body (on-demand feature bodies)': /(?:realvirtual-WebViewer-Private~|realvirtual-web-pro|realvirtual-WebViewer~|realvirtual-web)\/src\/features\/[^/]+\.body\./,
  // plan-680: DES is core code. The BODY is everything under plugins/des/ except the
  // workspace shell and eager command metadata; implementations must remain lazy.
  // A private copy (repo skew) counts too.
  'des body (plugins/des/** without the workspace shell)': /(?:realvirtual-WebViewer-Private~|realvirtual-web-pro|realvirtual-WebViewer~|realvirtual-web)\/src\/plugins\/des\/(?!(?:des-workspace-plugin\.tsx|experiment-commands\.ts)$)/,
  'register-des-runner': /(?:realvirtual-WebViewer-Private~|realvirtual-web-pro|realvirtual-WebViewer~|realvirtual-web)\/src\/plugins\/des\/register-des-runner/,
  'features/*.register (private adapters)': /(?:realvirtual-WebViewer-Private~|realvirtual-web-pro)\/src\/features\/[^/]+\.register\./,
  'private-plugins.ts (generated entry)': /(?:realvirtual-WebViewer-Private~|realvirtual-web-pro)\/src\/private-plugins\.ts$/,
  'des workspace shell (core des-workspace-plugin, allowed at boot)': /(?:realvirtual-WebViewer~|realvirtual-web)\/src\/plugins\/des\/des-workspace-plugin\.tsx/,
  'public core/editor/**': /(?:realvirtual-WebViewer~|realvirtual-web)\/src\/core\/editor\//,
  'all private src/**': /(?:realvirtual-WebViewer-Private~|realvirtual-web-pro)\/src\//,
};

//! Attributes the bytes of `code` to the sources of its source map. Returns `{ total, bySource }`.
export function attributeBytes(code, map, SourceMapConsumer) {
  const lineStart = [];
  let acc = 0;
  for (const line of code.split('\n')) { lineStart.push(acc); acc += line.length + 1; }
  const smc = new SourceMapConsumer(map);
  const bySource = {};
  let prev = { off: 0, src: '(unmapped)' };
  smc.eachMapping((m) => {
    const off = lineStart[m.generatedLine - 1] + m.generatedColumn;
    // Each mapping owns the span up to the next mapping, including unmapped spans.
    if (off > prev.off) bySource[prev.src] = (bySource[prev.src] || 0) + (off - prev.off);
    prev = { off, src: m.source ?? '(unmapped)' };
  });
  if (code.length > prev.off) bySource[prev.src] = (bySource[prev.src] || 0) + (code.length - prev.off);
  return { total: code.length, bySource };
}

//! Sums `bySource` into groups and plan-652 buckets.
export function summarize(bySource) {
  const groups = {};
  const buckets = Object.fromEntries(Object.keys(FEATURE_BUCKETS).map((k) => [k, 0]));
  for (const [source, bytes] of Object.entries(bySource)) {
    const key = groupSource(source);
    groups[key] = (groups[key] || 0) + bytes;
    const norm = source.replace(/\\/g, '/');
    for (const [bucket, re] of Object.entries(FEATURE_BUCKETS)) if (re.test(norm)) buckets[bucket] += bytes;
  }
  return { groups, buckets };
}

/** Static (not dynamic) relative imports of a built chunk: `import{..}from"./x.js"`, `import"./x.js"`, `export{..}from"./x.js"`. */
const STATIC_IMPORT = /(?:\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*)["']\.\/([^"']+\.js)["']/g;

//! File names a built chunk imports statically (dynamic `import("./x.js")` excluded).
export function staticImportsOf(code) {
  const out = new Set();
  for (const m of code.matchAll(STATIC_IMPORT)) out.add(m[1]);
  return [...out];
}

//! The BOOT SET (plan-652 Phase 2): every chunk a start fetches and executes - the entry and
//! all `*.register` adapter chunks (the generated entry imports every adapter at boot) plus
//! their static imports. An on-demand body reached only via `import()` stays outside.
export function bootSet(entryFile, registerFiles, importsOf) {
  const seen = new Set();
  const stack = [entryFile, ...registerFiles];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of importsOf(f)) stack.push(dep);
  }
  return seen;
}

function parseArgs(argv) {
  const args = { keep: false, top: 40, json: null, out: null, publicOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') args.keep = true;
    else if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--json') args.json = resolve(argv[++i]);
    else if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--public-only') args.publicOnly = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function linkNodeModules(target, linkPath) {
  if (!existsSync(target) || existsSync(linkPath)) return false;
  symlinkSync(target, linkPath, 'junction');
  return true;
}

function kb(bytes) { return `${(bytes / 1024).toFixed(0).padStart(6)} KB`; }

//! Runs the staged demo build and returns the report (also used by test-bundle-guard.mjs).
export function analyzeDemoEntry(args = { keep: false, top: 40, json: null, out: null, publicOnly: false }) {
  const publicOnly = !!args.publicOnly;
  if (!publicOnly && !existsSync(join(PRIVATE_ROOT, 'tier-manifest.json'))) {
    throw new Error(`analyze-demo-entry needs the private sibling next to this tree: ${PRIVATE_ROOT}`);
  }
  const work = args.out ?? join(tmpDir(), `rv-652-demo-entry-${Date.now()}`);
  const stageRoot = join(work, 'stage');
  const outDir = join(work, 'dist');
  mkdirSync(work, { recursive: true });
  const junctions = [];
  try {
    // 1. generated/features.json, exactly what `deployPublic` regenerates before a --demo staging.
    // A public-only build has no manifest to generate from (and no features.json, like a
    // community clone) — skipped there.
    if (!publicOnly) {
      const features = generateFeatures();
      if (!features.available) throw new Error(`features.json: ${features.manifestPath} not found`);
      mkdirSync(dirname(FEATURES_JSON_FILE), { recursive: true });
      writeFileSync(FEATURES_JSON_FILE, features.json);
    }

    // 2. The demo staging (same options as bunny-deploy's stageAndBuild for mode 'demo').
    const t0 = Date.now();
    stageFilteredSourceTree({
      coreRoot: ROOT,
      // plan-680 --public-only: a private root that does not exist stages the core alone.
      privateRoot: publicOnly ? join(work, 'no-private-sibling') : PRIVATE_ROOT,
      projectKey: null,
      delivery: null,
      profile: publicOnly ? { tier: 'core', restrictedFeatures: [] } : DEMO_PROFILE,
      includePublicDemoContent: true,
      // A community clone has no generated/features.json (no manifest) — do not carry over
      // one a previous demo run left behind.
      includeGeneratedFiles: !publicOnly,
      workspaceFiles: false,
      destinationRoot: stageRoot,
    });
    const coreStage = join(stageRoot, 'realvirtual-web');
    const proStage = join(stageRoot, 'realvirtual-web-pro');
    console.log(`[analyze] staged in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${stageRoot}`);
    const generatedEntry = join(proStage, 'src', 'private-plugins.ts');
    const generatedText = existsSync(generatedEntry) ? readFileSync(generatedEntry, 'utf8') : '';
    const staticAdapterImports = (generatedText.match(/^import \{ register as /gm) ?? []).length;
    const dynamicAdapterImports = (generatedText.match(/import\(['"][^'"]+\.register['"]\)/g) ?? []).length;
    console.log(`[analyze] generated private-plugins.ts: ${staticAdapterImports} static adapter imports, ${dynamicAdapterImports} dynamic`);

    // 3. node_modules: junctions into this checkout (read-only use by vite build).
    if (linkNodeModules(join(ROOT, 'node_modules'), join(coreStage, 'node_modules'))) junctions.push(join(coreStage, 'node_modules'));
    if (!publicOnly && existsSync(proStage) && linkNodeModules(join(PRIVATE_ROOT, 'node_modules'), join(proStage, 'node_modules'))) {
      junctions.push(join(proStage, 'node_modules'));
    }

    // 4. vite build with the demo env, plus hidden source maps, into the temp outDir.
    const env = { ...process.env };
    delete env.VITE_PUBLIC_BUILD;
    delete env.VITE_PRIVATE_BUILD;
    delete env.RV_INTERNAL;
    env.RV_SOURCEMAP = '1';
    if (!publicOnly) {
      env.RV_COMMERCIAL = '1';
      env.RV_DEMO_WELCOME = '1';
    } else {
      // A clean community build: nothing commercial inherited from the caller's shell.
      delete env.RV_COMMERCIAL;
      env.RV_DEMO_WELCOME = '0';
    }
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
    const t1 = Date.now();
    const vite = join(coreStage, 'node_modules', 'vite', 'bin', 'vite.js');
    const result = spawnSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: coreStage, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    writeFileSync(join(work, 'vite-build.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    if (result.status !== 0) {
      throw new Error(`vite build failed (exit ${result.status}); log: ${join(work, 'vite-build.log')}\n${(result.stderr ?? '').slice(-2000)}`);
    }
    console.log(`[analyze] vite build ${((Date.now() - t1) / 1000).toFixed(0)} s → ${outDir}`);

    // 5. Entry chunk from index.html; chunk list; composition.
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    const entryRel = html.match(/<script[^>]+type="module"[^>]+src="[^"]*?(assets\/[^"]+\.js)"/)?.[1];
    if (!entryRel) throw new Error('entry chunk not found in index.html');
    const entryPath = join(outDir, entryRel);
    const assets = join(outDir, 'assets');
    const chunks = readdirSync(assets).filter((f) => f.endsWith('.js'))
      .map((f) => ({ file: f, bytes: statSync(join(assets, f)).size }))
      .sort((a, b) => b.bytes - a.bytes);
    // Vite names a chunk after its module: `features/des.register.ts` → `des.register-<hash>.js`.
    const registerChunks = chunks.filter((c) => /\.register-[\w-]+\.js$/.test(c.file));
    const { SourceMapConsumer } = require(join(ROOT, 'node_modules', 'source-map-js'));
    const code = readFileSync(entryPath, 'utf8');
    const map = JSON.parse(readFileSync(`${entryPath}.map`, 'utf8'));
    const { total, bySource } = attributeBytes(code, map, SourceMapConsumer);
    // `total` is `code.length`, i.e. UTF-16 CODE UNITS — right for attribution shares,
    // wrong for a size budget: the minified bundle carries enough non-ASCII that the two
    // differ by ~3 kB (the same trap `entryByteLength()` in bundle-splitting.test.ts was
    // written for). The budget in test-bundle-guard.mjs is named in BYTES, so report both,
    // measured on two independent paths: what the filesystem says, and what the decoded
    // text weighs when re-encoded. The guard compares them and refuses when they disagree.
    const entryFileBytes = statSync(entryPath).size;
    const entryEncodedBytes = Buffer.byteLength(code, 'utf8');
    const { groups, buckets } = summarize(bySource);

    console.log(`\nENTRY ${relative(work, entryPath)}  ${kb(total)} raw (${(total / 1e6).toFixed(2)} MB)`);
    console.log(`[analyze] entry bytes: ${entryFileBytes} on disk, ${entryEncodedBytes} re-encoded, ${total} UTF-16 code units`);
    console.log(`JS chunks: ${chunks.length}, *.register chunks: ${registerChunks.length}`);
    console.log('\n--- largest JS chunks ---');
    for (const c of chunks.slice(0, 15)) console.log(kb(c.bytes), c.file);
    console.log('\n--- plan-652 buckets (entry) ---');
    for (const [k, b] of Object.entries(buckets)) console.log(kb(b), ((100 * b) / total).toFixed(1).padStart(5) + '%', k);
    console.log('\n--- entry by group ---');
    for (const [k, b] of Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, args.top)) {
      console.log(kb(b), ((100 * b) / total).toFixed(1).padStart(5) + '%', k);
    }
    console.log('\n--- top single files (entry) ---');
    for (const [s, b] of Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      console.log(kb(b), s.replace(/\\/g, '/').replace(/^.*?(node_modules|realvirtual-web-pro\/src|realvirtual-web\/src)\//, '$1/'));
    }
    // plan-652 Phase 2: the boot set - what a start actually executes, entry or not.
    const codeOf = (f) => readFileSync(join(assets, f), 'utf8');
    const entryFile = entryRel.replace(/^assets\//, '');
    const boot = bootSet(entryFile, registerChunks.map((c) => c.file), (f) => (existsSync(join(assets, f)) ? staticImportsOf(codeOf(f)) : []));
    const bootBySource = {};
    let bootBytes = 0;
    for (const f of boot) {
      const p = join(assets, f);
      if (!existsSync(p)) continue;
      const c = codeOf(f);
      bootBytes += c.length;
      if (!existsSync(`${p}.map`)) continue;
      const attributed = attributeBytes(c, JSON.parse(readFileSync(`${p}.map`, 'utf8')), SourceMapConsumer);
      for (const [s, b] of Object.entries(attributed.bySource)) bootBySource[s] = (bootBySource[s] || 0) + b;
    }
    const bootBuckets = summarize(bootBySource).buckets;
    console.log(`\n--- plan-652 buckets (boot set: ${boot.size} chunks, ${kb(bootBytes).trim()}) ---`);
    for (const [k, b] of Object.entries(bootBuckets)) console.log(kb(b), k);

    // plan-652 Phase 1: the build table the FeatureLoader and the bundle guard read.
    const featureChunksPath = join(outDir, 'feature-chunks.json');
    const featureChunks = existsSync(featureChunksPath) ? JSON.parse(readFileSync(featureChunksPath, 'utf8')) : null;
    console.log(`\n[analyze] feature-chunks.json: ${featureChunks ? `${Object.keys(featureChunks).length} features` : 'MISSING'}`);
    const report = {
      date: new Date().toISOString(), publicOnly, entry: entryRel, entryBytes: total, entryFileBytes, entryEncodedBytes, featureChunks,
      chunkCount: chunks.length, registerChunks: registerChunks.map((c) => c.file),
      generatedEntry: { staticAdapterImports, dynamicAdapterImports },
      buckets, groups, chunks: chunks.slice(0, 40),
      boot: { chunks: boot.size, bytes: bootBytes, buckets: bootBuckets },
    };
    if (args.json) { writeFileSync(args.json, JSON.stringify(report, null, 2)); console.log(`\n[analyze] json → ${args.json}`); }
    if (args.keep) console.log(`[analyze] kept: ${work}  (preview: npx vite preview --outDir "${outDir}" from ${coreStage})`);
    return report;
  } finally {
    // Junctions are unlinked first so the recursive removal can never follow them.
    for (const j of junctions) { try { unlinkSync(j); } catch { /* already gone */ } }
    if (!args.keep) {
      // A kept tree loses its node_modules links, so re-create them on --keep instead.
      try { rmSync(work, { recursive: true, force: true }); } catch (error) { console.warn(`[analyze] cleanup failed: ${error.message}`); }
    } else {
      linkNodeModules(join(ROOT, 'node_modules'), join(stageRoot, 'realvirtual-web', 'node_modules'));
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    analyzeDemoEntry(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[analyze] ${error?.message ?? error}`);
    process.exit(1);
  }
}
