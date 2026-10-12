// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Synthetic scene for the hierarchy count-walk measurement (plan-597 §9.8).
 *
 * `nodeCount` nodes in a shallow-but-not-flat tree (fan-out 8), 30 % of them
 * carrying 1-3 mixed component types, drawn with a fixed seed so every run —
 * baseline and after — sees the identical type distribution. The types are
 * registered by {@link registerSyntheticTypes}; an unregistered key would be
 * dropped by `extractComponentTypes` before any counting happens, and the
 * measurement would time an empty loop.
 */

import { Group, Object3D, Scene } from 'three';
import { registerCapabilities } from '../../src/core/engine/rv-component-registry';
import { makeRandom } from './seeded-random';

/** The type keys the synthetic scene draws from (registered + rule-classified). */
export const SYNTHETIC_TYPES: readonly string[] = [
  'MeasureDrive', 'MeasureSensor', 'MeasureConveyor', 'MeasureLamp',
  'MeasureButton', 'MeasureRobot', 'MeasurePipe', 'MeasureInfo',
  'PLCOutputBool', 'PLCInputFloat', 'LogicStep_Delay', 'ConnectSignal',
];

/** Register the synthetic types (call in the test setup, not per run). */
export function registerSyntheticTypes(): void {
  const decl: Array<[string, string, string]> = [
    ['MeasureDrive', 'Drives', 'drives'],
    ['MeasureSensor', 'Sensors', 'sensors'],
    ['MeasureConveyor', 'Conveyors', 'transport'],
    ['MeasureLamp', 'Lamps', 'hmi'],
    ['MeasureButton', 'Buttons', 'hmi'],
    ['MeasureRobot', 'Robots', 'robotics'],
    ['MeasurePipe', 'Pipes', 'process'],
    ['MeasureInfo', 'Metadata', 'info'],
  ];
  for (const [type, filter, category] of decl) {
    // `category` is ignored by a registry that does not know the field yet
    // (baseline run), so the SAME setup code runs before and after.
    registerCapabilities(type, { ui: { filter, category } as never });
  }
}

/** Build the seeded synthetic scene. */
export function buildSyntheticTypeScene(nodeCount = 20_000, seed = 597): { scene: Scene; paths: Map<Object3D, string> } {
  const rnd = makeRandom(seed);
  const scene = new Scene();
  const paths = new Map<Object3D, string>();
  const parents: Object3D[] = [scene];
  for (let i = 0; i < nodeCount; i++) {
    const node = new Group();
    node.name = `N${i}`;
    const parent = parents[Math.floor(i / 8)] ?? scene;
    parent.add(node);
    parents.push(node);
    paths.set(node, `${paths.get(parent) ?? 'Root'}/${node.name}`);
    if (rnd() < 0.3) {
      const n = 1 + Math.floor(rnd() * 3);
      const rv: Record<string, unknown> = {};
      for (let k = 0; k < n; k++) {
        rv[SYNTHETIC_TYPES[Math.floor(rnd() * SYNTHETIC_TYPES.length)]!] = {};
      }
      node.userData.realvirtual = rv;
    }
  }
  return { scene, paths };
}
