// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 S5 — `MUSwitcher` (Unity `MUSwitcher.cs`: on `Sensor.EventMUSensor(mu, true)`
 * every `Group` in the MU's subtree is `SetActive(GroupName == SwitchToGroup)`).
 *
 * Runs through the shipping bake (`loadBakedGLB()`): the variant groups of the MU
 * template must survive the bake as switchable nodes, a spawned clone must keep their
 * group names (its rv-extras are stripped) and the authored-inactive variants
 * (`activeSelf: false`) must load hidden — in the template AND in every clone.
 *
 *   Cell
 *    ├─ Hose (MU template)                                at (-3, 0, 0)
 *    │   ├─ Round  mesh 0.05, Group "Schlauch"
 *    │   ├─ Tube   mesh 0.05, Group "Tube",  activeSelf false
 *    │   └─ Barrel mesh 0.6,  Group "Fass",  activeSelf false
 *    │       └─ Lid mesh 0.05, Group "Fass"
 *    ├─ Src    Source { ThisObjectAsMU: Hose }            at (0, 1, 0)
 *    ├─ SensT  Sensor + MUSwitcher { Tube }               at (2, 1, 0)
 *    ├─ SensF  Sensor + MUSwitcher { Fass }               at (4, 1, 0)
 *    ├─ Lonely MUSwitcher { Tube } without a Sensor
 *    ├─ HoseOff (MU template, activeSelf false AS A WHOLE)  at (-6, 0, 0)
 *    │   ├─ Body  mesh 0.1
 *    │   └─ Cap   mesh 0.05
 *    ├─ SrcOff Source { ThisObjectAsMU: HoseOff }         at (0, 3, 0)
 *    ├─ Pill (MU template, ONE mesh)                      at (-9, 0, 0)
 *    │   └─ PillBody mesh 0.1, Group "Tube"  (a switch variant on a single mesh)
 *    └─ SrcPill Source { ThisObjectAsMU: Pill }           at (0, 5, 0)
 *
 * plan-2016 S5 fixes: `Multi` under Hose carries three Group components
 * `Tube`, `Fass`, `Tube` — Unity's last component decides, so the labels must
 * keep authored order WITHOUT dedup (the bake's partition stamp dedups).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import type { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVMUSwitcher, MUSWITCHER_NO_SENSOR, switchMuGroup } from '../src/core/engine/rv-mu-switcher';
import { RV_INACTIVE_KEY } from '../src/core/engine/rv-authored-inactive';
import { analyzeTemplate } from '../src/core/engine/rv-mu';
import type { RVSource } from '../src/core/engine/rv-source';
import { RV_GROUP_LABELS_KEY, groupLabelsOf } from '../src/core/engine/rv-mu-group-labels';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';

function box(name: string, size: number, rv?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(size, size, size), new MeshBasicMaterial());
  m.name = name;
  if (rv) m.userData.realvirtual = rv;
  return m;
}

const group = (name: string, inactive = false): Record<string, unknown> => ({
  Group: { GroupName: name }, layer: 0, tag: 'Untagged', activeSelf: !inactive,
});

async function build(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const hose = node('Hose', { MU: {} });
  hose.position.set(-3, 0, 0);
  const round = box('Round', 0.05, group('Schlauch'));
  const tube = box('Tube', 0.05, group('Tube', true));
  const barrel = box('Barrel', 0.6, group('Fass', true));
  barrel.add(box('Lid', 0.05, group('Fass')));
  // Three Group components, the first and the last equal (Unity: last one decides).
  const multi = box('Multi', 0.05, {
    Group: { GroupName: 'Tube' }, Group_1: { GroupName: 'Fass' }, Group_2: { GroupName: 'Tube' },
    layer: 0, tag: 'Untagged', activeSelf: true,
  });
  hose.add(round, tube, barrel, multi);

  const hoseOff = node('HoseOff', { MU: {}, activeSelf: false });
  hoseOff.position.set(-6, 0, 0);
  hoseOff.add(box('Body', 0.1), box('Cap', 0.05));
  const srcOff = node('SrcOff', { Source: { ThisObjectAsMU: 'HoseOff', AutomaticGeneration: false, GenerateMU: true } });
  srcOff.position.set(0, 3, 0);

  const pill = node('Pill', { MU: {} });
  pill.position.set(-9, 0, 0);
  pill.add(box('PillBody', 0.1, group('Tube')));
  const srcPill = node('SrcPill', { Source: { ThisObjectAsMU: 'Pill', AutomaticGeneration: false, GenerateMU: true } });
  srcPill.position.set(0, 5, 0);

  const src = node('Src', { Source: { ThisObjectAsMU: 'Hose', AutomaticGeneration: false, GenerateMU: true } });
  src.position.set(0, 1, 0);
  const sensT = box('SensT', 0.2, { Sensor: {}, MUSwitcher: { SwitchToGroup: 'Tube' } });
  sensT.position.set(2, 1, 0);
  const sensF = box('SensF', 0.2, { Sensor: {}, MUSwitcher: { SwitchToGroup: 'Fass' } });
  sensF.position.set(4, 1, 0);
  const lonely = node('Lonely', { MUSwitcher: { SwitchToGroup: 'Tube' } });
  scene.add(hose, src, sensT, sensF, lonely, hoseOff, srcOff, pill, srcPill);
  return sceneToGlb(scene);
}

async function load() {
  const result = await loadBakedGLB('mu-switcher.glb', new Scene(), { data: (await build()).slice(0), loadKinematicsSidecar: false });
  const tm = result.transportManager;
  const source = tm.sources.find((s) => s.node.name === 'Src')!;
  const spawn = (name: string): RVMovingUnit => {
    const mu = tm.spawnFromSource(source) as RVMovingUnit;
    expect(mu.isInstanced, 'a multi-mesh template spawns clones').toBe(false);
    mu.node.name = name;
    return mu;
  };
  return { result, tm, source, spawn };
}

/** Puts a clone MU at a world position (keeps its parent) and ticks once. */
function moveTo(tm: { update(dt: number): void }, mu: RVMovingUnit, x: number, y: number, z: number): void {
  const p = mu.node.parent!;
  p.updateWorldMatrix(true, false);
  mu.node.position.copy(p.worldToLocal(new Vector3(x, y, z)));
  mu.node.updateMatrix();
  mu.node.updateMatrixWorld(true);
  tm.update(1 / 60);
}

function child(mu: RVMovingUnit, name: string): Object3D {
  let found: Object3D | null = null;
  mu.node.traverse((n) => { if (!found && n.name === name) found = n; });
  expect(found, `${name} in ${mu.node.name}`).toBeTruthy();
  return found!;
}

/** Which of the variant nodes are visible in `mu`. */
const shown = (mu: RVMovingUnit): string[] =>
  ['Round', 'Tube', 'Barrel', 'Lid'].filter((n) => child(mu, n).visible);

afterEach(() => clearAllProblems());

describe('plan-2016 S5 — MUSwitcher', () => {
  it('authored-inactive variants load hidden in the template and stay switchable nodes after the bake', async () => {
    const { result } = await load();
    const tube = result.registry.getNode('Hose/Tube');
    const barrel = result.registry.getNode('Hose/Barrel');
    expect(tube, 'Tube survives the bake as a node').toBeTruthy();
    expect(barrel).toBeTruthy();
    expect(tube!.visible).toBe(false);
    expect(barrel!.visible).toBe(false);
    expect(tube!.userData[RV_INACTIVE_KEY]).toBe(true);
    expect(result.registry.getNode('Hose/Round')!.visible).toBe(true);
    expect(groupLabelsOf(tube!)).toEqual(['Tube']);
  });

  it('a spawned clone keeps the inactive variants hidden and carries its group labels', async () => {
    const { spawn } = await load();
    const a = spawn('A');
    expect(shown(a)).toEqual(['Round', 'Lid']);   // Lid is visible itself, hidden by its Barrel parent
    expect(child(a, 'Barrel').visible).toBe(false);
    expect(child(a, 'Tube').userData.realvirtual, 'clone extras stripped').toBeUndefined();
    expect(child(a, 'Tube').userData[RV_GROUP_LABELS_KEY]).toEqual(['Tube']);
    expect(child(a, 'Round').userData[RV_GROUP_LABELS_KEY]).toEqual(['Schlauch']);
  });

  it('the MU size ignores the hidden variants (the 0.6 m barrel does not grow the sensor box)', async () => {
    const { spawn } = await load();
    const a = spawn('A');
    a.updateAABB();
    const size = a.aabb.max.clone().sub(a.aabb.min);
    expect(size.x).toBeLessThan(0.06);
    expect(size.y).toBeLessThan(0.06);
  });

  it('an MU entering the sensor shows only SwitchToGroup in THIS MU; other MUs stay untouched', async () => {
    const { tm, spawn } = await load();
    const a = spawn('A');
    const b = spawn('B');
    moveTo(tm, b, 10, 1, 0);
    moveTo(tm, a, 2, 1, 0);
    expect(shown(a)).toEqual(['Tube']);   // Lid carries group Fass: switched off itself
    expect(child(a, 'Barrel').visible).toBe(false);
    expect(shown(b), 'B never entered').toEqual(['Round', 'Lid']);
    expect(child(b, 'Barrel').visible).toBe(false);
  });

  it('MU B entering right after MU A (no free state in between) is switched too', async () => {
    const { tm, spawn } = await load();
    const a = spawn('A');
    const b = spawn('B');
    moveTo(tm, b, 10, 1, 0);
    moveTo(tm, a, 2, 1, 0);
    const sensT = tm.sensors.find((s) => s.node.name === 'SensT')!;
    expect(sensT.occupied).toBe(true);
    moveTo(tm, b, 2.02, 1, 0);
    expect(sensT.occupied).toBe(true);
    expect(shown(b)).toEqual(['Tube']);
  });

  it('a second switcher switches on to the next variant (group members below a group node follow)', async () => {
    const { tm, spawn } = await load();
    const a = spawn('A');
    moveTo(tm, a, 2, 1, 0);
    moveTo(tm, a, 4, 1, 0);
    expect(shown(a)).toEqual(['Barrel', 'Lid']);
    expect(child(a, 'Round').visible).toBe(false);
    expect(child(a, 'Tube').visible).toBe(false);
  });

  it('a MUSwitcher without a Sensor on its node reports muswitcher-no-sensor', async () => {
    const { result } = await load();
    const problems = getProblems().filter((p) => p.code === MUSWITCHER_NO_SENSOR);
    expect(problems).toHaveLength(1);
    expect(problems[0].title).toContain('Lonely');
    const switchers = result.registry.getAll<RVMUSwitcher>('MUSwitcher');
    expect(switchers.map((s) => [s.instance.node.name, s.instance.getSensor() !== null]).sort())
      .toEqual([['Lonely', false], ['SensF', true], ['SensT', true]]);
  });

  it('switchMuGroup: the last Group of a node decides, nodes without a group are left alone', () => {
    const root = new Object3D();
    const plain = new Object3D();
    plain.visible = false;
    const multi = new Object3D();
    multi.userData.realvirtual = { Group: { GroupName: 'Tube' }, Group_1: { GroupName: 'Fass' } };
    root.add(plain, multi);
    expect(switchMuGroup(root, 'Fass')).toBe(1);
    expect(multi.visible).toBe(true);
    expect(plain.visible).toBe(false);
    switchMuGroup(root, 'Tube');
    expect(multi.visible).toBe(false);
  });
});

/** World visibility: the node and every ancestor visible. */
function worldVisible(n: Object3D): boolean {
  for (let c: Object3D | null = n; c; c = c.parent) if (!c.visible) return false;
  return true;
}

const sizeOf = (mu: RVMovingUnit): Vector3 => mu.aabb.max.clone().sub(mu.aabb.min);

describe('plan-2016 S5 fixes — MUSwitcher = SetActive, shape, spawn, instancing', () => {
  it('L1: the authored-inactive target group becomes ACTIVE (visible in the world, flag cleared)', async () => {
    const { tm, spawn } = await load();
    const a = spawn('A');
    const tube = child(a, 'Tube');
    expect(tube.userData[RV_INACTIVE_KEY]).toBe(true);
    moveTo(tm, a, 2, 1, 0);
    expect(worldVisible(tube)).toBe(true);
    expect(tube.userData[RV_INACTIVE_KEY], 'SetActive(true) clears the inactive flag').toBeUndefined();
    expect(child(a, 'Round').userData[RV_INACTIVE_KEY], 'SetActive(false) flags the old variant').toBe(true);
    expect(worldVisible(child(a, 'Round'))).toBe(false);
  });

  it('the MU box is re-measured from the active variant after a switch', async () => {
    const { tm, spawn } = await load();
    const a = spawn('A');
    expect(sizeOf(a).y).toBeLessThan(0.06);
    moveTo(tm, a, 4, 1, 0);   // SensF switches to Fass: the 0.6 m barrel is active now
    expect(child(a, 'Barrel').visible).toBe(true);
    expect(sizeOf(a).y).toBeGreaterThan(0.59);
    expect(sizeOf(a).x).toBeGreaterThan(0.59);
    // Centred on the barrel (the MU root), i.e. the stale 0.05 box was replaced, not grown.
    const c = a.aabb.min.clone().add(a.aabb.max).multiplyScalar(0.5);
    expect(c.distanceTo(new Vector3(4, 1, 0))).toBeLessThan(0.02);
  });

  it('Unity keeps the LAST of several Group components — labels keep authored order without dedup', async () => {
    const { result, tm, spawn } = await load();
    const tpl = result.registry.getNode('Hose/Multi')!;
    expect(groupLabelsOf(tpl)).toEqual(['Tube', 'Fass', 'Tube']);
    const a = spawn('A');
    expect(child(a, 'Multi').userData[RV_GROUP_LABELS_KEY]).toEqual(['Tube', 'Fass', 'Tube']);
    moveTo(tm, a, 2, 1, 0);
    expect(child(a, 'Multi').visible, 'switch to Tube: last component is Tube, active').toBe(true);
    moveTo(tm, a, 4, 1, 0);
    expect(child(a, 'Multi').visible, 'switch to Fass: last component is Tube, inactive').toBe(false);
  });

  it('a template authored inactive AS A WHOLE spawns active clones with a real size', async () => {
    const { result, tm } = await load();
    const srcOff = tm.sources.find((s: RVSource) => s.node.name === 'SrcOff')!;
    expect(result.registry.getNode('HoseOff')!.visible, 'the template itself stays hidden').toBe(false);
    const mu = tm.spawnFromSource(srcOff) as RVMovingUnit;
    expect(mu.node.visible).toBe(true);
    expect(mu.node.userData[RV_INACTIVE_KEY]).toBeUndefined();
    expect(worldVisible(child(mu, 'Body'))).toBe(true);
    expect(sizeOf(mu).x, 'the root flag does not erase the size').toBeGreaterThan(0.09);
  });

  it('instancing: a template with an inactive node or a group variant below its root takes the clone path', async () => {
    const { tm } = await load();
    const srcPill = tm.sources.find((s: RVSource) => s.node.name === 'SrcPill')! as unknown as { useInstancing: boolean };
    expect(srcPill.useInstancing, 'single mesh, but a switch variant').toBe(false);

    const plain = new Object3D();
    plain.add(box('Only', 0.1));
    expect(analyzeTemplate(plain), 'a plain single-mesh template still instances').not.toBeNull();
    const rootGroup = box('Root', 0.1, group('Products'));
    expect(analyzeTemplate(rootGroup), 'a group on the ROOT is no variant').not.toBeNull();
    const hidden = new Object3D();
    const h = box('Hidden', 0.1);
    h.userData[RV_INACTIVE_KEY] = true;
    hidden.add(h);
    expect(analyzeTemplate(hidden)).toBeNull();
    const variant = new Object3D();
    variant.add(box('V', 0.1, group('Tube')));
    expect(analyzeTemplate(variant)).toBeNull();
  });

  it('after the bake: an inactive variant is a group member that Groups can show; dispose unbinds the switcher', async () => {
    const { result, tm, spawn } = await load();
    const barrel = result.registry.getNode('Hose/Barrel')!;
    expect(barrel.visible).toBe(false);
    expect(result.groups!.get('Fass')!.nodes).toContain(barrel);
    result.groups!.setVisible('Fass', true);
    expect(barrel.visible).toBe(true);

    const sensT = result.registry.getAll<RVMUSwitcher>('MUSwitcher').find((e) => e.instance.node.name === 'SensT')!.instance;
    sensT.dispose();
    expect(sensT.getSensor()).toBeNull();
    const a = spawn('A');
    moveTo(tm, a, 2, 1, 0);
    expect(child(a, 'Tube').visible, 'no switch after dispose').toBe(false);
    expect(child(a, 'Round').visible).toBe(true);
  });
});

