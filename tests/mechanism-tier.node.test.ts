// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mechanism-tier.node.test.ts — plan-404 Phase 6 / T14: three-tier build proof
 * for the rigid-body mechanism feature.
 *
 * The claim this test has to make good on (plan-404 §2.6, mirroring the
 * plan-309 §2.4 build-exclusion proof):
 *
 *   PUBLIC   — neither `rv_kinematic_solver.wasm` NOR any mechanism HOST code
 *              (solver provider, topology, state blob, manager, findings) is
 *              in the emitted bundle. What stays is the open plumbing: the
 *              registry interface (`rv-kinematic-registry.ts`), the quick-edit
 *              panel SHELL and the op-plan builders.
 *   CUSTOMER — both are present. The feature registers from `private-plugins.ts`
 *              on the CUSTOMER tier, deliberately not `internal-plugins.ts`
 *              (SOL finding 2: the internal tier would make it vanish from
 *              customer deploys).
 *   INTERNAL — both are present.
 *
 * ── The three builds ────────────────────────────────────────────────────────
 * Each tier is a SEPARATE build into its own outDir (`dist/` stays untouched so
 * the existing `bundle-splitting` / `bundle-chunk` tests keep their artifact).
 * PowerShell — no POSIX `VAR=x cmd` prefix:
 *
 *   $env:VITE_PUBLIC_BUILD='1'; npx vite build --outDir dist-public   --emptyOutDir
 *   $env:VITE_PUBLIC_BUILD=$null; $env:VITE_PRIVATE_BUILD='1'
 *   $env:RV_INTERNAL=$null;      npx vite build --outDir dist-customer --emptyOutDir
 *   $env:RV_INTERNAL='1';        npx vite build --outDir dist-internal --emptyOutDir
 *
 * The tier switches are `vite.config.ts`: `VITE_PUBLIC_BUILD` forces
 * `HAS_PRIVATE=false` (so `@rv-private/*` aliases to `src/private-stubs/`), and
 * `RV_INTERNAL` sets `__RV_INTERNAL__` (see doc-deploy.md "Build tiers &
 * feature gating"). Override the directories with `RV_DIST_PUBLIC`,
 * `RV_DIST_CUSTOMER`, `RV_DIST_INTERNAL`.
 *
 * ── Skipping ────────────────────────────────────────────────────────────────
 * A missing tier build SKIPS LOUDLY (a console banner naming the exact command)
 * rather than failing, matching `bundle-chunk.node.test.ts`: the regular node
 * suite must stay build-independent. A release gate that wants the proof runs
 * the three builds first, which arms all three describes.
 *
 * ── Markers ─────────────────────────────────────────────────────────────────
 * Every marker below was verified against real builds (08.08.2026) — found in
 * dist-customer/dist-internal, and zero hits anywhere under dist-public,
 * sourcemaps and binary assets included. They are string literals or property
 * names, so minification preserves them. Codes that LOOK distinctive but are
 * NOT usable were checked and rejected: the component type names
 * (`KinematicMechanism`, `KinematicJoint`) live in the public authoring shell,
 * and the finding codes (`AnchorsApart`, `IdleSpinRod`, …) appear in the public
 * MCP tool description and its help markdown.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PRIVATE_WASM = resolve(
  ROOT,
  '../realvirtual-WebViewer-Private~/src/kinematic-solver/rv_kinematic_solver.wasm',
);

/** Solver ABI symbols — raw-wasm export names, private host only. */
const SOLVER_MARKERS = ['rvk_abi_version', 'rvk_solve_inverse', 'rvk_create'];

/** Host code: manager, mechanism component, solver provider diagnostics. */
const HOST_MARKERS = [
  'wasm instance lost',                 // rv-kinematic-solver-provider.ts
  'viewer exposes no sim loop',         // rv-kinematic-manager.ts
  'a driven joint lost its Drive',      // rv-kinematic-mechanism.ts
];

/** The emitted wasm asset: `assets/rv_kinematic_solver-<hash>.wasm`. */
const SOLVER_WASM = /^rv_kinematic_solver-[\w-]+\.wasm$/;

/**
 * Control marker. Present in EVERY tier — it is the PUBLIC authoring shell
 * (`mechanism-authoring.ts` → `MECHANISM_TYPE`). Without it the absence
 * assertions could pass vacuously against an empty or wrong directory, and the
 * cut would be untested in the other direction: the shell is supposed to stay.
 */
const PUBLIC_SHELL_MARKER = 'KinematicMechanism';

interface Tier {
  readonly name: 'public' | 'customer' | 'internal';
  readonly dir: string;
  readonly command: string;
}

const TIERS: Tier[] = [
  {
    name: 'public',
    dir: process.env.RV_DIST_PUBLIC ?? join(ROOT, 'dist-public'),
    command: "$env:VITE_PUBLIC_BUILD='1'; npx vite build --outDir dist-public --emptyOutDir",
  },
  {
    name: 'customer',
    dir: process.env.RV_DIST_CUSTOMER ?? join(ROOT, 'dist-customer'),
    command: "$env:VITE_PRIVATE_BUILD='1'; npx vite build --outDir dist-customer --emptyOutDir",
  },
  {
    name: 'internal',
    dir: process.env.RV_DIST_INTERNAL ?? join(ROOT, 'dist-internal'),
    command: "$env:RV_INTERNAL='1'; $env:VITE_PRIVATE_BUILD='1'; npx vite build --outDir dist-internal --emptyOutDir",
  },
];

// ─── File collection ────────────────────────────────────────────────────────

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, keep));
    else if (keep(entry.name)) out.push(path);
  }
  return out;
}

const isJs = (name: string) => name.endsWith('.js');
const isMap = (name: string) => name.endsWith('.map');
const isWasm = (name: string) => name.endsWith('.wasm');

/**
 * Files containing `marker`, searched on the raw Buffer — no string decode, so
 * a ~115 MB dist (25 MB JS + 90 MB sourcemaps) scans in a couple of seconds and
 * binary assets are covered by the same pass.
 */
function filesContaining(files: string[], marker: string): string[] {
  const needle = Buffer.from(marker, 'utf8');
  return files.filter((file) => readFileSync(file).includes(needle));
}

/** Every tier build is at least ~180 JS files plus their sourcemaps. */
const SCAN_TIMEOUT = 120_000;

// ─── Tier presence ──────────────────────────────────────────────────────────

const built = new Map<string, boolean>();
for (const tier of TIERS) {
  const ok = existsSync(join(tier.dir, 'index.html'));
  built.set(tier.name, ok);
  if (!ok) {
    console.warn(
      `\n[mechanism-tier] SKIPPING the ${tier.name.toUpperCase()} tier proof — no build at ${tier.dir}\n`
      + `[mechanism-tier]   build it with:  ${tier.command}\n`,
    );
  }
}

function tierOf(name: Tier['name']): Tier {
  return TIERS.find((t) => t.name === name)!;
}

// ─── PUBLIC: the solver and its host must be absent ─────────────────────────

describe.skipIf(!built.get('public'))('public build excludes the mechanism solver + host', () => {
  const dir = () => tierOf('public').dir;

  it('emits no rv_kinematic_solver wasm asset', () => {
    const wasm = walk(dir(), isWasm).map((f) => basename(f));
    expect(wasm.length, 'the build emits wasm assets at all (draco) — scan is live').toBeGreaterThan(0);
    expect(wasm.filter((name) => SOLVER_WASM.test(name))).toEqual([]);
  });

  it('carries no solver ABI symbol in any emitted JS or sourcemap', () => {
    const files = walk(dir(), (n) => isJs(n) || isMap(n));
    expect(files.length).toBeGreaterThan(0);
    for (const marker of SOLVER_MARKERS) {
      expect(filesContaining(files, marker), `public build leaks solver symbol "${marker}"`).toEqual([]);
    }
  }, SCAN_TIMEOUT);

  it('carries no mechanism host code in any emitted JS or sourcemap', () => {
    const files = walk(dir(), (n) => isJs(n) || isMap(n));
    for (const marker of HOST_MARKERS) {
      expect(filesContaining(files, marker), `public build leaks host code "${marker}"`).toEqual([]);
    }
  }, SCAN_TIMEOUT);

  it('does not inline the solver wasm as base64', () => {
    if (!existsSync(PRIVATE_WASM)) {
      console.warn('[mechanism-tier] private wasm not on disk — base64-inline check skipped.');
      return;
    }
    // A base64-embedded copy starts at byte 0, so the base64 of the first 45
    // bytes (a multiple of 3 → stable 60-char prefix, no padding shift) is a
    // literal substring of the embedding. This is narrower than scanning for
    // the generic `AGFzbQ` wasm magic, which legitimately occurs in the public
    // build (the gaussian-splat chunk inlines its own wasm).
    const prefix = readFileSync(PRIVATE_WASM).subarray(0, 45).toString('base64');
    const hits = filesContaining(walk(dir(), isJs), prefix);
    expect(hits, 'solver wasm is embedded base64 in the public build').toEqual([]);
  }, SCAN_TIMEOUT);

  it('still ships the public mechanism panel shell (the cut is host-only)', () => {
    const hits = filesContaining(walk(dir(), isJs), PUBLIC_SHELL_MARKER);
    expect(hits.length, 'public authoring shell missing — absence assertions would be vacuous')
      .toBeGreaterThan(0);
  }, SCAN_TIMEOUT);
});

// ─── CUSTOMER / INTERNAL: both must be present ──────────────────────────────

for (const name of ['customer', 'internal'] as const) {
  describe.skipIf(!built.get(name))(`${name} build includes the mechanism solver + host`, () => {
    const dir = () => tierOf(name).dir;

    it('emits the rv_kinematic_solver wasm asset', () => {
      const wasm = walk(dir(), isWasm).filter((f) => SOLVER_WASM.test(basename(f)));
      expect(wasm.map((f) => basename(f)).join(', ')).toMatch(SOLVER_WASM);
      expect(statSync(wasm[0]!).size, 'wasm artifact is non-empty').toBeGreaterThan(1024);
      console.info(`[mechanism-tier] ${name}: ${basename(wasm[0]!)} (${statSync(wasm[0]!).size} bytes)`);
    });

    it('carries every solver ABI symbol in the emitted JS', () => {
      const files = walk(dir(), isJs);
      for (const marker of SOLVER_MARKERS) {
        const hits = filesContaining(files, marker);
        expect(hits.length, `${name} build is missing solver symbol "${marker}"`).toBeGreaterThan(0);
      }
    }, SCAN_TIMEOUT);

    it('carries the mechanism host code (manager, component, provider)', () => {
      const files = walk(dir(), isJs);
      for (const marker of HOST_MARKERS) {
        const hits = filesContaining(files, marker);
        expect(hits.length, `${name} build is missing host code "${marker}"`).toBeGreaterThan(0);
        console.info(`[mechanism-tier] ${name}: "${marker}" in ${hits.map((f) => basename(f)).join(', ')}`);
      }
    }, SCAN_TIMEOUT);

    it('references the wasm asset from the host chunk, not just as a dangling file', () => {
      const asset = walk(dir(), isWasm).map((f) => basename(f)).find((n) => SOLVER_WASM.test(n))!;
      const hits = filesContaining(walk(dir(), isJs), asset);
      expect(hits.length, `no JS chunk references ${asset}`).toBeGreaterThan(0);
    }, SCAN_TIMEOUT);
  });
}
