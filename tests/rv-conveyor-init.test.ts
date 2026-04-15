// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Integration test: Drive_Simple → signal → jogForward → TransportSurface init
 *
 * Reproduces the exact loading flow for a conveyor with Drive_Simple behavior
 * wired to a PLCOutputBool signal, verifying the two-step init model correctly
 * sets jogForward=true and produces non-zero currentSpeed after drive.update().
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveSimple } from '../src/core/engine/rv-drive-simple';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { AABB } from '../src/core/engine/rv-aabb';
import { applySchema, resolveComponentRefs } from '../src/core/engine/rv-component-registry';
import type { ComponentContext, RVComponent } from '../src/core/engine/rv-component-registry';
import type { ComponentRef } from '../src/core/engine/rv-node-registry';

// ─── Helpers ──────────────────────────────────────────────────────

/** Build a minimal hierarchy matching the GLB structure:
 *   Scene
 *     └── Root
 *           ├── Signals
 *           │     └── EntryConveyorStart   (PLCOutputBool, value=true)
 *           └── ConveyorEntry1             (Drive + Drive_Simple)
 *                 └── Conveyor
 *                       └── Conveyor       (TransportSurface)
 */
function buildTestScene() {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Root'; scene.add(root);

  const signals = new Object3D(); signals.name = 'Signals'; root.add(signals);
  const signalNode = new Object3D(); signalNode.name = 'EntryConveyorStart'; signals.add(signalNode);

  const conveyor1 = new Object3D(); conveyor1.name = 'ConveyorEntry1'; root.add(conveyor1);
  const mid = new Object3D(); mid.name = 'Conveyor'; conveyor1.add(mid);
  const tsNode = new Object3D(); tsNode.name = 'Conveyor'; mid.add(tsNode);

  return { scene, root, signalNode, conveyor1, tsNode };
}

/** Simulate the scene loader's two-step init for a conveyor. */
function simulateConveyorLoading(opts: { signalValue: boolean }) {
  const { scene, root, signalNode, conveyor1, tsNode } = buildTestScene();
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const manager = new RVTransportManager();
  manager.scene = scene;

  // ══════ STEP 1 "Awake" ══════

  // Register all nodes
  scene.traverse((node) => {
    if (!node.parent) return; // skip scene root
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);
  });

  // Register signal (mimics scene loader signal registration)
  const signalPath = NodeRegistry.computeNodePath(signalNode);
  signalStore.register('EntryConveyorStart', signalPath, opts.signalValue);
  registry.register('PLCOutputBool', signalPath, { address: signalPath, signalName: 'EntryConveyorStart' });

  // Create Drive on ConveyorEntry1
  const drivePath = NodeRegistry.computeNodePath(conveyor1);
  const drive = new RVDrive(conveyor1);
  const driveExtras = { Direction: 'LinearX', TargetSpeed: 200 };
  applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, driveExtras);
  drive.initDrive();
  registry.register('Drive', drivePath, drive);

  // Create Drive_Simple on same node
  const driveSimple = new RVDriveSimple(conveyor1);
  const driveSimpleExtras: Record<string, unknown> = {
    Forward: {
      type: 'ComponentReference',
      path: signalPath,  // Use the exact registered path
      componentType: 'realvirtual.PLCOutputBool',
    } as ComponentRef,
  };
  applySchema(driveSimple as unknown as Record<string, unknown>, RVDriveSimple.schema, driveSimpleExtras);

  // Create TransportSurface on grandchild
  const tsPath = NodeRegistry.computeNodePath(tsNode);
  const aabb = AABB.fromHalfSize(tsNode, new Vector3(1, 0.1, 0.5));
  const surface = new RVTransportSurface(tsNode, aabb);
  const tsExtras = { TransportDirection: { x: 1, y: 0, z: 0 } };
  surface.rawLocalDir = { x: 1, y: 0, z: 0 };
  applySchema(surface as unknown as Record<string, unknown>, RVTransportSurface.schema, tsExtras);
  registry.register('TransportSurface', tsPath, surface);

  // Build pending array (same order as DFS in scene loader)
  const pending: { component: RVComponent; type: string; path: string }[] = [
    { component: driveSimple, type: 'Drive_Simple', path: drivePath },
    { component: surface, type: 'TransportSurface', path: tsPath },
  ];

  // ══════ STEP 2 "Start" ══════
  const context: ComponentContext = { registry, signalStore, scene, transportManager: manager, root };

  for (const { component } of pending) {
    resolveComponentRefs(component as unknown as Record<string, unknown>, registry);
    component.init(context);
  }

  return { drive, driveSimple, surface, signalStore, manager };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Conveyor init flow (Drive_Simple → signal → TransportSurface)', () => {
  it('should wire Forward signal and set jogForward=true when signal is true', () => {
    const { drive, driveSimple } = simulateConveyorLoading({ signalValue: true });

    // Drive_Simple should have resolved Forward to a signal address string
    expect(typeof driveSimple.Forward).toBe('string');
    expect(driveSimple.Forward).not.toBeNull();

    // Drive should have jogForward=true (from signal value)
    expect(drive.jogForward).toBe(true);
  });

  it('should auto-start when signal is false (fallback)', () => {
    const { drive } = simulateConveyorLoading({ signalValue: false });

    // Auto-start in TransportSurface.init() should set jogForward=true
    // even when signal is false
    expect(drive.jogForward).toBe(true);
  });

  it('should have non-zero currentSpeed after first drive update', () => {
    const { drive } = simulateConveyorLoading({ signalValue: true });

    // Simulate one frame
    drive.update(1 / 60);

    expect(drive.jogForward).toBe(true);
    expect(drive.currentSpeed).toBe(200); // TargetSpeed
    expect(drive.isRunning).toBe(true);
  });

  it('should have active transport surface after init', () => {
    const { drive, surface } = simulateConveyorLoading({ signalValue: true });

    // After one update tick, surface should be active
    drive.update(1 / 60);

    expect(surface.drive).toBe(drive);
    expect(surface.speed).toBe(200);
    expect(surface.isActive).toBe(true);
  });

  it('should NOT be idle when jogForward=true', () => {
    const { drive } = simulateConveyorLoading({ signalValue: true });

    expect(drive.isIdle).toBe(false);
  });

  it('should handle ComponentRef with mismatched path (suffix resolution)', () => {
    // Test with a ComponentRef path that uses a shorter/different prefix
    const { scene, root, signalNode, conveyor1, tsNode } = buildTestScene();
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const manager = new RVTransportManager();
    manager.scene = scene;

    scene.traverse((node) => {
      if (!node.parent) return;
      registry.registerNode(NodeRegistry.computeNodePath(node), node);
    });

    const signalPath = NodeRegistry.computeNodePath(signalNode);
    signalStore.register('EntryConveyorStart', signalPath, true);
    registry.register('PLCOutputBool', signalPath, { address: signalPath, signalName: 'EntryConveyorStart' });

    const drivePath = NodeRegistry.computeNodePath(conveyor1);
    const drive = new RVDrive(conveyor1);
    applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, { Direction: 'LinearX', TargetSpeed: 200 });
    drive.initDrive();
    registry.register('Drive', drivePath, drive);

    // Use a SHORTENED path in the ComponentRef (like C# export might do)
    const driveSimple = new RVDriveSimple(conveyor1);
    applySchema(driveSimple as unknown as Record<string, unknown>, RVDriveSimple.schema, {
      Forward: {
        type: 'ComponentReference',
        path: 'Signals/EntryConveyorStart',  // Shorter path (no Root prefix)
        componentType: 'realvirtual.PLCOutputBool',
      },
    });

    resolveComponentRefs(driveSimple as unknown as Record<string, unknown>, registry);
    const context: ComponentContext = { registry, signalStore, scene, transportManager: manager, root };
    driveSimple.init(context);

    // Forward should still resolve via suffix matching
    expect(typeof driveSimple.Forward).toBe('string');
    expect(drive.jogForward).toBe(true);
  });
});

// ─── Real GLB Path Test ──────────────────────────────────────────

describe('Conveyor init with actual GLB path structure', () => {
  /** Build hierarchy matching actual demo.glb structure:
   *   Scene
   *     └── demoglb                              (Three.js root from "demo.glb")
   *           └── DemoCell
   *                 ├── PLCInterface
   *                 │     └── --- Entry and Exit Conveyor  ----
   *                 │           └── EntryConveyorStart     (PLCOutputBool, value=true)
   *                 └── Conveyors
   *                       └── ConveyorEntry1              (Drive + Drive_Simple)
   *                             └── Conveyor
   *                                   └── Conveyor_1      (TransportSurface, renamed by Three.js)
   */
  function buildRealScene() {
    const scene = new Scene();
    const demoglb = new Object3D(); demoglb.name = 'demoglb'; scene.add(demoglb);
    const demoCell = new Object3D(); demoCell.name = 'DemoCell'; demoglb.add(demoCell);

    // Signal hierarchy with special chars
    const plcInterface = new Object3D(); plcInterface.name = 'PLCInterface'; demoCell.add(plcInterface);
    const entryFolder = new Object3D(); entryFolder.name = '--- Entry and Exit Conveyor  ----'; plcInterface.add(entryFolder);
    const signalNode = new Object3D(); signalNode.name = 'EntryConveyorStart'; entryFolder.add(signalNode);

    // Conveyor hierarchy
    const conveyors = new Object3D(); conveyors.name = 'Conveyors'; demoCell.add(conveyors);
    const conveyor1 = new Object3D(); conveyor1.name = 'ConveyorEntry1'; conveyors.add(conveyor1);
    const mid = new Object3D(); mid.name = 'Conveyor'; conveyor1.add(mid);
    const tsNode = new Object3D(); tsNode.name = 'Conveyor_1'; mid.add(tsNode); // Three.js renamed from "Conveyor"

    return { scene, demoglb, signalNode, conveyor1, tsNode };
  }

  it('should resolve ComponentRef with Unity path through demoglb prefix and special chars', () => {
    const { scene, demoglb, signalNode, conveyor1, tsNode } = buildRealScene();
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const manager = new RVTransportManager();
    manager.scene = scene;

    // Register ALL nodes (like the scene loader does)
    scene.traverse((node) => {
      if (!node.parent) return;
      registry.registerNode(NodeRegistry.computeNodePath(node), node);
    });

    // Register signal
    const signalPath = NodeRegistry.computeNodePath(signalNode);
    expect(signalPath).toBe('demoglb/DemoCell/PLCInterface/--- Entry and Exit Conveyor  ----/EntryConveyorStart');
    signalStore.register('EntryConveyorStart', signalPath, true);
    registry.register('PLCOutputBool', signalPath, { address: signalPath, signalName: 'EntryConveyorStart' });

    // Create Drive
    const drivePath = NodeRegistry.computeNodePath(conveyor1);
    const drive = new RVDrive(conveyor1);
    applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, { Direction: 'LinearX', TargetSpeed: 200 });
    drive.initDrive();
    registry.register('Drive', drivePath, drive);

    // Create Drive_Simple with ACTUAL GLB ComponentRef path (Unity format, no demoglb prefix)
    const driveSimple = new RVDriveSimple(conveyor1);
    applySchema(driveSimple as unknown as Record<string, unknown>, RVDriveSimple.schema, {
      Forward: {
        type: 'ComponentReference',
        path: 'DemoCell/PLCInterface/--- Entry and Exit Conveyor  ----/EntryConveyorStart',
        componentType: 'realvirtual.PLCOutputBool',
      } as ComponentRef,
    });

    // Create TransportSurface
    const tsPath = NodeRegistry.computeNodePath(tsNode);
    const aabb = AABB.fromHalfSize(tsNode, new Vector3(1, 0.1, 0.5));
    const surface = new RVTransportSurface(tsNode, aabb);
    surface.rawLocalDir = { x: 1, y: 0, z: 0 };
    applySchema(surface as unknown as Record<string, unknown>, RVTransportSurface.schema, {
      TransportDirection: { x: 1, y: 0, z: 0 },
    });
    registry.register('TransportSurface', tsPath, surface);

    // Step 2: resolveComponentRefs + init
    const pending: { component: RVComponent; type: string }[] = [
      { component: driveSimple, type: 'Drive_Simple' },
      { component: surface, type: 'TransportSurface' },
    ];

    const context: ComponentContext = { registry, signalStore, scene, transportManager: manager, root: demoglb };
    for (const { component } of pending) {
      resolveComponentRefs(component as unknown as Record<string, unknown>, registry);
      component.init(context);
    }

    // Verify: Forward should be resolved to the full path
    expect(typeof driveSimple.Forward).toBe('string');
    expect(driveSimple.Forward).toContain('EntryConveyorStart');

    // Verify: jogForward should be true (from signal value=true)
    expect(drive.jogForward).toBe(true);

    // Verify: drive update produces speed
    drive.update(1 / 60);
    expect(drive.currentSpeed).toBe(200);
    expect(drive.isRunning).toBe(true);

    // Verify: surface is active
    expect(surface.drive).toBe(drive);
    expect(surface.speed).toBe(200);
    expect(surface.isActive).toBe(true);
  });

  it('should handle signal subscription updates after init', () => {
    const { scene, demoglb, signalNode, conveyor1 } = buildRealScene();
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const manager = new RVTransportManager();
    manager.scene = scene;

    scene.traverse((node) => {
      if (!node.parent) return;
      registry.registerNode(NodeRegistry.computeNodePath(node), node);
    });

    const signalPath = NodeRegistry.computeNodePath(signalNode);
    signalStore.register('EntryConveyorStart', signalPath, true);
    registry.register('PLCOutputBool', signalPath, { address: signalPath, signalName: 'EntryConveyorStart' });

    const drivePath = NodeRegistry.computeNodePath(conveyor1);
    const drive = new RVDrive(conveyor1);
    applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, { Direction: 'LinearX', TargetSpeed: 200 });
    drive.initDrive();
    registry.register('Drive', drivePath, drive);

    const driveSimple = new RVDriveSimple(conveyor1);
    applySchema(driveSimple as unknown as Record<string, unknown>, RVDriveSimple.schema, {
      Forward: {
        type: 'ComponentReference',
        path: 'DemoCell/PLCInterface/--- Entry and Exit Conveyor  ----/EntryConveyorStart',
        componentType: 'realvirtual.PLCOutputBool',
      } as ComponentRef,
    });

    resolveComponentRefs(driveSimple as unknown as Record<string, unknown>, registry);
    const context: ComponentContext = { registry, signalStore, scene, transportManager: manager, root: demoglb };
    driveSimple.init(context);

    expect(drive.jogForward).toBe(true);

    // Simulate signal change via subscription (e.g., LogicStep sets signal to false)
    signalStore.setByPath(signalPath, false);
    expect(drive.jogForward).toBe(false);

    // Set back to true
    signalStore.setByPath(signalPath, true);
    expect(drive.jogForward).toBe(true);
  });
});
