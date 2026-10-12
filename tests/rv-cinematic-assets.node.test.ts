// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-553 F8 — the cinematic render's loose assets (OIDN weights + look HDRIs): served by the
 * dev middleware under any base, emitted into a build only with the cinematic renderer, absent
 * in a build without the private tree, staged into customer workspaces with their feature, and
 * listed in the third-party notices.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CINEMATIC_BUNDLE_MARKER, PRIVATE_LOOSE_ASSETS, cinematicAssetsPlugin } from '../scripts/_rv-cinematic-assets.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRIVATE = resolve(ROOT, '../realvirtual-WebViewer-Private~');
const HAS_PRIVATE = existsSync(join(PRIVATE, 'assets'));

type Mw = (req: { url?: string; method?: string }, res: unknown, next: () => void) => void;

function devServer(base: string) {
  let mw: Mw | null = null;
  const plugin = cinematicAssetsPlugin(PRIVATE);
  plugin.configureServer({ config: { base }, middlewares: { use: (f: Mw) => { mw = f; } } });
  /** HEAD request: { status: 'served' | 'next', length } */
  return (url: string): { served: boolean; length: number } => {
    const headers: Record<string, string> = {};
    let ended = false;
    let nexted = false;
    mw!({ url, method: 'HEAD' }, { setHeader: (k: string, v: string) => { headers[k] = v; }, end: () => { ended = true; } }, () => { nexted = true; });
    return { served: ended && !nexted, length: Number(headers['Content-Length'] ?? -1) };
  };
}

function emitted(modules: string[]): string[] {
  const out: string[] = [];
  const plugin = cinematicAssetsPlugin(PRIVATE);
  plugin.generateBundle.call(
    { emitFile: (f: { fileName: string }) => { out.push(f.fileName); }, error: (m: string) => { throw new Error(m); } },
    {},
    { 'assets/index.js': { type: 'chunk', modules: Object.fromEntries(modules.map((m) => [m, {}])) } },
  );
  return out.sort();
}

describe.skipIf(!HAS_PRIVATE)('cinematic loose assets (plan-553 F8)', () => {
  it('lists the look HDRIs next to the OIDN weights; every listed file exists in the private tree', () => {
    expect(PRIVATE_LOOSE_ASSETS.find((a) => a.folder === 'envmaps')?.files).toEqual(['studio.hdr', 'outdoor.hdr']);
    for (const { folder, files } of PRIVATE_LOOSE_ASSETS) {
      for (const f of files) {
        const p = join(PRIVATE, 'assets', folder, f);
        expect(existsSync(p), p).toBe(true);
        expect(statSync(p).size).toBeLessThan(8 * 1024 * 1024); // 1k–2k HDRIs, not 4k+
      }
    }
  });

  it('dev: serves envmaps/*.hdr and oidn/*.tza under "/" and under a sub-path base; anything else falls through', () => {
    for (const base of ['/', '/demo/']) {
      const get = devServer(base);
      const studio = get(`${base}envmaps/studio.hdr`);
      expect(studio.served).toBe(true);
      expect(studio.length).toBe(statSync(join(PRIVATE, 'assets/envmaps/studio.hdr')).size);
      expect(get(`${base}envmaps/outdoor.hdr`).served).toBe(true);
      expect(get(`${base}oidn/rt_hdr.tza`).served).toBe(true);
      // the public preset HDR and unknown names are not this plugin's business
      expect(get(`${base}envmaps/empty_warehouse_01_1k.hdr`).served).toBe(false);
      expect(get(`${base}envmaps/../oidn/rt_hdr.tza`).served).toBe(false);
      expect(get(`${base}envmaps/secret.hdr`).served).toBe(false);
    }
  });

  it('build: emitted only when the cinematic renderer is in the bundle', () => {
    const marker = '/x/realvirtual-WebViewer-Private~/src/cinematic/rv-cinematic-denoiser.ts';
    expect(CINEMATIC_BUNDLE_MARKER.test(marker)).toBe(true);
    expect(emitted([marker])).toEqual(['envmaps/outdoor.hdr', 'envmaps/studio.hdr', 'oidn/rt_hdr.tza', 'oidn/rt_hdr_alb_nrm.tza']);
    expect(emitted(['/x/src/main.ts'])).toEqual([]);
  });

  it('community / core build (no private assets): no plugin at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'rv-no-private-'));
    try {
      expect(cinematicAssetsPlugin(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('customer-workspace staging copies every asset folder together with the cinematic feature', () => {
    const lib = readFileSync(join(ROOT, 'scripts/_workspace-lib.mjs'), 'utf8');
    const m = /const PRIVATE_FEATURE_ASSET_DIRS = (\[.*\]);/.exec(lib);
    expect(m).not.toBeNull();
    const dirs = JSON.parse(m![1].replace(/'/g, '"')) as Array<[string, string]>;
    for (const { folder } of PRIVATE_LOOSE_ASSETS) expect(dirs).toContainEqual(['cinematic-render', folder]);
  });

  it('the vite config uses the shared plugin', () => {
    const cfg = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/import \{ cinematicAssetsPlugin \} from '\.\/scripts\/_rv-cinematic-assets\.mjs'/);
    expect(cfg).toMatch(/cinematicAssets\(\),/);
  });

  it('the notices list the HDRIs (CC0, Poly Haven) by their emitted names', () => {
    const manual = JSON.parse(readFileSync(join(ROOT, 'third-party/manual-components.json'), 'utf8')) as { components: Array<{ license: string; match: string[]; source: string }> };
    for (const name of ['envmaps/studio.hdr', 'envmaps/outdoor.hdr']) {
      const entry = manual.components.find((c) => c.match.includes(name));
      expect(entry, name).toBeTruthy();
      expect(entry!.license).toBe('CC0-1.0');
      expect(entry!.source).toMatch(/^https:\/\/polyhaven\.com\/a\//);
    }
  });
});
