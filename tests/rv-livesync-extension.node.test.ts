// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-637 Phase 6 — the Isaac Sim extension download (`scripts/_rv-livesync-extension.mjs`):
 * zip name carries the `extension.toml` version, the zip holds exactly the extension, the two
 * start scripts and the README under one folder (no tests, no __pycache__), batch files keep
 * CRLF, the same input packs to the same bytes, and the build wiring (vite.config.ts import +
 * delivery staging list) is in place.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import {
  LIVESYNC_KIT_DIR,
  buildLivesyncZip,
  livesyncClientInfo,
  livesyncExtensionPlugin,
  readLivesyncVersion,
} from '../scripts/_rv-livesync-extension.mjs';

const ROOT = resolve(__dirname, '..');
const KIT = resolve(ROOT, LIVESYNC_KIT_DIR);

/** A minimal Kit integration tree with the files the real one has plus the ones to leave out. */
function fakeKit(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rv-livesync-'));
  const ext = join(dir, 'exts', 'realvirtual.livesync');
  mkdirSync(join(ext, 'config'), { recursive: true });
  mkdirSync(join(ext, 'realvirtual', 'livesync', '__pycache__'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(ext, 'config', 'extension.toml'), `[package]\nversion = "${version}"\ntitle = "x"\n\n[settings]\nversion = "9.9.9"\n`);
  writeFileSync(join(ext, 'realvirtual', 'livesync', '__init__.py'), '# init\n');
  writeFileSync(join(ext, 'realvirtual', 'livesync', '__pycache__', 'x.cpython-310.pyc'), 'bytecode');
  writeFileSync(join(ext, 'realvirtual', 'livesync', 'stale.pyc'), 'bytecode');
  writeFileSync(join(dir, 'tests', 'test_x.py'), 'def test(): pass\n');
  writeFileSync(join(dir, 'run_isaac_sim_with_realvirtual.bat'), '@echo off\nset A=1\n');
  writeFileSync(join(dir, 'run_isaac_sim_nvidia_only.bat'), '@echo off\r\ncall x\r\n');
  writeFileSync(join(dir, 'README.md'), '# readme\n');
  return dir;
}

describe('livesync extension zip (plan-637 Phase 6)', () => {
  it('names the zip after the extension.toml [package] version', () => {
    const dir = fakeKit('1.4.2');
    try {
      expect(readLivesyncVersion(dir)).toBe('1.4.2');
      const zip = buildLivesyncZip(dir);
      expect(zip.version).toBe('1.4.2');
      expect(zip.fileName).toBe('realvirtual-livesync-1.4.2.zip');
      expect(zip.path).toBe('downloads/realvirtual-livesync-1.4.2.zip');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packs exts, the two start scripts and the README under one folder — no tests, no bytecode', () => {
    const dir = fakeKit('0.2.0');
    try {
      const files = unzipSync(buildLivesyncZip(dir).bytes);
      expect(Object.keys(files).sort()).toEqual([
        'realvirtual-livesync/README.md',
        'realvirtual-livesync/exts/realvirtual.livesync/config/extension.toml',
        'realvirtual-livesync/exts/realvirtual.livesync/realvirtual/livesync/__init__.py',
        'realvirtual-livesync/run_isaac_sim_nvidia_only.bat',
        'realvirtual-livesync/run_isaac_sim_with_realvirtual.bat',
      ]);
      // Batch files always CRLF (a LF checkout must not break cmd.exe), no doubled CR.
      expect(strFromU8(files['realvirtual-livesync/run_isaac_sim_with_realvirtual.bat'])).toBe('@echo off\r\nset A=1\r\n');
      expect(strFromU8(files['realvirtual-livesync/run_isaac_sim_nvidia_only.bat'])).toBe('@echo off\r\ncall x\r\n');
      expect(strFromU8(files['realvirtual-livesync/README.md'])).toBe('# readme\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic: the same input packs to the same bytes', () => {
    const dir = fakeKit('0.2.0');
    try {
      expect(Buffer.from(buildLivesyncZip(dir).bytes).equals(Buffer.from(buildLivesyncZip(dir).bytes))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packs the real integration: version 0.2.1, the extension package, no tests', () => {
    const zip = buildLivesyncZip(KIT);
    expect(zip.version).toBe('0.2.1');
    expect(zip.entries).toContain('realvirtual-livesync/exts/realvirtual.livesync/realvirtual/livesync/server.py');
    expect(zip.entries).toContain('realvirtual-livesync/exts/realvirtual.livesync/realvirtual/livesync/version.py');
    expect(zip.entries).toContain('realvirtual-livesync/exts/realvirtual.livesync/realvirtual/livesync/port_owner.py');
    expect(zip.entries).toContain('realvirtual-livesync/run_isaac_sim_nvidia_only.bat');
    expect(zip.entries).toContain('realvirtual-livesync/run_isaac_sim_with_realvirtual.bat');
    expect(zip.entries).toContain('realvirtual-livesync/README.md');
    expect(zip.entries.some((e) => /\/tests\/|__pycache__|\.pyc$/.test(e))).toBe(false);
    expect(zip.entries.every((e) => e.startsWith('realvirtual-livesync/'))).toBe(true);
  });

  it('client info: version + path for this tree, null without the integration folder', () => {
    expect(livesyncClientInfo(ROOT)).toEqual({ version: '0.2.1', path: 'downloads/realvirtual-livesync-0.2.1.zip' });
    const empty = mkdtempSync(join(tmpdir(), 'rv-livesync-empty-'));
    try {
      expect(livesyncClientInfo(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('the viewer minimum is not newer than the shipped extension', async () => {
    const { MIN_EXTENSION_VERSION, compareVersions } = await import('../src/plugins/usd-live-link/livesync-extension');
    expect(compareVersions(MIN_EXTENSION_VERSION, readLivesyncVersion(KIT))).toBeLessThanOrEqual(0);
  });

  it('plugin: defines the client info and serves the zip in dev under the build URL', () => {
    const plugin = livesyncExtensionPlugin(ROOT) as unknown as {
      config(): { define: Record<string, string> };
      configureServer(server: unknown): void;
    };
    expect(JSON.parse(plugin.config().define.__RV_LIVESYNC_EXT__)).toEqual({
      version: '0.2.1', path: 'downloads/realvirtual-livesync-0.2.1.zip',
    });
    let middleware: ((req: unknown, res: unknown, next: () => void) => void) | null = null;
    plugin.configureServer({ config: { base: '/' }, middlewares: { use: (fn: typeof middleware) => { middleware = fn; } } });
    const call = (url: string) => {
      const headers: Record<string, string> = {};
      const res = {
        statusCode: 200, body: null as Buffer | null,
        setHeader: (k: string, v: string) => { headers[k] = v; },
        end: (b?: Buffer) => { res.body = b ?? null; },
      };
      let passed = false;
      middleware!({ url, method: 'GET' }, res, () => { passed = true; });
      return { res, headers, passed };
    };
    const hit = call('/downloads/realvirtual-livesync-0.2.1.zip?x=1');
    expect(hit.passed).toBe(false);
    expect(hit.headers['Content-Type']).toBe('application/zip');
    expect(Object.keys(unzipSync(new Uint8Array(hit.res.body!)))).toContain('realvirtual-livesync/README.md');
    expect(call('/downloads/other.zip').passed).toBe(true);
    // Without the integration folder: define null, no middleware.
    const empty = mkdtempSync(join(tmpdir(), 'rv-livesync-empty-'));
    try {
      const none = livesyncExtensionPlugin(empty) as unknown as typeof plugin;
      expect(none.config().define.__RV_LIVESYNC_EXT__).toBe('null');
      const use = vi.fn();
      none.configureServer({ config: { base: '/' }, middlewares: { use } });
      expect(use).not.toHaveBeenCalled();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('is wired into the build and the delivery staging list', () => {
    const cfg = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/import \{ livesyncExtensionPlugin \} from '\.\/scripts\/_rv-livesync-extension\.mjs'/);
    expect(cfg).toMatch(/livesyncExtensionPlugin\(__dirname\)/);
    const lib = readFileSync(join(ROOT, 'scripts', '_workspace-lib.mjs'), 'utf8');
    expect(lib).toContain("'_rv-livesync-extension.mjs', '_rv-livesync-extension.d.mts'");
  });
});
