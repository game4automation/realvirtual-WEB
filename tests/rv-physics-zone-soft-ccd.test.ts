// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-zone-soft-ccd.test.ts — plan-2219 Phase 2, test 9.3.
 *
 * `WebPhysicsZone.SoftCcdPrediction` (m, default 0.03, 0 = off) travels the whole data path:
 * rv-ODT schema → zone instance → `toZoneConfig()` → physics plugin → `addZone` → the dynamic
 * body Rapier creates. Covered here:
 *
 *  - the schema default (0.03) on a zone without the field and on the synthetic WholeScene zone;
 *  - a GLB value 0.05 and 0 (saved by the editor, reloaded from the bytes) reaching the body;
 *  - the synthetic zone's default reaching the body;
 *  - the inspector: number editor with unit m, bounds 0 … 0.2, input clamped to them;
 *  - save → reload keeps an edited value.
 *
 * The A3 tunnelling proof itself (300 drops) lives in the Private
 * `tests/rapier-dynamic-soft-ccd.test.ts`. Real Rapier WASM — an unusable provider is a failure.
 *
 * PRIVATE-DEPENDENT (plugin, provider and the editor's add rules are private).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { Box3, Object3D, Scene, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { makeAuthoringRig, rvOf, type AuthoringRig } from './helpers/collider-authoring-rig';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { EventEmitter } from '../src/core/rv-events';
import {
  applySchema, getFieldDescriptor, getRegisteredFactories, type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { physicsRegistry, physicsSettings } from '../src/core/engine/rv-physics-registry';
import { PHYSICS_DEFAULT_SOFT_CCD_PREDICTION_M } from '../src/core/engine/rv-physics-constants';
import { getFieldUnit } from '../src/core/hmi/rv-inspector-helpers';
import { FieldRow } from '../src/core/hmi/rv-field-row';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { addColliderAwareComponent } from '@rv-private/plugins/asset-editor/collider-add-rules';
import { PhysicsZonePlugin } from '@rv-private/plugins/physics-zone-plugin';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';

const Q = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };
const HALF = { x: 0.01, y: 0.01, z: 0.01 };

// ─── Helpers ────────────────────────────────────────────────────────────────

const rigs: AuthoringRig[] = [];
let provider: RapierPhysicsProvider | null = null;
let plugin: PhysicsZonePlugin | null = null;

beforeEach(() => RVPhysicsZone.clearAll());
afterEach(() => {
  cleanup();
  plugin?.dispose(); plugin = null;
  provider?.dispose(); provider = null;
  for (const r of rigs.splice(0)) r.dispose();
  RVPhysicsZone.clearAll();
  physicsRegistry.register(null);
  physicsSettings.enabled = false;
  vi.restoreAllMocks();
});

function find(root: Object3D, name: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  return hit;
}

/** Build a zone from a node's extras exactly like the scene loader does
 *  (create → beforeSchema → applySchema → init; volume from its BoxCollider). */
function zoneFromNode(node: Object3D): RVPhysicsZone {
  node.updateMatrixWorld(true);
  const rv = rvOf(node);
  const box = rv.BoxCollider as { center: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } };
  const f = getRegisteredFactories().get('WebPhysicsZone')!;
  const zone = f.create(node, AABB.fromBoxCollider(node, box.center, box.size)) as RVPhysicsZone;
  f.beforeSchema?.(zone, rv.WebPhysicsZone);
  applySchema(zone as unknown as Record<string, unknown>, f.schema, rv.WebPhysicsZone);
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
  return zone;
}

/** Author a zone in the editor, set SoftCcdPrediction (or leave it), save, reload the bytes. */
async function savedAndReloaded(value: number | undefined): Promise<{ station: Object3D; rig: AuthoringRig }> {
  const r = makeAuthoringRig();
  rigs.push(r);
  r.addNode('Station');
  await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'WebPhysicsZone');
  if (value !== undefined) {
    const before = rvOf(r.registry.getNode('Asset/Station')).WebPhysicsZone.SoftCcdPrediction;
    r.doc.setField('Asset/Station', 'WebPhysicsZone', 'SoftCcdPrediction', value, before);
    await r.doc.whenIdle();
  }
  const glb = await exportAssetGlb(r.root, 'Asset');
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  const station = find(gltf.scene, 'Station')!;
  expect(station, 'Station node in the reloaded GLB').toBeTruthy();
  RVPhysicsZone.clearAll(); // the rig's live zone must not take the F2 slot
  return { station, rig: r };
}

/** Run the physics plugin's model load over the currently registered zones; returns the
 *  soft-CCD prediction of a dynamic MU created inside the world afterwards. */
async function softCcdOfNewMU(at = { x: 0, y: 0, z: 0 }): Promise<number> {
  provider = new RapierPhysicsProvider();
  await provider.init();
  expect(provider.ready, 'Rapier WASM must load').toBe(true);
  physicsRegistry.register(provider);
  physicsSettings.enabled = true;
  physicsSettings.full = false;
  const tm = new RVTransportManager();
  tm.scene = new Scene();
  const emitter = new EventEmitter();
  const viewer = {
    transportManager: tm, registry: { getNode: () => null, storedNode: () => null },
    gizmoManager: undefined, simulationKernel: null, drives: [], getPlugin: () => undefined,
    on: emitter.on.bind(emitter), emit: emitter.emit.bind(emitter),
  } as unknown as RVViewer;
  const result = {
    root: new Object3D(), boundingBox: new Box3(new Vector3(-5, -1, -5), new Vector3(5, 5, 5)),
    transportManager: tm, registry: { getNode: () => null, storedNode: () => null }, drives: [],
  } as unknown as LoadResult;
  plugin = new PhysicsZonePlugin();
  plugin.onModelLoaded(result, viewer);
  await plugin.buildPromise;
  provider.addDynamicMU('probe', { pos: at, quat: Q }, HALF, ZERO, 0.02);
  const body = (provider as unknown as { bodyMap: Map<string, { body: { softCcdPrediction(): number } }> })
    .bodyMap.get('probe')?.body;
  expect(body, 'probe MU became a dynamic body').toBeTruthy();
  return body!.softCcdPrediction();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('WebPhysicsZone.SoftCcdPrediction (plan-2219)', () => {
  it('defaults to 0.03 m on a zone without the field and on the synthetic zone', () => {
    expect(PHYSICS_DEFAULT_SOFT_CCD_PREDICTION_M).toBe(0.03);
    const node = new Object3D();
    node.name = 'Zone';
    node.userData.realvirtual = { WebPhysicsZone: {}, BoxCollider: { center: ZERO, size: { x: 1, y: 1, z: 1 } } };
    const zone = zoneFromNode(node);
    expect(zone.SoftCcdPrediction).toBe(0.03);
    expect(zone.toZoneConfig().softCcdPrediction).toBe(0.03);
    RVPhysicsZone.clearAll();
    expect(RVPhysicsZone.createSynthetic().toZoneConfig().softCcdPrediction).toBe(0.03);
    expect(RVPhysicsZone.createSynthetic({ softCcdPrediction: 0 }).SoftCcdPrediction).toBe(0);
  });

  it.each([
    ['0.05 m', 0.05, 0.05, 0.05],
    ['0 (off)', 0, 0, 0],
    ['absent (default)', undefined, 0.03, 0.03],
    // Above the schema maximum (hand-edited GLB / script): stored as is, clamped at the provider.
    ['0.5 m (above max)', 0.5, 0.5, 0.2],
  ] as const)('a saved GLB value %s reaches the dynamic body', async (_label, value, expected, bodyExpected) => {
    const { station } = await savedAndReloaded(value);
    const stored = rvOf(station).WebPhysicsZone.SoftCcdPrediction;
    if (value === undefined) expect(stored === undefined || stored === 0.03).toBe(true);
    else expect(stored).toBe(value);
    const zone = zoneFromNode(station);
    expect(zone.SoftCcdPrediction).toBe(expected);
    const centre = zone.worldAabb!;
    const at = { x: (centre.min.x + centre.max.x) / 2, y: (centre.min.y + centre.max.y) / 2, z: (centre.min.z + centre.max.z) / 2 };
    expect(await softCcdOfNewMU(at)).toBeCloseTo(bodyExpected, 6);
  });

  it('the synthetic WholeScene zone hands the default to the dynamic body', async () => {
    expect(RVPhysicsZone.zones).toHaveLength(0);
    expect(await softCcdOfNewMU()).toBeCloseTo(0.03, 6);
    expect(RVPhysicsZone.zones.some((z) => z.WholeScene)).toBe(true);
  });

  it('save → reload keeps an edited value; the live instance follows the edit', async () => {
    const r = makeAuthoringRig();
    rigs.push(r);
    r.addNode('Station');
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Station', 'WebPhysicsZone');
    const live = r.registry.getByPath<RVPhysicsZone>('WebPhysicsZone', 'Asset/Station')!;
    expect(live.SoftCcdPrediction).toBe(0.03);
    r.doc.setField('Asset/Station', 'WebPhysicsZone', 'SoftCcdPrediction', 0.12, 0.03);
    await r.doc.whenIdle();
    expect(rvOf(r.registry.getNode('Asset/Station')).WebPhysicsZone.SoftCcdPrediction).toBe(0.12);
    expect(r.registry.getByPath<RVPhysicsZone>('WebPhysicsZone', 'Asset/Station')!.SoftCcdPrediction).toBe(0.12);

    const glb1 = await exportAssetGlb(r.root, 'Asset');
    const gltf = await new GLTFLoader().parseAsync(glb1, '');
    const station = find(gltf.scene, 'Station')!;
    expect(rvOf(station).WebPhysicsZone.SoftCcdPrediction).toBe(0.12);
    RVPhysicsZone.clearAll();
    expect(zoneFromNode(station).toZoneConfig().softCcdPrediction).toBe(0.12);
  });

  it('inspector: number editor with unit m and bounds 0 … 0.2; input is clamped to them', () => {
    const desc = getFieldDescriptor('WebPhysicsZone', 'SoftCcdPrediction')!;
    expect(desc).toMatchObject({ type: 'number', default: 0.03, unit: 'm', min: 0, max: 0.2 });
    expect(getFieldUnit('WebPhysicsZone', 'SoftCcdPrediction')).toBe('m');
    // Same editor kind as RemoveBelowY: a plain schema number with a unit.
    expect(getFieldDescriptor('WebPhysicsZone', 'RemoveBelowY')).toMatchObject({ type: 'number', unit: 'm' });

    const onEdit = vi.fn();
    render(createElement(FieldRow, {
      fieldName: 'SoftCcdPrediction',
      value: 0.03,
      status: 'consumed',
      isOverridden: false,
      onEdit,
      onReset: () => {},
      viewer: null,
      signalStore: null,
      descriptor: desc,
      unit: getFieldUnit('WebPhysicsZone', 'SoftCcdPrediction'),
      componentType: 'WebPhysicsZone',
    }));
    const range = screen.getByTestId('rv-number-range');
    expect(range.textContent).toMatch(/0.*0\.2/);
    expect(document.body.textContent).toContain('m');
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '0.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenLastCalledWith(0.2);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenLastCalledWith(0);
  });
});
