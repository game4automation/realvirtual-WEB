// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 CP1d-a on the REAL scenes/PalletYard.glb (stackers + conveyors are placements
// since CP1d-b), loaded the viewer way with the PalletYard plugin, switched to DES:
//   a1 Phase 0 — the stackers ARE DES-HMI components (the runner's Agv adapters), their
//      paths resolve in the registry, so the in-scene badges exist for them (with a SOC
//      row); driving the sim, each badge rides along with its stacker (rigid in the
//      vehicle frame, same height above it);
//   a2 — the plugin shows "⚡ n %" above the charger a stacker charges at, and a
//      simulation reset removes it;
//   a3 — every stacker placement's `Lamp_Beacon` wears the amber signal material.
// Every looked-up value is asserted to exist first (#211).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mesh, Object3D, Vector3, type MeshStandardMaterial, type Sprite } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { HIGHLIGHT_OVERLAY_LAYER } from '../../src/core/engine/rv-group-registry';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { clearShared } from '../helpers/agv-harness';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { DESRunner } from '@rv/plugins/des/des-runner';
import type { DESComponent } from '@rv/plugins/des/rv-des-component';
import { getActiveDesRunner, desComponentsOf } from '@rv/plugins/des/hmi/des-active-runner';
import { DES_SOC_USERDATA_KEY } from '@rv/plugins/des/hmi/des-stat-colors';
import { disposeDesStatsGizmos, getDesStatsGizmos } from '@rv/plugins/des/hmi/des-stats-gizmos';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard/index';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';

const AVAILABLE = (await devAssetAvailable(PALLET_YARD_URL)) && (await devAssetAvailable('/library/MobileRobots/AGVStacker.glb'));
const STACKERS = ['Stapler_1', 'Stapler_2', 'Stapler_3'];
const TICK = 1 / 60;

const find = (root: Object3D, name: string): Object3D | null => {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  return hit;
};

describe.skipIf(!AVAILABLE)('plan-612 CP1d-a — badges, charger label and beacon on the real PalletYard', () => {
  let h: TestViewerHandle;
  let v: RVViewer;
  let root: Object3D;
  let plugin: PalletYardPlugin;
  let runner: DESRunner;
  let wall = 0;

  /** One viewer frame: runner ticks (Animated), the plugin's onRender, the world-matrix walk, the badge follow. */
  const frame = (): void => {
    runner.tick(TICK);
    runner.lateTick(TICK);
    wall += TICK * 1000;
    plugin.onRender();
    v.scene.updateMatrixWorld();
    getDesStatsGizmos(v).updateFrame();
  };

  beforeAll(async () => {
    clearShared();
    h = await createTestViewer('webgl');
    v = h.viewer;
    v.loop.setPaused('plan-612-cp1d-a', true);
    registerAllBehaviors(v.behaviors);
    plugin = new PalletYardPlugin();
    plugin.chargerLabels.wallNow = () => wall;
    v.use(plugin);
    await v.loadModel(PALLET_YARD_URL);
    await v.whenSceneReady();
    await Promise.resolve();
    root = (v as unknown as { currentModel: Object3D }).currentModel;
    v.simulationKernel!.setMode('des');
    await Promise.resolve();
    runner = v.simulationKernel!.desControl() as unknown as DESRunner;
    v.scene.updateMatrixWorld(true);
  }, 240_000);
  afterAll(() => { if (v) disposeDesStatsGizmos(v); h?.dispose(); clearShared(); });

  it('Phase 0: the stackers are DES-HMI components whose paths resolve in the registry', () => {
    expect(runner, 'DES runner').toBeTruthy();
    expect(plugin.runtime, 'plugin bound').not.toBeNull();
    const source = getActiveDesRunner(v);
    expect(source, 'DES-HMI source').not.toBeNull();
    const comps = desComponentsOf(source!);
    for (const n of STACKERS) {
      const c = comps.find((x) => x.node.name === n);
      expect(c, `${n} component`).toBeDefined();
      console.info(`[cp1d-a] ${n}: path ${c!.path}`);
      expect(v.registry?.getNode(c!.path), `${n} path resolves`).toBe(c!.node);
    }
  });

  it('a1: every stacker gets a badge with a SOC row, and it rides along with the stacker', () => {
    frame();   // the plugin publishes the SOC onto the vehicle nodes
    const source = getActiveDesRunner(v)!;
    const comps = STACKERS.map((n) => desComponentsOf(source).find((x) => x.node.name === n) as DESComponent);
    for (const c of comps) expect(typeof c.node.userData[DES_SOC_USERDATA_KEY], `${c.node.name} SOC`).toBe('number');
    const g = getDesStatsGizmos(v);
    g.setEnabled(true);
    const start = comps.map((c) => {
      const s = g.spriteOf(c.path);
      expect(s, `${c.node.name} badge`).not.toBeNull();
      expect((s!.material.map as unknown as { image: HTMLCanvasElement }).image.height, `${c.node.name} SOC row`).toBe(204);
      return {
        c, s: s as Sprite,
        root0: c.node.getWorldPosition(new Vector3()),
        local0: c.node.worldToLocal(s!.position.clone()),
        above0: s!.position.y - c.node.matrixWorld.elements[13],
      };
    });
    for (let i = 0; i < 60 * 60; i++) frame();   // one sim minute, Animated
    let moved = 0;
    for (const b of start) {
      const now = b.c.node.getWorldPosition(new Vector3());
      if (Math.hypot(now.x - b.root0.x, now.z - b.root0.z) > 1) moved++;
      const local = b.c.node.worldToLocal(b.s.position.clone());
      expect(Math.hypot(local.x - b.local0.x, local.z - b.local0.z), `${b.c.node.name}: badge rigid in the vehicle frame`).toBeLessThan(1e-4);
      expect(b.s.position.y - b.c.node.matrixWorld.elements[13], `${b.c.node.name}: height above the vehicle`).toBeCloseTo(b.above0, 6);
    }
    console.info(`[cp1d-a] stackers moved > 1 m in one sim minute: ${moved}`);
    expect(moved, 'at least one stacker drove (else the follow proves nothing)').toBeGreaterThan(0);
  }, 240_000);

  it('a2: the plugin shows "⚡ n %" above the charger a stacker charges at; a simulation reset removes it', () => {
    const rt = plugin.runtime!;
    expect(rt, 'runtime').not.toBeNull();
    const labelsInScene = (): Sprite[] => v.scene.children.filter((o) => o.name.startsWith('ChargerLabel_')) as Sprite[];
    let guard = 0;
    while (plugin.chargerLabels.size === 0 && guard++ < 60 * 900) frame();
    expect(plugin.chargerLabels.size, 'a stacker charges within 15 sim minutes').toBeGreaterThan(0);
    const charging = rt.vehicleIds.map((id) => [id, rt.chargingAt(id)] as const).filter(([, c]) => c !== null);
    expect(charging.length).toBe(plugin.chargerLabels.size);
    for (const [id, c] of charging) {
      const info = plugin.chargerLabels.label(c!);
      expect(info, `label at ${c}`).not.toBeNull();
      expect(info!.vehicle).toBe(id);
      expect(info!.percent).toBe(Math.round(rt.socAt(id)));
      expect(info!.sprite.layers.isEnabled(HIGHLIGHT_OVERLAY_LAYER), 'overlay layer').toBe(true);
      const at = find(root, id)!.getWorldPosition(new Vector3());
      expect(Math.hypot(info!.position.x - at.x, info!.position.z - at.z), `${c} label near ${id}`).toBeLessThan(1.6);
      console.info(`[cp1d-a] ${id} charging at ${c}: ${info!.text}`);
    }
    expect(labelsInScene().length).toBe(plugin.chargerLabels.size);
    v.resetSimulation();
    plugin.onRender();
    expect(plugin.chargerLabels.size, 'after reset').toBe(0);
    expect(labelsInScene(), 'no charger sprite after reset').toEqual([]);
  }, 240_000);

  it('a3: Lamp_Beacon of every stacker placement wears the amber signal material', () => {
    for (const n of STACKERS) {
      const s = find(root, n);
      expect(s, n).not.toBeNull();
      const beacon = find(s!, 'Lamp_Beacon');
      expect(beacon, `${n}/Lamp_Beacon`).not.toBeNull();
      const meshes: Mesh[] = [];
      beacon!.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
      expect(meshes.length, `${n} beacon mesh`).toBeGreaterThan(0);
      for (const m of meshes) {
        const mats = (Array.isArray(m.material) ? m.material : [m.material]) as MeshStandardMaterial[];
        for (const mat of mats) {
          console.info(`[cp1d-a] ${n} beacon material "${mat.name}" color ${mat.color.toArray().map((x) => x.toFixed(3))}`);
          expect(mat.name, `${n} beacon material`).toContain('Signal Amber');
          // Amber, not red: a clear green share, no blue (red: g ≈ 0).
          expect(mat.color.g / mat.color.r, `${n} beacon hue`).toBeGreaterThan(0.3);
          expect(mat.color.b).toBeLessThan(0.05);
        }
      }
    }
  });
});
