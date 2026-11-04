// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 Phase 1 — a SignalConnector on an ASSET ROOT, the asset placed twice:
 *
 *  - `carriesToPlacementRoot` brings the connector onto each placement root
 *    (without it the root block is lost on placing, Review R2 finding 2);
 *  - the two connectors have two instance addresses and two writer ids
 *    (node-identity rule 5, RR2);
 *  - authored PLC signals keep their NAMES inside placements (node-identity
 *    rule 10, `signal-name-collision`): both placements' `Rob_Ready` are ONE
 *    store signal, so two enabled connectors on it are a real fan-in and are
 *    reported as such. Disabling one releases the other, which then writes
 *    under ITS instance writer id;
 *  - a reload of the document gives the same picture.
 *
 * The save round trip of a planner document needs the Phase 2 commands to author
 * the connector in the document; here the asset carries it (open point, Phase 2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { RVSignalConnector, SIGNAL_CONNECTOR_PROBLEM_CODES } from '../src/core/engine/rv-signal-connector';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { bootRealLoaderViewer, dataUrlOf, referenceNode, type Booted } from './helpers/nested-placement-fixture';

beforeEach(() => { resetSlotAuthority(); resetProblemsForTests(); });

let booted: Booted | null = null;
afterEach(() => {
  booted?.h.dispose();
  booted = null;
  resetSlotAuthority();
  resetProblemsForTests();
});

function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

const ref = (path: string) => ({ type: 'ComponentReference', path });

/** Robot asset: the connector sits on the asset root; Signals/RobotReady → Signals/Rob_Ready. */
async function robotAssetUrl(): Promise<string> {
  const root = new Group();
  root.name = 'Robot';
  root.userData.realvirtual = {
    SignalConnector: { Mode: 'Copy', SourceBool: ref('Signals/RobotReady'), TargetBool: ref('Signals/Rob_Ready') },
  };
  const body = new Mesh(new BoxGeometry(0.5, 1, 0.5), new MeshStandardMaterial({ color: 0xcc6633 }));
  body.name = 'Body';
  root.add(body);
  const signals = child(root, 'Signals');
  child(signals, 'RobotReady', { PLCOutputBool: { Name: 'RobotReady', Status: { Value: false } } });
  child(signals, 'Rob_Ready', { PLCInputBool: { Name: 'Rob_Ready', Status: { Value: false } } });
  return dataUrlOf(await objectToGlb(root));
}

async function layoutBytes(assetUrl: string): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  root.add(referenceNode('Robot_1', 'nid-robot-1', assetUrl, true, [0, 0, 0], 'cat:robot'));
  root.add(referenceNode('Robot_2', 'nid-robot-2', assetUrl, true, [3, 0, 0], 'cat:robot'));
  return objectToGlb(root);
}

function connectors(b: Booted): RVSignalConnector[] {
  const viewer = b.h.viewer;
  const registry = viewer.registry!;
  const out: RVSignalConnector[] = [];
  viewer.scene.traverse((node) => {
    const path = registry.getPathForNode(node);
    if (!path) return;
    for (const [type, inst] of registry.getComponentsAt(path) ?? []) {
      if (type === 'SignalConnector' && inst instanceof RVSignalConnector && !out.includes(inst)) out.push(inst);
    }
  });
  return out.sort((x, y) => x.nodePath.localeCompare(y.nodePath));
}

function checkPlacedConnectors(b: Booted): void {
  const store = b.h.viewer.signalStore!;
  const list = connectors(b);
  expect(list).toHaveLength(2);
  const [a, c] = list;
  expect(a.nodePath).toMatch(/Robot_1$/);
  expect(c.nodePath).toMatch(/Robot_2$/);
  expect(a.instanceAddress).toBe('#nid-robot-1');
  expect(c.instanceAddress).toBe('#nid-robot-2');
  for (const k of list) {
    expect(typeof k.SourceBool).toBe('string');
    expect(typeof k.TargetBool).toBe('string');
  }

  // Shared PLC names → both connectors write the SAME store signal: fan-in.
  expect(store.nameForPath(a.TargetBool!)).toBe(store.nameForPath(c.TargetBool!));
  const fanIn = getProblems().filter((p) => p.code === SIGNAL_CONNECTOR_PROBLEM_CODES.fanIn);
  expect(fanIn).toHaveLength(2);
  expect(fanIn[0].detail).toContain('Robot_1');
  expect(fanIn[0].detail).toContain('Robot_2');
  expect(a.isActive).toBe(false);
  expect(c.isActive).toBe(false);

  // Disable the second: the first writes, under ITS instance writer id.
  const data = (c.node.userData.realvirtual as Record<string, Record<string, unknown>>).SignalConnector;
  data.Enabled = false;
  c.Enabled = false;
  c.reapplyConfig();
  expect(a.isActive).toBe(true);
  store.resetWriterInventory();
  store.setByPath(a.SourceBool!, true);
  expect(store.getByPath(a.TargetBool!)).toBe(true);
  const writers = store.getWriterInventory()
    .filter((e) => e.writerId.startsWith('component:SignalConnector:'))
    .map((e) => e.writerId);
  expect(writers).toEqual(['component:SignalConnector:#nid-robot-1']);
}

describe('SignalConnector on an asset root, placed twice', () => {
  it('both placements carry a connector with own address and writer; shared PLC names are fan-in; a reload keeps it', async () => {
    const assetUrl = await robotAssetUrl();
    const doc = await layoutBytes(assetUrl);
    booted = await bootRealLoaderViewer();
    const viewer = booted.h.viewer;

    await viewer.loadModel('layout.glb', { data: doc.slice(0) });
    await viewer.whenSceneReady();
    checkPlacedConnectors(booted);

    resetProblemsForTests();
    await viewer.loadModel('layout.glb', { data: doc.slice(0) });
    await viewer.whenSceneReady();
    checkPlacedConnectors(booted);
  }, 60_000);
});
