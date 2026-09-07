// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * export-ribbon-vectors.mjs — the shared parity fixture for the ribbon mathematics
 * (plan-466 Phase 1).
 *
 * The three portable modules under `src/core/engine/ribbon/` were ported to C#
 * (`Packages/io.realvirtual.professional/Runtime/Ribbon/Math/`). Nothing but a
 * shared set of numbers keeps the two transcriptions honest, so this script runs
 * the TypeScript originals and writes their answers as JSON:
 *
 *   - `tests/fixtures/ribbon-vectors.json`                       (web side)
 *   - `Packages/.../Tests/EditMode/Ribbon/ribbon-vectors.json`   (Unity side)
 *
 * BOTH copies are written in the same run — a generator that writes only one of
 * them is how the two sides silently drift apart. `--no-package` skips the Unity
 * copy for environments without the Unity checkout (a bare web clone).
 *
 * `tests/ribbon-vectors-drift.test.ts` regenerates the payload in memory and
 * compares it against both files, so a change to the mathematics that was not
 * regenerated fails the web test suite.
 *
 * The TypeScript sources are transpiled with esbuild (a Vite dependency, always
 * present) rather than imported through a loader: the three modules import
 * NOTHING, so a plain type-strip is a complete and dependency-free build.
 *
 * Usage:
 *   node scripts/export-ribbon-vectors.mjs [--no-package] [--check]
 *
 *   --check  writes nothing; exits 1 when a file on disk differs from the
 *            freshly generated payload (CI guard).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { transform } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
/** The Unity project root: `<project>/Assets/realvirtual-WebViewer~` -> `<project>`. */
const UNITY_PROJECT = resolve(REPO, '..', '..');
const WEB_FIXTURE = resolve(REPO, 'tests', 'fixtures', 'ribbon-vectors.json');
const PACKAGE_FIXTURE = resolve(
  UNITY_PROJECT,
  'Packages', 'io.realvirtual.professional', 'Tests', 'EditMode', 'Ribbon', 'ribbon-vectors.json',
);

const MODULES = ['ribbon-geometry', 'ribbon-winder-math', 'ribbon-dancer-math'];

/** Transpile the three portable modules and import them. */
async function loadRibbonModules() {
  const out = resolve(tmpdir(), `rv-ribbon-vectors-${process.pid}`);
  mkdirSync(out, { recursive: true });
  const loaded = {};
  for (const name of MODULES) {
    const src = readFileSync(resolve(REPO, 'src', 'core', 'engine', 'ribbon', `${name}.ts`), 'utf8');
    const js = await transform(src, { loader: 'ts', format: 'esm', target: 'es2022' });
    const file = resolve(out, `${name}.mjs`);
    writeFileSync(file, js.code, 'utf8');
    loaded[name] = await import(pathToFileURL(file).href);
  }
  return loaded;
}

/** A circle literal, spelled the way both ports read it. */
function circle(cx, cy, r, side) {
  return { cx, cy, r, side };
}

/** Round-trip a value through JSON so the fixture holds exactly what a reader sees. */
function num(value) {
  return Number.isFinite(value) ? value : null;
}

/** Every `tangentBetween` case: two circles with explicit sides, plus degeneracies. */
function buildTangentCases(geometry) {
  const inputs = [
    // name, a, b
    ['same-side-left', circle(0, 0, 100, 1), circle(600, 0, 50, 1)],
    ['same-side-right', circle(0, 0, 100, -1), circle(600, 0, 50, -1)],
    ['crossed-left-right', circle(0, 0, 100, 1), circle(600, 0, 50, -1)],
    ['crossed-right-left', circle(0, 0, 100, -1), circle(600, 0, 50, 1)],
    ['equal-radii-same-side', circle(0, 0, 120, 1), circle(0, 800, 120, 1)],
    ['diagonal', circle(-250, -180, 90, 1), circle(430, 610, 200, -1)],
    ['negative-quadrant', circle(-900, 250, 300, -1), circle(120, -640, 75, 1)],
    ['large-into-small', circle(0, 0, 450, 1), circle(1500, -200, 60, 1)],
    // Degenerate: no tangent of positive length.
    ['coincident-centres', circle(10, 10, 100, 1), circle(10, 10, 50, 1)],
    ['swallowed-same-side', circle(0, 0, 400, 1), circle(120, 0, 50, 1)],
    ['crossed-too-close', circle(0, 0, 300, 1), circle(400, 0, 200, -1)],
  ];
  return inputs.map(([name, a, b]) => {
    const t = geometry.tangentBetween({ ...a }, { ...b });
    return {
      name,
      a: { ...a },
      b: { ...b },
      tangent: t ? { p0: { x: num(t.p0.x), y: num(t.p0.y) }, p1: { x: num(t.p1.x), y: num(t.p1.y) } } : null,
    };
  });
}

/** Roller chains for `resolveAutoSides` — the Auto rule, in isolation. */
function buildAutoSideCases(geometry) {
  const chains = [
    ['s-layout', [circle(0, 0, 450, 0), circle(1200, 300, 100, 0), circle(2200, -300, 100, 0), circle(3400, 0, 300, 0)]],
    ['straight-line', [circle(0, 0, 100, 0), circle(500, 0, 100, 0), circle(1000, 0, 100, 0)]],
    ['arch-up', [circle(0, 0, 80, 0), circle(500, 400, 80, 0), circle(1000, 0, 80, 0)]],
    ['arch-down', [circle(0, 0, 80, 0), circle(500, -400, 80, 0), circle(1000, 0, 80, 0)]],
    ['mixed-explicit', [circle(0, 0, 200, 1), circle(600, 250, 90, 0), circle(1300, -150, 90, -1), circle(2000, 0, 200, 0)]],
    ['reverse-running', [circle(3400, 0, 300, 0), circle(2200, -300, 100, 0), circle(1200, 300, 100, 0), circle(0, 0, 450, 0)]],
  ];
  return chains.map(([name, rollers]) => {
    const copy = rollers.map((c) => ({ ...c }));
    geometry.resolveAutoSides(copy);
    return { name, rollers: rollers.map((c) => ({ ...c })), resolved: copy.map((c) => c.side) };
  });
}

/** Full path builds: segments, sweeps, lengths — and the error strings. */
function buildSegmentCases(geometry) {
  const chains = [
    ['demo-slitter-lane', [
      circle(0, 0, 450, 1), circle(1500, 600, 100, 0), circle(2600, 600, 100, 0),
      circle(3700, 0, 190, 0), circle(4600, -700, 120, 0), circle(5600, 200, 100, 0),
      circle(6800, 0, 150, 1),
    ]],
    ['two-rollers-only', [circle(0, 0, 300, 1), circle(2000, 0, 150, 1)]],
    ['three-collinear-equal', [circle(0, 0, 100, 1), circle(800, 0, 100, 1), circle(1600, 0, 100, 1)]],
    ['s-wrap-explicit', [circle(0, 0, 200, 1), circle(900, 0, 120, -1), circle(1800, 0, 200, 1)]],
    ['auto-everything', [circle(0, 0, 250, 0), circle(1100, 450, 90, 0), circle(2300, -450, 90, 0), circle(3300, 0, 250, 0)]],
    ['tight-wrap', [circle(0, 0, 60, 1), circle(300, 260, 60, 0), circle(600, 0, 60, 1)]],
    // Errors
    ['too-few-rollers', [circle(0, 0, 100, 1)]],
    ['non-positive-radius', [circle(0, 0, 100, 1), circle(900, 0, 0, 1)]],
    ['no-tangent', [circle(0, 0, 400, 1), circle(120, 0, 50, 1)]],
  ];
  return chains.map(([name, rollers]) => {
    const copy = rollers.map((c) => ({ ...c }));
    const built = geometry.buildRibbonSegments(copy);
    if ('error' in built) {
      return { name, rollers: rollers.map((c) => ({ ...c })), error: built.error };
    }
    return {
      name,
      rollers: rollers.map((c) => ({ ...c })),
      error: null,
      resolvedSides: copy.map((c) => c.side),
      lengthMm: num(built.lengthMm),
      segments: built.segments.map((s) => (s.kind === 'line'
        ? { kind: 'line', x0: num(s.x0), y0: num(s.y0), x1: num(s.x1), y1: num(s.y1), lengthMm: num(s.lengthMm) }
        : {
          kind: 'arc', cx: num(s.cx), cy: num(s.cy), r: num(s.r),
          a0: num(s.a0), sweep: num(s.sweep), lengthMm: num(s.lengthMm),
          wrapAngle: num(geometry.wrapAngle(s)),
        })),
    };
  });
}

/** Sampling on the absolute grid, including the capacity coarsening branch. */
function buildSamplingCases(geometry) {
  const chain = [
    circle(0, 0, 450, 1), circle(1500, 600, 100, 0), circle(2600, 600, 100, 0),
    circle(3700, 0, 190, 0), circle(4600, -700, 120, 0), circle(5600, 200, 100, 0),
    circle(6800, 0, 150, 1),
  ];
  const built = geometry.buildRibbonSegments(chain.map((c) => ({ ...c })));
  const segs = built.segments;
  const short = geometry.buildRibbonSegments([circle(0, 0, 100, 1), circle(1000, 0, 100, 1)]).segments;

  // The chain KEY travels with the case: deriving it from the name is how the first version
  // labelled `zero-step-falls-back` (which runs on `short`) as `demo`, and the C# side then
  // rebuilt a different chain and compared answers that were never meant to match.
  const cases = [
    ['demo-64-per-m', 'demo', segs, 1000 / 64, 4096],
    ['demo-48-per-m', 'demo', segs, 1000 / 48, 4096],
    ['demo-coarsened', 'demo', segs, 1000 / 64, 64],
    ['demo-capacity-2', 'demo', segs, 1000 / 64, 2],
    ['short-exact-grid', 'short', short, 100, 64],
    ['short-remainder', 'short', short, 133, 64],
    ['zero-step-falls-back', 'short', short, 0, 64],
  ];

  return cases.map(([name, chainKey, segments, stepMm, capacity]) => {
    const out = new Float32Array(capacity * geometry.RIBBON_SAMPLE_STRIDE);
    const sampling = geometry.sampleArcLength(segments, stepMm, out);
    // The whole buffer would bloat the fixture without adding coverage: the first
    // three, the middle and the last sample pin the grid, the ends and the
    // interpolation in between.
    const probe = sampling.count > 0
      ? [0, 1, 2, Math.floor(sampling.count / 2), sampling.count - 2, sampling.count - 1]
        .filter((i, k, a) => i >= 0 && i < sampling.count && a.indexOf(i) === k)
      : [];
    return {
      name,
      segmentsOf: chainKey,
      stepMm,
      capacity,
      count: sampling.count,
      resultStepMm: num(sampling.stepMm),
      samples: probe.map((i) => ({
        i,
        x: num(out[i * 4]), y: num(out[i * 4 + 1]),
        tx: num(out[i * 4 + 2]), ty: num(out[i * 4 + 3]),
      })),
    };
  });
}

/** The chains the sampling cases refer to, so the C# side builds the same segments. */
function buildSamplingChains() {
  return {
    demo: [
      circle(0, 0, 450, 1), circle(1500, 600, 100, 0), circle(2600, 600, 100, 0),
      circle(3700, 0, 190, 0), circle(4600, -700, 120, 0), circle(5600, 200, 100, 0),
      circle(6800, 0, 150, 1),
    ],
    short: [circle(0, 0, 100, 1), circle(1000, 0, 100, 1)],
  };
}

function buildWinderCases(winder) {
  const radius = [
    [76.2, 0.1, 0], [76.2, 0.1, 1000], [76.2, 0.1, 250000], [76.2, 3, 120000],
    [150, 0.05, 5e6], [76.2, 0.1, -50], [76.2, 0.1, 1e-9],
  ].map(([coreRadiusMm, thicknessMm, lengthMm]) => ({
    coreRadiusMm, thicknessMm, lengthMm,
    radiusMm: num(winder.radiusFromLengthMm(coreRadiusMm, thicknessMm, lengthMm)),
  }));

  const length = [
    [76.2, 0.1, 76.2], [76.2, 0.1, 50], [76.2, 0.1, 450], [76.2, 3, 450], [150, 0.05, 900],
  ].map(([coreRadiusMm, thicknessMm, radiusMm]) => ({
    coreRadiusMm, thicknessMm, radiusMm,
    lengthMm: num(winder.lengthFromRadiusMm(coreRadiusMm, thicknessMm, radiusMm)),
  }));

  const angular = [
    [800, 200, 1], [-800, 200, 1], [800, 0, 1], [800, 0.0000001, 1],
    [0, 200, 1], [1234.5, 76.2, 1], [-1234.5, 450, 0],
  ].map(([linearSpeedMmPerS, radiusMm, minRadiusMm]) => ({
    linearSpeedMmPerS, radiusMm, minRadiusMm,
    omegaRadPerS: num(winder.angularSpeedRad(linearSpeedMmPerS, radiusMm, minRadiusMm)),
  }));

  return { radius, length, angular };
}

function buildDancerCases(dancer) {
  const strands = [1, 2, 3, 0, -1, 0.5].map((strands) => ({
    strands, normalised: num(dancer.normaliseStrands(strands)),
  }));

  const accumulate = [
    [0, 800, 800, 0.02], [0, 800, 100, 0.02], [500, 100, 800, 0.02],
    [500, 800, 100, 0], [500, 800, 100, -0.02], [-250, 0, 400, 0.05],
  ].map(([lAccMm, vUp, vDown, dt]) => ({
    lAccMm, vUp, vDown, dt, result: num(dancer.accumulate(lAccMm, vUp, vDown, dt)),
  }));

  const position = [
    [0, 0, 2], [0, 300, 2], [0, 300, 1], [50, -300, 3], [0, 300, 0],
  ].map(([homeMm, lAccMm, strands]) => ({
    homeMm, lAccMm, strands, posMm: num(dancer.positionFromAccumulated(homeMm, lAccMm, strands)),
  }));

  const clamp = [
    [0, 0, -200, 200, 2], [150, 0, -200, 200, 2], [250, 0, -200, 200, 2],
    [-250, 0, -200, 200, 2], [200, 0, -200, 200, 2], [-200, 0, -200, 200, 2],
    [80, 50, -150, 150, 3], [400, 50, -150, 150, 1],
    // A mis-authored, reversed pair must normalise rather than go NaN.
    [0, 0, 200, -200, 2],
  ].map(([posMm, homeMm, minMm, maxMm, strands]) => {
    const r = dancer.clampTravel(posMm, homeMm, minMm, maxMm, strands);
    return {
      posMm, homeMm, minMm, maxMm, strands,
      result: { posMm: num(r.posMm), lAccMm: num(r.lAccMm), atMin: r.atMin, atMax: r.atMax },
    };
  });

  return { strands, accumulate, position, clamp };
}

/** The whole payload, without the `generatedAt` header (which is not compared). */
export async function buildRibbonVectors() {
  const mods = await loadRibbonModules();
  const geometry = mods['ribbon-geometry'];
  const winder = mods['ribbon-winder-math'];
  const dancer = mods['ribbon-dancer-math'];
  return {
    sampleStride: geometry.RIBBON_SAMPLE_STRIDE,
    tangentBetween: buildTangentCases(geometry),
    resolveAutoSides: buildAutoSideCases(geometry),
    buildRibbonSegments: buildSegmentCases(geometry),
    samplingChains: buildSamplingChains(),
    sampleArcLength: buildSamplingCases(geometry),
    winder: buildWinderCases(winder),
    dancer: buildDancerCases(dancer),
  };
}

function sourceCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function serialise(cases, commit, generatedAt) {
  return `${JSON.stringify({ generatedAt, sourceCommit: commit, cases }, null, 2)}\n`;
}

/** The payload of a fixture file on disk, or `null` when it is missing/broken. */
export function readFixtureCases(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')).cases ?? null;
  } catch {
    return null;
  }
}

export const RIBBON_VECTOR_FILES = { web: WEB_FIXTURE, package: PACKAGE_FIXTURE };

async function main() {
  const args = process.argv.slice(2);
  const noPackage = args.includes('--no-package');
  const check = args.includes('--check');

  const cases = await buildRibbonVectors();
  const targets = [WEB_FIXTURE];
  if (!noPackage) targets.push(PACKAGE_FIXTURE);

  if (check) {
    let bad = 0;
    const expected = JSON.stringify(cases);
    for (const file of targets) {
      const onDisk = readFixtureCases(file);
      if (onDisk === null) { console.error(`MISSING  ${file}`); bad++; continue; }
      if (JSON.stringify(onDisk) !== expected) { console.error(`STALE    ${file}`); bad++; continue; }
      console.log(`ok       ${file}`);
    }
    process.exit(bad === 0 ? 0 : 1);
  }

  const text = serialise(cases, sourceCommit(), new Date().toISOString());
  for (const file of targets) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
    console.log(`wrote    ${file}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
