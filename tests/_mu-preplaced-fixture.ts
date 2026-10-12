// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared fixture for the plan-516 pre-placed MU tests: MU nodes with a solid
 * BoxCollider whose BOTTOM sits at the node origin, a pallet-with-products
 * builder and a manager wired like the loader wires it.
 */

import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { computeMUColliderFrameBox } from '../src/core/engine/rv-mu-collider-bounds';
import { classifyPreplacedMUs } from '../src/core/engine/rv-scene-loader';

/** MU node with one BoxCollider of `size` (m) whose bottom face is at the node origin, plus a visual mesh. */
export function muNode(name: string, size: [number, number, number], pos: [number, number, number] = [0, 0, 0]): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(pos[0], pos[1], pos[2]);
  n.userData.realvirtual = {
    MU: {},
    colliders: [{
      type: 'BoxCollider', enabled: true, isTrigger: false,
      center: { x: 0, y: size[1] / 2, z: 0 },
      size: { x: size[0], y: size[1], z: size[2] },
    }],
  };
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]), new MeshBasicMaterial());
  mesh.position.y = size[1] / 2;
  n.add(mesh);
  return n;
}

/** A standalone MU object built the way the classifier builds a pre-placed one. */
export function preplacedMU(node: Object3D): RVMovingUnit {
  node.updateWorldMatrix(true, true);
  const box = computeMUColliderFrameBox(node, new Box3());
  const mu = new RVMovingUnit(node, '', box.getSize(new Vector3()).multiplyScalar(0.5), box.getCenter(new Vector3()));
  mu.preplaced = true;
  if (node.parent) {
    mu.snapshot = {
      parent: node.parent,
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      scale: node.scale.clone(),
      visible: node.visible,
    };
  }
  return mu;
}

export const PALLET: [number, number, number] = [0.6, 0.1, 0.4];
export const PART: [number, number, number] = [0.1, 0.08, 0.1];

/**
 * A model root with `pallets` pallets in a row along X (1 m pitch) and
 * `partsPerPallet` parts resting on each (collider bottom = pallet top). The
 * parts are authored as SIBLINGS of the pallets — the collider, not the
 * hierarchy, decides the load.
 */
export function palletRow(pallets: number, partsPerPallet: number): { root: Object3D; pallets: Object3D[]; parts: Object3D[][] } {
  const root = new Object3D();
  root.name = 'Model';
  const palletNodes: Object3D[] = [];
  const parts: Object3D[][] = [];
  for (let i = 0; i < pallets; i++) {
    const p = muNode(`PALLET.${i}`, PALLET, [i, 0, 0]);
    root.add(p);
    palletNodes.push(p);
    const row: Object3D[] = [];
    for (let k = 0; k < partsPerPallet; k++) {
      const x = i - 0.2 + (partsPerPallet > 1 ? (0.4 * k) / (partsPerPallet - 1) : 0.2);
      const part = muNode(`PART.${i}.${k}`, PART, [x, PALLET[1], 0]);
      root.add(part);
      row.push(part);
    }
    parts.push(row);
  }
  return { root, pallets: palletNodes, parts };
}

/** A manager + scene with `root` added, classified like the loader does. */
export function classifiedScene(root: Object3D): { scene: Scene; tm: RVTransportManager } {
  const scene = new Scene();
  scene.add(root);
  const tm = new RVTransportManager();
  tm.scene = scene;
  classifyPreplacedMUs(root, tm);
  return { scene, tm };
}

/** The pre-placed MU object of `node` (throws when it was not classified). */
export function muOf(tm: RVTransportManager, node: Object3D): RVMovingUnit {
  const mu = tm.preplacedMUs.find((m) => m.node === node);
  if (!mu) throw new Error(`${node.name} is not a pre-placed MU`);
  return mu;
}

export function worldPos(node: Object3D): Vector3 {
  node.updateWorldMatrix(true, false);
  return node.getWorldPosition(new Vector3());
}

// ─── plan-577: seats (parts IN a jig, a cap over a valve end) ──────────────

/** Set `MU.LoadSeatDepth` (mm) on an MU node built by {@link muNode}. */
export function withSeatDepth(node: Object3D, mm: unknown): Object3D {
  const rv = node.userData.realvirtual as { MU: Record<string, unknown> };
  rv.MU.LoadSeatDepth = mm;
  return node;
}

/** Workpiece carrier with jig (spike plan-569: 170 × 93.8 × 170 mm). */
export const WT: [number, number, number] = [0.17, 0.0938, 0.17];
/** Valve body (38.4 × 111.4 × 45.4 mm → rounded). */
export const VALVE: [number, number, number] = [0.038, 0.111, 0.045];
/** Cap (31.8 × 25 × 33.1 mm → rounded). */
export const CAP: [number, number, number] = [0.032, 0.025, 0.033];
/** Seat depths of the laser-welding demo (mm). */
export const WT_SEAT_MM = 70;
export const VALVE_SEAT_MM = 40;
/** How deep the valve sits in the jig / the cap over the valve (m, spike measurements). */
export const VALVE_SINK = 0.062;
export const CAP_SINK = 0.036;

/**
 * A row of `n` jig cells along X (0.5 m pitch). Each cell is a plain group
 * `Jig.<i>` (the CAD assembly node, NOT an MU) holding three SIBLING MUs: the
 * carrier `WT.<i>` (seat 70 mm), the valve `Valve.<i>` sunk 62 mm into it
 * (seat 40 mm) and — when `cap(i)` — the cap `Cap.<i>` sunk 36 mm over the
 * valve end. Parent ≠ carrier for valve and cap (plan-577 §2.5).
 */
export function jigCell(n: number, cap: (i: number) => boolean = () => true): {
  root: Object3D; jigs: Object3D[]; wts: Object3D[]; valves: Object3D[]; caps: (Object3D | null)[];
} {
  const root = new Object3D();
  root.name = 'Cell';
  const jigs: Object3D[] = [];
  const wts: Object3D[] = [];
  const valves: Object3D[] = [];
  const caps: (Object3D | null)[] = [];
  for (let i = 0; i < n; i++) {
    const jig = new Object3D();
    jig.name = `Jig.${i}`;
    jig.position.set(i * 0.5, 0, 0);
    root.add(jig);
    const wt = withSeatDepth(muNode(`WT.${i}`, WT, [0, 0, 0]), WT_SEAT_MM);
    const valveBottom = WT[1] - VALVE_SINK;
    const valve = withSeatDepth(muNode(`Valve.${i}`, VALVE, [0.03, valveBottom, 0.02]), VALVE_SEAT_MM);
    jig.add(wt, valve);
    let c: Object3D | null = null;
    if (cap(i)) {
      c = muNode(`Cap.${i}`, CAP, [0.03, valveBottom + VALVE[1] - CAP_SINK, 0.02]);
      jig.add(c);
    }
    jigs.push(jig); wts.push(wt); valves.push(valve); caps.push(c);
  }
  return { root, jigs, wts, valves, caps };
}

/** World TRS of a node (position, quaternion) — for "same as after load" checks. */
export function worldPose(node: Object3D): { pos: Vector3; quat: Quaternion } {
  node.updateWorldMatrix(true, false);
  const pos = new Vector3();
  const quat = new Quaternion();
  node.matrixWorld.decompose(pos, quat, new Vector3());
  return { pos, quat };
}
