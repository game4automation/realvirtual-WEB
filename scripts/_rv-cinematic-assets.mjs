// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Loose runtime assets of the cinematic render (plan-550 F12, generalised by plan-553 F8).
 *
 * The cinematic renderer (private tree, `src/cinematic/`) loads files at runtime relative to the
 * deploy base: the OIDN denoiser weights (`<base>oidn/*.tza`, Intel Open Image Denoise,
 * Apache-2.0) and the HDRIs of its looks (`<base>envmaps/studio.hdr`, `outdoor.hdr`, Poly Haven
 * CC0). They are vendored in the private tree under `assets/<folder>/` — the private package has
 * no `public/` folder. The `hall` look reuses the viewer's own `public/envmaps/` HDR.
 * Each folder lists its files explicitly; nothing else under the folder is ever served.
 *
 * In dev a middleware serves exactly the listed files under `<base><folder>/<file>` (anything
 * else falls through, so `public/envmaps/` keeps working); a build emits them into
 * `dist/<folder>/` ONLY when the cinematic renderer is part of the bundle, so public and core
 * builds stay free of weights and HDRIs. Listed in third-party/manual-components.json. The
 * customer-workspace staging copies the same folders (`PRIVATE_FEATURE_ASSET_DIRS` in
 * `_workspace-lib.mjs`, kept in step by tests/rv-cinematic-assets.node.test.ts).
 *
 * Plain JS without dependencies beyond node:fs/path so vite.config.ts and a Node test share it.
 * No shebang in `scripts/*.mjs` (vite-node + CRLF, plan-503).
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** @type {Array<{ folder: string, files: string[] }>} */
export const PRIVATE_LOOSE_ASSETS = [
  { folder: 'oidn', files: ['rt_hdr_alb_nrm.tza', 'rt_hdr.tza'] },
  { folder: 'envmaps', files: ['studio.hdr', 'outdoor.hdr'] },
];

/** A chunk module that proves the cinematic renderer is part of the bundle. */
export const CINEMATIC_BUNDLE_MARKER = /[\\/]cinematic[\\/]rv-cinematic-denoiser\.ts(\?|$)/;

/**
 * The Vite plugin, or null when `privateRoot` holds none of the asset folders.
 * @param {string} privateRoot  the private tree (`realvirtual-WebViewer-Private~`)
 */
export function cinematicAssetsPlugin(privateRoot) {
  const sets = PRIVATE_LOOSE_ASSETS
    .map(({ folder, files }) => ({ folder, files, src: resolve(privateRoot, 'assets', folder) }))
    .filter((x) => existsSync(x.src));
  if (sets.length === 0) return null;
  return {
    name: 'rv-cinematic-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const u = (req.url || '').split('?')[0];
        const base = server.config.base || '/';
        for (const set of sets) {
          const prefix = u.startsWith(`${base}${set.folder}/`) ? `${base}${set.folder}/` : (u.startsWith(`/${set.folder}/`) ? `/${set.folder}/` : null);
          if (!prefix) continue;
          const name = u.slice(prefix.length);
          const file = join(set.src, name);
          if (!set.files.includes(name) || !existsSync(file)) continue;
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', String(statSync(file).size));
          if (req.method === 'HEAD') { res.end(); return; }
          createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
    generateBundle(_options, bundle) {
      const bundled = Object.values(bundle).some((item) => item.type === 'chunk'
        && Object.keys(item.modules ?? {}).some((id) => CINEMATIC_BUNDLE_MARKER.test(id)));
      if (!bundled) return;
      for (const set of sets) {
        for (const name of set.files) {
          const file = join(set.src, name);
          if (!existsSync(file)) this.error(`[rv-cinematic-assets] missing ${file} — the cinematic render would fail to load it`);
          this.emitFile({ type: 'asset', fileName: `${set.folder}/${name}`, source: readFileSync(file) });
        }
      }
    },
  };
}
