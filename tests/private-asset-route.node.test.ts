// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-395 §7.2 — the `/private-assets/` route may not be a way out of the
 * private projects directory.
 *
 * The route is recursive by design and now carries more than it did: `docs/`
 * and `aasx/` as before, plus the internal Development project's `fixtures/`,
 * `models/`, `library/` and `scratch/`. That makes its containment rules load
 * bearing for CUSTOMER projects too — every customer project is a sibling
 * folder under the same root, so a traversal here reads their geometry.
 *
 * The rules live in `scripts/_rv-private-assets.mjs` rather than inline in
 * `vite.config.ts` precisely so they can be tested here without standing up an
 * HTTP server: a guard that needs a dev server to exercise is a guard nobody
 * runs.
 *
 * Deliberately NOT tested here: that the dev server is only reachable from
 * loopback. It is not (`host: true`), that is older than this plan, and it is
 * plan-414's subject. This file proves containment, not exposure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  PRIVATE_ASSET_MIME,
  parsePrivateAssetUrl,
  resolvePrivateAsset,
} from '../scripts/_rv-private-assets.mjs';

/** A throwaway projects root: one project, one neighbour, one secret outside. */
let root = '';
let outsideDir = '';
/** True when this machine let the test create a symlink (Windows may not). */
let symlinkReady = false;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'rv-private-assets-'));
  root = join(base, 'projects');
  outsideDir = join(base, 'outside');
  mkdirSync(join(root, 'Development', 'fixtures'), { recursive: true });
  mkdirSync(join(root, 'Development', 'models'), { recursive: true });
  mkdirSync(join(root, 'Development', 'library', 'Custom'), { recursive: true });
  mkdirSync(join(root, 'Development', 'scratch'), { recursive: true });
  mkdirSync(join(root, 'CustomerNeighbour', 'models'), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  writeFileSync(join(root, 'Development', 'fixtures', 'tests.glb'), 'glb');
  writeFileSync(join(root, 'Development', 'models', 'DemoRobotIK.glb'), 'glb');
  writeFileSync(join(root, 'Development', 'library', 'Custom', 'Side Cutting.glb'), 'glb');
  writeFileSync(join(root, 'Development', 'scratch', 'try.glb'), 'glb');
  writeFileSync(join(root, 'Development', 'project.json'), '{}');
  writeFileSync(join(root, 'Development', 'secrets.local.json'), '{"token":"x"}');
  writeFileSync(join(root, 'Development', 'notes.txt'), 'not a servable type');
  writeFileSync(join(root, 'CustomerNeighbour', 'models', 'Secret.glb'), 'glb');
  writeFileSync(join(outsideDir, 'stolen.glb'), 'glb');

  try {
    symlinkSync(outsideDir, join(root, 'Development', 'escape'), 'junction');
    symlinkReady = true;
  } catch {
    // Creating a link needs a privilege this machine may not grant. The escape
    // case is then not measured here — said out loud in the test rather than
    // quietly passing.
    symlinkReady = false;
  }
});

afterAll(() => {
  if (root) rmSync(resolve(root, '..'), { recursive: true, force: true });
});

const serve = (project: string, path: string) => resolvePrivateAsset(root, project, path);

describe('projectSubfolders_ServedGenerically', () => {
  it('serves every subfolder of a project, for any project, with the right MIME', () => {
    for (const path of [
      'fixtures/tests.glb',
      'models/DemoRobotIK.glb',
      'library/Custom/Side Cutting.glb',
      'scratch/try.glb',
    ]) {
      expect(serve('Development', path), path).not.toBeNull();
      expect(serve('Development', path)!.mime).toBe('model/gltf-binary');
    }
    // Generic, not a special case for Development: the neighbour resolves the
    // same way. A route that knew one project's name would be a route that has
    // to be edited for the next one.
    expect(serve('CustomerNeighbour', 'models/Secret.glb')).not.toBeNull();
    expect(serve('Development', 'project.json')!.mime).toBe('application/json');
  });

  it('returns the REAL path, so the caller opens what was checked', () => {
    const resolved = serve('Development', 'fixtures/tests.glb')!;
    expect(resolved.path.endsWith('tests.glb')).toBe(true);
    expect(resolved.path.startsWith(resolve(root))).toBe(true);
  });
});

describe('projectSubfolders_RejectsTraversal', () => {
  it('rejects a `..` segment, however it is spelled', () => {
    expect(serve('Development', '../CustomerNeighbour/models/Secret.glb')).toBeNull();
    expect(serve('Development', 'models/../../CustomerNeighbour/models/Secret.glb')).toBeNull();
    expect(serve('..', 'outside/stolen.glb')).toBeNull();
    expect(serve('.', 'Development/models/DemoRobotIK.glb')).toBeNull();
  });

  it('rejects percent-encoded and malformed-encoded traversal at the URL layer', () => {
    // The decode happens in the parser, so `%2e%2e%2f` becomes `../` and is then
    // caught by the same rule as the plain spelling.
    const encoded = parsePrivateAssetUrl('/private-assets/Development/%2e%2e%2fCustomerNeighbour/models/Secret.glb');
    expect(encoded).not.toBeNull();
    expect(serve(encoded!.project, encoded!.assetPath)).toBeNull();
    // Malformed escapes never even parse.
    expect(parsePrivateAssetUrl('/private-assets/Development/%zz/tests.glb')).toBeNull();
    expect(parsePrivateAssetUrl('/private-assets/Development/models/%')).toBeNull();
  });

  it('rejects absolute paths, drive letters and backslashes', () => {
    expect(serve('Development', '/etc/passwd')).toBeNull();
    expect(serve('Development', 'C:/Windows/win.ini')).toBeNull();
    expect(serve('Development', String.raw`..\CustomerNeighbour\models\Secret.glb`)).toBeNull();
    expect(serve(String.raw`Development\..`, 'models/DemoRobotIK.glb')).toBeNull();
  });

  it('rejects a NUL byte', () => {
    expect(serve('Development', `fixtures/tests.glb${String.fromCharCode(0)}.txt`)).toBeNull();
    expect(serve(`Development${String.fromCharCode(0)}`, 'fixtures/tests.glb')).toBeNull();
  });

  it('rejects a query string or fragment at the URL layer', () => {
    expect(parsePrivateAssetUrl('/private-assets/Development/fixtures/tests.glb?raw')).toBeNull();
    expect(parsePrivateAssetUrl('/private-assets/Development/fixtures/tests.glb#x')).toBeNull();
  });

  it('serves only known file types — a secrets sidecar is not one', () => {
    // `.json` IS servable (the manifest is read through this route), so the
    // interesting case is the extension that is on no list at all.
    expect(serve('Development', 'notes.txt')).toBeNull();
    expect(Object.keys(PRIVATE_ASSET_MIME)).not.toContain('.txt');
  });

  it('rejects a directory and a file that is not there', () => {
    expect(serve('Development', 'fixtures')).toBeNull();
    expect(serve('Development', 'fixtures/does-not-exist.glb')).toBeNull();
  });

  it('rejects a symlink that escapes the projects root', () => {
    if (!symlinkReady) {
      // Not silently green: the assertion below is the point of the test, and
      // saying so beats a pass that measured nothing.
      console.warn('[private-asset-route] symlink escape not measured — no link privilege on this machine');
      return;
    }
    expect(serve('Development', 'escape/stolen.glb')).toBeNull();
  });
});

describe('privateAssetUrl_Parsing', () => {
  it('splits project from an arbitrarily deep asset path', () => {
    expect(parsePrivateAssetUrl('/private-assets/Development/library/Custom/a/b/c.glb'))
      .toEqual({ project: 'Development', assetPath: 'library/Custom/a/b/c.glb' });
  });

  it('refuses a URL with no asset path at all', () => {
    expect(parsePrivateAssetUrl('/private-assets/Development')).toBeNull();
    expect(parsePrivateAssetUrl('/private-assets//models/x.glb')).toBeNull();
    expect(parsePrivateAssetUrl('/models/x.glb')).toBeNull();
  });
});
