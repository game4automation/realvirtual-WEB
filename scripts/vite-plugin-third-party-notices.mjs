// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * vite-plugin-third-party-notices.mjs — emits THIRD-PARTY-NOTICES.txt + third-party-notices.json
 * into every WEB build (plan-544 F5).
 *
 * Worker builds are SEPARATE Rollup passes that do not inherit the main `plugins`, so a factory
 * returns two plugin flavours that share ONE collector:
 *
 *   const notices = createThirdPartyNotices({ ... });
 *   plugins:        [ ..., notices.plugin() ]
 *   worker.plugins: () => [ ..., notices.workerPlugin() ]
 *
 * Every instance records `Object.keys(chunk.modules)` and the emitted asset names in its
 * `generateBundle`. Worker passes run while the main build transforms (`new Worker(new URL(...))`),
 * i.e. before the main `generateBundle`, which therefore sees every worker record, maps module
 * ids to npm packages, adds the manual components whose `match` globs matched, applies the
 * licence policies and emits both files.
 *
 * Mode (F11): `enforce` → violations fail the build (`this.error`, all listed at once);
 * `warn` → `this.warn` and a "Policy violations" section at the top of the file. Internal errors
 * (unreadable file, broken JSON) degrade to warnings in `warn` mode and mark the notices
 * incomplete. Serve mode never errors: the dev server answers `<base>THIRD-PARTY-NOTICES.txt`
 * with a "development preview" generated from the lockfile.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { walkRelativeFiles } from './lib/rv-fs.mjs';
import {
  NOTICES_JSON,
  NOTICES_TXT,
  anyGlobMatches,
  applyPolicy,
  compareCodePoint,
  componentFromManual,
  componentFromPackageDir,
  DEFAULT_LICENSE_TEXTS_DIR,
  NOTICE_DELIVERY_TIERS,
  loadManualComponents,
  loadPolicy,
  renderJson,
  renderNotices,
  resolveNoticesMode,
} from './lib/rv-third-party-notices.mjs';

const PRODUCT = 'realvirtual WEB';

/** Strips the virtual-id prefix and the query; returns null for virtual modules. */
export function cleanModuleId(id) {
  if (!id || id.startsWith('\0') || id.startsWith('virtual:')) return null;
  const query = id.indexOf('?');
  const path = query >= 0 ? id.slice(0, query) : id;
  if (!path || !(isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path))) return null;
  return path;
}

/** True for `?url`-style imports: the module is a URL to a separate asset, not bundled code. */
export function isUrlImport(id) {
  const query = id.indexOf('?');
  if (query < 0) return false;
  return /(^|&)url(&|=|$)/.test(id.slice(query + 1));
}

/**
 * Resolves a module path to the root of the npm package that contains it: realpath (the config
 * runs with `preserveSymlinks`), the LAST `node_modules/` segment, then the nearest package.json
 * with a `name` walking up — a sub-folder package.json without a name (`three/examples/...`) is
 * skipped. Paths outside any node_modules are first-party and yield null.
 */
export function createPackageRootResolver() {
  const cache = new Map();
  const byInputDir = new Map();
  return function packageRootOf(modulePath) {
    // One realpath per input DIRECTORY, not per module: a build has thousands of ids in a few
    // hundred folders, and realpath is the expensive part.
    const inputDir = dirname(modulePath);
    if (byInputDir.has(inputDir)) return byInputDir.get(inputDir);
    const root = resolveRoot(modulePath);
    byInputDir.set(inputDir, root);
    return root;
  };
  function resolveRoot(modulePath) {
    let real = modulePath;
    try { real = realpathSync.native(modulePath); } catch { /* keep the given spelling */ }
    const posix = real.replace(/\\/g, '/');
    const marker = posix.lastIndexOf('/node_modules/');
    if (marker < 0) return null;
    const boundary = posix.slice(0, marker + '/node_modules'.length);
    let dir = dirname(posix);
    const visited = [];
    while (dir.length > boundary.length) {
      if (cache.has(dir)) {
        const hit = cache.get(dir);
        for (const v of visited) cache.set(v, hit);
        return hit;
      }
      visited.push(dir);
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        try {
          const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
          if (pkg && typeof pkg.name === 'string' && pkg.name) {
            for (const v of visited) cache.set(v, dir);
            return dir;
          }
        } catch { /* unreadable manifest: keep walking */ }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const v of visited) cache.set(v, null);
    return null;
  }
}

//! Every file below `root`, without cap and without skip — ON PURPOSE (plan-587 F5).
//!
//! The traversal is the shared `walkRelativeFiles`, but NEITHER `maxDepth` nor `skipDirs` is
//! passed, and that is the whole point of the shared helper having no defaults: the directory
//! walked here is the shipped `publicDir`, every file in it is DELIVERED, and the manual
//! component list is matched against exactly that set. A `node_modules` skip or a depth cap
//! would silently drop a shipped third-party component out of THIRD-PARTY-NOTICES.txt — a
//! licence problem, not a tidiness one. The CONNECT generator filters; this one must not.
const walkFiles = (root) => walkRelativeFiles(root);

/**
 * @param {{
 *   rootDir: string,                         // project root (package-lock.json, node_modules)
 *   policies: Array<{ path: string, scope: 'public'|'private'|'customer', optional?: boolean }>,
 *   manualComponents?: string,               // third-party/manual-components.json
 *   licenseTextsDir?: string,
 *   tier?: 'public'|'demo'|'private'|'core'|'commercial'|'restricted'|'internal',
 *   mode?: 'warn'|'enforce',               // explicit mode (tests); otherwise resolveNoticesMode
 *   releaseBuild?: boolean,                  // our own staged/embed build
 *   env?: Record<string,string|undefined>,
 *   product?: string,
 *   firstPartyNames?: string[],              // package names that are never third-party
 *   declaredManifests?: string[],            // package.json files whose dependencies are "declared"
 * }} options
 */
export function createThirdPartyNotices(options) {
  const rootDir = resolve(options.rootDir);
  const licenseTextsDir = options.licenseTextsDir ?? DEFAULT_LICENSE_TEXTS_DIR;
  const product = options.product ?? PRODUCT;
  const tier = options.tier ?? 'public';
  const env = options.env ?? process.env;
  const collector = { modules: new Set(), urlModules: new Set(), assets: new Set() };
  let resolvedConfig = null;
  // Our own packages are first-party even when a staged copy lives below a node_modules folder
  // (the embed build stages the core tree into node_modules/.cache/rv-embed-filtered-stage).
  const firstPartyNames = new Set(options.firstPartyNames ?? ['realvirtual-web', 'realvirtual-web-private']);
  try {
    const own = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))?.name;
    if (own) firstPartyNames.add(String(own));
  } catch { /* no package.json at the root (tests) */ }

  // ── Read once per collector instance (plan-587 Phase 4) ─────────────────
  //
  // `manual-components.json` was read by `collect()` AND by `declaredNames()`, i.e. twice per
  // build and three times when the dev preview also ran; the licence policies once per
  // `generate()`. Nothing about either changes during a build, so both are memoised on the
  // instance — the collector is already the per-build object (it is what the two plugin
  // flavours share).
  //
  // The FAILURE is memoised too, not just the success: an unreadable list must keep landing in
  // `problems` on every call, exactly as before, or a cached-away error would turn a broken
  // manual list into a silently incomplete notices file. `reads` counts actual file reads and
  // exists so a test can prove the memo (it would be 2 without it).
  const reads = { manualComponents: 0, policies: 0 };
  let manualCache = null;
  let policiesCache = null;

  //! The manual component list, read at most once: `{ entries }` or `{ error }`.
  function manualComponentsOnce() {
    if (!manualCache) {
      reads.manualComponents += 1;
      try { manualCache = { entries: loadManualComponents(options.manualComponents) }; }
      catch (error) { manualCache = { entries: [], error: error.message }; }
    }
    return manualCache;
  }

  function record(bundle) {
    for (const item of Object.values(bundle)) {
      if (item.type === 'chunk') {
        for (const id of Object.keys(item.modules ?? {})) {
          if (isUrlImport(id)) collector.urlModules.add(id);
          else collector.modules.add(id);
        }
      } else if (item.type === 'asset') {
        collector.assets.add(item.fileName);
        for (const name of item.originalFileNames ?? []) collector.assets.add(String(name).replace(/\\/g, '/'));
      }
    }
  }

  function modeInfo() {
    if (options.mode) return { mode: options.mode, source: 'plugin option' };
    return resolveNoticesMode({ env, releaseBuild: options.releaseBuild ?? env.RV_NOTICES_RELEASE_BUILD === '1' });
  }

  /** Collects components from the recorded bundles. Internal errors are pushed to `problems`. */
  function collect(problems) {
    const packageRootOf = createPackageRootResolver();
    const roots = new Map(); // dir -> linking
    const consider = (id, linking) => {
      const path = cleanModuleId(id);
      if (!path) return;
      const root = packageRootOf(path);
      if (!root) return; // first-party (src, private tree, aliases) — skipped by path
      if (roots.get(root) !== 'static') roots.set(root, linking);
    };
    for (const id of collector.modules) consider(id, 'static');
    for (const id of collector.urlModules) consider(id, 'dynamic');
    for (const asset of collector.assets) {
      if (!asset.includes('node_modules/')) continue;
      consider(isAbsolute(asset) ? asset : resolve(resolvedConfig?.root ?? rootDir, asset), 'dynamic');
    }
    const components = [];
    for (const [root, linking] of [...roots.entries()].sort((a, b) => compareCodePoint(a[0], b[0]))) {
      try {
        const component = componentFromPackageDir(root, { licenseTextsDir, linking });
        if (!firstPartyNames.has(component.name)) components.push(component);
      } catch (error) {
        problems.push(`could not read the package at ${root}: ${error.message}`);
      }
    }
    // Manual components: matched against bundle module ids, emitted asset names and the files
    // of the public dir (copied verbatim into dist/ — Rollup never sees them).
    if (options.manualComponents) {
      const cached = manualComponentsOnce();
      const manual = cached.entries;
      if (cached.error) problems.push(`manual component list unreadable: ${cached.error}`);
      const candidates = [];
      for (const id of [...collector.modules, ...collector.urlModules]) {
        const path = cleanModuleId(id);
        if (path) candidates.push(path.replace(/\\/g, '/'));
      }
      candidates.push(...collector.assets);
      const publicDir = resolvedConfig?.publicDir;
      if (publicDir && existsSync(publicDir)) candidates.push(...walkFiles(publicDir).map((rel) => `public/${rel}`));
      for (const entry of manual) {
        if (!Array.isArray(entry.match) || !anyGlobMatches(entry.match, candidates)) continue;
        try {
          components.push(componentFromManual(entry, { baseDir: dirname(options.manualComponents), licenseTextsDir }));
        } catch (error) {
          problems.push(`manual component ${entry.name} unreadable: ${error.message}`);
        }
      }
    }
    return components;
  }

  //! The licence policies, read at most once per instance. Problems are RE-reported into every
  //! caller's list (they are cached alongside the result, not swallowed).
  function loadPolicies(problems) {
    if (!policiesCache) {
      reads.policies += 1;
      const policies = [];
      const failures = [];
      for (const spec of options.policies ?? []) {
        try {
          const policy = loadPolicy(spec.path, { scope: spec.scope, optional: spec.optional });
          if (policy) policies.push(policy);
        } catch (error) {
          failures.push(`licence policy ${spec.path}: ${error.message}`);
        }
      }
      policiesCache = { policies, failures };
    }
    for (const failure of policiesCache.failures) problems.push(failure);
    return policiesCache.policies;
  }

  /**
   * Names the product declares even when this build does not ship them (`applyPolicy` →
   * `declared`): every manual-list entry and every dependency of the root package.json and of the
   * package.json next to each private policy (the private tree's own dependencies).
   */
  function declaredNames() {
    const names = new Set();
    if (options.manualComponents) {
      // Same memoised read as `collect()`; its error is reported there, not here.
      for (const entry of manualComponentsOnce().entries) if (entry?.name) names.add(String(entry.name));
    }
    const manifests = options.declaredManifests ?? [
      join(rootDir, 'package.json'),
      ...(options.policies ?? []).filter((spec) => spec.scope === 'private').map((spec) => join(dirname(dirname(spec.path)), 'package.json')),
    ];
    for (const manifest of manifests) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        for (const field of ['dependencies', 'optionalDependencies']) for (const name of Object.keys(pkg?.[field] ?? {})) names.add(name);
      } catch { /* no such manifest */ }
    }
    return names;
  }

  /** Builds both outputs. Exposed for the dev middleware and tests. */
  function generate({ components, mode, problems, preview = false }) {
    const policies = loadPolicies(problems);
    const { violations, notInTier } = applyPolicy(components, policies, { tier, declared: declaredNames() });
    // plan-679 Phase 3: entries for another tier are information, never a violation.
    for (const entry of notInTier) {
      console.log(`[rv-third-party-notices] not-in-tier: ${entry.name} ${entry.version} (tiers ${entry.tiers.join(', ')}; this build: ${tier})`);
    }
    const txt = renderNotices({ product, components, violations, mode, preview, incomplete: problems });
    const json = renderJson({ product, components, violations, mode, tier, incomplete: problems });
    return { txt, json, violations };
  }

  function devPreview() {
    const problems = [];
    const components = [];
    try {
      const lock = JSON.parse(readFileSync(join(rootDir, 'package-lock.json'), 'utf8'));
      for (const [key, entry] of Object.entries(lock.packages ?? {})) {
        if (!key.startsWith('node_modules/') || entry.dev || entry.devOptional || entry.link) continue;
        const dir = join(rootDir, ...key.split('/'));
        if (!existsSync(join(dir, 'package.json'))) continue;
        try { components.push(componentFromPackageDir(dir, { licenseTextsDir })); } catch { /* skip */ }
      }
    } catch (error) {
      problems.push(`package-lock.json unreadable: ${error.message}`);
    }
    return generate({ components, mode: 'warn', problems, preview: true }).txt;
  }

  const shared = {
    configResolved(config) { resolvedConfig = config; },
  };

  return {
    collector,
    /**
     * How often the two memoised inputs were actually read from disk (plan-587 Phase 4).
     * Observable on purpose: it is the only way a test can tell a working memo from a
     * coincidence, and it costs two integers.
     */
    reads,
    /** Main-build plugin (also serves the dev preview). */
    plugin() {
      return {
        name: 'rv-third-party-notices',
        ...shared,
        configureServer(server) {
          let cached = null;
          server.middlewares.use((req, res, next) => {
            try {
              const base = server.config.base || '/';
              const url = (req.url || '').split('?')[0];
              const wanted = `${base.endsWith('/') ? base : `${base}/`}${NOTICES_TXT}`;
              if (url !== wanted && url !== `/${NOTICES_TXT}`) return next();
              cached ??= devPreview();
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end(cached);
            } catch (error) {
              // The dev server must never fail on this route.
              res.statusCode = 200;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end(`DEVELOPMENT PREVIEW — third-party notices could not be generated: ${error?.message ?? error}\n`);
            }
          });
        },
        generateBundle(_outputOptions, bundle) {
          const started = Date.now();
          record(bundle);
          const { mode } = modeInfo();
          const problems = [];
          let components = [];
          try {
            components = collect(problems);
          } catch (error) {
            problems.push(`collection failed: ${error.message}`);
          }
          if (problems.length && mode === 'enforce') {
            this.error(`[rv-third-party-notices] cannot generate the notices:\n  - ${problems.join('\n  - ')}`);
            return;
          }
          const { txt, json, violations } = generate({ components, mode, problems });
          if (problems.length && mode === 'enforce') {
            this.error(`[rv-third-party-notices] cannot generate the notices:\n  - ${problems.join('\n  - ')}`);
            return;
          }
          if (violations.length) {
            const list = violations.map((v) => `  - [${v.rule}] ${v.message}`).join('\n');
            if (mode === 'enforce') {
              this.error(`[rv-third-party-notices] ${violations.length} licence-policy violation(s) (RV_NOTICES_MODE=warn is the emergency switch):\n${list}`);
              return;
            }
            this.warn(`[rv-third-party-notices] WARN mode — ${violations.length} licence-policy violation(s):\n${list}`);
          }
          for (const problem of problems) this.warn(`[rv-third-party-notices] notices incomplete: ${problem}`);
          this.emitFile({ type: 'asset', fileName: NOTICES_TXT, source: txt });
          this.emitFile({ type: 'asset', fileName: NOTICES_JSON, source: json });
          if (env.RV_NOTICES_DEBUG === '1') writeDebugDump(rootDir, collector);
          console.log(`[rv-third-party-notices] ${tier} tier, ${mode} mode: ${components.length} component record(s), `
            + `${violations.length} violation(s), ${Date.now() - started} ms`);
        },
      };
    },
    /** Worker-pass plugin: records only; the main instance emits. */
    workerPlugin() {
      return {
        name: 'rv-third-party-notices-worker',
        generateBundle(_outputOptions, bundle) { record(bundle); },
      };
    },
    devPreview,
  };
}

/** RV_NOTICES_DEBUG=1: dumps what the collector saw (audit aid) to node_modules/.cache. */
function writeDebugDump(rootDir, collector) {
  try {
    const dir = join(rootDir, 'node_modules', '.cache');
    mkdirSync(dir, { recursive: true });
    const sorted = (set) => [...set].map((v) => v.replace(/\\/g, '/')).sort(compareCodePoint);
    writeFileSync(join(dir, 'rv-third-party-notices-debug.json'), JSON.stringify({
      modules: sorted(collector.modules), urlModules: sorted(collector.urlModules), assets: sorted(collector.assets),
    }, null, 2));
  } catch { /* debug aid only */ }
}

/**
 * Tier of a WEB build from the environment (F12, plan-679 Phase 3), decided in this order:
 *
 * 1. no private tree -> `public` (an inherited `RV_NOTICES_TIER` is ignored: a `core` workspace
 *    without private code is a public build);
 * 2. demo mode (private tree, no `VITE_PRIVATE_BUILD`) -> `demo`;
 * 3. `RV_NOTICES_TIER` set -> that delivery tier (`runBuild` sets it for a customer workspace);
 *    a value outside the delivery tiers is a hard error, never a silent fallback;
 * 4. otherwise -> `private`, the full build.
 */
export function noticesTierFromEnv(hasPrivate, env = process.env) {
  if (!hasPrivate) return 'public';
  if (env.VITE_PRIVATE_BUILD !== '1') return 'demo';
  const delivery = env.RV_NOTICES_TIER;
  if (delivery !== undefined && delivery !== '') {
    if (!NOTICE_DELIVERY_TIERS.includes(delivery)) {
      throw new Error(`RV_NOTICES_TIER="${delivery}" is not a delivery tier (${NOTICE_DELIVERY_TIERS.join(', ')}).`);
    }
    return delivery;
  }
  return 'private';
}

/** Default policy set for a WEB build rooted at `rootDir` (F12). */
export function defaultPolicySpecs(rootDir, privateRoot) {
  const specs = [{ path: join(rootDir, 'third-party', 'license-policy.json'), scope: 'public' }];
  if (privateRoot) specs.push({ path: join(privateRoot, 'third-party', 'license-policy.json'), scope: 'private', optional: true });
  specs.push({ path: join(rootDir, 'third-party', 'license-policy.customer.json'), scope: 'customer', optional: true });
  return specs;
}
