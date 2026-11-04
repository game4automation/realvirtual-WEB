// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mujoco-commercial-tier.node.test.ts — plan-673 O13/O14/O15: the MuJoCo detail
 * physics is a COMMERCIAL feature that reaches the PUBLIC DEMO, and it stays lazy.
 *
 * Thomas, 2026-10-25: *"es soll ins commercial tier aber in der public demo sein"*.
 *
 * ## Why the tier was not where one would look for it
 *
 * `tier-manifest.json` has `defaults: "commercial"` and not one of its rules
 * names `mujoco` or `locomotion` — so a reader checking the manifest concludes
 * the feature is already commercial. It was not. The tier was decided one level
 * up, by the REGISTRATION SITE: `mujoco.register` was imported from
 * `internal-plugins.ts`, and the manifest pins THAT file to `internal`. The
 * demo build (`runBuild` mode `demo`) deletes `RV_INTERNAL`, so `__RV_INTERNAL__`
 * is false, the one dynamic import of `internal-plugins` is dead code, and
 * Rollup emitted none of it. The feature was absent from the demo although no
 * rule said so.
 *
 * This test pins both halves of the fix, because either one alone is silent:
 *
 *  1. the manifest DECLARES `mujoco` and the real resolver puts it on
 *     `commercial` (so a commercial customer workspace generates the call), and
 *  2. the customer block of `private-plugins.ts` registers it while
 *     `internal-plugins.ts` does not — a double registration would be dropped
 *     with a console warning, and the internal-only variant is the bug above.
 *
 * ## And it stays lazy
 *
 * Commercial does not mean eager (house rule 2026-10-23: the FEATURE CODE is
 * lazy and the proof is the BUILD IMPORT GRAPH, not a request that never
 * fires). The stub's own header records the measurement: before it existed the
 * whole locomotion stack sat in the always-loaded chunk. So the graph walk below
 * asserts the stub IS statically reachable from the private entry — the feature
 * declaration must ship, or nothing would ever trigger it — while no module of
 * `src/mujoco/**` is.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { featureTier, loadTierManifest, resolveTier } from '../scripts/_workspace-lib.mjs';
import { dynamicSpecifiers, eagerGraphPaths, norm, resolveSpec } from './helpers/static-import-graph';

const ROOT = resolve(__dirname, '..');
const PRIVATE = resolve(ROOT, '../realvirtual-WebViewer-Private~');
const HAS_PRIVATE = existsSync(resolve(PRIVATE, 'src/private-plugins.ts'));

const read = (p: string): string => readFileSync(resolve(PRIVATE, p), 'utf8');

/** Everything under the private `src/mujoco/` that one entry reaches statically. */
function mujocoModulesIn(entry: string): string[] {
  return eagerGraphPaths(entry).map(norm).filter((f) => f.includes('/realvirtual-WebViewer-Private~/src/mujoco/'));
}

describe.skipIf(!HAS_PRIVATE)('mujoco is a commercial feature (plan-673)', () => {
  const manifest = loadTierManifest(PRIVATE);
  const registration = (id: string): { adapter?: string; activation?: string[] } | undefined =>
    manifest.registrations[id] as { adapter?: string; activation?: string[] } | undefined;

  it('the manifest declares the registration', () => {
    expect(registration('mujoco')?.adapter).toBe('./features/mujoco.register');
  });

  it('the real tier resolver puts it on commercial', () => {
    expect(featureTier(manifest, 'mujoco')).toBe('commercial');
  });

  it('not one tier rule names mujoco or locomotion', () => {
    // The checked claim behind "the manifest already said commercial": the tier
    // came from the registration site, never from a rule. If someone later adds a
    // rule for `src/features/mujoco.register.ts` or `src/mujoco/**`, this fails and
    // the tier decision becomes visible instead of moving under the test's feet.
    expect(manifest.rules.filter((r) => /mujoco|locomotion/i.test(String(r.path)))).toEqual([]);
    expect(resolveTier(manifest, 'src/features/mujoco.register.ts').tier).toBe('commercial');
    expect(resolveTier(manifest, 'src/mujoco/rv-mujoco-plugin.ts').tier).toBe('commercial');
  });

  it('the customer tier registers it, in manifest order, and the internal tier does not', () => {
    const src = read('src/private-plugins.ts');
    const customer = src.split(/if\s*\(\s*__RV_INTERNAL__\s*\)/)[0]!;
    expect(customer).toContain("useFeature(viewer, 'mujoco', () => import('./features/mujoco.register'))");
    // A double registration is dropped by RVViewer.use() with a warning, and
    // provider registries do not necessarily dedupe at all.
    expect(read('src/internal-plugins.ts')).not.toMatch(/import\s*\{[^}]*\}\s*from\s*'\.\/features\/mujoco\.register'/);
    const order = Object.keys(manifest.registrations);
    const used = [...customer.matchAll(/useFeature\(viewer, '([^']+)'/g)].map((m) => m[1]!);
    expect(used).toContain('mujoco');
    // Directly after `physics` in both lists — the file's own contract is
    // "every commercial registration of tier-manifest.json, in manifest order".
    expect(order[order.indexOf('mujoco') - 1]).toBe('physics');
    expect(used[used.indexOf('mujoco') - 1]).toBe('physics');
  });

  it('both plugins and the feature declaration carry the commercial origin', () => {
    const body = read('src/features/mujoco.body.ts');
    expect(body).toMatch(/viewer\.use\(new RVMuJoCoPlugin\(\), 'commercial'\)/);
    expect(body).toMatch(/viewer\.use\(new RVMuJoCoRegionPlugin\(\), 'commercial'\)/);
    expect(body).not.toMatch(/viewer\.use\([^)]*'internal'\)/);
    expect(read('src/features/mujoco.register.ts')).toMatch(/origin: 'commercial'/);
  });

  it('the stub activation equals the manifest activation', () => {
    const stub = read('src/features/mujoco.register.ts');
    const listed = /activation:\s*\[([^\]]*)\]/.exec(stub)?.[1] ?? '';
    const names = [...listed.matchAll(/\b(REGION_TRIGGER|TRIGGER)\b/g)].map((m) => m[1]);
    // The stub builds the two triggers from consts; resolve them to their literals.
    const literal = (constName: string): string => {
      const re = new RegExp(`const ${constName} = '([^']+)'`);
      return re.exec(stub)?.[1] ?? '';
    };
    expect(names.map(literal)).toEqual(registration('mujoco')!.activation);
  });
});

describe.skipIf(!HAS_PRIVATE)('mujoco stays lazy on the commercial tier (plan-673)', () => {
  const entry = resolve(PRIVATE, 'src/private-plugins.ts');

  it('walks a real graph (so an empty result means absence, not a broken walker)', () => {
    expect(eagerGraphPaths(resolve(ROOT, 'src/main.ts')).length).toBeGreaterThan(100);
  });

  it('the feature declaration ships — the private entry imports the stub by a literal import()', () => {
    // Without this the two assertions below would also pass for a feature that is
    // simply not wired up at all, which is the state this change replaced.
    //
    // It is a DYNAMIC edge, and deliberately so: `private-plugins.ts` reaches
    // every customer adapter through `useFeature(..., () => import(...))`, which
    // is what makes Rollup emit each commercial subsystem as its own chunk
    // instead of welding it into the entry chunk (the file says so in its
    // header). Its static graph is therefore the file alone — measured here, so
    // the dynamic edge is not mistaken for the absence of one.
    expect(eagerGraphPaths(entry)).toHaveLength(1);
    const specs = dynamicSpecifiers(read('src/private-plugins.ts'));
    expect(specs).toContain('./features/mujoco.register');
    // A literal, resolvable specifier — a computed one would collapse the
    // features into a single glob chunk.
    expect(resolveSpec(entry, './features/mujoco.register')).not.toBeNull();
  });

  it('no module of the private src/mujoco/ tree rides along with it', () => {
    expect(mujocoModulesIn(entry)).toEqual([]);
    expect(mujocoModulesIn(resolve(PRIVATE, 'src/features/mujoco.register.ts'))).toEqual([]);
  });

  it('nor with the public entry', () => {
    expect(mujocoModulesIn(resolve(ROOT, 'src/main.ts'))).toEqual([]);
  });

  it('the stub reaches the body only through import()', () => {
    expect(read('src/features/mujoco.register.ts')).toMatch(/load:\s*\(\)\s*=>\s*import\('\.\/mujoco\.body'\)/);
    expect(existsSync(resolve(PRIVATE, 'src/features/mujoco.body.ts'))).toBe(true);
  });
});

describe('the demo build carries the commercial tier and no internal tier', () => {
  // `runBuild` spawns npm, so the decision is read where it is made. Mode `demo`
  // must (a) set NEITHER Vite switch — `VITE_PUBLIC_BUILD` would alias
  // `@rv-private` to the stubs and leave the site without a single commercial
  // feature — and (b) delete `RV_INTERNAL` whatever the operator's shell says.
  const lib = readFileSync(resolve(ROOT, 'scripts/_workspace-lib.mjs'), 'utf8');
  const demoBranch = (): string => {
    const at = lib.indexOf("else if (options.mode === 'demo')");
    expect(at, "runBuild's demo branch").toBeGreaterThan(-1);
    return lib.slice(at, lib.indexOf("else { delete env.VITE_PUBLIC_BUILD", at));
  };

  it('deletes RV_INTERNAL, so the internal tier is dead code in the demo', () => {
    expect(demoBranch()).toMatch(/delete env\.RV_INTERNAL;/);
  });

  it('sets neither VITE_PUBLIC_BUILD nor VITE_PRIVATE_BUILD', () => {
    const branch = demoBranch();
    expect(branch).toMatch(/delete env\.VITE_PUBLIC_BUILD;/);
    expect(branch).toMatch(/delete env\.VITE_PRIVATE_BUILD;/);
    expect(branch).not.toMatch(/env\.VITE_PUBLIC_BUILD\s*=/);
    expect(branch).not.toMatch(/env\.VITE_PRIVATE_BUILD\s*=/);
  });
});
