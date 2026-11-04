// plan-673 Phase 5 — WHY the grip does not reach the board, measured.
//
//   node scripts/with-test-lock.mjs npx vitest run -c spikes/673/vitest.config.ts \
//     spikes/673/phase5-grip-study.node.test.ts
//
// ── The question ────────────────────────────────────────────────────────────
// `phase5-demo-measure.node.test.ts` left the scene's one real open point:
// the jaws clamp (42 N), carry the part ~180 mm, and lose it as the motion
// settles, so the insertion is never reached. Three candidate causes were named
// in the plan, ordered by how cheap they are:
//
//   (a) the jaw collision hull is the WHOLE finger block, 52 x 94 x 33 mm,
//   (b) the setpoint ramp steps over the contact compliance per tick,
//   (c) the part is at the heavy end of its mass window (0.3 kg).
//
// This file measures them on the DELIVERED geometry instead of arguing about
// them. It patches the document's `AssetOverrides` IN MEMORY — the same
// mechanism the document itself uses, so a winning variant moves into
// `scripts/build-peg-game-demo.mjs` unchanged — and runs the same pick/carry/
// press cycle per variant.
//
// ── What the geometry says before any measurement ───────────────────────────
// Two numbers from `contact-profiles.json` bound what (a) can possibly do, and
// they are worth stating because they rule out the obvious reading of it:
//
//  - `GripperJaw` is contype 4 / conaffinity 6 (GUIDE), `MachineFrame` is
//    1 / 3 (SUPPORT), and a guide does NOT meet support. The finger block
//    therefore never collided with the floor, the pick table or the board's
//    riser, so "the block is in the way" cannot be about those.
//  - The pads press along the finger's local X. The part's gripped arm spans
//    x ±10 mm, the left pad x 8.5…60.6 mm, so the CONTACT PATCH is the overlap
//    1.5 x 33.1 x 10 mm — set by the pad's INNER FACE, its Z extent and the
//    grip depth, and not by how far the block reaches outward or upward.
//
// So shrinking the block in X and Y is free clearance and changes no contact.
// What the patch geometry CAN change is its Z extent: the part's centre of mass
// hangs `PART_HUB_BACK_M` = 20 mm out along -Z, and the friction couple that
// has to carry that moment acts over the patch's Z extent. The delivered pad
// covers 33.1 mm of a 50 mm arm. Extending it to the whole arm is the one pad
// change with a mechanical argument behind it, and it is measured below as
// `pad-long`.
//
// ── Units ──────────────────────────────────────────────────────────────────
// `CollisionShapeSet.Size` is HALF extents in mm (the delivered pad is
// Size 26.049 x 46.8 x 16.551 at Center 34.549, 156, 0 — a 52 x 94 x 33 mm
// block whose inner face lands at 8.5 mm, which is the measured 17 mm jaw gap).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Scene, type Object3D } from 'three';
import { loadGLB } from '@rv/core/engine/rv-scene-loader';
import type { ReferenceResolver } from '@rv/core/engine/rv-glb-compose';
import { RVMuJoCoRegion } from '@rv/core/engine/rv-mujoco-region';
import { RVDrive } from '@rv/core/engine/rv-drive';
import { RVGripLoad } from '@rv/core/engine/rv-grip-load';
import { getComponentInstances } from '@rv/core/engine/rv-component-registry';
import { RVMuJoCoRegionRuntime } from '@rv-private/mujoco/rv-mujoco-region-runtime';
import '@rv-private/kinematic-mechanism/rv-kinematic-mechanism';
import { readGlb, writeGlb } from '../../scripts/lib/rv-glb.mjs';

const ROOT = resolve(__dirname, '../..');
const DEMO_GLB = resolve(ROOT, 'public/demo-realvirtual/PegGameSetzkasten.glb');
const ROBOT_GLB = resolve(ROOT, 'public/library/Robots/FanucCRX-10iA-L.glb');
const POSES = JSON.parse(
  readFileSync(resolve(ROOT, 'spikes/673/peg-game-demo-poses.json'), 'utf8'),
) as {
  poses: Record<string, { q: number[]; gripperPos: number[]; yawDeg: number }>;
  layout: { boardTopYM: number; boardOriginXZ: number[] };
  grip: { padTipYM: number; padGripDepthM: number };
};

const FIXED_DT = 1 / 60;
const AXIS_NAMES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const;
const JAW_OPEN_MM = -8;
/** The delivered pad's inner face in the finger frame, mm — the 17 mm jaw gap. */
const PAD_INNER_X_MM = 8.5;
/** The delivered pad tip along the approach axis, mm — every pose depends on it. */
const PAD_TIP_Y_MM = 202.8;

// ─── The document, patched in memory ────────────────────────────────────────

/** One shape of a `CollisionShapeSet`, in the authored mm/half-extent form. */
interface Shape {
  Kind: 'box';
  Center: { x: number; y: number; z: number };
  Size: { x: number; y: number; z: number };
  Rotation: { x: number; y: number; z: number };
}

/**
 * A jaw pad as a box, from the four numbers that matter.
 *
 * `innerXMm` is the face that touches the part, `tipYMm` the end of the finger
 * (both measured from the delivered pad and kept unless a variant says
 * otherwise — every solved pose is relative to them). `depthXMm` is how far the
 * pad reaches outward from the part, `heightYMm` how far back from the tip, and
 * `zFromMm`/`zToMm` the extent ALONG the gripped arm.
 */
function pad(sign: 1 | -1, p: {
  innerXMm?: number; tipYMm?: number; depthXMm: number; heightYMm: number;
  zFromMm: number; zToMm: number;
}): Shape {
  const innerX = p.innerXMm ?? PAD_INNER_X_MM;
  const tipY = p.tipYMm ?? PAD_TIP_Y_MM;
  return {
    Kind: 'box',
    Center: {
      x: sign * (innerX + p.depthXMm / 2),
      y: tipY - p.heightYMm / 2,
      z: (p.zFromMm + p.zToMm) / 2,
    },
    Size: { x: p.depthXMm / 2, y: p.heightYMm / 2, z: (p.zToMm - p.zFromMm) / 2 },
    Rotation: { x: 0, y: 0, z: 0 },
  };
}

interface Variant {
  id: string;
  /** Pad override, or undefined to keep the delivered finger block. */
  padShape?: (sign: 1 | -1) => Shape;
  /** Part mass, kg — undefined keeps the document's 0.3 kg. */
  massKg?: number;
  /** Jaw stroke commanded to clamp, mm. 0 = the nominal closed position. */
  clampMm: number;
  /** Jaw speed, mm/s — the rate at which the clamp setpoint advances. */
  jawSpeedMmS: number;
  /** Axis speed of the cycle, deg/s. */
  axisSpeedDegS: number;
  /**
   * Scale each axis's `TargetSpeed` by its share of the move, so all six
   * arrive together — a PTP move. See the descent study: without it the tool
   * leaves the straight line by 15.6 mm on the way down to the pick and the
   * pad shoves the part off its table before the jaws close.
   */
  coordinated: boolean;
  why: string;
}

/** Ids of the two finger nodes inside the delivered asset, from the document. */
const FINGER_IDS = ['9601a086-6029-5aa0-afad-245d7379c560', '640d7c84-3db3-5100-9fc7-91e1bfddd7c5'];

/**
 * The document's bytes with `variant` patched into them.
 *
 * The pad override goes into the SAME `AssetOverrides.byAddress` record the
 * document already uses for the jaw stroke and the axis speed, so what is
 * measured here is literally what a build-script change would produce. The part
 * mass is edited on the `ThreeStar` node itself — in both places it is stated,
 * `FreeBody.MassKg` and `MechanismBody.MassOverrideKg`, because the writer
 * prefers the explicit body override and a half-applied mass would be a silent
 * wrong measurement.
 */
function patchedDemoBytes(variant: Variant): ArrayBuffer {
  const glb = readGlb(readFileSync(DEMO_GLB));
  const json = glb.json as {
    nodes: { name?: string; extras?: { realvirtual?: Record<string, unknown> } }[];
  };
  if (variant.padShape) {
    const robot = json.nodes.find((n) => n.name === 'Robot');
    const rv = robot?.extras?.realvirtual as
      { AssetOverrides?: { byAddress?: Record<string, Record<string, unknown>> } } | undefined;
    const byAddress = rv?.AssetOverrides?.byAddress;
    if (!byAddress) throw new Error('the document lost its AssetOverrides.byAddress');
    FINGER_IDS.forEach((id, i) => {
      const key = `#${id}`;
      const entry = byAddress[key] ?? (byAddress[key] = {});
      // Left finger is the one with the POSITIVE pad centre in the asset.
      entry.CollisionShapeSet = {
        Shapes: [variant.padShape!(i === 0 ? 1 : -1)],
        ReplacesMesh: true,
      };
    });
  }
  if (variant.massKg !== undefined) {
    const star = json.nodes.find((n) => n.name === 'ThreeStar');
    const rv = star?.extras?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    if (!rv) throw new Error('the document lost its ThreeStar extras');
    rv.FreeBody.MassKg = variant.massKg;
    rv.MechanismBody.MassOverrideKg = variant.massKg;
  }
  // `rest` is the VERBATIM tail of the container (BIN chunk and anything behind
  // it), handed straight back — the meshes are untouched by this patch.
  const out = writeGlb(json, glb.rest) as Uint8Array;
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/** The library asset as bytes `GLTFLoader` parses in Node — see the measure test. */
let robotBytes: ArrayBuffer | null = null;
async function robotAssetBytes(): Promise<ArrayBuffer> {
  if (robotBytes) return robotBytes;
  const { dracoIO } = await import('../../scripts/lib/rv-glb-three.mjs');
  const io = await dracoIO() as {
    readBinary(data: Uint8Array): Promise<unknown>;
    writeBinary(doc: unknown): Promise<Uint8Array>;
  };
  const doc = await io.readBinary(new Uint8Array(readFileSync(ROBOT_GLB))) as {
    getRoot(): {
      listTextures(): { dispose(): void }[];
      listExtensionsUsed(): { extensionName: string; dispose(): void }[];
    };
  };
  for (const texture of doc.getRoot().listTextures()) texture.dispose();
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();
  }
  const out = await io.writeBinary(doc);
  robotBytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  return robotBytes;
}

const resolver: ReferenceResolver = async (ref) => {
  if (ref.assetId !== 'robots-fanuccrx-10ia-l' && !String(ref.path).endsWith('FanucCRX-10iA-L.glb')) {
    return null;
  }
  return { bytes: await robotAssetBytes(), url: 'library/Robots/FanucCRX-10iA-L.glb' };
};

interface LoadedDemo {
  scene: Scene;
  region: RVMuJoCoRegion;
  drives: RVDrive[];
  byName: Map<string, RVDrive>;
  part: Object3D;
  board: Object3D;
  gripLoad: RVGripLoad | null;
}

async function loadVariant(variant: Variant): Promise<LoadedDemo> {
  RVMuJoCoRegion.clearAll();
  const scene = new Scene();
  await loadGLB('demo-realvirtual/PegGameSetzkasten.glb', scene, {
    data: patchedDemoBytes(variant), referenceResolver: resolver,
  });
  const region = RVMuJoCoRegion.regions[0];
  expect(region, 'one WebMuJoCoRegion').toBeTruthy();
  const drives: RVDrive[] = [];
  const byName = new Map<string, RVDrive>();
  let gripLoad: RVGripLoad | null = null;
  let part: Object3D | null = null;
  let board: Object3D | null = null;
  scene.traverse((node) => {
    for (const inst of getComponentInstances(node)) {
      if (inst instanceof RVDrive) { drives.push(inst); byName.set(node.name, inst); }
      if (inst instanceof RVGripLoad) gripLoad = inst;
    }
    if (node.name === 'ThreeStar') part = node;
    if (node.name === 'Board') board = node;
  });
  expect(part, 'ThreeStar').toBeTruthy();
  expect(board, 'Board').toBeTruthy();
  return { scene, region, drives, byName, part: part!, board: board!, gripLoad };
}

// ─── The cycle ─────────────────────────────────────────────────────────────

function run(
  runtime: RVMuJoCoRegionRuntime, seconds: number, demo: LoadedDemo, grip?: RVGripLoad | null,
  probe?: () => void,
): number[] {
  const costs: number[] = [];
  const ticks = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    runtime.tick(FIXED_DT);
    costs.push(performance.now() - t0);
    for (const drive of demo.drives) drive.update(FIXED_DT);
    grip?.measure();
    probe?.();
  }
  return costs;
}

/**
 * Arm the six axes onto a joint vector; returns the largest joint step, deg.
 *
 * `coordinated` is the one option here that is not cosmetic. Without it every
 * axis gets the SAME `TargetSpeed`, so the axis with the smallest step arrives
 * first and the tool is dragged through a path nobody solved — measured below
 * as `max deviation from the straight line`. With it each axis's speed is
 * scaled by its own share of the largest step, so all six arrive together and
 * the move is a straight line IN JOINT SPACE, which is what a real robot
 * controller does with a PTP move.
 */
function commandJoints(
  demo: LoadedDemo, q: readonly number[], speedDegPerS: number, coordinated: boolean,
): number {
  let maxDelta = 0;
  const deltas: number[] = [];
  for (let i = 0; i < 6; i++) {
    const drive = demo.byName.get(AXIS_NAMES[i]);
    const d = drive ? Math.abs(q[i] - drive.currentPosition) : 0;
    deltas.push(d);
    maxDelta = Math.max(maxDelta, d);
  }
  for (let i = 0; i < 6; i++) {
    const drive = demo.byName.get(AXIS_NAMES[i]);
    if (!drive) continue;
    drive.targetSpeed = coordinated && maxDelta > 1e-9
      // A floor of 1 % keeps a near-zero axis from being given speed 0, which
      // would arm a ramp that never advances.
      ? speedDegPerS * Math.max(deltas[i] / maxDelta, 0.01)
      : speedDegPerS;
    drive.startMove(q[i]);
  }
  return maxDelta;
}

/** Arm the six axes onto a solved pose; returns the largest joint step, deg. */
function commandAxes(demo: LoadedDemo, poseId: string, speedDegPerS: number, coordinated = false): number {
  const q = POSES.poses[poseId]?.q;
  if (!q) throw new Error(`no solved pose "${poseId}"`);
  return commandJoints(demo, q, speedDegPerS, coordinated);
}

/** Arm the gripper's one cylinder setpoint — the two fingers are geared off it. */
function commandJaws(demo: LoadedDemo, strokeMm: number, speedMmS: number): void {
  const cylinder = demo.byName.get('SchunkEGH80Gripper');
  if (!cylinder) throw new Error('no gripper cylinder drive');
  cylinder.targetSpeed = speedMmS;
  cylinder.startMove(strokeMm);
}

interface Attempt {
  variant: Variant;
  /** Part Y after the settle, before anything moves, m. */
  partYSettled: number;
  heldAfterClamp: boolean;
  clampNAtPick: number;
  /** Part Y at the end of the carry (at the approach pose), m. */
  partYAtApproach: number;
  /** Did the part still sit in the jaws at the approach? */
  heldAtApproach: boolean;
  clampNAtApproach: number;
  /** Part Y while the tool presses, m. */
  partYPressed: number;
  /** Part Y two seconds after the release, m. */
  partYFinal: number;
  slipMm: number;
  maxFollowErrDeg: number;
  boardMovedMm: number;
  /** Highest the part's centre ever reached, m — how far the carry got. */
  maxPartY: number;
  /** Largest clamping force seen at any tick of the carry, N. */
  maxCarryN: number;
  /** Tick at which the carry lost the part, counted from the clamp; -1 = kept. */
  lostAtTick: number;
  /** The verdict: did the part's centre end below the board's underside? */
  inserted: boolean;
  p95CostMs: number;
}

/**
 * Pick, carry, press, release — the document's own 13 steps, headless.
 *
 * `moveTo` waits for the TRAVEL rather than for `isAtTarget`, for the reason
 * the measure test records: on a dynamic axis `isAtTarget` compares against the
 * ramp's own output and is satisfied one tick after every ramp step.
 */
async function attempt(variant: Variant, insertPose = 'insert', approachPose = 'approach'): Promise<Attempt> {
  const demo = await loadVariant(variant);
  const runtime = await RVMuJoCoRegionRuntime.create({
    region: demo.region, drives: demo.drives, report: false,
  });
  try {
    const grip = demo.gripLoad;
    const speed = variant.axisSpeedDegS;
    // Per-tick watch over the whole run: the END of a phase cannot tell a part
    // that was never lifted from one that was carried 180 mm and dropped — the
    // dropped one lands back on its table at exactly the height it started.
    let maxPartY = -Infinity;
    let maxCarryN = 0;
    let carryTick = -1;
    let lostAtTick = -1;
    let watching = false;
    const probe = (): void => {
      maxPartY = Math.max(maxPartY, demo.part.position.y);
      if (!watching) return;
      carryTick++;
      const f = grip?.measuredForce ?? NaN;
      if (Number.isFinite(f)) maxCarryN = Math.max(maxCarryN, f);
      if (lostAtTick < 0 && !grip?.heldPart) lostAtTick = carryTick;
    };
    const moveTo = (poseId: string): number[] => {
      const maxDelta = commandAxes(demo, poseId, speed, variant.coordinated);
      return run(runtime, maxDelta / speed + 0.5, demo, grip, probe);
    };
    commandJaws(demo, JAW_OPEN_MM, 50);
    run(runtime, 0.5, demo, grip, probe);
    const partYSettled = demo.part.position.y;

    moveTo('lift');
    moveTo('pick');
    run(runtime, 0.5, demo, grip, probe);

    // Clamp — the one parameter pair this study varies most.
    commandJaws(demo, variant.clampMm, variant.jawSpeedMmS);
    run(runtime, Math.abs(variant.clampMm - JAW_OPEN_MM) / variant.jawSpeedMmS + 0.8, demo, grip, probe);
    const heldAfterClamp = Boolean(grip?.heldPart);
    const clampNAtPick = grip?.measuredForce ?? NaN;
    // From here on every tick is watched: this is the carry.
    maxPartY = demo.part.position.y;
    watching = true;

    moveTo('lift');
    moveTo(approachPose);
    const partYAtApproach = demo.part.position.y;
    const heldAtApproach = Boolean(grip?.heldPart);
    const clampNAtApproach = grip?.measuredForce ?? NaN;

    // Press, slowly, and then HOLD — where the jam would show.
    commandAxes(demo, insertPose, 10, variant.coordinated);
    const pressCosts = run(runtime, 3.0, demo, grip, probe);
    const maxFollowErrDeg = Math.max(...AXIS_NAMES.map(
      (n) => Math.abs(demo.byName.get(n)?.followingError ?? 0),
    ));
    const slipMm = grip ? grip.measure() : NaN;
    const partYPressed = demo.part.position.y;

    watching = false;
    commandJaws(demo, JAW_OPEN_MM, 50);
    run(runtime, 2.0, demo, grip, probe);
    const partYFinal = demo.part.position.y;

    const sorted = [...pressCosts].sort((a, b) => a - b);
    return {
      variant,
      partYSettled,
      heldAfterClamp,
      clampNAtPick,
      partYAtApproach,
      heldAtApproach,
      clampNAtApproach,
      partYPressed,
      partYFinal,
      slipMm,
      maxFollowErrDeg,
      boardMovedMm: Math.hypot(
        demo.board.position.x - POSES.layout.boardOriginXZ[0],
        demo.board.position.z - POSES.layout.boardOriginXZ[1],
      ) * 1000,
      maxPartY,
      maxCarryN,
      lostAtTick,
      inserted: partYFinal < POSES.layout.boardTopYM - 0.012,
      p95CostMs: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? NaN,
    };
  } finally {
    runtime.dispose();
  }
}

function report(a: Attempt): void {
  const mm = (m: number) => (m * 1000).toFixed(1).padStart(7);
  // eslint-disable-next-line no-console
  console.log(
    `[${a.variant.id.padEnd(22)}] settled ${mm(a.partYSettled)} approach ${mm(a.partYAtApproach)} `
    + `pressed ${mm(a.partYPressed)} final ${mm(a.partYFinal)} mm | `
    + `clamp ${a.clampNAtPick.toFixed(1).padStart(6)}/${a.clampNAtApproach.toFixed(1).padStart(6)} N `
    + `held ${a.heldAfterClamp ? 'Y' : 'n'}${a.heldAtApproach ? 'Y' : 'n'} `
    + `slip ${Number.isFinite(a.slipMm) ? a.slipMm.toFixed(1).padStart(6) : '   n/a'} mm | `
    + `maxY ${mm(a.maxPartY)} carryN ${a.maxCarryN.toFixed(0).padStart(4)} lostAt ${String(a.lostAtTick).padStart(5)} | `
    + `followErr ${a.maxFollowErrDeg.toFixed(3)} deg board ${a.boardMovedMm.toFixed(1)} mm | `
    + `p95 ${a.p95CostMs.toFixed(2)} ms | INSERTED=${a.inserted ? 'YES' : 'no'}`,
  );
}

// ─── The variants ──────────────────────────────────────────────────────────

/** The document exactly as it ships today: the reference every row is read against. */
const BASELINE: Variant = {
  id: 'as-shipped',
  clampMm: 0,
  jawSpeedMmS: 50,
  axisSpeedDegS: 25,
  coordinated: false,
  why: 'the document as it stands: whole finger block, uncoordinated axes, clamp at the nominal closed position',
};

/**
 * The one change the descent study below identified, and nothing else.
 *
 * Six `LogicStep_SetDriveSpeed` steps ahead of each `DriveTo` group is all the
 * document needs for it — the component exists and sets `targetSpeed`
 * immediately.
 */
const COORD: Variant = {
  ...BASELINE,
  id: 'coordinated',
  coordinated: true,
  why: 'PTP: each axis scaled to arrive with the slowest one. Nothing else changed',
};

/**
 * (a) as literally stated: the pad instead of the block.
 *
 * Inner face and tip unchanged — every solved pose is measured off them — and
 * the block shrunk from 52 x 94 x 33 to 6 x 24 x 33 mm. The CONTACT is
 * identical by construction (see the header), so this row is the control that
 * says so rather than a candidate fix.
 */
const COORD_PAD_SLIM: Variant = {
  ...COORD,
  id: 'coord+pad-slim',
  padShape: (s) => pad(s, { depthXMm: 6, heightYMm: 24, zFromMm: -16.551, zToMm: 16.551 }),
  why: 'slim pad, same inner face / tip / Z extent — clearance only, contact unchanged',
};

/**
 * (a) with the one pad change that has a mechanical argument behind it: the
 * patch covers the WHOLE gripped arm instead of two thirds of it.
 *
 * The arm spans z -20…+30 mm in the jaw frame (hub 20 mm back, arm 50 mm long),
 * and the part's centre of mass hangs 20 mm out along -Z, so the friction
 * couple that carries that moment acts over exactly this extent.
 */
const COORD_PAD_LONG: Variant = {
  ...COORD,
  id: 'coord+pad-long',
  padShape: (s) => pad(s, { depthXMm: 6, heightYMm: 24, zFromMm: -19, zToMm: 29 }),
  why: 'slim pad extended along the arm: 48 mm of patch instead of 33, bigger friction couple',
};

/**
 * (b) WITHOUT touching `rv-drive.ts`: the ramp rate is already a property.
 *
 * The plan's `forcefit` rule says the jaws are commanded CLOSED PAST the part
 * and the actuator's own force range is what the part feels. The previous run
 * measured that this ejects the part — at 50 mm/s, which advances the setpoint
 * 0.83 mm per 60 Hz tick while the measured contact compliance is 0.7 mm, i.e.
 * one tick steps clean over it. The same command at 3 mm/s advances 0.05 mm per
 * tick, which is the same limiting idea as a ramp limiter in the drive loop,
 * expressed as the property it already is.
 */
const COORD_FORCEFIT: Variant = {
  ...COORD,
  id: 'coord+forcefit',
  clampMm: 15,
  jawSpeedMmS: 3,
  why: 'clamp past the part (full stroke) but at 3 mm/s: 0.05 mm per tick, under the compliance',
};

const COORD_PAD_LONG_FORCEFIT: Variant = {
  ...COORD_PAD_LONG,
  id: 'coord+pad-long+ff',
  clampMm: 15,
  jawSpeedMmS: 3,
  why: 'the descent fix and both grip levers together',
};

/** (c), last, and only together with whatever else helped. */
const COORD_LIGHT: Variant = {
  ...COORD,
  id: 'coord+0.2kg',
  massKg: 0.2,
  why: 'and the part at the light end of its window',
};

/**
 * (b) again, on the AXES this time: the carry's own ramp rate.
 *
 * The plan measured this on the axes and it is the reason the document sits at
 * 25 deg/s: at 100 deg/s the grip is gone in the first tick of the lift, at
 * 10 deg/s the same grip carried the part 180 mm. The arithmetic behind it —
 * 25 deg/s is 0.42 deg per 60 Hz tick, which at the 2.8 m reach of this pose is
 * about 1.2 mm of tool travel, against a contact that gives 0.7 mm at 42 N —
 * says 25 deg/s is still over the line and 10 is only just under it. These rows
 * walk it down WITH the stronger clamp, which widens the compliance window
 * (100 N / 60 N per mm is 1.7 mm of give instead of 0.7).
 */
const COORD_FF_SLOW_AXES: Variant[] = [10, 5, 2].map((v) => ({
  ...COORD_FORCEFIT,
  id: `coord+ff+${v}deg/s`,
  axisSpeedDegS: v,
  why: `the whole cycle at ${v} deg/s: the setpoint advances ${(v / 60 * 48).toFixed(2)} mm per tick at the tool`,
}));

/**
 * The clamp as a SQUEEZE, between "just touching" and "crushing through".
 *
 * MEASURED why full stroke is not it: traced at 10 deg/s, the two fingers sit
 * at +6.4 mm of stroke while the geometric contact is at -1.5 mm — the pads
 * have pushed 8 mm INTO a 20 mm part, the actuator saturated at 100 N the whole
 * time, and at tick 204 the right jaw popped to +14.3 mm and the part fell out
 * the other side. That is the plan's "squirted out" with a mechanism attached:
 * `forcefit` over a 1.5 mm interference has no travel to build the force over,
 * so the servo error is 16 mm and the contact constraint simply loses.
 *
 * The usable range follows from the two measured stiffnesses: the jaw
 * actuator's Kp is 50 N/mm and the contact gives 0.7 mm at 42 N, i.e. about
 * 60 N/mm. A command `s` mm past the nominal closed position settles where
 * 50*(1.5 + s - p) = 60*p, so s = 0 gives 42 N (which is what was measured),
 * s = 1.5 about 82 N, and s = 2.2 saturates. These rows walk that range at a
 * jaw speed whose per-tick step (0.05 mm) stays under the contact's own give.
 */
const COORD_SQUEEZE: Variant[] = [0, 1.5].flatMap((clamp) => [10, 5].map((axis) => ({
  ...COORD,
  id: `coord+clamp${clamp}+${axis}deg/s`,
  clampMm: clamp,
  jawSpeedMmS: 3,
  axisSpeedDegS: axis,
  why: `squeeze ${clamp} mm past the nominal closed position at 3 mm/s, cycle at ${axis} deg/s`,
})));

/** The squeeze plus each of the remaining levers, once. */
const COORD_SQUEEZE_PAD: Variant = {
  ...COORD_PAD_LONG,
  id: 'coord+clamp1.5+pad-long',
  clampMm: 1.5,
  jawSpeedMmS: 3,
  axisSpeedDegS: 10,
  why: 'the squeeze plus the long pad',
};
const COORD_SQUEEZE_LIGHT: Variant = {
  ...COORD,
  id: 'coord+clamp1.5+0.2kg',
  clampMm: 1.5,
  jawSpeedMmS: 3,
  axisSpeedDegS: 10,
  massKg: 0.2,
  why: 'the squeeze plus the light part',
};

// ─── The descent study: why the jaws never reach the part ──────────────────
//
// MEASURED 2026-10-25, and it is upstream of every pad, force and mass
// question: the joint move from `lift` (200 mm above the pick) to `pick`
// carries the tool 15.6 mm away from the straight line between the two poses.
// The jaws open to 33 mm against a 20 mm arm, i.e. 6.5 mm of clearance per
// flank, so a 15.6 mm excursion means the pad arrives THROUGH the part: the
// part was shoved 32 mm across its table before the jaws closed, and another
// 48 mm by the closing jaws. `held=NO`, `clamp 0.0 N` — which is exactly what
// the committed `phase5-demo-measure` test prints today as well.
//
// WHY the tool leaves the line: every axis gets the same `TargetSpeed` and runs
// its OWN ramp, so the axis with the smallest step arrives first. lift -> pick
// is A2 8.2 deg, A3 13.6 deg, A5 21.7 deg, A6 0 deg: three axes stop while the
// fourth is still running and the tool is dragged along a path nobody solved.
//
// Two fixes are measurable without touching `rv-drive.ts` and without a new IK
// solution, because both are expressible in what the document already writes:
//
//  - COORDINATED arrival: each axis's `TargetSpeed` scaled by its own share of
//    the largest step, so all six finish together. A PTP move, as a controller
//    does it. In the document this is a per-step speed.
//  - SPLITTING the move: the same joint-space line walked in N commanded steps.
//    Each step's arrival mismatch is 1/N of the whole, and no new pose has to
//    be solved — the intermediate joint vectors are interpolations of two
//    already-solved ones, so the pose file stays bit-identical.
describe('plan-673 Phase 5 — the descent, and why the jaws miss the part', () => {
  it('measures tool deviation and part displacement per descent strategy', async () => {
    interface Strategy { id: string; steps: number; coordinated: boolean }
    const strategies: Strategy[] = [
      { id: 'as-shipped (1 step, uncoordinated)', steps: 1, coordinated: false },
      { id: '1 step, coordinated', steps: 1, coordinated: true },
      { id: '4 steps, uncoordinated', steps: 4, coordinated: false },
      { id: '4 steps, coordinated', steps: 4, coordinated: true },
      { id: '10 steps, coordinated', steps: 10, coordinated: true },
    ];
    for (const st of strategies) {
      const demo = await loadVariant(BASELINE);
      const runtime = await RVMuJoCoRegionRuntime.create({
        region: demo.region, drives: demo.drives, report: false,
      });
      try {
        const grip = demo.gripLoad;
        let gripperNode: Object3D | null = null;
        demo.scene.traverse((n) => { if (n.name === 'SchunkEGH80Gripper') gripperNode = n; });
        const toolPos = (): [number, number, number] => {
          demo.scene.updateMatrixWorld(true);
          const m = (gripperNode as unknown as Object3D).matrixWorld.elements;
          return [m[12], m[13], m[14]];
        };
        const partXZ = (): [number, number] => [demo.part.position.x, demo.part.position.z];

        commandJaws(demo, JAW_OPEN_MM, 50);
        run(runtime, 0.5, demo, grip);
        // Up to `lift` first — the part is nowhere near this one.
        const toLift = commandAxes(demo, 'lift', 25, st.coordinated);
        run(runtime, toLift / 25 + 1.0, demo, grip);
        const partBefore = partXZ();

        // The descent under test, as `steps` commanded joint-space steps.
        const from = AXIS_NAMES.map((n) => demo.byName.get(n)!.currentPosition);
        const target = POSES.poses.pick.q;
        const lineFrom = toolPos();
        const samples: [number, number, number][] = [];
        for (let k = 1; k <= st.steps; k++) {
          const q = from.map((a, i) => a + (target[i] - a) * (k / st.steps));
          const delta = commandJoints(demo, q, 25, st.coordinated);
          const ticks = Math.round((delta / 25 + 0.3) / FIXED_DT);
          for (let i = 0; i < ticks; i++) {
            runtime.tick(FIXED_DT);
            for (const d of demo.drives) d.update(FIXED_DT);
            grip?.measure();
            samples.push(toolPos());
          }
        }
        const lineTo = samples[samples.length - 1];
        const dir = [lineTo[0] - lineFrom[0], lineTo[1] - lineFrom[1], lineTo[2] - lineFrom[2]];
        const len2 = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2] || 1;
        let maxOff = 0;
        for (const s of samples) {
          const v = [s[0] - lineFrom[0], s[1] - lineFrom[1], s[2] - lineFrom[2]];
          const t = (v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) / len2;
          maxOff = Math.max(maxOff, Math.hypot(
            s[0] - (lineFrom[0] + dir[0] * t),
            s[1] - (lineFrom[1] + dir[1] * t),
            s[2] - (lineFrom[2] + dir[2] * t),
          ));
        }
        const partAtPick = partXZ();
        const shovedMm = Math.hypot(partAtPick[0] - partBefore[0], partAtPick[1] - partBefore[1]) * 1000;

        run(runtime, 0.4, demo, grip);
        commandJaws(demo, 0, 50);
        run(runtime, 1.0, demo, grip);
        const clampN = grip?.measuredForce ?? NaN;
        const held = Boolean(grip?.heldPart);
        // eslint-disable-next-line no-console
        console.log(
          `[descent ${st.id.padEnd(36)}] tool deviation ${(maxOff * 1000).toFixed(1).padStart(6)} mm | `
          + `part shoved ${shovedMm.toFixed(1).padStart(6)} mm | after clamp: held ${held ? 'YES' : 'no '} `
          + `F ${clampN.toFixed(2).padStart(7)} N | q err ${AXIS_NAMES.map(
            (n, i) => Math.abs(demo.byName.get(n)!.currentPosition - target[i]).toFixed(2),
          ).join('/')} deg`,
        );
      } finally {
        runtime.dispose();
      }
    }
    expect(true).toBe(true);
  }, 900_000);
});

describe('plan-673 Phase 5 — what makes the grip reach the board', () => {
  it('sweeps the three named candidates and names the one that inserts', async () => {
    const variants = [
      BASELINE, COORD, COORD_PAD_SLIM, COORD_PAD_LONG,
      COORD_FORCEFIT, COORD_PAD_LONG_FORCEFIT, COORD_LIGHT,
      ...COORD_FF_SLOW_AXES, ...COORD_SQUEEZE, COORD_SQUEEZE_PAD, COORD_SQUEEZE_LIGHT,
    ];
    const results: Attempt[] = [];
    for (const v of variants) {
      const a = await attempt(v);
      results.push(a);
      report(a);
    }
    // eslint-disable-next-line no-console
    console.log('\n[why] ' + results.map((r) => `${r.variant.id}: ${r.variant.why}`).join('\n[why] '));
    // Recorded, not gated: the point of the file is the table. The one thing
    // asserted is that the harness measured something at all.
    expect(results.every((r) => Number.isFinite(r.partYFinal))).toBe(true);
  }, 1_200_000);
});

// ─── Why the carry loses the part after about 3.6 s ────────────────────────
//
// The sweep above splits the failure in two, and the split is the finding:
//
//  - at 25 deg/s the grip is gone at tick 9 of the carry, 14 mm off the table,
//    and the clamping force makes NO difference (44 N and 100 N both fail at
//    tick 9) — that is the setpoint ramp stepping over the contact, the effect
//    the plan already measured at 100 deg/s;
//  - at 10, 5 and 2 deg/s the grip survives the lift and is lost at tick
//    216-221 in ALL THREE, i.e. after the same 3.6 s of wall-clock holding
//    while the distance travelled differs by a factor of four (191 mm, 148 mm,
//    46 mm). A loss at a fixed TIME and not at a fixed DISTANCE is not a ramp
//    problem; something creeps.
//
// This trace follows the carry tick by tick to say WHAT creeps: the jaws
// (an actuator that gives way) or the part (friction losing to the moment).
describe('plan-673 Phase 5 — what creeps during the carry', () => {
  it('traces jaws, part and force through a slow carry', async () => {
    const variant: Variant = { ...COORD_FORCEFIT, id: 'trace', axisSpeedDegS: 10 };
    const demo = await loadVariant(variant);
    const runtime = await RVMuJoCoRegionRuntime.create({
      region: demo.region, drives: demo.drives, report: false,
    });
    try {
      const grip = demo.gripLoad!;
      const cyl = demo.byName.get('SchunkEGH80Gripper')!;
      const lf = demo.byName.get('LeftFinger')!;
      const rf = demo.byName.get('RightFinger')!;
      const gripper = demo.byName.get('SchunkEGH80Gripper') ? (() => {
        let n: Object3D | null = null;
        demo.scene.traverse((o) => { if (o.name === 'SchunkEGH80Gripper') n = o; });
        return n as unknown as Object3D;
      })() : null;
      /** The part's position in the JAW frame, mm — where it sits in the grip. */
      const inJaw = (): [number, number, number] => {
        if (!gripper) return [NaN, NaN, NaN];
        gripper.updateWorldMatrix(true, false);
        demo.part.updateWorldMatrix(true, false);
        const v = demo.part.position.clone().setFromMatrixPosition(demo.part.matrixWorld);
        gripper.worldToLocal(v);
        return [v.x * 1000, v.y * 1000, v.z * 1000];
      };
      const moveTo = (poseId: string): void => {
        const d = commandAxes(demo, poseId, variant.axisSpeedDegS, true);
        run(runtime, d / variant.axisSpeedDegS + 0.5, demo, grip);
      };
      commandJaws(demo, JAW_OPEN_MM, 50);
      run(runtime, 0.5, demo, grip);
      moveTo('lift');
      moveTo('pick');
      run(runtime, 0.5, demo, grip);
      commandJaws(demo, variant.clampMm, variant.jawSpeedMmS);
      run(runtime, Math.abs(variant.clampMm - JAW_OPEN_MM) / variant.jawSpeedMmS + 0.8, demo, grip);

      // The carry, traced.
      const d = commandAxes(demo, 'lift', variant.axisSpeedDegS, true);
      let tick = 0;
      const line = (): void => {
        const j = inJaw();
        // eslint-disable-next-line no-console
        console.log(
          `[carry t${String(tick).padStart(4)}] partY ${(demo.part.position.y * 1000).toFixed(1).padStart(7)} `
          + `inJaw ${j.map((v) => v.toFixed(2).padStart(8)).join(',')} mm | `
          + `cyl ${cyl.currentPosition.toFixed(3).padStart(7)} L ${lf.currentPosition.toFixed(3).padStart(7)} `
          + `R ${rf.currentPosition.toFixed(3).padStart(7)} | F ${grip.measuredForce.toFixed(1).padStart(6)} N `
          + `held ${grip.heldPart ? 'Y' : 'n'} slip ${grip.slipMm.toFixed(2).padStart(6)} mm `
          + `ncon ${runtime.world.readContacts().length}`,
        );
      };
      // Whether the slip reading can mean anything at all: `RVGripLoad.measure()`
      // reads `part.matrixWorld`, and `updateWorldMatrix` rebuilds the local
      // matrix only when `matrixAutoUpdate` is on.
      // eslint-disable-next-line no-console
      console.log(
        `[carry] part matrixAutoUpdate=${demo.part.matrixAutoUpdate} `
        + `matrixWorldAutoUpdate=${demo.part.matrixWorldAutoUpdate}`,
      );
      line();
      const ticks = Math.round((d / variant.axisSpeedDegS + 2.0) / FIXED_DT);
      for (let i = 0; i < ticks; i++) {
        runtime.tick(FIXED_DT);
        for (const dr of demo.drives) dr.update(FIXED_DT);
        grip.measure();
        tick++;
        if (tick % 20 === 0 || (tick > 200 && tick < 240)) line();
        if (!grip.heldPart && tick > 5) { line(); break; }
      }
      expect(true).toBe(true);
    } finally {
      runtime.dispose();
    }
  }, 600_000);
});
