// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * build-peg-game-demo.mjs — the Setzkasten demo AS A VIEWER DOCUMENT
 * (plan-673 Phase 5).
 *
 *   node scripts/solve-peg-game-poses.mjs      # first: the joint angles
 *   node scripts/build-peg-game-demo.mjs       # then: the document
 *   node scripts/build-peg-game-demo.mjs --check   # build in memory, write nothing
 *
 * ## Why a document and not the Phase-1 spike model
 *
 * Phase 1 measured a HAND-WRITTEN MJCF. Phase 5 owes the plan a scene a user can
 * open, and the finding that forced this file is that no such scene existed: the
 * existing web demo scene carries a node called `FanucCRX-10iA_L`, but it is a
 * BAKED Unity export with `layer`/`tag`/`activeSelf` and nothing else — no
 * physics, no `RobotIK`, and above all no
 * `AssetReference`. Across all six documents of the demo project there are zero
 * `AssetReference` and zero `IKPath` nodes. So the physics-capable library CRX
 * (`author-robot-physics.mjs`, Phase 4b: 9 x `MechanismBody`, 9 x
 * `CollisionShapeSet`, 8 x `DynamicAxis`, 9 x `ContactProfile`, `GripLoad`) has
 * never appeared in a scene at all.
 *
 * This document PLACES that part — `AssetReference` to
 * `library/Robots/FanucCRX-10iA-L.glb` — and adds only what the robot cannot
 * own: the region, the board, the part, the pick station and the floor.
 *
 * ## What is authored here, and where every number comes from
 *
 * | thing | source |
 * |---|---|
 * | part geometry (arm 50 mm, width 20, thickness 35, 0.3 kg) | MEASURED, Phase 1 `DEFAULT_PART` |
 * | board (12 mm plate, 15 mm walls, 0.5 mm clearance per flank, r 30 mm round hole, 1.5 kg) | MEASURED, Phase 1 `DEFAULT_BOARD` |
 * | board decomposition (6 flank walls, 3 slot caps, 3 outer sectors, 6 round segments, 4 rim boxes) | MEASURED, Phase 1 `boardPrimitives` |
 * | feet 15 mm | MEASURED, Phase 1 `BOARD_FOOT_HEIGHT_M` — a part that is IN protrudes below the board |
 * | six round segments, not four or twelve | MEASURED: four segments cost MORE than six (not monotone) |
 * | `TimestepS` 0.002 | MEASURED, Phase-1 cost gate |
 * | joint angles of every waypoint | SOLVED on the delivered part, `solve-peg-game-poses.mjs` |
 * | grip pose of the part | MEASURED from the delivered jaw pads' `CollisionShapeSet` |
 * | region volume | DERIVED: the bounding box of everything above, plus the robot's reach |
 *
 * ## The three cases, and the ONE property each
 *
 * The cycle runs the case that FITS. The other two are one inspector field away,
 * which is what makes this a demo one OPERATES rather than plays:
 *
 *  - **wrong rotation** — `Sequence/06_Insert/A6.Destination`: 169.08 -> -130.92
 *    (the same pose turned 60 deg about the approach axis; for a three-fold
 *    shape that is the maximally wrong yaw). All three arms then rest on the
 *    plate instead of entering their slots.
 *  - **wrong shape** — the four `Insert`/`Approach` destinations of the
 *    `*-wrong-shape` pose set, printed by the solver: the three-star over the
 *    ROUND hole. Its convex hull is 83.7 mm wide against a 60 mm hole, so it
 *    cannot enter however hard it is pushed.
 *  - **the board moves** — nothing to change: the board is a `FreeBody` with
 *    `Movable`, so a skewed press shoves it, and the user can shove it by hand.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoxGeometry, ExtrudeGeometry, Shape } from 'three';
import { readGlb } from './lib/rv-glb.mjs';
import { seedNodeId, seedNodeIdsForFile } from '../src/core/engine/rv-node-id-seed.mjs';
import { stableDocumentId } from './_rv-manifest.mjs';
import {
  PART, BOARD, BOARD_FOOT_HEIGHT_M, BOARD_ORIGIN_XZ, ROUND_CENTRE_X,
  PART_HUB_BACK_M, PICK_TOP_Y, PICK_XZ,
} from './solve-peg-game-poses.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ROBOT_ASSET = resolve(ROOT, 'public/library/Robots/FanucCRX-10iA-L.glb');
const POSES_FILE = resolve(ROOT, 'spikes/673/peg-game-demo-poses.json');
const OUT_GLB = resolve(ROOT, '../realvirtual-WebViewer-Private~/projects/Development/models/PegGameSetzkasten.glb');
const PROJECT_JSON = resolve(ROOT, '../realvirtual-WebViewer-Private~/projects/Development/project.json');

// DERIVED, never invented: `tests/demo-manifest-invariants.node.test.ts` requires
// every document id in the manifest to be `stableDocumentId(path)`, and it caught
// a hand-written one here on the first run.
const DOC_ID = stableDocumentId('models/PegGameSetzkasten.glb');
const DOC_NAME = 'Peg Game (MuJoCo detail physics)';
const ROBOT_ASSET_ID = 'robots-fanuccrx-10ia-l';
const ROBOT_ASSET_PATH = 'library/Robots/FanucCRX-10iA-L.glb';
const SCENE_NAME = 'PegGameSetzkasten';

/**
 * Jaw stroke that OPENS the gripper, mm — negative, and that sign is the whole
 * finding (see the override on the `Robot` node). 0 is the delivered widest
 * position (17 mm between the pads); -8 mm gives 33 mm, enough for the 20 mm arm,
 * and 0 then clamps it with 1.5 mm of squeeze per flank against the actuator's
 * own 100 N force limit.
 */
const JAW_OPEN_MM = -8;

/** Axis speed of the whole cycle, deg/s — see the TargetSpeed override. */
const AXIS_SPEED_DEG_S = 25;

/**
 * Jaw stroke that CLAMPS, mm — the far end of the travel, deliberately past the
 * part, which is what `forcefit` means.
 *
 * MEASURED why it is not 0 (the nominal closed position): the part holds the
 * jaws at -1.5 mm, so a command of 0 leaves a 0.8 mm servo error and the clamp
 * came out at 42 N — a servo artefact, not the catalogue force. At 42 N and the
 * pad's µ 0.7 the part was carried and then lost as the motion settled.
 * Commanding the full stroke (15 mm) makes the error large, the actuator
 * saturate, and the clamp exactly its own `forcerange` — the plan's own rule for
 * `forcefit`: "the jaws are commanded to CLOSE FULLY, past the part, and the
 * actuator's forcerange is what the part actually feels".
 *
 * MEASURED, and the rule does NOT transfer to this jaw geometry: at a full-stroke
 * command the 100 N force limit arrives across a 1.5 mm interference and the part
 * is squirted out from between the pads — the grip was lost at the clamp instead
 * of at the carry. The delivered pads leave no travel over which to build the
 * force gently, so the clamp stays at the nominal closed position, which holds
 * 42 N. That is the open point of this scene, stated rather than tuned away.
 */
const JAW_CLAMP_MM = 0;

const MM = 1000;
const DEG = Math.PI / 180;
/** Rx(-90 deg) as a glTF quaternion `x y z w`: a plate whose own +Z is UP. */
const PLATE_LYING_FLAT = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

// ─────────────────────────────────────────────────────────────────────────────
// Geometry of the two parts, in their own plate frames (plate in XY, thickness
// along Z) — the SAME frame the `CollisionShapeSet` primitives are authored in.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Outline of a three-armed star with rectangular arms, as a 9-gon.
 *
 * Per arm two tip corners; between two arms the intersection of their flanks,
 * which sits at `hw / sin(60 deg)` from the hub. That is the EXACT outline, and
 * it is worth saying why it differs from the collision decomposition: the flank
 * WALLS of the board start at `hw * tan(30 deg)` from the hub (6.7 mm, not
 * 12.1 mm), i.e. slightly inside the ideal corner. That is the measured value
 * from Phase 1 and the rule the MJCF writer states but cannot check — a wall
 * that starts closer reaches into the NEXT arm's corridor, and the part then
 * never enters its own slot, silently.
 */
function threeStarOutline(armLen, halfWidth) {
  const pts = [];
  const inner = halfWidth / Math.sin(60 * DEG);
  for (let k = 0; k < 3; k++) {
    const a = k * 120 * DEG;
    const u = [Math.cos(a), Math.sin(a)];
    const n = [-Math.sin(a), Math.cos(a)];
    const bisectorBefore = (k * 120 - 60) * DEG;
    pts.push([inner * Math.cos(bisectorBefore), inner * Math.sin(bisectorBefore)]);
    pts.push([u[0] * armLen - n[0] * halfWidth, u[1] * armLen - n[1] * halfWidth]);
    pts.push([u[0] * armLen + n[0] * halfWidth, u[1] * armLen + n[1] * halfWidth]);
  }
  return pts;
}

/** A closed `Shape` from a point list. */
function shapeFrom(points) {
  const s = new Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]);
  s.closePath();
  return s;
}

/** The three-star plate, extruded and centred on its own mid-plane. */
function threeStarGeometry() {
  const shape = shapeFrom(threeStarOutline(PART.armLenM, PART.armWidthM / 2));
  const g = new ExtrudeGeometry(shape, { depth: PART.thicknessM, bevelEnabled: false });
  g.translate(0, 0, -PART.thicknessM / 2);
  return g;
}

/**
 * The board plate: a rectangle with the Y slot and the round hole cut out.
 *
 * The rectangle is 440 x 260 mm centred at local x = 80 mm — DERIVED, not
 * chosen: it is the smallest plate that covers every collision primitive,
 * including the round hole's four rim boxes, which reach to x = 295 mm. A
 * smaller plate would leave collision geometry outside the drawn part, and the
 * rule of this viewer since plan-754 is that what is drawn is what collides.
 */
function boardGeometry() {
  const halfX = 0.220;
  const halfY = 0.130;
  const cx = 0.080;
  const outer = shapeFrom([
    [cx - halfX, -halfY], [cx + halfX, -halfY], [cx + halfX, halfY], [cx - halfX, halfY],
  ]);
  const hw = PART.armWidthM / 2 + BOARD.clearanceM;
  const slot = shapeFrom(threeStarOutline(PART.armLenM + BOARD.clearanceM, hw));
  const round = new Shape();
  round.absarc(ROUND_CENTRE_X, 0, BOARD.roundHoleRadiusM, 0, Math.PI * 2, false);
  outer.holes.push(slot, round);
  const g = new ExtrudeGeometry(outer, { depth: 2 * BOARD.halfThickM, bevelEnabled: false });
  g.translate(0, 0, -BOARD.halfThickM);
  return g;
}

/**
 * The board's collision primitives, transcribed from `peg-game-scene.ts`
 * (`boardPrimitives`) — MILLIMETRES, HALF extents, DEGREES.
 *
 * Four groups, each with the measurement that put it there:
 *  - SIX FLANK WALLS, one per arm flank, starting at `hw * tan(30 deg) * 1.1`
 *    from the hub (closer and arm 1's wall reaches into arm 0's corridor).
 *  - THREE SLOT CAPS with 2 mm more stand-off: a slot's end is not a fit surface.
 *  - THREE OUTER SECTORS: what a wrongly rotated part rests on.
 *  - THE ROUND HOLE as six tangential boxes plus four rim boxes.
 */
function boardPrimitives(roundSegments = 6) {
  const out = [];
  const hw = PART.armWidthM / 2 + BOARD.clearanceM;
  const Lr = PART.armLenM + BOARD.clearanceM;
  const wt = BOARD.wallM;
  const ht = BOARD.halfThickM;
  const wallStartR = hw * Math.tan(30 * DEG) * 1.1;
  const box = (half, pos, angleRad) => out.push({
    Kind: 'box',
    Size: { x: half[0] * MM, y: half[1] * MM, z: half[2] * MM },
    Center: { x: pos[0] * MM, y: pos[1] * MM, z: pos[2] * MM },
    Rotation: { x: 0, y: 0, z: (angleRad * 180) / Math.PI },
  });
  for (let k = 0; k < 3; k++) {
    const a = 120 * k * DEG;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rMid = (Lr + wallStartR) / 2;
    const halfLen = (Lr - wallStartR) / 2;
    for (const s of [-1, 1]) {
      const off = hw + wt / 2;
      box([halfLen, wt / 2, ht], [rMid * ca - s * off * sa, rMid * sa + s * off * ca, 0], a);
    }
    const rCap = Lr + 0.002 + 0.020;
    box([0.020, hw + wt, ht], [rCap * ca, rCap * sa, 0], a);
    const ao = (120 * k + 60) * DEG;
    const rSec = 0.078;
    box([0.042, 0.042, ht], [rSec * Math.cos(ao), rSec * Math.sin(ao), 0], ao);
  }
  const rh = BOARD.roundHoleRadiusM;
  const segLen = 2 * rh * Math.tan(Math.PI / roundSegments);
  for (let k = 0; k < roundSegments; k++) {
    const a = (2 * Math.PI * k) / roundSegments;
    const r = rh + wt / 2;
    box([segLen / 2 + wt / 2, wt / 2, ht],
      [ROUND_CENTRE_X + r * Math.cos(a), r * Math.sin(a), 0], a + Math.PI / 2);
  }
  for (let k = 0; k < 4; k++) {
    const a = 90 * k * DEG;
    const r = rh + wt + 0.030;
    box([0.030, 0.030, ht], [ROUND_CENTRE_X + r * Math.cos(a), r * Math.sin(a), 0], a);
  }
  return out;
}

/** The three-star's three collision boxes — exactly the Phase-1 decomposition. */
function partPrimitives() {
  return Array.from({ length: 3 }, (_, k) => {
    const a = 120 * k;
    return {
      Kind: 'box',
      Size: {
        x: (PART.armLenM / 2) * MM, y: (PART.armWidthM / 2) * MM, z: (PART.thicknessM / 2) * MM,
      },
      Center: {
        x: (PART.armLenM / 2) * Math.cos(a * DEG) * MM,
        y: (PART.armLenM / 2) * Math.sin(a * DEG) * MM,
        z: 0,
      },
      Rotation: { x: 0, y: 0, z: a },
    };
  });
}

/** Principal inertia of the three-star about its hub, kg*mm^2 (Phase-1 `partDiagInertia`). */
function partInertiaKgMm2() {
  const m = PART.massKg / 3;
  const L = PART.armLenM;
  const w = PART.armWidthM;
  const t = PART.thicknessM;
  const iAlong = (m / 12) * (w * w + t * t);
  const iAcross = (m / 12) * (L * L + t * t);
  const iNormal = (m / 12) * (L * L + w * w);
  const d2 = (L / 2) * (L / 2);
  const inPlane = 1.5 * (iAcross + m * d2 + iAlong);
  const normal = 3 * (iNormal + m * d2);
  return [inPlane * 1e6, inPlane * 1e6, normal * 1e6, 0, 0, 0];
}

/** Box inertia of the drawn board plate, kg*mm^2. */
function boardInertiaKgMm2() {
  const m = BOARD.massKg;
  const bx = 0.440;
  const by = 0.260;
  const bz = 2 * BOARD.halfThickM;
  return [
    (m / 12) * (by * by + bz * bz) * 1e6,
    (m / 12) * (bx * bx + bz * bz) * 1e6,
    (m / 12) * (bx * bx + by * by) * 1e6,
    0, 0, 0,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// glTF assembly
// ─────────────────────────────────────────────────────────────────────────────

class GlbBuilder {
  constructor() {
    this.nodes = [];
    this.meshes = [];
    this.materials = [];
    this.accessors = [];
    this.bufferViews = [];
    this.chunks = [];
    this.byteLength = 0;
    this.materialIndex = new Map();
  }

  material(name, color, metallic = 0.1, roughness = 0.75) {
    if (this.materialIndex.has(name)) return this.materialIndex.get(name);
    const i = this.materials.length;
    this.materials.push({
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [...color, 1],
        metallicFactor: metallic,
        roughnessFactor: roughness,
      },
    });
    this.materialIndex.set(name, i);
    return i;
  }

  _view(bytes, target) {
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.byteLength += pad; }
    const offset = this.byteLength;
    this.chunks.push(Buffer.from(bytes));
    this.byteLength += bytes.length;
    const i = this.bufferViews.length;
    this.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    return i;
  }

  /** One mesh from a three.js BufferGeometry (POSITION + NORMAL + indices). */
  mesh(name, geometry, materialName, color) {
    geometry.computeVertexNormals();
    const pos = geometry.getAttribute('position');
    const nrm = geometry.getAttribute('normal');
    const idx = geometry.getIndex();
    const posArr = new Float32Array(pos.array);
    const nrmArr = new Float32Array(nrm.array);
    const indices = idx
      ? new Uint32Array(idx.array)
      : new Uint32Array(Array.from({ length: pos.count }, (_, i) => i));
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < posArr.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        if (posArr[i + c] < min[c]) min[c] = posArr[i + c];
        if (posArr[i + c] > max[c]) max[c] = posArr[i + c];
      }
    }
    const vPos = this._view(Buffer.from(posArr.buffer, posArr.byteOffset, posArr.byteLength), 34962);
    const vNrm = this._view(Buffer.from(nrmArr.buffer, nrmArr.byteOffset, nrmArr.byteLength), 34962);
    const vIdx = this._view(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength), 34963);
    const aPos = this.accessors.length;
    this.accessors.push({ bufferView: vPos, componentType: 5126, count: pos.count, type: 'VEC3', min, max });
    const aNrm = this.accessors.length;
    this.accessors.push({ bufferView: vNrm, componentType: 5126, count: nrm.count, type: 'VEC3' });
    const aIdx = this.accessors.length;
    this.accessors.push({ bufferView: vIdx, componentType: 5125, count: indices.length, type: 'SCALAR' });
    const i = this.meshes.length;
    this.meshes.push({
      name,
      primitives: [{
        attributes: { POSITION: aPos, NORMAL: aNrm },
        indices: aIdx,
        material: this.material(materialName, color),
      }],
    });
    return i;
  }

  node(spec) {
    const i = this.nodes.length;
    this.nodes.push(spec);
    return i;
  }

  pack(gltf) {
    const json = Buffer.from(JSON.stringify(gltf), 'utf8');
    const jsonPad = (4 - (json.length % 4)) % 4;
    const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
    const bin = Buffer.concat(this.chunks);
    const binPad = (4 - (bin.length % 4)) % 4;
    const binChunk = Buffer.concat([bin, Buffer.alloc(binPad)]);
    const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    const jh = Buffer.alloc(8);
    jh.writeUInt32LE(jsonChunk.length, 0);
    jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(binChunk.length, 0);
    bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, jsonChunk, bh, binChunk]);
  }
}

/** The authored `NodeId` of one of OUR nodes — the id the loader would seed. */
function ownNodeId(canonicalPath) {
  return seedNodeId(canonicalPath);
}

/** `realvirtual` extras block with an authored id. */
function rv(canonicalPath, components) {
  return { realvirtual: { NodeId: ownNodeId(canonicalPath), ...components } };
}

/** A `ComponentReference` by ADDRESS into the robot placement. */
function driveRef(placementId, nodeId) {
  return {
    type: 'ComponentReference',
    address: `${placementId}#${nodeId}`,
    componentType: 'realvirtual.Drive',
    componentIndex: 0,
  };
}

export function buildPegGameDemo() {
  const poses = JSON.parse(readFileSync(POSES_FILE, 'utf8'));
  // The robot's own node ids, computed the way the loader computes them
  // (UUIDv5 over the canonical authored path) — never transcribed.
  const robotJson = readGlb(readFileSync(ROBOT_ASSET)).json;
  const seeded = seedNodeIdsForFile(robotJson);
  const robotIdOf = (assetPath) => {
    const i = seeded.paths.indexOf(assetPath);
    if (i < 0) throw new Error(`no node "${assetPath}" in ${ROBOT_ASSET}`);
    return seeded.ids[i];
  };
  const A = 'FanucCRX-10iA-L/A1/A2/A3/A4/A5/A6';
  const AXIS_IDS = [
    robotIdOf('FanucCRX-10iA-L/A1'),
    robotIdOf('FanucCRX-10iA-L/A1/A2'),
    robotIdOf('FanucCRX-10iA-L/A1/A2/A3'),
    robotIdOf('FanucCRX-10iA-L/A1/A2/A3/A4'),
    robotIdOf('FanucCRX-10iA-L/A1/A2/A3/A4/A5'),
    robotIdOf(A),
  ];
  const GRIPPER_ID = robotIdOf(`${A}/TCP/SchunkEGH80Gripper`);

  const b = new GlbBuilder();

  // ── Meshes ────────────────────────────────────────────────────────────────
  const meshBoard = b.mesh('BoardPlate', boardGeometry(), 'Board', [0.78, 0.80, 0.83]);
  const meshStar = b.mesh('ThreeStarPlate', threeStarGeometry(), 'Workpiece', [0.00, 0.62, 0.84]);
  const meshFoot = b.mesh('BoardRiser', new BoxGeometry(0.380, 0.260, BOARD_FOOT_HEIGHT_M), 'Frame', [0.35, 0.36, 0.40]);
  const meshPedestal = b.mesh('PickTable', new BoxGeometry(0.200, 0.200, 0.200), 'Frame', [0.35, 0.36, 0.40]);
  const meshFloor = b.mesh('FloorSlab', new BoxGeometry(3.0, 0.100, 3.0), 'Floor', [0.55, 0.56, 0.58]);

  // ── Scene content ─────────────────────────────────────────────────────────
  const regionPath = 'MuJoCoDetail';
  const robotPath = `${regionPath}/Robot`;
  const placementId = ownNodeId(robotPath);

  // NO `PlacementMeta`, and that is load-bearing (measured 2026-10-24).
  //
  // `PlacementMeta` marks a PLANNER placement, and compose then reproduces the
  // place-time pivot normalisation on the graft (`pivotToFloorCenter`) so a
  // library file whose own root sits off-origin is not shifted twice. Applied to
  // this document it moved the robot's base to (-0.1017, 0, +0.3554): every
  // joint angle was reached exactly and the tool was 370 mm from where the
  // pose file said it would be, which looked like an IK error and was not.
  //
  // A hand-authored reference — this one, a CAD assembly referencing its parts —
  // keeps the file's own transforms, which is what a pose solved against the
  // asset's own frame needs.
  const robot = b.node({
    name: 'Robot',
    extras: rv(robotPath, {
      AssetReference: { assetId: ROBOT_ASSET_ID, path: ROBOT_ASSET_PATH },
      // ── The one correction this document makes to the placed robot ──────
      //
      // MEASURED 2026-10-24 from the delivered jaw pads' own
      // `CollisionShapeSet`: the pad inner faces sit at +-8.5 mm, so the jaws
      // span 17 mm at stroke 0 — and stroke 0 is the WIDEST, because the
      // fingers travel INWARD over their 0..15 mm range (at 15 mm the pads
      // overlap by 13 mm). Against the 20 mm arm of the three-star that means
      // the gripper cannot open far enough to accept the part at all: the first
      // full run reached every waypoint, closed the jaws, and held nothing.
      //
      // Phase 0 had already recorded the contradiction behind this: the Schunk
      // EGH 80 catalogue gives 40 mm of stroke PER JAW and the library part
      // 15 mm, and it ruled "the library part wins, and the contradiction is
      // reported". This is that report turning into a number. The correction is
      // the smallest one that works — 8 mm of extra travel outward, i.e. 33 mm
      // of opening, far inside the catalogue figure — and it lives HERE, as an
      // override of this placement, not in the delivered asset.
      //
      // The second correction, same mechanism, also measured: the asset's
      // `Drive.TargetSpeed` is 100 deg/s, and `LogicStep_DriveTo` moves at the
      // drive's own speed. On a DYNAMIC axis the ramp advances the setpoint by
      // `TargetSpeed * dt` per 60 Hz tick, i.e. 1.7 deg per tick at 100 deg/s,
      // which at the tool is a 5 mm jump — larger than the contact compliance
      // that holds the part. Measured: at 100 deg/s the jaws lost the part on
      // the first tick of the lift (clamp force 42 N -> 0 N within one frame);
      // at 10 deg/s the same grip carried it 180 mm. 25 deg/s is the fastest
      // that held in this scene.
      AssetOverrides: {
        byAddress: {
          [`#${robotIdOf(`${A}/TCP/SchunkEGH80Gripper/LeftFinger`)}`]: {
            Drive: { LowerLimit: JAW_OPEN_MM },
          },
          [`#${robotIdOf(`${A}/TCP/SchunkEGH80Gripper/RightFinger`)}`]: {
            Drive: { LowerLimit: JAW_OPEN_MM },
          },
          ...Object.fromEntries(AXIS_IDS.map((id) => [`#${id}`, { Drive: { TargetSpeed: AXIS_SPEED_DEG_S } }])),
        },
      },
    }),
  });

  // The floor: a flat BOX, not a plane — `plane` is not one of the five
  // `CollisionShapeSet` kinds, which the Phase-3 writer names as a gap.
  const floor = b.node({
    name: 'Floor',
    mesh: meshFloor,
    translation: [0, -0.050, 0],
    extras: rv(`${regionPath}/Floor`, {
      CollisionShapeSet: {
        Shapes: [{
          Kind: 'box', Size: { x: 1500, y: 50, z: 1500 },
          Center: { x: 0, y: 0, z: 0 }, Rotation: { x: 0, y: 0, z: 0 },
        }],
        ReplacesMesh: true,
      },
      ContactProfile: { Profile: 'MachineFrame', Priority: 0 },
    }),
  });

  // The pick table, and its SIZE is a measured requirement rather than taste.
  //
  // First attempt: a 100 x 140 mm pedestal under the part's hub, kept narrow out
  // of a fear that the jaw blocks would hit it. They cannot: the pads grip the
  // part's TOP 10 mm, so the pad tip always stops `thickness - 10 mm` = 25 mm
  // ABOVE whatever the part lies on — the same 25 mm that lets the part pass
  // through a 12 mm board. What the narrow pedestal did produce was measured:
  // the part's centre of mass sat 22 mm from the edge with 28 mm of arm
  // overhanging, and under the contact compliance of the `Workpiece` profile it
  // walked off and fell 100 mm in +X before the robot had moved at all.
  //
  // So the table is simply big enough: 200 x 200 mm, the part fully on it.
  const pedestal = b.node({
    name: 'PickTable',
    mesh: meshPedestal,
    translation: [PICK_XZ[0] - PART_HUB_BACK_M, PICK_TOP_Y - 0.100, PICK_XZ[1]],
    extras: rv(`${regionPath}/PickTable`, {
      CollisionShapeSet: {
        Shapes: [{
          Kind: 'box', Size: { x: 100, y: 100, z: 100 },
          Center: { x: 0, y: 0, z: 0 }, Rotation: { x: 0, y: 0, z: 0 },
        }],
        ReplacesMesh: true,
      },
      ContactProfile: { Profile: 'MachineFrame', Priority: 0 },
    }),
  });

  // The riser under the board: a child node with no joint, so the writer welds
  // its geometry into the board body. It is what lifts the board 15 mm off the
  // floor — a part that is IN protrudes below the plate, and a board lying flat
  // turns every success into a part/floor contact.
  const foot = b.node({
    name: 'BoardRiser',
    mesh: meshFoot,
    translation: [0.075, 0, -(BOARD.halfThickM + BOARD_FOOT_HEIGHT_M / 2)],
    extras: rv('MuJoCoDetail/Board/BoardRiser', {
      CollisionShapeSet: {
        Shapes: [{
          Kind: 'box', Size: { x: 190, y: 130, z: (BOARD_FOOT_HEIGHT_M / 2) * MM },
          Center: { x: 0, y: 0, z: 0 }, Rotation: { x: 0, y: 0, z: 0 },
        }],
        ReplacesMesh: true,
      },
      ContactProfile: { Profile: 'MachineFrame', Priority: 0 },
    }),
  });

  const board = b.node({
    name: 'Board',
    mesh: meshBoard,
    translation: [BOARD_ORIGIN_XZ[0], BOARD.halfThickM + BOARD_FOOT_HEIGHT_M, BOARD_ORIGIN_XZ[1]],
    rotation: [...PLATE_LYING_FLAT],
    children: [foot],
    extras: rv(`${regionPath}/Board`, {
      FreeBody: {
        Enabled: true, MassKg: BOARD.massKg, CondDim: 'SlidingTorsional', FrictionSlide: 0.3,
        LinearDamping: 0, AngularDamping: 0, Restitution: 0,
      },
      // FixtureBore with priority 1: the guiding surface sets the tone of the
      // pairing. MuJoCo MAXIMISES friction element-wise, so without a priority
      // the grippy jaw pad would pull the board pairing up with it.
      ContactProfile: { Profile: 'FixtureBore', Priority: 1 },
      CollisionShapeSet: { Shapes: boardPrimitives(6), ReplacesMesh: true },
      MechanismBody: {
        MassOverrideKg: BOARD.massKg,
        ComOverrideLocalMm: { x: -80, y: 0, z: 0 },
        InertiaOverrideLocalKgMm2: boardInertiaKgMm2(),
      },
      // Not a Drive with Direction 'Virtual': an obstacle is not a drive. The
      // user may shove the board on the floor plane and it springs back on stop.
      Movable: { Enabled: true, Axes: 'XZ', SnapMm: 0, ResetOnStop: true },
    }),
  });

  const part = b.node({
    name: 'ThreeStar',
    mesh: meshStar,
    // Hub `PART_HUB_BACK_M` behind the jaw axis, lying on the pedestal.
    translation: [
      PICK_XZ[0] - PART_HUB_BACK_M, PICK_TOP_Y + PART.thicknessM / 2, PICK_XZ[1],
    ],
    rotation: [...PLATE_LYING_FLAT],
    extras: rv(`${regionPath}/ThreeStar`, {
      FreeBody: {
        Enabled: true, MassKg: PART.massKg, CondDim: 'SlidingTorsional', FrictionSlide: 0.5,
        LinearDamping: 0, AngularDamping: 0, Restitution: 0,
      },
      ContactProfile: { Profile: 'Workpiece', Priority: 0 },
      CollisionShapeSet: { Shapes: partPrimitives(), ReplacesMesh: true },
      MechanismBody: {
        MassOverrideKg: PART.massKg,
        ComOverrideLocalMm: { x: 0, y: 0, z: 0 },
        InertiaOverrideLocalKgMm2: partInertiaKgMm2(),
      },
    }),
  });

  // ── The sequence ──────────────────────────────────────────────────────────
  //
  // Joint space, not an `IKPath`. When this was written the delivered library
  // robot carried no `RobotIK` (plan-773 E5). Since 2026-10-25 it ships one,
  // plus a demo `IKPath` `Robotpath` — with `StartPath: false`, so the placed
  // robot here does not run it and nothing fights this sequence (the path's
  // axis-ownership participant is inactive while the path is). The peg game
  // keeps its own joint-space steps because its poses are the measured grip
  // frames of `solve-peg-game-poses.mjs`, not the library's demo targets. On a
  // DYNAMIC axis this is not a shortcut past the
  // physics: `RVDrive.stepDynamicSetpoint()` routes a `LogicStep_DriveTo`
  // through `commandPosition()` onto the MuJoCo actuator, so the axis moves by
  // asking the actuator and the following error stays real.
  const steps = [];
  let stepNo = 0;
  const seqPath = 'Sequence';
  const nextName = (label) => `${String(++stepNo).padStart(2, '0')}_${label}`;

  const addStep = (label, components, children) => {
    const name = nextName(label);
    const i = b.node({
      name,
      ...(children ? { children } : {}),
      extras: rv(`${seqPath}/${name}`, components),
    });
    steps.push(i);
    return i;
  };

  /** One waypoint: six `DriveTo` in a parallel container, each waiting. */
  const addWaypoint = (label, poseId) => {
    const q = poses.poses[poseId]?.q;
    if (!q) throw new Error(`no solved pose "${poseId}" in ${POSES_FILE}`);
    const name = nextName(label);
    const children = q.map((deg, i) => b.node({
      name: `A${i + 1}`,
      extras: rv(`${seqPath}/${name}/A${i + 1}`, {
        LogicStep_DriveTo: { drive: driveRef(placementId, AXIS_IDS[i]), Destination: deg, Relative: false },
      }),
    }));
    const node = b.node({
      name,
      children,
      extras: rv(`${seqPath}/${name}`, { LogicStep_ParallelContainer: {} }),
    });
    steps.push(node);
    return node;
  };

  /** The gripper's virtual cylinder drive: 15 mm = open, 0 mm = clamped. */
  const addJaws = (label, mm) => addStep(label, {
    LogicStep_DriveTo: { drive: driveRef(placementId, GRIPPER_ID), Destination: mm, Relative: false },
  });

  addJaws('OpenJaws', JAW_OPEN_MM);
  // The approach waypoint ABOVE the pick, and it is not decoration: a joint-space
  // move straight to the pick pose brings the tool in from the SIDE, and the jaw
  // blocks — 52 mm wide, 94 mm long — sweep the part off its table on the way.
  // Measured: the part was 100 mm away and on the floor before the jaws closed.
  // From 200 mm directly above, the descent is short enough that the sweep is
  // harmless. Standard robot programming, arrived at the hard way.
  addWaypoint('ToPickAbove', 'lift');
  addWaypoint('ToPick', 'pick');
  addJaws('Clamp', JAW_CLAMP_MM);
  addStep('SettleGrip', { LogicStep_Delay: { Duration: 0.5 } });
  addWaypoint('Lift', 'lift');
  addWaypoint('Approach', 'approach');
  addWaypoint('Insert', 'insert');
  addStep('HoldPress', { LogicStep_Delay: { Duration: 1.5 } });
  addJaws('Release', JAW_OPEN_MM);
  addStep('WatchResult', { LogicStep_Delay: { Duration: 2 } });
  addWaypoint('Retract', 'approach');
  addStep('CycleEnd', { LogicStep_Delay: { Duration: 30 } });

  const sequence = b.node({
    name: 'Sequence',
    children: steps,
    extras: rv(seqPath, { LogicStep_SerialContainer: {} }),
  });

  const region = b.node({
    name: 'MuJoCoDetail',
    children: [robot, floor, pedestal, board, part],
    extras: rv(regionPath, {
      WebMuJoCoRegion: {
        RegionEnabled: true,
        TimestepS: 0.002,
        ExitBandM: 0.5,
        LoadTreeMode: 'composite',
        MjcfSource: '',
        MeshBase: '',
        Contract: '',
        TrunkBody: '',
        TrunkFreeJoint: '',
        GyroSensor: '',
        // Off by default: a 2.6 x 2.0 x 1.8 m violet wireframe box over the whole
        // cell hides the thing it contains. Switch it on in the inspector.
        ShowGizmo: false,
      },
      // The region VOLUME is this node's own BoxCollider extras — the same rule
      // WebPhysicsZone follows, so there is no second place that states a volume.
      // `center` is a UNITY value (readers negate X), hence -0.55 for +0.55 m.
      BoxCollider: { center: { x: -0.55, y: 0.80, z: 0 }, size: { x: 2.7, y: 2.0, z: 1.8 } },
    }),
  });

  const gltf = {
    asset: { version: '2.0', generator: 'rv peg-game demo builder (plan-673 Phase 5)' },
    scene: 0,
    scenes: [{
      name: SCENE_NAME,
      nodes: [region, sequence],
      extras: {
        realvirtual: {
          // A web-written file: every reference is an ADDRESS, never a path.
          idVersion: 1,
          SceneSettings: { catalogUrls: [], gridSizeMm: 500 },
          Classification: { v: 1, level: 'scene' },
          DocumentInfo: {
            v: 1,
            summary: 'Peg game with MuJoCo detail physics: the library Fanuc CRX places the realvirtual '
              + 'three-star into a loose segmented board — force-limited axes, contact-held gripper, '
              + 'and a board that slides when the press is skewed.',
            description: DOC_DESCRIPTION,
            updatedAt: '2026-10-24T00:00:00.000Z',
            updatedBy: 'realvirtual',
          },
        },
      },
    }],
    nodes: b.nodes,
    meshes: b.meshes,
    materials: b.materials,
    accessors: b.accessors,
    bufferViews: b.bufferViews,
    buffers: [{ byteLength: b.chunks.reduce((s, c) => s + c.length, 0) }],
  };
  return {
    glb: b.pack(gltf),
    stats: {
      nodes: b.nodes.length,
      meshes: b.meshes.length,
      boardPrimitives: boardPrimitives(6).length,
      partPrimitives: partPrimitives().length,
      steps: steps.length,
      placementId,
      axisIds: AXIS_IDS,
      gripperId: GRIPPER_ID,
    },
  };
}

const DOC_DESCRIPTION = `# Peg Game — MuJoCo detail physics

The **library Fanuc CRX-10iA/L** picks the *realvirtual* three-star off a pedestal and places it
into a **loose** segmented board. Everything that matters here is physics, not animation:

- **Force-limited axes.** Each of the six axes is a \`DynamicAxis\` driven as a MuJoCo position
  actuator with the force range derived from its own gravity torque, so the axis has a real
  **following error** and a real **actual torque**.
- **A gripper that holds by contact.** \`GripLoad\` is in \`forcefit\` mode: the part is held by the
  jaw pads' contact, not parented to the gripper. It can slip, and the slip is measured.
- **A board nobody clamped.** The board is a \`FreeBody\` on 15 mm feet. Press skewed and it slides
  away instead of accepting the part — the one failure case that shows up in the *environment*
  rather than at the machine.
- **A decomposition, not a mesh.** MuJoCo convexifies every collision mesh, and the convex hull of
  a three-star is a hexagon that does not fit through its own slot. Both the part (3 boxes) and the
  board (22 primitives: 6 flank walls, 3 slot caps, 3 sectors, 6 round segments, 4 rim boxes) are
  authored as arrangements of convex primitives.

## Try this

- Press **Play**: the cycle picks, carries, presses, releases and retracts.
- **Wrong rotation:** set \`Sequence/06_Insert/A6.Destination\` from \`169.08\` to \`-130.92\` — the same
  pose turned 60° about the approach axis, which for a three-fold shape is the maximally wrong yaw.
  All three arms then rest on the plate.
- **Wrong shape:** aim the press at the round hole instead. The three-star's convex hull is 83.7 mm
  wide against a 60 mm hole, so no amount of force gets it in.
- **Shove the board** (it is \`Movable\`) and watch the next press miss.
- Watch **PartSlip** and the **clamping force** on the gripper, not only the axis following error:
  in two of the three measured failure cases the axes look exactly like the successful run.
`;

export function registerInProject(glb) {
  const project = JSON.parse(readFileSync(PROJECT_JSON, 'utf8'));
  const sha256 = createHash('sha256').update(glb).digest('hex');
  const entry = {
    id: DOC_ID,
    name: DOC_NAME,
    path: 'models/PegGameSetzkasten.glb', section: 'models',
    mode: 'commissioning',
    classification: { v: 1, level: 'scene' },
    sizeBytes: glb.length,
    mtimeMs: Date.now(),
    sha256,
    documentInfo: {
      v: 1,
      summary: 'Peg game with MuJoCo detail physics: the library Fanuc CRX places the realvirtual '
        + 'three-star into a loose segmented board.',
      description: DOC_DESCRIPTION,
      updatedAt: '2026-10-24T00:00:00.000Z',
      updatedBy: 'realvirtual',
    },
    extrasScan: 2,
  };
  // Keyed on the PATH, not the id: a document is identified by its file, and an
  // id that is DERIVED from that path can change when the rule does.
  const i = project.documents.findIndex((d) => d.path === 'models/PegGameSetzkasten.glb');
  if (i >= 0) project.documents[i] = entry;
  else {
    // Before the knowledge markdown entry, which is conventionally last.
    const mdAt = project.documents.findIndex((d) => String(d.path).endsWith('.md'));
    if (mdAt >= 0) project.documents.splice(mdAt, 0, entry);
    else project.documents.push(entry);
  }
  project.modifiedAt = new Date().toISOString();
  return { project, sha256 };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { glb, stats } = buildPegGameDemo();
  const { project, sha256 } = registerInProject(glb);
  console.log(`nodes            ${stats.nodes}`);
  console.log(`meshes           ${stats.meshes}`);
  console.log(`board primitives ${stats.boardPrimitives}`);
  console.log(`part primitives  ${stats.partPrimitives}`);
  console.log(`sequence steps   ${stats.steps}`);
  console.log(`placement id     ${stats.placementId}`);
  console.log(`glb              ${glb.length} bytes, sha256 ${sha256.slice(0, 16)}...`);
  if (!process.argv.includes('--check')) {
    writeFileSync(OUT_GLB, glb);
    writeFileSync(PROJECT_JSON, `${JSON.stringify(project, null, 2)}\n`);
    console.log(`\nwritten: ${OUT_GLB}`);
    console.log(`updated: ${PROJECT_JSON}`);
  }
}
