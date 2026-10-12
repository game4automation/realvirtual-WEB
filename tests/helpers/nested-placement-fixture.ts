// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * nested-placement-fixture — the shared world of the plan-757 Phase 2 tests
 * ("a reference is a placement, always"): assets that reference other assets,
 * served by a fake `GLTFLoader.loadAsync` keyed by `blob:` url (the URL seam of
 * `ModelCache._decode`, the same seam `scene-ready-contract.test.ts` uses), a
 * real `RVViewer` with the runtime PAUSED so that only `tick()` advances time.
 *
 *   INNER      Cell: Body (off-centre) + Slide {Drive, JogForward}   — the leaf asset
 *   OUTER      Machine: Frame + planner reference `Cell_1` → INNER
 *   OUTER_HAND Machine: Frame + hand-authored reference `CellRef` → INNER
 *   OUTER_DEEP Machine: Frame / Mount (static intermediate) / `Cell_1` → INNER
 *   SELF       Ouroboros: references ITSELF (under another catalog id — F13)
 *   CYC_A/B    A → B → A
 *   MANY       Many: 6 planner references → INNER
 *   DEPTH(n)   Depth n → Depth n+1, unbounded
 *   ROOT_CYCLE Boomerang: references the DOCUMENT url (F13, seeded chain)
 *
 * Positions are metres. Every `Slide` carries the NodeId `nid-slide` (the
 * save-routing tests address it by that id inside the referenced file).
 */
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { createPickBuildPort } from '../../src/core/engine/rv-pick-build-port';
import { ModelCache } from '../../src/core/engine/rv-model-cache';
import { setAssetReference, setPlacementMeta } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { gltfLoader } from '../../src/core/engine/rv-glb-parse';
import type { PlacementsSettledInfo } from '../../src/core/engine/rv-placement-instancer';
import { parseGlbChunks } from '../../src/core/persistence/rv-glb-chunks';
import { createTestViewer, type TestViewerHandle } from './create-test-viewer';
import { withComponent, group } from '../fixtures/bake-fixture';

// ─── Asset urls of the fake loader ──────────────────────────────────────

export const INNER_URL = 'blob:rv-test/p757-inner.glb';
export const OUTER_URL = 'blob:rv-test/p757-outer.glb';
export const OUTER_HAND_URL = 'blob:rv-test/p757-outer-hand.glb';
export const OUTER_DEEP_URL = 'blob:rv-test/p757-outer-deep.glb';
export const SELF_URL = 'blob:rv-test/p757-self.glb';
export const CYC_A_URL = 'blob:rv-test/p757-cyc-a.glb';
export const CYC_B_URL = 'blob:rv-test/p757-cyc-b.glb';
export const MANY_URL = 'blob:rv-test/p757-many.glb';
export const MANY_REFS = 6;
export const DEPTH_URL = (n: number): string => `blob:rv-test/p757-depth-${n}.glb`;
/** The DOCUMENT url a `ROOT_CYCLE_URL` asset references back to (F13). */
export const DOC_URL = 'blob:rv-test/p757-doc.glb';
export const ROOT_CYCLE_URL = 'blob:rv-test/p757-boomerang.glb';
/** Phase 2b (F12): a Cell that carries a PLC signal `Signals/Speed` (= 55), and a Machine placing it TWICE. */
export const SIGNAL_INNER_URL = 'blob:rv-test/p757-signal-cell.glb';
export const OUTER_SIGNAL_URL = 'blob:rv-test/p757-outer-signal.glb';

export const SLIDE_NODE_ID = 'nid-slide';
export const CELL_REF_NODE_ID = 'nid-cell';

/** Off-centre content so the floor-centre pivot is measurable: AABB x 1.5…2.5, y 0…0.7 → offset (−2, 0, 0). */
export function makeInner(): Group {
  const root = group('Cell');
  const body = new Mesh(new BoxGeometry(1, 0.5, 1), new MeshStandardMaterial({ color: 0x336699 }));
  body.name = 'Body';
  body.position.set(2, 0.25, 0);
  root.add(body);
  const slide = withComponent(group('Slide'), 'Drive', { Direction: 'LinearX', TargetSpeed: 200, JogForward: true });
  setNodeId(slide, SLIDE_NODE_ID);
  slide.position.set(2, 0.5, 0);
  const tool = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x99cc33 }));
  tool.name = 'Tool';
  tool.position.set(0, 0.1, 0);
  slide.add(tool);
  root.add(slide);
  return root;
}

/** {@link makeInner} plus a `Signals/Speed` PLCOutputFloat (55) — the MCP fan-out target inside a nested placement. */
export function makeSignalInner(): Group {
  const root = makeInner();
  root.name = 'SignalCell';
  const signals = new Object3D();
  signals.name = 'Signals';
  const speed = new Object3D();
  speed.name = 'Speed';
  speed.userData.realvirtual = { PLCOutputFloat: { Name: 'Speed', Status: { Value: 55 } } };
  signals.add(speed);
  root.add(signals);
  return root;
}

export interface RefSpec {
  name: string;
  id: string;
  url: string;
  planner: boolean;
  pos?: [number, number, number];
  /** Catalog id written into the reference (default `cat:<file stem>`). */
  assetId?: string;
}

export function referenceNode(name: string, id: string, url: string, planner: boolean, pos: [number, number, number], assetId?: string): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(...pos);
  setNodeId(node, id);
  setAssetReference(node, { assetId: assetId ?? `cat:${url.split('/').pop()}`, path: url });
  if (planner) setPlacementMeta(node, {});
  return node;
}

/** Outer asset: a frame mesh + reference node(s), optionally under a static intermediate node. */
export function makeOuter(name: string, refs: RefSpec[], opts?: { under?: string }): Group {
  const root = group(name);
  const frame = new Mesh(new BoxGeometry(3, 0.2, 3), new MeshStandardMaterial({ color: 0x777777 }));
  frame.name = 'Frame';
  frame.position.set(0, 0.1, 0);
  root.add(frame);
  let parent: Object3D = root;
  if (opts?.under) {
    const mount = new Object3D();
    mount.name = opts.under;
    mount.position.set(0, 0.2, 0);
    root.add(mount);
    parent = mount;
  }
  for (const r of refs) parent.add(referenceNode(r.name, r.id, r.url, r.planner, r.pos ?? [3, 0, 0], r.assetId));
  return root;
}

/** The tree the fake loader serves for `url`. */
export function treeFor(url: string): Group {
  switch (url) {
    case INNER_URL: return makeInner();
    case OUTER_URL: return makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: INNER_URL, planner: true }]);
    case OUTER_HAND_URL: return makeOuter('Machine', [{ name: 'CellRef', id: 'nid-cellref', url: INNER_URL, planner: false }]);
    case OUTER_DEEP_URL: return makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: INNER_URL, planner: true }], { under: 'Mount' });
    // F13: the self-reference is spelled under ANOTHER catalog id than the
    // document's reference to it — the same file, one key (`sourceOf`).
    case SELF_URL: return makeOuter('Ouroboros', [{ name: 'Self_1', id: 'nid-self', url: SELF_URL, planner: true, assetId: 'cat:ouroboros-alias' }]);
    case CYC_A_URL: return makeOuter('CycA', [{ name: 'B_1', id: 'nid-cyc-b', url: CYC_B_URL, planner: true }]);
    case CYC_B_URL: return makeOuter('CycB', [{ name: 'A_1', id: 'nid-cyc-a', url: CYC_A_URL, planner: true }]);
    case MANY_URL: return makeOuter('Many', Array.from({ length: MANY_REFS }, (_, i) => ({
      name: `Cell_${i + 1}`, id: `nid-many-${i + 1}`, url: INNER_URL, planner: true, pos: [i * 4, 0, 0] as [number, number, number],
    })));
    case ROOT_CYCLE_URL: return makeOuter('Boomerang', [{ name: 'Doc_1', id: 'nid-doc', url: DOC_URL, planner: true, assetId: 'cat:the-document' }]);
    case SIGNAL_INNER_URL: return makeSignalInner();
    case OUTER_SIGNAL_URL: return makeOuter('SignalMachine', [
      { name: 'SignalCell_1', id: 'nid-sig-1', url: SIGNAL_INNER_URL, planner: true, pos: [3, 0, 0] },
      { name: 'SignalCell_2', id: 'nid-sig-2', url: SIGNAL_INNER_URL, planner: true, pos: [3, 0, 4] },
    ]);
  }
  const depth = /p757-depth-(\d+)\.glb$/.exec(url);
  if (depth) {
    const n = Number(depth[1]);
    return makeOuter(`Depth${n}`, [{ name: `Depth${n + 1}_1`, id: `nid-depth-${n + 1}`, url: DEPTH_URL(n + 1), planner: true }]);
  }
  throw new Error(`fake loader: unknown url ${url}`);
}

export interface DocSpec { id: string; name: string; url: string; pos?: [number, number, number]; assetId?: string }

/** A layout document whose reference nodes point at the fake loader's urls. */
export async function documentBytes(specs: DocSpec[]): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  for (const s of specs) root.add(referenceNode(s.name, s.id, s.url, true, s.pos ?? [10, 0, 0], s.assetId));
  return objectToGlb(root);
}

export async function plainBytes(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Plain';
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x884422 }));
  m.name = 'box';
  root.add(m);
  return objectToGlb(root);
}

/** A fake loader serving {@link treeFor}; `gate(url)` holds that url's decode until `open()`. */
export function makeFakeLoader(opts?: { gate?: string }): { loader: GLTFLoader; open(): void; decodes: string[] } {
  let openGate!: () => void;
  const gate = new Promise<void>((r) => { openGate = r; });
  const decodes: string[] = [];
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      decodes.push(url);
      if (opts?.gate && url === opts.gate) await gate;
      return { scene: treeFor(url) };
    },
  } as unknown as GLTFLoader;
  return { loader, open: () => openGate(), decodes };
}

export interface Booted {
  h: TestViewerHandle;
  /** Let the gated asset decode. */
  open(): void;
  settled: PlacementsSettledInfo[];
  order: string[];
  added: Object3D[];
  removed: Object3D[];
  decodes: string[];
}

/** Real viewer, fake loader, runtime paused. `gate` holds one asset url until `open()`. */
export async function bootNestedViewer(opts?: { gate?: string; maxPlacementsPerLoad?: number }): Promise<Booted> {
  const h = await createTestViewer('webgl');
  const { loader, open, decodes } = makeFakeLoader({ gate: opts?.gate });
  h.viewer.placements.setModelCache(new ModelCache(loader, {
    uber: () => h.viewer.placementUberMaterial,
    isWebGPU: () => h.viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  // The cap is a settable property of the instancer (F9) — no reach-in.
  if (opts?.maxPlacementsPerLoad !== undefined) h.viewer.placements.maxPlacementsPerLoad = opts.maxPlacementsPerLoad;
  // `snapshotAfter`-style determinism: only `tick()` advances time.
  h.viewer.setSimulationPaused('nested-fixture', true);
  const settled: PlacementsSettledInfo[] = [];
  const order: string[] = [];
  const added: Object3D[] = [];
  const removed: Object3D[] = [];
  h.viewer.on('model-loaded', () => order.push('model-loaded'));
  h.viewer.on('layout-content-added', (data: unknown) => {
    const root = (data as { root?: Object3D }).root;
    if (root) added.push(root);
    order.push(`added:${root?.name ?? '?'}`);
  });
  h.viewer.on('layout-content-removed', (data: unknown) => {
    const root = (data as { root?: Object3D }).root;
    if (root) removed.push(root);
    order.push(`removed:${root?.name ?? '?'}`);
  });
  h.viewer.on('placements-materialized', (info) => {
    settled.push(info);
    order.push(info.aborted ? 'aborted' : 'materialized');
  });
  return { h, settled, order, added, removed, decodes, open };
}

export function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

export function jsonNodes(bytes: ArrayBuffer | Uint8Array): Array<Record<string, unknown>> {
  return (parseGlbChunks(toArrayBuffer(bytes)).json.nodes ?? []) as Array<Record<string, unknown>>;
}

export function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  return bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes;
}

/** `n` deterministic fixed steps of the paused runtime. */
export function tick(h: TestViewerHandle, n: number): void {
  const v = h.viewer as unknown as { _tickOnce(dt: number): void };
  for (let i = 0; i < n; i++) v._tickOnce(1 / 60);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Real-loader world: assets as `data:` urls ──────────────────────────
//
// The save-routing tests reload a document the BAKE wrote, and a written
// placement keeps its `AssetReference.path` only for a non-`blob:` url
// (`placementExtras`). A `data:` url survives the write, needs no fetch mock
// (the blob cache reads it natively) and takes the byte path of the REAL
// `GLTFLoader` — signature verdict, renamed nodes and `BakedAsset.url` included.

/** GLB bytes as a `data:` url — what a saved reference can carry across a reload. */
export function dataUrlOf(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return `data:model/gltf-binary;base64,${btoa(binary)}`;
}

/** The inner Cell as a `data:` url. */
export async function innerDataUrl(): Promise<string> {
  return dataUrlOf(await objectToGlb(makeInner()));
}

/** An outer Machine whose planner reference `Cell_1` points at `innerUrl`, as a `data:` url. */
export async function outerDataUrl(innerUrl: string): Promise<string> {
  return dataUrlOf(await objectToGlb(makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: innerUrl, planner: true, assetId: 'cat:cell' }])));
}

/** Real viewer, REAL loader (byte path), runtime paused — for documents whose references are `data:` urls. */
export async function bootRealLoaderViewer(): Promise<Booted> {
  const h = await createTestViewer('webgl');
  h.viewer.placements.setModelCache(new ModelCache(gltfLoader as unknown as GLTFLoader, {
    uber: () => h.viewer.placementUberMaterial,
    isWebGPU: () => h.viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  h.viewer.setSimulationPaused('nested-fixture', true);
  const settled: PlacementsSettledInfo[] = [];
  const order: string[] = [];
  const added: Object3D[] = [];
  const removed: Object3D[] = [];
  h.viewer.on('layout-content-added', (data: unknown) => {
    const root = (data as { root?: Object3D }).root;
    if (root) added.push(root);
    order.push(`added:${root?.name ?? '?'}`);
  });
  h.viewer.on('placements-materialized', (info) => { settled.push(info); order.push(info.aborted ? 'aborted' : 'materialized'); });
  return { h, settled, order, added, removed, decodes: [], open: () => {} };
}
