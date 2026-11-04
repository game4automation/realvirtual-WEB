// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Guard against the regression that froze the standard demo (2026-10-29).
 *
 * `Source.Destination` is SORTING, not a transport brake — Thomas, 2026-10-29:
 * "destination ist einsortierung". It says under which node the Source files its new
 * MUs; it never takes them out of the transport loop. A short-lived skip in
 * `RVTransportManager.update()` (plan-2016 S1) did exactly that, and because the shipped
 * demo authors `Destination: "DemoCell/MUs"` — a plain collector node — every MU in the
 * standard demo stood still: `currentSurface` null, 0 mm travel, while the belts ran.
 *
 * Unity does not pause transport for a destination either, so the only correct
 * behaviour is: filed under the destination AND transported.
 *
 *   Cell
 *    ├─ Belt   box 0.6 × 0.1 × 2.0 at y 0.15 (top y = 0.2); Drive LinearZ jog + TransportSurface +z
 *    ├─ MUs    plain collector node at the origin                        ← Destination
 *    ├─ Part   box 0.2 — MU template, parked off to the side
 *    └─ Src    at (0, 0.301, -0.8) — spawns a Part with its underside 1 mm over the belt
 */

import { describe, it, expect, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { node, sceneToGlb } from './helpers/migrate-769-fixtures';
import type { RVMovingUnit } from '../src/core/engine/rv-mu';
import type { RVDrive } from '../src/core/engine/rv-drive';

const DT = 1 / 50;

function boxMesh(name: string, sx: number, sy: number, sz: number, extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(sx, sy, sz), new MeshBasicMaterial());
  m.name = name;
  if (extras) m.userData.realvirtual = extras;
  return m;
}

/** `withDestination = false` is the control case: identical scene, no Destination. */
async function build(withDestination: boolean): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';

  const belt = boxMesh('Belt', 0.6, 0.1, 2.0, {
    Drive: { Direction: 'LinearZ', TargetSpeed: 500, JogForward: true },
    TransportSurface: { TransportDirection: { x: 0, y: 0, z: 1 } },
  });
  belt.position.set(0, 0.15, 0);

  // The collector the demo uses: a plain node, no component of its own. It is kept
  // through the destructive bake only because `Source.Destination` is a declared
  // path field (PATH_FIELDS → bake survival).
  const collector = node('MUs');

  const part = boxMesh('Part', 0.2, 0.2, 0.2, { MU: {} });
  part.position.set(-3, 0, 0);

  const src = node('Src', {
    Source: {
      ThisObjectAsMU: 'Part', AutomaticGeneration: false, GenerateMU: true,
      ...(withDestination ? { Destination: 'MUs' } : {}),
    },
  });
  src.position.set(0, 0.301, -0.8);

  scene.add(belt, collector, part, src);
  return sceneToGlb(scene);
}

async function load(withDestination: boolean) {
  const result = await loadBakedGLB('source-destination-transport.glb', new Scene(),
    { data: (await build(withDestination)).slice(0), loadKinematicsSidecar: false });
  const tm = result.transportManager;
  tm.preferCloneMU = true; // a Destination forces the clone path anyway — keep both cases comparable
  const belt = result.drives.find((d) => d.name === 'Belt') as RVDrive;
  const step = () => { belt.update(DT); tm.update(DT); };
  step();
  const mu = tm.mus.find((m) => !m.isInstanced) as RVMovingUnit | undefined;
  return { result, tm, mu, belt, step };
}

const worldZ = (mu: RVMovingUnit) => { mu.node.updateWorldMatrix(true, false); return mu.node.getWorldPosition(new Vector3()).z; };

afterEach(() => clearAllProblems());

describe('Source.Destination is sorting, not a transport brake', () => {
  it('an MU filed under a Destination node is transported by the belt it stands on', async () => {
    const { result, tm, mu, step } = await load(true);
    expect(mu, 'one MU spawned').toBeTruthy();

    const collector = result.registry.getNode('MUs');
    expect(collector, 'the collector survives the bake').toBeTruthy();
    expect(mu!.node.parent, 'filed under the Destination node').toBe(collector);
    expect(mu!.destinationParent, 'and it remembers that it was filed there').toBe(collector);

    const z0 = worldZ(mu!);
    for (let i = 0; i < 50; i++) step();          // 1 s of belt at 500 mm/s
    const travelled = worldZ(mu!) - z0;

    expect(mu!.currentSurface, 'the belt drives it').toBeTruthy();
    expect(mu!.currentSurface!.node.name).toBe('Belt');
    expect(travelled, 'it travels along +z instead of standing still').toBeGreaterThan(0.2);
    expect(mu!.node.parent, 'and it is still filed under the Destination node').toBe(collector);

    // Same scene without a Destination: the travel must not differ because of the sorting.
    const control = await load(false);
    expect(control.mu!.node.parent).not.toBe(collector);
    const cz0 = worldZ(control.mu!);
    for (let i = 0; i < 50; i++) control.step();
    const controlTravel = worldZ(control.mu!) - cz0;
    expect(Math.abs(travelled - controlTravel), 'a Destination changes nothing about transport').toBeLessThan(1e-6);

    expect(tm.mus.length).toBeGreaterThan(0);
  });
});
