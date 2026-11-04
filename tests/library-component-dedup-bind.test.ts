// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-622 §9.2 — two instances of the SAME library conveyor in ONE GLB both bind.
 *
 * three.js' `GLTFLoader.createUniqueName` makes node names unique per FILE, so
 * the second embedded RollConveyor carries `Transport-Z_1` / `Sensor_1`. The
 * naming-convention matchers used to reject that suffix: the second instance
 * was disabled ("missing Transport-*\/Sensor-* node") and nothing moved on it
 * (found in plan-612 Phase 4 CP1 — of four RollConveyors only the first bound).
 *
 * The fixture is the shipped `public/library/PalletHandling/RollConveyor-2m.glb`,
 * placed twice under one root the way `scenes/PalletYard.glb` embeds it (an
 * `rv_extras.Conveyor` payload on each instance root), exported with
 * `GLTFExporter` and loaded through the REAL viewer (`viewer.loadModel` → bake →
 * payload dispatch), so the `_1` names come from the loader itself. A pre-placed
 * MU on the SECOND instance must travel along that instance's belt.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Group, Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { unwrapGltfRoot } from '../src/core/engine/rv-gltf-unwrap';
import Conveyor from '../src/behaviors/Conveyor';
import { createParityHost, fixtureBytes, loadAsMainModel, type ParityHost, type LoadedAsset } from './helpers/parity-harness';
import { muNode, PART } from './_mu-preplaced-fixture';

const GLB_URL = '/library/PalletHandling/RollConveyor-2m.glb';

async function glbAvailable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    // The dev server answers unknown paths with the SPA fallback (200 text/html).
    return res.ok && /gltf-binary|octet-stream/i.test(res.headers.get('content-type') ?? '');
  } catch {
    return false;
  }
}
const AVAILABLE = await glbAvailable(GLB_URL);

/** Nearest ancestor (node included) whose name is one of `names`. */
function instanceOf(node: Object3D, names: readonly string[]): string | null {
  for (let c: Object3D | null = node; c; c = c.parent) if (names.includes(c.name)) return c.name;
  return null;
}

function byName(root: Object3D, name: string): Object3D {
  const n = root.getObjectByName(name);
  if (!n) throw new Error(`node ${name} not found`);
  return n;
}

const INSTANCES = ['Conveyor_A', 'Conveyor_B'] as const;

describe.skipIf(!AVAILABLE)('two embedded instances of one library conveyor (plan-622 §9.2)', () => {
  let host: ParityHost;
  let loaded: LoadedAsset;
  let warn: ReturnType<typeof vi.spyOn>;
  const warnings: string[] = [];

  beforeAll(async () => {
    const gltf = await new GLTFLoader().loadAsync(GLB_URL);
    const asset = unwrapGltfRoot(gltf.scene as Group);

    const root = new Group();
    root.name = 'DedupYard';
    INSTANCES.forEach((name, i) => {
      const inst = asset.clone(true);
      inst.name = name;
      inst.position.set(i * 3, 0, 0);
      inst.rotation.set(0, 0, 0);
      inst.scale.set(1, 1, 1);
      // Same embedding as scenes/PalletYard.glb: the payload names the type.
      inst.userData = { realvirtual: { Conveyor: {} } };
      root.add(inst);
    });
    // A part resting on the SECOND belt (top at y = 0.5 m), upstream of its sensor.
    root.add(muNode('Part_B', PART, [3, 0.5, -0.6]));

    warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });

    host = await createParityHost();
    host.viewer.behaviors.register('Conveyor', Conveyor);
    loaded = await loadAsMainModel(host, await fixtureBytes(root));
  }, 60_000);

  afterAll(() => {
    warn?.mockRestore();
    host?.dispose();
  });

  it('the loader really deduplicated the convention names of the second instance', () => {
    const transports: Object3D[] = [];
    loaded.assetRoot.traverse((n) => { if (/^Transport-Z(_\d+)?$/.test(n.name)) transports.push(n); });
    expect(transports.map((n) => n.name).sort()).toEqual(['Transport-Z', 'Transport-Z_1']);
    expect(byName(loaded.assetRoot, 'Sensor_1')).toBeTruthy();
  });

  it('both instances bind their OWN transport and sensor, none is disabled', () => {
    const binds = host.viewer.behaviors.getActiveBinds().filter((b) => b.behaviorId === 'Conveyor');
    expect(binds).toHaveLength(2);

    for (const name of INSTANCES) {
      const inst = byName(loaded.assetRoot, name);
      const marker = (inst.userData.realvirtual as Record<string, unknown>).ConveyorBehavior as
        { Belt?: string; Sensor?: string } | undefined;
      expect(marker, `${name}: ConveyorBehavior stamp`).toBeTruthy();
      const belt = byName(inst, marker!.Belt!);
      const sensor = byName(inst, marker!.Sensor!);
      expect(instanceOf(belt, INSTANCES), `${name}: belt`).toBe(name);
      expect(instanceOf(sensor, INSTANCES), `${name}: sensor`).toBe(name);
    }
    const a = (byName(loaded.assetRoot, 'Conveyor_A').userData.realvirtual as Record<string, { Belt: string }>).ConveyorBehavior;
    const b = (byName(loaded.assetRoot, 'Conveyor_B').userData.realvirtual as Record<string, { Belt: string }>).ConveyorBehavior;
    expect(new Set([a.Belt, b.Belt])).toEqual(new Set(['Transport-Z', 'Transport-Z_1']));

    expect(warnings.filter((w) => /missing/i.test(w))).toEqual([]);
  });

  it('a part on the second instance travels along that belt', () => {
    const part = byName(loaded.assetRoot, 'Part_B');
    const start = part.getWorldPosition(new Vector3());
    for (let i = 0; i < 60; i++) loaded.viewer._tickOnce(1 / 60);
    const end = part.getWorldPosition(new Vector3());
    // Belt runs along the instance's local +Z; 1 s of sim time at conveyor speed.
    expect(end.z - start.z).toBeGreaterThan(0.05);
    expect(Math.abs(end.x - start.x)).toBeLessThan(0.05);
  });
});
