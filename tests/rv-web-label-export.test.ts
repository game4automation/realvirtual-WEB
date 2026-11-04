// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-529 §9.1c (SOL #5) — the runtime label visuals are NEVER saved.
 *
 * A document with a Billboard and a Plate label is exported through the real
 * `exportAssetGlb`: the file holds no label mesh / sprite, only the `WebLabel`
 * extras; export → reload → rebuild → export again yields identical node and
 * mesh counts (a save → reload → save cycle does not grow the geometry).
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import '../src/core/engine/rv-scene-loader';
import { constructComponentOnNode, type RuntimeNodeDeps } from '../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { WebLabelManager } from '../src/core/engine/rv-web-label-manager';
import { WEB_LABEL_TYPE } from '../src/core/engine/rv-web-label';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { isSensorRuntimeVizName } from '../src/core/engine/rv-sensor-viz-names';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';

interface GltfJson {
  nodes?: Array<{ name?: string; mesh?: number; extras?: Record<string, unknown> }>;
  meshes?: unknown[];
  materials?: unknown[];
  textures?: unknown[];
  images?: unknown[];
}

const BILLBOARD = { Mode: 'Billboard', Text: 'Info\nLine 2', Url: 'https://example.com' };
const PLATE = { Mode: 'Plate', Text: 'Model courtesy of Villette Oh (GrabCAD)', FontSize: 40 };

function buildDoc(): Group {
  const root = new Group();
  root.name = 'LabelDoc';
  const frame = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x777777 }));
  frame.name = 'Frame';
  root.add(frame);
  const b = new Object3D(); b.name = 'Info'; b.position.set(0, 1, 0);
  b.userData.realvirtual = { WebLabel: { ...BILLBOARD } };
  const p = new Object3D(); p.name = 'Credit'; p.position.set(0, 0.2, 0.51);
  p.userData.realvirtual = { WebLabel: { ...PLATE } };
  root.add(b, p);
  return root;
}

/** Construct every WebLabel under `root` the way the editor's runtime path does. */
function constructLabels(root: Object3D): WebLabelManager {
  const scene = new Scene();
  scene.add(root);
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const webLabelManager = new WebLabelManager();
  const deps: RuntimeNodeDeps = {
    registry, signalStore: new SignalStore(), scene, transportManager: new RVTransportManager(), webLabelManager,
  };
  const targets: Object3D[] = [];
  root.traverse((n) => { if ((n.userData.realvirtual as Record<string, unknown> | undefined)?.[WEB_LABEL_TYPE]) targets.push(n); });
  for (const n of targets) {
    const data = (n.userData.realvirtual as Record<string, Record<string, unknown>>)[WEB_LABEL_TYPE];
    expect(constructComponentOnNode(deps, n, WEB_LABEL_TYPE, { ...data })).toBeTruthy();
  }
  return webLabelManager;
}

function json(bytes: ArrayBuffer): GltfJson {
  return parseGlbChunks(bytes).json as GltfJson;
}

function counts(j: GltfJson) {
  return {
    nodes: j.nodes?.length ?? 0,
    meshes: j.meshes?.length ?? 0,
    materials: j.materials?.length ?? 0,
    textures: j.textures?.length ?? 0,
    images: j.images?.length ?? 0,
  };
}

describe('WebLabel export (§9.1c)', () => {
  it('no label mesh / sprite in the file; WebLabel extras present; save → reload → save does not grow', async () => {
    const root = buildDoc();
    const mgr = constructLabels(root);
    expect(mgr.size).toBe(2);
    // The runtime visuals are really there before the export.
    let runtimeVisuals = 0;
    root.traverse((n) => { if (n.userData._rvWebLabel) runtimeVisuals++; });
    expect(runtimeVisuals).toBe(2);

    const first = await exportAssetGlb(root, 'LabelDoc');
    const j1 = json(first);
    const names1 = (j1.nodes ?? []).map((n) => n.name);
    expect(names1).not.toContain('__rvWebLabelPlate');
    expect(names1).not.toContain('__rvWebLabelBillboard');
    // Only the frame carries a mesh; no canvas texture was written.
    expect(counts(j1)).toMatchObject({ meshes: 1, textures: 0, images: 0 });
    const info = (j1.nodes ?? []).find((n) => n.name === 'Info')!;
    const credit = (j1.nodes ?? []).find((n) => n.name === 'Credit')!;
    expect((info.extras!.realvirtual as Record<string, unknown>).WebLabel).toMatchObject(BILLBOARD);
    expect((credit.extras!.realvirtual as Record<string, unknown>).WebLabel).toMatchObject(PLATE);
    expect(info.mesh).toBeUndefined();
    expect(credit.mesh).toBeUndefined();

    // Reload the file, rebuild the labels, export again.
    const reloaded = (await gltfLoader.parseAsync(first.slice(0), '')).scene;
    const mgr2 = constructLabels(reloaded);
    expect(mgr2.size).toBe(2);
    const second = await exportAssetGlb(reloaded, 'LabelDoc');
    const j2 = json(second) as GltfJson & { buffers?: unknown; bufferViews?: unknown; accessors?: unknown };
    expect(counts(j2)).toEqual(counts(j1));
    // Geometry payload identical — nothing was added by the second save.
    const g1 = j1 as GltfJson & { buffers?: unknown; bufferViews?: unknown; accessors?: unknown };
    expect(j2.buffers).toEqual(g1.buffers);
    expect(j2.bufferViews).toEqual(g1.bufferViews);
    expect(j2.accessors).toEqual(g1.accessors);
    // Same label extras. (The raw GLTFLoader stamps `extras.name` on reload — a
    // parser artifact of this test's bare reload, not label data, so compared
    // without it.)
    const labelsOf = (j: GltfJson) => (j.nodes ?? []).map((n) => [n.name, n.mesh, (n.extras?.realvirtual as Record<string, unknown> | undefined)?.WebLabel]);
    expect(labelsOf(j2)).toEqual(labelsOf(j1));
    mgr.clear();
    mgr2.clear();
  });
});

// plan-529 Phase 5 — the SHIPPED demo file carries the credit plate as extras
// only, and a save of the loaded station writes the same extras back without
// the runtime plate (no geometry growth).
const DEMO_URLS = ['/demo-realvirtual/LaserWeldingAssemblyStation.glb', '/public/demo-realvirtual/LaserWeldingAssemblyStation.glb'];

async function fetchGlb(): Promise<ArrayBuffer | null> {
  for (const url of DEMO_URLS) {
    try {
      const res = await fetch(url);
      if (res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) return await res.arrayBuffer();
    } catch { /* next */ }
  }
  return null;
}

describe('demo station credit plate (Phase 5)', () => {
  it('WebLabel_Credit round-trips: extras only, plate built at load, save writes no plate', async (ctx) => {
    const bytes = await fetchGlb();
    if (!bytes) { ctx.skip('demo GLB not served'); return; }
    const j0 = json(bytes);
    const credit0 = (j0.nodes ?? []).find((n) => n.name === 'WebLabel_Credit');
    expect(credit0).toBeTruthy();
    expect(credit0!.mesh).toBeUndefined();
    const extras0 = (credit0!.extras!.realvirtual as Record<string, Record<string, unknown>>).WebLabel;
    // On the operator box's touch screen since 2026-10-14 (patch-welding-demo-look.mjs).
    expect(extras0).toMatchObject({ Mode: 'Plate', Text: 'Model courtesy of\nVillette Oh\n(GrabCAD)', FontSize: 40, PlateWidth: 300, PlateHeight: 228 });

    const scene = (await gltfLoader.parseAsync(bytes.slice(0), '')).scene;
    let creditNode: Object3D | null = null;
    scene.traverse((n) => { if (n.name === 'WebLabel_Credit') creditNode = n; });
    expect(creditNode).not.toBeNull();
    // Build only the credit label (the rest of the station is not under test).
    const holder = new Scene();
    holder.add(scene);
    const registry = new NodeRegistry();
    scene.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const mgr = new WebLabelManager();
    const inst = constructComponentOnNode(
      { registry, signalStore: new SignalStore(), scene: holder, transportManager: new RVTransportManager(), webLabelManager: mgr },
      creditNode as unknown as Object3D, WEB_LABEL_TYPE, { ...extras0 },
    );
    expect(inst).toBeTruthy();
    const plate = (creditNode as unknown as Object3D).children.find((c) => c.userData._rvLabelPlate) as Mesh;
    expect(plate).toBeTruthy();
    plate.geometry.computeBoundingBox();
    expect(plate.geometry.boundingBox!.max.x - plate.geometry.boundingBox!.min.x).toBeCloseTo(0.30, 6);

    const saved = await exportAssetGlb(scene, 'LaserWeldingAssemblyStation');
    const j1 = json(saved);
    expect((j1.nodes ?? []).map((n) => n.name)).not.toContain('__rvWebLabelPlate');
    // The shipped file still carries sensor ray tubes saved before the export
    // pruned `_sensorRay` (`Sensor_Lift01_sensorRay_1_1…`). A save drops them
    // now, so they are not part of the expected geometry.
    const nodes0 = j0.nodes ?? [];
    const used = new Set(nodes0.filter((n) => n.mesh !== undefined && !isSensorRuntimeVizName(n.name ?? '')).map((n) => n.mesh));
    const vizOnly = new Set(nodes0.filter((n) => n.mesh !== undefined && isSensorRuntimeVizName(n.name ?? '') && !used.has(n.mesh)).map((n) => n.mesh));
    expect(counts(j1).meshes).toBe(counts(j0).meshes - vizOnly.size);
    const credit1 = (j1.nodes ?? []).find((n) => n.name === 'WebLabel_Credit')!;
    expect((credit1.extras!.realvirtual as Record<string, unknown>).WebLabel).toEqual(extras0);
    mgr.clear();
  }, 120_000);
});
