// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 Phase 4 CP1d-b — PalletYard vehicles and conveyors as `AssetReference`
// placements instead of generator clones. Answers plan-559 M2.
// Step b0 (probe, the first two describes) and step b1 (the real, regenerated scene
// with the PalletYard plugin in DES, the last describe). After b1-0 (library asset
// AGVStacker.glb: tagged gear reference, ForkAnchor BakeRole) and b1-2 (engine: the
// document-root claim spelling is reported) the former `it.fails` are plain `it`.
//
// One in-memory layout document on the REAL viewer load path (`createTestViewer` →
// `registerAllBehaviors` → `loadModel` → deferred placements → `PlacementInstancer`):
//   - three straight paths `LaneA/B/C`, one stub `StubV1`;
//   - three stackers `Stapler_1..3` as hand-authored references (NO `PlacementMeta`)
//     of `library/MobileRobots/AGVStacker.glb`. `Stapler_1/2` carry their `Agv` config
//     ON the reference node; `Stapler_3` tries the `byPath` override route instead;
//     `Stapler_2` additionally overrides `Lift` TargetSpeed via `byPath`;
//   - two conveyors `Conveyor_V1/V2` as references of `PalletHandling/RollConveyor-2m.glb`,
//     `Conveyor_V1` with a plugin-style string field naming its stub path;
//   - a probe plugin with `bakeClaims()` aimed into a placement and an `onModelLoaded`
//     snapshot (same lifecycle slot the PalletYard plugin binds in today).
//
// Every assertion on a looked-up value first asserts that it exists (#211).
// Private-dependent only by location (it belongs to the pallet-yard test family).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Vector3 } from 'three';
import type { LoadResult } from '../../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { RVDrive } from '../../src/core/engine/rv-drive';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { setAssetOverrides, setAssetReference } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { instanceScope } from '../../src/core/engine/rv-instance-scope';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getProblems } from '../../src/core/hmi/problems-store';
import type { DESRunner } from '@rv/plugins/des/des-runner';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard/index';
import type { DesHandoverBackend } from '@rv/plugins/des/fleet/des-handover';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { clearShared } from '../helpers/agv-harness';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';

const STACKER = 'library/MobileRobots/AGVStacker.glb';
const CONVEYOR = 'library/PalletHandling/RollConveyor-2m.glb';
const AVAILABLE = (await devAssetAvailable(`/${STACKER}`)) && (await devAssetAvailable(`/${CONVEYOR}`));

const DOC_ROOT = 'ProbeRoot';
const HOLD = 'plan-612-b0';

type V3 = [number, number, number];
const agvCfg = (pathId: string, startMm: number): Record<string, unknown> => ({
  PathId: pathId, StartPosition: startMm, TargetSpeed: 800, VehicleLength: 1900, VehicleWidth: 900,
  AllowReverse: true, ReverseSpeed: 300,
});

function pathNode(id: string, from: V3, to: V3): Object3D {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = {
    Path: { type: 'Path', version: 1, closed: false, align: [0, 1, 0], id, segments: [{ kind: 'line', from, to }], successors: [] },
  };
  return n;
}

function refNode(name: string, path: string, pos: V3, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(...pos);
  setNodeId(n, `nid-${name}`);
  setAssetReference(n, { assetId: `cat:${path.split('/').pop()}`, path });
  if (extras) Object.assign(n.userData.realvirtual as Record<string, unknown>, extras);
  return n;
}

async function documentBytes(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = DOC_ROOT;
  root.add(pathNode('LaneA', [0, 0, 0], [20, 0, 0]));
  root.add(pathNode('LaneB', [0, 0, 6], [20, 0, 6]));
  root.add(pathNode('LaneC', [0, 0, 12], [20, 0, 12]));
  root.add(pathNode('StubV1', [5, 0, 20], [5, 0, 17]));
  // Agv config on the reference node (route 1).
  root.add(refNode('Stapler_1', STACKER, [0, 0, 0], { Agv: agvCfg('LaneA', 2000) }));
  const s2 = refNode('Stapler_2', STACKER, [0, 0, 6], { Agv: agvCfg('LaneB', 5000) });
  // Per-instance override of a CHILD component (asset-relative byPath).
  setAssetOverrides(s2, { byAddress: {}, legacyByPath: { Lift: { Drive: { TargetSpeed: 111 } } } });
  root.add(s2);
  // Agv config ONLY as byPath override (route 2): root spelled '' and as the asset root name.
  const s3 = refNode('Stapler_3', STACKER, [0, 0, 12]);
  setAssetOverrides(s3, { byAddress: {}, legacyByPath: { '': { Agv: agvCfg('LaneC', 3000) }, AGV_Stacker: { Agv: agvCfg('LaneC', 3000) } } });
  root.add(s3);
  // Conveyors: bind by asset name (`*Conveyor*`), V1 carries a plugin-style stub link.
  root.add(refNode('Conveyor_V1', CONVEYOR, [5, 0, 22], { TransferProbe: { StubPathId: 'StubV1' } }));
  root.add(refNode('Conveyor_V2', CONVEYOR, [10, 0, 22]));
  return objectToGlb(root);
}

// ── Probe state ─────────────────────────────────────────────────────────────

interface Snapshot { liftUnderStapler1: boolean; stapler1Children: number; agvSignals: string[] }
const order: string[] = [];
const atModelLoadedPlugin: Snapshot[] = [];
const atModelLoadedEvent: Snapshot[] = [];
const atFirstContentAdded = new Map<string, Snapshot>();
let atMaterialized: Snapshot | null = null;

let handle: TestViewerHandle;
let viewer: RVViewer;
let model: Object3D;

/** Each `/` segment is the NEAREST descendant of that name (wrapper nodes such as the
 *  document root or a placed asset's own root in between are skipped). */
const find = (root: Object3D, path: string): Object3D | null => {
  let cur: Object3D | null = root;
  for (const seg of path.split('/')) {
    const queue: Object3D[] = [...(cur?.children ?? [])];
    let hit: Object3D | null = null;
    while (queue.length) {
      const n = queue.shift()!;
      if (n.name === seg) { hit = n; break; }
      queue.push(...n.children);
    }
    cur = hit;
    if (!cur) return null;
  }
  return cur;
};
const pathOf = (n: Object3D | null): string => {
  const parts: string[] = [];
  for (let c = n; c; c = c.parent) parts.unshift(c.name || '?');
  return parts.join('/');
};
const agvSignalNames = (): string[] => [...(viewer.signalStore?.getAll().keys() ?? [])].filter((n) => /(^|\.)Agv\./.test(n)).sort();
const flowSignalNames = (): string[] => [...(viewer.signalStore?.getAll().keys() ?? [])].filter((n) => /(^|\.)Flow\./.test(n)).sort();
function snap(root: Object3D | null): Snapshot {
  const s1 = root ? find(root, 'Stapler_1') : null;
  return { liftUnderStapler1: !!(s1 && find(s1, 'Lift')), stapler1Children: s1?.children.length ?? -1, agvSignals: agvSignalNames() };
}
const driveOf = (node: Object3D | null): RVDrive | null => (node ? viewer.drives.find((d) => d.node === node) ?? null : null);
const tick = (n: number): void => {
  const v = viewer as unknown as { _tickOnce(dt: number): void };
  for (let i = 0; i < n; i++) v._tickOnce(1 / 60);
};
const agvBinds = () => viewer.behaviors.getActiveBinds().filter((b) => b.behaviorId === 'Agv');
const conveyorBinds = () => viewer.behaviors.getActiveBinds().filter((b) => b.behaviorId === 'Conveyor');

describe.skipIf(!AVAILABLE)('plan-612 CP1d-b b0 — PalletYard parts as AssetReference placements', () => {
  beforeAll(async () => {
    clearShared();
    handle = await createTestViewer('webgl');
    viewer = handle.viewer;
    viewer.loop.setPaused(HOLD, true);
    registerAllBehaviors(viewer.behaviors);
    viewer.use({
      id: 'plan-612-b0-probe',
      // Two spellings: the full registry path (model root 'AuxScene' of a bytes load) and the
      // document-root form the PalletYard plugin uses today (`PalletYardRoot/Stapler_N/...`).
      bakeClaims: () => [
        { path: `AuxScene/${DOC_ROOT}/Stapler_1/Lift/ForkAnchor`, role: 'merge' as const },
        { path: `${DOC_ROOT}/Stapler_2/Lift/ForkAnchor`, role: 'merge' as const },
      ],
      onModelLoaded: (r: LoadResult) => { order.push('plugin.onModelLoaded'); atModelLoadedPlugin.push(snap(r.root)); },
    } as never);
    viewer.on('model-loaded', () => { order.push('model-loaded'); atModelLoadedEvent.push(snap(model ?? (viewer as unknown as { currentModel: Object3D }).currentModel)); });
    viewer.on('model-logic-activated', () => order.push('model-logic-activated'));
    viewer.on('layout-content-added', (d: unknown) => {
      const root = (d as { root?: Object3D }).root;
      order.push(`added:${root?.name ?? '?'}`);
      if (root && !atFirstContentAdded.has(root.name)) {
        atFirstContentAdded.set(root.name, snap((viewer as unknown as { currentModel: Object3D }).currentModel));
      }
    });
    viewer.on('placements-materialized', () => {
      order.push('placements-materialized');
      atMaterialized = snap((viewer as unknown as { currentModel: Object3D }).currentModel);
    });
    await viewer.loadModel('placement-probe.glb', { data: await documentBytes() });
    await viewer.whenSceneReady();
    order.push('whenSceneReady');
    model = (viewer as unknown as { currentModel: Object3D }).currentModel;
    viewer.scene.updateMatrixWorld(true);
  }, 180_000);

  afterAll(() => { handle?.dispose(); clearShared(); });

  // ── 4. Bind time ─────────────────────────────────────────────────────────
  it('4: placements materialise AFTER onModelLoaded / model-loaded; complete at placements-materialized and whenSceneReady', () => {
    expect(model, 'model loaded').toBeTruthy();
    expect(atModelLoadedPlugin).toHaveLength(1);
    expect(atModelLoadedPlugin[0].liftUnderStapler1, 'plugin onModelLoaded sees NO stacker content').toBe(false);
    expect(atModelLoadedPlugin[0].stapler1Children, 'Stapler_1 is an empty reference node there').toBe(0);
    expect(atModelLoadedEvent).toHaveLength(1);
    expect(atModelLoadedEvent[0].liftUnderStapler1, 'model-loaded event sees NO stacker content').toBe(false);
    expect(atFirstContentAdded.get('Stapler_1')?.liftUnderStapler1, 'layout-content-added(Stapler_1) carries the content').toBe(true);
    expect(atMaterialized, 'placements-materialized fired').not.toBeNull();
    expect(atMaterialized!.liftUnderStapler1).toBe(true);
    const iPlugin = order.indexOf('plugin.onModelLoaded');
    const iLoaded = order.indexOf('model-loaded');
    const iMat = order.indexOf('placements-materialized');
    const iReady = order.indexOf('whenSceneReady');
    const added = ['Stapler_1', 'Stapler_2', 'Stapler_3', 'Conveyor_V1', 'Conveyor_V2'].map((n) => order.indexOf(`added:${n}`));
    expect(iPlugin).toBeGreaterThanOrEqual(0);
    for (const a of added) {
      expect(a, `layout-content-added per placement (${order.join(' > ')})`).toBeGreaterThan(iLoaded);
      expect(a).toBeLessThan(iMat);
    }
    expect(iPlugin).toBeLessThan(iLoaded);
    expect(iMat).toBeLessThan(iReady);
    console.info(`[b0] event order: ${order.join(' > ')}`);
  });

  // ── 1. Agv per instance ──────────────────────────────────────────────────
  it('1: Agv config on the reference node binds per instance with its own path and start; signals are scoped Stapler_N.Agv.*', () => {
    const s1 = find(model, 'Stapler_1');
    const s2 = find(model, 'Stapler_2');
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    // LayoutObject stamp on a DOCUMENT reference (no PlacementMeta, no planner record).
    const lo1 = (s1!.userData.realvirtual as Record<string, unknown>).LayoutObject;
    expect(lo1, 'stampPlacementMarkers stamps a document reference too').toBeTruthy();
    expect(typeof s1!.userData._layoutId).toBe('string');
    expect(instanceScope(find(s1!, 'Lift')!)).toBe('Stapler_1');
    expect(instanceScope(find(s2!, 'Lift')!)).toBe('Stapler_2');
    // Agv extras survive materialise on the reference node.
    expect((s1!.userData.realvirtual as Record<string, Record<string, unknown>>).Agv?.PathId).toBe('LaneA');
    expect((s2!.userData.realvirtual as Record<string, Record<string, unknown>>).Agv?.PathId).toBe('LaneB');

    const binds = agvBinds().map((b) => b.nodePath).sort();
    console.info(`[b0] Agv binds: ${JSON.stringify(binds)}; Agv signals at onModelLoaded: ${JSON.stringify(atModelLoadedPlugin[0].agvSignals)}; now: ${JSON.stringify(agvSignalNames())}`);
    const mbs = getDefaultMovementAuthority('continuous');
    expect(mbs.has('Stapler_1'), 'Stapler_1 is a vehicle').toBe(true);
    expect(mbs.has('Stapler_2'), 'Stapler_2 is a vehicle').toBe(true);
    // Exactly ONE bind per configured vehicle (no double bind load + dispatchPlaced).
    expect(binds.filter((p) => /Stapler_1$/.test(p ?? ''))).toHaveLength(1);
    expect(binds.filter((p) => /Stapler_2$/.test(p ?? ''))).toHaveLength(1);

    // Own path + own start: the root sits on its lane at its StartPosition.
    const net = getDefaultPathNetwork();
    for (const [node, lane, startMm] of [[s1!, 'LaneA', 2000], [s2!, 'LaneB', 5000]] as const) {
      const p = net.get(lane);
      expect(p, `${lane} registered`).not.toBeNull();
      const want = p!.getAbsPosition(startMm / 1000, new Vector3());
      const got = node.getWorldPosition(new Vector3());
      expect(got.distanceTo(want) * 1000, `${node.name} at ${lane}@${startMm}`).toBeLessThan(1);
    }

    // Signals: separate per instance, no unscoped Agv.* left.
    const names = agvSignalNames();
    expect(names).toContain('Stapler_1.Agv.Run');
    expect(names).toContain('Stapler_2.Agv.Run');
    expect(names).toContain('Stapler_1.Agv.Position');
    expect(names.filter((n) => n.startsWith('Agv.')), 'no unscoped Agv signal').toEqual([]);
  });

  it('1b: Agv as byPath override — "" orphans; the asset root name lands on the asset-root CHILD (vehicle id = "Stapler_3.AGV_Stacker")', () => {
    const s3 = find(model, 'Stapler_3');
    expect(s3).not.toBeNull();
    const inner = find(s3!, 'AGV_Stacker');
    expect(inner, 'Stapler_3 materialised (asset root kept as a child node)').not.toBeNull();
    expect(inner!.parent, 'the asset root is a DIRECT child of the reference node').toBe(s3);
    expect((s3!.userData.realvirtual as Record<string, unknown>).Agv, 'no Agv on the reference node').toBeUndefined();
    expect((inner!.userData.realvirtual as Record<string, Record<string, unknown>>).Agv?.PathId, 'byPath "AGV_Stacker" patched the child').toBe('LaneC');
    const mb = getDefaultMovementAuthority('continuous');
    expect(mb.has('Stapler_3'), 'Stapler_3 is NOT the vehicle id').toBe(false);
    // plan-559 Phase 2b: the vehicle id is scoped by the placement (it used to be the bare asset root
    // name "AGV_Stacker", which collided across instances).
    expect(mb.has('AGV_Stacker'), 'no bare asset-root id any more').toBe(false);
    expect(mb.has('Stapler_3.AGV_Stacker'), 'the vehicle id is scoped by the placement').toBe(true);
    expect(agvBinds().filter((b) => /Stapler_3\/AGV_Stacker$/.test(b.nodePath))).toHaveLength(1);
    expect(agvSignalNames()).toContain('Stapler_3.Agv.Run'); // signals still scoped by the placement root
    const orphans = getProblems().filter((p) => p.code === 'override-orphaned' && /Stapler_3/.test(`${p.id} ${p.detail ?? ''} ${p.title ?? ''} ${p.nodePath ?? ''}`));
    expect(orphans.length, 'only the "" key is orphaned').toBe(1);
  });

  // ── 2. Lift / LiftRam per instance ──────────────────────────────────────
  it('2a: Lift per instance; byPath child override (Lift TargetSpeed) on Stapler_2 only', () => {
    const lift1 = driveOf(find(model, 'Stapler_1/Lift'));
    const lift2 = driveOf(find(model, 'Stapler_2/Lift'));
    expect(lift1).not.toBeNull();
    expect(lift2).not.toBeNull();
    expect(lift1).not.toBe(lift2);
    expect(lift1!.targetSpeed, 'asset value').toBe(250);
    expect(lift2!.targetSpeed, 'byPath override on Stapler_2 only').toBe(111);
    const p2Before = lift2!.currentPosition;
    lift1!.startMove(400);
    tick(240); // 4 s at 250 mm/s
    expect(lift1!.currentPosition).toBeCloseTo(400, 0);
    expect(lift2!.currentPosition, 'Stapler_2 Lift unmoved').toBe(p2Before);
  });

  // b0 FINDING (asset, fixed in b1-0): AGVStacker.glb wrote Drive_Gear.MasterDrive WITHOUT
  // type:'ComponentReference' — never resolved, LiftRam NaN. The asset now carries the tagged
  // reference (tools/solidcraft/agv-stacker/patch-agv-stacker-glb.mjs).
  it('2b: LiftRam follows its OWN Lift through Drive_Gear', () => {
    const lift1 = driveOf(find(model, 'Stapler_1/Lift'));
    const ram1 = driveOf(find(model, 'Stapler_1/LiftRam'));
    const ram2 = driveOf(find(model, 'Stapler_2/LiftRam'));
    expect(lift1).not.toBeNull();
    expect(ram1).not.toBeNull();
    expect(ram2).not.toBeNull();
    expect(lift1!.currentPosition).toBeCloseTo(400, 0);
    expect(ram1!.currentPosition, 'gear 0.5 follows its OWN Lift').toBeCloseTo(200, 0);
    expect(ram2!.currentPosition, 'Stapler_2 LiftRam unmoved').toBe(0);
  });

  it('2c: the gear master is the RESOLVED Lift drive of the same instance (no raw reference object, no NaN)', () => {
    const lift1 = driveOf(find(model, 'Stapler_1/Lift'));
    const ram1 = driveOf(find(model, 'Stapler_1/LiftRam'));
    expect(lift1).not.toBeNull();
    expect(ram1).not.toBeNull();
    const gear = (ram1 as unknown as { driveBehaviors: Array<{ master?: unknown }> }).driveBehaviors.find((b) => 'master' in b);
    expect(gear, 'Drive_Gear registered on LiftRam').toBeTruthy();
    expect(gear!.master, 'master = Stapler_1/Lift (not Stapler_2/3)').toBe(lift1);
    expect(Number.isNaN(ram1!.currentPosition)).toBe(false);
  });

  // ── 3. Bake survival in the placement ───────────────────────────────────
  it('3: Lamps (and therefore Chassis), Lift, LiftRam, Snap-Load and Lift/ForkAnchor (library BakeRole, b1-0) survive the placement bake; plugin claims into it are reported in BOTH spellings', () => {
    const s1 = find(model, 'Stapler_1');
    expect(s1).not.toBeNull();
    const lamps: string[] = [];
    const all: string[] = [];
    s1!.traverse((n) => {
      if (/^Lamp_/.test(n.name)) lamps.push(n.name);
      if (!n.userData?._rvBakeChunk && n !== s1) all.push(pathOf(n).replace(pathOf(s1!) + '/', ''));
    });
    console.info(`[b0] Stapler_1 subtree: ${all.join(', ')}`);
    expect(lamps.sort()).toEqual(['Lamp_Beacon', 'Lamp_EyeL', 'Lamp_EyeR', 'Lamp_StackAmber', 'Lamp_StackGreen', 'Lamp_StackRed']);
    expect(find(s1!, 'Lift'), 'Lift (Drive) survives').not.toBeNull();
    expect(find(s1!, 'Snap-Load'), 'Snap-Load survives').not.toBeNull();
    expect(find(s1!, 'LiftRam'), 'LiftRam (Drive) survives').not.toBeNull();
    // Chassis has no component; it survives only as the PARENT of the Lamp nodes.
    const chassis = find(s1!, 'Chassis');
    expect(chassis, 'Chassis kept as lamp parent').not.toBeNull();
    expect(chassis!.children.every((c) => /^Lamp_/.test(c.name) || c.userData?._rvBakeChunk === true), 'only lamps under Chassis').toBe(true);
    // ForkAnchor (empty, component-less) survives by its authored BakeRole in the library asset.
    expect(find(s1!, 'Lift/ForkAnchor'), 'ForkAnchor kept (library rv.BakeRole merge)').not.toBeNull();
    for (const v of ['Stapler_2', 'Stapler_3']) expect(find(find(model, v)!, 'Lift/ForkAnchor'), v).not.toBeNull();
    const claims = getProblems().filter((p) => p.code === 'plugin-claim-not-applicable');
    console.info(`[b0] claim problems: ${JSON.stringify(claims.map((c) => c.id))}; Stapler_1 registry path: ${viewer.registry?.getPathForNode(s1!)}`);
    expect(claims.filter((p) => p.id.includes('Stapler_1/Lift/ForkAnchor')), 'full-path claim into the placement reported').toHaveLength(1);
    // b0 FINDING, fixed in b1-2 (rv-placement-integrate.ts reportClaimsInsidePlacement): the
    // document-root spelling (`ProbeRoot/Stapler_2/...`) is read like the main-model bake reads
    // it and reported — no longer silently lost.
    expect(claims.filter((p) => p.id.includes('Stapler_2/Lift/ForkAnchor')), 'doc-root spelling: reported').toHaveLength(1);
  });

  // ── 5. Conveyor placements ──────────────────────────────────────────────
  it('5: two RollConveyor placements bind with separate Flow signals; V2.Flow.Run=false stops only V2', () => {
    const names = flowSignalNames();
    console.info(`[b0] Flow signals: ${JSON.stringify(names)}; Conveyor binds: ${JSON.stringify(conveyorBinds().map((b) => b.nodePath))}`);
    expect(conveyorBinds()).toHaveLength(2);
    for (const c of ['Conveyor_V1', 'Conveyor_V2']) {
      expect(names).toContain(`${c}.Flow.Run`);
      expect(names).toContain(`${c}.Flow.Occupied`);
    }
    expect(names.filter((n) => n.startsWith('Flow.')), 'no unscoped Flow signal').toEqual([]);
    const store = viewer.signalStore;
    expect(store, "signal store").not.toBeNull();
    if (!store) return;
    const belt = (c: string): RVDrive | null => {
      const t = find(model, `${c}/Transport-Z`);
      return driveOf(t) ?? (t ? viewer.drives.find((d) => { let n: Object3D | null = d.node; while (n) { if (n === t) return true; n = n.parent; } return false; }) ?? null : null);
    };
    store.set('Conveyor_V1.Flow.Run', true);
    store.set('Conveyor_V2.Flow.Run', true);
    tick(30);
    const runV1 = store.get('Conveyor_V1.Flow.Running');
    const runV2 = store.get('Conveyor_V2.Flow.Running');
    store.set('Conveyor_V2.Flow.Run', false);
    tick(30);
    const runV1b = store.get('Conveyor_V1.Flow.Running');
    const runV2b = store.get('Conveyor_V2.Flow.Running');
    console.info(`[b0] Running V1/V2 before ${runV1}/${runV2}, after V2.Run=false ${runV1b}/${runV2b}; belts ${belt('Conveyor_V1')?.node.name}/${belt('Conveyor_V2')?.node.name}`);
    expect(runV1).toBe(true);
    expect(runV2).toBe(true);
    expect(runV1b, 'V1 keeps running').toBe(true);
    expect(runV2b, 'V2 stopped').toBe(false);
  });

  // ── 6. Stub by Path-Id string at a conveyor placement ───────────────────
  it('6: a string field on the conveyor reference node survives and resolves late against the PathNetwork', () => {
    const v1 = find(model, 'Conveyor_V1');
    expect(v1).not.toBeNull();
    const tp = (v1!.userData.realvirtual as Record<string, Record<string, unknown>>).TransferProbe;
    expect(tp, 'reference-node extras survive materialise').toBeTruthy();
    expect(tp.StubPathId).toBe('StubV1');
    const stub = getDefaultPathNetwork().get(tp.StubPathId as string);
    expect(stub, 'Path-Id resolves (paths live in the layout document, global id)').not.toBeNull();
    // Geometric sanity: the stub end lies at the conveyor's head side (both authored in the doc).
    const end = stub!.getAbsPosition(stub!.length, new Vector3());
    const head = v1!.getWorldPosition(new Vector3());
    expect(end.distanceTo(head)).toBeLessThan(6);
  });
});

// ── Control for finding 2: the same asset as MAIN model (no placement) ─────
describe.skipIf(!AVAILABLE)('plan-612 CP1d-b b0 — control: AGVStacker.glb as the main model', () => {
  let h: TestViewerHandle;
  beforeAll(async () => {
    clearShared();
    h = await createTestViewer('webgl');
    h.viewer.loop.setPaused(`${HOLD}-control`, true);
    await h.viewer.loadModel(`/${STACKER}`);
    await h.viewer.whenSceneReady();
  }, 180_000);
  afterAll(() => { h?.dispose(); clearShared(); });

  // Same asset as 2b — fixed in b1-0, on the main model too.
  it('control: LiftRam follows Lift through Drive_Gear when the asset is the main model', () => {
    const v = h.viewer;
    const lift = v.drives.find((d) => d.node.name === 'Lift') ?? null;
    const ram = v.drives.find((d) => d.node.name === 'LiftRam') ?? null;
    expect(lift).not.toBeNull();
    expect(ram).not.toBeNull();
    lift!.startMove(400);
    const t = v as unknown as { _tickOnce(dt: number): void };
    for (let i = 0; i < 240; i++) t._tickOnce(1 / 60);
    expect(lift!.currentPosition).toBeCloseTo(400, 0);
    expect(ram!.currentPosition, 'gear 0.5 on the main model').toBeCloseTo(200, 0);
  });
});

// ── b1: the REAL regenerated scene with the PalletYard plugin in DES ───────────

const YARD_URL = '/demo-realvirtual/PalletYard.glb';
const YARD_AVAILABLE = AVAILABLE && (await devAssetAvailable(YARD_URL));
const STACKERS = ['Stapler_1', 'Stapler_2', 'Stapler_3'];
const CONVEYOR_PLACEMENTS = ['Conveyor_A1', 'Conveyor_A2', 'Conveyor_V1', 'Conveyor_V2', 'ConveyorOut_V1', 'ConveyorOut_V2'];

/** A viewer with the PalletYard plugin (and every behaviour, as main.ts) that recorded each bind attempt. */
async function yardViewer(onModelLoaded?: (v: RVViewer) => void): Promise<{
  h: TestViewerHandle; v: RVViewer; root: Object3D; plugin: PalletYardPlugin; added: string[]; attempts: string[]; events: string[];
}> {
  clearShared();
  const h = await createTestViewer('webgl');
  const v = h.viewer;
  v.loop.setPaused(`${HOLD}-b1`, true);
  registerAllBehaviors(v.behaviors);   // as main.ts does
  const plugin = new PalletYardPlugin();
  // Every tryBind the plugin makes, by trigger (the watchdog would call it with the default).
  const attempts: string[] = [];
  const tryBind = plugin.tryBind.bind(plugin);
  plugin.tryBind = (trigger?: string) => { attempts.push(trigger ?? 'direct'); tryBind(trigger); };
  v.use(plugin);
  const added: string[] = [];
  const events: string[] = [];
  v.on('layout-content-added', (d: unknown) => { const r = (d as { root?: Object3D }).root; if (r) added.push(r.name); });
  v.on('model-loaded', () => { events.push('model-loaded'); onModelLoaded?.(v); });
  v.on('placements-materialized', () => events.push('placements-materialized'));
  v.on('simulation-mode-changed', () => events.push('simulation-mode-changed'));
  await v.loadModel(YARD_URL);
  await v.whenSceneReady();
  await Promise.resolve();   // the plugin's deferred (microtask) bind attempts
  const root = (v as unknown as { currentModel: Object3D }).currentModel;
  v.scene.updateMatrixWorld(true);
  return { h, v, root, plugin, added, attempts, events };
}

describe.skipIf(!YARD_AVAILABLE)('plan-612 CP1d-b b1 — the real PalletYard.glb: placements, per-instance signals, plugin bind in DES', () => {
  let y: Awaited<ReturnType<typeof yardViewer>>;
  let attemptsBeforeDes: string[] = [];

  beforeAll(async () => {
    y = await yardViewer();
    attemptsBeforeDes = [...y.attempts];
    // The user switches the loaded document to DES (DES toolbar / workspace mode).
    y.v.simulationKernel!.setMode('des');
    await Promise.resolve();
  }, 240_000);
  afterAll(() => { y?.h.dispose(); clearShared(); });

  it('the scene materialises 3 stacker and 6 conveyor placements (4 station conveyors + 2 ConveyorOut), Lift/ForkAnchor in every stacker', () => {
    for (const n of [...STACKERS, ...CONVEYOR_PLACEMENTS]) expect(y.added, `layout-content-added ${n}`).toContain(n);
    for (const n of STACKERS) {
      const s = find(y.root, n);
      expect(s, n).not.toBeNull();
      expect(instanceScope(find(s!, 'Lift')!), `${n} scope`).toBe(n);
      expect(find(s!, 'AGV_Stacker'), `${n}: asset root kept as a child`).not.toBeNull();
      expect(find(s!, 'Lift/ForkAnchor'), `${n}: ForkAnchor`).not.toBeNull();
    }
    for (const n of CONVEYOR_PLACEMENTS) expect(instanceScope(find(find(y.root, n)!, 'Transport-Z')!), `${n} scope`).toBe(n);
  });

  it('signals are separate per instance (Stapler_N.Agv.*, Conveyor_*.Flow.*), no unscoped Agv / Flow.Run', () => {
    const names = [...(y.v.signalStore?.getAll().keys() ?? [])];
    for (const n of STACKERS) expect(names, n).toContain(`${n}.Agv.Run`);
    for (const n of CONVEYOR_PLACEMENTS) expect(names, n).toContain(`${n}.Flow.Run`);
    // (Unscoped Flow.* of the EMBEDDED sources / sinks is not a conveyor Run.)
    expect(names.filter((n) => n.startsWith('Agv.') || n === 'Flow.Run'), 'no unscoped Agv / Flow.Run').toEqual([]);
  });

  it('the plugin binds without the watchdog: it tries on placements-materialized, binds on the DES switch; the watchdog never binds', () => {
    const runner = y.v.simulationKernel?.desControl() as unknown as DESRunner | null;
    console.info(`[b1] events: ${y.events.join(' > ')}; bind attempts before DES ${attemptsBeforeDes.join(',')}; all ${y.attempts.join(',')}; `
      + `bind trigger ${y.plugin.bindTrigger}; runner instances ${runner?.liveInstances.length}: ${runner?.liveInstances.map((i) => `${i.def.kind}:${i.adapter.node.name}`).join(' ')}`);
    expect(attemptsBeforeDes, 'a bind attempt once the placements are there').toContain('placements-materialized');
    expect(y.v.simulationKernel?.mode).toBe('des');
    expect(y.plugin.runtime, 'plugin bound').not.toBeNull();
    // plan-645 Phase 5: the DES bind needs a `bound` run of the lifecycle service; inside setMode the
    // mode-changed tryBind sees it first (same generation, the later `bound` is a no-op).
    expect(['des-lifecycle', 'simulation-mode-changed']).toContain(y.plugin.bindTrigger);
    expect(y.plugin.bindGeneration, 'bound to the runner generation').toBe(runner!.lifecycleGeneration);
    expect(y.attempts, 'the watchdog never calls tryBind').not.toContain('direct');
    const be = y.plugin.runtime!.adapters as DesHandoverBackend;
    for (const n of STACKERS) expect(be.vehicleNode(n)?.name, n).toBe(n);
    expect(y.plugin.runtime!.lamps.lampCount('Stapler_1'), 'lamps of the asset found through AGV_Stacker').toBe(6);
  });

  it('shipping pause: Conveyor_V2.Flow.Run off — V1 and both production outputs keep running and delivering', () => {
    const rt = y.plugin.runtime!;
    const be = rt.adapters as DesHandoverBackend;
    const runner = y.v.simulationKernel!.desControl() as unknown as DESRunner;
    const store = y.v.signalStore!;
    expect(be.inputRunSignal('V2')).toBe('Conveyor_V2.Flow.Run');
    be.setInputRun('V2', false);
    expect(store.get('Conveyor_V2.Flow.Run')).toBe(false);
    for (const n of ['Conveyor_V1', 'Conveyor_A1', 'Conveyor_A2', 'ConveyorOut_V1', 'ConveyorOut_V2']) expect(store.get(`${n}.Flow.Run`), n).toBe(true);
    // Run the yard on SIM time (FastForward drain as the viewer's FF does) up to before V1's
    // configured pause (300 s); V2's own schedule would only switch at 900 s.
    const m = runner.getManager();
    for (let t = Math.ceil(m.currentTime) + 1; t <= 290; t++) {
      be.clock.schedule(t, () => {});
      m.processUpTo(t, 1e8);
      rt.frame();
    }
    const shippedV1 = be.sinkOf('V1')!.totalProcessed;
    const shippedV2 = be.sinkOf('V2')!.totalProcessed;
    console.info(`[b1] t=${m.currentTime.toFixed(0)} produced ${rt.counters.produced}, picks ${rt.counters.picks}, delivered ${rt.counters.delivered}, sink V1 ${shippedV1}, sink V2 ${shippedV2}, V2 load ${be.inputConveyor('V2')!.currentLoad}`);
    expect(store.get('Conveyor_V2.Flow.Run'), 'V2 still paused').toBe(false);
    expect(rt.counters.produced, 'both production outputs released pallets').toBeGreaterThanOrEqual(4);
    expect(shippedV1, 'V1 ships').toBeGreaterThanOrEqual(1);
    expect(shippedV2, 'V2 holds back').toBe(0);
  });
});

// Boot straight into DES (plan-612 CP1d-b fix): the kernel switches at `model-loaded`, while
// the placements are still empty reference nodes (the ?mode=des path). The runner binds the
// stackers by their Agv PAYLOAD on the reference node (no scope stamp yet → unscoped
// `Agv.*`). On `placements-materialized` the viewer calls `kernel.rebindScene()`, which drops
// the scene-discovered instances (traffic teardown, bind contexts, the unscoped names) and
// binds the scene anew — `reset()` alone never rediscovered (des-runner `_instances` guard).
describe.skipIf(!YARD_AVAILABLE)('plan-612 CP1d-b — boot into DES before the placements materialise', () => {
  let y: Awaited<ReturnType<typeof yardViewer>>;
  let earlyInstances: string[] = [];
  let earlyUnscopedAgv: string[] = [];
  let earlyScopedAgvRun: string[] = [];
  let unscopedAgvBeforeRebind: string[] = [];
  const unscopedAgv = (v: RVViewer): string[] => [...(v.signalStore?.getAll().keys() ?? [])].filter((n) => n.startsWith('Agv.')).sort();
  beforeAll(async () => {
    y = await yardViewer((v) => {
      v.simulationKernel?.setMode('des');
      const r = v.simulationKernel?.desControl() as unknown as DESRunner | null;
      earlyInstances = r?.liveInstances.map((i) => `${i.def.type}:${i.adapter.node.name}`) ?? [];
      earlyUnscopedAgv = unscopedAgv(v);
      earlyScopedAgvRun = [...(v.signalStore?.getAll().keys() ?? [])].filter((n) => /^Stapler_\d\.Agv\.Run$/.test(n)).sort();
      // Diagnostic: the state on the LAST layout-content-added (placements there, no rebind yet).
      v.on('layout-content-added', () => { unscopedAgvBeforeRebind = unscopedAgv(v); });
    });
  }, 240_000);
  afterAll(() => { y?.h.dispose(); clearShared(); });

  it('the DES runner holds all 6 conveyor and 3 stacker placements once, no unscoped Agv.*; the plugin binds on placements-materialized', () => {
    const runner = y.v.simulationKernel?.desControl() as unknown as DESRunner | null;
    console.info(`[boot-into-DES] events: ${y.events.join(' > ')}; attempts ${y.attempts.join(',')}; early: ${earlyInstances.join(' ')}; runner instances: `
      + `${runner?.liveInstances.map((i) => `${i.def.type}:${i.adapter.node.name}`).join(' ')}`);
    expect(y.v.simulationKernel?.mode).toBe('des');
    // The early bind really happened before the placements (otherwise this test proves nothing).
    expect(earlyInstances.filter((n) => n.startsWith('Agv:')).length, 'early Agv binds on the empty reference nodes').toBe(3);
    expect(earlyInstances.some((n) => n.endsWith(':Conveyor_A1')), 'no conveyor placement before materialisation').toBe(false);
    console.info(`[boot-into-DES] unscoped Agv.* early: ${earlyUnscopedAgv.join(',')}; before the rebind: ${unscopedAgvBeforeRebind.join(',')}`);
    // #149: the early bind on the still-empty reference nodes is ALREADY scoped by its
    // placement (a deferred / pending reference node is a scope root, rv-instance-scope) —
    // no bare `Agv.*` ever exists, so three stackers never share one status.
    expect(earlyUnscopedAgv, 'the early bind wrote no unscoped Agv.*').toEqual([]);
    expect(earlyScopedAgvRun, 'the early bind declared Stapler_N.Agv.Run').toEqual(STACKERS.map((n) => `${n}.Agv.Run`).sort());
    expect(runner, 'runner').not.toBeNull();
    const names = runner!.liveInstances.map((i) => `${i.def.type}:${i.adapter.node.name}`);
    for (const n of CONVEYOR_PLACEMENTS) expect(names.filter((x) => x.endsWith(`:${n}`)), n).toHaveLength(1);
    for (const n of STACKERS) expect(names.filter((x) => x === `Agv:${n}`), n).toHaveLength(1);
    expect(names.filter((x) => x.startsWith('Agv:')), 'exactly three vehicles').toHaveLength(3);
    const signals = [...(y.v.signalStore?.getAll().keys() ?? [])];
    for (const n of STACKERS) expect(signals, n).toContain(`${n}.Agv.Run`);
    for (const n of CONVEYOR_PLACEMENTS) expect(signals, n).toContain(`${n}.Flow.Run`);
    expect(signals.filter((n) => n.startsWith('Agv.') || n === 'Flow.Run'), 'no unscoped Agv / Flow.Run').toEqual([]);
    expect(y.plugin.runtime, 'plugin bound').not.toBeNull();
    // The rebind on placements-materialized opens a new run: the plugin binds on that
    // `simulation-run-started` or on its own (microtask) placements-materialized attempt.
    // plan-645 Phase 5: the rebind's `bound` binds the yard (lifecycle service).
    expect(y.plugin.bindTrigger).toBe('des-lifecycle');
    const be = y.plugin.runtime!.adapters as DesHandoverBackend;
    for (const n of STACKERS) expect(be.vehicleNode(n)?.name, n).toBe(n);
    expect(getProblems().filter((p) => p.code === 'pallet-yard-bind-incomplete'), 'no bind gap').toEqual([]);
  });

  it('plan-645 9.7: rebind / reset of the SAME runner → new generation, the old runtime disposed before the teardown, a new one bound', () => {
    const runner = y.v.simulationKernel!.desControl() as unknown as DESRunner;
    for (const step of ['rebind', 'reset'] as const) {
      const old = y.plugin.runtime!;
      const gen0 = y.plugin.bindGeneration!;
      let disposedAtReset = false;
      const off = runner.onLifecycle((e) => { if (e.type === 'reset') disposedAtReset = (old as unknown as { disposed: boolean }).disposed; });
      const q = vi.spyOn(console, 'info').mockImplementation(() => {});
      try { if (step === 'rebind') runner.rebindScene(); else runner.reset(); } finally { q.mockRestore(); off(); }
      expect((old as unknown as { disposed: boolean }).disposed, `${step}: old runtime disposed`).toBe(true);
      expect(disposedAtReset, `${step}: the plugin listener ran first (registered earlier)`).toBe(true);
      expect(y.plugin.runtime, `${step}: a new runtime`).not.toBe(old);
      expect(y.plugin.bindGeneration, `${step}: generation moved on`).toBeGreaterThan(gen0);
      expect(y.plugin.bindGeneration).toBe(runner.lifecycleGeneration);
    }
  });

  it('the yard runs: picks and deliveries after a short sim time (FastForward drain)', () => {
    const rt = y.plugin.runtime!;
    expect(rt, 'plugin bound').toBeTruthy();
    const be = rt.adapters as DesHandoverBackend;
    const runner = y.v.simulationKernel!.desControl() as unknown as DESRunner;
    const m = runner.getManager();
    for (let t = Math.ceil(m.currentTime) + 1; t <= 290; t++) {
      be.clock.schedule(t, () => {});
      m.processUpTo(t, 1e8);
      rt.frame();
    }
    const shippedV1 = be.sinkOf('V1')!.totalProcessed;
    console.info(`[boot-into-DES] t=${m.currentTime.toFixed(0)} produced ${rt.counters.produced}, picks ${rt.counters.picks}, delivered ${rt.counters.delivered}, sink V1 ${shippedV1}`);
    expect(m.currentTime, 'sim time advanced').toBeGreaterThanOrEqual(290);
    expect(rt.counters.produced, 'production').toBeGreaterThanOrEqual(4);
    expect(rt.counters.picks, 'fork picks (handovers conveyor → fork)').toBeGreaterThan(0);
    expect(rt.counters.delivered, 'deliveries (handovers fork → conveyor)').toBeGreaterThan(0);
    expect(shippedV1, 'V1 ships').toBeGreaterThanOrEqual(1);
  });
});
