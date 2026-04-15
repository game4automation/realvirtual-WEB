// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
// PWA disabled – always serve fresh content, no service worker caching
// import { VitePWA } from 'vite-plugin-pwa';
import { playwright } from '@vitest/browser-playwright';
import { readdirSync, existsSync, mkdirSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

// ─── Private content detection ──────────────────────────────────────────
const PRIVATE_DIR = resolve(__dirname, '../realvirtual-WebViewer-Private~/src');
const HAS_PRIVATE = existsSync(PRIVATE_DIR) && !process.env.VITE_PUBLIC_BUILD;
console.log(`[rv-build] ${HAS_PRIVATE ? 'Private' : 'Public'} build${process.env.VITE_PUBLIC_BUILD ? ' (forced public via VITE_PUBLIC_BUILD)' : ''}`);
import { exec } from 'node:child_process';


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
              .filter((f: string) => f.endsWith('.test.ts'))
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

// ─── Private project directory (contains project subfolders with models/) ────
const PRIVATE_PROJECTS_DIR = resolve(__dirname, '../realvirtual-WebViewer-Private~/projects');

/**
 * Vite plugin: Discover and serve GLB models from private project folders.
 *
 * Scans `realvirtual-WebViewer-Private~/projects/<name>/models/` for .glb files,
 * serves them under `/private-models/<project>/<file>.glb`, and exposes a
 * `/__api/private-models` JSON manifest for runtime discovery.
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
            const filePath = join(PRIVATE_PROJECTS_DIR, project, 'models', file);
            if (existsSync(filePath)) {
              const stat = statSync(filePath);
              res.setHeader('Content-Type', 'model/gltf-binary');
              res.setHeader('Content-Length', stat.size);
              res.setHeader('Cache-Control', 'no-store');
              createReadStream(filePath).pipe(res);
              return;
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
  if (!HAS_PRIVATE) return null;
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
      if (!normalizedImporter.includes('realvirtual-WebViewer-Private')) return null;
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

export default defineConfig({
  base: process.env.VITE_BASE || './',
  plugins: [
    privateResolverPlugin(),
    privateModelsPlugin(),
    react(),
    // VitePWA disabled – no service worker, always fresh content
    testRunnerPlugin(),
    debugApiPlugin(),
    thumbnailSavePlugin(),
  ].filter(Boolean),
  resolve: {
    alias: {
      '@rv-private': HAS_PRIVATE
        ? PRIVATE_DIR
        : resolve(__dirname, 'src/private-stubs'),
      '@rv-projects': HAS_PRIVATE
        ? resolve(__dirname, '../realvirtual-WebViewer-Private~/projects')
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
  },
  server: {
    open: true,
    https: !!process.env.HTTPS,
    headers: {
      'Cache-Control': 'no-store',
    },
    watch: {
      usePolling: true,
      interval: 100,
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        banner: '/* realvirtual WEB | AGPL-3.0-only | Copyright (C) 2025 realvirtual GmbH | https://realvirtual.io */',
        manualChunks: {
          three: ['three'],
          echarts: ['echarts'],
          rapier: ['@dimforge/rapier3d-compat'],
          'react-pdf': ['react-pdf', 'pdfjs-dist'],
        },
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
