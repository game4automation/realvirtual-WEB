// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// plan-2246 §9.2 / Gate R2 #6 — the REAL limit, not part of the standard suite.
// Runs only with RV_USD_LIMIT_TEST=1, alone and serially:
//   RV_USD_LIMIT_TEST=1 RV_USD_PYTHON=<python with pxr> npm run test:node -- tests/usd-runtime-stage-large-geometry.limit.node.test.ts
// A synthetic single-material chunk whose geometry text is > 512 MiB (above the
// V8 string limit) is exported in SEPARATE child processes, each with explicit
// heap flags, an external time limit and a captured exit code:
// - negative control: the unsplit exporter call throws RangeError "Invalid string length";
// - positive: `exportRuntimeStage` (split) succeeds; usd-core then checks the faces
//   of all parts against the input, compact parts, one material binding per part,
//   the parent transform equals the runtime matrix, first / last corner positions.
// Heap and ArrayBuffer / process memory are measured separately (peak RSS from
// process.resourceUsage, V8 heap statistics, memoryUsage().arrayBuffers).
// Skipped when less than 10 GB of commit is free (Windows) — the caller's watchdog rule.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ENABLED = process.env.RV_USD_LIMIT_TEST === '1';
const PY = process.env.RV_USD_PYTHON;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEAP_MB = 4096;
const CHILD_TIMEOUT_MS = 180_000;
/** Vertices of the synthetic chunk: ~135 characters each → ~593 M characters (> 2^29, like the measured 4 M-vertex chunk). */
const VERTICES = 4_400_000;

function freeCommitGb(): number {
  if (process.platform !== 'win32') return Infinity;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory/1MB,1)'], { encoding: 'utf8', windowsHide: true });
  const v = Number(String(r.stdout).trim().replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
}
const FREE_GB = ENABLED ? freeCommitGb() : 0;
const RUN = ENABLED && FREE_GB >= 10;

/** Child driver (bundled with esbuild; `three` stays an external package import). */
const DRIVER = `
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { writeFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { buildRuntimeStageTree, exportRuntimeStage } from '../../../src/core/usd/runtime-stage-export';
import { serializedGeometryLength, V8_MAX_STRING_LENGTH } from '../../../src/core/usd/usd-export-geometry-split';

const [mode, vertices, out] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
function chunk() {
  const n = vertices, p = new Float32Array(n * 3), nr = new Float32Array(n * 3), c = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    p[3 * i] = (i % 2000) * 0.0012345671; p[3 * i + 1] = Math.floor(i / 2000) * 0.0023456781 + (i % 3) * 1e-4; p[3 * i + 2] = Math.sin(i) * 0.31234567;
    nr[3 * i] = 0.1234567; nr[3 * i + 1] = 0.7654321; nr[3 * i + 2] = -0.6123457;
    c[3 * i] = i % 251; c[3 * i + 1] = (i * 7) % 253; c[3 * i + 2] = 128;
  }
  const idx = new Uint32Array((n - 2) * 3);
  for (let t = 0; t < n - 2; t++) { idx[3 * t] = t; idx[3 * t + 1] = t + 1; idx[3 * t + 2] = t + 2; }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(p, 3)); g.setAttribute('normal', new BufferAttribute(nr, 3));
  g.setAttribute('color', new BufferAttribute(c, 3, true)); g.setIndex(new BufferAttribute(idx, 1));
  return g;
}
const mem = () => { const u = process.memoryUsage(), h = getHeapStatistics();
  return { rss: u.rss, heapUsed: u.heapUsed, external: u.external, arrayBuffers: u.arrayBuffers,
    peakRssKb: process.resourceUsage().maxRSS, heapTotal: h.total_heap_size, heapPeakMalloced: h.peak_malloced_memory }; };
const root = new Object3D(); root.name = 'Cell'; root.position.set(1, 2, 3); root.updateMatrixWorld(true);
const g = chunk();
const mesh = new Mesh(g, new MeshStandardMaterial()); mesh.name = 'Chunk'; mesh.position.set(0.5, -0.25, 2); mesh.rotation.z = 0.3; root.add(mesh);
const chars = serializedGeometryLength(g);
const report = { mode, vertices, triangles: g.index.count / 3, chars, v8Limit: V8_MAX_STRING_LENGTH, memBefore: mem() };
const t0 = Date.now();
const before = [g.index.array.slice(0, 30), g.attributes.position.array.slice(0, 30)];
try {
  if (mode === 'unsplit') {
    const tree = buildRuntimeStageTree({ root, templates: [], exclude: new Set(), preplaced: [] }, { primNames: 'sibling' });
    await new USDZExporter().parseAsync(tree.scene, { includeAnchoringProperties: false });
    report.result = 'exported';
  } else {
    const snap = await exportRuntimeStage({ root, templates: [], exclude: new Set(), preplaced: [] });
    writeFileSync(out, snap.usdz);
    report.result = 'exported'; report.usdzBytes = snap.usdz.byteLength; report.primPaths = snap.primPaths;
    mesh.updateMatrix(); report.matrix = Array.from(mesh.matrix.elements);
    const pos = (v) => [g.attributes.position.getX(v), g.attributes.position.getY(v), g.attributes.position.getZ(v)];
    const T = g.index.count / 3;
    report.firstCorner = pos(g.index.getX(0)); report.lastCorner = pos(g.index.getX(3 * T - 1));
  }
} catch (e) {
  report.result = 'threw'; report.errorName = e && e.name; report.errorMessage = String(e && e.message);
}
report.inputUnchanged = before[0].every((v, i) => g.index.array[i] === v) && before[1].every((v, i) => g.attributes.position.array[i] === v)
  && mesh.geometry === g && root.children[0] === mesh;
report.ms = Date.now() - t0; report.memAfter = mem();
process.stdout.write('\\n@@REPORT@@' + JSON.stringify(report) + '\\n');
`;

const CHECK = `
import sys, json
from pxr import Usd, UsdGeom, UsdShade
s = Usd.Stage.Open(sys.argv[1])
p = s.GetPrimAtPath("/Root/Scenes/Scene/Cell/Chunk")
parts = [c for c in p.GetChildren() if c.GetName().startswith("rvPart_")]
faces = 0; points = 0; bound = 0; compact = True; first = None; last = None
for c in parts:
    m = UsdGeom.Mesh(c.GetChildren()[0])
    counts = m.GetFaceVertexCountsAttr().Get(); idx = m.GetFaceVertexIndicesAttr().Get(); pts = m.GetPointsAttr().Get()
    faces += len(counts); points += len(pts)
    if any(k != 3 for k in counts): compact = False
    used = set(idx)
    if len(used) != len(pts) or max(used) != len(pts) - 1: compact = False
    if first is None: first = list(pts[idx[0]])
    last = list(pts[idx[len(idx) - 1]])
    bound += 1 if UsdShade.MaterialBindingAPI(c).GetDirectBinding().GetMaterial() else 0
x = UsdGeom.Xformable(p).GetLocalTransformation()
print(json.dumps({"parts": len(parts), "names": [c.GetName() for c in parts], "faces": faces, "points": points, "bound": bound,
  "compact": compact, "first": first, "last": last, "matrix": [x[i][j] for i in range(4) for j in range(4)]}))
`;

interface ChildResult { status: number | null; signal: string | null; report: Record<string, unknown> | null; stderr: string; wallMs: number }

function runChild(script: string, mode: 'unsplit' | 'split', out: string): ChildResult {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, script, mode, String(VERTICES), out], {
    cwd: ROOT, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  const line = String(r.stdout ?? '').split('\n').find((l) => l.startsWith('@@REPORT@@'));
  const result = { status: r.status, signal: r.signal, report: line ? JSON.parse(line.slice('@@REPORT@@'.length)) : null,
    stderr: String(r.stderr ?? '').slice(-4000), wallMs: Date.now() - t0 };
  console.log(`[limit:${mode}] exit=${result.status} signal=${result.signal} wall=${result.wallMs}ms ${JSON.stringify(result.report)}`);
  return result;
}

describe.skipIf(!RUN)(`plan-2246 limit test (free commit ${FREE_GB} GB)`, () => {
  let script = '';
  let dir = '';
  it('bundles the child driver', async () => {
    // Inside the package so the external `three` import resolves from node_modules.
    const cache = join(ROOT, 'node_modules', '.cache', 'rv-2246-limit');
    mkdirSync(cache, { recursive: true });
    script = join(cache, 'driver.mjs');
    await build({
      stdin: { contents: DRIVER, resolveDir: cache, loader: 'ts', sourcefile: 'driver.ts' },
      bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: script, packages: 'external',
      define: {
        __RV_TERMS_GATE__: '"off"', __RV_HAS_PRIVATE__: 'false', __RV_EMBED__: 'false',
        'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"production","BASE_URL":"/"}',
      },
      logLevel: 'error',
    });
    dir = mkdtempSync(join(tmpdir(), 'rv-2246-limit-'));
  }, 60_000);

  it('negative control (own process): the unsplit exporter throws "Invalid string length"', () => {
    const r = runChild(script, 'unsplit', join(dir, 'unsplit.usdz'));
    expect(r.signal).toBeNull();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report!.chars as number).toBeGreaterThan(r.report!.v8Limit as number);
    expect(r.report).toMatchObject({ result: 'threw', errorName: 'RangeError', errorMessage: 'Invalid string length' });
  }, CHILD_TIMEOUT_MS + 30_000);

  it('split export (own process) succeeds; usd-core reads every face back', () => {
    const file = join(dir, 'split.usdz');
    try {
      const r = runChild(script, 'split', file);
      expect(r.signal).toBeNull();
      expect(r.status, r.stderr).toBe(0);
      const rep = r.report!;
      expect(rep).toMatchObject({ result: 'exported', inputUnchanged: true });
      expect(rep.primPaths).toEqual(['/Root/Scenes/Scene/Cell', '/Root/Scenes/Scene/Cell/Chunk']);
      expect((rep.memAfter as { heapUsed: number }).heapUsed).toBeLessThan(HEAP_MB * 1024 * 1024);
      if (!PY) return;
      const py = spawnSync(PY, ['-c', CHECK, file], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      expect(py.status, py.stderr).toBe(0);
      const out = JSON.parse(py.stdout) as { parts: number; names: string[]; faces: number; points: number; bound: number; compact: boolean; first: number[]; last: number[]; matrix: number[] };
      console.log(`[limit:usd-core] ${JSON.stringify({ ...out, names: out.names.slice(0, 6) })}`);
      expect(out.parts).toBeGreaterThanOrEqual(Math.ceil((rep.chars as number) / (128 * 1024 * 1024)));
      expect(out.names).toEqual(out.names.map((_, k) => `rvPart_${k}`));
      expect(out.faces).toBe(rep.triangles);
      expect(out.compact).toBe(true);
      expect(out.bound).toBe(out.parts);
      // Strip triangles share two vertices with the next one: each part boundary copies two.
      expect(out.points).toBe(VERTICES + 2 * (out.parts - 1));
      out.first.forEach((v, i) => expect(v).toBeCloseTo((rep.firstCorner as number[])[i], 5));
      out.last.forEach((v, i) => expect(v).toBeCloseTo((rep.lastCorner as number[])[i], 5));
      out.matrix.forEach((v, i) => expect(v).toBeCloseTo((rep.matrix as number[])[i], 5));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 2 * CHILD_TIMEOUT_MS + 30_000);
});

describe.skipIf(RUN)('plan-2246 limit test', () => {
  it.skip(ENABLED ? `skipped: only ${FREE_GB} GB commit free (needs 10)` : 'set RV_USD_LIMIT_TEST=1 to run', () => {});
});
