// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
// PWA disabled – always serve fresh content, no service worker caching
// import { VitePWA } from 'vite-plugin-pwa';
import { playwright } from '@vitest/browser-playwright';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';

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
// All git calls are guarded so a git-less build (tarball, CI without .git)
// still produces a valid bundle.
function rvGit(cmd: string, fallback: string): string {
  try {
    return execSync(cmd, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || fallback;
  } catch {
    return fallback;
  }
}
const RV_VERSION = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8'),
).version as string;
const RV_WEB_BUILD = rvGit('git rev-list --count HEAD', '0');
const RV_COMMIT = rvGit('git rev-parse --short HEAD', '');
const RV_BUILD_DATE = rvGit(
  'git log -1 --format=%cd --date=short',
  new Date().toISOString().slice(0, 10),
);
console.log(
  `[rv-build] realvirtual WEB v${RV_VERSION} · web build ${RV_WEB_BUILD}` +
  `${RV_COMMIT ? ` (${RV_COMMIT})` : ''} · ${RV_BUILD_DATE}`,
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
 * Vite plugin: Save library thumbnails to disk.
 * POST /api/library-thumbnail with { catalogId, dataUrl }
 * Writes PNG next to the GLB in public/models/library/.
 */
function thumbnailSavePlugin() {
  function readBody(req: { on: Function }): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => resolve(body));
    });
  }

  return {
    name: 'rv-thumbnail-save',
    apply: 'serve' as const,
    configureServer(server: { config: { root: string }; middlewares: { use: Function } }) {
      server.middlewares.use(async (req: { url?: string; method?: string; on: Function }, res: any, next: Function) => {
        if (req.url !== '/api/library-thumbnail' || req.method !== 'POST') return next();

        try {
          const body = JSON.parse(await readBody(req));
          const { catalogId, dataUrl } = body as { catalogId: string; dataUrl: string };
          if (!catalogId || !dataUrl) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing catalogId or dataUrl' }));
            return;
          }

          // Convert data URL to buffer
          const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
          const buffer = Buffer.from(base64, 'base64');

          // Save next to GLB: use catalogId as filename stem
          const filename = catalogId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.png';
          const outDir = join(server.config.root, 'public/models/library');
          mkdirSync(outDir, { recursive: true });
          const outPath = join(outDir, filename);
          writeFileSync(outPath, buffer);

          const url = `models/library/${filename}`;
          console.log(`[rv-thumbnail] Saved ${outPath}`);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ url }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(e) }));
        }
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

/** MIME types for static assets served from private projects. */
const PRIVATE_ASSET_MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.aasx': 'application/asset-administration-shell-package',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * Vite plugin: Discover and serve GLB models + AASX/PDF assets from private project folders.
 *
 * Scans `realvirtual-WebViewer-Private~/projects/<name>/` for:
 *   - `models/*.glb`  → served under `/private-models/<project>/`
 *   - `aasx/*.aasx`   → served under `/private-assets/<project>/aasx/`
 *   - `pdf/*.pdf`     → served under `/private-assets/<project>/pdf/`
 *
 * Also exposes:
 *   - `GET /__api/private-models` — JSON manifest of all GLB models
 *   - `GET /private-assets/<project>/aasx/index.json` — auto-generated AASX index
 */
function privateModelsPlugin() {
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
  function serveProjectFile(res: any, project: string, subfolder: string, filename: string): boolean {
    const filePath = join(PRIVATE_PROJECTS_DIR, project, subfolder, filename);
    if (!existsSync(filePath)) return false;
    const ext = extname(filename).toLowerCase();
    const mime = PRIVATE_ASSET_MIME[ext] ?? 'application/octet-stream';
    const stat = statSync(filePath);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-store');
    createReadStream(filePath).pipe(res);
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
            if (serveProjectFile(res, project, 'models', file)) return;
          }
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        // Serve private assets: /private-assets/<project>/<path...>
        // Supports arbitrary depth paths (e.g., docs/subfolder/subfolder/file.pdf)
        // as well as flat paths (e.g., docs-index.json, aasx/index.json)
        if (url.startsWith('/private-assets/')) {
          const decoded = decodeURIComponent(url);
          const stripped = decoded.replace('/private-assets/', '');
          const slashIdx = stripped.indexOf('/');
          if (slashIdx > 0) {
            const project = stripped.substring(0, slashIdx);
            const assetPath = stripped.substring(slashIdx + 1);

            // Auto-generate AASX index.json on the fly
            if (assetPath === 'aasx/index.json') {
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

            // Serve any file from the project directory
            const filePath = join(PRIVATE_PROJECTS_DIR, project, assetPath);
            if (existsSync(filePath)) {
              try {
                const fstat = statSync(filePath);
                if (fstat.isFile()) {
                  const ext = extname(filePath).toLowerCase();
                  const mime = PRIVATE_ASSET_MIME[ext] ?? 'application/octet-stream';
                  res.setHeader('Content-Type', mime);
                  res.setHeader('Content-Length', fstat.size);
                  res.setHeader('Cache-Control', 'no-store');
                  createReadStream(filePath).pipe(res);
                  return;
                }
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

export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE || './',
  plugins: [
    privateResolverPlugin(),
    missingStubResolverPlugin(),
    privateModelsPlugin(),
    react(),
    // VitePWA disabled – no service worker, always fresh content
    devServerIdentityPlugin(),
    testRunnerPlugin(),
    debugApiPlugin(),
    thumbnailSavePlugin(),
    presetSavePlugin(),
    dracoDecoderPlugin(),
    stripImpeccableLivePlugin(),
  ].filter(Boolean),
  // Worker builds are a SEPARATE Rollup pass that does NOT inherit the main `plugins`.
  // The STEP-import worker (`step-import-worker.ts`) lives in the private sibling folder and
  // imports bare npm deps like `occt-import-js`; without privateResolverPlugin here, Rollup walks
  // up from the worker file (which has no node_modules) and fails to resolve them. Register the
  // same resolver for the worker pass so private-folder bare imports hit the main node_modules.
  worker: {
    // ES format is required because the STEP-import worker code-splits (it dynamically loads the
    // occt-import-js WASM chunk); Vite's default 'iife' worker format rejects code-splitting builds.
    format: 'es',
    plugins: () => [privateResolverPlugin()].filter(Boolean),
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
      } : {}),
    },
  },
  define: {
    __RV_HAS_PRIVATE__: JSON.stringify(HAS_PRIVATE),
    __RV_COMMERCIAL__: JSON.stringify(!!process.env.RV_COMMERCIAL),
    // Internal/dev-only features (DES, IK solver, STEP import, layout cloud, …).
    // Dev server (and vitest, which runs in serve mode) always ON; production
    // builds only with RV_INTERNAL=1. Customer deploys (stagePrivateProject /
    // deploy:private) never set it, so Rollup eliminates the gated dynamic
    // import in internal code paths and its chunks never reach the bundle.
    __RV_INTERNAL__: JSON.stringify(command === 'serve' || !!process.env.RV_INTERNAL),
    __RV_VERSION__: JSON.stringify(RV_VERSION),
    __RV_WEB_BUILD__: JSON.stringify(RV_WEB_BUILD),
    __RV_COMMIT__: JSON.stringify(RV_COMMIT),
    __RV_BUILD_DATE__: JSON.stringify(RV_BUILD_DATE),
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
    // echarts sub-entries (core/charts/components/renderers, all via
    // echarts-setup.ts) MUST be pre-bundled together: without pinning, a
    // mid-session dep re-optimization can split echarts into two optimized
    // instances, and the second instance re-runs its component registration
    // against a core that already has them → uncaught "axisPointer
    // CartesianAxisPointer exists". Pinning keeps a single echarts instance.
    include: [
      'read-excel-file',
      'monaco-editor/esm/vs/editor/editor.api',
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/loaders/USDZLoader.js',
      'three/examples/jsm/loaders/FBXLoader.js',
      'three/examples/jsm/libs/fflate.module.js',
      'echarts/core',
      'echarts/charts',
      'echarts/components',
      'echarts/renderers',
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
    // @dimforge/rapier3d-compat (plan-276) is an OUT-OF-BAND dependency (not
    // in package.json — Omniverse pattern §2.8): the private Rapier loader
    // contains a PROD-only literal dynamic import that the dev optimizer
    // would otherwise discover and re-bundle on every physics test run
    // (esbuild "build was canceled" churn). In dev/vitest the loader uses the
    // /node_modules URL import, so the package must never be optimized.
    exclude: ['three-mesh-bvh/worker', '@dimforge/rapier3d-compat'],
  },
  server: {
    host: true,
    open: true,
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
      usePolling: true,
      interval: 100,
      // A folder-backed PROJECT can live inside the checkout during
      // development — asset-editor saves write files there and must NOT trigger
      // a dev-server full reload. (The `LocalFolderTest/` entry that used to
      // sit here belonged to the retired work folder, plan-709 §2.6.)
      ignored: ['**/public/models/library/**'],
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
            'src/plugins/mcp-bridge/help/editor.md',
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
