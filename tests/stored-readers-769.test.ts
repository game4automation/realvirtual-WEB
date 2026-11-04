// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 1b — every STORED-reference reader reads by the file's verdict
 * (9.2 extension, Inventory R).
 *
 * One Unity-like file (no NodeIds, path references in authored names) with one
 * referrer per reader: CRI, WebVisibility, PhysicsZone, Source (NAME field),
 * Drive_Gear through `resolveComponentRefs`, the drive order, the Kinematic
 * prepare hook and bake survival, and the load audit. Each reader gets:
 *  - a reference the file's authored index resolves (`CadB/Sep/Pin` — the node a
 *    loader rename AND a Kinematic re-parent moved): lands on the AUTHORED node;
 *  - a reference the file does NOT carry as a node (`Sep/Pin`) or that is ambiguous
 *    (`Pin`): no node — never a guessing stage, and visible in the Problems panel
 *    (`unresolved-instruction-target`, `reference-unresolved`, `reference-ambiguous`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene, type Object3D } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { getProblems, resetProblemsForTests, UNRESOLVED_INSTRUCTION_TARGET_CODE } from '../src/core/hmi/problems-store';
import {
  box, buildStoredReadersGlb, CR, driveNodeBySpeed, node as fxNode, sceneToGlb,
} from './helpers/migrate-769-fixtures';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveGear } from '../src/core/engine/rv-drive-gear';
import { bakeRemovalReport } from '../src/core/engine/rv-bake-survival';
import { auditReferences } from '../src/core/engine/rv-reference-audit';
import { DriveOrderPlugin } from '../src/plugins/drive-order-plugin';

/**
 * The content-root shape (Phase-0 finding, PalletScanner): a wrapper scene, refs
 * written relative to the Unity root `Machine`, a decoy with the same tail first in
 * glTF order. The CRI target is a BARE part — only an incoming tag keeps it.
 */
async function buildContentRootSurvivalGlb(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'AuxScene';
  const machine = fxNode('Machine');
  const other = fxNode('Other');
  const decoyStatic = fxNode('Static');
  decoyStatic.add(box('Part', 0.11));
  other.add(decoyStatic);
  const stat = fxNode('Static');
  stat.add(box('Part', 0.22));
  const panel = fxNode('Panel', {
    CustomRuntimeInstruction: { steps: [{ instruction: 'look', targetObjects: ['Static/Part'] }] },
  });
  machine.add(other, stat, panel, box('Body', 0.3));
  scene.add(machine);
  return sceneToGlb(scene);
}

function authoredPin(reg: NodeRegistry, from: Object3D): Object3D | null {
  const r = reg.resolveRef(from, 'CadB/Sep/Pin');
  return r.status === 'resolved' ? r.node : null;
}

describe('plan-769 Phase 1b — stored-reference readers read by the file verdict', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; resetProblemsForTests(); vi.restoreAllMocks(); });

  async function load(): Promise<TestViewerHandle> {
    resetProblemsForTests();
    bakeRemovalReport.length = 0;
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('stored-readers.glb', { data: await buildStoredReadersGlb() });
    return h;
  }

  it('readStoredRef: a file reference is final (resolved / unresolved), a path the file does not carry is legacy', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    const panel = reg.getNode('Cell/Panel')!;
    const pin = authoredPin(reg, panel)!;
    expect(reg.getAuthoredPath(pin)).toBe('CadB/Sep/Pin');
    const ok = reg.readStoredRef(panel, 'CadB/Sep/Pin');
    expect(ok.status === 'resolved' && ok.node).toBe(pin);
    const miss = reg.readStoredRef(panel, 'Sep/Pin');
    expect(miss.status).toBe('unresolved');
    // A path the file never carried (written this session: an input) — the reader's lookup applies.
    expect(reg.readStoredRef(panel, 'Mount/Sep_1/Pin_1').status).toBe('legacy');
    // No document at all → legacy as well.
    expect(reg.readStoredRef(null, 'CadB/Sep/Pin').status).toBe('legacy');
  });

  it('CRI: the authored target is highlighted, the unknown one is a problem — never a guess', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    const getNode = vi.spyOn(reg, 'getNode');
    const panel = reg.getNode('Cell/Panel')!;
    const misses = getProblems().filter((p) => p.code === UNRESOLVED_INSTRUCTION_TARGET_CODE);
    expect(misses.map((p) => p.detail)).toEqual([expect.stringContaining('"Sep/Pin"')]);
    expect(reg.storedNode(panel, 'CadB/Sep/Pin')).toBe(authoredPin(reg, panel));
    expect(reg.storedNode(panel, 'Sep/Pin')).toBeNull();
    // Neither read reached the runtime path index (a stored ref is no path input).
    expect(getNode.mock.calls.map((c) => c[0])).not.toContain('Sep/Pin');
  });

  it('WebVisibility: AdditionalTargets holds exactly the authored node', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    const visNode = reg.getNode('Cell/Vis')!;
    const vis = reg.componentOn<{ _additionalNodes: Object3D[] }>(visNode, 'WebVisibility');
    expect(vis).not.toBeNull();
    expect(vis!._additionalNodes).toEqual([authoredPin(reg, visNode)]);
  });

  it('PhysicsZone: StaticColliders resolve through the zone by the file verdict', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    const zoneNode = reg.getNode('Cell/Zone')!;
    const zone = reg.componentOn<{ StaticColliders: string[]; resolveStaticCollider(r: NodeRegistry, p: string): Object3D | null }>(zoneNode, 'WebPhysicsZone');
    expect(zone?.StaticColliders).toEqual(['CadB/Sep/Pin', 'Sep/Pin']);
    expect(zone!.resolveStaticCollider(reg, 'CadB/Sep/Pin')).toBe(authoredPin(reg, zoneNode));
    expect(zone!.resolveStaticCollider(reg, 'Sep/Pin')).toBeNull();
  });

  it('PhysicsZone2D (plan-661): Guides resolve through the zone by the file verdict, never by the path index', async () => {
    resetProblemsForTests();
    const scene = new Scene();
    scene.name = 'Cell';
    const drive = { Direction: 'LinearX', TargetSpeed: 100 };
    const cadA = fxNode('CadA');
    cadA.position.set(-2, 0, 0);
    const sepA = fxNode('Sep', { Drive: { ...drive, TargetSpeed: 111 } });
    sepA.add(box('Pin', 0.1));
    cadA.add(sepA);
    const cadB = fxNode('CadB');
    cadB.position.set(2, 0, 0);
    const sepB = fxNode('Sep', { Kinematic: { KinematicParentEnable: true, Parent: 'Mount' }, Drive: { ...drive, TargetSpeed: 222 } });
    sepB.add(box('Pin', 0.2));
    cadB.add(sepB);
    const mount = fxNode('Mount');
    mount.position.set(0, 1, 0);
    const zone2d = fxNode('Zone2D', {
      WebPhysicsZone2D: {
        Kind: 'Jam',
        Guides: [CR('CadB/Sep/Pin', 'UnityEngine.Transform'), CR('Sep/Pin', 'UnityEngine.Transform')],
      },
    });
    scene.add(cadA, cadB, mount, zone2d);
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('zone2d-readers.glb', { data: await sceneToGlb(scene) });
    const reg = h.viewer.registry!;
    const zoneNode = reg.getNode('Cell/Zone2D')!;
    const zone = reg.componentOn<{ guidePaths: string[]; resolveReference(r: NodeRegistry, p: string): Object3D | null }>(zoneNode, 'WebPhysicsZone2D');
    expect(zone?.guidePaths).toEqual(['CadB/Sep/Pin', 'Sep/Pin']);
    const getNode = vi.spyOn(reg, 'getNode');
    expect(zone!.resolveReference(reg, 'CadB/Sep/Pin')).toBe(authoredPin(reg, zoneNode));
    expect(zone!.resolveReference(reg, 'Sep/Pin')).toBeNull();
    expect(getNode.mock.calls.map((c) => c[0])).not.toContain('Sep/Pin');
  });

  it('Source: an ambiguous ThisObjectAsMU name binds no template (reported), never the first "Pin"', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    const srcNode = reg.getNode('Cell/Src')!;
    expect(reg.readStoredRef(srcNode, 'Pin', { kind: 'name' })).toMatchObject({ status: 'unresolved', reason: 'ambiguous' });
    const source = reg.componentOn<{ muTemplate: Object3D | null }>(srcNode, 'Source');
    expect(source).not.toBeNull();
    expect(source!.muTemplate).toBeNull();
    expect(getProblems().some((p) => p.code === 'reference-ambiguous' && p.detail?.includes('ThisObjectAsMU'))).toBe(true);
  });

  it('Drive_Gear + drive order: the master is the AUTHORED CadB/Sep, sorted before its slave', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    const authored = driveNodeBySpeed(viewer.currentModelRoot!, 222)!;
    const slaveNode = reg.getNode('Cell/Slave')!;
    const drive = reg.componentOn<RVDrive>(slaveNode, 'Drive')!;
    const gear = drive.driveBehaviors.find((b) => b instanceof RVDriveGear) as RVDriveGear | undefined;
    expect(gear?.masterDrive?.node).toBe(authored);
    // The drive-order plugin reads MasterDrive by the file verdict too (a name guess
    // would pick the CadA "Sep" — the only drive literally named "Sep").
    // Adversarial start order: slave first, the wrong candidate next, the authored master last.
    const wrong = driveNodeBySpeed(viewer.currentModelRoot!, 111)!;
    const rank = (d: RVDrive): number => (d.node === slaveNode ? 0 : d.node === wrong ? 1 : d.node === authored ? 3 : 2);
    viewer.drives.sort((a, b) => rank(a) - rank(b));
    new DriveOrderPlugin().sort(viewer);
    const order = viewer.drives.map((d) => d.node);
    expect(order.indexOf(authored)).toBeLessThan(order.indexOf(slaveNode));
  });

  it('Survival == Runtime (content root): a bare part only the file verdict names survives the bake and resolves', async () => {
    resetProblemsForTests();
    bakeRemovalReport.length = 0;
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('content-root-survival.glb', { data: await buildContentRootSurvivalGlb() });
    const reg = h.viewer.registry!;
    const panel = reg.getNode(`${reg.getPathForNode(h.viewer.currentModelRoot!)}/Machine/Panel`)!;
    expect(panel).not.toBeNull();
    // prepare read the CRI target through the file (content-root step), tagged it, the bake kept it…
    const report = bakeRemovalReport.find((r) => r.assetId === 'content-root-survival.glb') ?? bakeRemovalReport[0]!;
    expect(report.unresolvedReferences.map((u) => u.path)).not.toContain('Static/Part');
    // …and the runtime resolves the SAME authored node: no instruction-target miss.
    const r = reg.resolveRef(panel, 'Static/Part');
    expect(r.status).toBe('resolved');
    expect(r.status === 'resolved' && reg.getAuthoredPath(r.node)).toBe('Machine/Static/Part');
    expect(getProblems().filter((p) => p.code === UNRESOLVED_INSTRUCTION_TARGET_CODE)).toEqual([]);
  });

  it('Survival == Runtime: prepare tags what the registry resolves; the unknown target is unresolved in both', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    const report = bakeRemovalReport.find((r) => r.assetId === 'stored-readers.glb') ?? bakeRemovalReport[0]!;
    const unresolvedPaths = report.unresolvedReferences.map((u) => `${u.component}.${u.field}=${u.path}`);
    expect(unresolvedPaths).not.toContain('CustomRuntimeInstruction.steps.targetObjects=CadB/Sep/Pin');
    expect(unresolvedPaths).toContain('CustomRuntimeInstruction.steps.targetObjects=Sep/Pin');
    expect(unresolvedPaths).toContain('WebPhysicsZone.StaticColliders=Sep/Pin');
    // The tagged node is the one the runtime resolves, attached in the live model.
    const pin = authoredPin(reg, reg.getNode('Cell/Panel')!)!;
    let attached = false;
    for (let n: Object3D | null = pin; n; n = n.parent) if (n === viewer.currentModelRoot) attached = true;
    expect(attached).toBe(true);
  });

  it('audit: a file reference that names no node is reference-unresolved, never reference-rescued', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    const result = auditReferences(reg);
    expect(result.findings.filter((f) => f.kind === 'rescued')).toEqual([]);
    const unresolved = result.findings.filter((f) => f.kind === 'unresolved').map((f) => `${f.componentType}.${f.field}=${f.writtenPath}`);
    expect(unresolved).toEqual(expect.arrayContaining([
      'CustomRuntimeInstruction.steps=Sep/Pin',
      'WebVisibility.AdditionalTargets=Sep/Pin',
      'WebPhysicsZone.StaticColliders=Sep/Pin',
    ]));
    expect(getProblems().filter((p) => p.code === 'reference-rescued')).toEqual([]);
  });
});
