// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2239 Phase 3 — the structure guard of the USD live link, pure logic on a
 * SYNTHETIC three.js tree of large-model size (18 047 surviving nodes + 178
 * partition objects after the bake; doc-bake-picking-internals § 1.3):
 *
 * - the baseline comes from the export tree's own pass (`structure: true`) and
 *   a fresh guard sees no change (root, invisible templates, helpers, MUs);
 * - every structural change kind is found, MU / helper churn is not;
 * - the per-sample check takes the CSR fast path (budget 0.2 ms median on
 *   the 18k-node model, spike 2026-11-05: 0.14 ms) and ALLOCATES NOTHING (heap delta with a
 *   forced GC, and no scavenge during the measured loop; a deliberately
 *   allocating control proves the probe sees allocation).
 */

import { describe, expect, it } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { PerformanceObserver } from 'node:perf_hooks';
import { BufferGeometry, Group, Line, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { buildRuntimeStageTree, type RuntimeStageInput } from '../src/core/usd/runtime-stage-export';
import { LiveMuInventory, collectStageInput } from '../src/core/usd/collect-stage-input';
import { StructureGuard, type GuardMu } from '../src/plugins/usd-live-link/structure-guard';

const LARGE_MODEL_NODES = 18_047 + 178;

interface Rig {
  root: Object3D;
  exported: Object3D[];
  templates: Object3D[];
  mus: GuardMu[];
  guard: StructureGuard;
  captureMs: number;
}

/** Deterministic large-model-sized tree with helpers, invisible templates, and live MUs under exported nodes. */
function rig(target = LARGE_MODEL_NODES, withMus = true): Rig {
  const geo = new BufferGeometry();
  const mat = new MeshBasicMaterial();
  const root = new Group(); root.name = 'LargeModel';
  const exported: Object3D[] = [root];
  const templates: Object3D[] = [];
  const mus: GuardMu[] = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const queue: Object3D[] = [root];
  const muParents: Object3D[] = [];
  while (exported.length < target) {
    const parent = queue.shift()!;
    const fan = 2 + Math.floor(rnd() * 5);
    for (let c = 0; c < fan && exported.length < target; c++) {
      const isMesh = rnd() < 0.15;
      const n = isMesh ? new Mesh(geo, mat) : new Object3D();
      n.name = `${isMesh ? 'Body' : 'Part'}_${exported.length}`;
      if (rnd() < 0.01) { n.visible = false; templates.push(n); }
      parent.add(n); exported.push(n); queue.push(n);
    }
    if (rnd() < 0.05) { const h = new Object3D(); h.userData._rvGizmo = true; parent.add(h); }
    if (rnd() < 0.02) parent.add(new Line());
    if (withMus && rnd() < 0.01) muParents.push(parent);
  }
  // Templates are exported with their whole subtree even when hidden.
  const input: RuntimeStageInput = { root, templates, exclude: new Set(), preplaced: [] };
  const t0 = performance.now();
  const tree = buildRuntimeStageTree(input, { primNames: 'sibling', structure: true });
  const captureMs = performance.now() - t0;
  // MUs spawned AFTER the snapshot, under exported nodes: never structural.
  for (const p of muParents) {
    const node = new Mesh(geo, mat); node.name = 'MU';
    p.add(node);
    mus.push({ node, isInstanced: false });
  }
  const muHost = { mus, preplacedMUs: [] as GuardMu[] };
  const guard = new StructureGuard({
    baseline: tree.structure!,
    exclude: input.exclude,
    templates: new Set(templates),
    preplacedNodes: new Set(),
    muHost: () => muHost,
  });
  expect(tree.nodes.length).toBeGreaterThanOrEqual(target);
  return { root, exported, templates, mus, guard, captureMs };
}

function timeChecks(guard: StructureGuard, n: number): { median: number; p95: number } {
  for (let i = 0; i < 200; i++) expect(guard.checkIndex()).toBe(-1);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    if (guard.checkIndex() !== -1) throw new Error('false positive');
    s[i] = performance.now() - a;
  }
  s.sort();
  return { median: s[n >> 1], p95: s[Math.floor(n * 0.95)] };
}

/** `global.gc` without `--expose-gc` on the command line (process-wide V8 flag). */
function obtainGc(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

/** Heap growth and GC count of `n` calls of `fn`. */
async function allocationProbe(fn: () => void, n: number): Promise<{ grownBytes: number; gcs: number }> {
  const gc = obtainGc();
  for (let i = 0; i < 200; i++) fn(); // warm-up (JIT, inline caches)
  let gcs = 0;
  const obs = new PerformanceObserver((list) => { gcs += list.getEntries().length; });
  gc();
  obs.observe({ entryTypes: ['gc'] });
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) fn();
  const after = process.memoryUsage().heapUsed;
  // GC entries are delivered asynchronously.
  await new Promise((r) => setTimeout(r, 20));
  obs.disconnect();
  return { grownBytes: after - before, gcs };
}

describe('usd-live-link structure guard (18k-node synthetic tree)', () => {
  it('a fresh baseline from the export pass sees no change: root, invisible templates, helpers, MUs added later', () => {
    const r = rig(2000);
    expect(r.guard.checkIndex()).toBe(-1);
    expect(r.guard.checkIndex()).toBe(-1);
  });

  it('finds every structural change kind and ignores MU / helper churn', () => {
    const r = rig(2000);
    const real = (c: Object3D) => c.visible && !(c as Line).isLine && !c.userData._rvGizmo;
    const victim = r.exported.find((n, i) => i > 200 && n.visible && n.children.filter(real).length > 1)!;
    const kindAt = () => { const i = r.guard.checkIndex(); return i < 0 ? null : r.guard.describe(i).kind; };

    const oldName = victim.name; victim.name = 'renamed';
    expect(kindAt()).toBe('rename');
    victim.name = oldName;

    const oldParent = victim.parent!; r.root.attach(victim);
    expect(kindAt()).toBe('re-parent');
    oldParent.attach(victim);
    expect(kindAt()).toBeNull();

    oldParent.remove(victim);
    expect(kindAt()).toBe('removed');
    oldParent.add(victim);
    // Index order inside the parent changed — still the same structure.
    expect(kindAt()).toBeNull();

    const extra = new Object3D(); victim.add(extra);
    expect(kindAt()).toBe('child added');
    victim.remove(extra);

    const shown = victim.children.find(real)!;
    shown.visible = false;
    expect(kindAt()).toBe('child removed');
    shown.visible = true;

    // Helpers and MUs come and go without a verdict.
    const g = new Object3D(); g.userData._rvGizmo = true; victim.add(g);
    expect(kindAt()).toBeNull();
    victim.remove(g);
    const mu = r.mus[0];
    victim.attach(mu.node); // grip
    expect(kindAt()).toBeNull();
    r.root.attach(mu.node); // release elsewhere
    expect(kindAt()).toBeNull();
    // A newly spawned MU (in the live list) is no structure either.
    const spawned = new Object3D(); victim.add(spawned); r.mus.push({ node: spawned, isInstanced: false });
    expect(kindAt()).toBeNull();
  });

  it('a visibility swap of equal count is a change: A hidden, B shown at the same parent (plan-2239 review #3)', () => {
    const root = new Group(); root.name = 'Cell';
    const parent = new Object3D(); parent.name = 'Station';
    const a = new Object3D(); a.name = 'A';
    const b = new Object3D(); b.name = 'B'; b.visible = false;
    root.add(parent); parent.add(a, b);
    const input: RuntimeStageInput = { root, templates: [], exclude: new Set(), preplaced: [] };
    const tree = buildRuntimeStageTree(input, { primNames: 'sibling', structure: true });
    const guard = new StructureGuard({
      baseline: tree.structure!, exclude: input.exclude, templates: new Set(), preplacedNodes: new Set(),
      muHost: () => ({ mus: [], preplacedMUs: [] }),
    });
    expect(guard.checkIndex()).toBe(-1);
    a.visible = false; b.visible = true;
    const i = guard.checkIndex();
    expect(i).toBe(tree.nodes.indexOf(parent));
    expect(guard.describe(i)).toMatchObject({ kind: 'child replaced', name: 'Station' });
    a.visible = true; b.visible = false; // back: the same set again
    expect(guard.checkIndex()).toBe(-1);
    // Reordered (same set) is still no change.
    parent.remove(a); parent.add(a);
    expect(guard.checkIndex()).toBe(-1);
  });

  it('a passive load on a pre-placed carrier: excluded by the collector, no alarm on a helper at the carrier or on unloading (plan-2239 review #2)', () => {
    const root = new Group(); root.name = 'Cell';
    const carrierNode = new Object3D(); carrierNode.name = 'Pallet';
    const loadNode = new Object3D(); loadNode.name = 'Part';
    root.add(carrierNode); carrierNode.add(loadNode);
    const load: GuardMu & { loadedMus: GuardMu[] } = { node: loadNode, isInstanced: false, loadedMus: [] };
    const carrier = { node: carrierNode, isInstanced: false, preplaced: true, loadedMus: [load] as GuardMu[] };
    const host = { mus: [carrier] as GuardMu[], preplacedMUs: [carrier] as GuardMu[] };
    const tm = { sources: [], mus: host.mus, preplacedMUs: host.preplacedMUs.map((m) => ({ ...m, id: 7 })) };
    const { input } = collectStageInput({ root, transportManager: tm } as never);
    expect(input.exclude.has(loadNode)).toBe(true);
    const tree = buildRuntimeStageTree(input, { primNames: 'sibling', structure: true });
    expect(tree.nodes).toEqual([root, carrierNode]);
    const guard = new StructureGuard({
      baseline: tree.structure!, exclude: input.exclude, templates: new Set(),
      preplacedNodes: new Set([carrierNode]), muHost: () => host,
    });
    expect(guard.checkIndex()).toBe(-1);
    // A gizmo at the carrier: its raw children differ → the slow path must agree with the baseline.
    const gizmo = new Object3D(); gizmo.userData._rvGizmo = true; carrierNode.add(gizmo);
    expect(guard.checkIndex()).toBe(-1);
    // Unload: the load becomes active and leaves the carrier.
    carrier.loadedMus.length = 0; host.mus.push(load); root.attach(loadNode);
    expect(guard.checkIndex()).toBe(-1);
  });

  it('rebase: after a detection the guard compares against the last observed state', () => {
    const r = rig(2000);
    const victim = r.exported[500];
    victim.name = 'A';
    expect(r.guard.checkIndex()).toBeGreaterThanOrEqual(0);
    r.guard.rebase();
    expect(r.guard.checkIndex()).toBe(-1);
    victim.name = 'B';
    expect(r.guard.checkIndex()).toBeGreaterThanOrEqual(0);
  });

  it('per-sample cost on 18 225 nodes: CSR fast path within the 0.2 ms budget (median)', () => {
    const quiet = rig(LARGE_MODEL_NODES, false);
    const q = timeChecks(quiet.guard, 2000);
    // Capture alone (the guard's re-capture = the same function the export pass calls).
    const c0 = performance.now();
    quiet.guard.rebase();
    const captureOnlyMs = performance.now() - c0;
    const r = rig();
    const N = 2000;
    for (let i = 0; i < 200; i++) expect(r.guard.checkIndex()).toBe(-1);
    const s = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      if (r.guard.checkIndex() !== -1) throw new Error('false positive');
      s[i] = performance.now() - a;
    }
    s.sort();
    const median = s[N >> 1];
    const p95 = s[Math.floor(N * 0.95)];
    // eslint-disable-next-line no-console
    console.log(`[plan-2239 structure guard] ${r.exported.length} nodes: export tree pass incl. capture ${r.captureMs.toFixed(1)} ms, `
      + `capture alone ${captureOnlyMs.toFixed(1)} ms; `
      + `check without MU churn median ${q.median.toFixed(4)} ms p95 ${q.p95.toFixed(4)} ms; `
      + `with ${r.mus.length} MUs spawned under exported nodes median ${median.toFixed(4)} ms p95 ${p95.toFixed(4)} ms`);
    // Budget 0.2 ms (plan NFR); the ceiling leaves room for a loaded shared machine.
    expect(q.median).toBeLessThan(0.6);
    expect(median).toBeLessThan(0.6);
  });

  it('the check allocates nothing (heap delta with forced GC, no scavenge during 3000 checks)', async () => {
    const r = rig();
    let sink = 0;
    const clean = await allocationProbe(() => { sink += r.guard.checkIndex(); }, 3000);
    // Control: the probe must see a check that allocates (here: 1 KB per call).
    let keep: unknown = null;
    const dirty = await allocationProbe(() => { sink += r.guard.checkIndex(); keep = new Array(128).fill(sink); }, 3000);
    // eslint-disable-next-line no-console
    console.log(`[plan-2239 structure guard alloc] clean: ${clean.grownBytes} B, ${clean.gcs} GCs; `
      + `allocating control: ${dirty.grownBytes} B, ${dirty.gcs} GCs`);
    expect(keep).not.toBeNull();
    expect(dirty.grownBytes > 256 * 1024 || dirty.gcs > 0).toBe(true);
    expect(clean.gcs).toBe(0);
    expect(clean.grownBytes).toBeLessThan(16 * 1024);
  });
});

describe('usd-live-link MU inventory (active MUs + passive loads in the scene, plan-2239 review #2 follow-ups)', () => {
  type Mu = { id: number; node: Object3D; isInstanced: boolean; preplaced?: boolean; loadedMus: Mu[] };
  const scene = new Scene();
  /** An MU whose node hangs under `parent` (a carrier's node for a load). */
  const mu = (id: number, extra: Partial<Mu> = {}, parent: Object3D = scene): Mu => {
    const m: Mu = { id, node: new Object3D(), isInstanced: false, loadedMus: [], ...extra };
    parent.add(m.node);
    return m;
  };
  const load = (carrier: Mu, id: number, extra: Partial<Mu> = {}): Mu => {
    const m = mu(id, extra, carrier.node);
    carrier.loadedMus.push(m);
    return m;
  };

  it('lists the active MUs as they are, adds spawned AND pre-placed passive loads recursively once by id', () => {
    const pool = mu(1, { isInstanced: true });
    const carrier = mu(2, { preplaced: true });
    const spawned = load(carrier, 3); load(spawned, 4); load(carrier, 5, { preplaced: true });
    const spawnedCarrier = mu(6); load(spawnedCarrier, 7);
    const host = { mus: [pool, carrier, spawnedCarrier], preplacedMUs: [carrier, carrier.loadedMus[1]] };
    const inv = new LiveMuInventory<Mu>(() => host);
    expect(inv.list().map((m) => m.id)).toEqual([1, 2, 6, 3, 4, 5, 7]);
    // Without any load: exactly the active list.
    const keep = carrier.loadedMus.slice(), keep2 = spawnedCarrier.loadedMus.slice();
    carrier.loadedMus.length = 0; spawnedCarrier.loadedMus.length = 0;
    expect(inv.list().map((m) => m.id)).toEqual([1, 2, 6]);
    carrier.loadedMus.push(...keep); spawnedCarrier.loadedMus.push(...keep2);
    // removeMU / sink: the carrier leaves the active list and its node the scene —
    // it stays registered as pre-placed and keeps its loads, which ride out of the scene.
    host.mus.splice(host.mus.indexOf(carrier), 1);
    scene.remove(carrier.node);
    expect(inv.list().map((m) => m.id)).toEqual([1, 6, 7]);
  });

  it('list() allocates nothing per sample (heap delta with forced GC, no scavenge during 30 000 calls)', async () => {
    const carriers: Mu[] = [];
    for (let i = 0; i < 200; i++) {
      const c = mu(1000 + i);
      for (let j = 0; j < 3; j++) load(c, 10_000 + i * 10 + j, { preplaced: j === 2 });
      carriers.push(c);
    }
    const host = { mus: carriers, preplacedMUs: [] as Mu[] };
    const inv = new LiveMuInventory<Mu>(() => host);
    let sink = 0;
    const N = 30_000;
    const r = await allocationProbe(() => { sink += inv.list().length; }, N);
    // Control: one small array per call must be seen.
    let keep: unknown = null;
    const dirty = await allocationProbe(() => { sink += inv.list().length; keep = [sink]; }, N);
    // eslint-disable-next-line no-console
    console.log(`[plan-2239 MU inventory alloc] 200 carriers x 3 loads, ${N} calls: ${r.grownBytes} B, ${r.gcs} GCs; `
      + `allocating control: ${dirty.grownBytes} B, ${dirty.gcs} GCs`);
    expect(keep).not.toBeNull();
    expect(sink).toBe(2 * (N + 200) * 800); // every call (incl. 200 warm-ups per probe) listed all 800 MUs
    expect(r.gcs).toBe(0);
    // One object per call is >= 16 B x N; the remainder is fixed JIT/IC overhead (sub-linear in N).
    expect(r.grownBytes).toBeLessThan(4 * N);
    expect(dirty.grownBytes > 16 * N || dirty.gcs > 0).toBe(true);
  });
});
