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

const MODULES = ['ribbon-geometry', 'ribbon-winder-math', 'ribbon-dancer-math',
  'ribbon-tension-math', 'ribbon-sag-math'];

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

/**
 * The same circle with a plan-468 end wrap on it, in RADIANS.
 *
 * It is a separate helper rather than a sixth parameter of {@link circle} so
 * every pre-468 case keeps serialising WITHOUT a `wrapRad` key — which is what
 * makes their fixture entries byte-identical to the ones the C# side already
 * reads (a `"wrapRad": null` on 20 cases would be a diff with no meaning).
 */
function wrapped(c, wrapDeg) {
  return { ...c, wrapRad: (wrapDeg * Math.PI) / 180 };
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
    // plan-468 end wraps. The three shapes a port can get wrong independently:
    // the PRE-arc's `a0 = a1 - side*wrapRad` on a CCW end, the POST-arc's sweep
    // sign on a CW one, and both at once on a chain that also has an inner arc.
    ['start-wrap-left', [wrapped(circle(0, 0, 400, 1), 270), circle(2000, 0, 150, 1)]],
    ['end-wrap-right', [circle(0, 0, 200, -1), wrapped(circle(2000, 0, 90, -1), 270)]],
    ['both-ends-wrapped', [
      wrapped(circle(0, 0, 450, 1), 180), circle(1500, 600, 100, 0),
      wrapped(circle(3400, 0, 190, 1), 90),
    ]],
    // Over a full turn: the sweep is NOT normalised into [0, 2pi) — the inner-arc
    // rule would fold 450 deg back to 90 and lose a whole lap of paper.
    ['start-wrap-over-full-turn', [wrapped(circle(0, 0, 300, -1), 450), circle(2500, 400, 120, -1)]],
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


/**
 * Like {@link num}, but collapses a NEGATIVE ZERO onto `+0`.
 *
 * `-0` and `0` serialise to the same JSON text but are NOT `Object.is`-equal, so the
 * drift test comparing a freshly built payload against the parsed file fails on a
 * value it cannot even show as different. `f'(1)` of the sag profile produces one.
 */
function numz(value) {
  if (!Number.isFinite(value)) return null;
  return value === 0 ? 0 : value;
}

/** The thresholds a `classify` / `bandDeviation` case runs against. */
function thresholds(minStrain, maxStrain, breakStrain, refStrain, tolerance) {
  return { minStrain, maxStrain, breakStrain, refStrain, tolerance };
}

/**
 * The tension mathematics (plan-471): the steady state, the implicit step INCLUDING
 * its stability branch, the two force conversions, the classification at every
 * threshold, the band deviation and the unit conversions.
 */
function buildTensionCases(tension) {
  const steady = [
    [0.01, 800, 784], [0.01, 800, 816], [0.01, 800, 800], [0.01, 800, 900],
    [0, 800, 800], [0.02, 0, 500], [-0.005, 600, 620],
    // Undefined: a stopped or reversed exit has no stationary solution.
    [0.01, 800, 0], [0.01, 800, -400], [Number.NaN, 800, 784],
  ].map(([epsIn, vA, vB]) => ({
    epsIn: numz(epsIn), vA, vB, eps: numz(tension.strainSteadyState(epsIn, vA, vB)),
  }));

  // A SERIES rather than a single step: the whole point of the implicit form is what it
  // does over many ticks, and the stability row (L = 1 mm, vB = 1000 mm/s, dt = 0.02 s,
  // i.e. dt*vB/L = 20) is exactly where the explicit form blows up.
  const step = [
    ['converging-slack', 0.01, 0.01, 800, 784, 800, 0.02, 20],
    ['converging-taut', 0.01, 0.01, 800, 816, 800, 0.02, 20],
    ['stability-short-zone', 0.01, 0.01, 800, 1000, 1, 0.02, 10],
    ['standing-web-keeps-strain', 0.013, 0.01, 0, 0, 500, 0.02, 5],
    ['backwards-freezes', 0.013, 0.01, 800, -100, 500, 0.02, 3],
    ['paused-frame', 0.013, 0.01, 800, 700, 500, 0, 3],
    ['zero-length', 0.013, 0.01, 800, 700, 0, 0.02, 3],
    ['entering-strain-passes-through', 0, 0.02, 500, 500, 250, 0.02, 15],
  ].map(([name, eps0, epsIn, vA, vB, lengthMm, dt, steps]) => {
    const results = [];
    let eps = eps0;
    for (let i = 0; i < steps; i++) {
      eps = tension.strainStepImplicit(eps, epsIn, vA, vB, lengthMm, dt);
      results.push(numz(eps));
    }
    return { name, eps0, epsIn, vA, vB, lengthMm, dt, steps, results };
  });

  const fromStrain = [
    [10, 500, 0.01], [10, 500, 0], [10, 500, -0.02], [0, 500, 0.01], [10, 0, 0.01],
    [2.5, 1200, 0.035],
  ].map(([stiffness, widthMm, eps]) => ({
    stiffness, widthMm, eps, tensionN: numz(tension.tensionFromStrain(stiffness, widthMm, eps)),
  }));

  const fromTension = [
    [50, 10, 500], [0, 10, 500], [-25, 10, 500], [50, 0, 500], [50, 10, 0], [42, 2.5, 1200],
  ].map(([tensionN, stiffness, widthMm]) => ({
    tensionN, stiffness, widthMm, eps: numz(tension.strainFromTension(tensionN, stiffness, widthMm)),
  }));

  const dancerLoad = [
    [100, 2], [100, 1], [100, 3], [0, 2], [-50, 2], [100, 0], [100, 0.5],
  ].map(([loadN, strands]) => ({
    loadN, strands, tensionN: numz(tension.tensionFromDancerLoad(loadN, strands)),
  }));

  const band = thresholds(0, 0.02, 0.07, 0.01, 0.1);
  const noBreak = thresholds(0, 0.02, Number.POSITIVE_INFINITY, 0.01, 0.1);
  const zeroTolerance = thresholds(0, 0.02, 0.07, 0.01, 0);
  // Every threshold from both sides, plus the ordering rule (broken outranks over).
  const classify = [
    ['far-slack', -0.02, band], ['just-slack', -1e-9, band], ['at-min', 0, band],
    ['below-band', 0.005, band], ['at-band-low', 0.009, band], ['in-band-low', 0.0091, band],
    ['at-ref', 0.01, band], ['in-band-high', 0.0109, band], ['at-band-high', 0.011, band],
    ['above-band', 0.015, band], ['at-max', 0.02, band], ['just-over', 0.0200001, band],
    ['far-over', 0.05, band], ['at-break', 0.07, band], ['past-break', 0.09, band],
    ['break-disabled', 0.5, noBreak], ['zero-tolerance-at-ref', 0.01, zeroTolerance],
    ['zero-tolerance-below', 0.0099, zeroTolerance], ['nan', Number.NaN, band],
  ].map(([name, eps, t]) => ({
    name, eps: numz(eps), thresholds: { ...t, breakStrain: numz(t.breakStrain) },
    state: tension.classify(eps, t),
  }));

  const deviation = [
    ['in-band', 0.01, band], ['at-band-low', 0.009, band], ['halfway-down', 0.0045, band],
    ['at-min', 0, band], ['past-min', -0.01, band], ['at-band-high', 0.011, band],
    ['halfway-up', 0.0155, band], ['at-max', 0.02, band], ['past-max', 0.04, band],
    ['zero-span-low', 0.005, thresholds(0.009, 0.02, 0.07, 0.01, 0.1)],
    ['zero-span-high', 0.05, thresholds(0, 0.011, 0.07, 0.01, 0.1)],
    ['nan', Number.NaN, band],
  ].map(([name, eps, t]) => ({
    name, eps: numz(eps), thresholds: { ...t, breakStrain: numz(t.breakStrain) },
    deviation: numz(tension.bandDeviation(eps, t)),
  }));

  const specific = [
    [50, 500], [50, 1000], [0, 500], [50, 0], [17.51, 50],
  ].map(([tensionN, widthMm]) => {
    const nPerM = tension.specificTension(tensionN, widthMm);
    return {
      tensionN, widthMm, nPerM: numz(nPerM), pli: numz(tension.pliFromNPerM(nPerM)),
    };
  });

  const tenacity = [
    [100, 20], [100, 0], [100, 60], [0, 20],
  ].map(([nPerM, basisWeightGsm]) => ({
    nPerM, basisWeightGsm, nmPerKg: numz(tension.specificTenacity(nPerM, basisWeightGsm)),
  }));

  const breakStrain = [
    [35, 10], [35, 0], [0, 10], [-5, 10], [120, 2.5],
  ].map(([breakForceNPer50mm, stiffness]) => ({
    breakForceNPer50mm, stiffness,
    // Infinity does not survive JSON: `null` is the fixture spelling of "breaking disabled".
    eps: numz(tension.breakStrain(breakForceNPer50mm, stiffness)),
  }));

  return {
    nPerMPerPli: tension.N_PER_M_PER_PLI,
    minZoneLengthMm: tension.MIN_ZONE_LENGTH_MM,
    strainSteadyState: steady,
    strainStepImplicit: step,
    tensionFromStrain: fromStrain,
    strainFromTension: fromTension,
    tensionFromDancerLoad: dancerLoad,
    classify,
    bandDeviation: deviation,
    specificTension: specific,
    specificTenacity: tenacity,
    breakStrain,
  };
}

/** A plain 3-vector, spelled the way both ports read it. */
function vec(x, y, z) {
  return { x, y, z };
}

/**
 * The sag mathematics (plan-471 Phase 4): the profile and its derivative at fixed
 * support points, the depth/excess round trip including the `L/2` cap, the
 * perpendicular gravity for a horizontal, an oblique and a VERTICAL run, the
 * proportional excess split and the analytic tangent.
 */
function buildSagCases(sag) {
  const supports = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const profile = [];
  for (const depthMm of [12, 0, -8, 250]) {
    for (const s of supports) {
      profile.push({
        s, depthMm,
        f: numz(sag.sagProfile(s, depthMm)),
        fPrime: numz(sag.sagProfileDerivative(s, depthMm)),
      });
    }
  }

  const depth = [
    [2, 800], [0.2, 800], [50, 800], [0, 800], [-5, 800], [2, 0],
    // Past the cap: the quartic would be a loop, so the depth stops at L / 2.
    [4000, 800], [800, 200],
  ].map(([excessMm, lengthMm]) => ({
    excessMm, lengthMm, depthMm: numz(sag.sagDepth(excessMm, lengthMm)),
  }));

  const excess = [
    [25, 800], [0, 800], [-25, 800], [400, 800], [25, 0],
  ].map(([depthMm, lengthMm]) => ({
    depthMm, lengthMm, excessMm: numz(sag.sagExcess(depthMm, lengthMm)),
  }));

  const estimated = [
    [0, 800], [135.9, 800], [136.1, 800], [-200, 800], [100, 0],
  ].map(([depthMm, lengthMm]) => ({
    depthMm, lengthMm, estimated: sag.isSagEstimated(depthMm, lengthMm),
  }));

  const gravity = [
    ['horizontal-run', vec(0, -9810, 0), vec(1, 0, 0)],
    ['oblique-run', vec(0, -9810, 0), vec(0.6, 0.8, 0)],
    ['vertical-run', vec(0, -9810, 0), vec(0, 1, 0)],
    ['vertical-run-down', vec(0, -9810, 0), vec(0, -1, 0)],
    ['unnormalised-chord', vec(0, -9810, 0), vec(0, 0, 250)],
    ['degenerate-chord', vec(0, -9810, 0), vec(0, 0, 0)],
    ['rotated-frame', vec(6937.2, -6937.2, 0), vec(0, 0, 1)],
  ].map(([name, g, chord]) => {
    const out = { x: 0, y: 0, z: 0 };
    const length = sag.perpGravity(g, chord, out);
    return { name, g, chord, length: numz(length), dir: { x: numz(out.x), y: numz(out.y), z: numz(out.z) } };
  });

  const distribute = [
    ['equal-thirds', [100, 100, 100], 30],
    ['proportional', [100, 300], 40],
    ['with-arcs', [250, 0, 150, 0, 600], 80],
    ['single', [800], 12],
    ['zero-excess', [100, 200], 0],
    ['all-empty', [0, 0], 12],
    ['empty-list', [], 12],
  ].map(([name, lengthsMm, excessMm]) => {
    const out = new Array(lengthsMm.length).fill(0);
    const written = sag.distributeExcess(lengthsMm, excessMm, out);
    return { name, lengthsMm, excessMm, written, shares: out.map((v) => numz(v)) };
  });

  const tangent = [
    ['start', vec(0, 0, 1), vec(0, -1, 0), 0, 40, 800],
    ['quarter', vec(0, 0, 1), vec(0, -1, 0), 0.25, 40, 800],
    ['middle', vec(0, 0, 1), vec(0, -1, 0), 0.5, 40, 800],
    ['three-quarter', vec(0, 0, 1), vec(0, -1, 0), 0.75, 40, 800],
    ['end', vec(0, 0, 1), vec(0, -1, 0), 1, 40, 800],
    ['taut', vec(0, 0, 1), vec(0, -1, 0), 0.25, 0, 800],
    ['diagonal-chord', vec(0.6, 0.8, 0), vec(-0.8, 0.6, 0), 0.3, 25, 500],
    ['degenerate-length', vec(0, 0, 1), vec(0, -1, 0), 0.25, 40, 0],
  ].map(([name, chord, sagDir, s, depthMm, lengthMm]) => {
    const out = { x: 0, y: 0, z: 0 };
    sag.lineTangentAfterSag(chord, sagDir, s, depthMm, lengthMm, out);
    return {
      name, chord, sagDir, s, depthMm, lengthMm,
      tangent: { x: numz(out.x), y: numz(out.y), z: numz(out.z) },
    };
  });

  return {
    sagC1: sag.SAG_C1,
    sagEstimatedRatio: sag.SAG_ESTIMATED_RATIO,
    profile,
    sagDepth: depth,
    sagExcess: excess,
    isSagEstimated: estimated,
    perpGravity: gravity,
    distributeExcess: distribute,
    lineTangentAfterSag: tangent,
  };
}

/** The whole payload, without the `generatedAt` header (which is not compared). */
export async function buildRibbonVectors() {
  const mods = await loadRibbonModules();
  const geometry = mods['ribbon-geometry'];
  const winder = mods['ribbon-winder-math'];
  const dancer = mods['ribbon-dancer-math'];
  const tension = mods['ribbon-tension-math'];
  const sag = mods['ribbon-sag-math'];
  return {
    sampleStride: geometry.RIBBON_SAMPLE_STRIDE,
    tangentBetween: buildTangentCases(geometry),
    resolveAutoSides: buildAutoSideCases(geometry),
    buildRibbonSegments: buildSegmentCases(geometry),
    samplingChains: buildSamplingChains(),
    sampleArcLength: buildSamplingCases(geometry),
    winder: buildWinderCases(winder),
    dancer: buildDancerCases(dancer),
    tension: buildTensionCases(tension),
    sag: buildSagCases(sag),
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
