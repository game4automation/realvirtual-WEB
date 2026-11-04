// plan-673 Phase 1 — the hand-written MJCF of the peg game ("Steckspiel").
//
// Everything here is a DECLARATION, and every number says where it comes from.
// Four origins, kept apart on purpose (plan 2.2 E/E2):
//
//   [GLB]       read out of the shipped library part
//               `public/library/Robots/FanucCRX-10iA-L.glb` (sha256 ec33e76f… at
//               the time of this measurement; Phase 4b authored physics extras
//               into the same file, which left the geometry bytes untouched but
//               changed the file hash to 962336b0…), node-local
//               translations/quaternions, verbatim.
//   [DATASHEET] Fanuc CRX-10iA/L / Schunk EGH 80 catalogue, via the Phase-0 gate.
//   [DERIVED]   computed here or measured out of the model itself (the static
//               holding torque via `qfrc_bias` — the RNEA term of plan-412).
//   [DECLARED]  a choice. Not measured, not from a datasheet. Named as such.
//
// Scope of this file: a COST measurement. It is not the Phase-5 demo and it is
// not the Phase-3 writer's golden (that comes later, against this file).

/** Degrees → radians. */
const rad = (deg: number): number => (deg * Math.PI) / 180;

// ─── The robot, transcribed from the library GLB ─────────────────────────────
//
// [GLB] node-local translations in metres and the glTF quaternion of A1,
// converted to MuJoCo order (glTF stores [x,y,z,w], MJCF wants [w,x,y,z]).
// Axis per node from `Drive.Direction` in its `rv_extras`.
//
//   A1  RotationY   quat glTF [0, .70711, 0, .70711]  → MJCF [.70711, 0, .70711, 0]
//   A2  RotationZ   pos (0, 0.245, 0)
//   A3  RotationZ   pos (0, 0.710, 0)
//   A4  RotationX   pos (0.150, 0, 0)
//   A5  RotationZ   pos (0.390, 0, 0)
//   A6  RotationX   pos (0.100, 0, 0.150)
//   TCP             pos (0.060, 0, 0)  quat glTF [-.5, .5, -.5, .5]
//
// Cross-check that this is the real robot and not a plausible invention:
// 0.710 + 0.150 + 0.390 + 0.100 + 0.060 = 1.410 m, against the datasheet's
// 1418 mm reach. Every `Drive` in the part carries `ReverseDirection: true`;
// that is a Drive-side sign convention and has no meaning for MuJoCo, where
// the axis vector itself carries the sign.
export const CRX_AXES = [
  { name: 'A1', pos: [0, 0, 0], quat: [0.7071068, 0, 0.7071068, 0], axis: [0, 1, 0] },
  { name: 'A2', pos: [0, 0.245, 0], quat: null, axis: [0, 0, 1] },
  { name: 'A3', pos: [0, 0.710, 0], quat: null, axis: [0, 0, 1] },
  { name: 'A4', pos: [0.150, 0, 0], quat: null, axis: [1, 0, 0] },
  { name: 'A5', pos: [0.390, 0, 0], quat: null, axis: [0, 0, 1] },
  { name: 'A6', pos: [0.100, 0, 0.150], quat: null, axis: [1, 0, 0] },
] as const;

/**
 * [DATASHEET + DECLARED] per-link mass in kg.
 *
 * The SUM is the datasheet figure (CRX-10iA/L, 39 kg); the DISTRIBUTION is
 * declared — mass concentrated low, as in every cobot. Phase 0 named exactly
 * this calibration step as missing from the plan: Mirtich gives the
 * distribution from the geometry, the datasheet mass fixes the sum. Here the
 * split is declared and the sum is honoured; Phase 4b replaces the split with
 * the real per-link volumes of the library part.
 *
 * `base` is world-fixed and therefore loads no joint; it is listed so the sum
 * is checkable against the 39 kg.
 */
export const CRX_LINK_MASS_KG = {
  base: 12.0,
  A1: 8.0,
  A2: 7.0,
  A3: 5.0,
  A4: 3.5,
  A5: 2.0,
  A6: 1.0,
  gripper: 0.5,
} as const;

/** [DECLARED] joint damping, N·m·s/rad. Taken from the UR10e in MuJoCo
 *  Menagerie (10 / 5 / 2 on the first three axes — the only comparable arm
 *  Menagerie carries, Phase 0) and continued downward for J4–J6. The CRX
 *  datasheet gives nothing here; this is a starting value, not a measurement. */
export const CRX_JOINT_DAMPING = [10, 5, 2, 2, 1, 1] as const;

/** [DECLARED] reflected rotor inertia, kg·m². The UR models in Menagerie carry
 *  a BLANKET 0.1 on all six axes (Phase 0 finding) — the single value whose
 *  absence you notice numerically. Declared, not measured. */
export const CRX_ARMATURE = 0.1;

/** [DECLARED] position-servo gains. UR10e's kp 5000 / kv 500 for the three
 *  main axes, scaled down for the wrist, whose force limits are an order
 *  smaller. Free parameters even in Menagerie (its UR README picks them). */
export const CRX_KP = [5000, 5000, 5000, 500, 500, 500] as const;
export const CRX_KV = [500, 500, 500, 50, 50, 50] as const;

// ─── Gripper ─────────────────────────────────────────────────────────────────
//
// [GLB] `SchunkEGH80Gripper` carries `Drive_Cylinder` with MinPos 0 / MaxPos 15
// (mm) and TimeOut/TimeIn 0.3 s; the jaws carry `Drive` (LinearX, one reversed)
// + `Drive_Gear` with `GearFactor: 1` and `MasterDrive` → the gripper's own
// Drive. So: one setpoint, two jaws, gear ratio 1 — exactly the Robotiq pattern
// Phase 0 confirmed (ONE actuator on a `<tendon fixed coef=0.5>` PLUS an
// `<equality joint polycoef>`, not "either/or").
//
// [DATASHEET] Schunk EGH 80: 50–100 N total grip force. Phase 0 flagged that
// the library part contradicts the catalogue on stroke (15 mm vs 40 mm/jaw) and
// on time (0.3 s vs 0.8 s). THE LIBRARY PART WINS HERE, because it is the part
// that ships; the contradiction is reported, not silently resolved.
/** [DATASHEET] total grip force, N — catalogue upper bound. */
export const GRIP_FORCE_TOTAL_N = 100;
/** [DECLARED] jaw-pad friction. Phase 0's verified calculation: the PAD
 *  FRICTION decides the holding capability by a factor of 7, not the grip
 *  force. 0.5 = a gripping pad, deliberately not the MuJoCo default 1.0. */
export const PAD_FRICTION = 0.5;

/**
 * [DECLARED] torsional friction of the pads, m — and a MEASURED necessity.
 *
 * MuJoCo's default `condim` is 3: normal plus two tangential directions, and
 * **no torsional friction at all**. With it, the gripped part is free to spin
 * about the pad normal: measured on the first full run, the three-star rotated
 * out of its pads inside five seconds and was re-caught on two DIFFERENT arms
 * (the contact list went from both pads on `part_arm0` to `pad_l` on
 * `part_arm1` and `pad_r` on `part_arm2`), which silently turned a `fits` run
 * into a jammed one.
 *
 * So the pads carry `condim="4"`. This is the plan's own argument about
 * `friction` + `condim` (2.2 D) hitting the very first scene that needs it —
 * and the same shape of finding as plan-659's ball that flew 8.46 m instead of
 * 0.38 m without rolling friction.
 */
export const PAD_TORSIONAL_FRICTION_M = 0.01;

/**
 * [DECLARED] stiffness of the gripper servo, N/m of tendon error.
 *
 * Deliberately high, and the reason is the modelling pattern rather than the
 * number: the jaws are commanded to CLOSE FULLY, past the part, and the
 * actuator's `forcerange` — the catalogue grip force — is what the part
 * actually feels. That is the plan's `forcefit` mode expressed in MJCF, and it
 * is the only way the grip force is a datasheet value rather than an artefact
 * of a servo gain.
 *
 * Measured why it matters: at kp 4000 with 2.5 mm of commanded over-travel the
 * jaws produced 10 N, a tenth of the catalogue figure, and the part slid 24 mm
 * down out of the pads during the settle.
 */
export const GRIP_KP = 50000;

/** [GLB] jaw stroke per jaw, m — `Drive_Cylinder.MaxPos` = 15 mm on the
 *  library part, rounded up to the 15.5 mm the jaw joints were given so the
 *  pads can close past a 20 mm arm. The catalogue says 40 mm per jaw; THE
 *  LIBRARY PART WINS, and the contradiction is reported (Phase 0). */
export const JAW_STROKE_M = 0.0155;

// ─── The part: the stylised realvirtual three-star ───────────────────────────
//
// [DECLARED, Phase 0] a STYLISED isosceles three-star: three identical
// rectangular arms at 120°, in ONE plane. NOT the literal silhouette of the
// isometric logo — that is a 12-gon whose arms have unequal effective width,
// which destroys the single-parameter clearance the segmented board needs.
export interface PartGeometry {
  /** Arm length from the hub, m. */
  armLenM: number;
  /** Arm width, m — the dimension the clearance is measured against. */
  armWidthM: number;
  /** Plate thickness, m. */
  thicknessM: number;
  /** Mass, kg. */
  massKg: number;
}

/** [DECLARED] L = 50 mm, w = 20 mm, t = 25 mm, 0.3 kg.
 *
 *  The mass is NOT free: Phase 0 showed the Schunk EGH 80 holds 0.5–1.0 kg
 *  depending on pad friction and recommended 0.2–0.5 kg for this part, so that
 *  "the part slips through" is producible on purpose rather than by accident.
 *  0.3 kg sits in the middle of that window.
 *
 *  The THICKNESS is not free either, and that is a Phase-1 finding: a parallel
 *  gripper holds this part on its arm FLANKS, i.e. on faces whose height IS the
 *  plate thickness. Whatever the pads cover cannot enter the slot, because the
 *  pads sit directly outside the arm flank and the slot is only one clearance
 *  wider. So the usable insertion travel is `thickness − pad height`, and a
 *  12 mm plate with 12 mm pads has travel ZERO. 25 mm with 10 mm pads leaves
 *  15 mm, which clears the 12 mm board. */
export const DEFAULT_PART: PartGeometry = {
  armLenM: 0.050,
  armWidthM: 0.020,
  thicknessM: 0.035,
  massKg: 0.3,
};

/** [DECLARED] how high the board's foot lifts its underside off the floor, m.
 *  Not decoration: the part protrudes BELOW the board once it has passed
 *  through, so a board lying flat on the floor turns every successful insertion
 *  into a part/floor contact instead of a pass-through. */
export const BOARD_FOOT_HEIGHT_M = 0.015;

/**
 * Principal inertia of the three-star about its own hub, kg·m².
 *
 * Three boxes at 120°, each of mass m/3 with its centre at L/2 along its own
 * axis; parallel-axis for the offset, then summed over the three orientations
 * (in-plane terms average to 3/2 of the per-arm sum by the 120° symmetry).
 * The thin-plate check Izz ≈ Ixx + Iyy holds to the thickness term.
 */
export function partDiagInertia(p: PartGeometry): [number, number, number] {
  const m = p.massKg / 3;
  const L = p.armLenM;
  const w = p.armWidthM;
  const t = p.thicknessM;
  const iAlong = (m / 12) * (w * w + t * t);        // about the arm's own axis
  const iAcross = (m / 12) * (L * L + t * t);       // in-plane, across the arm
  const iNormal = (m / 12) * (L * L + w * w);       // about the plate normal
  const d2 = (L / 2) * (L / 2);
  const inPlane = 1.5 * (iAcross + m * d2 + iAlong);
  const normal = 3 * (iNormal + m * d2);
  return [inPlane, inPlane, normal];
}

// ─── The board ───────────────────────────────────────────────────────────────

export interface BoardGeometry {
  /** Plate half-thickness, m. */
  halfThickM: number;
  /** Wall thickness of each segment, m. */
  wallM: number;
  /** Clearance PER FLANK between arm flank and slot wall, m — the main dial of
   *  the parameter study (plan 3.1: 0.5 mm easy, 0.1 mm only with a chamfer). */
  clearanceM: number;
  /** Radius of the round hole (the wrong-shape target), m. */
  roundHoleRadiusM: number;
  /** Mass, kg — the tuning parameter of the whole case (plan 3.3). */
  massKg: number;
}

export const DEFAULT_BOARD: BoardGeometry = {
  halfThickM: 0.006,   // 12 mm plate — thinner than the part's 20 mm free protrusion
  wallM: 0.015,
  clearanceM: 0.0005,
  roundHoleRadiusM: 0.030,
  massKg: 1.5,
};

/**
 * The part's orientation in the `grip_site` frame, as a MuJoCo quaternion.
 *
 * The plate normal is the APPROACH axis (site +Z), so the plate lies flat and
 * descends along its own normal. The pads press along site ±X, so the arm they
 * hold must run along site ±Y — i.e. the part is rotated +90° about its normal
 * relative to the site. Without that, the pads would clamp an arm TIP and the
 * gap next to it instead of a flank.
 */
export const PART_IN_SITE_QUAT: readonly [number, number, number, number] = [
  Math.SQRT1_2, 0, 0, Math.SQRT1_2,
];

/** Board-local centre of the Y slot and of the round hole, m. [DECLARED] */
export const SLOT_CENTRE: readonly [number, number] = [0, 0];
/** 220 mm, not 150: at 150 mm the round hole's outer rim reached back to
 *  x = 45 mm and blocked arm 0 of the Y slot (whose tip is at 50.5 mm). Also
 *  measured, also from the contact list (`part_arm0 / round_rim2`). */
export const ROUND_CENTRE: readonly [number, number] = [0.220, 0];
/** Board origin in the world, m. [DECLARED] — in front of the robot, on the floor. */
export const BOARD_ORIGIN: readonly [number, number] = [0.750, 0.0];

export interface SceneOptions {
  part?: Partial<PartGeometry>;
  board?: Partial<BoardGeometry>;
  /** Sliding friction between board and floor — measurable in reality
   *  (slip angle); here the second dial of the mass sweep. [DECLARED] */
  floorFriction?: number;
  /** Friction of the board's own surfaces against the part. [DECLARED] */
  boardFriction?: number;
  /**
   * NEGATIVE PROBE (plan F22 / test 9.23). When true the part is built as ONE
   * convex mesh from the three-star's own corner vertices instead of three
   * boxes. MuJoCo convexifies every collision mesh, so the hull is a HEXAGON
   * and must not pass through the Y slot it belongs to.
   */
  partAsOneMesh?: boolean;
  /** Per-axis force limits, N·m. `null` = unlimited (used by the stage that
   *  MEASURES the static holding torque before the limits exist). */
  forceRangeNm?: readonly number[] | null;
  /** Round the board's round hole with this many box segments. [DECLARED 12 —
   *  the plan's "a dozen segments for a usable approximation"]. */
  roundSegments?: number;
  /**
   * Multiplier on {@link CRX_KP} (and sqrt-matched {@link CRX_KV}).
   *
   * A knob, not decoration: MuJoCo's `<position>` servo has NO integral term,
   * so it carries a permanent gravity DROOP of tau_static / kp. Measured with
   * the UR10e's own kp = 5000, that droop is 1.2 deg on A2 — about 15 mm at the
   * TCP, which swamps the contact-caused following error the whole gate is
   * about. The Phase-1 sweep reports droop and stability against this scale and
   * the timestep together.
   */
  kpScale?: number;
  /** Physics timestep, s. [DECLARED default 0.002] */
  timestepS?: number;
}

/** The hexagonal convex hull of the three-star: the 6 arm-tip corners.
 *  Its minimum width is what the negative probe is about. */
export function starHullVertices(p: PartGeometry): number[][] {
  const out: number[][] = [];
  const hw = p.armWidthM / 2;
  const ht = p.thicknessM / 2;
  for (let k = 0; k < 3; k++) {
    const a = rad(120 * k);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const s of [-1, 1]) {
      // arm tip corner in arm coords (L, s*hw) → world
      const x = p.armLenM * ca - s * hw * sa;
      const y = p.armLenM * sa + s * hw * ca;
      out.push([x, y, -ht], [x, y, ht]);
    }
  }
  return out;
}

/**
 * Minimum width of the three-star's convex hull, m — the smallest distance
 * between two parallel supporting planes.
 *
 * This is the probe the Phase-0 convex rule names: compare it against the
 * narrowest place of the opening. For a hexagon it is the smallest
 * edge-normal extent, so it suffices to test the 6 edge normals.
 */
export function hullMinWidth(p: PartGeometry): number {
  const v = starHullVertices(p).filter((_, i) => i % 2 === 0).map(([x, y]) => [x, y]);
  // Hull of the 6 tip corners, ordered by angle.
  const ordered = [...v].sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
  let best = Infinity;
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    const b = ordered[(i + 1) % ordered.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const nx = -ey / len;
    const ny = ex / len;
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of ordered) {
      const d = q[0] * nx + q[1] * ny;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    best = Math.min(best, hi - lo);
  }
  return best;
}

const f = (n: number): string => (Number.isFinite(n) ? n.toPrecision(8).replace(/\.?0+$/, '') : '0');
const v3 = (a: readonly number[]): string => a.map(f).join(' ');

/** Build the MJCF document of the peg-game scene. */
export function buildPegGameMjcf(opts: SceneOptions = {}): { xml: string; part: PartGeometry; board: BoardGeometry; geomCount: { board: number } } {
  const part: PartGeometry = { ...DEFAULT_PART, ...opts.part };
  const board: BoardGeometry = { ...DEFAULT_BOARD, ...opts.board };
  const floorFriction = opts.floorFriction ?? 0.4;
  const boardFriction = opts.boardFriction ?? 0.3;
  const roundSegments = opts.roundSegments ?? 12;
  const fr = opts.forceRangeNm ?? null;
  const kpScale = opts.kpScale ?? 1;
  const dt = opts.timestepS ?? 0.002;

  // ── Robot chain ──
  let robot = '';
  let close = '';
  for (let i = 0; i < CRX_AXES.length; i++) {
    const ax = CRX_AXES[i];
    const mass = CRX_LINK_MASS_KG[ax.name as keyof typeof CRX_LINK_MASS_KG];
    const quat = ax.quat ? ` quat="${v3(ax.quat)}"` : '';
    // Collision geometry: ONE capsule per link, spanning to the next joint.
    // [DECLARED] the Menagerie precedent (UR5e README step 9, "manually
    // designed collision geometries" — capsules, never the visual meshes).
    // Coarse on purpose: this gate measures the JOINING contacts, and the arm's
    // own links never touch anything here. The capsule also carries the link
    // mass, so MuJoCo derives the inertia from geometry (Mirtich-equivalent)
    // while the SUM stays the datasheet's 39 kg.
    const next = CRX_AXES[i + 1];
    const to = next ? next.pos : [0.060, 0, 0];
    const span = Math.hypot(to[0], to[1], to[2]);
    const fromto = span > 1e-4 ? v3([0, 0, 0, ...to]) : v3([0, 0, 0, 0, 0, 0.06]);
    robot += `${'  '.repeat(i + 3)}<body name="${ax.name}" pos="${v3(ax.pos)}"${quat}>
${'  '.repeat(i + 4)}<joint name="${ax.name}" type="hinge" axis="${v3(ax.axis)}" armature="${f(CRX_ARMATURE)}" damping="${f(CRX_JOINT_DAMPING[i])}"/>
${'  '.repeat(i + 4)}<geom name="${ax.name}_col" type="capsule" fromto="${fromto}" size="0.055" mass="${f(mass)}" contype="0" conaffinity="0" rgba="0.8 0.8 0.85 1"/>
`;
    close = `${'  '.repeat(i + 3)}</body>\n` + close;
  }

  // ── Gripper, on A6 via the GLB's TCP frame ──
  // [GLB] TCP pos (0.060,0,0) quat glTF [-.5,.5,-.5,.5] → MJCF [.5,-.5,.5,-.5];
  // gripper pos (0,0,-0.010) quat glTF [.5,.5,.5,.5] → MJCF [.5,.5,.5,.5].
  // Jaw layout [DECLARED]: slide along the gripper's local X (the GLB's
  // `LinearX`), pads 25 mm long on gripper +Z, which is the approach direction.
  // Opening 35 mm at q=0 (the 20 mm arm fits), stroke 15.5 mm — the library
  // part's 15 mm, not the catalogue's 40 mm (contradiction reported).
  // [DECLARED] grip the MIDDLE of an arm, not the hub (plan 4b: the attack
  // point is on the arm, so a moment acts about the jaw axis when it jams).
  const padY = 0.025;
  const jawBase = 0.0255;
  // Pad half-extents: 8 mm thick, 24 mm along the arm, 10 mm tall. The height
  // is what limits the insertion travel (see DEFAULT_PART).
  const padHalf = [0.004, 0.012, 0.005];
  // Pad centre along the approach axis, so the pads cover the part plate's
  // UPPER 10 mm and the remaining 15 mm protrudes freely below them.
  const padZ = 0.0225;
  /** Part hub along the gripper's approach axis — also where `grip_site` sits,
   *  so an IK target for the site IS a target for the part's hub. */
  const partHubZ = 0.030;
  const grip = `          <body name="TCP" pos="0.06 0 0" quat="0.5 -0.5 0.5 -0.5">
            <body name="gripper" pos="0 0 -0.01" quat="0.5 0.5 0.5 0.5">
              <geom name="gripper_col" type="box" size="0.035 0.03 0.025" pos="0 0 0.005" mass="${f(CRX_LINK_MASS_KG.gripper)}" contype="0" conaffinity="0" rgba="0.2 0.2 0.25 1"/>
              <site name="grip_site" pos="0 0 ${f(partHubZ)}" size="0.004"/>
              <body name="jaw_l" pos="${f(-jawBase)} 0 ${f(padZ)}">
                <joint name="jaw_l" type="slide" axis="1 0 0" range="0 ${f(JAW_STROKE_M)}" armature="0.001" damping="2"/>
                <geom name="pad_l" type="box" size="${v3(padHalf)}" pos="0.004 ${f(padY)} 0" mass="0.05"
                      contype="2" conaffinity="2" condim="4"
                      priority="2" friction="${f(PAD_FRICTION)} ${f(PAD_TORSIONAL_FRICTION_M)} 0.0001" solref="0.004 1" rgba="0.9 0.5 0.1 1"/>
              </body>
              <body name="jaw_r" pos="${f(jawBase)} 0 ${f(padZ)}">
                <joint name="jaw_r" type="slide" axis="-1 0 0" range="0 ${f(JAW_STROKE_M)}" armature="0.001" damping="2"/>
                <geom name="pad_r" type="box" size="${v3(padHalf)}" pos="-0.004 ${f(padY)} 0" mass="0.05"
                      contype="2" conaffinity="2" condim="4"
                      priority="2" friction="${f(PAD_FRICTION)} ${f(PAD_TORSIONAL_FRICTION_M)} 0.0001" solref="0.004 1" rgba="0.9 0.5 0.1 1"/>
              </body>
            </body>
          </body>
`;

  // ── The part ──
  const [ix, iy, iz] = partDiagInertia(part);
  let partGeoms: string;
  let assets = '';
  if (opts.partAsOneMesh) {
    // The negative probe: give MuJoCo the star's own vertices. It builds their
    // CONVEX HULL — a hexagonal prism — without a word of warning.
    const verts = starHullVertices(part).flat().map(f).join(' ');
    assets = `    <mesh name="star_hull" vertex="${verts}"/>\n`;
    partGeoms = `      <geom name="part_hull" type="mesh" mesh="star_hull" contype="2" conaffinity="3" rgba="0.9 0.2 0.2 1"/>\n`;
  } else {
    // Three boxes at 120°, the exact decomposition (plan 3.3.0 (2)).
    partGeoms = '';
    for (let k = 0; k < 3; k++) {
      const a = rad(120 * k);
      const cx = (part.armLenM / 2) * Math.cos(a);
      const cy = (part.armLenM / 2) * Math.sin(a);
      const qw = Math.cos(a / 2);
      const qz = Math.sin(a / 2);
      partGeoms += `      <geom name="part_arm${k}" type="box" size="${v3([part.armLenM / 2, part.armWidthM / 2, part.thicknessM / 2])}" pos="${f(cx)} ${f(cy)} 0" quat="${f(qw)} 0 0 ${f(qz)}" contype="2" conaffinity="3" rgba="0.1 0.6 0.9 1"/>\n`;
    }
  }
  const partBody = `    <body name="part" pos="0.4 0 0.6">
      <freejoint name="part_free"/>
      <inertial pos="0 0 0" mass="${f(part.massKg)}" diaginertia="${v3([ix, iy, iz])}"/>
${partGeoms}    </body>
`;

  // ── The board: six flank walls around the Y slot, three slot-end caps,
  //    three outer sectors, and the round hole as `roundSegments` boxes.
  //    Everything priority 1, so the board sets the part/board pairing — the
  //    Phase-0 correction 2 route ("priority on the tone-setting side"),
  //    because friction is MAXIMISED elementwise while solref/solimp are
  //    solmix-AVERAGED, which makes a pairing table out of per-geom profiles
  //    unrepresentable.
  //
  //    Collision classes [DECLARED], and the reason they exist is itself a
  //    Phase-1 finding: a free body built from 28 plate segments pays for EVERY
  //    segment's floor contact, which a one-piece plate would not — 28 boxes on
  //    a plane are up to 112 contacts that carry no information. So the plate
  //    segments collide with the PART only (contype 2 / conaffinity 2) and the
  //    board stands on ONE underside box (contype 4 / conaffinity 1), which is
  //    the 4 contacts a flat plate on a floor really has.
  //      floor      1 / 1
  //      plate seg  2 / 2      part 2 / 3      pads 2 / 2      feet 4 / 1
  //    The robot's own links are contype 0 / conaffinity 0: in this scene they
  //    touch nothing, and the gate measures the JOINING contacts.
  const prio = `contype="2" conaffinity="2" priority="1" friction="${f(boardFriction)} 0.005 0.0001" solref="0.004 1" solimp="0.9 0.95 0.001 0.5 2"`;
  const hw = part.armWidthM / 2 + board.clearanceM;       // slot half-width
  const Lr = part.armLenM + board.clearanceM;             // slot radial length
  const wt = board.wallM;
  const ht = board.halfThickM;
  let boardGeoms = '';
  let boardGeomCount = 0;
  const addBox = (name: string, size: number[], pos: number[], angle: number, rgba: string) => {
    const qw = Math.cos(angle / 2);
    const qz = Math.sin(angle / 2);
    boardGeoms += `      <geom name="${name}" type="box" size="${v3(size)}" pos="${v3(pos)}" quat="${f(qw)} 0 0 ${f(qz)}" ${prio} rgba="${rgba}"/>\n`;
    boardGeomCount++;
  };
  // WHERE A FLANK WALL MAY START, and why six boxes are not simply six boxes.
  //
  // Measured on the first run: with every wall running from the hub outwards,
  // the part never entered its own slot — and the contact list named the
  // culprit, `part_arm0 / slot_flank1_m`. Near the hub the three 120°
  // corridors OVERLAP, so arm 1's wall reaches into arm 0's corridor.
  //
  // The bound is closed-form. Arm 0's inner wall edge is the line
  // (t, hw); its distance from arm 1's axis is sin60·t + cos60·hw, which must
  // be at least hw, so t >= hw·(1 − cos60)/sin60 = hw·tan30. Below that radius
  // NO wall may exist, which is also fine physically: the part's own hub needs
  // that region free anyway.
  //
  // This is the kind of error the plan's convex rule is about — not a numerics
  // problem, a CONSTRUCTION error, and silent: the scene compiles, the solver
  // is happy, and the part just sits there.
  const wallStartR = hw * Math.tan(Math.PI / 6) * 1.1; // +10 % margin
  for (let k = 0; k < 3; k++) {
    const a = rad(120 * k);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rMid = (Lr + wallStartR) / 2;
    const halfLen = (Lr - wallStartR) / 2;
    for (const s of [-1, 1]) {
      // One box per ARM FLANK (six total) — each lies against exactly ONE
      // flank, axis-parallel to it, so the clearance is ONE parameter set six
      // times (plan F23: six, not three).
      const off = hw + wt / 2;
      const px = SLOT_CENTRE[0] + rMid * ca - s * off * sa;
      const py = SLOT_CENTRE[1] + rMid * sa + s * off * ca;
      addBox(`slot_flank${k}_${s > 0 ? 'p' : 'm'}`, [halfLen, wt / 2, ht], [px, py, 0], a, '0.55 0.55 0.6 1');
    }
    // Slot end cap, so the opening is closed beyond the arm tip. It gets 2 mm
    // MORE standoff than the flanks, deliberately: the six flanks are the
    // GUIDING surfaces and carry the fit, the end of the slot is not a fit
    // surface at all. Measured why it matters — with the cap at the same
    // clearance as the flanks, `part_arm0 / slot_cap0` showed up as a jam
    // contact on a part that was otherwise correctly aligned.
    const capStandoff = 0.002;
    const rCap = Lr + capStandoff + 0.020;
    addBox(`slot_cap${k}`, [0.020, hw + wt, ht], [SLOT_CENTRE[0] + rCap * ca, SLOT_CENTRE[1] + rCap * sa, 0], a, '0.55 0.55 0.6 1');
    // Outer sector between two arms — the surface a wrongly rotated part rests on.
    const ao = rad(120 * k + 60);
    const rSec = 0.078;
    addBox(`sector${k}`, [0.042, 0.042, ht], [SLOT_CENTRE[0] + rSec * Math.cos(ao), SLOT_CENTRE[1] + rSec * Math.sin(ao), 0], ao, '0.45 0.45 0.5 1');
  }
  // Round hole: `roundSegments` tangential boxes. The plan's hardest case, and
  // the one that stays an APPROXIMATION (the alternative is an `sdf` collider,
  // unverified in WASM — open question O5).
  const rh = board.roundHoleRadiusM;
  const segLen = 2 * rh * Math.tan(Math.PI / roundSegments);
  for (let k = 0; k < roundSegments; k++) {
    const a = (2 * Math.PI * k) / roundSegments;
    const r = rh + wt / 2;
    addBox(`round_seg${k}`, [segLen / 2 + wt / 2, wt / 2, ht],
      [ROUND_CENTRE[0] + r * Math.cos(a), ROUND_CENTRE[1] + r * Math.sin(a), 0], a + Math.PI / 2, '0.5 0.5 0.55 1');
  }
  // One ring of plate around the round hole so a part can rest on it.
  for (let k = 0; k < 4; k++) {
    const a = rad(90 * k);
    const r = rh + wt + 0.030;
    addBox(`round_rim${k}`, [0.030, 0.030, ht], [ROUND_CENTRE[0] + r * Math.cos(a), ROUND_CENTRE[1] + r * Math.sin(a), 0], a, '0.45 0.45 0.5 1');
  }
  // [DECLARED] plate-equivalent inertia for the declared mass. The real figure
  // falls out of the segmented geometry via Mirtich + `mergePointMass`
  // (plan 3.3 last paragraph); for a mass SWEEP a plate equivalent is enough
  // and keeps the sweep one-dimensional.
  const bm = board.massKg;
  const bx = 0.36;
  const by = 0.26;
  const bz = 2 * ht;
  const bInertia = [
    (bm / 12) * (by * by + bz * bz),
    (bm / 12) * (bx * bx + bz * bz),
    (bm / 12) * (bx * bx + by * by),
  ];
  const foot = BOARD_FOOT_HEIGHT_M;
  const boardBody = `    <body name="board" pos="${f(BOARD_ORIGIN[0])} ${f(BOARD_ORIGIN[1])} ${f(ht + foot)}">
      <freejoint name="board_free"/>
      <inertial pos="0 0 0" mass="${f(bm)}" diaginertia="${v3(bInertia)}"/>
${boardGeoms}      <geom name="board_foot" type="box" size="0.19 0.13 ${f(foot / 2)}" pos="0.075 0 ${f(-ht - foot / 2)}"
            contype="4" conaffinity="1" priority="1" friction="${f(boardFriction)} 0.005 0.0001" rgba="0.35 0.35 0.4 1"/>
    </body>
`;

  // ── Actuators ──
  // Six position servos + ONE gripper actuator on a tendon, exactly the pattern
  // Phase 0 confirmed on the Robotiq 2F-85.
  let actuators = '';
  for (let i = 0; i < 6; i++) {
    const ax = CRX_AXES[i].name;
    const limit = fr && Number.isFinite(fr[i]) ? ` forcerange="${f(-fr[i])} ${f(fr[i])}"` : '';
    // kv is matched to kp as sqrt(scale): a position servo's damping has to
    // grow with the square root of its stiffness to keep the damping ratio, so
    // scaling kv linearly with kp would over-damp it.
    const kp = CRX_KP[i] * kpScale;
    const kv = CRX_KV[i] * Math.sqrt(kpScale);
    actuators += `    <position name="act_${ax}" joint="${ax}" kp="${f(kp)}" kv="${f(kv)}"${limit} ctrlrange="-3.2 3.2"/>\n`;
  }
  // Tendon force F puts F*coef on each jaw joint; coef 0.5 → half each. For a
  // total grip force of `GRIP_FORCE_TOTAL_N` the per-jaw normal force is half
  // of it, so the tendon limit is the total.
  actuators += `    <position name="act_grip" tendon="grip" kp="${f(GRIP_KP)}" kv="${f(GRIP_KP / 100)}" forcerange="${f(-GRIP_FORCE_TOTAL_N)} ${f(GRIP_FORCE_TOTAL_N)}" ctrlrange="0 ${f(JAW_STROKE_M)}"/>\n`;

  const xml = `<mujoco model="rv-673-peg-game">
  <compiler angle="radian" autolimits="true"/>
  <!-- [DECLARED] 2 ms and implicitfast: the integrator MuJoCo recommends for
       actuated systems. The plan's abort criterion is stated per 60 Hz frame,
       i.e. over ceil(16.667/2) = 9 steps. -->
  <option timestep="${f(dt)}" integrator="implicitfast" cone="pyramidal" solver="Newton" iterations="100"/>
  <asset>
${assets}  </asset>
  <default>
    <geom condim="3" friction="1 0.005 0.0001"/>
  </default>
  <worldbody>
    <!-- [DECLARED] the floor sets the board/floor pairing (priority 3). -->
    <geom name="floor" type="plane" size="0 0 0.05" pos="0 0 0" contype="1" conaffinity="1"
          priority="3" friction="${f(floorFriction)} 0.005 0.0001" rgba="0.3 0.3 0.33 1"/>
    <body name="base" pos="0 0 0">
      <geom name="base_col" type="cylinder" size="0.09 0.1225" pos="0 0 0.1225" mass="${f(CRX_LINK_MASS_KG.base)}" contype="0" conaffinity="0" rgba="0.7 0.7 0.1 1"/>
      <!-- glTF is Y-UP, MJCF is Z-UP. The library part's node translations are
           authored Y-up, so the whole transcribed chain hangs under ONE +90°-
           about-X frame. Transcribing the numbers without this lays the robot
           flat in the floor — measured here on the first run (ncon 126 before
           the fix, grip site at z = -0.513 m). The Phase-3 MJCF writer needs
           exactly this one frame, once, at the document root. -->
      <body name="yup" quat="0.70710678 0.70710678 0 0">
${robot}${grip}${close}      </body>
    </body>
${partBody}${boardBody}  </worldbody>
  <tendon>
    <fixed name="grip">
      <joint joint="jaw_l" coef="0.5"/>
      <joint joint="jaw_r" coef="0.5"/>
    </fixed>
  </tendon>
  <equality>
    <!-- The gear coupling of the two jaws (GLB: Drive_Gear, GearFactor 1).
         Robotiq keeps BOTH tendon and equality, with a comment that the
         equality alone would have to do too much work. -->
    <joint joint1="jaw_l" joint2="jaw_r" polycoef="0 1 0 0 0"/>
  </equality>
  <actuator>
${actuators}  </actuator>
</mujoco>
`;
  return { xml, part, board, geomCount: { board: boardGeomCount } };
}
