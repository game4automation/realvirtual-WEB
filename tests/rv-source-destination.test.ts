// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 S1 — `Source.Destination` (Unity `Source.Generate`: `SetParent(Destination)`,
 * then the source's WORLD pose). A new MU becomes a child of the destination node, starts
 * at the source's world pose — also when the destination is moved / rotated / scaled — and
 * follows the destination afterwards. The field is a declared path field (PATH_FIELDS):
 * a Unity path string, a ComponentReference and a web-saved `{ address }` all resolve; an
 * unresolvable one is a `reference-unresolved` Problem and the MU spawns as before.
 *
 * Runs through the shipping bake (`loadBakedGLB()` proves from the result that the
 * destructive bake ran): the destination must survive it (PATH_FIELDS → bake survival)
 * and the MU must ride the BAKED node. Only (c) loads one authoring tree on purpose —
 * the editor export that writes the address form.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { holdMU, detachMU } from '../src/core/engine/rv-mu-hold';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { auditReferences } from '../src/core/engine/rv-reference-audit';
import { reportReferenceAudit, getProblems, clearAllProblems } from '../src/core/hmi/problems-store';
import { PATH_FIELDS } from '../src/core/engine/rv-node-path-rewrite.mjs';
import type { RVMovingUnit, MuHolder } from '../src/core/engine/rv-mu';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';

/**
 *   Cell
 *    ├─ Machine (moved)
 *    │   ├─ Axis (moved, rotated, uniformly scaled)   ← Destination
 *    │   ├─ Other (Drive, moved)                      ← second destination (reapply test)
 *    │   └─ Base (static mesh — the bake's chunk)
 *    ├─ Part (mesh, MU template)
 *    │   └─ Sub                                       ← destination INSIDE the template
 *    └─ Src  Source { ThisObjectAsMU: 'Part', Destination, GenerateMU: true }
 */
async function build(destination: unknown, axisIsDrive = false): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const machine = node('Machine');
  machine.position.set(1, 0.2, -0.5);
  // Plain node: only the PATH_FIELDS entry keeps it through the bake. As a Drive it is a
  // moving node the loader does not freeze (the blow-moulding case: an extruder axis).
  const axis = node('Axis', axisIsDrive ? { Drive: { Direction: 'LinearX', TargetSpeed: 100 } } : undefined);
  axis.position.set(0.4, 0.3, 0);
  axis.rotation.set(0, Math.PI / 3, 0.2);
  axis.scale.setScalar(2);
  machine.add(axis);
  const other = node('Other', { Drive: { Direction: 'LinearX', TargetSpeed: 100 } });
  other.position.set(-0.6, 0.1, 0.3);
  machine.add(other);
  // Plain static geometry: gives the bake a chunk to produce (the MU template is not baked).
  const base = new Mesh(new BoxGeometry(1, 0.1, 1), new MeshBasicMaterial());
  base.name = 'Base';
  machine.add(base);
  const part = new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshBasicMaterial());
  part.name = 'Part';
  part.position.set(-1, 0, 0);
  part.userData.realvirtual = { MU: {} };
  const sub = node('Sub');
  sub.position.set(0, 0.02, 0);
  part.add(sub);
  const src = node('Src', {
    Source: {
      ThisObjectAsMU: 'Part', AutomaticGeneration: false, GenerateMU: true,
      ...(destination !== undefined ? { Destination: destination } : {}),
    },
  });
  src.position.set(0.3, 1, -0.2);
  src.rotation.set(Math.PI / 6, 0, 0);
  scene.add(machine, part, src);
  return sceneToGlb(scene);
}

/** Production load (destructive bake) + one tick, which spawns the first MU. `preferClone`
 *  is only for cases without a destination: a Destination must force the clone path ITSELF. */
async function load(bytes: ArrayBuffer, preferClone = false) {
  const result = await loadBakedGLB('dest.glb', new Scene(), { data: bytes.slice(0), loadKinematicsSidecar: false });
  const tm = result.transportManager;
  const source = tm.sources.find((s) => s.node.name === 'Src')!;
  if (preferClone) tm.preferCloneMU = true;
  tm.update(1 / 60);
  const mu = tm.mus.find((m) => !m.isInstanced) as RVMovingUnit | undefined;
  return { result, tm, source, mu };
}

const worldPos = (o: Object3D) => { o.updateWorldMatrix(true, false); return o.getWorldPosition(new Vector3()); };
const worldQuat = (o: Object3D) => { o.updateWorldMatrix(true, false); return o.getWorldQuaternion(new Quaternion()); };

afterEach(() => clearAllProblems());

describe('plan-2016 S1 — Source.Destination', () => {
  it('is a declared path field', () => {
    expect(PATH_FIELDS.some((f: { component: string; field: string }) => f.component === 'Source' && f.field === 'Destination')).toBe(true);
  });

  it('(a) path string: the MU is a child of the destination and starts at the source world pose', async () => {
    const { source, mu } = await load(await build('Machine/Axis'));
    expect(mu, 'one MU spawned').toBeTruthy();
    const axis = source.destination!;
    expect(axis?.name).toBe('Axis');
    expect(mu!.node.parent).toBe(axis);
    expect(mu!.destinationParent).toBe(axis);
    expect(worldPos(mu!.node).distanceTo(worldPos(source.node))).toBeLessThan(1e-5);
    expect(worldQuat(mu!.node).angleTo(worldQuat(source.node))).toBeLessThan(1e-5);
  });

  it('(b) the MU follows the destination when it moves, and the transport loop keeps it there', async () => {
    const { source, mu, tm } = await load(await build('Machine/Axis', true));
    const axis = source.destination!;
    const before = worldPos(mu!.node);
    axis.position.x += 0.25;
    axis.rotation.y += 0.4;
    axis.updateMatrixWorld(true);
    const after = worldPos(mu!.node);
    expect(after.distanceTo(before)).toBeGreaterThan(0.01);
    // World pose = destination world matrix × unchanged local pose. The loop DOES process
    // this MU (the destination is no longer a skip, 2026-10-29) — there simply is no
    // transport surface under it, so nothing takes it off the destination node.
    const local = mu!.node.position.clone();
    for (let i = 0; i < 5; i++) tm.update(1 / 60);
    expect(mu!.node.parent).toBe(axis);
    expect(mu!.node.position.distanceTo(local)).toBeLessThan(1e-9);
    expect(worldPos(mu!.node).distanceTo(local.clone().applyMatrix4(axis.matrixWorld))).toBeLessThan(1e-6);
  });

  it('(c) ComponentReference and the web-saved address form resolve to the same node', async () => {
    const cr = await load(await build({ type: 'ComponentReference', path: 'Machine/Axis', componentType: '' }));
    expect(cr.mu!.node.parent?.name).toBe('Axis');

    // Unity path → editor export writes an address → reload resolves it.
    const first = await loadGLB('dest.glb', new Scene(), { data: (await build('Machine/Axis')).slice(0), preserveHierarchy: true, loadKinematicsSidecar: false });
    const saved = await exportAssetGlb(first.root, 'Cell', undefined, undefined, { registry: first.registry });
    const json = readGlbJson(saved) as { nodes: Array<{ name?: string; extras?: { realvirtual?: Record<string, Record<string, unknown>> } }> };
    const written = json.nodes.find((n) => n.name === 'Src')!.extras!.realvirtual!.Source.Destination as { address?: string };
    const axisId = json.nodes.find((n) => n.name === 'Axis')!.extras!.realvirtual!.NodeId as unknown as string;
    expect(written).toEqual({ address: `#${axisId}` });
    const second = await load(saved);
    expect(second.source.destination?.name).toBe('Axis');
    expect(second.mu!.node.parent).toBe(second.source.destination);
    expect(worldPos(second.mu!.node).distanceTo(worldPos(second.source.node))).toBeLessThan(1e-5);
  });

  it('(d) an unresolvable destination is a reference-unresolved Problem and the MU spawns as before', async () => {
    const { result, source, mu } = await load(await build('Machine/Nope'), true);
    expect(source.destination).toBeNull();
    expect(mu!.node.parent).toBe(source.spawnParent);
    const audit = auditReferences(result.registry);
    const finding = audit.findings.find((f) => f.componentType === 'Source' && f.field === 'Destination');
    expect(finding?.kind).toBe('unresolved');
    reportReferenceAudit(audit.findings);
    expect(getProblems().some((p) => p.code === 'reference-unresolved')).toBe(true);
  });

  it('(e) without Destination nothing changes: MU under the spawn parent at the source world pose', async () => {
    const { source, mu } = await load(await build(undefined), true);
    expect(source.destination).toBeNull();
    expect(mu!.destinationParent).toBeNull();
    expect(mu!.node.parent).toBe(source.spawnParent);
    expect(worldPos(mu!.node).distanceTo(worldPos(source.node))).toBeLessThan(1e-5);
  });

  it('(f) the bake keeps the destination: baked load, survived node, MU rides it', async () => {
    const { result, source, mu } = await load(await build('Machine/Axis'));
    expect(result.bakedAsset?.destructive).toBe(true);
    const axis = result.registry.getNode('Machine/Axis');
    expect(axis, 'Axis survives the bake (Source.Destination claims it)').toBeTruthy();
    expect(source.destination).toBe(axis);
    expect(mu!.node.parent).toBe(axis);
  });

  it('(g) Destination alone forces the clone path for an instancing-capable template', async () => {
    const { tm, source, mu } = await load(await build('Machine/Axis'));
    expect(tm.preferCloneMU).toBe(false);
    expect(source.useInstancing, 'template is instancing-capable').toBe(true);
    expect(tm.mus.length).toBe(1);
    expect(tm.mus[0].isInstanced).toBe(false);
    expect(mu!.node.parent).toBe(source.destination);
  });

  it.each([['Part'], ['Part/Sub']])('(h) a destination inside the MU template (%s) is refused: no MU under the template, no clone of earlier MUs', async (dest) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tm, source } = await load(await build(dest), true);
      expect(source.destination).toBeNull();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('inside the MU template'))).toBe(true);
      tm.spawnFromSource(source);
      const clones = tm.mus.filter((m) => !m.isInstanced) as RVMovingUnit[];
      expect(clones.length).toBe(2);
      const isMu = (o: Object3D) => /^Part_\d+$/.test(o.name);
      const template = source.muTemplate!;
      let inTemplate = 0;
      template.traverse((o) => { if (isMu(o)) inTemplate++; });
      expect(inTemplate, 'no MU hangs under the hidden template').toBe(0);
      let nested = 0;
      clones[1].node.traverse((o) => { if (o !== clones[1].node && isMu(o)) nested++; });
      expect(nested, 'the second MU contains no copy of the first').toBe(0);
      for (const c of clones) expect(c.node.parent).toBe(source.spawnParent);
    } finally {
      warn.mockRestore();
    }
  });

  it('(i) a Destination edit (reapplyConfig) applies to the next spawn; clearing it restores the spawn parent', async () => {
    const { result, tm, source, mu } = await load(await build('Machine/Axis'));
    const axis = source.destination!;
    const other = result.registry.getNode('Machine/Other')!;
    expect(other).toBeTruthy();
    const rv = source.node.userData.realvirtual as Record<string, Record<string, unknown>>;
    // Clone-on-write, as the inspector / component_set writer does it.
    rv.Source = { ...rv.Source, Destination: 'Machine/Other' };
    source.reapplyConfig();
    expect(source.destination).toBe(other);
    const second = tm.spawnFromSource(source) as RVMovingUnit;
    expect(second.node.parent).toBe(other);
    expect(mu!.node.parent, 'an already spawned MU stays where it is').toBe(axis);
    expect(worldPos(second.node).distanceTo(worldPos(source.node))).toBeLessThan(1e-5);

    rv.Source = { ...rv.Source, Destination: '' };
    source.reapplyConfig();
    expect(source.destination).toBeNull();
    tm.preferCloneMU = true;
    const third = tm.spawnFromSource(source) as RVMovingUnit;
    expect(third.isInstanced).toBe(false);
    expect(third.node.parent).toBe(source.spawnParent);
    expect(third.destinationParent).toBeNull();
  });

  it('(j) removal and reset take MUs off the destination', async () => {
    const { tm, source, mu } = await load(await build('Machine/Axis'));
    const axis = source.destination!;
    const second = tm.spawnFromSource(source) as RVMovingUnit;
    expect(axis.children).toContain(mu!.node);
    expect(axis.children).toContain(second.node);
    // Sink / delete path.
    tm.removeMU(mu!);
    expect(axis.children).not.toContain(mu!.node);
    expect(tm.mus).not.toContain(mu);
    // Simulation reset / stop.
    tm.reset();
    expect(axis.children).not.toContain(second.node);
    expect(axis.children.some((c) => /^Part_\d+$/.test(c.name))).toBe(false);
    expect(tm.mus.length).toBe(0);
  });

  // Reversed 2026-10-29 (Thomas: "destination ist einsortierung"). This case used to assert
  // that an MU riding its destination is SKIPPED by the transport loop; that skip was the
  // regression which froze the standard demo, so riding a destination must now cost nothing:
  // the loop looks for a driving surface every tick, exactly as under the spawn parent.
  it('(k) riding the destination does not stop transport; only a grip takes the MU out of the loop', async () => {
    const { result, tm, source, mu } = await load(await build('Machine/Axis'));
    const axis = source.destination!;
    const pick = vi.spyOn(tm as unknown as { _pickDrivingSurface(m: unknown): unknown }, '_pickDrivingSurface');
    const picked = () => pick.mock.calls.filter((c) => c[0] === mu).length;
    tm.update(1 / 60);
    expect(picked(), 'a destination is sorting, not a brake: transport still looks for a surface').toBeGreaterThan(0);
    expect(mu!.node.parent, 'and the MU stays filed under the destination').toBe(axis);

    const gripper = new Object3D();
    result.root.add(gripper);
    const owner: MuHolder = 'user';
    holdMU(mu!, gripper, owner);
    expect(mu!.node.parent).toBe(gripper);
    expect(mu!.isGripped).toBe(true);
    const beforeGripTick = picked();
    tm.update(1 / 60);
    expect(picked() - beforeGripTick, 'a gripped MU belongs to the grip').toBe(0);

    detachMU(mu!, owner, result.root);
    expect(mu!.node.parent).not.toBe(axis);
    const beforeReleaseTick = picked();
    tm.update(1 / 60);
    expect(picked() - beforeReleaseTick, 'released: transport owns it again').toBeGreaterThan(0);
    pick.mockRestore();
  });
});
