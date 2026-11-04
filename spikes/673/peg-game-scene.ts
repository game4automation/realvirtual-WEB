// plan-673 Phase 3 — the peg game AS AUTHORED COMPONENTS.
//
// `peg-game-model.ts` next door writes the same machine as a hand-built MJCF
// document, in metres, with every number formatted straight into the XML. This
// file builds it the way a user would: a `WebMuJoCoRegion` on a three.js node,
// `Drive` + `DynamicAxis` per axis, `CollisionShapeSet` in MILLIMETRE HALF
// extents, `ContactProfile` roles, `FreeBody` on the loose parts — and nothing
// else. The Phase-3 MJCF writer then has to produce the same machine out of it.
//
// THE TWO FILES ARE DELIBERATELY NOT SHARED. They take the same two parameter
// records (`DEFAULT_PART`, `DEFAULT_BOARD`) and the same transcribed robot
// (`CRX_AXES`, `CRX_LINK_MASS_KG`) and construct the board, the gripper and the
// three-star independently, in different unit systems. That is what makes the
// golden test a witness instead of an echo: a writer that halves twice, forgets
// a millimetre conversion or composes a frame the wrong way round disagrees with
// a document that was formatted by hand.
//
// What is NOT re-derived here, and why: the gripper's internal layout (jaw
// stand-off, pad size, pad height along the approach axis) are five numbers that
// exist only inside `buildPegGameMjcf`. They are RETYPED below rather than
// exported from there, so the spike file of a finished gate stays untouched — and
// a typo in them fails the golden, which is the point.
//
// Coordinate note, and the one thing to understand before reading any position
// here: MJCF positions and quaternions are expressed in the PARENT's frame, and
// the whole document hangs under ONE +90°-about-X frame at its root. So below
// that root a node's glTF-local translation and the hand-written model's MJCF
// translation are THE SAME NUMBERS; only the quaternion component order differs
// (glTF stores `x y z w`, MJCF `w x y z`).

import { Euler, Object3D, Quaternion, Vector3 } from 'three';
import {
  applySchema,
  getRegisteredFactories,
  setComponentInstance,
  type ComponentContext,
} from '@rv/core/engine/rv-component-registry';
import { RVDrive, DriveDirection } from '@rv/core/engine/rv-drive';
import { RVDriveGear } from '@rv/core/engine/rv-drive-gear';
import { MUJOCO_REGION_TYPE, RVMuJoCoRegion } from '@rv/core/engine/rv-mujoco-region';
import { DYNAMIC_AXIS_TYPE } from '@rv/core/engine/rv-dynamic-axis';
import { FREE_BODY_TYPE } from '@rv/core/engine/rv-free-body';
import {
  COLLISION_SHAPE_SET_TYPE,
  CONTACT_PROFILE_TYPE,
  type CollisionShapeKind,
} from '@rv/core/engine/rv-contact-geometry';
import {
  BOARD_FOOT_HEIGHT_M,
  BOARD_ORIGIN,
  CRX_ARMATURE,
  CRX_AXES,
  CRX_JOINT_DAMPING,
  CRX_KP,
  CRX_KV,
  CRX_LINK_MASS_KG,
  DEFAULT_BOARD,
  DEFAULT_PART,
  GRIP_FORCE_TOTAL_N,
  JAW_STROKE_M,
  partDiagInertia,
  type BoardGeometry,
  type PartGeometry,
} from './peg-game-model';

const CTX = {} as unknown as ComponentContext;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Build one component through its registered factory, exactly as the loader does. */
export function addComponent<T>(node: Object3D, type: string, extras: Record<string, unknown> = {}): T {
  const factory = getRegisteredFactories().get(type);
  if (!factory) throw new Error(`no registered factory for "${type}"`);
  const inst = factory.create(node, null);
  factory.beforeSchema?.(inst, extras);
  applySchema(inst as unknown as Record<string, unknown>, factory.schema, extras);
  setComponentInstance(node, inst);
  inst.init(CTX);
  return inst as unknown as T;
}

/** A node with an authored local pose; `quat` is glTF order `x y z w`. */
function child(
  parent: Object3D, name: string,
  pos: readonly [number, number, number] = [0, 0, 0],
  quat: readonly [number, number, number, number] | null = null,
): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(pos[0], pos[1], pos[2]);
  if (quat) n.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
  parent.add(n);
  n.updateMatrix();
  return n;
}

/** One `CollisionShapeSet.Shapes[]` entry: MILLIMETRES, HALF extents, DEGREES. */
export function shape(
  kind: CollisionShapeKind,
  sizeMm: readonly number[],
  centreMm: readonly [number, number, number] = [0, 0, 0],
  rotationDeg: readonly [number, number, number] = [0, 0, 0],
): Record<string, unknown> {
  return {
    Kind: kind,
    Size: { x: sizeMm[0] ?? 0, y: sizeMm[1] ?? 0, z: sizeMm[2] ?? 0 },
    Center: { x: centreMm[0], y: centreMm[1], z: centreMm[2] },
    Rotation: { x: rotationDeg[0], y: rotationDeg[1], z: rotationDeg[2] },
  };
}

const M_TO_MM = 1000;

/**
 * `[Ixx, Iyy, Izz, 0, 0, 0]` in kg·mm² of a uniform sphere of radius `rM` — an
 * ISOTROPIC tensor, deliberately.
 *
 * A capsule's real tensor is not isotropic, and expressing it would mean rotating
 * a diagonal into the link's frame, i.e. one more conversion with one more chance
 * of a sign error — in a file whose job is to be an independent witness. An
 * isotropic tensor needs no frame at all, and nothing this scene is used for
 * reads it: the gravity torques both documents are compared on are a function of
 * mass and centre of mass only (`qfrc_bias` at zero velocity), and the geometry
 * comparison does not touch inertia. What the tensor must be is PLAUSIBLE and
 * positive definite, so the model is a real rigid body and the solver behaves.
 */
function isotropicInertia(massKg: number, rM: number): number[] {
  const i = 0.4 * massKg * rM * rM * 1e6; // kg·m² → kg·mm²
  return [i, i, i, 0, 0, 0];
}

/**
 * A flat plate's own frame inside a Y-up scene: local +Z (the plate normal) onto
 * world +Y, as a glTF quaternion `x y z w`.
 *
 * `Rx(−90°)`. It exists because the two documents place the SAME plate in two
 * different parent frames and that is not a detail to gloss over: the
 * hand-written model puts its part and board straight into the `worldbody`, i.e.
 * in MJCF's Z-up world, while everything the writer emits hangs below the one
 * root frame and is therefore authored Y-up. "0.6 m up" is `+Z` there and `+Y`
 * here, and a plate whose decomposition is drawn in its own plane needs this
 * quarter turn on its node.
 */
const PLATE_LYING_FLAT: readonly [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

// ─── The gripper layout, retyped from `buildPegGameMjcf` (see the header) ────
/** Pad centre along the arm, m. */
const PAD_Y = 0.025;
/** Jaw stand-off from the gripper centre at q = 0, m. */
const JAW_BASE = 0.0255;
/** Pad half extents, m — the Z component is what limits the insertion travel. */
const PAD_HALF: readonly [number, number, number] = [0.004, 0.012, 0.005];
/** Pad centre along the approach axis, m. */
const PAD_Z = 0.0225;
/** Pad mass, kg — part of the model's 40.9 kg total. */
const PAD_MASS_KG = 0.05;

/**
 * `ReverseDirection` per axis, and the one place this scene is tuned to the
 * hand-written model rather than to the library part.
 *
 * `Drive.getAxis()` is the drive's OWN convention: `directionToGltfAxis()` for
 * the direction, negated when `ReverseDirection` is set. For `RotationY` and
 * `RotationZ` the glTF conversion already negates the axis (the quaternion
 * handedness flip), so a reversed Y or Z drive comes out as Unity's positive
 * axis — which is what the hand-written model wrote. `RotationX` is not negated
 * by the conversion, so it needs `ReverseDirection: false` to come out the same
 * way.
 *
 * The SIGN of a joint axis is free in a model (it only says which way a positive
 * setpoint turns), but it must not be free between two models that are compared
 * in the same pose — otherwise `qfrc_bias` differs for a reason that has nothing
 * to do with the writer. The writer's own contract, that the MJCF axis IS
 * `Drive.getAxis()`, has its own test.
 */
const CRX_REVERSE = [true, true, true, false, true, false] as const;

export interface PegGameScene {
  /** The region node — the MJCF document's origin. */
  readonly root: Object3D;
  readonly region: RVMuJoCoRegion;
  /** `A1`…`A6`, `jaw_l`, `jaw_r`. */
  readonly drives: Readonly<Record<string, RVDrive>>;
  readonly part: PartGeometry;
  readonly board: BoardGeometry;
  /** Number of board primitives authored — the geom count the writer must emit. */
  readonly boardShapeCount: number;
}

export interface PegGameSceneOptions {
  part?: Partial<PartGeometry>;
  board?: Partial<BoardGeometry>;
  /** Per-axis force limits, N·m. `null` = no limit authored (and a problem entry). */
  forceRangeNm?: readonly number[] | null;
  /** Multiplier on {@link CRX_KP}; `kv` follows as sqrt, as in the hand-written model. */
  kpScale?: number;
  roundSegments?: number;
  timestepS?: number;
  /** Add the floor box. Off for a model that only needs the robot. */
  withFloor?: boolean;
}

/**
 * The authored scene.
 *
 * CALLER CONTRACT: the caller must first have loaded the module that registers
 * `MechanismBody`, i.e. `kinematic-mechanism/rv-kinematic-mechanism`. That module
 * is PRIVATE, so this public file does not import it — a public spike file that
 * reached into the private tree would be exactly the licence leak the repo split
 * exists to prevent. Both Phase-3 tests import it themselves.
 *
 * Masses are pinned with `MassOverrideKg` + `ComOverrideLocalMm`, not integrated
 * from meshes: there is no geometry in this scene, and the quantity under test is
 * the writer's unit handling and frame composition, not the mesh integrator
 * (which has its own suite). The centre of mass of each link is the MIDPOINT of
 * the capsule the hand-written model gives that link, which is exactly where a
 * uniform capsule's centre of mass sits — so the two documents must agree on
 * every gravity torque.
 */
export function buildPegGameScene(opts: PegGameSceneOptions = {}): PegGameScene {
  const part: PartGeometry = { ...DEFAULT_PART, ...opts.part };
  const board: BoardGeometry = { ...DEFAULT_BOARD, ...opts.board };
  const roundSegments = opts.roundSegments ?? 12;
  const kpScale = opts.kpScale ?? 1;
  const fr = opts.forceRangeNm ?? null;

  const root = new Object3D();
  root.name = 'PegGameRegion';
  root.updateMatrix();
  const region = addComponent<RVMuJoCoRegion>(root, MUJOCO_REGION_TYPE, {
    TimestepS: opts.timestepS ?? 0.002,
  });

  const drives: Record<string, RVDrive> = {};

  /** A dynamic axis: `Drive` + `DynamicAxis` on one node. */
  const dynamicAxis = (
    node: Object3D, direction: DriveDirection, reverse: boolean,
    axisExtras: Record<string, unknown>,
  ): RVDrive => {
    const drive = new RVDrive(node);
    drive.Direction = direction;
    drive.ReverseDirection = reverse;
    drive.initDrive();
    addComponent(node, DYNAMIC_AXIS_TYPE, axisExtras);
    drives[node.name] = drive;
    return drive;
  };

  // ── Base: static, 12 kg, one cylinder along the approach-free vertical ──
  // The hand-written model puts the base cylinder along MJCF +Z at z = 0.1225;
  // below the root frame that is glTF +Y, so the authored primitive is a cylinder
  // whose own axis (local Z) is rotated onto +Y by −90° about X.
  const base = child(root, 'base');
  addComponent(base, COLLISION_SHAPE_SET_TYPE, {
    Shapes: [shape('cylinder', [0.09 * M_TO_MM, 0.1225 * M_TO_MM], [0, 0.1225 * M_TO_MM, 0], [-90, 0, 0])],
  });
  addComponent(base, CONTACT_PROFILE_TYPE, { Profile: 'MachineFrame' });
  mechanismBody(base, CRX_LINK_MASS_KG.base, [0, 0.1225 * M_TO_MM, 0],
    isotropicInertia(CRX_LINK_MASS_KG.base, 0.1225));

  // ── The six axes, transcribed 1:1 from the library part ──
  let parent = base;
  for (let i = 0; i < CRX_AXES.length; i++) {
    const ax = CRX_AXES[i];
    // MJCF `w x y z` → glTF `x y z w`.
    const q = ax.quat ? ([ax.quat[1], ax.quat[2], ax.quat[3], ax.quat[0]] as const) : null;
    const node = child(parent, ax.name, [ax.pos[0], ax.pos[1], ax.pos[2]], q);
    const direction = ax.axis[1] !== 0
      ? DriveDirection.RotationY
      : ax.axis[2] !== 0 ? DriveDirection.RotationZ : DriveDirection.RotationX;
    dynamicAxis(node, direction, CRX_REVERSE[i], {
      ActuatorKind: 'position',
      Kp: CRX_KP[i] * kpScale,
      Kv: CRX_KV[i] * Math.sqrt(kpScale),
      Armature: CRX_ARMATURE,
      Damping: CRX_JOINT_DAMPING[i],
      ForceRangeMin: fr && Number.isFinite(fr[i]) ? -fr[i] : 0,
      ForceRangeMax: fr && Number.isFinite(fr[i]) ? fr[i] : 0,
    });
    // One capsule per link, spanning to the next joint — the Menagerie precedent
    // (manually designed collision geometry, capsules, never the visual meshes).
    const next = CRX_AXES[i + 1];
    const to = next ? next.pos : ([0.060, 0, 0] as const);
    const span = Math.hypot(to[0], to[1], to[2]);
    const mid: [number, number, number] = [to[0] / 2, to[1] / 2, to[2] / 2];
    if (span > 1e-4) {
      addComponent(node, COLLISION_SHAPE_SET_TYPE, {
        Shapes: [capsuleAlong(0.055, mid, to)],
      });
      addComponent(node, CONTACT_PROFILE_TYPE, { Profile: 'MachineFrame' });
    }
    const linkMass = CRX_LINK_MASS_KG[ax.name as keyof typeof CRX_LINK_MASS_KG];
    mechanismBody(node, linkMass, [mid[0] * M_TO_MM, mid[1] * M_TO_MM, mid[2] * M_TO_MM],
      isotropicInertia(linkMass, Math.max(span / 2, 0.055)));
    parent = node;
  }

  // ── Tool frame and gripper: NO joint, so the writer welds them into A6 ──
  const tcp = child(parent, 'TCP', [0.060, 0, 0], [-0.5, 0.5, -0.5, 0.5]);
  const gripper = child(tcp, 'gripper', [0, 0, -0.010], [0.5, 0.5, 0.5, 0.5]);
  addComponent(gripper, COLLISION_SHAPE_SET_TYPE, {
    Shapes: [shape('box', [0.035 * M_TO_MM, 0.03 * M_TO_MM, 0.025 * M_TO_MM], [0, 0, 0.005 * M_TO_MM])],
  });
  addComponent(gripper, CONTACT_PROFILE_TYPE, { Profile: 'MachineFrame' });
  mechanismBody(gripper, CRX_LINK_MASS_KG.gripper, [0, 0, 0.005 * M_TO_MM],
    isotropicInertia(CRX_LINK_MASS_KG.gripper, 0.035));

  // ── Two jaws, geared 1:1 off the left one ──
  const jawAxisExtras = {
    ActuatorKind: 'position',
    // The jaws are commanded to close FULLY and the force limit is what the part
    // feels — the plan's `forcefit`. A stiff servo plus a datasheet force range,
    // never a soft servo with commanded over-travel (10 N of 100 N measured).
    Kp: 50000,
    Kv: 500,
    Armature: 0.001,
    Damping: 2,
    ForceRangeMin: -GRIP_FORCE_TOTAL_N,
    ForceRangeMax: GRIP_FORCE_TOTAL_N,
  };
  const jawL = child(gripper, 'jaw_l', [-JAW_BASE, 0, PAD_Z]);
  const driveL = dynamicAxis(jawL, DriveDirection.LinearX, true, jawAxisExtras);
  driveL.UseLimits = true;
  driveL.LowerLimit = 0;
  driveL.UpperLimit = JAW_STROKE_M * M_TO_MM;
  jaw(jawL, 1);

  const jawR = child(gripper, 'jaw_r', [JAW_BASE, 0, PAD_Z]);
  const driveR = dynamicAxis(jawR, DriveDirection.LinearX, false, jawAxisExtras);
  driveR.UseLimits = true;
  driveR.LowerLimit = 0;
  driveR.UpperLimit = JAW_STROKE_M * M_TO_MM;
  jaw(jawR, -1);
  // `Drive_Gear` registers a SCHEMA, not a factory (it is a drive behavior, wired
  // by the loader), so it is constructed directly. The writer reads the public
  // `MasterDrive` field, which is what `resolveComponentRefs()` fills on a real
  // load — nothing here needs the behavior's own `init`.
  const gear = new RVDriveGear(jawR);
  gear.GearFactor = 1;
  gear.Offset = 0;
  gear.MasterDrive = driveL;
  setComponentInstance(jawR, gear);

  // ── The part: three boxes at 120°, a free body ──
  //
  // The plate lies flat, i.e. its normal is UP, and in a Y-up scene that is +Y —
  // so the node carries the quarter turn that puts its own local +Z there, and the
  // three-star decomposition is then authored in the plate's own frame (arms in
  // local XY, thickness along local Z), which is how anyone would draw it. Note
  // what this means for the position: "0.6 m above the floor" is +Y here, not +Z.
  const partNode = child(root, 'part', [0.4, 0.6, 0], PLATE_LYING_FLAT);
  const [ix, iy, iz] = partDiagInertia(part);
  addComponent(partNode, FREE_BODY_TYPE, {
    MassKg: part.massKg, CondDim: 'SlidingTorsional', FrictionSlide: 0.5,
  });
  addComponent(partNode, CONTACT_PROFILE_TYPE, { Profile: 'Workpiece' });
  addComponent(partNode, COLLISION_SHAPE_SET_TYPE, {
    Shapes: Array.from({ length: 3 }, (_, k) => {
      const a = 120 * k;
      return shape(
        'box',
        [(part.armLenM / 2) * M_TO_MM, (part.armWidthM / 2) * M_TO_MM, (part.thicknessM / 2) * M_TO_MM],
        [(part.armLenM / 2) * Math.cos(rad(a)) * M_TO_MM, (part.armLenM / 2) * Math.sin(rad(a)) * M_TO_MM, 0],
        [0, 0, a],
      );
    }),
  });
  // kg·m² → kg·mm² for the authoring unit of `MechanismBody`.
  mechanismBody(partNode, part.massKg, [0, 0, 0], [ix * 1e6, iy * 1e6, iz * 1e6, 0, 0, 0]);

  // ── The board: a free body with six flank walls, caps, sectors and the hole ──
  const ht = board.halfThickM;
  const foot = BOARD_FOOT_HEIGHT_M;
  const boardNode = child(
    root, 'board', [BOARD_ORIGIN[0], ht + foot, BOARD_ORIGIN[1]], PLATE_LYING_FLAT,
  );
  const boardShapes = boardPrimitives(part, board, roundSegments);
  addComponent(boardNode, FREE_BODY_TYPE, {
    MassKg: board.massKg, CondDim: 'SlidingTorsional', FrictionSlide: 0.3,
  });
  // FixtureBore: the guiding surface sets the tone of the pairing (priority 1),
  // and its collision class is what keeps 28 plate segments off the floor.
  addComponent(boardNode, CONTACT_PROFILE_TYPE, { Profile: 'FixtureBore', Priority: 1 });
  addComponent(boardNode, COLLISION_SHAPE_SET_TYPE, { Shapes: boardShapes });
  const bx = 0.36;
  const by = 0.26;
  const bz = 2 * ht;
  const bm = board.massKg;
  mechanismBody(boardNode, bm, [0, 0, 0], [
    (bm / 12) * (by * by + bz * bz) * 1e6,
    (bm / 12) * (bx * bx + bz * bz) * 1e6,
    (bm / 12) * (bx * bx + by * by) * 1e6,
    0, 0, 0,
  ]);

  // The foot is a child node of the board with no joint: the writer welds its
  // geometry into the board body, and its own role puts it in the SUPPORT class
  // so the board stands on four contacts instead of on every plate segment.
  const footNode = child(boardNode, 'board_foot', [0.075, 0, -ht - foot / 2]);
  addComponent(footNode, COLLISION_SHAPE_SET_TYPE, {
    Shapes: [shape('box', [0.19 * M_TO_MM, 0.13 * M_TO_MM, (foot / 2) * M_TO_MM])],
  });
  addComponent(footNode, CONTACT_PROFILE_TYPE, { Profile: 'MachineFrame' });

  if (opts.withFloor !== false) {
    // A flat box, not a plane: `plane` is not one of the five CollisionShapeSet
    // kinds, which is named as a gap in the Phase-3 report.
    const floor = child(root, 'floor', [0, -0.05, 0]);
    addComponent(floor, COLLISION_SHAPE_SET_TYPE, { Shapes: [shape('box', [3000, 50, 3000])] });
    addComponent(floor, CONTACT_PROFILE_TYPE, { Profile: 'MachineFrame' });
  }

  root.updateWorldMatrix(true, true);
  return { root, region, drives, part, board, boardShapeCount: boardShapes.length };
}

/**
 * `MechanismBody` with a pinned mass and centre of mass; `comMm` is the centre
 * in the node's local GLTF frame, in millimetres.
 *
 * X is negated on the way in, and that is not a detail: `ComOverrideLocalMm` is
 * declared `unityCoords` in the schema, so `applySchema` flips X on load — an
 * authored Unity value becomes a glTF one. Handing a glTF value straight in
 * would mirror every centre of mass that has an X component, which on a six-axis
 * arm is a gravity torque with the wrong sign on three joints.
 */
function mechanismBody(
  node: Object3D, massKg: number, comMm: readonly [number, number, number],
  inertiaKgMm2?: readonly number[],
): void {
  addComponent(node, 'MechanismBody', {
    MassOverrideKg: massKg,
    ComOverrideLocalMm: { x: -comMm[0], y: comMm[1], z: comMm[2] },
    ...(inertiaKgMm2 ? { InertiaOverrideLocalKgMm2: [...inertiaKgMm2] } : {}),
  });
}

/**
 * A capsule primitive spanning `(0,0,0) → to`, as the mm/half-extent form.
 *
 * `CollisionShapeSet` has no `fromto`: a capsule is radius plus HALF LENGTH along
 * its own local Z, so the span becomes a rotation. Deriving that rotation here is
 * the authoring side of the same conversion the writer does not have to make,
 * which is the point — the writer reads primitives, it does not interpret spans.
 */
function capsuleAlong(
  radiusM: number, centreM: readonly [number, number, number], to: readonly [number, number, number],
): Record<string, unknown> {
  const dir = new Vector3(to[0], to[1], to[2]);
  const halfLen = dir.length() / 2;
  dir.normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir);
  // Euler XYZ in DEGREES, which is what the schema declares for `Rotation`.
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  return shape(
    'capsule',
    [radiusM * M_TO_MM, halfLen * M_TO_MM],
    [centreM[0] * M_TO_MM, centreM[1] * M_TO_MM, centreM[2] * M_TO_MM],
    [(e.x * 180) / Math.PI, (e.y * 180) / Math.PI, (e.z * 180) / Math.PI],
  );
}

/**
 * The board's primitives, built independently of the hand-written model.
 *
 * Same geometry, different arithmetic path and different units — see the file
 * header on why the two are not shared. The four groups, and the measured reason
 * each exists:
 *
 *  - SIX FLANK WALLS, one per arm flank, each starting no closer to the hub than
 *    `hw·tan(30°)`: closer than that, arm 1's wall reaches into arm 0's corridor
 *    and the part simply never enters its own slot — silently.
 *  - THREE SLOT CAPS with 2 mm more stand-off than the flanks: the flanks are the
 *    guiding surfaces and carry the fit, the end of the slot is not a fit surface.
 *  - THREE OUTER SECTORS: what a wrongly rotated part rests on.
 *  - THE ROUND HOLE as `roundSegments` tangential boxes plus four rim boxes. Six
 *    segments, not four: fewer and longer walls give the three arms MORE flat
 *    surface to lie against, and four segments measured MORE expensive than six.
 */
function boardPrimitives(
  part: PartGeometry, board: BoardGeometry, roundSegments: number,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const hw = part.armWidthM / 2 + board.clearanceM;
  const Lr = part.armLenM + board.clearanceM;
  const wt = board.wallM;
  const ht = board.halfThickM;
  const wallStartR = hw * Math.tan(Math.PI / 6) * 1.1;
  const box = (
    halfM: readonly [number, number, number], posM: readonly [number, number, number], angleRad: number,
  ): void => {
    out.push(shape(
      'box',
      [halfM[0] * M_TO_MM, halfM[1] * M_TO_MM, halfM[2] * M_TO_MM],
      [posM[0] * M_TO_MM, posM[1] * M_TO_MM, posM[2] * M_TO_MM],
      [0, 0, (angleRad * 180) / Math.PI],
    ));
  };
  for (let k = 0; k < 3; k++) {
    const a = rad(120 * k);
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
    const ao = rad(120 * k + 60);
    const rSec = 0.078;
    box([0.042, 0.042, ht], [rSec * Math.cos(ao), rSec * Math.sin(ao), 0], ao);
  }
  const rh = board.roundHoleRadiusM;
  const roundCentre = 0.220;
  const segLen = 2 * rh * Math.tan(Math.PI / roundSegments);
  for (let k = 0; k < roundSegments; k++) {
    const a = (2 * Math.PI * k) / roundSegments;
    const r = rh + wt / 2;
    box([segLen / 2 + wt / 2, wt / 2, ht],
      [roundCentre + r * Math.cos(a), r * Math.sin(a), 0], a + Math.PI / 2);
  }
  for (let k = 0; k < 4; k++) {
    const a = rad(90 * k);
    const r = rh + wt + 0.030;
    box([0.030, 0.030, ht], [roundCentre + r * Math.cos(a), r * Math.sin(a), 0], a);
  }
  return out;
}

/** Pad primitive and role on one jaw; `side` is +1 for the left jaw. */
function jaw(node: Object3D, side: number): void {
  addComponent(node, COLLISION_SHAPE_SET_TYPE, {
    Shapes: [shape(
      'box',
      [PAD_HALF[0] * M_TO_MM, PAD_HALF[1] * M_TO_MM, PAD_HALF[2] * M_TO_MM],
      [side * 0.004 * M_TO_MM, PAD_Y * M_TO_MM, 0],
    )],
  });
  // GripperJaw: priority 1 and its own friction. Phase 0's verified force-closure
  // calculation — the PAD FRICTION decides the holding capacity by a factor of
  // seven, not the grip force (0.51 kg at µ 0.1, 3.57 kg at µ 0.7).
  addComponent(node, CONTACT_PROFILE_TYPE, { Profile: 'GripperJaw', Priority: 1 });
  mechanismBody(node, PAD_MASS_KG, [side * 0.004 * M_TO_MM, PAD_Y * M_TO_MM, 0],
    isotropicInertia(PAD_MASS_KG, 0.012));
}
