// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.4 (bound scene) — the three stacker lifts of scenes/PalletYard.glb
// are independent after loading: driving Stapler_2's Lift moves only ITS LiftRam
// (Drive_Gear 0.5, instance-local reference), and the load rollers of all three
// vehicles keep their height relative to the vehicle (they hang on Chassis, not on
// Lift — the GLB hierarchy itself is checked in pallet-yard-scene.node.test.ts; the
// bake may fold the component-less Chassis empty into the vehicle root).
// Regression control for #188: three instances of the same vehicle must keep each
// Drive_Gear master inside its own vehicle. Since CP1d-b the stackers are placements
// (one bake of the library asset, three instances; the gear reference is tagged in the
// asset since b1-0) — loaded through the viewer so the placements materialise.
// It also checks that the loader added a duplicate suffix only where the GLB really
// holds the same name twice — never to a name that was unique in the file, which an
// editor save would otherwise write back as authored (the root node once loaded as
// `PalletYard_1` beside the model root `PalletYard`, which takes the glTF scene name).
import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import type { RVDrive } from '../../src/core/engine/rv-drive';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { PALLET_YARD_URL as URL, loadPalletYardScene } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(URL);

/** The vehicle (Stapler_n) a node belongs to. */
function vehicleOf(n: Object3D): string | null {
  for (let c: Object3D | null = n; c; c = c.parent) if (/^Stapler_\d$/.test(c.name)) return c.name;
  return null;
}
/** Node name without the loader's duplicate suffix (`Lift_1` → `Lift`; three.js dedups equal names). */
const baseName = (n: Object3D): string => n.name.replace(/_\d+$/, '');
const find = (drives: RVDrive[], vehicle: string, name: string): RVDrive => {
  const d = drives.find((x) => baseName(x.node) === name && vehicleOf(x.node) === vehicle);
  if (!d) throw new Error(`${vehicle}/${name}: no drive`);
  return d;
};
/** Node names of a GLB (JSON chunk), counted. */
function glbNameCounts(data: ArrayBuffer): Map<string, number> {
  const view = new DataView(data);
  const len = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, len))) as { nodes?: Array<{ name?: string }> };
  const counts = new Map<string, number>();
  for (const n of json.nodes ?? []) if (n.name) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
  return counts;
}
/** World position of `n` in the frame of `frame`. */
const inFrame = (n: Object3D, frame: Object3D): Vector3 => frame.worldToLocal(n.getWorldPosition(new Vector3()));

describe.skipIf(!AVAILABLE)('PalletYard bound scene', () => {
  it('three lifts are independent; the chassis with the load rollers stays on the floor', async () => {
    const data = await (await fetch(URL)).arrayBuffer();
    const y = await loadPalletYardScene();
    const res = { root: y.root, drives: y.drives };
    try {
      // Dedup suffixes only on names the file holds more than once (the model root,
      // named after the file stem, counts as one more holder of its name).
      const counts = glbNameCounts(data);
      counts.set('PalletYard', (counts.get('PalletYard') ?? 0) + 1);
      const unjustified: string[] = [];
      res.root.traverse((n) => {
        const m = /^(.*)_\d+$/.exec(n.name);
        if (!m || counts.has(n.name) || !counts.has(m[1])) return;
        if ((counts.get(m[1]) ?? 0) < 2) unjustified.push(n.name);
      });
      expect(unjustified).toEqual([]);
      expect(res.root.getObjectByName('PalletYardRoot')).toBeTruthy();

      const vehicles = ['Stapler_1', 'Stapler_2', 'Stapler_3'];
      const lifts = vehicles.map((v) => find(res.drives, v, 'Lift'));
      const rams = vehicles.map((v) => find(res.drives, v, 'LiftRam'));
      const rootOf = (v: string): Object3D => {
        let c: Object3D | undefined;
        res.root.traverse((n) => { if (!c && n.name === v) c = n; });
        if (!c) throw new Error(`${v}: vehicle root missing`);
        return c;
      };
      // The SolidCraft stacker (CP1b) carries its load rollers `Chassis/LoadRollerL/R` WITHOUT a
      // component: the bake merges them into the claimed `Chassis` chunk (no own node, no extra
      // draw call — the plugin never addresses a roller). What has to stay on the floor while a
      // fork lifts is therefore the Chassis node that carries their geometry (the GLB hierarchy
      // `Chassis/LoadRoller*`, not under `Lift`, is asserted in pallet-yard-scene.node.test.ts).
      const rollers = vehicles.flatMap((v) => {
        const frame = rootOf(v);
        const out: Array<{ node: Object3D; frame: Object3D; y0: number }> = [];
        res.root.traverse((n) => {
          if (baseName(n) === 'Chassis' && vehicleOf(n) === v) out.push({ node: n, frame, y0: inFrame(n, frame).y });
        });
        return out;
      });
      expect(rollers).toHaveLength(3);
      for (const r of rollers) {
        for (let p = r.node.parent; p && p !== r.frame; p = p.parent) expect(baseName(p)).not.toBe('Lift');
      }

      lifts[1].startMove(600);
      for (let i = 0; i < 60 * 8; i++) for (const d of res.drives) d.update(1 / 60);

      expect(lifts[1].currentPosition).toBeCloseTo(600, 3);
      expect(rams[1].currentPosition).toBeCloseTo(300, 1);          // 2:1 reeving, its own Lift
      for (const i of [0, 2]) {
        expect(lifts[i].currentPosition).toBeCloseTo(0, 6);
        expect(rams[i].currentPosition).toBeCloseTo(0, 6);
      }
      for (const r of rollers) expect(inFrame(r.node, r.frame).y).toBeCloseTo(r.y0, 6);
    } finally {
      y.dispose();
    }
  }, 120_000);
});
