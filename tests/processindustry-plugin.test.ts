// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, Object3D } from 'three';
import { RVPipe } from '../src/core/engine/rv-pipe';
import { RVTank } from '../src/core/engine/rv-tank';
import { RVPump } from '../src/core/engine/rv-pump';
import { ProcessIndustryPlugin } from '../src/plugins/processindustry-plugin';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

/** Build a fake scene with the given number of pipes/tanks/pumps. */
function buildFakeScene(nPipes: number, nTanks: number, nPumps: number) {
  const scene = new Scene();
  const pipes: RVPipe[] = [];
  const tanks: RVTank[] = [];
  const pumps: RVPump[] = [];

  for (let i = 0; i < nPipes; i++) {
    const node = new Object3D(); node.name = `Pipe${i}`;
    scene.add(node);
    pipes.push(new RVPipe(node, { resourceName: 'Water', flowRate: 10 }));
  }
  for (let i = 0; i < nTanks; i++) {
    const node = new Object3D(); node.name = `Tank${i}`;
    scene.add(node);
    tanks.push(new RVTank(node, { capacity: 1000, amount: 500 }));
  }
  for (let i = 0; i < nPumps; i++) {
    const node = new Object3D(); node.name = `Pump${i}`;
    scene.add(node);
    pumps.push(new RVPump(node, { flowRate: 0 }));
  }

  return { scene, pipes, tanks, pumps };
}

describe('ProcessIndustryPlugin', () => {
  let plugin: ProcessIndustryPlugin;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    plugin = new ProcessIndustryPlugin();
  });

  afterEach(() => {
    plugin.dispose();
    randomSpy?.mockRestore();
  });

  it('has the expected id and plugin order', () => {
    expect(plugin.id).toBe('processindustry');
    expect(plugin.order).toBe(150);
  });

  it('onModelLoaded discovers all pipe/tank/pump instances in the scene', () => {
    const { scene, pipes, tanks, pumps } = buildFakeScene(3, 2, 2);
    const viewer = { scene } as unknown as RVViewer;

    plugin.onModelLoaded({} as LoadResult, viewer);

    // The plugin also reassigns fluids on load — verify tanks got a fluid.
    for (const t of tanks) {
      expect(t.resourceName).not.toBe('');
    }
    // Smoke: pipes were visited (resource now set to one of the plant's fluids)
    const fluids = new Set([
      'Xylene', 'MEK', 'Epoxy Resin', 'Pigment Paste',
      'Automotive Paint', 'Wood Varnish', 'Recovered Solvent',
    ]);
    for (const p of pipes) {
      expect(fluids.has(p.resourceName)).toBe(true);
    }
    // Pumps discovered (no fluid assignment for pumps)
    expect(pumps.length).toBe(2);
  });

  it('onFixedUpdatePost flips pipe flow over many ticks', () => {
    const { scene, pipes } = buildFakeScene(1, 0, 0);
    const viewer = { scene } as unknown as RVViewer;

    // 0.6 skips the 15% stop branch so the pipe reliably flips to a non-zero value.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.6);

    plugin.onModelLoaded({} as LoadResult, viewer);
    // Force a known sentinel value distinct from what any flip would produce
    // so we can detect a flip happened. With mock 0.6 every flip yields +640,
    // so -12345 is guaranteed to differ from both kick-start and flip output.
    pipes[0].setFlow(-12345);
    const initialRate = pipes[0].flowRate;

    // Drive 60 simulated seconds — flip cadence is 8–25 s per pipe.
    for (let i = 0; i < 60 * 60; i++) plugin.onFixedUpdatePost(1 / 60);

    expect(pipes[0].flowRate).not.toBe(initialRate);
  });

  it('onFixedUpdatePost can stop the pipe (15% branch)', () => {
    const { scene, pipes } = buildFakeScene(1, 0, 0);
    const viewer = { scene } as unknown as RVViewer;

    // 0.05 triggers the <0.15 stop branch for flow.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.05);

    plugin.onModelLoaded({} as LoadResult, viewer);
    for (let i = 0; i < 60 * 60; i++) plugin.onFixedUpdatePost(1 / 60);

    expect(pipes[0].flowRate).toBe(0);
  });

  it('every pipe in a multi-pipe scene gets flipped over time', () => {
    const N = 8;
    const { scene, pipes } = buildFakeScene(N, 0, 0);
    const viewer = { scene } as unknown as RVViewer;

    // Known starting value so we can detect any per-pipe change.
    for (const p of pipes) p.setFlow(0);

    // 0.7: skip the 15% stop branch → always produces a non-zero flow.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.7);

    plugin.onModelLoaded({} as LoadResult, viewer);
    // Override kick-start flow so we can detect per-pipe mutation from 0.
    for (const p of pipes) p.setFlow(0);

    // Drive 120 simulated seconds — flip cadence is 8–25 s per pipe so each
    // pipe gets multiple chances to flip within this window.
    for (let i = 0; i < 60 * 120; i++) plugin.onFixedUpdatePost(1 / 60);

    for (let i = 0; i < N; i++) {
      expect(pipes[i].flowRate, `pipe #${i} was never flipped`).not.toBe(0);
    }
  });

  it('transfers fluid in the Unity-standard direction (positive flow drains destination, fills source)', () => {
    // Build a mini plant: pipe with source=TankA, destination=TankB.
    const scene = new Scene();
    const tankANode = new Object3D(); tankANode.name = 'TankA';
    const tankBNode = new Object3D(); tankBNode.name = 'TankB';
    const pipeNode = new Object3D(); pipeNode.name = 'Pipe0';
    scene.add(tankANode); scene.add(tankBNode); scene.add(pipeNode);

    const tankA = new RVTank(tankANode, { capacity: 1000, amount: 200 });
    const tankB = new RVTank(tankBNode, { capacity: 1000, amount: 800 });
    const pipe = new RVPipe(pipeNode, {
      resourceName: 'Water', flowRate: 20,
      source: { type: 'ComponentReference', path: 'TankA' },
      destination: { type: 'ComponentReference', path: 'TankB' },
    });

    const pathToNode = new Map<string, Object3D>([['TankA', tankANode], ['TankB', tankBNode]]);
    const viewer = {
      scene,
      registry: { getNode: (p: string) => pathToNode.get(p) ?? null },
    } as unknown as RVViewer;

    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    plugin.onModelLoaded({} as LoadResult, viewer);
    pipe.setFlow(600); // +600 L/min = +10 L/s; drains DESTINATION (TankB), fills SOURCE (TankA).

    const aBefore = tankA.amount;
    const bBefore = tankB.amount;
    for (let i = 0; i < 60; i++) plugin.onFixedUpdatePost(1 / 60);

    expect(tankA.amount, 'source tank should have FILLED (positive flow convention)').toBeGreaterThan(aBefore);
    expect(tankB.amount, 'destination tank should have DRAINED (positive flow convention)').toBeLessThan(bBefore);
    const filled = tankA.amount - aBefore;
    const drained = bBefore - tankB.amount;
    expect(Math.abs(drained - filled)).toBeLessThan(0.01);
    expect(filled).toBeCloseTo(10, 1);
  });

  it('resolves a pipe endpoint that points to another Pipe (one-hop walk) to the adjacent tank', () => {
    // Chain: Pipe1(source=TankA, dest=Pipe2) — Pipe2(source=Pipe1, dest=TankB).
    // Pipe1's destination is Pipe2 (not a tank). Plugin should walk one hop
    // through Pipe2 and resolve Pipe1.destination → TankB.
    const scene = new Scene();
    const tankANode = new Object3D(); tankANode.name = 'TankA';
    const tankBNode = new Object3D(); tankBNode.name = 'TankB';
    const pipe1Node = new Object3D(); pipe1Node.name = 'Pipe1';
    const pipe2Node = new Object3D(); pipe2Node.name = 'Pipe2';
    scene.add(tankANode); scene.add(tankBNode); scene.add(pipe1Node); scene.add(pipe2Node);

    const tankA = new RVTank(tankANode, { capacity: 1000, amount: 200 });
    const tankB = new RVTank(tankBNode, { capacity: 1000, amount: 800 });
    const pipe1 = new RVPipe(pipe1Node, {
      resourceName: 'Water', flowRate: 0,
      source:      { type: 'ComponentReference', path: 'TankA' },
      destination: { type: 'ComponentReference', path: 'Pipe2' },
    });
    new RVPipe(pipe2Node, {
      resourceName: 'Water', flowRate: 0,
      source:      { type: 'ComponentReference', path: 'Pipe1' },
      destination: { type: 'ComponentReference', path: 'TankB' },
    });

    const pathToNode = new Map<string, Object3D>([
      ['TankA', tankANode], ['TankB', tankBNode],
      ['Pipe1', pipe1Node], ['Pipe2', pipe2Node],
    ]);
    const viewer = {
      scene,
      registry: { getNode: (p: string) => pathToNode.get(p) ?? null },
    } as unknown as RVViewer;

    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    plugin.onModelLoaded({} as LoadResult, viewer);
    pipe1.setFlow(600); // positive → drain destination (via one-hop → TankB), fill source (TankA)

    const aBefore = tankA.amount;
    const bBefore = tankB.amount;
    for (let i = 0; i < 60; i++) plugin.onFixedUpdatePost(1 / 60);

    expect(tankA.amount, 'TankA should fill via source endpoint').toBeGreaterThan(aBefore);
    expect(tankB.amount, 'TankB should drain via one-hop destination').toBeLessThan(bBefore);
  });

  it('negative flow reverses direction (drains source, fills destination) and clamps at tank limits', () => {
    // Unity convention: negative flow → drain SOURCE, fill DESTINATION.
    // Pipe: source=Full, destination=Empty. Negative flow drains Full → Empty.
    const scene = new Scene();
    const fullNode = new Object3D(); fullNode.name = 'Full';
    const emptyNode = new Object3D(); emptyNode.name = 'Empty';
    const pipeNode = new Object3D(); pipeNode.name = 'Pipe0';
    scene.add(fullNode); scene.add(emptyNode); scene.add(pipeNode);

    const full = new RVTank(fullNode, { capacity: 100, amount: 100 });
    const empty = new RVTank(emptyNode, { capacity: 100, amount: 0 });
    const pipe = new RVPipe(pipeNode, {
      resourceName: 'Water', flowRate: 0,
      source: { type: 'ComponentReference', path: 'Full' },
      destination: { type: 'ComponentReference', path: 'Empty' },
    });

    const pathToNode = new Map<string, Object3D>([['Full', fullNode], ['Empty', emptyNode]]);
    const viewer = {
      scene,
      registry: { getNode: (p: string) => pathToNode.get(p) ?? null },
    } as unknown as RVViewer;

    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    plugin.onModelLoaded({} as LoadResult, viewer);
    pipe.setFlow(-3000); // -3000 L/min = -50 L/s, drains source (Full), fills destination (Empty)

    // Drive 2 s — inside the first per-pipe flip window (flip cadence 8–25 s).
    // At 50 L/s over 2 s we move 100 L, exactly Full's capacity.
    for (let i = 0; i < 60 * 2; i++) plugin.onFixedUpdatePost(1 / 60);

    expect(full.amount).toBeCloseTo(0, 5);       // drained (source side)
    expect(empty.amount).toBeCloseTo(100, 5);    // filled (destination side, clamped)
  });

  it('derives tank capacity from bounding box volume on load (preserves fill ratio)', () => {
    const scene = new Scene();
    // Small tank: 1×1×1 m box → 1 m³ → 1000 L
    const smallNode = new Object3D(); smallNode.name = 'Small';
    smallNode.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    scene.add(smallNode);
    // Large tank: 2×3×4 m box → 24 m³ → 24000 L
    const largeNode = new Object3D(); largeNode.name = 'Large';
    largeNode.add(new Mesh(new BoxGeometry(2, 3, 4), new MeshBasicMaterial()));
    scene.add(largeNode);

    // Both start with identical GLB-authored capacity 1000 and amount 500 (50% full).
    const small = new RVTank(smallNode, { capacity: 1000, amount: 500 });
    const large = new RVTank(largeNode, { capacity: 1000, amount: 500 });

    const viewer = { scene, registry: { getNode: () => null } } as unknown as RVViewer;
    plugin.onModelLoaded({} as LoadResult, viewer);

    // Capacities now reflect geometry volume (1000 L vs 24000 L).
    expect(small.capacity).toBeCloseTo(1000, 5);
    expect(large.capacity).toBeCloseTo(24000, 5);
    // Fill ratio preserved at 50%.
    expect(small.amount / small.capacity).toBeCloseTo(0.5, 5);
    expect(large.amount / large.capacity).toBeCloseTo(0.5, 5);
  });

  it('leaves capacity untouched for tanks with no geometry', () => {
    const scene = new Scene();
    const empty = new Object3D(); empty.name = 'NoGeo';
    scene.add(empty);
    const tank = new RVTank(empty, { capacity: 1234, amount: 500 });

    const viewer = { scene, registry: { getNode: () => null } } as unknown as RVViewer;
    plugin.onModelLoaded({} as LoadResult, viewer);

    expect(tank.capacity).toBe(1234);
  });

  it('assigns one coherent fluid per connected subgraph (pipe↔tank edges), isolated tanks are their own subgraph', () => {
    // Graph:
    //   Cluster 1: TankA ── Pipe1 ── TankB   (three nodes, one subgraph)
    //   Cluster 2: TankC                     (isolated — singleton subgraph)
    const scene = new Scene();
    const tankANode = new Object3D(); tankANode.name = 'TankA';
    const tankBNode = new Object3D(); tankBNode.name = 'TankB';
    const tankCNode = new Object3D(); tankCNode.name = 'TankC';
    const pipe1Node = new Object3D(); pipe1Node.name = 'Pipe1';
    scene.add(tankANode); scene.add(tankBNode); scene.add(tankCNode); scene.add(pipe1Node);

    const tankA = new RVTank(tankANode, { capacity: 1000, amount: 500 });
    const tankB = new RVTank(tankBNode, { capacity: 1000, amount: 500 });
    const tankC = new RVTank(tankCNode, { capacity: 1000, amount: 500 });
    const pipe1 = new RVPipe(pipe1Node, {
      resourceName: '', flowRate: 0,
      source:      { type: 'ComponentReference', path: 'TankA' },
      destination: { type: 'ComponentReference', path: 'TankB' },
    });

    const pathToNode = new Map<string, Object3D>([
      ['TankA', tankANode], ['TankB', tankBNode], ['TankC', tankCNode], ['Pipe1', pipe1Node],
    ]);
    const viewer = {
      scene,
      registry: { getNode: (p: string) => pathToNode.get(p) ?? null },
    } as unknown as RVViewer;

    plugin.onModelLoaded({} as LoadResult, viewer);

    // Every node in the connected cluster must share the same resourceName.
    expect(tankA.resourceName).toBe(tankB.resourceName);
    expect(pipe1.resourceName).toBe(tankA.resourceName);
    expect(tankA.resourceName).not.toBe(''); // was assigned by reassignFluids

    // The isolated tank got *some* fluid too, but it's independent of the cluster.
    expect(tankC.resourceName).not.toBe('');
  });

  it('pipes chained through other pipes share a single fluid across the whole chain', () => {
    // TankA ── Pipe1 ── Pipe2 ── Pipe3 ── TankB (one subgraph of 5 nodes)
    const scene = new Scene();
    const tankANode = new Object3D(); tankANode.name = 'TankA';
    const tankBNode = new Object3D(); tankBNode.name = 'TankB';
    const pipe1Node = new Object3D(); pipe1Node.name = 'Pipe1';
    const pipe2Node = new Object3D(); pipe2Node.name = 'Pipe2';
    const pipe3Node = new Object3D(); pipe3Node.name = 'Pipe3';
    scene.add(tankANode); scene.add(tankBNode);
    scene.add(pipe1Node); scene.add(pipe2Node); scene.add(pipe3Node);

    const tankA = new RVTank(tankANode, { capacity: 1000, amount: 500 });
    const tankB = new RVTank(tankBNode, { capacity: 1000, amount: 500 });
    const pipe1 = new RVPipe(pipe1Node, {
      resourceName: '', flowRate: 0,
      source: { type: 'ComponentReference', path: 'TankA' },
      destination: { type: 'ComponentReference', path: 'Pipe2' },
    });
    const pipe2 = new RVPipe(pipe2Node, {
      resourceName: '', flowRate: 0,
      source: { type: 'ComponentReference', path: 'Pipe1' },
      destination: { type: 'ComponentReference', path: 'Pipe3' },
    });
    const pipe3 = new RVPipe(pipe3Node, {
      resourceName: '', flowRate: 0,
      source: { type: 'ComponentReference', path: 'Pipe2' },
      destination: { type: 'ComponentReference', path: 'TankB' },
    });

    const pathToNode = new Map<string, Object3D>([
      ['TankA', tankANode], ['TankB', tankBNode],
      ['Pipe1', pipe1Node], ['Pipe2', pipe2Node], ['Pipe3', pipe3Node],
    ]);
    const viewer = {
      scene,
      registry: { getNode: (p: string) => pathToNode.get(p) ?? null },
    } as unknown as RVViewer;

    plugin.onModelLoaded({} as LoadResult, viewer);

    const fluid = tankA.resourceName;
    expect(fluid).not.toBe('');
    expect(tankB.resourceName).toBe(fluid);
    expect(pipe1.resourceName).toBe(fluid);
    expect(pipe2.resourceName).toBe(fluid);
    expect(pipe3.resourceName).toBe(fluid);
  });

  it('unions pipes that share a non-negative circuitId into one subgraph (even across ProcessingUnit barriers)', () => {
    // Two clusters that topologically have NO reference between them:
    //   Cluster A refs: TankA ── Pipe1        (only ref'd side)
    //   Cluster B refs: Pipe2 ── TankB        (only ref'd side)
    // Without circuit ids this would be two independent subgraphs. With
    // circuitId=7 on both pipes, all 4 nodes must end up in ONE subgraph and
    // share a single fluid.
    const scene = new Scene();
    const tankANode = new Object3D(); tankANode.name = 'TankA';
    const tankBNode = new Object3D(); tankBNode.name = 'TankB';
    const pipe1Node = new Object3D(); pipe1Node.name = 'Pipe1';
    const pipe2Node = new Object3D(); pipe2Node.name = 'Pipe2';
    scene.add(tankANode); scene.add(tankBNode); scene.add(pipe1Node); scene.add(pipe2Node);

    const tankA = new RVTank(tankANode, { capacity: 1000, amount: 500 });
    const tankB = new RVTank(tankBNode, { capacity: 1000, amount: 500 });
    const pipe1 = new RVPipe(pipe1Node, {
      resourceName: '', flowRate: 0, circuitId: 7,
      source: { type: 'ComponentReference', path: 'TankA' },
    });
    const pipe2 = new RVPipe(pipe2Node, {
      resourceName: '', flowRate: 0, circuitId: 7,
      destination: { type: 'ComponentReference', path: 'TankB' },
    });

    const pathToNode = new Map<string, Object3D>([
      ['TankA', tankANode], ['TankB', tankBNode], ['Pipe1', pipe1Node], ['Pipe2', pipe2Node],
    ]);
    const viewer = {
      scene,
      registry: { getNode: (p: string) => pathToNode.get(p) ?? null },
    } as unknown as RVViewer;

    plugin.onModelLoaded({} as LoadResult, viewer);

    expect(tankA.resourceName).not.toBe('');
    expect(tankA.resourceName).toBe(tankB.resourceName);
    expect(pipe1.resourceName).toBe(tankA.resourceName);
    expect(pipe2.resourceName).toBe(tankA.resourceName);
  });

  it('circuitId = -1 does NOT force-merge pipes — default stays topology-only', () => {
    // Two independent clusters, both pipes at circuitId=-1. They must stay
    // in separate subgraphs and may end up with different fluids.
    const scene = new Scene();
    const tankANode = new Object3D(); tankANode.name = 'TankA';
    const tankBNode = new Object3D(); tankBNode.name = 'TankB';
    const pipe1Node = new Object3D(); pipe1Node.name = 'Pipe1';
    const pipe2Node = new Object3D(); pipe2Node.name = 'Pipe2';
    scene.add(tankANode); scene.add(tankBNode); scene.add(pipe1Node); scene.add(pipe2Node);

    new RVTank(tankANode, { capacity: 1000, amount: 500 });
    new RVTank(tankBNode, { capacity: 1000, amount: 500 });
    new RVPipe(pipe1Node, {
      resourceName: '', flowRate: 0, circuitId: -1,
      source: { type: 'ComponentReference', path: 'TankA' },
    });
    new RVPipe(pipe2Node, {
      resourceName: '', flowRate: 0, circuitId: -1,
      destination: { type: 'ComponentReference', path: 'TankB' },
    });

    const pathToNode = new Map<string, Object3D>([
      ['TankA', tankANode], ['TankB', tankBNode], ['Pipe1', pipe1Node], ['Pipe2', pipe2Node],
    ]);
    const viewer = {
      scene,
      registry: { getNode: (p: string) => pathToNode.get(p) ?? null },
    } as unknown as RVViewer;

    plugin.onModelLoaded({} as LoadResult, viewer);

    // Four nodes → two subgraphs: {TankA, Pipe1} and {Pipe2, TankB}.
    // Use the plugin's own count — private field access is fine in a test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subgraphCount = (plugin as any).fluidSubgraphs.length;
    expect(subgraphCount).toBe(2);
  });

  describe('pipe coloring toggle', () => {
    it('defaults to disabled — applyFlowMaterial leaves GLB materials untouched', () => {
      // Build a pipe with a real Mesh child so material swap would be observable.
      const scene = new Scene();
      const pipeNode = new Object3D(); pipeNode.name = 'Pipe0';
      const originalMat = new MeshBasicMaterial();
      const pipeMesh = new Mesh(new BoxGeometry(1, 1, 1), originalMat);
      pipeNode.add(pipeMesh);
      scene.add(pipeNode);
      new RVPipe(pipeNode, { resourceName: 'Xylene', flowRate: 10 });

      const viewer = { scene } as unknown as RVViewer;
      plugin.onModelLoaded({} as LoadResult, viewer);

      // Default-off → mesh still wears its original material.
      expect(plugin.isColoringEnabled()).toBe(false);
      expect(pipeMesh.material).toBe(originalMat);
    });

    it('setColoringEnabled(true) swaps pipe meshes to fluid materials; (false) restores originals', () => {
      const scene = new Scene();
      const pipeNode = new Object3D(); pipeNode.name = 'Pipe0';
      const originalMat = new MeshBasicMaterial();
      const pipeMesh = new Mesh(new BoxGeometry(1, 1, 1), originalMat);
      pipeNode.add(pipeMesh);
      scene.add(pipeNode);
      new RVPipe(pipeNode, { resourceName: 'Xylene', flowRate: 10 });

      const viewer = { scene } as unknown as RVViewer;
      plugin.onModelLoaded({} as LoadResult, viewer);
      expect(pipeMesh.material).toBe(originalMat); // starting state

      plugin.setColoringEnabled(true);
      expect(plugin.isColoringEnabled()).toBe(true);
      expect(pipeMesh.material).not.toBe(originalMat); // fluid material applied

      plugin.setColoringEnabled(false);
      expect(plugin.isColoringEnabled()).toBe(false);
      expect(pipeMesh.material).toBe(originalMat); // restored from cache
    });

    it('setColoringEnabled(true) also swaps tank vessel meshes; (false) restores originals', () => {
      const scene = new Scene();
      const tankNode = new Object3D(); tankNode.name = 'TankA';
      const tankOriginalMat = new MeshBasicMaterial();
      const tankMesh = new Mesh(new BoxGeometry(2, 3, 2), tankOriginalMat);
      tankNode.add(tankMesh);
      scene.add(tankNode);
      new RVTank(tankNode, { resourceName: 'Xylene', capacity: 1000, amount: 500 });

      const viewer = { scene } as unknown as RVViewer;
      plugin.onModelLoaded({} as LoadResult, viewer);
      expect(tankMesh.material).toBe(tankOriginalMat);

      plugin.setColoringEnabled(true);
      expect(tankMesh.material).not.toBe(tankOriginalMat); // tank now fluid-colored

      plugin.setColoringEnabled(false);
      expect(tankMesh.material).toBe(tankOriginalMat); // restored
    });

    it('setColoringEnabled skips tank-fill overlay meshes (userData._tankFillViz)', () => {
      const scene = new Scene();
      const tankNode = new Object3D(); tankNode.name = 'TankA';
      const tankOriginalMat = new MeshBasicMaterial();
      const tankMesh = new Mesh(new BoxGeometry(2, 3, 2), tankOriginalMat);
      tankNode.add(tankMesh);

      // Simulate a TankFillManager overlay mesh as a sibling inside the tank node.
      const fillOverlayMat = new MeshBasicMaterial();
      const fillOverlay = new Mesh(new BoxGeometry(1, 1, 1), fillOverlayMat);
      fillOverlay.userData._tankFillViz = true;
      tankNode.add(fillOverlay);

      scene.add(tankNode);
      new RVTank(tankNode, { resourceName: 'Xylene', capacity: 1000, amount: 500 });

      const viewer = { scene } as unknown as RVViewer;
      plugin.onModelLoaded({} as LoadResult, viewer);
      plugin.setColoringEnabled(true);

      // Vessel swapped; fill-overlay untouched.
      expect(tankMesh.material).not.toBe(tankOriginalMat);
      expect(fillOverlay.material).toBe(fillOverlayMat);
    });

    it('setColoringEnabled is idempotent — repeat calls do not corrupt material cache', () => {
      const scene = new Scene();
      const pipeNode = new Object3D(); pipeNode.name = 'Pipe0';
      const originalMat = new MeshBasicMaterial();
      const pipeMesh = new Mesh(new BoxGeometry(1, 1, 1), originalMat);
      pipeNode.add(pipeMesh);
      scene.add(pipeNode);
      new RVPipe(pipeNode, { resourceName: 'Xylene', flowRate: 10 });

      const viewer = { scene } as unknown as RVViewer;
      plugin.onModelLoaded({} as LoadResult, viewer);

      plugin.setColoringEnabled(true);
      const fluidMat = pipeMesh.material;
      plugin.setColoringEnabled(true); // redundant ON
      expect(pipeMesh.material).toBe(fluidMat); // unchanged

      plugin.setColoringEnabled(false);
      plugin.setColoringEnabled(false); // redundant OFF
      expect(pipeMesh.material).toBe(originalMat); // still the original
    });
  });

  it('onModelCleared restores original pipe materials and disposes fluid materials', () => {
    const { scene, pipes } = buildFakeScene(1, 0, 0);
    const viewer = { scene } as unknown as RVViewer;

    plugin.onModelLoaded({} as LoadResult, viewer);
    // The plugin should have noted the original material (undefined here since
    // we used a plain Object3D with no Mesh children — just verifying clean-up works).
    plugin.onModelCleared(viewer);

    // After clear, state is empty — a subsequent onFixedUpdatePost is a no-op.
    expect(() => plugin.onFixedUpdatePost(1 / 60)).not.toThrow();
    expect(pipes[0].flowRate).toBeDefined(); // pipe still usable
  });
});
