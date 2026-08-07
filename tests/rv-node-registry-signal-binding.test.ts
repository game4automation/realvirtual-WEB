// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-registry-signal-binding — plan-234 Phase 2 (§10-A / §10-E).
 *
 * Verifies `NodeRegistry.getComponentsForSignal(name, signalPath?)`:
 *   1. String-field binding  — a component field whose value is a signal name
 *      (e.g. WebSensor.SignalBool = "SigA") resolves that node as a consumer.
 *   2. Parent-walk           — a signal materialised as a child node
 *      (`Drive1/Signals/Forward`) resolves the nearest owning non-signal
 *      component (Drive1) when `signalPath` is supplied.
 *   3. Empty case            — a signal with no consumer and no node → `[]`
 *      (and undefined signalPath + no string hit → `[]`), never a crash.
 *   4. Multi-owner + dedup + ordering — nearest owner first, no duplicates.
 *   5. Invalidation          — clear() / recomputePathsForSubtrees() drop stale
 *      bindings; the index rebuilds lazily.
 *
 * Synthetic fixtures only — plain Object3D + registerNode + userData.realvirtual,
 * mirroring signal-badge-controller / signal-hierarchy-parity. No GLB needed.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * A node carrying rv_extras components; registered under `path`.
 *
 * Mirrors the real two-phase loader: `registerNode` (Phase 1) PLUS a typed
 * `register(type, path, {})` per component (Phase 2) so `getComponentTypes(path)`
 * — which the parent-walk relies on — returns the component types.
 */
function makeNode(
  registry: NodeRegistry,
  parent: Object3D | null,
  name: string,
  path: string,
  realvirtual?: Record<string, unknown>,
): Object3D {
  const node = new Object3D();
  node.name = name;
  if (parent) parent.add(node);
  if (realvirtual) {
    node.userData.realvirtual = realvirtual;
    for (const [type, data] of Object.entries(realvirtual)) {
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        registry.register(type, path, {});
      }
    }
  }
  registry.registerNode(path, node);
  return node;
}

/** A root under a scene root so computeNodePath()/parent walk have a real chain. */
function makeSceneRoot(): Object3D {
  const scene = new Object3D();
  scene.name = 'Scene';
  return scene;
}

// ── 1. String-field binding ──────────────────────────────────────────────────

describe('getComponentsForSignal — string-field binding', () => {
  it('resolves a WebSensor whose SignalBool string equals the signal name', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    makeNode(reg, scene, 'EndStop', 'Conveyor01/EndStop', {
      WebSensor: { SignalBool: 'SigA', Label: 'End stop' },
    });

    const refs = reg.getComponentsForSignal('SigA');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      sourcePath: 'Conveyor01/EndStop',
      componentType: 'WebSensor',
      fieldName: 'SignalBool',
    });
  });

  it('does not match ComponentReference objects (those are getReferencesTo territory)', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    makeNode(reg, scene, 'EndStop', 'Conveyor01/EndStop', {
      WebSensor: {
        // Raw ComponentReference object — must NOT be indexed as a string binding.
        SignalBool: { type: 'ComponentReference', path: 'Cell/Signals/SigA', componentType: 'PLCOutputBool' },
      },
    });

    expect(reg.getComponentsForSignal('SigA')).toEqual([]);
    expect(reg.getComponentsForSignal('Cell/Signals/SigA')).toEqual([]);
  });
});

// ── 2. Parent-walk ───────────────────────────────────────────────────────────

describe('getComponentsForSignal — parent-walk owner', () => {
  it('resolves the owning Drive for a <Drive>/Signals/* child signal node', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    const drive = makeNode(reg, scene, 'Drive1', 'Drive1', { Drive: { Direction: 'LinearX' } });
    const signals = makeNode(reg, drive, 'Signals', 'Drive1/Signals');
    makeNode(reg, signals, 'Forward', 'Drive1/Signals/Forward', {
      PLCInputBool: { Name: 'Drive1.Forward' },
    });

    const refs = reg.getComponentsForSignal('Drive1.Forward', 'Drive1/Signals/Forward');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      sourcePath: 'Drive1',
      componentType: 'Drive',
      fieldName: 'Signals',
    });
  });

  it('climbs past nodes with only signal components to the first non-signal owner', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    const drive = makeNode(reg, scene, 'Drive1', 'Drive1', { Drive: {} });
    // The container node itself has no component; the signal node has only a PLC type.
    const signals = makeNode(reg, drive, 'Signals', 'Drive1/Signals');
    makeNode(reg, signals, 'Ready', 'Drive1/Signals/Ready', {
      PLCOutputBool: { Name: 'Drive1.Ready' },
    });

    const refs = reg.getComponentsForSignal('Drive1.Ready', 'Drive1/Signals/Ready');
    expect(refs.map((r) => r.sourcePath)).toEqual(['Drive1']);
  });

  it('ignores parent-walk when no signalPath is supplied', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    const drive = makeNode(reg, scene, 'Drive1', 'Drive1', { Drive: {} });
    const signals = makeNode(reg, drive, 'Signals', 'Drive1/Signals');
    makeNode(reg, signals, 'Forward', 'Drive1/Signals/Forward', { PLCInputBool: {} });

    // No string binding + no signalPath → nothing to walk from.
    expect(reg.getComponentsForSignal('Drive1.Forward')).toEqual([]);
  });
});

// ── 3. Empty case (§10-G) ────────────────────────────────────────────────────

describe('getComponentsForSignal — empty / orphaned signals', () => {
  it('returns [] for a signal with no node and no consumer (no crash)', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    makeNode(reg, scene, 'Box', 'Box', { LayoutObject: { Label: 'Box' } });

    expect(reg.getComponentsForSignal('MC01_orphan')).toEqual([]);
    // Even with a signalPath pointing at nothing registered → still [].
    expect(reg.getComponentsForSignal('MC01_orphan', '__iface__/MC01_orphan')).toEqual([]);
  });

  it('returns [] on a completely empty registry', () => {
    const reg = new NodeRegistry();
    expect(reg.getComponentsForSignal('Whatever')).toEqual([]);
    expect(reg.getComponentsForSignal('Whatever', 'Nowhere/Whatever')).toEqual([]);
  });
});

// ── 4. Multi-owner + dedup + ordering ────────────────────────────────────────

describe('getComponentsForSignal — multi-owner, dedup, ordering', () => {
  it('returns every string-field consumer, deduplicated', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    makeNode(reg, scene, 'SensorA', 'Line/SensorA', { WebSensor: { SignalBool: 'Shared' } });
    makeNode(reg, scene, 'SensorB', 'Line/SensorB', { WebSensor: { SignalBool: 'Shared' } });
    // A ConnectSignal that ALSO references the same signal name by string.
    makeNode(reg, scene, 'Bridge', 'Line/Bridge', { ConnectSignal: { ConnectedSignal: 'Shared' } });

    const refs = reg.getComponentsForSignal('Shared');
    const paths = refs.map((r) => r.sourcePath).sort();
    expect(paths).toEqual(['Line/Bridge', 'Line/SensorA', 'Line/SensorB']);
    // No duplicate entries.
    const keys = refs.map((r) => `${r.sourcePath}|${r.componentType}|${r.fieldName}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('orders the nearest owner first (parent-walk owner before a far string consumer)', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();

    // Nearest: the owning Drive of the signal node (distance 1 in the chain).
    const drive = makeNode(reg, scene, 'Drive1', 'Drive1', { Drive: {} });
    const signals = makeNode(reg, drive, 'Signals', 'Drive1/Signals');
    makeNode(reg, signals, 'Pos', 'Drive1/Signals/Pos', { PLCOutputFloat: { Name: 'Drive1.Pos' } });

    // Far consumer: a WebSensor elsewhere references the same signal NAME by string.
    makeNode(reg, scene, 'FarSensor', 'OtherArea/FarSensor', { WebSensor: { SignalBool: 'Drive1.Pos' } });

    const refs = reg.getComponentsForSignal('Drive1.Pos', 'Drive1/Signals/Pos');
    // Both owners present; nearest (Drive1, parent-walk) first.
    expect(refs).toHaveLength(2);
    expect(refs[0].sourcePath).toBe('Drive1');
    expect(refs.map((r) => r.sourcePath)).toContain('OtherArea/FarSensor');
  });

  it('does not double-count when parent-walk and index resolve the same owner', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    // A Drive whose OWN field also names the signal by string, AND the signal
    // node sits under it — both mechanisms would report Drive1.
    const drive = makeNode(reg, scene, 'Drive1', 'Drive1', {
      Drive: { Direction: 'LinearX' },
    });
    const signals = makeNode(reg, drive, 'Signals', 'Drive1/Signals');
    makeNode(reg, signals, 'Forward', 'Drive1/Signals/Forward', { PLCInputBool: {} });
    // Give the Drive itself a string field naming the signal.
    (drive.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.ForwardSignal = 'Drive1.Forward';

    const refs = reg.getComponentsForSignal('Drive1.Forward', 'Drive1/Signals/Forward');
    // Drive1 appears once via the string index (fieldName ForwardSignal) and once
    // via parent-walk (fieldName 'Signals') — different fieldNames → two distinct
    // consumer facets, but neither is a duplicate of the other.
    const driveRefs = refs.filter((r) => r.sourcePath === 'Drive1');
    const fields = driveRefs.map((r) => r.fieldName).sort();
    expect(fields).toEqual(['ForwardSignal', 'Signals']);
  });
});

// ── 5. Invalidation (§10-E) ──────────────────────────────────────────────────

describe('getComponentsForSignal — index invalidation', () => {
  it('clear() drops stale bindings and the index rebuilds empty', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    makeNode(reg, scene, 'SensorA', 'Line/SensorA', { WebSensor: { SignalBool: 'SigA' } });

    // Build the index (lazy on first call).
    expect(reg.getComponentsForSignal('SigA')).toHaveLength(1);

    reg.clear();
    // After clear the registry is empty → no stale bindings served.
    expect(reg.getComponentsForSignal('SigA')).toEqual([]);
  });

  it('recomputePathsForSubtrees invalidates the index → consumer path updates, no stale binding', () => {
    const reg = new NodeRegistry();
    const scene = makeSceneRoot();
    // Chain: Scene → Line → Sensor. Sensor binds SigA by string.
    const line = new Object3D();
    line.name = 'Line';
    scene.add(line);
    reg.registerNode('Line', line);
    makeNode(reg, line, 'Sensor', 'Line/Sensor', { WebSensor: { SignalBool: 'SigA' } });

    // First lookup builds the index → consumer path is the current one.
    expect(reg.getComponentsForSignal('SigA')[0].sourcePath).toBe('Line/Sensor');

    // Rename the mid-level node so the consumer's computed path changes.
    line.name = 'Line_2';
    const { count } = reg.recomputePathsForSubtrees([scene]);
    expect(count).toBeGreaterThan(0); // paths actually moved → index invalidated

    // Rebuild (lazy) serves the NEW consumer path — no stale 'Line/Sensor'.
    const refs = reg.getComponentsForSignal('SigA');
    expect(refs).toHaveLength(1);
    expect(refs[0].sourcePath).toBe('Line_2/Sensor');
  });
});
