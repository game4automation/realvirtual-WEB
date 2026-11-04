// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 CP1d-a a1 — in-scene DES stats badges ride along with their node.
// The badge remembers its anchor in the node's local frame; `updateFrame()` (per
// frame, from the DES-HMI plugin's `onRender`) carries it along: x/z from the
// node's current world matrix, the height above the node's origin kept vertical.
// A standing node keeps its badge where it was. A node carrying a state of charge
// gets a SOC row. Every looked-up value is asserted to exist first (#211).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, Matrix4, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { DESComponent } from '@rv/plugins/des/rv-des-component';
import { DES_SOC_USERDATA_KEY } from '@rv/plugins/des/hmi/des-stat-colors';
import { hmiRunner } from './des-hmi-runner-fixture';
import { DesStatsGizmos, disposeDesStatsGizmos, getDesStatsGizmos } from '@rv/plugins/des/hmi/des-stats-gizmos';
import { DESHMIPlugin } from '@rv/plugins/des/hmi/des-hmi-plugin';

interface Fixture {
  viewer: RVViewer;
  scene: Scene;
  vehicle: Object3D;
  station: Object3D;
  comps: DESComponent[];
}

/** A node with a 1 m box whose centre sits 1 m off the node origin along local +X (so a yaw moves the bbox centre). */
function partNode(name: string, x: number, z: number): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(x, 0, z);
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  m.position.set(1, 0.5, 0);
  n.add(m);
  return n;
}

function fixture(): Fixture {
  const scene = new Scene();
  const vehicle = partNode('Vehicle', 2, 3);
  const station = partNode('Station', -4, 1);
  scene.add(vehicle, station);
  scene.updateMatrixWorld(true);
  const { runner, comps } = hmiRunner(scene, [vehicle, station]);
  const byPath = (p: string): Object3D | null => scene.getObjectByName(p) ?? null;
  const viewer = {
    scene,
    registry: { getNode: byPath },
    on: () => () => {},
  } as unknown as RVViewer;
  const source = runner;
  Object.assign(viewer, { simulationKernel: { mode: 'des', activeExecutor: source } });
  return { viewer, scene, vehicle, station, comps };
}

const v3 = (p: { x: number; y: number; z: number }): Vector3 => new Vector3(p.x, p.y, p.z);

describe('DES stats badges follow their node (plan-612 CP1d-a a1)', () => {
  let f: Fixture | null = null;
  afterEach(() => {
    if (f) { disposeDesStatsGizmos(f.viewer); Object.assign(f.viewer, { simulationKernel: null }); }
    f = null;
    vi.restoreAllMocks();
  });

  it('a badge exists for both components, above the bbox top at the bbox centre', () => {
    f = fixture();
    const g = getDesStatsGizmos(f.viewer);
    g.setEnabled(true);
    const s = g.spriteOf('Vehicle');
    expect(s, 'vehicle badge').not.toBeNull();
    // bbox centre x = 2 + 1, z = 3; top = 1 → centre y = 1 + 0.65 (default offset).
    expect(s!.position.x).toBeCloseTo(3, 9);
    expect(s!.position.z).toBeCloseTo(3, 9);
    expect(s!.position.y).toBeCloseTo(1.65, 9);
    expect(g.spriteOf('Station'), 'station badge').not.toBeNull();
  });

  it('after moving and yawing the node the badge sits at the moved anchor (x/z) at the same height above the node', () => {
    f = fixture();
    const g = getDesStatsGizmos(f.viewer);
    g.setEnabled(true);
    const s = g.spriteOf('Vehicle')!;
    expect(s).not.toBeNull();
    const before = v3(s.position);
    const node0 = new Matrix4().copy(f.vehicle.matrixWorld);
    const local = before.clone().applyMatrix4(node0.clone().invert());
    // The vehicle drives 5 m along -X, 2 m along +Z, 0.4 m up a ramp, and turns 90° about Y.
    f.vehicle.position.set(-3, 0.4, 5);
    f.vehicle.rotation.set(0, Math.PI / 2, 0);
    f.scene.updateMatrixWorld(true);   // the viewer's one world-matrix walk per frame
    g.updateFrame();
    const expected = local.clone().applyMatrix4(f.vehicle.matrixWorld);
    expect(s.position.x).toBeCloseTo(expected.x, 9);
    expect(s.position.z).toBeCloseTo(expected.z, 9);
    expect(s.position.y).toBeCloseTo(0.4 + 1.65, 9);
    // It really moved (a badge that stays put fails here).
    expect(s.position.distanceTo(before)).toBeGreaterThan(4);
    // Yaw 90° about Y maps the +X offset onto -Z: bbox centre now at (-3, ·, 5 - 1).
    expect(s.position.x).toBeCloseTo(-3, 9);
    expect(s.position.z).toBeCloseTo(4, 9);
  });

  it('a tilted node keeps the badge vertical above it (height from the anchor, not rotated)', () => {
    f = fixture();
    const g = getDesStatsGizmos(f.viewer);
    g.setEnabled(true);
    const s = g.spriteOf('Vehicle')!;
    expect(s).not.toBeNull();
    f.vehicle.rotation.set(0.5, 0, 0);   // pitch about X (a rotated anchor would sit lower / aside)
    f.vehicle.position.y = 0.3;
    f.scene.updateMatrixWorld(true);
    g.updateFrame();
    expect(s.position.y, 'height above the node origin unchanged').toBeCloseTo(0.3 + 1.65, 9);
  });

  it('a standing node keeps its badge exactly where it was, frame after frame', () => {
    f = fixture();
    const g = getDesStatsGizmos(f.viewer);
    g.setEnabled(true);
    const s = g.spriteOf('Station')!;
    expect(s).not.toBeNull();
    const before = v3(s.position);
    for (let i = 0; i < 10; i++) { f.scene.updateMatrixWorld(true); g.updateFrame(); }
    expect(s.position.x).toBeCloseTo(before.x, 12);
    expect(s.position.y).toBeCloseTo(before.y, 12);
    expect(s.position.z).toBeCloseTo(before.z, 12);
  });

  it('the per-frame path allocates nothing it can avoid: no clone, no bbox, no matrix walk, no canvas, same position object', () => {
    f = fixture();
    const g = getDesStatsGizmos(f.viewer);
    g.setEnabled(true);
    const s = g.spriteOf('Vehicle')!;
    expect(s).not.toBeNull();
    const pos = s.position;
    const spies = [
      vi.spyOn(Vector3.prototype, 'clone'),
      vi.spyOn(Box3.prototype, 'setFromObject'),
      vi.spyOn(Matrix4.prototype, 'clone'),
      vi.spyOn(Matrix4.prototype, 'invert'),
      vi.spyOn(Object3D.prototype, 'updateWorldMatrix'),
      vi.spyOn(Object3D.prototype, 'worldToLocal'),
      vi.spyOn(Object3D.prototype, 'localToWorld'),
      vi.spyOn(document, 'createElement'),
    ];
    for (let i = 0; i < 100; i++) {
      f.vehicle.position.x = i * 0.01;
      f.vehicle.updateMatrixWorld(true);
      g.updateFrame();
    }
    // The path really ran (the badge followed) …
    expect(s.position.x).toBeCloseTo(0.99 + 1, 9);
    // … through none of the allocating helpers.
    for (const sp of spies) expect(sp, sp.getMockName()).not.toHaveBeenCalled();
    expect(s.position, 'sprite position mutated in place').toBe(pos);
  });

  it('a node with a state of charge gets a SOC row (taller canvas, "SOC 63 %"); one without keeps the old layout', () => {
    f = fixture();
    f.vehicle.userData[DES_SOC_USERDATA_KEY] = 62.6;
    const texts: string[] = [];
    const orig = CanvasRenderingContext2D.prototype.fillText;
    vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText').mockImplementation(function (this: CanvasRenderingContext2D, t: string, x: number, y: number, w?: number) {
      texts.push(t);
      return w === undefined ? orig.call(this, t, x, y) : orig.call(this, t, x, y, w);
    });
    const g = getDesStatsGizmos(f.viewer);
    g.setEnabled(true);
    const veh = g.spriteOf('Vehicle')!;
    const sta = g.spriteOf('Station')!;
    expect(veh).not.toBeNull();
    expect(sta).not.toBeNull();
    const img = (sp: typeof veh): HTMLCanvasElement => (sp.material.map as unknown as { image: HTMLCanvasElement }).image;
    expect(img(sta).height, 'no SOC: unchanged canvas').toBe(80 * 2);
    expect(img(veh).height, 'SOC row').toBe((80 + 22) * 2);
    expect(texts).toContain('SOC 63 %');
    // Same pixel density: the world height grows with the canvas.
    expect(veh.scale.y / sta.scale.y).toBeCloseTo(102 / 80, 9);
  });

  it('a SOC that appears after the badge was built rebuilds the badge with the SOC row on the next refresh', () => {
    f = fixture();
    const g = getDesStatsGizmos(f.viewer);
    g.setEnabled(true);
    const first = g.spriteOf('Vehicle')!;
    expect(first).not.toBeNull();
    expect((first.material.map as unknown as { image: HTMLCanvasElement }).image.height).toBe(160);
    f.vehicle.userData[DES_SOC_USERDATA_KEY] = 40;
    (g as unknown as { refresh(): void }).refresh();
    const second = g.spriteOf('Vehicle')!;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect((second.material.map as unknown as { image: HTMLCanvasElement }).image.height).toBe(204);
    expect(f.scene.children.includes(first), 'old sprite removed').toBe(false);
    expect(f.scene.children.includes(second)).toBe(true);
    // The rebuilt badge still follows.
    f.vehicle.position.z = 10;
    f.scene.updateMatrixWorld(true);
    g.updateFrame();
    expect(second.position.z).toBeCloseTo(10, 9);
  });

  it('the DES-HMI plugin drives it from onRender (and does nothing without badges)', () => {
    f = fixture();
    const plugin = new DESHMIPlugin();
    // Before any viewer / badge: a no-op.
    expect(() => plugin.onRender()).not.toThrow();
    plugin.ensureViewer(f.viewer);
    expect(() => plugin.onRender()).not.toThrow();
    const g = getDesStatsGizmos(f.viewer);
    expect(g).toBeInstanceOf(DesStatsGizmos);
    g.setEnabled(true);
    const s = g.spriteOf('Vehicle')!;
    expect(s).not.toBeNull();
    f.vehicle.position.x = -10;
    f.scene.updateMatrixWorld(true);
    plugin.onRender();
    expect(s.position.x).toBeCloseTo(-9, 9);
    plugin.dispose();
  });
});
