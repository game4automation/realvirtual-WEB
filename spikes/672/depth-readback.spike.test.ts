// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-672 Phase 0, half 1 — THE DEPTH READBACK GATE.
 *
 * Three questions, in the order the plan puts them:
 *
 *  1. **Does the proven path still work with a SENSOR's pose and near/far?**
 *     `RGBADepthPacking` into a linear RGBA8 target, decoded by the repo's own
 *     `unpackRGBADepth` — the path `tests/rv-toon-gbuffer-smoke.test.ts:152-171`
 *     already pins on the classic WebGLRenderer, re-run here at the sensor
 *     defaults of §2.3 (Near 20 mm, Far 10 000 mm, FOV 40°) instead of the
 *     test's 0.1/100. That near/far ratio is 500:1, so this is not a formality:
 *     packed NDC depth spends its precision near the near plane.
 *
 *  2. **Does the float path work at all on WebGL2 — and is it worth it?** (F3.)
 *     That needs the read path the repo does not have (R12), which is
 *     `spikes/672/view-distance.ts`. The ACCURACY half is decided here against a
 *     synthetic scene with exact ground truth; the COST half below.
 *
 *  3. **What does one pass cost on a real model?** Station (21 MB) and, when the
 *     private sibling is there, a Mauser-class model (193 MB), at 320×240 and
 *     640×480, through the production harness `viewer.renderAuxiliaryPass`.
 *     The plan's gate is: depth pass INCLUDING the readback ≤ 4 ms at 320×240 on
 *     Station.
 *
 * WHAT IS DELIBERATELY NOT MEASURED: WebGPU. `renderAuxiliaryPass` returns
 * `false` under any `WebGPURenderer` (`rv-viewer.ts:2225`), so a number from
 * there would measure a no-op. The plan says so in R12 and in Phase 0's third
 * bullet; this file obeys it and ASSERTS the no-op instead of timing it.
 *
 * READING THE OUTPUT: every measurement prints a `[672-P0]` line. The printed
 * tables are the result; the assertions only keep the measurement honest (a
 * finite reading, the right number of samples, the harness really running). A
 * budget that throws hides the figure the gate exists to produce, so the budget
 * verdict is printed as `PASS`/`FAIL` and read by a human.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Box3,
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RGBADepthPacking,
  Scene,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type WebGLRenderer,
} from 'three';
import { unpackRGBADepth } from '../../src/core/engine/rv-gbuffer-material';
import { readRenderTargetPixelsFlipped } from '../../src/core/engine/rv-offscreen-capture';
import { createTestViewer, type TestViewerHandle } from '../../tests/helpers/create-test-viewer';
import { loadBakedGLB } from '../../tests/helpers/load-baked-glb';
import { devAssetAvailable } from '../../tests/fixtures/dev-asset-available';
import {
  createDepthTarget,
  createViewDistanceMaterial,
  floatReadbackSupport,
  readFloatTargetTopDown,
  type DepthTargetKind,
} from './view-distance';

// ─── sensor defaults from plan-672 §2.3 ─────────────────────────────────
const NEAR = 0.02; //  20 mm
const FAR = 10; //  10 000 mm
const FOV = 40; //  degrees

const STATION = '/demo-realvirtual/LaserWeldingAssemblyStation.glb';
const MAUSER = '/private-models/mauser3dhmi/MauserCageline30.glb';

/** Distances a perception sensor in this project actually sees, plus both ends. */
const DISTANCES = [0.05, 0.1, 0.3, 1, 2.5, 5, 9, 9.9];

// ─── statistics ─────────────────────────────────────────────────────────

interface Stats { n: number; median: number; p95: number; min: number; mean: number }

function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return {
    n: s.length,
    median: s.length ? q(0.5) : NaN,
    p95: s.length ? q(0.95) : NaN,
    min: s.length ? s[0] : NaN,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN,
  };
}

const ms = (x: number) => x.toFixed(3);
const fmt = (label: string, st: Stats) =>
  `${label}: median ${ms(st.median)} ms, p95 ${ms(st.p95)} ms, min ${ms(st.min)} ms (n=${st.n})`;

// ─── one depth pass, measured ───────────────────────────────────────────

type DepthKind = 'packed' | 'half' | 'float';

const TARGET_KIND: Record<DepthKind, DepthTargetKind> = {
  packed: 'rgba8', half: 'half', float: 'float',
};

interface PassTiming { submitMs: number; totalMs: number; readMs: number; sample: number }

/**
 * Render `scene` from `camera` through the depth override of `kind` into a
 * private target and read it back, timing the two halves.
 *
 * `submitMs` is the CPU cost of issuing the draw calls; `totalMs` includes the
 * readback, which IS the GPU sync point — on the classic renderer
 * `readRenderTargetPixels` is synchronous (NFR2), so `totalMs` is the only
 * honest wall-clock figure and the one the plan's budget is about. Both are
 * printed, because the difference between them is exactly the readback cost the
 * plan calls "the cost point, not the rendering".
 */
function timedDepthPass(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  rt: WebGLRenderTarget,
  override: Material,
  kind: DepthKind,
  width: number,
  height: number,
): PassTiming {
  const prevOverride = scene.overrideMaterial;
  const prevTarget = renderer.getRenderTarget();
  const prevClear = new Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  try {
    scene.overrideMaterial = override;
    // packed: the clear must be WHITE — packed depth 1.0 is the far plane and
    // `unpackRGBADepth` answers NaN there, which is how background is told from
    // a surface. float: clear to 0 and treat 0 as background (a float clear
    // colour cannot carry 10.0 through `setClearColor`'s colour conversion).
    renderer.setClearColor(kind === 'packed' ? 0xffffff : 0x000000, 1);
    renderer.setRenderTarget(rt);
    const t0 = performance.now();
    renderer.clear();
    renderer.render(scene, camera);
    const t1 = performance.now();
    const o = (((height >> 1) * width) + (width >> 1)) * 4;
    let sample: number;
    if (kind === 'packed') {
      const px = readRenderTargetPixelsFlipped(renderer, rt, width, height);
      sample = unpackRGBADepth(px[o], px[o + 1], px[o + 2], px[o + 3], camera.near, camera.far);
    } else {
      sample = readFloatTargetTopDown(renderer, rt, width, height).pixels[o];
    }
    const t2 = performance.now();
    return { submitMs: t1 - t0, totalMs: t2 - t0, readMs: t2 - t1, sample };
  } finally {
    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
  }
}

/** Decode a whole frame to one distance per pixel (metres; NaN/0 = background). */
function readFrame(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  rt: WebGLRenderTarget,
  override: Material,
  kind: DepthKind,
  size: number,
): Float32Array {
  const prevOverride = scene.overrideMaterial;
  const prevTarget = renderer.getRenderTarget();
  try {
    scene.overrideMaterial = override;
    renderer.setClearColor(kind === 'packed' ? 0xffffff : 0x000000, 1);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, camera);
    const out = new Float32Array(size * size);
    if (kind === 'packed') {
      const px = readRenderTargetPixelsFlipped(renderer, rt, size, size);
      for (let i = 0; i < out.length; i++) {
        out[i] = unpackRGBADepth(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3], camera.near, camera.far);
      }
    } else {
      const { pixels } = readFloatTargetTopDown(renderer, rt, size, size);
      for (let i = 0; i < out.length; i++) out[i] = pixels[i * 4];
    }
    return out;
  } finally {
    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevTarget);
  }
}

// ─── fixtures ───────────────────────────────────────────────────────────

/** A large plane facing the camera, movable to an exact distance. */
function wallScene(): { scene: Scene; move(z: number): void; dispose(): void } {
  const scene = new Scene();
  const geo = new PlaneGeometry(40, 40);
  const mat = new MeshBasicMaterial();
  const mesh = new Mesh(geo, mat);
  scene.add(mesh);
  return {
    scene,
    move(z: number) { mesh.position.set(0, 0, -z); mesh.updateMatrixWorld(true); },
    dispose() { geo.dispose(); mat.dispose(); scene.clear(); },
  };
}

/** A camera at the origin looking down -z, at the plan's sensor defaults. */
function sensorCamera(aspect = 1): PerspectiveCamera {
  const cam = new PerspectiveCamera(FOV, aspect, NEAR, FAR);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);
  return cam;
}

/** A sensor-like camera placed to see the loaded model inside [NEAR, FAR]. */
function cameraOverModel(viewerHandle: TestViewerHandle, aspect: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(FOV, aspect, NEAR, FAR);
  const bounds = new Box3().setFromObject(viewerHandle.viewer.scene);
  const centre = bounds.isEmpty() ? new Vector3() : bounds.getCenter(new Vector3());
  const span = bounds.isEmpty() ? 2 : bounds.getSize(new Vector3()).length();
  const radius = Math.min(FAR * 0.4, Math.max(0.5, span * 0.25));
  cam.position.copy(centre).add(new Vector3(radius, radius * 0.6, radius));
  cam.lookAt(centre);
  cam.updateMatrixWorld(true);
  return cam;
}

let handle: TestViewerHandle | null = null;
let renderer: WebGLRenderer;
let gpuName = 'unknown';

beforeAll(async () => {
  handle = await createTestViewer('webgl', { desRunner: false });
  renderer = handle.viewer.renderer as unknown as WebGLRenderer;
  const probe32 = createDepthTarget(4, 4, 'float');
  const probe16 = createDepthTarget(4, 4, 'half');
  const s32 = floatReadbackSupport(renderer, probe32);
  const s16 = floatReadbackSupport(renderer, probe16);
  probe32.dispose();
  probe16.dispose();
  gpuName = s32.renderer;
  console.info(
    `[672-P0] device: ${s32.renderer} | EXT_color_buffer_float=${s32.colorBufferFloat} `
    + `| EXT_float_blend=${s32.floatBlend}`
    + `\n[672-P0] IMPLEMENTATION_COLOR_READ_TYPE — RGBA32F FBO: float=${s32.readTypeFloat} half=${s32.readTypeHalf}`
    + ` | RGBA16F FBO: float=${s16.readTypeFloat} half=${s16.readTypeHalf}`,
  );
}, 180_000);

afterAll(() => { handle?.dispose(); handle = null; });

// ─── 1 + 2. accuracy, with exact ground truth ───────────────────────────

/**
 * The exact distance the CENTRE pixel of a `size`×`size` frame must report for a
 * wall `d` metres away — and the reason this function exists at all.
 *
 * The centre pixel of an even-sized frame is NOT on the optical axis: its centre
 * sits half a pixel off in both directions. The perpendicular depth there is
 * still `d`, but the RADIAL distance is `d·|dir|`, and at 64×64 that is a
 * +0.0032 % difference. Measured against a flat `d`, the float path therefore
 * looks 0.0032 % "wrong" at every single distance — a constant relative offset,
 * which is the signature of a wrong expectation rather than a wrong reading. So
 * the expectation is computed, not assumed.
 */
function expectedAtCentre(d: number, size: number, radial: boolean): number {
  if (!radial) return d;
  const t = Math.tan((FOV / 2) * (Math.PI / 180));
  const ndc = ((size >> 1) + 0.5) / size * 2 - 1; // same magnitude in x and y
  const dx = ndc * t; //  aspect 1
  const dy = ndc * t;
  return d * Math.sqrt(dx * dx + dy * dy + 1);
}

describe('plan-672 P0 · accuracy of the two depth encodings', () => {
  /** Run `DISTANCES` through one encoding and report the worst error. */
  function accuracySweep(kind: DepthKind, label: string, decimals: number): number {
    const radial = kind !== 'packed'; // the view-distance material reports radial
    const SIZE = 64;
    const { scene, move, dispose } = wallScene();
    const camera = sensorCamera();
    const rt = createDepthTarget(SIZE, SIZE, TARGET_KIND[kind]);
    const mat: Material = kind === 'packed'
      ? new MeshDepthMaterial({ depthPacking: RGBADepthPacking })
      : createViewDistanceMaterial();
    const rows: string[] = [];
    let worstRel = 0;
    let worstAbs = 0;
    try {
      for (const d of DISTANCES) {
        move(d);
        const { sample } = timedDepthPass(renderer, scene, camera, rt, mat, kind, SIZE, SIZE);
        expect(Number.isFinite(sample), `${label} depth at ${d} m must be a finite reading`).toBe(true);
        const truth = expectedAtCentre(d, SIZE, radial);
        const err = sample - truth;
        const rel = Math.abs(err) / truth;
        worstRel = Math.max(worstRel, rel);
        worstAbs = Math.max(worstAbs, Math.abs(err));
        rows.push(
          `wall ${d.toFixed(2)} m → read ${sample.toFixed(6)} m (expected ${truth.toFixed(6)} m, `
          + `err ${(err * 1000).toFixed(decimals)} mm, ${(rel * 100).toFixed(decimals + 1)} %)`,
        );
      }
    } finally {
      mat.dispose(); rt.dispose(); dispose();
    }
    console.info(
      `[672-P0] ${label} (near=${NEAR} far=${FAR}, expectation ${radial ? 'RADIAL' : 'PERPENDICULAR'}):`
      + `\n  ${rows.join('\n  ')}`,
    );
    console.info(
      `[672-P0] ${label} worst error: ${(worstAbs * 1000).toFixed(decimals)} mm absolute, `
      + `${(worstRel * 100).toFixed(decimals + 1)} % relative`,
    );
    return worstRel;
  }

  it('the PROVEN 24-bit path measures known distances at sensor near/far', () => {
    const worst = accuracySweep('packed', 'PACKED RGBADepthPacking 24 bit', 3);
    // 1 % of the distance is the bar a depth reading has to clear to be worth
    // calling metric. If 24 bits across a 500:1 near/far ratio does NOT clear
    // it, that is the Phase 0 finding and the plan's baseline is wrong.
    expect(worst, 'worst relative error of the packed path').toBeLessThan(0.01);
  });

  it('the FLOAT path (FloatType) measures the same distances — new read path included', () => {
    const worst = accuracySweep('float', 'FLOAT FloatType length(viewPosition)', 4);
    expect(worst, 'worst relative error of the float path').toBeLessThan(0.01);
  });

  it('the FLOAT path also works with a HalfFloatType target (half the bandwidth)', () => {
    // Half float has an ~11-bit mantissa, so a different trade than the packed
    // path's: relative precision instead of near-plane-weighted absolute.
    const worst = accuracySweep('half', 'HALF HalfFloatType length(viewPosition)', 3);
    expect(worst, 'worst relative error of the half-float path').toBeLessThan(0.01);
  });

  it('packed reports PERPENDICULAR depth, float reports RADIAL distance', () => {
    // The off-centre pixel is where the two encodings disagree by construction:
    // the rasteriser interpolates -z, a sensor measures along its ray. At the
    // corner of a 40° FOV they are cos(θ) apart. Not a defect of either — a
    // semantic difference the plan must know, because §2.6 reprojects the depth
    // image into a point cloud and the wrong one bends the cloud.
    const { scene, move, dispose } = wallScene();
    const camera = sensorCamera();
    const S = 64;
    const packedRt = createDepthTarget(S, S, 'rgba8');
    const floatRt = createDepthTarget(S, S, 'float');
    const packedMat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    const floatMat = createViewDistanceMaterial();
    try {
      move(2.5);
      const packed = readFrame(renderer, scene, camera, packedRt, packedMat, 'packed', S);
      const flt = readFrame(renderer, scene, camera, floatRt, floatMat, 'float', S);
      const corner = 2 * S + 2; // well off axis
      const centre = (S >> 1) * S + (S >> 1);
      console.info(
        `[672-P0] SEMANTICS at 2.50 m — centre: packed ${packed[centre].toFixed(4)} m, `
        + `float ${flt[centre].toFixed(4)} m | off-axis: packed ${packed[corner].toFixed(4)} m `
        + `(perpendicular), float ${flt[corner].toFixed(4)} m (radial), `
        + `ratio ${(flt[corner] / packed[corner]).toFixed(4)}`,
      );
      expect(Math.abs(packed[centre] - flt[centre]), 'identical on the axis').toBeLessThan(0.01);
      expect(flt[corner], 'radial > perpendicular off axis').toBeGreaterThan(packed[corner] * 1.001);
    } finally {
      packedMat.dispose(); floatMat.dispose(); packedRt.dispose(); floatRt.dispose(); dispose();
    }
  });
});

// ─── 3. cost on real models, through the production harness ─────────────

interface CostRow { label: string; submit: Stats; total: Stats; read: Stats }

/**
 * Measure one (model, resolution, encoding) cell INSIDE `renderAuxiliaryPass` —
 * the harness production would use: reflector off, clipping off, matrices
 * walked at most once per frame, everything restored in a `finally`.
 */
function measureCost(
  viewerHandle: TestViewerHandle,
  camera: PerspectiveCamera,
  kind: DepthKind,
  width: number,
  height: number,
  iterations: number,
): CostRow {
  const rt = createDepthTarget(width, height, TARGET_KIND[kind]);
  const override: Material = kind === 'packed'
    ? new MeshDepthMaterial({ depthPacking: RGBADepthPacking })
    : createViewDistanceMaterial();
  const WARMUP = 5;
  const submit: number[] = [];
  const total: number[] = [];
  const read: number[] = [];
  try {
    for (let i = 0; i < iterations + WARMUP; i++) {
      const ran = viewerHandle.viewer.renderAuxiliaryPass((r, scene) => {
        const t = timedDepthPass(r, scene, camera, rt, override, kind, width, height);
        if (i >= WARMUP) { submit.push(t.submitMs); total.push(t.totalMs); read.push(t.readMs); }
      });
      expect(ran, 'renderAuxiliaryPass must run on the classic WebGL renderer').toBe(true);
    }
  } finally {
    override.dispose();
    rt.dispose();
  }
  return { label: `${kind} ${width}x${height}`, submit: stats(submit), total: stats(total), read: stats(read) };
}

function printCost(model: string, rows: CostRow[]): void {
  console.info(
    `[672-P0] COST on ${model} (device ${gpuName}) — pass+readback is the gate figure:\n  `
    + rows
      .map((r) => `${fmt(r.label.padEnd(18), r.total)}  [submit ${ms(r.submit.median)} ms, readback ${ms(r.read.median)} ms]`)
      .join('\n  '),
  );
}

describe('plan-672 P0 · cost of one depth pass on a real model', () => {
  let station: TestViewerHandle | null = null;

  beforeAll(async () => {
    station = await createTestViewer('webgl', { desRunner: false, width: 800, height: 600 });
    const bytes = await (await fetch(STATION)).arrayBuffer();
    const result = await loadBakedGLB(STATION, station.viewer.scene, { data: bytes });
    console.info(
      `[672-P0] Station baked: ${result.bakedAsset!.chunks.length} chunks, `
      + `${result.bakedAsset!.chunks.reduce((a, c) => a + c.triangles, 0)} triangles`,
    );
  }, 600_000);

  afterAll(() => { station?.dispose(); station = null; });

  it('320x240 and 640x480, packed vs float vs half — the gate', () => {
    const rows: CostRow[] = [];
    for (const [w, h] of [[320, 240], [640, 480]] as const) {
      const cam = cameraOverModel(station!, w / h);
      for (const kind of ['packed', 'float', 'half'] as const) {
        rows.push(measureCost(station!, cam, kind, w, h, 30));
      }
    }
    printCost('LaserWeldingAssemblyStation', rows);
    const gate = rows.find((r) => r.label === 'packed 320x240')!;
    console.info(
      '[672-P0] GATE (depth pass + readback ≤ 4 ms at 320x240 on Station): '
      + `${ms(gate.total.median)} ms median, ${ms(gate.total.p95)} ms p95 → `
      + `${gate.total.median <= 4 ? 'PASS' : 'FAIL'}`,
    );
    expect(gate.total.n).toBe(30);
  });
});

// ─── 4. where the cost actually sits ────────────────────────────────────

/**
 * THE FOLLOW-UP THE FIRST RESULT FORCED.
 *
 * Measurement 3 came back at ~9.7 ms for a 320×240 pass against a 4 ms budget,
 * with `submit` at 1.0 ms and the READBACK at 8.6 ms — and 640×480 costing only
 * ~1 ms more. A readback whose cost barely moves when the pixel count
 * quadruples is not paying for pixels; it is paying for the PIPELINE STALL.
 * `readRenderTargetPixels` flushes the GL command stream and blocks the main
 * thread until the GPU has caught up (`rv-offscreen-capture.ts` NFR2 says so in
 * words; this is the number).
 *
 * That changes which lever matters, so the lever has to be measured too:
 *
 *  A. **no readback at all** — the plan's own NFR2 note that "the display alone
 *     needs none", the texture going straight to the display. N passes
 *     back-to-back, one sync read at the very end to force completion: the
 *     per-pass main-thread cost AND the amortised GPU cost of a pass.
 *  B. **asynchronous readback** — `readRenderTargetPixelsAsync`, which the
 *     classic WebGLRenderer has had since r168 (note in
 *     `tests/helpers/create-test-viewer.ts`) and which `rv-offscreen-capture.ts`
 *     deliberately does NOT use on this backend. Two different numbers then
 *     matter: what the pass costs the MAIN THREAD, and how old the frame is when
 *     the pixels arrive (which a sensor can simply declare as its latency — it
 *     has a latency parameter anyway, per plan-664).
 */
describe('plan-672 P0 · where the cost actually sits', () => {
  let station: TestViewerHandle | null = null;

  beforeAll(async () => {
    station = await createTestViewer('webgl', { desRunner: false, width: 800, height: 600 });
    const bytes = await (await fetch(STATION)).arrayBuffer();
    await loadBakedGLB(STATION, station.viewer.scene, { data: bytes });
  }, 600_000);

  afterAll(() => { station?.dispose(); station = null; });

  it('A — a pass WITHOUT a readback (display-only sensor)', () => {
    const W = 320;
    const H = 240;
    const rt = createDepthTarget(W, H, 'rgba8');
    const mat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    const cam = cameraOverModel(station!, W / H);
    const N = 40;
    try {
      // warm up
      for (let i = 0; i < 5; i++) {
        station!.viewer.renderAuxiliaryPass((r, scene) => {
          timedDepthPass(r, scene, cam, rt, mat, 'packed', W, H);
        });
      }
      const per: number[] = [];
      let wall = 0;
      station!.viewer.renderAuxiliaryPass((r, scene) => {
        const prevOverride = scene.overrideMaterial;
        const prevTarget = r.getRenderTarget();
        try {
          scene.overrideMaterial = mat;
          r.setRenderTarget(rt);
          r.setClearColor(0xffffff, 1);
          const t0 = performance.now();
          for (let i = 0; i < N; i++) {
            const a = performance.now();
            r.clear();
            r.render(scene, cam);
            per.push(performance.now() - a);
          }
          const submitted = performance.now();
          // ONE sync read at the end forces the whole queue to complete, so the
          // wall time divided by N is the amortised GPU cost of a pass.
          readRenderTargetPixelsFlipped(r, rt, W, H);
          wall = performance.now() - t0;
          console.info(
            `[672-P0] NO-READBACK ${W}x${H}, ${N} passes: main thread ${ms(submitted - t0)} ms total `
            + `(${ms((submitted - t0) / N)} ms per pass), wall incl. the single final sync `
            + `${ms(wall)} ms (${ms(wall / N)} ms per pass amortised)`,
          );
        } finally {
          scene.overrideMaterial = prevOverride;
          r.setRenderTarget(prevTarget);
        }
      });
      const st = stats(per);
      console.info(`[672-P0] NO-READBACK per-pass main-thread cost: ${fmt('render only', st)}`);
      expect(st.n).toBe(N);
    } finally {
      mat.dispose(); rt.dispose();
    }
  });

  it('B — an ASYNCHRONOUS readback on the classic WebGL renderer', async () => {
    const W = 320;
    const H = 240;
    const rt = createDepthTarget(W, H, 'rgba8');
    const mat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
    const cam = cameraOverModel(station!, W / H);
    const r = station!.viewer.renderer as unknown as WebGLRenderer & {
      readRenderTargetPixelsAsync?: (
        t: WebGLRenderTarget, x: number, y: number, w: number, h: number, buf: Uint8Array,
      ) => Promise<unknown>;
    };
    const hasAsync = typeof r.readRenderTargetPixelsAsync === 'function';
    console.info(`[672-P0] classic WebGLRenderer exposes readRenderTargetPixelsAsync: ${hasAsync}`);
    expect(hasAsync, 'three 0.185 should expose the async readback on WebGLRenderer').toBe(true);
    try {
      const main: number[] = [];
      const latency: number[] = [];
      for (let i = 0; i < 15; i++) {
        const buf = new Uint8Array(W * H * 4);
        let pending!: Promise<unknown>;
        const t0 = performance.now();
        const ran = station!.viewer.renderAuxiliaryPass((rr, scene) => {
          const prevOverride = scene.overrideMaterial;
          try {
            scene.overrideMaterial = mat;
            rr.setRenderTarget(rt);
            rr.setClearColor(0xffffff, 1);
            rr.clear();
            rr.render(scene, cam);
            // Issued, NOT awaited: the pass must not hold renderer state
            // across an await (the rule `rv-offscreen-capture.ts` states).
            pending = r.readRenderTargetPixelsAsync!(rt, 0, 0, W, H, buf);
          } finally {
            scene.overrideMaterial = prevOverride;
            rr.setRenderTarget(null);
          }
        });
        expect(ran).toBe(true);
        const t1 = performance.now();
        await pending;
        const t2 = performance.now();
        if (i >= 5) { main.push(t1 - t0); latency.push(t2 - t0); }
        // The pixels must be real, or a fast number means nothing.
        const o = (((H >> 1) * W) + (W >> 1)) * 4;
        const d = unpackRGBADepth(buf[o], buf[o + 1], buf[o + 2], buf[o + 3], cam.near, cam.far);
        expect(Number.isFinite(d) || Number.isNaN(d), 'the async buffer must be filled').toBe(true);
        expect(buf.some((v) => v !== 0), 'the async readback returned an all-zero buffer').toBe(true);
      }
      console.info(
        `[672-P0] ASYNC READBACK ${W}x${H} on Station:\n  `
        + `${fmt('main thread   ', stats(main))}\n  ${fmt('pixel latency ', stats(latency))}`,
      );
      console.info(
        '[672-P0] GATE revisited — main-thread cost of a pass with an ASYNC readback vs the 4 ms budget: '
        + `${ms(stats(main).median)} ms median → ${stats(main).median <= 4 ? 'PASS' : 'FAIL'}`,
      );
    } finally {
      mat.dispose(); rt.dispose();
    }
  }, 300_000);
});

// ─── the large model, when the private sibling is there ─────────────────

// The availability probe runs in `beforeAll`, NOT at module scope.
// `tests/fixtures/dev-asset-available.ts` documents a top-level `await` as the
// normal pairing with `describe.skipIf`, and it is — for ONE file. With two
// measurement files in one serial browser session the second one's top-level
// await lands after the first file's suite context is gone, and vitest 4.0.18
// fails the whole file with "Vitest failed to find the current suite"
// (reproduced 2026-10-24). So: no module-scope await here, and the skip is a
// runtime `ctx.skip()` instead of a collection-time one.
let mauserAvailable = false;

describe('plan-672 P0 · cost on a Mauser-class model', () => {
  let big: TestViewerHandle | null = null;

  beforeAll(async () => {
    mauserAvailable = await devAssetAvailable(MAUSER);
    if (!mauserAvailable) {
      console.info('[672-P0] Mauser-class model unavailable (no private sibling) — skipping');
      return;
    }
    big = await createTestViewer('webgl', { desRunner: false, width: 800, height: 600 });
    const bytes = await (await fetch(MAUSER)).arrayBuffer();
    const result = await loadBakedGLB(MAUSER, big.viewer.scene, { data: bytes });
    console.info(
      `[672-P0] Mauser baked: ${result.bakedAsset!.chunks.length} chunks, `
      + `${result.bakedAsset!.chunks.reduce((a, c) => a + c.triangles, 0)} triangles`,
    );
  }, 900_000);

  afterAll(() => { big?.dispose(); big = null; });

  it('320x240 and 640x480, packed vs float', (ctx) => {
    if (!mauserAvailable) { ctx.skip(); return; }
    const rows: CostRow[] = [];
    for (const [w, h] of [[320, 240], [640, 480]] as const) {
      const cam = cameraOverModel(big!, w / h);
      for (const kind of ['packed', 'float'] as const) {
        rows.push(measureCost(big!, cam, kind, w, h, 20));
      }
    }
    printCost('MauserCageline30', rows);
  });
});

// ─── the WebGPU non-measurement, asserted rather than timed ─────────────

describe('plan-672 P0 · WebGPU is a no-op, not a slow path', () => {
  it('renderAuxiliaryPass refuses under a WebGPURenderer (R12, so no sham number)', async () => {
    const gpu = await createTestViewer('webgpu-gl', { desRunner: false });
    try {
      let ran = false;
      const ok = gpu.viewer.renderAuxiliaryPass(() => { ran = true; });
      console.info(`[672-P0] WebGPU: renderAuxiliaryPass → ${ok}, callback ran = ${ran} (R12 confirmed)`);
      expect(ok).toBe(false);
      expect(ran).toBe(false);
    } finally {
      gpu.dispose();
    }
  }, 180_000);
});
