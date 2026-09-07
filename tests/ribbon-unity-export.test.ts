// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-unity-export.test.ts — the Unity → GLB → browser roundtrip (plan-466 §2.6).
 *
 * This is the ACCEPTANCE criterion of the Unity ribbon port. Everything else proves that
 * the two implementations agree on paper: the shared JSON vectors pin the mathematics,
 * and the Unity EditMode suite pins the Unity side against them. Only this file proves
 * the thing a customer actually does — build a converting machine in Unity, export it,
 * open it in realvirtual WEB — produces the same machine.
 *
 * ## How it works
 *
 * Unity's `TestRibbonDemoRecordsParityState` builds two variants of the slitter demo
 * (`RibbonDemoScene`), runs each for `round(2 s / Time.fixedDeltaTime)` fixed ticks and
 * records the resulting state into `ribbon-unity-state.json` next to the exported GLBs.
 * This file loads those GLBs, steps its own simulation with the SAME `dt` and tick count
 * — drives first, then the web, the production order — and compares.
 *
 * The `AxisY` variant is not decoration. Axis Y and `TravelAxis: 'X'` are exactly the
 * cases where a Unity-to-glTF handedness mistake shows: Unity mirrors X on export and
 * maps `RotationY` to glTF `-Y`, so a port that computed in the Unity frame would run
 * that machine backwards while the plain X variant looked perfect. It did, once — the
 * first export of this demo had the axis-Y rewinders paying web out from an empty core.
 *
 * ## What is compared
 *
 * Per roller: rotation angle, signed surface speed, contact radius, driven flag.
 * Per winder: wound length and diameter. Per dancer: carriage position and both limit
 * flags. Per path: length, slit sample, resolved wrap sides, section speeds.
 * Plus two structural gates that no recorded number can express: no band vertex inside a
 * roller, and no rv_extras field the schema does not know.
 *
 * Regenerate both sides with, in Unity:
 *   realvirtual DEV/Samples/Export Ribbon Slitter GLBs   (writes the two GLBs)
 *   the feature test `TestRibbonDemoRecordsParityState`  (writes the state JSON)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Box3, Scene, Vector3 } from 'three';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';
import { RibbonManager } from '../src/core/engine/rv-ribbon-manager';
import { MM_TO_METERS } from '../src/core/engine/rv-constants';
import type { RVRibbonPath } from '../src/core/engine/rv-ribbon-path';
import type { RVRibbonWinder } from '../src/core/engine/rv-ribbon-winder';
import type { RVRibbonDancer } from '../src/core/engine/rv-ribbon-dancer';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

/** The artefacts live in the private Development project and are absent from a public checkout. */
const DEV_ASSETS = await devAssetAvailable(DEV_GLB.ribbonSlitterUnity);

/** Relative tolerance on every recorded magnitude — the plan's 0.5 %. */
const REL_TOLERANCE = 0.005;

/** mm — a band vertex may not be deeper than this inside a roller. */
const PENETRATION_TOLERANCE_MM = 0.1;

/**
 * rv_extras keys every realvirtual component carries, whatever its type: the serializer's
 * own metadata plus the `realvirtualBehavior` base fields. They are framework-wide and
 * deliberately outside the per-component schema.
 */
const FRAMEWORK_KEYS = new Set(['_fullTypeName', '_version', '_enabled', 'Name', 'Active']);

/** The state Unity recorded, exactly as written. */
interface UnityRoller {
  angleRad: number;
  surfaceSpeedMmPerS: number;
  radiusMm: number;
  isDriven: boolean;
  woundLengthMm?: number;
  diameterMm?: number;
  empty?: boolean;
  full?: boolean;
  positionMm?: number;
  accumulatedMm?: number;
  atMin?: boolean;
  atMax?: boolean;
}

interface UnityPath {
  lengthMm: number;
  slitSampleIndex: number;
  sampleStepMm: number;
  drawsPreSlit: boolean;
  rollers: string[];
  sides: number[];
  sectionSpeedsMmPerS: number[];
}

interface UnityVariant {
  glb: string;
  axis: 'X' | 'Y';
  rollers: Record<string, UnityRoller>;
  paths: Record<string, UnityPath>;
}

interface UnityState {
  dt: number;
  ticks: number;
  seconds: number;
  variants: Record<string, UnityVariant>;
}

/** One loaded and stepped browser run of a variant. */
interface Run {
  result: LoadResult;
  /** The scene the GLB was loaded into - `LoadResult` does not carry one. */
  scene: Scene;
  manager: RibbonManager;
  paths: RVRibbonPath[];
}

let state: UnityState | null = null;
const runs = new Map<string, Run>();

/** URL of a variant's GLB, from the name Unity recorded. */
function urlFor(variant: UnityVariant): string {
  return variant.axis === 'X' ? DEV_GLB.ribbonSlitterUnity : DEV_GLB.ribbonSlitterUnityAxisY;
}

/**
 * Load one GLB and step it exactly as Unity did.
 *
 * The order inside the loop is load-bearing and is the production one: every drive
 * advances first, then the ribbon manager reads their new positions. A loop that ticked
 * the manager first would measure a one-tick-old drive and legitimately see zero — the
 * whole point of reading the position DIFFERENCE.
 */
async function runVariant(variant: UnityVariant, dt: number, ticks: number): Promise<Run> {
  const url = urlFor(variant);
  const bytes = await (await fetch(url)).arrayBuffer();
  const scene = new Scene();
  const manager = new RibbonManager();
  // preserveHierarchy: the merges would bake the roller nodes away, and every question
  // this file asks is about the authored nodes.
  const result = await loadGLB(url, scene, { data: bytes, preserveHierarchy: true, ribbonManager: manager });
  scene.updateMatrixWorld(true);

  const drives = result.registry.getAll<RVDrive>('Drive').map((d) => d.instance);
  for (let i = 0; i < ticks; i++) {
    for (const drive of drives) drive.update(dt);
    manager.update(dt);
  }

  const paths = result.registry.getAll<RVRibbonPath>('RibbonPath').map((p) => p.instance);
  paths.sort((a, b) => (a.node.name < b.node.name ? -1 : 1));
  return { result, scene, manager, paths };
}

beforeAll(async () => {
  // The suite is `skipIf`-ed without the private sibling, but a top-level `beforeAll` runs
  // anyway — and there the dev server answers `/private-assets/` with the SPA fallback,
  // whose bytes are neither JSON nor a GLB. Bail out so the file reports `skipped`.
  if (!DEV_ASSETS) return;
  state = await (await fetch(DEV_GLB.ribbonUnityState)).json() as UnityState;
  for (const [name, variant] of Object.entries(state.variants)) {
    runs.set(name, await runVariant(variant, state.dt, state.ticks));
  }
}, 180_000);

/** `actual` is within 0.5 % of `expected`, and has the same sign. */
function expectClose(actual: number, expected: number, what: string): void {
  expect(Math.sign(actual), `${what}: sign (unity ${expected}, web ${actual})`).toBe(Math.sign(expected));
  const tolerance = Math.max(Math.abs(expected) * REL_TOLERANCE, 1e-4);
  expect(Math.abs(actual - expected), `${what}: unity ${expected}, web ${actual}`).toBeLessThanOrEqual(tolerance);
}

describe.skipIf(!DEV_ASSETS)('Unity → GLB → realvirtual WEB roundtrip', () => {
  it('the recorded state describes both variants', () => {
    expect(state).not.toBeNull();
    expect(state!.ticks).toBeGreaterThan(50);
    expect(state!.dt).toBeGreaterThan(0);
    expect(Object.keys(state!.variants).sort()).toEqual(['axisX', 'axisY']);
    for (const run of runs.values()) expect(run.paths).toHaveLength(2);
  });

  it('every ribbon rv_extras field is one the schema knows', () => {
    const schemas: Record<string, Set<string>> = {};
    for (const type of ['RibbonRoller', 'RibbonWinder', 'RibbonDancer', 'RibbonPath']) {
      schemas[type] = new Set(Object.keys(loadSchemaFromSpec(type)));
    }

    for (const [name, run] of runs) {
      let checked = 0;
      run.scene.traverse((node) => {
        const extras = node.userData?.realvirtual as Record<string, unknown> | undefined;
        if (!extras) return;
        for (const [type, allowed] of Object.entries(schemas)) {
          const block = extras[type] as Record<string, unknown> | undefined;
          if (!block) continue;
          checked++;
          for (const key of Object.keys(block)) {
            expect(
              allowed.has(key) || FRAMEWORK_KEYS.has(key),
              `${name}: "${node.name}" ${type} exports "${key}", which is not in schema/v1/rv-odt.json`,
            ).toBe(true);
          }
        }
      });
      // A variant whose extras never appeared would pass the loop vacuously.
      expect(checked, `${name}: no ribbon extras found at all`).toBeGreaterThanOrEqual(10);
    }
  });

  it('every roller reproduces the angle, surface speed, radius and driven flag Unity recorded', () => {
    for (const [name, variant] of Object.entries(state!.variants)) {
      const run = runs.get(name)!;
      for (const [rollerName, expected] of Object.entries(variant.rollers)) {
        const entry = run.result.registry.getAll('RibbonRoller')
          .concat(run.result.registry.getAll('RibbonWinder'))
          .concat(run.result.registry.getAll('RibbonDancer'))
          .find((e) => e.instance.node.name === rollerName);
        expect(entry, `${name}: the GLB has no roller "${rollerName}"`).toBeTruthy();
        const roller = entry!.instance as unknown as {
          angle: number; surfaceSpeedMmPerS: number; radiusMm: number; isDriven: boolean;
        };

        expect(roller.isDriven, `${name}/${rollerName}: driven flag`).toBe(expected.isDriven);
        expectClose(roller.radiusMm, expected.radiusMm, `${name}/${rollerName} radiusMm`);
        expectClose(roller.surfaceSpeedMmPerS, expected.surfaceSpeedMmPerS,
          `${name}/${rollerName} surfaceSpeedMmPerS`);
        expectClose(roller.angle, expected.angleRad, `${name}/${rollerName} angleRad`);
      }
    }
  });

  it('every winder reproduces its wound length and diameter', () => {
    for (const [name, variant] of Object.entries(state!.variants)) {
      const run = runs.get(name)!;
      for (const [rollerName, expected] of Object.entries(variant.rollers)) {
        if (expected.woundLengthMm === undefined) continue;
        const entry = run.result.registry.getAll<RVRibbonWinder>('RibbonWinder')
          .find((e) => e.instance.node.name === rollerName);
        expect(entry, `${name}: the GLB has no winder "${rollerName}"`).toBeTruthy();
        const winder = entry!.instance;

        expectClose(winder.woundLengthMm, expected.woundLengthMm, `${name}/${rollerName} woundLengthMm`);
        expectClose(winder.diameterMm, expected.diameterMm!, `${name}/${rollerName} diameterMm`);
        expect(winder.isEmpty, `${name}/${rollerName} Empty`).toBe(expected.empty);
        expect(winder.isFull, `${name}/${rollerName} Full`).toBe(expected.full);
      }
    }
  });

  it('every dancer reproduces its carriage position and limit flags', () => {
    for (const [name, variant] of Object.entries(state!.variants)) {
      const run = runs.get(name)!;
      let dancers = 0;
      for (const [rollerName, expected] of Object.entries(variant.rollers)) {
        if (expected.positionMm === undefined) continue;
        dancers++;
        const entry = run.result.registry.getAll<RVRibbonDancer>('RibbonDancer')
          .find((e) => e.instance.node.name === rollerName);
        expect(entry, `${name}: the GLB has no dancer "${rollerName}"`).toBeTruthy();
        const dancer = entry!.instance;

        // The carriage moves in millimetres of travel, so an absolute tolerance is the
        // honest one at the stops, where the relative one would be a fraction of a stop.
        expect(Math.abs(dancer.positionMm - expected.positionMm),
          `${name}/${rollerName} positionMm: unity ${expected.positionMm}, web ${dancer.positionMm}`)
          .toBeLessThanOrEqual(Math.max(Math.abs(expected.positionMm) * REL_TOLERANCE, 0.5));
        expect(dancer.atMin, `${name}/${rollerName} AtMin`).toBe(expected.atMin);
        expect(dancer.atMax, `${name}/${rollerName} AtMax`).toBe(expected.atMax);
      }

      expect(dancers, `${name}: expected two dancers in the recording`).toBe(2);
    }
  });

  it('every path reproduces its length, slit sample, wrap sides and section speeds', () => {
    for (const [name, variant] of Object.entries(state!.variants)) {
      const run = runs.get(name)!;
      for (const [pathName, expected] of Object.entries(variant.paths)) {
        const path = run.paths.find((p) => p.node.name === pathName);
        expect(path, `${name}: the GLB has no path "${pathName}"`).toBeTruthy();

        expectClose(path!.lengthMm, expected.lengthMm, `${name}/${pathName} lengthMm`);
        expect(path!.slitSampleIndex, `${name}/${pathName} slitSampleIndex`).toBe(expected.slitSampleIndex);
        expect(path!.drawsPreSlit, `${name}/${pathName} drawsPreSlit`).toBe(expected.drawsPreSlit);
        expect(path!.rollers.map((r) => r.node.name), `${name}/${pathName} roller chain`)
          .toEqual(expected.rollers);

        const sides = path!.rollers.map((_, i) => path!.resolvedSideAt(i));
        expect(sides, `${name}/${pathName} resolved wrap sides`).toEqual(expected.sides);

        expect(path!.sections.length, `${name}/${pathName} section count`)
          .toBe(expected.sectionSpeedsMmPerS.length);
        for (let k = 0; k < expected.sectionSpeedsMmPerS.length; k++) {
          expectClose(path!.sections[k].speed, expected.sectionSpeedsMmPerS[k],
            `${name}/${pathName} section ${k} speed`);
        }
      }
    }
  });

  it('no band vertex lies inside a roller of its own path', () => {
    const centre = new Vector3();
    const axis = new Vector3();
    const point = new Vector3();
    const delta = new Vector3();
    const box = new Box3();

    for (const [name, run] of runs) {
      for (const path of run.paths) {
        const band = path.band!;
        expect(band, `${name}/${path.node.name} has no band`).toBeTruthy();
        band.mesh.updateMatrixWorld(true);
        const pos = band.mesh.geometry.getAttribute('position');

        for (const roller of path.rollers) {
          const node = roller.node;
          node.updateMatrixWorld(true);
          centre.setFromMatrixPosition(node.matrixWorld);
          // The axis is taken from the roller's own letter and its world matrix, not
          // assumed: this suite runs the axis-Y variant too.
          axis.set(roller.axis === 'X' ? 1 : 0, roller.axis === 'Y' ? 1 : 0, roller.axis === 'Z' ? 1 : 0)
            .transformDirection(node.matrixWorld).normalize();
          box.setFromObject(node);
          const size = new Vector3();
          box.getSize(size);
          const halfLenMm = (Math.abs(size.dot(axis.clone().set(
            Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z),
          ))) / 2) * MM_TO_METERS;
          const limitMm = roller.radiusMm - PENETRATION_TOLERANCE_MM;

          for (let i = 0; i < pos.count; i++) {
            point.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(band.mesh.matrixWorld);
            delta.subVectors(point, centre);
            const axialMm = delta.dot(axis) * MM_TO_METERS;
            if (Math.abs(axialMm) > halfLenMm) continue;     // beside the roller
            const radialMm = delta.addScaledVector(axis, -delta.dot(axis)).length() * MM_TO_METERS;
            expect(
              radialMm,
              `${name}/"${path.node.name}" vertex ${i} is ${(roller.radiusMm - radialMm).toFixed(2)} mm `
              + `inside "${node.name}" (r = ${roller.radiusMm.toFixed(2)} mm)`,
            ).toBeGreaterThanOrEqual(limitMm);
          }
        }
      }
    }
  });

  it('every signal slot that is wired resolves to an address', () => {
    // The demo authors no PLC signals — neither does the browser demo it mirrors — so this
    // is a shape gate rather than a count: a slot is either absent or a resolved address
    // string, never a dangling reference object the reader would silently ignore.
    for (const [name, run] of runs) {
      for (const entry of run.result.registry.getAll<RVRibbonWinder>('RibbonWinder')) {
        for (const slot of ['DiameterMm', 'WoundLengthMm', 'Empty', 'Full'] as const) {
          const value = entry.instance[slot];
          if (value === null || value === undefined) continue;
          expect(typeof value, `${name}/${entry.instance.node.name}.${slot}`).toBe('string');
        }
      }

      for (const entry of run.result.registry.getAll<RVRibbonDancer>('RibbonDancer')) {
        for (const slot of ['PositionMm', 'AtMin', 'AtMax'] as const) {
          const value = entry.instance[slot];
          if (value === null || value === undefined) continue;
          expect(typeof value, `${name}/${entry.instance.node.name}.${slot}`).toBe('string');
        }
      }
    }
  });
});
