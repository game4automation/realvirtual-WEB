// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * vite-asset-404-guard.node.test.ts — plan-508 F1.
 *
 * The dev server must answer a missing asset with 404 text/plain, never with
 * its SPA `index.html` (the 2026-09-26 `ChainConveyor-1m.glb` poisoning). Vite
 * internals and plugin-owned paths pass untouched; existence is case-exact and
 * file-only, exactly like the Linux storage zone behind the CDN.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The middleware lives in scripts/lib/rv-fs.mjs and is re-exported by vite.config.ts,
// which registers it; importing the config itself would type-check the whole file.
// @ts-expect-error — plain JS Node module, no type declarations by design (scripts/lib).
import { assetNotFoundGuard, existsOnDiskExactly } from '../scripts/lib/rv-fs.mjs';

interface AssetNotFoundGuardOptions {
  base?: string;
  exists?: (rel: string) => boolean;
  roots?: string[];
}

interface FakeRes {
  status: number;
  headers: Record<string, string>;
  body: string;
  writeHead(s: number, h?: Record<string, string>): void;
  end(b?: string): void;
}

function run(url: string, opts: AssetNotFoundGuardOptions, method?: string): { res: FakeRes; nexted: boolean } {
  const res: FakeRes = {
    status: 0, headers: {}, body: '',
    writeHead(s, h) { this.status = s; Object.assign(this.headers, h ?? {}); },
    end(b) { this.body = b ?? ''; },
  };
  let nexted = false;
  assetNotFoundGuard(opts)({ url, method }, res, () => { nexted = true; });
  return { res, nexted };
}

const never = (): boolean => false;
const always = (): boolean => true;

describe('rv-asset-404-guard', () => {
  it('404 text/plain for a missing .glb under /library', () => {
    const { res, nexted } = run('/library/PalletHandling/Nope.glb', { base: '/', exists: never });
    expect(nexted).toBe(false);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toContain('library/PalletHandling/Nope.glb');
  });

  it('guards every sidecar / splat extension anywhere, and models/ paths without an extension', () => {
    for (const url of ['/x/a.kin.json', '/scan.splat', '/scan.ksplat', '/cloud.ply', '/models/readme']) {
      expect(run(url, { base: '/', exists: never }).res.status, url).toBe(404);
    }
  });

  it('passes an existing file, every Vite-internal path and unrelated urls', () => {
    expect(run('/library/x.glb', { base: '/', exists: always }).nexted).toBe(true);
    for (const url of [
      '/@fs/E:/x/y.glb', '/@id/foo.glb', '/src/core/rv-viewer.ts', '/src/fixtures/a.glb',
      '/node_modules/pkg/a.glb', '/private-models/p/a.glb', '/private-assets/p/a.ply',
      '/__api/private-models', '/', '/index.html', '/settings.json',
    ]) {
      expect(run(url, { base: '/', exists: never }).nexted, url).toBe(true);
    }
  });

  it('leaves non-GET requests alone', () => {
    expect(run('/library/x.glb', { base: '/', exists: never }, 'POST').nexted).toBe(true);
    expect(run('/library/x.glb', { base: '/', exists: never }, 'HEAD').res.status).toBe(404);
  });

  it('ignores query strings and decodes percent-escapes when checking the disk', () => {
    const seen: string[] = [];
    run('/models/A%20B.glb?x=1', { base: '/', exists: (rel) => { seen.push(rel); return true; } });
    expect(seen).toEqual(['models/A B.glb']);
  });

  it('treats the dev default base "./" as "/"', () => {
    expect(run('/library/nope.glb', { base: './', exists: never }).res.status).toBe(404);
  });

  describe('against a real tmp publicDir', () => {
    let dir = '';
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'rv-404-guard-'));
      mkdirSync(join(dir, 'library', 'PalletHandling'), { recursive: true });
      writeFileSync(join(dir, 'library', 'PalletHandling', 'A.glb'), 'glTF');
    });
    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

    it('existsOnDiskExactly is case-exact and file-only', () => {
      expect(existsOnDiskExactly(dir, 'library/PalletHandling/A.glb')).toBe(true);
      expect(existsOnDiskExactly(dir, 'library/pallethandling/A.glb')).toBe(false);
      expect(existsOnDiskExactly(dir, 'library/PalletHandling/a.glb')).toBe(false);
      expect(existsOnDiskExactly(dir, 'library/PalletHandling')).toBe(false);
      expect(existsOnDiskExactly(dir, 'library/../library/PalletHandling/A.glb')).toBe(false);
      expect(existsOnDiskExactly(dir, '')).toBe(false);
    });

    it('wrong case, a directory and a base path are 404 / passed correctly', () => {
      const opts = { base: '/', roots: [dir] };
      expect(run('/library/PalletHandling/A.glb', opts).nexted).toBe(true);
      expect(run('/library/pallethandling/A.glb', opts).res.status).toBe(404);
      expect(run('/Library/PalletHandling/A.glb', { ...opts, exists: undefined }).res.status).toBe(404);
      expect(run('/library/PalletHandling', opts).res.status).toBe(404);
      const demo = { base: '/demo/', roots: [dir] };
      expect(run('/demo/library/PalletHandling/A.glb', demo).nexted).toBe(true);
      expect(run('/demo/library/PalletHandling/B.glb', demo).res.status).toBe(404);
      // Outside the base: not this server's asset namespace.
      expect(run('/library/PalletHandling/B.glb', demo).nexted).toBe(true);
    });

    it('a second root (the server root for test fixtures) is consulted too', () => {
      const other = mkdtempSync(join(tmpdir(), 'rv-404-guard-root-'));
      try {
        mkdirSync(join(other, 'tests', 'fixtures'), { recursive: true });
        writeFileSync(join(other, 'tests', 'fixtures', 'f.glb'), 'glTF');
        expect(run('/tests/fixtures/f.glb', { base: '/', roots: [dir, other] }).nexted).toBe(true);
        expect(run('/tests/fixtures/g.glb', { base: '/', roots: [dir, other] }).res.status).toBe(404);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });
});
