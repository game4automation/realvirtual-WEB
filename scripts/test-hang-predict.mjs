// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Hang predictor (plan-900 § 2.4, requirement A9) — names the test files that will hang BEFORE
 * their first test, from the rule plan-900 phase 3 established and proved:
 *
 *   `vi.mock(M, factory)` where the factory asks for the ORIGINAL module
 *   (`importOriginal` / `importActual`) AND M lies inside a static import CYCLE
 *   → the file hangs in its import, with no test result and no `module-start`.
 *
 * Mechanism, for anyone who has to judge a hit: vitest's `ManualMockedModule.resolve()` has no
 * in-flight memo, so the factory's request for the original re-enters the module graph while the
 * cycle is still being resolved and waits for itself. A plain stub factory (no original) breaks
 * the cycle and does not hang — the mock FORM is half of the rule, the cycle the other half.
 *
 * WHAT A HIT IS WORTH. The rule is a NECESSARY condition for this hang, not a sufficient one:
 * it fires while a cycle closes through the mocked module. Measured on this tree 2026-10-27,
 * after plan-900 phase 4 removed the cycle edge: browser suite 2041 test files, 3931 modules,
 * 22 modules on a cycle, 0 hits — which matches reality, the suite runs through. Recall is
 * measured separately in `tests/test-hang-predict.node.test.ts` by bending that edge back IN
 * MEMORY: all five known hangers are named again, 5 of 5. So a hit means "this file dies if a
 * cycle through its mocked module ever closes", and it is the first suspect when a file DOES hang
 * before its first test.
 *
 * One thing that decides whether the numbers above are 22 or 499: TYPE-ONLY imports are erased
 * before the module runs and cannot close a runtime cycle. Counting them (a regex does) turned
 * 22 cyclic modules into 499 and produced 27 hits, none of which hangs. Hence the TypeScript
 * parser in `staticImports`, the same rule the existing guard
 * `tests/mock-import-cycles.node.test.ts` follows — which is also the reason that guard is green
 * on this tree while a regex-based scan would have screamed.
 *
 *   node scripts/test-hang-predict.mjs                      # the node suite
 *   node scripts/test-hang-predict.mjs --suite browser      # the browser suite
 *   node scripts/test-hang-predict.mjs --suite all --json
 *   node scripts/test-hang-predict.mjs --config my.config.ts --files tests/a.test.ts
 *
 * ONE tool with a suite PARAMETER, deliberately: the throwaway version had its file glob and its
 * aliases written into the code, and an inverted glob then reported `PREDICTED HANGS (0)` over a
 * list of ZERO files — a clean bill of health from a broken selection. Therefore, and this is
 * requirement A9: the file list comes from `vitest list --filesOnly` of the given config, the
 * aliases come from that same config through vite's own loader, and EVERY output states how many
 * test files and how many modules were scanned. A run that scanned 0 files exits non-zero.
 *
 * NOT THE SAME RULE AS `tests/mock-import-cycles.node.test.ts`, in BOTH directions — do not read a
 * green guard as "the predictor would say nothing" or the reverse (plan-900, 2026-10-27):
 *   - the GUARD resolves a `./x.js` specifier to `x.ts` before looking it up; this predictor does
 *     not (its `resolveModule` probes extensions, but an explicit `.js` that exists only as `.ts`
 *     stays unresolved). A cycle that closes only through such a specifier is seen by the guard
 *     and MISSED here.
 *   - the guard counts any `async` factory with a non-empty PARAMETER list as asking for the original; this
 *     predictor requires an actual CALL of that parameter (`originalMocks`). A factory that takes
 *     `importOriginal` and never uses it is flagged by the guard and MISSED here; conversely the
 *     predictor catches the `vi.importActual(…)`/`importOriginal` spellings used without a
 *     parameter, which a parameter check alone does not.
 * Each one therefore misses cases of the other. Run both.
 *
 * `--json` writes NOTHING but the report to stdout: the configs print at load time (`[rv-build] …`),
 * which once made `JSON.parse` fail on the first line, so `loadAliases` redirects config output to
 * stderr while the config runs.
 *
 * Exit codes: 0 = nothing predicted, 1 = at least one file predicted to hang, 2 = the scan itself
 * was broken (no files, no config, a selected file that cannot be read, or no aliases where the
 * scanned files need them — all three enforced in `main()`).
 */

import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const slash = (value) => String(value).replace(/\\/g, '/');

/** `--suite` → the vitest config that defines that suite's file selection and aliases. */
export const SUITES = {
  node: 'vitest.node.config.ts',
  browser: 'vite.config.ts',
};

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const INDEXES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];

/**
 * Static RUNTIME `import`/`export … from` specifiers of one source text — parsed, not matched.
 *
 * Type-only imports (`import type …`, `export type … from`) are excluded, and that is not a
 * nicety: they are erased before the module ever runs, so they cannot close a runtime cycle. A
 * regex that counts them inflates the graph badly — on this tree it turned 0 real cycles into 499
 * "cyclic" modules and 27 predicted hangs, none of which hangs. Same rule as the existing guard
 * `tests/mock-import-cycles.node.test.ts`.
 */
export function staticImports(text, file = 'module.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const out = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const typeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly : statement.isTypeOnly;
    if (typeOnly) continue;
    const spec = statement.moduleSpecifier;
    if (spec && ts.isStringLiteral(spec)) out.push(spec.text);
  }
  return [...new Set(out)];
}

/** The text of a call that starts at `open` (the index of its `(`), parentheses balanced. */
function callBody(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    } else if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    }
  }
  return text.slice(open + 1);
}

/**
 * `vi.mock(<specifier>, <factory>)` calls whose factory asks for the ORIGINAL module — the half
 * of the rule that lives in the test file. A pure stub factory does NOT count, and neither does a
 * `vi.mock` without a factory: both break the cycle instead of closing it, which is why 49 files
 * use this hook and only five hang.
 *
 * The parameter's NAME is not fixed, and that matters: vitest documents `importOriginal`, but our
 * tree also writes `async (original) => { const actual = await original<…>(); … }`. A check for
 * the documented spelling alone misses those — it missed `editor-save-shortcut.test.ts`, one of
 * the five known hangers, which is exactly the kind of false all-clear A9 exists to prevent. So
 * the factory's first parameter is read out and a CALL of that parameter counts, whatever it is
 * called.
 */
export function originalMocks(text) {
  const out = [];
  const re = /vi\.mock\(/g;
  for (const match of text.matchAll(re)) {
    const open = match.index + match[0].length - 1;
    const body = callBody(text, open);
    const spec = body.match(/^\s*['"]([^'"]+)['"]\s*,/);
    if (!spec) continue;
    const factory = body.slice(spec[0].length);
    const param = factory.match(/^\s*(?:async\s+)?(?:\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*=>/);
    const name = param?.[1] ?? param?.[2];
    const callsParam = name ? new RegExp(`\\b${name}\\s*[(<]`).test(factory.slice(param[0].length)) : false;
    if (callsParam || /\bimportOriginal\b|\bimportActual\b|vi\.importActual/.test(factory)) out.push(spec[1]);
  }
  return [...new Set(out)];
}

/** The alias list of a vite/vitest config, as `{ find, replacement }` rows (via vite's own loader). */
export async function loadAliases(configFile, { root = repoRoot } = {}) {
  const vite = await import('vite');
  // The config RUNS while it is loaded, and ours prints at module scope (`vite.config.ts` writes
  // `[rv-build] Private build …`). On stdout that banner lands IN FRONT of the `--json` report and
  // makes it unparsable — measured: `JSON.parse` died on `Unexpected token 'r'`, although the
  // header of this script documents `--json` as machine-readable. For the duration of the load
  // every stdout write is therefore redirected to stderr: the banner stays VISIBLE (it is useful —
  // it says which build the aliases come from), it just no longer pollutes the data channel.
  const stdoutWrite = process.stdout.write;
  process.stdout.write = (...args) => process.stderr.write(...args);
  let loaded;
  try {
    loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'test' }, configFile, root);
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const alias = loaded?.config?.resolve?.alias ?? [];
  if (Array.isArray(alias)) return alias.map((row) => ({ find: row.find, replacement: row.replacement }));
  return Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
}

/** `specifier` with the first matching alias applied (longest `find` first, as vite does). */
export function applyAliases(specifier, aliases) {
  const rows = [...aliases].sort((a, b) => String(b.find).length - String(a.find).length);
  for (const { find, replacement } of rows) {
    if (find instanceof RegExp) {
      if (find.test(specifier)) return specifier.replace(find, String(replacement));
    } else if (specifier === find || specifier.startsWith(`${find}/`)) {
      return `${replacement}${specifier.slice(String(find).length)}`;
    }
  }
  return specifier;
}

/** A specifier → an absolute file inside the repo, or null (a package, a style, unresolvable). */
export function resolveModule(specifier, fromFile, aliases, { root = repoRoot } = {}) {
  if (/^(node:|https?:)/.test(specifier)) return null;
  const aliased = applyAliases(specifier, aliases);
  const isPath = aliased.startsWith('.') || path.isAbsolute(aliased) || /^[A-Za-z]:[\\/]/.test(aliased);
  if (!isPath) return null; // a package from node_modules — never part of our own cycle
  const base = aliased.startsWith('.') ? path.resolve(path.dirname(fromFile), aliased) : path.resolve(root, aliased);
  const bare = base.replace(/\?.*$/, '');
  for (const ext of EXTENSIONS) {
    const candidate = `${bare}${ext}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const index of INDEXES) {
    const candidate = path.join(bare, index);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * True for a specifier that resolved to NOTHING and is not a real package in `node_modules` —
 * i.e. the footprint an UNAPPLIED ALIAS leaves (plan-900 F3).
 *
 * `resolveModule` returns null for anything that is not a path after aliasing, on the assumption
 * that it is a package. That assumption is what makes an empty alias list invisible: with
 * `resolve.alias` gone, `@rv/foo` is simply "a package", the edge is dropped, the graph shrinks to
 * the test files themselves, and the output reads `0 modules on a cycle, 0 hits`, exit 0 — the
 * reassuring all-clear from an empty input that A9 exists to prevent. A specifier that is neither a
 * path nor an installed package is therefore COUNTED here, and `main()` refuses the run.
 */
export function unknownSpecifier(specifier, { root = repoRoot } = {}) {
  if (/^(node:|https?:)/.test(specifier)) return false;
  // A relative or absolute path that does not exist is a different defect (a stale import); this
  // check is only about specifiers an alias was supposed to rewrite.
  if (specifier.startsWith('.') || path.isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier)) return false;
  if (/\.(css|scss|svg|png|jpe?g|glb|json)$/i.test(specifier)) return false;
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  return !existsSync(path.join(root, 'node_modules', name));
}

/**
 * The static import graph reachable from `entries` → `{ edges, read }`. Walking from the test
 * files rather than from a hardcoded `src/` root is deliberate: the scan then covers exactly what
 * the suite imports, including the private repo, without a path written into this file.
 */
export function buildGraph(entries, aliases, { root = repoRoot, extraEdges = [] } = {}) {
  const edges = new Map();
  const queue = [...entries];
  const read = new Set(entries);
  const unreadable = [];
  const unresolved = new Set(); // F3: specifiers an alias should have rewritten, but nothing did
  // `extraEdges` ([from, to] absolute paths) adds import edges that are NOT in the source. It
  // exists for one purpose: bending a removed cycle edge back IN MEMORY, so the rule's recall can
  // be measured against a tree that no longer has the cycle — without editing a repo file.
  const added = new Map();
  for (const [from, to] of extraEdges) {
    if (!added.has(from)) added.set(from, []);
    added.get(from).push(to);
    for (const file of [from, to]) if (!read.has(file)) { read.add(file); queue.push(file); }
  }
  while (queue.length) {
    const file = queue.pop();
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { unreadable.push(file); continue; }
    const targets = [];
    for (const specifier of staticImports(text, file)) {
      const resolved = resolveModule(specifier, file, aliases, { root });
      if (!resolved) {
        if (unknownSpecifier(specifier, { root })) unresolved.add(specifier);
        continue;
      }
      if (/\.(css|scss|svg|png|jpe?g|glb|json)$/i.test(resolved)) continue;
      targets.push(resolved);
      if (!read.has(resolved)) { read.add(resolved); queue.push(resolved); }
    }
    edges.set(file, [...new Set([...targets, ...(added.get(file) ?? [])])]);
  }
  return { edges, read, unreadable, unresolved: [...unresolved] };
}

/** Every module that lies on a cycle (Tarjan: an SCC of more than one node, or a self-loop). */
export function modulesInCycles(edges) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cyclic = new Set();
  let counter = 0;
  for (const start of edges.keys()) {
    if (index.has(start)) continue;
    // Iterative Tarjan: the graph is thousands of modules deep in places.
    const work = [{ node: start, next: 0 }];
    index.set(start, counter); low.set(start, counter++); stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const neighbours = edges.get(frame.node) ?? [];
      if (frame.next < neighbours.length) {
        const target = neighbours[frame.next++];
        if (target === frame.node) cyclic.add(target); // self-loop
        if (!index.has(target)) {
          index.set(target, counter); low.set(target, counter++); stack.push(target); onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(target)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        for (;;) {
          const node = stack.pop();
          onStack.delete(node);
          component.push(node);
          if (node === frame.node) break;
        }
        if (component.length > 1) for (const node of component) cyclic.add(node);
      }
    }
  }
  return cyclic;
}

/** The predictor itself: `{ scanned, modules, cyclicModules, hits }` for the given test files. */
export function predict(testFiles, aliases, { root = repoRoot, extraEdges = [] } = {}) {
  const { edges, read, unreadable, unresolved } = buildGraph(testFiles, aliases, { root, extraEdges });
  const cyclic = modulesInCycles(edges);
  const hits = [];
  for (const file of testFiles) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const mocked = [];
    for (const specifier of originalMocks(text)) {
      const resolved = resolveModule(specifier, file, aliases, { root });
      if (resolved && cyclic.has(resolved)) mocked.push({ specifier, module: slash(path.relative(root, resolved)) });
    }
    if (mocked.length) hits.push({ file: slash(path.relative(root, file)), mocked });
  }
  return { scanned: testFiles.length, modules: read.size, cyclicModules: cyclic.size, unreadable: unreadable.map((file) => slash(path.relative(root, file))), unresolved, hits };
}

/** `vitest list --filesOnly` for one config → absolute test file paths. */
export function listFiles(config, { root = repoRoot } = {}) {
  const args = [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'list', '--filesOnly', '--config', config];
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`vitest list failed for ${config} (${run.status}): ${String(run.stderr).trim().split('\n').slice(-5).join('\n')}`);
  // `list` prefixes every line with its project (`[chromium] tests/a.test.ts`). Leaving that in
  // produces paths nothing can read — and a graph of 0 edges, which looks like "no cycles" and
  // therefore like "no hangs". That is the A9 failure mode, so it is stripped here and any file
  // that still cannot be read is a hard error below.
  return String(run.stdout).split(/\r?\n/)
    .map((line) => line.trim().replace(/^\[[^\]]+\]\s+/, ''))
    .filter((line) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(line))
    .map((line) => path.resolve(root, line));
}

export function parseArgv(argv) {
  const options = { suite: 'node', json: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--suite') options.suite = value();
    else if (flag === '--config') options.config = value();
    else if (flag === '--files') { options.filesGiven = true; options.files.push(...value().split(',').map((f) => f.trim()).filter(Boolean)); }
    else if (flag === '--json') options.json = true;
    else throw new Error(`unknown option ${argv[i]}`);
  }
  if (options.filesGiven && !options.files.length) {
    // An empty --files is a broken selection, not "scan everything": falling back to the full
    // suite here would answer a question nobody asked (A9).
    throw new Error('--files was given but contains no file');
  }
  if (!options.config && options.suite !== 'all' && !SUITES[options.suite]) {
    throw new Error(`unknown suite ${options.suite} (known: ${Object.keys(SUITES).join(', ')}, all)`);
  }
  return options;
}

async function main(argv) {
  const options = parseArgv(argv);
  const configs = options.config ? [options.config]
    : options.suite === 'all' ? Object.values(SUITES) : [SUITES[options.suite]];
  const report = { suites: [], scanned: 0, modules: 0, cyclicModules: 0, hits: [] };
  for (const config of configs) {
    const configFile = path.resolve(repoRoot, config);
    if (!existsSync(configFile)) throw new Error(`config not found: ${configFile}`);
    const aliases = await loadAliases(configFile);
    const files = options.files.length
      ? options.files.map((file) => path.resolve(repoRoot, file))
      : listFiles(configFile);
    const result = predict(files, aliases);
    report.suites.push({ config, aliases: aliases.length, ...result, hits: result.hits.map((hit) => hit.file) });
    report.scanned += result.scanned;
    report.modules += result.modules;
    report.cyclicModules += result.cyclicModules;
    report.hits.push(...result.hits.map((hit) => ({ config, ...hit })));
  }
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const suite of report.suites) {
      // A9: the scan count is MANDATORY. "PREDICTED HANGS (0)" over 0 files is not a result.
      process.stdout.write(`${suite.config}: scanned ${suite.scanned} test files, ${suite.modules} modules, ${suite.aliases} aliases, ${suite.cyclicModules} modules on a cycle\n`);
    }
    process.stdout.write(`\nWATCHLIST — files matching the hang rule (${report.hits.length}) out of ${report.scanned} scanned test files\n`);
    if (report.hits.length) {
      process.stdout.write('  a hit is a NECESSARY condition, not a sufficient one: such a file hangs only while the cycle closes through its mocked module — see the header of this script\n');
    }
    for (const hit of report.hits) {
      process.stdout.write(`  ${hit.file}\n`);
      for (const mock of hit.mocked) process.stdout.write(`      vi.mock('${mock.specifier}') with the original → ${mock.module} (on a cycle)\n`);
    }
  }
  if (!report.scanned) {
    process.stderr.write('[test-hang-predict] 0 test files scanned — the file selection is broken, this is NOT a clean bill of health\n');
    return 2;
  }
  // A selected file that cannot be READ means the selection is wrong (a project prefix left in,
  // a stale path). Its imports stay invisible, it looks cycle-free, and the run reports a clean
  // bill of health it never earned — the exact A9 failure.
  const unreadable = report.suites.flatMap((suite) => suite.unreadable ?? []);
  if (unreadable.length) {
    process.stderr.write(`[test-hang-predict] ${unreadable.length} of ${report.scanned} selected files could not be read — the selection is broken: ${unreadable.slice(0, 5).join(', ')}\n`);
    return 2;
  }
  // F3: "no aliases where aliases are needed" — the third broken-scan case the header has always
  // promised and nothing used to check. `resolve.alias` loading empty (a config rebuild, a plugin
  // moved) silently turns every `@rv/…` edge into "a package", the graph collapses to the test
  // files, and the run reports `0 modules on a cycle, 0 hits` with exit 0. Needed is MEASURED, not
  // assumed: a config whose alias list is empty is only refused when the scanned files actually
  // import something that neither resolves to a file nor exists in node_modules.
  for (const suite of report.suites) {
    if (suite.aliases > 0 || !(suite.unresolved?.length > 0)) continue;
    process.stderr.write(`[test-hang-predict] ${suite.config}: 0 aliases loaded, but ${suite.unresolved.length} import specifier(s) resolve to nothing and are not installed packages (${suite.unresolved.slice(0, 5).join(', ')}) — the alias list did not load, so the import graph is incomplete; this is NOT a clean bill of health\n`);
    return 2;
  }
  return report.hits.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[test-hang-predict] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
