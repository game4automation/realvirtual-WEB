// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../../src/core/engine/rv-aabb';
import { RVSource } from '../../src/core/engine/rv-source';
import { RVSink } from '../../src/core/engine/rv-sink';
import { RVTransportSurface } from '../../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { RVDrive } from '../../src/core/engine/rv-drive';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { progressNodeId } from '../../src/core/diagnostics/rv-population-sources';

export function conveyorLineFixture(opts: {
  expectFlow?: (sink: RVSink) => boolean;
  secondLine?: boolean;
  DeleteMus?: boolean;
  lineBudget?: Record<string, unknown>;
  sourceSignal?: boolean;
  accumulation?: boolean;
} = {}) {
  const scene = new Scene();
  const manager = new RVTransportManager();
  manager.scene = scene;
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const context = { scene, root: scene, registry, signalStore, transportManager: manager };
  const geometry = new BoxGeometry(0.08, 0.08, 0.08);
  const material = new MeshBasicMaterial();
  const lines: {
    source: RVSource; sink: RVSink; surfaces: RVTransportSurface[];
    drive: { currentSpeed: number; isRunning: boolean; jogForward: boolean; jogBackward: boolean };
  }[] = [];
  for (let i = 0; i < (opts.secondLine ? 2 : 1); i++) {
    const root = new Object3D();
    root.name = `Line${i + 1}`;
    if (i === 0 && opts.lineBudget) root.userData.realvirtual = { BlockageBudget: opts.lineBudget };
    scene.add(root);
    const drive = { currentSpeed: 1000, isRunning: true, jogForward: false, jogBackward: false };
    const surfaces: RVTransportSurface[] = [];
    for (let j = 0; j < 2; j++) {
      const node = new Object3D();
      node.name = `Belt${j + 1}`;
      node.position.set(j + 0.5, 0, i * 3);
      root.add(node);
      const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(0.5, 0.1, 0.3)));
      surface.TransportDirection.set(1, 0, 0);
      surface.Accumulate = opts.accumulation ?? false;
      surface.drive = drive as unknown as RVDrive;
      surface.init(context);
      surfaces.push(surface);
    }
    const sourceNode = new Object3D();
    sourceNode.name = 'Source';
    sourceNode.position.set(0.15, 0.1, i * 3);
    // Two meshes force normal clone MUs, without an instancing/render backend.
    sourceNode.add(new Mesh(geometry, material), new Mesh(geometry, material));
    root.add(sourceNode);
    const source = new RVSource(sourceNode);
    source.sourceIsTemplate = true;
    source.spawnMode = 'Interval';
    source.spawnInterval = 1;
    if (opts.sourceSignal) {
      signalStore.register('Generate', 'Generate', false, 'PLCOutputBool');
      source.SourceGenerate = 'Generate';
      source.spawnMode = 'OnSignal';
    }
    source.init(context);
    const sinkNode = new Object3D();
    sinkNode.name = 'Sink';
    sinkNode.position.set(1.85, 0, i * 3);
    root.add(sinkNode);
    const sink = new RVSink(sinkNode, AABB.fromHalfSize(sinkNode, new Vector3(0.1, 0.3, 0.3)));
    sink.DeleteMus = opts.DeleteMus ?? true;
    sink.init(context);
    lines.push({ source, sink, surfaces, drive });
  }
  let now = 0;
  let running = true;
  const budgets = new BudgetResolver({ readSignal: ref => {
    const path = (ref as { path?: string })?.path;
    return path ? signalStore.getBoolByPath(path) : false;
  }, nodeForUnit: id => {
    for (const line of lines) {
      if (progressNodeId(line.sink.node, 'sink') === id) return line.sink.node;
      for (const surface of line.surfaces) if (progressNodeId(surface.node, 'surface') === id) return surface.node;
    }
    return null;
  } });
  const wiring = new ProgressWiring({ clock: { now: () => now }, fleet: { all: () => [] },
    transport: manager, running: () => running, expectFlow: opts.expectFlow ?? budgets.expectFlow });
  return {
    manager, lines, wiring, signalStore,
    checkerContext: () => ({ ledger: wiring.ledger, registry: wiring.waitRegistry, budgets, now }),
    run(seconds: number) {
      for (let tick = 0; tick < Math.round(seconds * 60); tick++) {
        now += 1 / 60;
        manager.update(1 / 60);
        wiring.fixedStep();
      }
    },
    jam() { lines[0].drive.currentSpeed = 0; lines[0].drive.isRunning = false; },
    jamAccumulation() {
      // Keep the upstream surface running into a parked MU just across the seam.
      const line = lines[0];
      line.source.spawnInterval = 10000;
      const leader = manager.mus.reduce((a, b) => a.aabb.center.x > b.aabb.center.x ? a : b);
      const position = leader.getPosition().clone();
      position.x = 1.04;
      leader.setPosition(position);
      leader.updateAABB();
      leader.currentSurface = line.surfaces[1];
      line.surfaces[1].drive = { ...line.drive, currentSpeed: 0, isRunning: false } as unknown as RVDrive;
    },
    setRunning(value: boolean) { running = value; },
    dispose() {
      wiring.dispose();
      manager.reset(true);
      for (const line of lines) { line.sink.dispose(); for (const surface of line.surfaces) surface.dispose(); }
      geometry.dispose();
      material.dispose();
    },
  };
}
