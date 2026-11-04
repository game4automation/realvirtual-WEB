// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
// PWA disabled – always serve fresh content, no service worker caching
// import { VitePWA } from 'vite-plugin-pwa';
import { playwright } from '@vitest/browser-playwright';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { constants as osConstants, hostname, setPriority } from 'node:os';
import { parsePrivateAssetUrl, resolvePrivateAsset } from './scripts/_rv-private-assets.mjs';
import { cinematicAssetsPlugin } from './scripts/_rv-cinematic-assets.mjs';
import { livesyncExtensionPlugin } from './scripts/_rv-livesync-extension.mjs';
// @ts-expect-error — plain JS Node module, no type declarations by design (scripts/lib).
import { assetNotFoundGuard } from './scripts/lib/rv-fs.mjs';
import { createThirdPartyNotices, defaultPolicySpecs, noticesTierFromEnv } from './scripts/vite-plugin-third-party-notices.mjs';
import { agplAttributionEnabled, agplAttributionPlugin, demoNoticeEnabled, termsGateMode } from './scripts/lib/rv-agpl-attribution.mjs';
import { testLockProgressPlugin } from './scripts/test-progress-reporter.mjs';
import { featuresJsonPlugin } from './scripts/vite-plugin-features-json.mjs';
import { rvFeatureChunksPlugin } from './scripts/gen-feature-chunks.mjs';
import { devGoldenMiddleware } from './scripts/lib/rv-dev-golden.mjs';

// ─── Private content detection ──────────────────────────────────────────
const PRIVATE_ROOT_CANDIDATES = [
  resolve(__dirname, '../realvirtual-WebViewer-Private~'),
  resolve(__dirname, '../realvirtual-web-pro'),
];
const PRIVATE_ROOT = PRIVATE_ROOT_CANDIDATES.find((candidate) => existsSync(resolve(candidate, 'src')))
  ?? PRIVATE_ROOT_CANDIDATES[0];
const PRIVATE_DIR = resolve(PRIVATE_ROOT, 'src');
const HAS_PRIVATE = existsSync(PRIVATE_DIR) && !process.env.VITE_PUBLIC_BUILD;
console.log(`[rv-build] ${HAS_PRIVATE ? 'Private' : 'Public'} build${process.env.VITE_PUBLIC_BUILD ? ' (forced public via VITE_PUBLIC_BUILD)' : ''}`);
// plan-680 §2.3 — repo skew is refused, not bridged: DES lives in the core, and a private
// tree that still carries its own copy would declare the feature a second time (the later
// `features.define` silently wins). The staged delivery build runs this same config.
if (HAS_PRIVATE) {
  const stale = [resolve(PRIVATE_DIR, 'plugins/des'), resolve(PRIVATE_DIR, 'features/des.register.ts')]
    .filter((p) => existsSync(p));
  if (stale.length > 0) {
    throw new Error('repo skew: DES lives in the core since plan-680 — update realvirtual-WebViewer-Private~ '
      + `(stale: ${stale.join(', ')})`);
  }
}
// NF3: refuse incompatible experiment backend/core pairs before bundling.
if (existsSync(resolve(PRIVATE_DIR, 'plugins/des-experiments'))) {
  const versionFile = resolve(PRIVATE_DIR, 'plugins/des-experiments/seam-version.ts');
  const expected = existsSync(versionFile)
    ? readFileSync(versionFile, 'utf-8').match(/EXPECTED_SEAM_VERSION\s*=\s*(\d+)/)?.[1] : undefined;
  const actual = readFileSync(resolve(__dirname, 'src/plugins/des/des-experiment-seam.ts'), 'utf-8')
    .match(/DES_EXPERIMENT_SEAM_VERSION\s*=\s*(\d+)/)?.[1];
  if (!expected || expected !== actual) throw new Error(`repo skew: DES experiment seam ${actual}, private expects ${expected ?? 'missing version'}`);
}
// plan-679 Phase 9 (D10/D14): the AGPL notice belongs to pure AGPL/community builds only — derived
// from the build stage (private code compiled in or not), never from a variable anyone can set.
// RV_COMMERCIAL keeps steering installability only.
const AGPL_ATTRIBUTION = agplAttributionEnabled({ hasPrivate: HAS_PRIVATE });
// The public demo's "for evaluation" notice (#rv-demo-notice): private tree AND the explicit flag
// the demo build mode sets (RV_DEMO_NOTICE=1, never inherited). See rv-agpl-attribution.mjs.
// Belt and braces against an inherited variable: only a production build (never the dev server)
// and never a VITE_PRIVATE_BUILD (customer/private deploys) can carry it.
function demoNoticeFor(command: 'build' | 'serve'): boolean {
  return demoNoticeEnabled({
    hasPrivate: HAS_PRIVATE,
    demoFlag: process.env.RV_DEMO_NOTICE === '1' && command === 'build' && !process.env.VITE_PRIVATE_BUILD,
  });
}
// The generated list of tests that cannot resolve without the private sibling — see the
// `test.exclude` block far below for what it is for. Read here, lazily and defensively, because
// this config is ALSO loaded by the staged public build: stageFilteredSourceTree
// (scripts/_workspace-lib.mjs) copies neither the private sibling nor `tests/`, so the file is
// absent and an eager read turned every staged `vite build` into an ENOENT. Without `tests/`
// there is nothing to run and therefore nothing to exclude, so an empty list is the honest
// answer. With the file present the behaviour is unchanged.
function privateDependentTestExcludes(): string[] {
  if (existsSync(PRIVATE_DIR)) return [];
  const list = resolve(__dirname, 'tests/private-dependent-tests.json');
  if (!existsSync(list)) return [];
  return JSON.parse(readFileSync(list, 'utf-8')) as string[];
}
import { exec, execSync } from 'node:child_process';

// A test run must not freeze the developer's machine: the browser suite starts one
// headless Chromium per worker, each rendering WebGL on the CPU. Only under vitest the
// process lowers itself to BELOW NORMAL — the Chromium instances it spawns inherit the
// priority class on Windows. RV_TEST_PRIORITY=normal keeps the default priority.
if (process.env.VITEST && process.env.RV_TEST_PRIORITY !== 'normal') {
  try { setPriority(osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted — keep the default */ }
}

// ─── HMR back-channel through the CONNECT proxy (plan-363 Phase 2) ──────
// When CONNECT supervises this dev server, the browser talks to the CONNECT port, not to this one:
// the page is loaded through the proxy, and the dev port is loopback-only. Vite's HMR client dials
// the port it is TOLD to, so CONNECT passes its own port in RV_HMR_CLIENT_PORT and it is applied to
// `server.hmr.clientPort` below. Unset — every start that is not through CONNECT — leaves the HMR
// configuration absent entirely, which is the behaviour that shipped before this plan.
const RV_HMR_CLIENT_PORT = (() => {
  const raw = process.env.RV_HMR_CLIENT_PORT;
  if (!raw) return undefined;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn(`[rv-build] RV_HMR_CLIENT_PORT='${raw}' is not a usable port — ignoring it.`);
    return undefined;
  }
  return port;
})();

// ─── Build / version info (baked into the bundle via `define`) ──────────
// version:  framework-synced semver from package.json (kept in step with the
//           Unity realvirtual release, e.g. 6.3.0).
// webBuild: web-specific build number = commit count of THIS repo
//           (realvirtual-WEB-DEV), independent of the Unity framework.
// commit/buildDate: short hash and date of the built commit.
// buildTime: when THIS build ran, local time "YYYY-MM-DD HH:MM".
// All git calls are guarded so a git-less build (tarball, CI without .git)
// still produces a valid bundle.
//
// ENV WINS OVER GIT. A deploy does not build in the repository: it builds in a
// filtered staging tree that carries no `.git`, so every git call below fell
// back and delivered builds showed "web build 0", no commit and today's date
// instead of the commit's. The deploy therefore reads the values in the SOURCE
// repository and hands them over as RV_WEB_BUILD / RV_COMMIT / RV_BUILD_DATE /
// RV_BUILD_TIME (see runBuild() in scripts/_workspace-lib.mjs). Set and
// non-empty, they win; otherwise git is asked, exactly as before.
function rvGit(cmd: string, fallback: string): string {
  try {
    return execSync(cmd, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || fallback;
  } catch {
    return fallback;
  }
}
//! Environment override first, then git, then the fallback.
function rvBuildMeta(envKey: string, cmd: string, fallback: string): string {
  const fromEnv = process.env[envKey];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return rvGit(cmd, fallback);
}
//! Local wall-clock time as "YYYY-MM-DD HH:MM" — deliberately not toISOString(),
//! which would report UTC and read as an hour or two off for the operator.
function rvLocalTimestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    ` ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
const RV_VERSION = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8'),
).version as string;
const RV_WEB_BUILD = rvBuildMeta('RV_WEB_BUILD', 'git rev-list --count HEAD', '0');
const RV_COMMIT = rvBuildMeta('RV_COMMIT', 'git rev-parse --short HEAD', '');
const RV_BUILD_DATE = rvBuildMeta(
  'RV_BUILD_DATE',
  'git log -1 --format=%cd --date=short',
  new Date().toISOString().slice(0, 10),
);
const RV_BUILD_TIME = (() => {
  const fromEnv = process.env.RV_BUILD_TIME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return rvLocalTimestamp(new Date());
})();
console.log(
  `[rv-build] realvirtual WEB v${RV_VERSION} · web build ${RV_WEB_BUILD}` +
  `${RV_COMMIT ? ` (${RV_COMMIT})` : ''} · ${RV_BUILD_DATE} · built ${RV_BUILD_TIME}`,
);

// ─── Dev-server session info (serve only, never built) ──────────────────
// Answers "which checkout is this dev server actually serving?" — the tab
// alone cannot tell a worktree session apart from the canonical checkout, and
// getting that wrong is expensive: an unattended run once wrote a worktree
// plan's changes into the canonical tree and it only surfaced afterwards.
// The SERVED DIRECTORY is the authority here; branch and plan are derived.
//
// `rv-worktree.ps1` writes .rv-session.json one level above the repo, so its
// presence alone distinguishes a worktree from the canonical checkout.
interface RVSessionManifest {
  plans?: number[];
  slug?: string;
  vite_port?: number;
}

function rvSessionManifest(): RVSessionManifest | null {
  try {
    const raw = readFileSync(resolve(__dirname, '..', '.rv-session.json'), 'utf-8');
    const parsed = JSON.parse(raw) as RVSessionManifest;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // No manifest (canonical checkout), unreadable, or corrupt — all mean
    // "no session", which the badge renders as the canonical warning state.
    return null;
  }
}

/** Serialised `__RV_SERVE_INFO__` value; `'null'` for every non-serve command. */
function rvServeInfoLiteral(command: string): string {
  if (command !== 'serve') return 'null';
  const session = rvSessionManifest();
  return JSON.stringify({
    // The MACHINE, ahead of the directory: with a port forward in play
    // (`ssh -L 5100:127.0.0.1:5100`, `tailscale serve`) a remote dev server is
    // served under the reader's OWN localhost, so the page origin proves nothing
    // about which computer answered. Only the serving side knows this — the
    // browser has no way to learn its own machine name.
    host: hostname(),
    root: __dirname,
    branch: rvGit('git rev-parse --abbrev-ref HEAD', ''),
    plans: session?.plans ?? null,
    slug: session?.slug ?? null,
    vitePort: session?.vite_port ?? null,
  });
}


/**
 * Vite plugin: lets realvirtual CONNECT prove WHICH dev server is on a port before adopting it.
 *
 * plan-363 Phase 2. CONNECT starts and proxies this dev server, but a port that answers is not
 * evidence of anything — it could be an unrelated service or a Vite belonging to a different
 * workspace (in the session this was built, a foreign CONNECT sat on the neighbouring port).
 * CONNECT therefore reads this endpoint and adopts only when `root` is the workspace it was
 * configured for; anything else is reported as a port conflict and left running untouched.
 *
 * `apply: 'serve'` is load-bearing: the endpoint must not exist in a production build, where the
 * folder layout of the machine that built it is nobody's business.
 */
function devServerIdentityPlugin() {
  return {
    name: 'rv-devserver-identity',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: Function } }) {
      server.middlewares.use((req: { url?: string; socket?: { remoteAddress?: string } }, res: any, next: Function) => {
        if ((req.url ?? '').split('?')[0] !== '/__api/rv-devserver') {
          next();
          return;
        }
        // Loopback only, like every other /__api/* route: the answer names a local directory, and a
        // directory name is exactly the kind of detail that has no business leaving the machine.
        const peer = req.socket?.remoteAddress ?? '';
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          server: 'realvirtual-web-vite',
          root: __dirname,
          hmrClientPort: RV_HMR_CLIENT_PORT ?? null,
        }));
      });
    },
  };
}

/** Vite plugin: exposes /__api/tests endpoints so the app can discover and run vitest tests */
function testRunnerPlugin() {
  return {
    name: 'rv-test-runner',
    apply: 'serve' as const,
    configureServer(server: { config: { root: string }; middlewares: { use: Function } }) {
      server.middlewares.use((req: { url?: string; method?: string }, res: any, next: Function) => {
        if (req.url === '/__api/tests') {
          const testsDir = join(server.config.root, 'tests');
          let files: string[] = [];
          if (existsSync(testsDir)) {
            files = readdirSync(testsDir)
              .filter((f: string) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
              .map((f: string) => `tests/${f}`);
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ files }));
          return;
        }

        if (req.url === '/__api/tests/run' && req.method === 'POST') {
          res.setHeader('Content-Type', 'application/json');
          exec('npx vitest run --reporter=json', {
            cwd: server.config.root,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 180000,
          }, (_err: unknown, stdout: string) => {
            try {
              const jsonStart = stdout.indexOf('{');
              const jsonEnd = stdout.lastIndexOf('}');
              if (jsonStart >= 0 && jsonEnd > jsonStart) {
                const json = JSON.parse(stdout.substring(jsonStart, jsonEnd + 1));
                res.end(JSON.stringify(json));
              } else {
                res.end(JSON.stringify({ error: 'No JSON output from vitest' }));
              }
            } catch (e) {
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
          return;
        }

        next();
      });
    },
  };
}

/**
 * Vite plugin: `POST /__api/dev/golden` — the dev toolbar's "Save snapshot"
 * (plan-615 F4). Writes a state golden below `e2e/__goldens__/` only; path
 * checks and the overwrite guard live in `scripts/lib/rv-dev-golden.mjs`.
 * Serve only — no build carries the route.
 */
function devGoldenPlugin() {
  return {
    name: 'rv-dev-golden',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: Function } }) {
      // The repo directory, not the server root: `e2e/` lives next to this file
      // whatever directory Vite was started from.
      server.middlewares.use(devGoldenMiddleware(__dirname));
    },
  };
}

/** Vite plugin: debug API — bidirectional bridge between browser and Claude Code.
 *
 * READ:  Browser pushes state snapshots via POST, Claude Code reads via GET.
 * WRITE: Claude Code pushes commands via POST, browser polls and executes them.
 * Also buffers errors and signal changelogs pushed from the browser.
 */
function debugApiPlugin() {
  let latestSnapshot = '{"status":"no data yet"}';
  let cmdIdCounter = 0;
  const cmdQueue: { id: number; cmd: string; [k: string]: unknown }[] = [];
  const cmdResults: { id: number; success: boolean; error?: string }[] = [];

  function readBody(req: { on: Function }): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => resolve(body));
    });
  }

  function json(res: any, data: unknown, status = 200) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(status);
    res.end(JSON.stringify(data));
  }

  return {
    name: 'rv-debug-api',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: Function } }) {
      server.middlewares.use(async (req: { url?: string; method?: string; on: Function }, res: any, next: Function) => {
        const url = req.url ?? '';

        // ── Snapshot push/read ──

        if (url === '/__api/debug/snapshot' && req.method === 'POST') {
          latestSnapshot = await readBody(req);
          res.writeHead(200); res.end('ok');
          return;
        }

        // ── Command queue: Claude Code → Browser ──

        // POST /__api/debug/cmd — Claude Code pushes a command
        if (url === '/__api/debug/cmd' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          const id = ++cmdIdCounter;
          cmdQueue.push({ id, ...body });
          json(res, { queued: true, id });
          return;
        }

        // GET /__api/debug/cmd/poll — Browser polls for pending commands
        if (url === '/__api/debug/cmd/poll' && req.method === 'GET') {
          const commands = cmdQueue.splice(0);
          json(res, { commands });
          return;
        }

        // POST /__api/debug/cmd/result — Browser posts execution result
        if (url === '/__api/debug/cmd/result' && req.method === 'POST') {
          const result = JSON.parse(await readBody(req));
          cmdResults.push(result);
          if (cmdResults.length > 100) cmdResults.splice(0, cmdResults.length - 100);
          res.writeHead(200); res.end('ok');
          return;
        }

        // GET /__api/debug/cmd/results — Claude Code reads results
        if (url === '/__api/debug/cmd/results' && req.method === 'GET') {
          const results = cmdResults.splice(0);
          json(res, { results });
          return;
        }

        // ── GET /__api/debug[/sub] — serve snapshot or sub-route ──

        if (url.startsWith('/__api/debug') && req.method === 'GET') {
          const fullRoute = url.replace('/__api/debug', '') || '/';
          // Split route from query string
          const qIdx = fullRoute.indexOf('?');
          const route = qIdx >= 0 ? fullRoute.slice(0, qIdx) : fullRoute;
          const query = qIdx >= 0 ? new URLSearchParams(fullRoute.slice(qIdx)) : null;

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');

          if (route === '/' || route === '/snapshot') {
            res.end(latestSnapshot);
            return;
          }

          try {
            const data = JSON.parse(latestSnapshot);
            const sub = route.slice(1); // strip leading '/'

            // Signal watch: /__api/debug/signals?names=A,B,C
            if (sub === 'signals' && query?.get('names')) {
              const names = query.get('names')!.split(',');
              const filtered: Record<string, unknown> = {};
              for (const n of names) {
                if (n in (data.signals ?? {})) filtered[n] = data.signals[n];
              }
              json(res, filtered);
              return;
            }

            // Log buffer: /__api/debug/logs?level=warn&category=signal&limit=20
            if (sub === 'logs') {
              const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
              let logs: unknown[] = data.logs ?? [];
              const level = query?.get('level');
              const category = query?.get('category');
              const limit = query?.get('limit');
              if (level) {
                const minIdx = LEVELS.indexOf(level);
                if (minIdx >= 0) logs = logs.filter((e: any) => LEVELS.indexOf(e.level) >= minIdx);
              }
              if (category) logs = logs.filter((e: any) => e.category === category);
              if (limit) logs = logs.slice(-parseInt(limit, 10));
              json(res, logs);
              return;
            }

            if (sub in data) {
              json(res, data[sub]);
              return;
            }
          } catch { /* snapshot not valid JSON yet */ }

          json(res, { error: 'unknown route' }, 404);
          return;
        }

        next();
      });
    },
  };
}

/**
 * Vite plugin: Save visual presets to disk (DEV only).
 * POST /api/preset with { name, preset }
 * Writes public/presets/<safeName>.preset.json and regenerates index.json
 * (an array of file stems) so the published manifest stays correct.
 */
function presetSavePlugin() {
  function readBody(req: { on: Function }): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => resolve(body));
    });
  }

  return {
    name: 'rv-preset-save',
    apply: 'serve' as const,
    configureServer(server: { config: { root: string }; middlewares: { use: Function } }) {
      server.middlewares.use(async (req: { url?: string; method?: string; on: Function }, res: any, next: Function) => {
        if (req.url !== '/api/preset' || req.method !== 'POST') return next();

        try {
          const body = JSON.parse(await readBody(req));
          const { name, preset } = body as { name: string; preset: unknown };
          if (!name || !preset) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing name or preset' }));
            return;
          }

          const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
          const outDir = join(server.config.root, 'public/presets');
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, `${safe}.preset.json`), JSON.stringify(preset, null, 2));

          // Regenerate the manifest from the directory (array of file stems).
          const stems = readdirSync(outDir)
            .filter((f) => f.endsWith('.preset.json'))
            .map((f) => f.replace(/\.preset\.json$/, ''));
          writeFileSync(join(outDir, 'index.json'), JSON.stringify(stems, null, 2));

          console.log(`[rv-preset] Saved ${safe}.preset.json`);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, name, stem: safe }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

// ─── Private project directory (contains project subfolders with models/) ────
const PRIVATE_PROJECTS_DIR = [
  resolve(PRIVATE_ROOT, 'projects'),
  resolve(__dirname, '../projects'),
].find((candidate) => existsSync(candidate)) ?? resolve(PRIVATE_ROOT, 'projects');

/**
 * Vite plugin: Discover and serve GLB models + AASX/PDF assets from private project folders.
 *
 * Scans `realvirtual-WebViewer-Private~/projects/<name>/` for:
 *   - `models/*.glb`  → served under `/private-models/<project>/`
 *   - `aasx/*.aasx`   → served under `/private-assets/<project>/aasx/`
 *   - `pdf/*.pdf`     → served under `/private-assets/<project>/pdf/`
 *   - everything else → `/private-assets/<project>/<path...>`, recursively
 *     (`fixtures/`, `models/`, `library/`, `scratch/` of the internal
 *     Development project since plan-395 — through this same route, on
 *     purpose: a second recursive mount would double the attack surface and
 *     need the same hardening twice)
 *
 * Also exposes:
 *   - `GET /__api/private-models` — JSON manifest of all GLB models
 *   - `GET /private-assets/<project>/aasx/index.json` — auto-generated AASX index
 *
 * `RV_NO_PRIVATE=1` turns the whole plugin off while leaving the working tree
 * alone. That is how the test suite simulates a checkout without the private
 * sibling (plan-395 §2.11): renaming the real folder to prove a skip works is
 * the kind of test setup that eventually loses somebody's models.
 */
/**
 * Ends the response for a HEAD request, or reports that a body should follow.
 *
 * A HEAD must carry the headers of the GET and none of its bytes. Piping the
 * file anyway is not merely wasteful: the plan-395 availability probe HEADs
 * every internal asset at module scope, `tests.glb` is 36 MB, and streaming it
 * eight times over turned a probe that should cost milliseconds into 22
 * seconds - measured, as a test timeout, which is how this was found.
 *
 * @returns `true` when the caller should still stream the body.
 */
function sendBody(res: any, _path: string, method?: string): boolean {
  if ((method ?? 'GET').toUpperCase() !== 'HEAD') return true;
  res.end();
  return false;
}

// ─── Asset 404 guard (plan-508 F1) ────────────────────────────────────────
//
// A missing asset path must answer 404 text/plain, never Vite's SPA
// `index.html` with status 200 — one such answer, cached by the planner's blob
// cache, WAS `ChainConveyor-1m.glb` for a browser profile (2026-09-26). The
// middleware itself (`assetNotFoundGuard`, rules and exemptions) lives in
// `scripts/lib/rv-fs.mjs` so its node test does not type-check this file; it is
// re-exported here and registered as a PRE-hook below.
export { assetNotFoundGuard };

/** Pre-hook plugin: registered straight in `configureServer`, so it runs BEFORE Vite's SPA fallback. */
function assetNotFoundGuardPlugin() {
  return {
    name: 'rv-asset-404-guard',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: Function }; config: { base: string; publicDir: string | false; root: string } }) {
      const roots = [server.config.publicDir, server.config.root].filter((d): d is string => typeof d === 'string' && d !== '');
      server.middlewares.use(assetNotFoundGuard({ base: server.config.base, roots }));
    },
  };
}

function privateModelsPlugin() {
  if (process.env.RV_NO_PRIVATE === '1') return null;
  if (!HAS_PRIVATE || !existsSync(PRIVATE_PROJECTS_DIR)) return null;

  // Build manifest: scan all project subdirs for GLB files
  function buildManifest(): Array<{ project: string; filename: string; url: string }> {
    const entries: Array<{ project: string; filename: string; url: string }> = [];
    try {
      for (const project of readdirSync(PRIVATE_PROJECTS_DIR, { withFileTypes: true })) {
        if (!project.isDirectory()) continue;
        const modelsDir = join(PRIVATE_PROJECTS_DIR, project.name, 'models');
        if (!existsSync(modelsDir)) continue;
        for (const file of readdirSync(modelsDir)) {
          if (!file.toLowerCase().endsWith('.glb')) continue;
          entries.push({
            project: project.name,
            filename: file,
            url: `/private-models/${project.name}/${file}`,
          });
        }
      }
    } catch { /* ignore scan errors */ }
    return entries;
  }

  /** List files in a private project subfolder. */
  function listProjectFiles(project: string, subfolder: string, ext: string): string[] {
    const dir = join(PRIVATE_PROJECTS_DIR, project, subfolder);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter(f => f.toLowerCase().endsWith(ext));
    } catch { return []; }
  }

  /** Serve a static file from a private project subfolder with correct MIME type. */
  function serveProjectFile(
    res: any, project: string, subfolder: string, filename: string, method?: string,
  ): boolean {
    // Through the same resolver as the recursive route: `/private-models/` takes
    // its two segments straight off the URL, so it is exactly as reachable, and
    // a second copy of the containment rules is a second place to get them wrong.
    const resolved = resolvePrivateAsset(PRIVATE_PROJECTS_DIR, project, `${subfolder}/${filename}`);
    if (!resolved) return false;
    const stat = statSync(resolved.path);
    res.setHeader('Content-Type', resolved.mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-store');
    if (!sendBody(res, resolved.path, method)) return true;
    createReadStream(resolved.path).pipe(res);
    return true;
  }

  return {
    name: 'rv-private-models',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: Function } }) {
      server.middlewares.use((req: { url?: string; method?: string }, res: any, next: Function) => {
        const url = req.url ?? '';

        // Manifest endpoint
        if (url === '/__api/private-models' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(buildManifest()));
          return;
        }

        // Serve GLB files under /private-models/<project>/<file>.glb
        if (url.startsWith('/private-models/') && url.endsWith('.glb')) {
          const parts = url.replace('/private-models/', '').split('/');
          if (parts.length === 2) {
            const [project, file] = parts;
            if (serveProjectFile(res, project, 'models', file, req.method)) return;
          }
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        // Serve private assets: /private-assets/<project>/<path...>
        // Supports arbitrary depth paths (e.g., docs/subfolder/subfolder/file.pdf)
        // as well as flat paths (e.g., docs-index.json, aasx/index.json)
        if (url.startsWith('/private-assets/')) {
          // Query, fragment and percent-encoding are judged by the shared
          // parser, containment by the shared resolver — both in
          // `scripts/_rv-private-assets.mjs`, so a Node test can exercise the
          // traversal rules without standing up an HTTP server (plan-395 §2.5).
          const parsed = parsePrivateAssetUrl(url);
          if (parsed) {
            const { project, assetPath } = parsed;

            // Auto-generate AASX index.json on the fly. `listProjectFiles`
            // composes a directory path from `project`, so the one-segment rule
            // has to hold here too — this branch answers before the resolver.
            // plan-682 RR5: only when the project ships NO index of its own. The
            // generated one keys entries by FILE NAME, the client looks them up
            // by AAS id — serving it over a real (id-keyed) index made every
            // link of a private project resolve to `unknown-id` in dev.
            const shippedIndex = assetPath === 'aasx/index.json'
              ? resolvePrivateAsset(PRIVATE_PROJECTS_DIR, project, assetPath)
              : null;
            if (assetPath === 'aasx/index.json' && !(shippedIndex && existsSync(shippedIndex.path))
              && project !== '.' && project !== '..' && !/[\\/]/.test(project)) {
              const aasxFiles = listProjectFiles(project, 'aasx', '.aasx');
              const index: Record<string, { file: string; idShort: string }> = {};
              for (const f of aasxFiles) {
                index[f.replace('.aasx', '')] = { file: f, idShort: f.replace('.aasx', '') };
              }
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Cache-Control', 'no-store');
              res.end(JSON.stringify(index, null, 2));
              return;
            }

            // Serve any file from the project directory — through the one
            // resolver, which is what decides whether the composed path is still
            // inside PRIVATE_PROJECTS_DIR and of a type we serve.
            const resolved = resolvePrivateAsset(PRIVATE_PROJECTS_DIR, project, assetPath);
            if (resolved) {
              try {
                const fstat = statSync(resolved.path);
                res.setHeader('Content-Type', resolved.mime);
                res.setHeader('Content-Length', fstat.size);
                res.setHeader('Cache-Control', 'no-store');
                if (!sendBody(res, resolved.path, req.method)) return;
                createReadStream(resolved.path).pipe(res);
                return;
              } catch { /* fall through to 404 */ }
            }
          }
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        next();
      });
    },
  };
}

/**
 * Vite plugin: Resolve bare imports from private folder files via the main project's node_modules.
 *
 * When HAS_PRIVATE is true, files in realvirtual-WebViewer-Private~/src/ may import npm packages
 * (react, @mui/icons-material, etc.). Rollup resolves node_modules by walking up from the
 * importing file's directory, which fails because the private folder has no node_modules.
 * This plugin intercepts unresolved bare imports from the private folder and resolves them
 * from the main project's node_modules instead.
 */
function privateResolverPlugin() {
  // Always activate when the private folder exists, even in public builds.
  // import.meta.glob discovers private project files on disk regardless of
  // VITE_PUBLIC_BUILD, so Rollup still needs to resolve their bare imports.
  if (!existsSync(PRIVATE_DIR)) return null;
  // A virtual importer inside the main project so Vite/Rollup resolves
  // bare npm imports using the main project's node_modules with proper ESM handling.
  const mainImporter = resolve(__dirname, 'src/main.ts');
  return {
    name: 'rv-private-resolver',
    enforce: 'pre' as const,
    async resolveId(source: string, importer: string | undefined) {
      // Only intercept bare imports from files in the private folder
      if (!importer) return null;
      const normalizedImporter = importer.replace(/\\/g, '/');
      if (!normalizedImporter.includes('realvirtual-WebViewer-Private')
          && !normalizedImporter.includes('realvirtual-web-pro')) return null;
      // Skip relative/absolute imports, virtual modules, and already-resolved paths
      if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) return null;
      if (/^[A-Za-z]:/.test(source)) return null; // Windows absolute paths like C:\...
      // Re-resolve using Vite's own resolver as if the import came from the main project.
      // This ensures ESM exports maps are respected (unlike createRequire which returns CJS paths).
      const resolved = await this.resolve(source, mainImporter, { skipSelf: true });
      return resolved;
    },
  };
}

/**
 * Vite plugin: resolve MISSING private stubs to an empty module in public builds.
 *
 * In a forced-public build on a machine WITH the private folder, import.meta.glob
 * still discovers private project files on disk, and Rollup loads every module
 * they import during the scan phase — even when the importing branch is dead
 * (`__RV_HAS_PRIVATE__` gate). `@rv-private/...` then aliases to src/private-stubs/,
 * and any private-only import WITHOUT a stub file breaks the build with ENOENT.
 *
 * This plugin resolves such nonexistent stub paths to a virtual empty module with
 * synthetic named exports (every named import becomes undefined, no build warnings).
 * The code is unreachable at runtime — the __RV_HAS_PRIVATE__ gate in
 * rv-model-plugin-manager.ts keeps private project plugins out of the public
 * runtime, and Rollup drops the dead chunks entirely.
 */
function missingStubResolverPlugin() {
  // Only relevant for a public build with the private folder present on disk.
  if (!existsSync(PRIVATE_DIR) || HAS_PRIVATE) return null;
  const STUBS_DIR = resolve(__dirname, 'src/private-stubs').replace(/\\/g, '/');
  const EMPTY_ID = '\0rv-missing-private-stub';
  const EXT_PROBES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
  return {
    name: 'rv-missing-stub-resolver',
    resolveId(source: string) {
      const normalized = source.replace(/\\/g, '/');
      if (!normalized.startsWith(STUBS_DIR)) return null;
      const exists = EXT_PROBES.some((ext) => existsSync(normalized + ext));
      if (exists) return null; // real stub — let Vite resolve it normally
      return { id: EMPTY_ID, syntheticNamedExports: true };
    },
    load(id: string) {
      if (id !== EMPTY_ID) return null;
      return 'export default {};';
    },
  };
}

/**
 * Vite plugin: serve the Draco glTF decoder from our own origin.
 *
 * The scene loader points DRACOLoader at `<base>draco/` (see rv-scene-loader.ts)
 * instead of the gstatic CDN — the CDN intermittently fails on mobile networks
 * and behind corporate proxies, leaving DRACO-compressed models with a blank
 * scene. In dev a middleware serves /draco/* from node_modules; for the
 * production build the decoder files are emitted into dist/draco/.
 */
function dracoDecoderPlugin() {
  const SRC = resolve(__dirname, 'node_modules/three/examples/jsm/libs/draco/gltf');
  const FILES = ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'];
  return {
    name: 'rv-draco-decoder',
    configureServer(server: { middlewares: { use: Function } }) {
      server.middlewares.use((req: { url?: string }, res: any, next: Function) => {
        const u = req.url || '';
        if (!u.startsWith('/draco/')) return next();
        const name = u.slice('/draco/'.length).split('?')[0];
        const file = join(SRC, name);
        if (!FILES.includes(name) || !existsSync(file)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'application/javascript');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle(this: { emitFile: Function }) {
      for (const name of FILES) {
        const file = join(SRC, name);
        if (existsSync(file)) {
          this.emitFile({ type: 'asset', fileName: `draco/${name}`, source: readFileSync(file) });
        } else {
          console.warn(`[rv-draco-decoder] missing ${file} — DRACO-compressed models will not decode`);
        }
      }
    },
  };
}

/**
 * Vite plugin: ship occt-import-js as two LOOSE files (plan-544, Thomas 2026-10-03).
 *
 * occt-import-js is LGPL-2.1-only. It must stay a separate, replaceable library, so its glue
 * (`occt-import-js.js`) and module (`occt-import-js.wasm`) are NOT bundled into a Rollup chunk:
 * they are copied verbatim — i.e. exactly as they sit in node_modules after the
 * `patch-occt-memory.mjs` pre-/postinstall step (heap ceiling 2 GB -> 4 GB, declared as
 * "modified (memory limit patch)" in third-party/manual-components.json) — to `<dist>/occt/`,
 * and the STEP-import worker loads them at runtime from `<deploy base>/occt/`. In dev the same
 * URLs are served from node_modules.
 *
 * The files are emitted only when a worker pass bundled the STEP-import worker (private tree),
 * so public and customer builds without the importer do not carry 7.6 MB of WASM. Worker passes
 * run before the main `generateBundle`, which is where the flag is read.
 */
function occtLooseFilePlugin() {
  const SRC = resolve(__dirname, 'node_modules/occt-import-js/dist');
  const FILES = ['occt-import-js.js', 'occt-import-js.wasm'];
  let stepWorkerBundled = false;
  return {
    /** Main-build plugin: dev middleware + emit. */
    plugin() {
      return {
        name: 'rv-occt-loose-files',
        configureServer(server: { config: { base?: string }; middlewares: { use: Function } }) {
          server.middlewares.use((req: { url?: string }, res: any, next: Function) => {
            const u = (req.url || '').split('?')[0];
            const base = server.config.base || '/';
            const prefix = u.startsWith(`${base}occt/`) ? `${base}occt/` : (u.startsWith('/occt/') ? '/occt/' : null);
            if (!prefix) return next();
            const name = u.slice(prefix.length);
            const file = join(SRC, name);
            if (!FILES.includes(name) || !existsSync(file)) return next();
            res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
            createReadStream(file).pipe(res);
          });
        },
        generateBundle(this: { emitFile: Function; error: Function }) {
          if (!stepWorkerBundled) return;
          for (const name of FILES) {
            const file = join(SRC, name);
            if (!existsSync(file)) {
              this.error(`[rv-occt-loose-files] missing ${file} — the STEP-import worker would fail to load its CAD engine`);
            }
            this.emitFile({ type: 'asset', fileName: `occt/${name}`, source: readFileSync(file) });
          }
        },
      };
    },
    /** Worker-pass plugin: notes whether the STEP-import worker is part of this build. */
    workerPlugin() {
      return {
        name: 'rv-occt-loose-files-worker',
        generateBundle(_options: unknown, bundle: Record<string, { type: string; modules?: Record<string, unknown> }>) {
          for (const item of Object.values(bundle)) {
            if (item.type !== 'chunk') continue;
            if (Object.keys(item.modules ?? {}).some((id) => /[\/]step-import-worker\.ts(\?|$)/.test(id))) {
              stepWorkerBundled = true;
            }
          }
        },
      };
    },
  };
}
const occtLooseFiles = occtLooseFilePlugin();

/**
 * Vite plugin: serve / ship the cinematic render's private loose assets — OIDN weights and the
 * look HDRIs (plan-550 F12, plan-553 F8). Implementation + file list: scripts/_rv-cinematic-assets.mjs.
 */
function cinematicAssets() {
  if (!HAS_PRIVATE) return null;
  return cinematicAssetsPlugin(PRIVATE_ROOT);
}

/**
 * Vite plugin: Strip the impeccable-live dev script from PRODUCTION builds.
 *
 * The impeccable live tool injects `<script src="http://localhost:8400/live.js">`
 * (wrapped in `<!-- impeccable-live-start/end -->` markers) into index.html for
 * design sessions. That toggle is dev-only — if it is accidentally left ON, this
 * plugin guarantees it never reaches dist/ (and thus never a deploy). Dev serve
 * is untouched, so impeccable can switch it on/off as usual.
 */
function stripImpeccableLivePlugin() {
  return {
    name: 'rv-strip-impeccable-live',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html
        .replace(/<!-- impeccable-live-start -->[\s\S]*?<!-- impeccable-live-end -->\s*/g, '')
        .replace(/^.*localhost:\d+\/live\.js.*\r?\n?/gm, '');
    },
  };
}

/**
 * Vite plugin: Write the version label into the loading splash.
 *
 * The splash in index.html is painted before any script runs, so the label is
 * substituted into the HTML itself (dev serve and build) — same wording as
 * `formatVersionShort()` in src/core/rv-version.ts.
 */
function versionLabelPlugin() {
  return {
    name: 'rv-version-label',
    transformIndexHtml(html: string) {
      return html.replace('{{RV_VERSION_LABEL}}', `v${RV_VERSION} · build ${RV_WEB_BUILD}`);
    },
  };
}

/**
 * Vite plugin: Strip the web app manifest link from NON-COMMERCIAL builds.
 *
 * The `<link rel="manifest">` (display: standalone) is what makes Chrome/Edge offer
 * "Install app". The public demo must not be installable; commercial/customer builds
 * (RV_COMMERCIAL=1) keep it so an HMI can run in its own app window. Dev serve is
 * untouched. There is no service worker either way, so an installed app is only a
 * window onto the online URL.
 */
function stripInstallManifestPlugin() {
  if (process.env.RV_COMMERCIAL) return null;
  return {
    name: 'rv-strip-install-manifest',
    apply: 'build' as const,
    transformIndexHtml(html: string) {
      return html.replace(/^.*<link rel="manifest"[^>]*>.*\r?\n?/gm, '');
    },
  };
}

// ─── Third-party licence notices (plan-544) ─────────────────────────────
// ONE collector shared by the main plugin and the worker-pass plugin: worker builds are separate
// Rollup passes (see `worker` below) and would otherwise leave worker-only packages (occt-import-js
// in the STEP-import worker, three-mesh-bvh's worker, …) out of the notices. The policy set follows
// the tier (F12): the Private policy only when the private tree is part of this build.
const thirdPartyNotices = createThirdPartyNotices({
  rootDir: __dirname,
  policies: defaultPolicySpecs(__dirname, HAS_PRIVATE ? PRIVATE_ROOT : null),
  manualComponents: resolve(__dirname, 'third-party/manual-components.json'),
  tier: noticesTierFromEnv(HAS_PRIVATE),
});

export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE || './',
  plugins: [
    privateResolverPlugin(),
    missingStubResolverPlugin(),
    privateModelsPlugin(),
    assetNotFoundGuardPlugin(),
    react(),
    // plan-652: dist/feature-chunks.json — files + bytes per feature adapter/body chunk.
    rvFeatureChunksPlugin(),
    // VitePWA disabled – no service worker, always fresh content
    versionLabelPlugin(),
    devServerIdentityPlugin(),
    testRunnerPlugin(),
    debugApiPlugin(),
    devGoldenPlugin(),
    presetSavePlugin(),
    dracoDecoderPlugin(),
    stripImpeccableLivePlugin(),
    stripInstallManifestPlugin(),
    // plan-679 Phase 9: removes watermark, noscript source link and JSON-LD licence unless this is
    // a pure AGPL build. No `apply`: the dev server a customer workspace runs gets the same HTML.
    agplAttributionPlugin(AGPL_ATTRIBUTION, { demoNotice: demoNoticeFor(command) }),
    // Before the notices plugin: its generateBundle must already see the emitted occt/ files.
    occtLooseFiles.plugin(),
    // Same rule for the cinematic denoiser weights (oidn/*.tza, plan-550).
    cinematicAssets(),
    // The Isaac Sim extension download (downloads/realvirtual-livesync-<version>.zip, plan-637
    // Phase 6): define __RV_LIVESYNC_EXT__, dev middleware, build emit.
    livesyncExtensionPlugin(__dirname),
    // dist/features.json from generated/features.json, only when it exists (plan-646 Phase 2).
    featuresJsonPlugin(__dirname),
    thirdPartyNotices.plugin(),
    // Vitest only (configureVitest hook): startup progress for the test lock wrapper + the
    // [test-skips] line, appended to whatever reporters config/CLI chose; under vitest its
    // configureServer hook also watches the deps optimizer for the [test-deps] line
    // (RV_TEST_STRICT_DEPS). No build or dev-server effect.
    testLockProgressPlugin(),
  ].filter(Boolean),
  // Worker builds are a SEPARATE Rollup pass that does NOT inherit the main `plugins`.
  // The STEP-import worker (`step-import-worker.ts`) lives in the private sibling folder and
  // imports bare npm deps like `occt-import-js`; without privateResolverPlugin here, Rollup walks
  // up from the worker file (which has no node_modules) and fails to resolve them. Register the
  // same resolver for the worker pass so private-folder bare imports hit the main node_modules.
  worker: {
    // ES format: the STEP-import worker is a module worker (it loads the loose occt-import-js glue
    // with a runtime `import()`, see occtLooseFilePlugin), and other workers code-split; Vite's
    // default 'iife' worker format rejects code-splitting builds.
    format: 'es',
    plugins: () => [privateResolverPlugin(), occtLooseFiles.workerPlugin(), thirdPartyNotices.workerPlugin()].filter(Boolean),
  },
  resolve: {
    dedupe: ['three'],
    // Worktree sessions link the private sibling folder in as a JUNCTION to the canonical
    // checkout. Resolving through the realpath would move `hmi-entry.tsx` into the canonical
    // tree, and its relative `../../../realvirtual-WebViewer~/src/...` imports would then load
    // a SECOND copy of the whole HMI layer (App, HMIShell, use-viewer, …) from there. Two
    // module instances mean two ViewerContext objects: the provider set by main.ts is invisible
    // to the consumers, every `useViewer()` throws, and React unmounts the entire UI (the
    // 3D canvas survives because it never goes through React). Keeping the link path also
    // keeps @fontsource inside `server.fs.allow`, which the canonical path is not (→ 403).
    preserveSymlinks: true,
    alias: {
      '@rv': resolve(__dirname, 'src'),
      '@rv-private': HAS_PRIVATE
        ? PRIVATE_DIR
        : resolve(__dirname, 'src/private-stubs'),
      '@rv-projects': HAS_PRIVATE
        ? PRIVATE_PROJECTS_DIR
        : resolve(__dirname, 'src/private-stubs/projects'),
      // Explicit aliases for React JSX runtime — needed so that files imported from
      // the private folder (outside the project root) resolve the JSX runtime from
      // the main project's node_modules, not from the (non-existent) private node_modules.
      ...(HAS_PRIVATE ? {
        'react/jsx-runtime': resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
        'react/jsx-dev-runtime': resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
        // plan-661: box2d3-wasm (PRIVATE dependency) exports only `.` and `./utils/*`, and its
        // `entry.mjs` picks the threaded `deluxe` build inside every Worker. The private loader
        // (src/physics2d/box2d-loader.ts) imports the two flavour files directly instead.
        'rv-box2d3-compat': resolve(PRIVATE_ROOT, 'node_modules/box2d3-wasm/build/dist/es/compat/Box2D.compat.mjs'),
        'rv-box2d3-deluxe': resolve(PRIVATE_ROOT, 'node_modules/box2d3-wasm/build/dist/es/deluxe/Box2D.deluxe.mjs'),
        // Rapier is a normal PRIVATE dependency (Private~/package.json). THIS entry is the single
        // source of truth for where it resolves from (the loader, the physics tests and the PROD
        // build all use the bare name): at the project root the name would hit the transitive
        // @types/three copy (Rapier 0.12) or nothing, so map it to the private copy (0.19.x: package
        // root, 0.20+: dist/). tests/rapier-version-guard.node.test.ts pins this entry. If the
        // private package is not installed there is NO entry, and the import fails loudly.
        ...((() => {
          const dir = resolve(PRIVATE_ROOT, 'node_modules/@dimforge/rapier3d-compat');
          const file = ['rapier.mjs', 'dist/rapier.mjs'].map((f) => resolve(dir, f)).find((f) => existsSync(f));
          return file ? { '@dimforge/rapier3d-compat': file } : {};
        })()),
      } : {}),
    },
  },
  define: {
    __RV_TERMS_GATE__: JSON.stringify(termsGateMode({
      command,
      hasPrivate: HAS_PRIVATE,
      demoFlag: process.env.RV_DEMO_NOTICE === '1',
      privateBuild: !!process.env.VITE_PRIVATE_BUILD,
      customerWorkspace: existsSync(resolve(__dirname, '..', 'delivery-manifest.json')),
      isTest: !!process.env.VITEST,
    })),
    __RV_HAS_PRIVATE__: JSON.stringify(HAS_PRIVATE),
    // plan-467 F15 test gate, default ON: the real-WASM physics suites must NOT skip when
    // @dimforge/rapier3d-compat cannot be loaded - a skip there hides exactly the cases the plan
    // cares about (and hid the whole Rapier 0.20 breakage). Required whenever the private tree is
    // present; the only explicit environment skip is a run without it (RV_NO_PRIVATE=1 /
    // VITE_PUBLIC_BUILD), or RV_PHYSICS_REQUIRE_WASM=0 for a deliberate local opt-out.
    // A `define` rather than an env var because the suites run in browser mode, where only
    // VITE_-prefixed env vars would be visible. Statically replaced; nothing survives into a bundle.
    __RV_PHYSICS_REQUIRE_WASM__: JSON.stringify(
      process.env.RV_PHYSICS_REQUIRE_WASM === '1' ||
        (HAS_PRIVATE && process.env.RV_NO_PRIVATE !== '1' && process.env.RV_PHYSICS_REQUIRE_WASM !== '0'),
    ),
    // plan-501 SOL R2 #3 — same gate for the kinematic mechanism solver: with
    // RV_SOLVER_REQUIRE_WASM=1 a missing rv_kinematic_solver.wasm is a FAILURE in
    // the solver suites (tests/helpers/require-solver.ts), not a quiet skip. A
    // define for the same reason as above: the suites run in browser mode.
    __RV_SOLVER_REQUIRE_WASM__: JSON.stringify(process.env.RV_SOLVER_REQUIRE_WASM === '1'),
    // plan-501 §9.7 acceptance gate: the SiMoRob torque bands and the Phase-3 runtime/main-thread
    // measurement run only with RV_PLAN501_ACCEPTANCE=1 — red until Simon's numeric reference
    // arrives (plan-501 open:), load-dependent for the measurement. Statically false in every build.
    __RV_PLAN501_ACCEPTANCE__: JSON.stringify(process.env.RV_PLAN501_ACCEPTANCE === '1'),
    // plan-612 Phase 6: long-run knobs of the PalletYard soak tests (browser mode, hence a define):
    // RV_SOAK_DAYS=7 runs the FastForward soak for a week, RV_SOAK_ANIMATED_SEC=3600 the Animated
    // run for an hour. 0 = the test default. Statically 0 in every build.
    __RV_SOAK_DAYS__: JSON.stringify(Number(process.env.RV_SOAK_DAYS) || 0),
    __RV_SOAK_ANIMATED_SEC__: JSON.stringify(Number(process.env.RV_SOAK_ANIMATED_SEC) || 0),
    __RV_EMBED__: 'false',
    __RV_COMMERCIAL__: JSON.stringify(!!process.env.RV_COMMERCIAL),
    // plan-679 Phase 9: true exactly in a pure AGPL/community build (no private tree).
    __RV_AGPL_ATTRIBUTION__: JSON.stringify(AGPL_ATTRIBUTION),
    // Internal/dev-only features (DES, IK solver, STEP import, layout cloud, …).
    // Dev server (and vitest, which runs in serve mode) always ON; production
    // builds only with RV_INTERNAL=1. Customer deploys (stagePrivateProject /
    // deploy:private) never set it, so Rollup eliminates the gated dynamic
    // import in internal code paths and its chunks never reach the bundle.
    __RV_INTERNAL__: JSON.stringify(command === 'serve' || !!process.env.RV_INTERNAL),
    // plan-646 F14: the welcome window of the public demo. True only when bunny-deploy builds
    // `--demo` for the effective target path `demo` — runBuild() then sets RV_DEMO_WELCOME
    // explicitly to '1' or '0' for every staged build, never inheriting it. Default false, so
    // the gated dynamic import in the private demo-welcome adapter is dead code everywhere else
    // and Rollup emits no chunk for the window.
    __RV_DEMO_WELCOME__: JSON.stringify(process.env.RV_DEMO_WELCOME === '1'),
    __RV_VERSION__: JSON.stringify(RV_VERSION),
    __RV_WEB_BUILD__: JSON.stringify(RV_WEB_BUILD),
    __RV_COMMIT__: JSON.stringify(RV_COMMIT),
    __RV_BUILD_DATE__: JSON.stringify(RV_BUILD_DATE),
    __RV_BUILD_TIME__: JSON.stringify(RV_BUILD_TIME),
    // Dev server only. Every built bundle substitutes the literal `null`, so
    // Rollup eliminates the badge subtree and no machine path is ever shipped.
    // Stricter than __RV_INTERNAL__, which is also true for internal *builds*.
    __RV_SERVE_INFO__: rvServeInfoLiteral(command),
  },
  optimizeDeps: {
    // Pre-bundle read-excel-file so the lazy `await import('read-excel-file')`
    // in s7-tag-table.ts doesn't trigger a dev-mode pre-bundling stall.
    // monaco-editor is lazy-imported on the first PLC-editor open (private,
    // internal tier) — pre-bundle to avoid a mid-session dev-server reload
    // on first discovery (which also aborts running vitest browser suites:
    // "Vite unexpectedly reloaded a test").
    // GLTFLoader is imported by the Onshape import validation (plan-237,
    // @rv-private) — pre-bundle for the same "unexpected reload" reason.
    // USDZLoader + fflate are lazy-imported by the USD import provider
    // (plan-252, @rv-private) — pre-bundle for the same reason.
    // FBXLoader is lazy-imported by the FBX import provider (@rv-private) —
    // same reason again; without it every fbx-to-three test times out on the
    // reload rather than failing with an assertion.
    // occt-import-js is NOT listed: since plan-544 the STEP-import worker no
    // longer imports it as a module — it loads the loose glue file from
    // `<base>occt/` at runtime (occtLooseFilePlugin), so the optimizer never
    // discovers it and no mid-session "optimized dependencies changed.
    // reloading" can hit an in-browser STEP import.
    // echarts sub-entries (core/charts/components/renderers, all via
    // echarts-setup.ts) MUST be pre-bundled together: without pinning, a
    // mid-session dep re-optimization can split echarts into two optimized
    // instances, and the second instance re-runs its component registration
    // against a core that already has them → uncaught "axisPointer
    // CartesianAxisPointer exists". Pinning keeps a single echarts instance.
    // A dependency still missing here shows up in every vitest run as the
    // `[test-deps] undeclared dependency discovered mid-run: <dep>` line
    // (scripts/test-progress-reporter.mjs; RV_TEST_STRICT_DEPS=fail makes it red).
    include: [
      // MUI and emotion MUST be pinned, for the same reason echarts is pinned
      // below: they have to land in ONE optimizer run. When the dependency scan
      // is incomplete — a single unresolvable import anywhere in the graph
      // aborts it, including one from the private tree — Vite discovers them
      // lazily instead and can end up with TWO @emotion/react instances
      // ("You are loading @emotion/react when it is already loaded"). The
      // ThemeProvider then writes into one instance's ThemeContext while every
      // styled component reads the other's, so all of MUI silently falls back
      // to its DEFAULT LIGHT theme: white Paper surfaces and, because the
      // default theme also carries fontSize 14 instead of 13 and no Inter,
      // a visibly shifted layout. Pinning keeps a single instance regardless.
      '@mui/material',
      '@mui/material/styles',
      '@mui/icons-material',
      '@emotion/react',
      '@emotion/styled',
      'read-excel-file',
      'meshoptimizer',
      'monaco-editor/esm/vs/editor/editor.api',
      // The PUBLIC Monaco loaders (script editor, JSON field editor — plan-555)
      // import the package ROOT (it carries the TS / JSON language services);
      // unlisted, its first lazy import re-optimized and reloaded the page
      // ("new dependencies optimized: monaco-editor"). Pre-bundled together
      // with editor.api above, both share ONE editor core instance.
      'monaco-editor',
      // JSON path ↔ text range of the JSON field editor (plan-555), lazy as well.
      'jsonc-parser',
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/loaders/USDZLoader.js',
      'three/examples/jsm/loaders/FBXLoader.js',
      'three/examples/jsm/libs/fflate.module.js',
      'echarts/core',
      'echarts/charts',
      'echarts/components',
      'echarts/renderers',
      // The cinematic renderer's path tracer (plan-550, private, lazy, itself excluded below)
      // imports these; discovering one mid-session re-optimizes and RELOADS the page — in the
      // middle of a recording (seen with Pass.js in the first CLI smoke).
      'three-mesh-bvh/webgpu',
      // plan-767 run 4 (private, lazy): the ray traced TLAS worker builds with three-mesh-bvh's own
      // buildPackedTree — first discovered on the first TLAS rebuild, i.e. mid-simulation.
      'three-mesh-bvh/src/core/build/buildTree.js',
      'three/webgpu',
      'three/tsl',
      'three/examples/jsm/postprocessing/Pass.js',
      // Teams SDK, lazily imported in src/main.ts — its first discovery mid-run re-optimized and
      // reloaded the page ("Vite unexpectedly reloaded a test", plan-602 acceptance 2026-10-15, plan-569).
      '@microsoft/teams-js',
      // Named only by the vi.mock() in tests/rv-fpv-plugin.test.ts — discovered mid-run in the full
      // browser suite (2026-10-16: "new dependencies optimized" → "optimized dependencies changed.
      // reloading"). Same class of fix as teams-js above.
      'three/addons/controls/PointerLockControls.js',
      // plan-764 (@rv-private, lazy): the USD export imports USDZExporter, the USD import provider
      // imports USDLoader (USDZLoader above is no longer the specifier it imports). Unlisted, each
      // re-optimized mid-run — red under RV_TEST_STRICT_DEPS=fail (full suite 2026-10-16).
      'three/examples/jsm/exporters/USDZExporter.js',
      'three/examples/jsm/loaders/USDLoader.js',
      // Browser-vitest CHILDREN of node tests (tests/des/_child-vitest.ts) keep their generated test file
      // under node_modules/.<name>/, which Vite's dependency scan skips - so on a cold optimizer cache the
      // whole app graph was discovered lazily, after the first test ("[test-deps] 39 mid-run
      // re-optimizations" -> exit 1 although every test passed). Pinned here, a cold child
      // pre-bundles them before its first test. Same remedy as every entry above.
      '@mui/icons-material/AccountTree',
      '@mui/icons-material/Add',
      '@mui/icons-material/ArrowDownward',
      '@mui/icons-material/ArrowForward',
      '@mui/icons-material/ArrowUpward',
      '@mui/icons-material/Bolt',
      '@mui/icons-material/Check',
      '@mui/icons-material/ChevronLeft',
      '@mui/icons-material/ChevronRight',
      '@mui/icons-material/Close',
      '@mui/icons-material/ContentCopy',
      '@mui/icons-material/DragIndicator',
      '@mui/icons-material/ErrorOutline',
      '@mui/icons-material/ExpandMore',
      '@mui/icons-material/FileUploadOutlined',
      '@mui/icons-material/GridViewOutlined',
      '@mui/icons-material/HourglassEmpty',
      '@mui/icons-material/InfoOutlined',
      '@mui/icons-material/Link',
      '@mui/icons-material/LinkOff',
      '@mui/icons-material/Public',
      '@mui/icons-material/PushPin',
      '@mui/icons-material/Remove',
      '@mui/icons-material/Search',
      '@mui/icons-material/SettingsInputComponent',
      '@mui/icons-material/SlideshowOutlined',
      '@mui/icons-material/Speed',
      '@mui/icons-material/TouchApp',
      '@mui/icons-material/ViewQuiltOutlined',
      '@mui/icons-material/WarningAmber',
      '@mui/utils',
      'fuse.js',
      'mqtt',
      'react-dom/client',
      'three/addons/lines/Line2.js',
      'three/addons/lines/LineGeometry.js',
      'three/addons/lines/LineMaterial.js',
      'three/addons/lines/LineSegments2.js',
      'three/addons/lines/LineSegmentsGeometry.js',
    ],
    // three-mesh-bvh/worker (lazily imported by rv-bvh-build-port.ts) MUST be
    // excluded, not included: pre-bundling relocates the module to
    // .vite/deps/, which breaks its internal
    // `new Worker(new URL('./generateMeshBVH.worker.js', import.meta.url))` —
    // the worker file does not exist next to the pre-bundled chunk, the
    // Worker dies on load ("GenerateMeshBVHWorker: undefined") and every BVH
    // build falls back to the inline main-thread path. Excluding serves the
    // module from node_modules source so import.meta.url resolves correctly,
    // AND avoids the mid-session reload just the same (excluded deps are
    // never optimized, so their discovery cannot trigger a re-bundle).
    // @dimforge/rapier3d-compat (plan-276): the private Rapier loader's literal dynamic import
    // (aliased to the Private~ copy, see resolve.alias) would otherwise be discovered by the dev
    // optimizer and re-bundled on every physics test run (esbuild "build was canceled" churn),
    // so the package must never be optimized.
    // three-gpu-pathtracer / oidn-web (plan-550) live in the PRIVATE package's node_modules and
    // are imported lazily by the cinematic renderer: discovering them mid-session would re-optimize
    // and RELOAD the page — in the middle of a cinematic recording. Excluded, they are served as
    // the plain ESM they ship as; their own `three` / `three-mesh-bvh` imports resolve to the
    // main project's copies (privateResolverPlugin).
    // @petamoriken/float16 is oidn-web's only dependency and lives next to it (private node_modules).
    // box2d3-wasm (plan-661) is a lazy private WASM dependency: never pre-bundled (its glue resolves
    // the .wasm via `new URL(..., import.meta.url)`, which pre-bundling would break).
    exclude: ['three-mesh-bvh/worker', '@dimforge/rapier3d-compat', 'three-gpu-pathtracer', 'oidn-web', '@petamoriken/float16', 'box2d3-wasm', 'rv-box2d3-compat', 'rv-box2d3-deluxe'],
  },
  server: {
    host: true,
    // Open the browser only for a person running `npm run dev`. A dev server started by an agent
    // (Claude Code sets CLAUDECODE=1 in its shells) or by CI must never open the user's default
    // browser: on 2026-10-22 an agent's worktree server opened Chrome, whose GPU process grew to
    // 7 GB and starved the machine. RV_VITE_OPEN=1 forces it on, RV_VITE_OPEN=0 forces it off.
    open: process.env.RV_VITE_OPEN
      ? process.env.RV_VITE_OPEN === '1'
      : !process.env.CLAUDECODE && !process.env.CI,
    https: !!process.env.HTTPS,
    // Only present when CONNECT started this server (see RV_HMR_CLIENT_PORT above). Spreading an
    // empty object keeps the shipped default — no `hmr` key at all, client follows window.location —
    // exactly as it was before plan-363.
    ...(RV_HMR_CLIENT_PORT ? { hmr: { clientPort: RV_HMR_CLIENT_PORT } } : {}),
    // Allow serving worker entries from the private sibling folder (e.g. the
    // STEP-import worker `new Worker(new URL('./step-import-worker.ts', …))`).
    // Normal @rv-private imports go through the module graph, but a worker URL
    // is fs-served and would otherwise be blocked as "outside the allow list".
    fs: {
      allow: [
        __dirname,
        ...(HAS_PRIVATE ? [PRIVATE_ROOT, resolve(__dirname, '../projects')] : []),
      ],
    },
    // Allow Tailscale MagicDNS hostnames (*.ts.net) when testing via `tailscale serve`.
    // Without this, Vite returns 403 due to DNS-rebinding protection on non-localhost Host headers.
    allowedHosts: ['.ts.net'],
    headers: {
      'Cache-Control': 'no-store',
    },
    proxy: {
      // Proxy Unity Asset Manager API to avoid CORS restrictions
      '/unity-api': {
        target: 'https://services.api.unity.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/unity-api/, ''),
        secure: true,
      },
    },
    watch: {
      // Native fs events, NOT polling. `usePolling: true, interval: 100` stat'ed
      // every watched file ten times a second and kept an idle dev server at
      // 0.2-0.5 cores in a bare checkout and 1-2 cores in a full one (private
      // repo, dist*, .runtime) — measured 2026-10-26: polling 18-47 %, native
      // ~4 % of one core, HMR on src/ unchanged. Re-enable polling locally only
      // for a filesystem without change events (WSL /mnt, network share) via
      // CHOKIDAR_USEPOLLING=1.
      usePolling: false,
      // `atomic` MUST stay off. chokidar enables it by default whenever it does
      // not poll, and in atomic mode it ignores every path ending in `~` (vim
      // backup files) — which is this project's own root, `realvirtual-WebViewer~`.
      // With it on the watcher saw nothing under the root: no HMR, and a reload
      // kept serving the stale transform (2026-10-30, Vincent's machine).
      atomic: false,
      // A folder-backed PROJECT can live inside the checkout during
      // development — asset-editor saves write files there and must NOT trigger
      // a dev-server full reload. (The `LocalFolderTest/` entry that used to
      // sit here belonged to the retired work folder, plan-709 §2.6.)
      // `public/models/library/**` is still ignored: it is the pre-plan-716
      // nesting and a dev checkout can still hold that scratch folder (Custom/,
      // imports/, .thumbnails/ — all gitignored). Un-ignoring it would make an
      // old local folder start triggering full reloads.
      // Build outputs (dist/, dist-*/) and runtime/smoke scratch (.runtime/,
      // .smoke/) are written by builds and CONNECT, never imported by the dev
      // server — watching them only costs CPU and fires reloads mid-build.
      ignored: [
        '**/public/library/**', '**/public/models/library/**',
        '**/dist/**', '**/dist-*/**', '**/.runtime/**', '**/.smoke/**',
      ],
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    // OFF by default (plan-434 §2.7 / ADR-047). A map carries `sourcesContent`,
    // i.e. the complete original TypeScript — and since the public demo ships the
    // full COMMERCIAL scope (DES, PLC, physics, machining, IK solver, the CAD
    // importers) as a compiled application, an emitted `.map` next to those chunks
    // is the private source code itself, sitting in `dist/`.
    //
    // It was `'hidden'` before: maps emitted, no `//# sourceMappingURL=` comment.
    // That relied on every consumer of `dist/` remembering to drop them — the
    // Bunny upload skips `.map` (scripts/_bunny-lib.mjs) and the CONNECT bundler
    // deletes them — so the protection lived outside the build, in each deploy
    // path separately, and any path that ever forgot would publish the sources.
    // Not emitting them removes the class of mistake instead of patching it.
    //
    // `RV_SOURCEMAP=1` re-enables hidden maps for local debugging. Never set it
    // for a build whose `dist/` is deployed. Nothing requires maps: the tier scans
    // in tests/mechanism-tier.node.test.ts search `.js` and `.map`, and the JS
    // alone keeps them non-vacuous.
    sourcemap: process.env.RV_SOURCEMAP === '1' ? 'hidden' : false,
    // The /dev build profile (RV_DEV_FAST_BUILD=1, set only by `bunny-deploy --dev-fast` → runBuild
    // devFast, i.e. only for the watcher's /dev deploys): no gzip-size report — Vite would gzip
    // every emitted chunk just to print a column nobody reads in a deploy log. Every other build
    // (/demo, customer deliveries, local `npm run build`) is unchanged.
    reportCompressedSize: process.env.RV_DEV_FAST_BUILD !== '1',
    rollupOptions: {
      output: {
        // `/*!` + `@license` marks this as a LEGAL comment. Without those two
        // markers esbuild's minifier drops it during renderChunk — for a long
        // while every emitted chunk shipped without the AGPL header and nobody
        // noticed, because the config still looked correct. Same fix, same
        // reason as vite.embed.config.ts; keep the markers when editing.
        banner: '/*! @license realvirtual WEB | AGPL-3.0-only | '
          + 'Copyright (C) 2025 realvirtual GmbH | https://realvirtual.io */',
        // plan-344 Phase 4: `react-pdf` deliberately has NO manual entry.
        // `DocViewerOverlay` already imports it dynamically, so Rollup splits it
        // on its own. Naming it here did the opposite of what it looked like: the
        // manual group pulled shared React internals into the react-pdf chunk, so
        // the entry chunk ended up importing symbols FROM it and the browser
        // modulepreloaded a PDF renderer on every cold start. Leave it to the
        // automatic split; verified by tests/bundle-splitting.test.ts.
        manualChunks: {
          three: ['three'],
          echarts: ['echarts'],
          'gaussian-splat': ['@mkkellogg/gaussian-splats-3d'],
        },
      },
    },
  },
  test: {
    // At most 75 % of the cores run test files in parallel (vitest's default is all
    // cores but one), so the machine stays usable during a full run.
    // RV_TEST_MAX_WORKERS overrides it — a count (`4`) or a share (`100%`).
    maxWorkers: process.env.RV_TEST_MAX_WORKERS || '75%',
    // plan-606: machine-wide test lock. Under `npm test` the wrapper
    // (scripts/with-test-lock.mjs) holds it and the guard only checks; a direct
    // `npx vitest run` takes it here. ROOT ONLY — never in a project, never via
    // `extends: true`.
    globalSetup: ['./tests/global-lock-guard.ts'],
    // Tests for private-only subsystems (the CAD importers: STEP, JT, USD, Onshape)
    // live in the private sibling so the public mirror does not carry the shape of
    // modules it cannot build. The glob matches nothing in a public-only checkout.
    include: [
      'tests/**/*.test.{ts,tsx}',
      '../realvirtual-WebViewer-Private~/tests/**/*.test.{ts,tsx}',
    ],
    // COMMUNITY edition (private sibling physically absent — deliberately NOT the
    // VITE_PUBLIC_BUILD flag): tests importing private modules can never resolve
    // them, so the generated list excludes them. See
    // scripts/gen-private-test-excludes.mjs + the guard test
    // tests/private-test-excludes.node.test.ts.
    exclude: [
      'tests/**/*.node.test.ts',
      // Same convention on the private side — and it has to be spelled out
      // separately, because the include glob above reaches into that sibling
      // and `*.node.test.ts` also matches `*.test.ts`. Without this line the
      // private Node suites are dragged into the browser run, where the first
      // `node:crypto` import fails them all ("externalized for browser
      // compatibility"). They run, and pass, under `npm run test:node`.
      '../realvirtual-WebViewer-Private~/tests/**/*.node.test.ts',
      // WebGPU quarantine fixtures (plan-602 F9): run only as vitest children of
      // tests/quarantine.node.test.ts, in Node — never in the browser suite.
      'tests/fixtures/quarantine/**',
      ...privateDependentTestExcludes(),
    ],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      api: { port: 5177 },
      /**
       * plan-707 — the MCP documentation write path.
       *
       * The renderer runs in the BROWSER (the tool classes pull Three.js and
       * the viewer, so there is no honest way to instantiate them in Node), but
       * the files it writes are on disk. `browser.commands` is the documented
       * bridge for exactly that: a Node-side function a browser test can call.
       *
       * It is a WRITE path, so it is deliberately narrow. It refuses unless
       * `RV_UPDATE_MCP_DOCS=1` is set (which is all `npm run gen:mcp-docs`
       * does), it only ever touches the six registered documentation files, and
       * it replaces only the text between a matching marker pair — every byte
       * of prose outside the fences is preserved by `replaceBlock`, and a
       * missing marker throws instead of appending.
       *
       * The drift GATE does not depend on any of this. Without the flag the
       * test only compares and prints the expected block; the convenience of
       * writing it back is a nicety, the gate is the feature.
       */
      commands: {
        writeMcpDocBlock(
          _ctx: unknown,
          relFile: string,
          marker: string,
          rendered: string,
        ): { written: boolean; reason?: string } {
          if (process.env.RV_UPDATE_MCP_DOCS !== '1') {
            return { written: false, reason: 'RV_UPDATE_MCP_DOCS is not set' };
          }
          const allowed = new Set([
            'webviewer.mcp.md',
            'recipes/kinematize-cad-import.md',
            'src/plugins/mcp-bridge/help/layout.md',
            'src/plugins/mcp-bridge/help/simulation.md',
            'src/plugins/mcp-bridge/help/plc.md',
            'src/plugins/mcp-bridge/help/des.md',
          ]);
          if (!allowed.has(relFile)) {
            return { written: false, reason: `${relFile} is not a registered doc file` };
          }
          const abs = resolve(__dirname, relFile);
          const source = readFileSync(abs, 'utf-8');
          const beginPrefix = `<!-- BEGIN GENERATED: ${marker} `;
          const end = `<!-- END GENERATED: ${marker} -->`;
          const beginAt = source.indexOf(beginPrefix);
          const beginEnd = beginAt === -1 ? -1 : source.indexOf('-->', beginAt);
          const endAt = beginEnd === -1 ? -1 : source.indexOf(end, beginEnd);
          if (beginAt === -1 || beginEnd === -1 || endAt === -1) {
            return { written: false, reason: `no marker pair "${marker}" in ${relFile}` };
          }
          // Match the file's own line endings. On Windows these files are
          // routinely CRLF (autocrlf, or any checkout / stash pop), and writing
          // an LF block into a CRLF file turns a content change into a
          // whole-file diff. The gate compares normalised content, so this is
          // purely about keeping the diff honest.
          const eol = source.includes('\r\n') ? '\r\n' : '\n';
          const body = rendered.replace(/\r\n/g, '\n').split('\n').join(eol);
          const next = `${source.slice(0, beginEnd + 3)}${eol}${body}${eol}${source.slice(endAt)}`;
          if (next === source) return { written: false, reason: 'already up to date' };
          writeFileSync(abs, next, 'utf-8');
          return { written: true };
        },

        /**
         * plan-713 Phase 0 — the discover-payload BASELINE writer.
         *
         * Same shape and same reasoning as `writeMcpDocBlock` above: the
         * schemas can only be produced in the browser, the baseline they are
         * frozen into lives on disk. It is a write path, so it refuses unless
         * `RV_UPDATE_MCP_BASELINE=1` is set and it writes exactly ONE file.
         *
         * The baseline is what T1 (delegate-split equivalence) and T4b
         * (payload-reduction gate) compare against; it is never "fixed" to
         * make a red test green — a legitimate tool change updates it in the
         * same commit that changes the tools.
         */
        /**
         * plan-498 Phase 3 — the live FMU smoke (`tests/fmu-live-smoke.e2e.test.ts`)
         * runs only against a REAL CONNECT named by `RV_CONNECT_URL`. Browser
         * tests cannot read the environment, so this read-only command hands
         * the one variable over; unset → the smoke skips.
         */
        connectSmokeUrl(): string | null {
          const url = process.env.RV_CONNECT_URL?.trim();
          return url ? url : null;
        },
        /**
         * plan-498 Phase 4 — writes THE shipped FMU demo model. The model is
         * built in the browser by the asset writer (`tests/fmu-demo-model.build.test.ts`),
         * the file lives on disk. Same narrow shape as the writers above: it
         * refuses unless `RV_BUILD_FMU_DEMO=1` is set and writes exactly one file.
         */
        writeFmuDemoGlb(_ctx: unknown, base64: string): { written: boolean; bytes?: number; reason?: string } {
          if (process.env.RV_BUILD_FMU_DEMO !== '1') {
            return { written: false, reason: 'RV_BUILD_FMU_DEMO is not set' };
          }
          const abs = resolve(__dirname, 'public/demo-realvirtual/fmu-demo.glb');
          const bytes = Buffer.from(base64, 'base64');
          writeFileSync(abs, bytes);
          return { written: true, bytes: bytes.byteLength };
        },
        writeMcpBaseline(_ctx: unknown, contents: string): { written: boolean; reason?: string } {
          if (process.env.RV_UPDATE_MCP_BASELINE !== '1') {
            return { written: false, reason: 'RV_UPDATE_MCP_BASELINE is not set' };
          }
          const abs = resolve(__dirname, 'tests/fixtures/mcp-discover-baseline.json');
          const existing = (() => {
            try { return readFileSync(abs, 'utf-8'); } catch { return null; }
          })();
          if (existing === contents) return { written: false, reason: 'already up to date' };
          writeFileSync(abs, contents, 'utf-8');
          return { written: true };
        },
      },
      // plan-375 phase 0a: pin headless instead of letting it follow
      // `process.env.CI` (vitest's default), which is unset locally and made
      // every local `npm test` pop a visible Chromium window. A visible window
      // costs compositor work per test file and — worse for a suite that
      // measures frame timings — makes results depend on whether the window
      // happens to be focused or occluded.
      // Opt out for visual debugging with `npx vitest --browser.headless=false`
      // (see CLAUDE.md and doc-web-debugging.md).
      headless: true,
    },
  },
}));
