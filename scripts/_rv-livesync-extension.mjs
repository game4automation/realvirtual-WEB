// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Download of the Isaac Sim / Omniverse Kit extension `realvirtual.livesync` (plan-637 Phase 6).
 *
 * The extension's source lives in `integrations/omniverse-kit/`. A build packs the parts a user
 * needs into ONE zip and emits it as `dist/downloads/realvirtual-livesync-<version>.zip`; the dev
 * server answers the same URL from memory. Nothing is written into the repository.
 *
 * Zip layout (one top-level folder, so "Extract here" does not scatter files):
 *
 *   realvirtual-livesync/
 *     exts/realvirtual.livesync/…           the extension (no tests, no __pycache__, no *.pyc)
 *     run_isaac_sim_with_realvirtual.bat
 *     run_isaac_sim_nvidia_only.bat
 *     README.md
 *
 * The version is read from `exts/realvirtual.livesync/config/extension.toml` — the one source the
 * Python side reads too (`realvirtual/livesync/version.py`). The client learns version and path
 * through the `__RV_LIVESYNC_EXT__` define (`{ version, path }` or `null` when the integration
 * folder is not part of the tree, e.g. a staged customer workspace). Only the lazily loaded USD
 * menu / live-link session read it, so the entry chunk does not grow.
 *
 * Plain JS (node:fs/path + fflate) so vite.config.ts and a Node test share it. Listed in
 * `CORE_SCRIPT_FILES` of `_workspace-lib.mjs` because vite.config.ts imports it at config-load
 * time. No shebang in `scripts/*.mjs` (vite-node + CRLF, plan-503).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';

/** Folder of the Kit integration, relative to the WebViewer root. */
export const LIVESYNC_KIT_DIR = 'integrations/omniverse-kit';
/** Top-level folder inside the zip. */
export const LIVESYNC_ZIP_FOLDER = 'realvirtual-livesync';
/** Deploy-relative folder of the download. */
export const LIVESYNC_DOWNLOAD_DIR = 'downloads';
/** Files next to `exts/` that go into the zip. */
export const LIVESYNC_ROOT_FILES = ['run_isaac_sim_with_realvirtual.bat', 'run_isaac_sim_nvidia_only.bat', 'README.md'];
/** Directory names never packed (anywhere below `exts/`). */
const SKIPPED_DIRS = new Set(['tests', '__pycache__', '.pytest_cache']);
/** File suffixes never packed. */
const SKIPPED_SUFFIXES = ['.pyc', '.pyo'];
/** Fixed timestamp for every entry: same input → same bytes. */
const ZIP_MTIME = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/**
 * Version from `extension.toml` (`[package] version = "x.y.z"`).
 * @param {string} kitDir  the `integrations/omniverse-kit` folder
 * @returns {string}
 */
export function readLivesyncVersion(kitDir) {
  const toml = readFileSync(join(kitDir, 'exts', 'realvirtual.livesync', 'config', 'extension.toml'), 'utf8');
  const pkg = toml.split(/^\[/m).find((s) => s.startsWith('package]'));
  const m = pkg && /^\s*version\s*=\s*"([^"]+)"/m.exec(pkg);
  if (!m) throw new Error('[rv-livesync-extension] no [package] version in extension.toml');
  return m[1];
}

/** `realvirtual-livesync-<version>.zip` */
export function livesyncZipName(version) {
  return `${LIVESYNC_ZIP_FOLDER}-${version}.zip`;
}

/** Deploy-relative path of the download, e.g. `downloads/realvirtual-livesync-0.2.0.zip`. */
export function livesyncDownloadPath(version) {
  return `${LIVESYNC_DOWNLOAD_DIR}/${livesyncZipName(version)}`;
}

/**
 * Every file that goes into the zip: `{ rel, abs }`, `rel` with forward slashes relative to
 * `kitDir`, sorted. `tests/`, `__pycache__/` and compiled Python are left out.
 * @param {string} kitDir
 * @returns {Array<{ rel: string, abs: string }>}
 */
export function collectLivesyncFiles(kitDir) {
  const out = [];
  const walk = (absDir, relDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(abs, rel);
      } else if (entry.isFile() && !SKIPPED_SUFFIXES.some((s) => entry.name.endsWith(s))) {
        out.push({ rel, abs });
      }
    }
  };
  walk(join(kitDir, 'exts'), 'exts');
  for (const name of LIVESYNC_ROOT_FILES) {
    const abs = join(kitDir, name);
    if (!existsSync(abs)) throw new Error(`[rv-livesync-extension] missing ${abs}`);
    out.push({ rel: name, abs });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Batch files must keep CRLF line ends (cmd.exe misreads labels otherwise) — whatever git did. */
function normalizeBat(bytes) {
  const text = Buffer.from(bytes).toString('latin1').replace(/\r?\n/g, '\r\n');
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

/**
 * Pack the extension.
 * @param {string} kitDir  the `integrations/omniverse-kit` folder
 * @returns {{ version: string, fileName: string, path: string, entries: string[], bytes: Uint8Array }}
 */
export function buildLivesyncZip(kitDir) {
  const version = readLivesyncVersion(kitDir);
  /** @type {Record<string, [Uint8Array, { mtime: Date }]>} */
  const tree = {};
  const entries = [];
  for (const { rel, abs } of collectLivesyncFiles(kitDir)) {
    let data = new Uint8Array(readFileSync(abs));
    if (rel.toLowerCase().endsWith('.bat')) data = normalizeBat(data);
    const name = `${LIVESYNC_ZIP_FOLDER}/${rel}`;
    tree[name] = [data, { mtime: ZIP_MTIME }];
    entries.push(name);
  }
  const bytes = zipSync(tree, { level: 9 });
  return { version, fileName: livesyncZipName(version), path: livesyncDownloadPath(version), entries, bytes };
}

/**
 * What the client gets through the `__RV_LIVESYNC_EXT__` define: `{ version, path }`, or null
 * when `rootDir` has no Kit integration.
 * @param {string} rootDir  the WebViewer root
 */
export function livesyncClientInfo(rootDir) {
  const kitDir = resolve(rootDir, LIVESYNC_KIT_DIR);
  if (!existsSync(join(kitDir, 'exts'))) return null;
  const version = readLivesyncVersion(kitDir);
  return { version, path: livesyncDownloadPath(version) };
}

/**
 * The Vite plugin: `define` for the client, the dev middleware and the build emit. Without the
 * integration folder it only defines `__RV_LIVESYNC_EXT__ = null`.
 * @param {string} rootDir  the WebViewer root
 */
export function livesyncExtensionPlugin(rootDir) {
  const kitDir = resolve(rootDir, LIVESYNC_KIT_DIR);
  const info = livesyncClientInfo(rootDir);
  return {
    name: 'rv-livesync-extension',
    config() {
      return { define: { __RV_LIVESYNC_EXT__: JSON.stringify(info) } };
    },
    configureServer(server) {
      if (!info) return;
      server.middlewares.use((req, res, next) => {
        const u = (req.url || '').split('?')[0];
        const base = server.config.base || '/';
        if (u !== `${base}${info.path}` && u !== `/${info.path}`) return next();
        // Packed per request: the source may change while the dev server runs, and it is small.
        let zip;
        try {
          zip = buildLivesyncZip(kitDir);
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e instanceof Error ? e.message : e));
          return;
        }
        if (zip.path !== info.path) return next(); // version bumped while running: restart the dev server
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', String(zip.bytes.byteLength));
        res.setHeader('Content-Disposition', `attachment; filename="${zip.fileName}"`);
        if (req.method === 'HEAD') { res.end(); return; }
        res.end(Buffer.from(zip.bytes));
      });
    },
    generateBundle() {
      if (!info) return;
      const zip = buildLivesyncZip(kitDir);
      this.emitFile({ type: 'asset', fileName: zip.path, source: zip.bytes });
    },
  };
}

