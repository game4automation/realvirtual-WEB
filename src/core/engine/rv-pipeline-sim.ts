// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PipelineSimulation — Graph-based flow propagation.
 *
 * ALL pipeline components (Tank, ProcessingUnit, Pipe) are graph nodes.
 * Pipes connecting to other pipes propagate naturally through the graph.
 *
 * Algorithm per tick:
 * 1. Reset all pipe flowRates to 0
 * 2. Pumps seed flow on their pipe
 * 3. BFS from pump seeds through the network:
 *    - Pipe node: passthrough to connected node
 *    - ProcessingUnit: split equally on available outputs
 *    - Tank: outflow = max(fillRatio, 5%) * inflow
 * 4. Delta-buffer fluid transfer on tanks
 */

import type { Object3D } from 'three';
import type { NodeRegistry } from './rv-node-registry';

// ─── Config ─────────────────────────────────────────────────────────────

const PUMP_FLOW_MULTIPLIER = 10;
const MIN_TANK_PASSTHROUGH = 0.05;

// ─── Types ──────────────────────────────────────────────────────────────

type NodeType = 'Tank' | 'ProcessingUnit' | 'Pipe';

interface GraphNode {
  obj: Object3D;
  type: NodeType;
  /** All connections: { peer, flowSign } where flowSign indicates direction. */
  connections: GraphConnection[];
}

/** A connection between two graph nodes. */
interface GraphConnection {
  peer: GraphNode;
  /**
   * +1: flow from this node to peer is the "natural" direction
   * -1: flow from this node to peer is "reverse"
   * Used to set the correct flowRate sign on pipe nodes.
   */
  flowSign: number;
}

interface RVPipeData { flowRate: number; sourcePath: string | null; destinationPath: string | null; uvDirection: number }
interface RVTankData { amount: number; capacity: number }
interface RVPumpData { flowRate: number; pipePath: string | null }

// ─── PipelineSimulation ─────────────────────────────────────────────────

export class PipelineSimulation {
  private allNodes: GraphNode[] = [];
  private pipeNodes: GraphNode[] = [];
  private tankNodes: GraphNode[] = [];
  private pumpSeeds: Array<{ pipeNode: GraphNode; flowRate: number; downstreamNode: GraphNode | null }> = [];
  private deltas = new Map<Object3D, number>();

  constructor(
    pipeObjs: Object3D[],
    tankObjs: Object3D[],
    pumpObjs: Object3D[],
    puObjs: Object3D[],
    registry: NodeRegistry,
  ) {
    this._buildGraph(pipeObjs, tankObjs, pumpObjs, puObjs, registry);
  }

  fixedUpdate(dt: number): boolean {
    // ── Phase 1: Reset all pipe flows ──
    for (const node of this.pipeNodes) {
      (node.obj.userData._rvPipe as RVPipeData).flowRate = 0;
    }

    // ── Phase 2: BFS flow propagation ──
    const flowMap = new Map<GraphNode, number>(); // accumulated flow arriving at each node
    const visited = new Set<GraphNode>();
    const queue: GraphNode[] = [];

    // Seed from pumps — set pipe flow, start BFS at downstream node directly
    for (const seed of this.pumpSeeds) {
      (seed.pipeNode.obj.userData._rvPipe as RVPipeData).flowRate = seed.flowRate;
      // Mark the pipe itself as visited so BFS doesn't revisit it
      visited.add(seed.pipeNode);
      // Start BFS at the downstream node with the pump's flow magnitude
      if (seed.downstreamNode && !visited.has(seed.downstreamNode)) {
        flowMap.set(seed.downstreamNode, (flowMap.get(seed.downstreamNode) ?? 0) + Math.abs(seed.flowRate));
        visited.add(seed.downstreamNode);
        queue.push(seed.downstreamNode);
      }
    }

    while (queue.length > 0) {
      const node = queue.shift()!;
      const inflow = flowMap.get(node) ?? 0;
      if (inflow <= 0.001) continue;

      // Compute outflow budget based on node type
      let outflowBudget: number;
      if (node.type === 'Tank') {
        const tank = node.obj.userData._rvTank as RVTankData | undefined;
        if (tank && tank.capacity > 0) {
          const fillRatio = tank.amount / tank.capacity;
          outflowBudget = Math.max(fillRatio, MIN_TANK_PASSTHROUGH) * inflow;
        } else {
          outflowBudget = inflow;
        }
      } else {
        // Pipe and ProcessingUnit: full passthrough
        outflowBudget = inflow;
      }

      if (outflowBudget <= 0.001) continue;

      // Find unvisited peers to send flow to
      const available: GraphConnection[] = [];
      for (const conn of node.connections) {
        if (!visited.has(conn.peer)) {
          available.push(conn);
        }
      }

      if (available.length === 0) continue;

      const flowPerPeer = outflowBudget / available.length;

      for (const conn of available) {
        // If the peer is a pipe, set its flowRate
        if (conn.peer.type === 'Pipe') {
          (conn.peer.obj.userData._rvPipe as RVPipeData).flowRate = conn.flowSign * flowPerPeer;
        }

        // Accumulate flow at peer
        flowMap.set(conn.peer, (flowMap.get(conn.peer) ?? 0) + flowPerPeer);

        if (!visited.has(conn.peer)) {
          visited.add(conn.peer);
          queue.push(conn.peer);
        }
      }
    }

    // ── Phase 3: Fluid Transfer (delta-buffer) ──
    this.deltas.clear();

    for (const pipeNode of this.pipeNodes) {
      const rv = pipeNode.obj.userData._rvPipe as RVPipeData;
      if (Math.abs(rv.flowRate) < 1e-6) continue;

      // Find the two tank endpoints by traversing connections
      let fromTankNode: GraphNode | null = null;
      let toTankNode: GraphNode | null = null;

      // Walk backward (against flow) to find source tank
      fromTankNode = this._findTank(pipeNode, rv.flowRate >= 0 ? -1 : 1, visited);
      // Walk forward (with flow) to find dest tank
      toTankNode = this._findTank(pipeNode, rv.flowRate >= 0 ? 1 : -1, visited);

      const fromTank = fromTankNode?.obj.userData._rvTank as RVTankData | undefined;
      const toTank = toTankNode?.obj.userData._rvTank as RVTankData | undefined;

      let transfer = Math.abs(rv.flowRate) * dt;
      if (fromTank) transfer = Math.min(transfer, fromTank.amount);
      if (toTank) transfer = Math.min(transfer, toTank.capacity - toTank.amount);
      if (transfer <= 0) continue;

      if (fromTankNode) this.deltas.set(fromTankNode.obj, (this.deltas.get(fromTankNode.obj) ?? 0) - transfer);
      if (toTankNode) this.deltas.set(toTankNode.obj, (this.deltas.get(toTankNode.obj) ?? 0) + transfer);
    }

    let changed = false;
    for (const [obj, delta] of this.deltas) {
      if (Math.abs(delta) < 1e-9) continue;
      const tank = obj.userData._rvTank as RVTankData | undefined;
      if (!tank) continue;
      tank.amount = Math.max(0, Math.min(tank.capacity, tank.amount + delta));
      changed = true;
    }

    return changed;
  }

  /** Walk from a pipe node in the given direction to find the nearest Tank. */
  private _findTank(start: GraphNode, direction: number, _visited: Set<GraphNode>): GraphNode | null {
    const seen = new Set<GraphNode>([start]);
    let current = start;
    for (let i = 0; i < 50; i++) { // max depth to prevent infinite loops
      // Find the connection going in the requested direction
      let next: GraphNode | null = null;
      for (const conn of current.connections) {
        if (seen.has(conn.peer)) continue;
        if (conn.flowSign === direction || current.connections.length <= 2) {
          next = conn.peer;
          break;
        }
      }
      if (!next) return null;
      if (next.type === 'Tank') return next;
      seen.add(next);
      current = next;
    }
    return null;
  }

  // ─── Graph Construction ───────────────────────────────────────────

  private _buildGraph(
    pipeObjs: Object3D[],
    tankObjs: Object3D[],
    pumpObjs: Object3D[],
    puObjs: Object3D[],
    registry: NodeRegistry,
  ): void {
    const objToNode = new Map<Object3D, GraphNode>();

    // Create nodes for all component types
    for (const obj of tankObjs) {
      const gn: GraphNode = { obj, type: 'Tank', connections: [] };
      objToNode.set(obj, gn);
      this.allNodes.push(gn);
      this.tankNodes.push(gn);
    }
    for (const obj of puObjs) {
      const gn: GraphNode = { obj, type: 'ProcessingUnit', connections: [] };
      objToNode.set(obj, gn);
      this.allNodes.push(gn);
    }
    for (const obj of pipeObjs) {
      const gn: GraphNode = { obj, type: 'Pipe', connections: [] };
      objToNode.set(obj, gn);
      this.allNodes.push(gn);
      this.pipeNodes.push(gn);
    }

    // Wire connections from pipe source/destination
    for (const obj of pipeObjs) {
      const rv = obj.userData._rvPipe as RVPipeData | undefined;
      if (!rv) continue;
      const pipeGN = objToNode.get(obj)!;

      const srcObj = rv.sourcePath ? registry.getNode(rv.sourcePath) : null;
      const dstObj = rv.destinationPath ? registry.getNode(rv.destinationPath) : null;

      if (srcObj) {
        const srcGN = objToNode.get(srcObj);
        if (srcGN) {
          // Pipe → source: flow going to source is "reverse" (-1)
          pipeGN.connections.push({ peer: srcGN, flowSign: -1 });
          srcGN.connections.push({ peer: pipeGN, flowSign: 1 });
        }
      }
      if (dstObj) {
        const dstGN = objToNode.get(dstObj);
        if (dstGN) {
          // Pipe → destination: flow going to dest is "natural" (+1)
          pipeGN.connections.push({ peer: dstGN, flowSign: 1 });
          dstGN.connections.push({ peer: pipeGN, flowSign: -1 });
        }
      }
    }

    // Resolve pump seeds
    for (const pumpObj of pumpObjs) {
      const pump = pumpObj.userData._rvPump as RVPumpData | undefined;
      if (!pump || !pump.pipePath || Math.abs(pump.flowRate) < 0.001) continue;

      const pipeObj = registry.getNode(pump.pipePath);
      if (!pipeObj) continue;

      const pipeGN = objToNode.get(pipeObj);
      if (pipeGN) {
        // Negate: pump pushes opposite to pipe's source→dest convention
        // Negative flow = dest→source, so downstream is the source end (flowSign: -1)
        const downstreamConn = pipeGN.connections.find(c => c.flowSign === -1);
        this.pumpSeeds.push({
          pipeNode: pipeGN,
          flowRate: -pump.flowRate * PUMP_FLOW_MULTIPLIER,
          downstreamNode: downstreamConn?.peer ?? null,
        });
      }
    }

    const connectedPipes = this.pipeNodes.filter(p => p.connections.length > 0).length;
    console.log(
      `[PipelineSim] Graph: ${this.allNodes.length} nodes ` +
      `(${tankObjs.length} tanks, ${puObjs.length} PUs, ${pipeObjs.length} pipes), ` +
      `${connectedPipes} pipes connected, ${this.pumpSeeds.length} pumps`
    );
  }
}
