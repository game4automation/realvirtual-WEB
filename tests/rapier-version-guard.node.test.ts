// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Rapier version guard (plan: rapier-import-2026-11-02).
 *
 * The physics engine is a PRIVATE dependency (`Private~/package.json`). Exactly ONE thing decides
 * which copy every mode loads: the `resolve.alias` entry for `@dimforge/rapier3d-compat` in
 * `vite.config.ts` (dev server, vitest browser, PROD build). Two failures used to hide here:
 *  - the project root resolves the bare name to the transitive Rapier 0.12 of `@types/three`
 *    (no WASM at all), or to nothing - and the physics suites silently skipped;
 *  - the bundle contained a different Rapier than the one the package.json declares.
 *
 * Part 1 (always runs, needs the private install): the alias must exist, point INTO the Private~
 * tree, and that copy must satisfy the range in `Private~/package.json`.
 * Part 2 (runs against an existing `dist/`, like the other bundle tests; `RV_REQUIRE_DIST=1`
 * turns an absent dist into a failure): the Rapier WASM the bundle ships must be byte-identical to
 * the installed Private~ copy - the base64 payload survives minification verbatim, so a 160-char
 * probe from the middle of it identifies the build, and it must differ from any 0.12 copy.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(root, '..', 'realvirtual-WebViewer-Private~');
const PKG = '@dimforge/rapier3d-compat';
const hasPrivate = existsSync(join(privateRoot, 'package.json'));
// RV_NO_PRIVATE / VITE_PUBLIC_BUILD: an explicit environment without the private tree - the one
// legitimate skip (the physics provider is not part of such a build).
const noPrivateEnv = process.env.RV_NO_PRIVATE === '1' || !!process.env.VITE_PUBLIC_BUILD;
const requireDist = process.env.RV_REQUIRE_DIST === '1';

/** Minimal semver for the ranges Private~ uses: exact `x.y.z` or caret `^x.y.z` (0.x: minor-locked). */
function satisfies(version: string, range: string): boolean {
  const v = version.split('.').map(Number);
  const m = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!m) throw new Error(`unsupported range "${range}" in Private~/package.json - extend satisfies()`);
  const r = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (!m[1]) return v.join('.') === r.join('.');
  if (v[0] !== r[0]) return false;
  if (r[0] === 0 || m[1] === '~') { if (v[1] !== r[1]) return false; return v[2] >= r[2]; }
  return v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2]);
}

const declaredRange: string = hasPrivate
  ? JSON.parse(readFileSync(join(privateRoot, 'package.json'), 'utf8')).dependencies[PKG]
  : '';

function installedCopy(): string {
  return join(privateRoot, 'node_modules', '@dimforge', 'rapier3d-compat');
}

/** The vite alias target for the bare package name, as the real config resolves it. */
async function aliasTarget(): Promise<string> {
  const cfg = await resolveConfig({ configFile: join(root, 'vite.config.ts'), mode: 'test' }, 'serve');
  const alias = cfg.resolve.alias as Array<{ find: string | RegExp; replacement: string }>;
  const hit = alias.find((a) => a.find === PKG);
  expect(hit, `vite.config.ts resolve.alias has no entry for ${PKG}`).toBeDefined();
  return hit!.replacement;
}

/** 160 base64 characters from the middle of the inlined Rapier WASM of a rapier.mjs. */
function wasmProbe(rapierMjs: string): string {
  const code = readFileSync(rapierMjs, 'utf8');
  const start = code.indexOf('AGFzbQ'); // base64 of the "\0asm" magic
  expect(start, `${rapierMjs} carries no inlined WASM`).toBeGreaterThan(-1);
  const end = code.indexOf('"', start);
  const mid = start + Math.floor((end - start) / 2);
  return code.slice(mid, mid + 160);
}

describe.skipIf(noPrivateEnv || !hasPrivate)('Rapier resolution (single source: vite alias)', () => {
  it('the private package is installed and satisfies Private~/package.json', () => {
    const pj = join(installedCopy(), 'package.json');
    expect(existsSync(pj), `run npm install in ${privateRoot}`).toBe(true);
    const version = JSON.parse(readFileSync(pj, 'utf8')).version as string;
    expect(satisfies(version, declaredRange), `installed ${version} vs declared ${declaredRange}`).toBe(true);
    expect(Number(version.split('.')[1]), 'the physics provider is tuned for Rapier >= 0.20').toBeGreaterThanOrEqual(20);
  });

  it('the vite alias maps the bare name INTO the Private~ copy, never the public tree', async () => {
    const target = realpathSync(await aliasTarget());
    const inside = realpathSync(installedCopy()) + sep;
    expect(target.startsWith(inside), `alias target ${target} is not inside ${inside}`).toBe(true);
    expect(target.includes(`${sep}@types${sep}three${sep}`)).toBe(false);
  });
});

const distAssets = join(root, 'dist', 'assets');
const hasDist = existsSync(distAssets);

describe.skipIf(noPrivateEnv || !hasPrivate || (!hasDist && !requireDist))('Rapier in the production bundle', () => {
  it('dist/ exists (RV_REQUIRE_DIST=1)', () => {
    expect(hasDist, 'run `npm run build` first').toBe(true);
  });

  it('the bundled Rapier WASM is the installed Private~ copy, and only one Rapier is bundled', () => {
    const probe = wasmProbe(join(installedCopy(), 'dist', 'rapier.mjs'));
    const chunks = readdirSync(distAssets).filter((f) => f.endsWith('.js'));
    const carrying = chunks.filter((f) => readFileSync(join(distAssets, f), 'utf8').includes(probe));
    expect(carrying.length, 'no dist chunk carries the installed Rapier 0.20 WASM').toBeGreaterThan(0);
    // exactly one Rapier payload family in the whole bundle
    const magicChunks = chunks.filter((f) => readFileSync(join(distAssets, f), 'utf8').includes('AGFzbQEAAAAB4Q2wAWACf38'));
    expect(magicChunks.sort()).toEqual(carrying.sort());
  }, 60_000);
});
