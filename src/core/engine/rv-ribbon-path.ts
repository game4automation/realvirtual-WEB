// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ribbon-path.ts — `RibbonPath`, one taut web over an ordered chain of rollers
 * (plan-459, sections added by plan-460).
 *
 * The component is the bridge between the scene graph and the portable
 * mathematics: it reads roller poses and radii, flattens them into the 2D
 * problem `ribbon-geometry.ts` solves, lifts the answer back into 3D, and turns the
 * rollers. It owns no mathematics of its own — that is what makes the later
 * Unity port a transcription of two files rather than of this one.
 *
 * ## Sections
 *
 * A web has ONE speed only as long as nothing stores material along it. Each
 * `RibbonDancer` in `Rollers` splits the path at its own departure tangent point
 * into sections that run at DIFFERENT speeds — the speed of a section being the
 * surface speed of the last driven roller in it. The path therefore hands the
 * manager an array of section speeds rather than a scalar, turns each follower
 * with the speed of ITS section, and scrolls the band per section.
 *
 * A path with no dancer has exactly one section, and every number it produces is
 * the plan-459 number — which is what `tests/ribbon-sections.test.ts` opens with.
 *
 * ## The plane
 *
 * Every roller of a path must share one axis (2 deg tolerance, F13 excludes turn
 * bars). The path builds an orthonormal frame `(e1, e2, a)` in its OWN local
 * space, projects every roller centre onto `(e1, e2)`, solves there, and maps
 * back with `p = O + e1·x + e2·y + a·axialMean`. Working in the path node's local
 * frame means the whole web moves with its parent for free — the same reason
 * `rv-chain-path.ts` bakes its table locally.
 *
 * ## The dirty gate
 *
 * A rebuild is expensive (tangents, sampling, a full position buffer); plain
 * motion is not (one texture offset, N roller rotations). The gate is an
 * ELEMENTWISE comparison of a pre-allocated transform snapshot — centre, the
 * unnormalised world axis, a radial scale probe, and the contact radius — with
 * per-element epsilons. A scalar checksum was rejected in review round 2: two
 * compensating changes sum to the same number and would silently freeze the
 * path in a stale shape.
 *
 * ## Units
 *
 * Millimetres, everywhere, up to and including the sample table handed to
 * `RVRibbonBandMesh.write()`. That method is the single mm → m boundary.
 */

import { NodeRegistry } from './rv-node-registry';
import { Matrix4, Object3D, Vector3 } from 'three';
import type { Material } from 'three';
import { findMaterialByName } from './rv-pre-bake';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';
import {
  getComponentInstances,
  loadSchemaFromSpec,
  registerComponent,
  removeComponentInstance,
  resolveComponentRefs,
  setComponentInstance,
} from './rv-component-registry';
import { MM_TO_METERS, NO_AO_LAYER } from './rv-constants';
import { RVRibbonBandMesh, RIBBON_BAND_SAMPLE_STRIDE } from './rv-ribbon-band-mesh';
import { RVRibbonWinder } from './rv-ribbon-winder';
import { RVRibbonRoller, axisVector, type RibbonRollerLike, type RibbonSideSign } from './rv-ribbon-roller';
import {
  buildRibbonSegments,
  sampleArcLength,
  RIBBON_SAMPLE_STRIDE,
  type Circle2,
  type RibbonSegment2,
} from './ribbon/ribbon-geometry';
import { angularSpeedRad } from './ribbon/ribbon-winder-math';
import {
  bandDeviation,
  breakStrain as breakStrainOf,
  classify,
  MIN_ZONE_LENGTH_MM,
  pliFromNPerM,
  isRibbonAlarm,
  specificTenacity,
  specificTension,
  strainFromTension,
  strainStepImplicit,
  tensionFromStrain,
  type RibbonStrainThresholds,
  type RibbonZoneMode,
  type RibbonZoneState,
} from './ribbon/ribbon-tension-math';
import type { ErrorStore } from './rv-error-store';
import {
  distributeExcess,
  isSagEstimated,
  lineTangentAfterSag,
  perpGravity,
  sagDepth,
  sagProfile,
  type SagVec3,
} from './ribbon/ribbon-sag-math';
import type { RibbonManager } from './rv-ribbon-manager';
import { RVRibbonDancer } from './rv-ribbon-dancer';
import { RVRibbonTensionOverlay } from './rv-ribbon-tension-overlay';

/** Floats per roller in the transform signature: centre, axis, radial scale, radius. */
const SIGNATURE_STRIDE = 9;

/** Elementwise epsilon for the pose part of the signature (world metres). */
const POSE_EPSILON = 1e-5;

/** mm — a winder radius must move this far before the path is rebuilt (F6). */
const RADIUS_EPSILON_MM = 0.05;

/** rad — the largest axis deviation two rollers of one path may have (2 deg). */
const AXIS_TOLERANCE_RAD = (2 * Math.PI) / 180;

/** Safety factor on the sample buffer, so a growing rewinder does not hit it. */
const CAPACITY_MARGIN = 1.25;

/** Hard ceiling on the sample buffer, whatever `SamplesPerMeter` asks for. */
const MAX_SAMPLES = 4096;

// ── Pre-allocated scratch: nothing in the per-tick path allocates ──
const _inv = new Matrix4();
const _c = new Vector3();
const _a = new Vector3();
const _tmp = new Vector3();
const _radial = new Vector3();

/** mm/s — a section speed difference above this fraction warns about slip. */
const SECTION_SPEED_MISMATCH = 0.01;

/** `RibbonWinder.WrapDeg` is authored in degrees; the geometry works in radians. */
const DEG_TO_RAD = Math.PI / 180;

/** mm - the sag depth must move this far before the geometry is rewritten (A1). */
const SAG_WRITE_EPSILON_MM = 0.5;

/** N/m - hysteresis on the specific-tension signal. */
const SIGNAL_EPSILON_N_PER_M = 0.5;

/** % - hysteresis on the strain signal. */
const SIGNAL_EPSILON_STRAIN_PERCENT = 0.01;

/** Which alarm wins when a path has several — a torn web outranks everything. */
const ALARM_RANK: Readonly<Record<RibbonZoneState, number>> = {
  inBand: 0, below: 0, above: 0, slack: 1, over: 2, broken: 3,
};

/** The alarm wording, for the error panel rather than for a 3D label. */
const ALARM_TEXT: Readonly<Record<RibbonZoneState, string>> = {
  inBand: '', below: '', above: '',
  slack: 'is slack', over: 'is overstretched', broken: 'has torn',
};

/** Hz - the pulse rate of the two ALARM tints (`slack`, `over` / `broken`). */
const ALARM_PULSE_HZ = 1.6;

/**
 * The tint of each zone state. `inBand` has none on purpose: the good web is the
 * customer's own material and is left completely alone (plan-471 E5/E6).
 *
 * Cold below the band, warm above it, and the two ALARM states in fully
 * saturated cyan / magenta - a red-green-blind-safe pairing whose ends are
 * distinguishable by hue AND by the hard edge at the band limit, so nobody has
 * to estimate a shade to read the machine.
 */
const ZONE_TINT: Readonly<Record<RibbonZoneState, number | null>> = {
  inBand: null,
  below: 0x2979ff,
  above: 0xff9100,
  slack: 0x00e5ff,
  over: 0xff00d0,
  broken: 0xff00d0,
};

/**
 * One tension zone: the span between two consecutive BOUNDARY rollers (the
 * first, the last, every driven roller, and the dancer).
 *
 * A zone carries exactly ONE signed strain. `lengthMm` is its MECHANICAL length
 * - the line segments plus the wrap arcs of the idlers inside it, never the arcs
 * at its own boundaries, where the web lies on the roller and cannot stretch -
 * and it is taken from the analytic segment lengths, never from sample indices,
 * so the physics does not depend on the render resolution.
 *
 * The COLOUR range is deliberately wider than the physical span: it runs from
 * the ARRIVAL sample of the upstream boundary to the arrival sample of the
 * downstream one, so the wrap arc of a boundary roller belongs to the zone the
 * web leaves it into. That is what makes the colour partition gapless (SOL R2 #5).
 */
export interface RibbonTensionZone {
  /** Index into `rollers` of the upstream boundary roller. */
  fromRoller: number;
  /** Index into `rollers` of the downstream boundary roller. */
  toRoller: number;
  /** mm - the mechanical length of the zone (see the interface doc). */
  lengthMm: number;
  /** The signed strain; `> 0` taut, `0` the taut limit, `< 0` slack. */
  eps: number;
  /** N - `K * w * eps`, and 0 for a slack zone: a rope does not push. */
  tensionN: number;
  /** How `eps` was produced in the current tick. */
  mode: RibbonZoneMode;
  /** The band / alarm state of `eps`. */
  state: RibbonZoneState;
  /** True while the zone is broken; cleared only by a reset. */
  broken: boolean;
  /** True when the sag depth left the range the closed form is good in (A4). */
  estimated: boolean;
  /** mm - the deepest sag currently drawn in this zone (0 when taut). */
  sagDepthMm: number;
  /** First band sample of the zone's COLOUR range. */
  colorFromSample: number;
  /** Last band sample of the zone's COLOUR range (inclusive). */
  colorToSample: number;
  /** First segment index of the physical span. */
  fromSegment: number;
  /** Last segment index of the physical span (inclusive). */
  toSegment: number;
  /** mm - arc length from the path start to the zone's first segment. */
  startArcMm: number;
}

/** What {@link RVRibbonPath.tensionReadout} reports for one zone. */
export interface RibbonZoneReadout {
  eps: number;
  tensionN: number;
  nPerM: number;
  pli: number;
  lengthMm: number;
  mode: RibbonZoneMode;
  state: RibbonZoneState;
  estimated: boolean;
}

// -- Pre-allocated scratch for the tension + sag path --
const _gravityInv = new Matrix4();
const _gravityLocal = new Vector3();
const _chord: SagVec3 = { x: 0, y: 0, z: 0 };
const _sagDir: SagVec3 = { x: 0, y: 0, z: 0 };
const _sagTangent: SagVec3 = { x: 0, y: 0, z: 0 };

/**
 * One stretch of web between two dancers (or between an end and a dancer).
 *
 * `fromRoller` is the first roller of the section; `fromSample` its first band
 * sample. `driven` is the roller whose surface speed IS this section's speed —
 * the LAST driven one in running direction, i.e. the pulling one.
 */
export interface RibbonSection {
  fromRoller: number;
  fromSample: number;
  driven: RibbonRollerLike | null;
  speed: number;
}

/** Browser runtime counterpart of Unity's `RibbonPath` component (plan-459/460). */
export class RVRibbonPath implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('RibbonPath');

  readonly node: Object3D;
  isOwner = true;

  // ── Schema fields ──
  /** Rollers in running order. Wire: `ComponentReference[]`. */
  Rollers: unknown[] = [];
  /**
   * DEPRECATED (plan-460). The web is moved exclusively by rotational drives on
   * the ROLLERS; this field is kept in the v1 schema so a plan-459 document
   * still loads, but it is read by nothing. See {@link _warnDeprecated}.
   */
  ConnectedDrive: unknown = null;
  /** DEPRECATED (plan-460) — ignored, see {@link ConnectedDrive}. */
  SpeedSource: 'Drive' | 'RibbonWinder' = 'Drive';
  RibbonWidthMm = 500;
  RibbonThicknessMm = 0.1;
  TextureLengthMm = 1000;
  SamplesPerMeter = 64;
  /** Optional LEGACY material donor node. Wire: `ComponentReference`. */
  Material: unknown = null;
  /**
   * Name of a material of the ribbon material library (plan-496). It is
   * resolved against the materials of the LOADED document — exactly, then
   * ignoring case, first match wins — and takes PRECEDENCE over {@link Material}.
   * Unity writes the library material into the GLB under exactly this name.
   */
  MaterialName = '';
  /**
   * Roller at which the full web is slit into this strip — the cut happens where
   * the web MEETS that roller. Wire: `ComponentReference`.
   */
  SlitAtRoller: unknown = null;
  /** mm - width of the full web BEFORE the slit; 0 = this path is not a slit strip. */
  FullWidthMm = 0;

  // -- Tension (plan-471). `TensileStiffnessNPerMmWidth <= 0` = everything off --
  /** g/m^2 - basis weight; the normaliser of the specific tenacity readout. */
  BasisWeightGsm = 20;
  /**
   * N/mm of width at `eps = 1` - the MD secant stiffness, and the ONE switch of
   * the whole feature. At `<= 0` the zone partition is never built and not a
   * single new code path is entered, which is what makes a document without
   * tension bit-identical to a pre-plan-471 reader.
   */
  TensileStiffnessNPerMmWidth = 0;
  /** % - strain below which the web is SLACK. Alarms; clamps nothing. */
  MinStrainPercent = 0;
  /** % - strain above which the web is OVERSTRETCHED. Alarms; clamps nothing. */
  MaxStrainPercent = 2;
  /** N per 50 mm of width - the MD strip force at break; 0 disables breaking. */
  BreakForceNPer50mm = 35;
  /** N/m - the set-point tension the unwinder pays the web out at. */
  TargetTensionNPerM = 100;
  /** % of the set point - half the width of the good band. */
  ToleranceBandPercent = 10;
  /** Whether a slack zone visibly hangs through. */
  EnableSag = true;
  /** Whether the band is tinted by its tension state. */
  TensionColoring = true;
  /** `0..1` - how strongly the tint is mixed into the band material. */
  TintStrength = 0.7;
  /** Visual exaggeration of the sag DEPTH only; never of the strain. */
  DeformationScale = 1;
  /** Whether the zone readout and the dancer gizmo are drawn. */
  ShowTensionLabels = false;
  /** Signal slots - resolved to signal addresses by `resolveComponentRefs`. */
  TensionN: unknown = null;
  SpecificTensionNPerM: unknown = null;
  StrainPercent: unknown = null;
  IsSlack: unknown = null;
  IsOverstretched: unknown = null;
  IsBroken: unknown = null;

  // ── Runtime state ──
  private _manager: RibbonManager | null = null;
  private _rollers: RibbonRollerLike[] = [];
  private _circles: Circle2[] = [];
  private _segments: RibbonSegment2[] = [];
  private _band: RVRibbonBandMesh | null = null;
  private _previewBand: RVRibbonBandMesh | null = null;
  private _samples2: Float32Array = new Float32Array(0);
  private _samples3: Float32Array = new Float32Array(0);
  private _signature: Float32Array = new Float32Array(0);
  private _sampleCount = 0;
  private _lengthMm = 0;
  private _inert = false;
  private _built = false;
  private _context: ComponentContext | null = null;
  private _capacityWarned = false;
  private _samplesPerMeter = 64;
  /** Sections in running order; always at least one (plan-460 F1). */
  private _sections: RibbonSection[] = [];
  /** Roller index -> section index. Pre-allocated with the roller list. */
  private _sectionOfRoller: Int32Array = new Int32Array(0);
  /** Section start SAMPLE indices, reused per rebuild (no GC in the tick). */
  private _sectionStarts: number[] = [];
  /** The dancers of this path, in running order (0 or 1 in plan-460). */
  private _dancers: RVRibbonDancer[] = [];
  private _warnedNoDrivenRoller = false;
  private _warnedMismatch = false;
  /** The 2D frame, rebuilt with the geometry. */
  private readonly _origin = new Vector3();
  private readonly _basisE1 = new Vector3();
  private readonly _basisE2 = new Vector3();
  private readonly _basisA = new Vector3();
  private _axialMeanMm = 0;
  /** mm - axial offset of the LAST roller (the strip's own lane after a slit). */
  private _lastAxialMm = 0;
  /** Index into {@link _rollers} of the slit roller, or -1. */
  private _slitRollerIdx = -1;
  /** First band sample after the slit roller's arc, or -1 without a slit. */
  private _slitSampleIdx = -1;
  /** Whether THIS path draws the shared full-width part before the slit. */
  private _drawsPreSlit = true;
  /**
   * The strip that OWNS the shared pre-slit strain, when this one mirrors it.
   *
   * Strips cut from one sheet must carry one strain upstream of the blade, not
   * one each: two integrations of the same web would drift apart and the sheet
   * would be slack for one strip and taut for the other. So exactly one strip
   * integrates that stretch and the rest copy it (SOL R1 #5).
   */
  private _preSlitSource: RVRibbonPath | null = null;
  /** mm — the absolute sample grid step the last {@link _writeGeometry} used. */
  private _sampleStepMm = 0;
  /**
   * `1` when a `WrapDeg` on the unwinder prepended a PRE-arc to the segment list
   * (plan-468), else `0`.
   *
   * Segments alternate `line, arc, line, …`, and the two sample lookups below
   * address roller `k`'s arc as segment `2k - 1`. A pre-arc pushes every one of
   * them back by exactly one — and by exactly one only, because a winder can
   * never be an INNER roller (see the invariant in {@link _build}), so neither
   * the slit nor a section boundary can ever fall on roller 0 itself.
   */
  private _startArcOffset = 0;
  /** The resolved wrap side per roller as of the last solve. */
  private _resolvedSides: RibbonSideSign[] = [];
  /** Bumped whenever {@link _resolvedSides} changed; read by `RibbonManager`. */
  private _sidesVersion = 0;

  // -- Tension runtime state; all empty while the feature is off --
  private _zones: RibbonTensionZone[] = [];
  /** Indices into {@link _rollers} of the boundary rollers, in running order. */
  private _boundaries: number[] = [];
  /** `[arrival, departure]` per ROLLER index; pre-allocated with the roller list. */
  private _boundarySpeeds: Float32Array = new Float32Array(0);
  /** True while the partition exists (stiffness > 0 and not a slit path). */
  private _tensionOn = false;
  /** Index of the honoured dancer in {@link _rollers}, or -1. */
  private _dancerIdx = -1;
  private _warnedBackwards = false;
  private _warnedUnknownMaterial = false;
  /** Set by {@link prepareTension} when step 5 must write geometry without re-solving. */
  private _pendingWrite = false;
  /** mm - the deepest sag the last geometry write actually drew. */
  private _writtenSagMm = 0;
  /** The `EnableSag` / `DeformationScale` the last geometry write was made with. */
  private _writtenSagEnabled = false;
  private _writtenDeformationScale = 1;
  /** Group boundaries = (section starts) U (zone colour starts); reused per write. */
  private readonly _groupStarts: number[] = [];
  private readonly _groupToSection: number[] = [];
  private readonly _groupToZone: number[] = [];
  /** Number of groups the band was last given; a change forces a `setGroups`. */
  private _bandGroupCount = -1;
  /** Scratch for the sag distribution; grown once, then reused. */
  private readonly _sagLengths: number[] = [];
  private readonly _sagShare: number[] = [];
  /** Reused threshold record - `classify` is called once per zone per tick. */
  private readonly _thresholds: RibbonStrainThresholds = {
    minStrain: 0, maxStrain: 0, breakStrain: Number.POSITIVE_INFINITY, refStrain: 0, tolerance: 0,
  };
  private _lastTensionN = Number.NaN;
  private _lastNPerM = Number.NaN;
  private _lastStrainPercent = Number.NaN;
  /** The readout overlay; created on the first tick that asks for it (E7). */
  private _overlay: RVRibbonTensionOverlay | null = null;

  /**
   * Which of its group's strips this is, and how many there are — assigned by
   * `RibbonManager` when the groups are built, and used ONLY to keep the zone
   * labels of sibling strips off each other (see `_placeAnchor`).
   *
   * A lone path is lane 0 of 1, which puts its labels at the zone midpoint, i.e.
   * exactly where they were before lanes existed.
   */
  labelLane = 0;
  labelLaneCount = 1;
  private _gizmos: GizmoOverlayManager | null = null;
  private _editorPreview = false;
  private readonly _editorRouting: GizmoHandle[] = [];
  private readonly _editorTangents: GizmoHandle[] = [];
  /** The viewer-wide alarm registry — see {@link _reportAlarm}. */
  private _errors: ErrorStore | null = null;
  /** The alarm text last written, so a steady fault is not re-published. */
  private _lastAlarmText = '';
  private _lastSlack: boolean | null = null;
  private _lastOver: boolean | null = null;
  private _lastBroken: boolean | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  // ── Public state (diagnostics + tests) ──

  /** True when the path is solved and ticking. */
  get isActive(): boolean {
    return !this._inert && this._segments.length > 0;
  }

  get isInert(): boolean {
    return this._inert;
  }

  /** mm — total arc length of the current path. */
  get lengthMm(): number {
    return this._lengthMm;
  }

  /** The resolved rollers, in running order. */
  get rollers(): readonly RibbonRollerLike[] {
    return this._rollers;
  }

  /** The winders at the two ends, with their roles assigned. */
  get winders(): RVRibbonWinder[] {
    const out: RVRibbonWinder[] = [];
    for (const r of this._rollers) if (r instanceof RVRibbonWinder) out.push(r);
    return out;
  }

  /** The band mesh, or `null` on an inert / authoring path. */
  get band(): RVRibbonBandMesh | null {
    return this._band;
  }

  /** The sections of this path, in running order (diagnostics + tests). */
  get sections(): readonly RibbonSection[] {
    return this._sections;
  }

  /**
   * The finished 3D sample buffer in MILLIMETRES, in the path node's local
   * frame: `[px,py,pz, tx,ty,tz, ux,uy,uz]` per sample, `RIBBON_BAND_SAMPLE_STRIDE`
   * floats apart. This is what {@link RVRibbonBandMesh.write} consumes, sag
   * included — the surface the rendering tests assert the deformation on.
   *
   * Live, not a copy: never written to from outside.
   */
  get sampleBuffer(): Float32Array {
    return this._samples3;
  }

  /** Number of valid samples in {@link sampleBuffer}. */
  get sampleCount(): number {
    return this._sampleCount;
  }

  /** The dancers of this path, in running order (at most one in plan-460). */
  get dancers(): readonly RVRibbonDancer[] {
    return this._dancers;
  }

  /** The section index a roller belongs to, or 0 (diagnostics + tests). */
  sectionOfRoller(index: number): number {
    return index >= 0 && index < this._sectionOfRoller.length ? this._sectionOfRoller[index] : 0;
  }

  /**
   * The RESOLVED wrap side of roller `index` in this path: `+1` Left, `-1`
   * Right, `0` when the path has not solved yet. Unlike `roller.sideSign` this
   * answers for `RibbonSide: Auto` too, because `resolveAutoSides` writes its
   * answer into the path's own circle list — and an Auto roller shared by two
   * strips can resolve DIFFERENTLY for each of them, which is what
   * `RibbonManager` checks before the slit (see its shared-side validation).
   */
  resolvedSideAt(index: number): RibbonSideSign {
    const circle = this._circles[index];
    return circle ? (circle.side as RibbonSideSign) : 0;
  }

  /** Refresh moving contact geometry before this tick's drive speeds are interpreted. */
  refreshMotionGeometry(): boolean {
    if (!this._isDirty()) return false;
    if (!this._solve()) return false;
    this._writeGeometry();
    this._captureSignature();
    return true;
  }

  /** Forward web speed to rotation about the roller's own positive axis. */
  contactSignAt(index: number): number {
    const roller = this._rollers[index];
    // _inv is shared scratch, not a cached inverse belonging to this path.
    this.node.updateMatrixWorld(true);
    _inv.copy(this.node.matrixWorld).invert();
    if (!roller || !this._localAxisOf(roller, _a)) return 0;
    return this.resolvedSideAt(index) * (_a.dot(this._basisA) < 0 ? -1 : 1);
  }

  /**
   * Incremented on every solve that resolved a wrap side differently than the
   * previous one. `RibbonManager` re-runs its shared-side check for a group when
   * any member's version moved — a dancer travelling across the chord between
   * its neighbours flips a side in the middle of a run, and that conflict has to
   * be reported when it HAPPENS, not only when the groups were built.
   */
  get sidesVersion(): number {
    return this._sidesVersion;
  }

  /**
   * mm — the absolute sample grid this path is currently on. It is
   * `1000 / SamplesPerMeter` unless the path outgrew its buffer, in which case
   * `sampleArcLength` coarsened it (and the halving branch may have coarsened it
   * again). Two strips slit at the same roller only cut at the same sample while
   * they are on the SAME grid, which is what `RibbonManager` checks.
   */
  get sampleStepMm(): number {
    return this._sampleStepMm;
  }

  /** The node path this component is registered under — the ownership key. */
  get sortKey(): string {
    return this._sortKey;
  }

  private _sortKey = '';
  private _alarmPath = '';

  // ── Build ──────────────────────────────────────────────────────

  init(context: ComponentContext): void {
    this._context = context;
    this._manager = context.ribbonManager ?? null;
    this._gizmos = context.gizmoManager ?? null;
    this._errors = context.errorStore ?? null;
    this._sortKey = nodePathOf(this.node);
    this._alarmPath = NodeRegistry.computeNodePath(this.node);
    // Like `RVChain`: wait for `onSceneReady()` where the loader has one, because
    // the Kinematic re-parenting pass runs between init and onSceneReady and a
    // roller may still move.
    if (!context.expectSceneReady) this._build(context);
  }

  /** Re-resolve the authored roller list after a structural editor change. */
  rebuildTopology(): void {
    const context = this._context;
    if (!context) return;
    this.setEditorBandPreview(false);
    this._overlay?.dispose();
    this._overlay = null;
    this._band?.dispose();
    this._band = null;
    this._manager?.unregister(this);
    this._built = false;
    this._inert = false;
    this._rollers = [];
    this._segments = [];
    this._circles = [];
    this._dancers = [];
    this._sections = [];
    this._build(context);
  }

  /** Sample-index range occupied by one roller arc. */
  arcSampleRange(index: number): { start: number; end: number } {
    return {
      start: this._rollerArcStartSample(index, this._sampleCount),
      end: this._rollerArcEndSample(index, this._sampleCount),
    };
  }

  /** Shows the stopped ribbon outside the document tree, without diagnostic overlays. */
  /**
   * The document material {@link MaterialName} names, or null (plan-496). An
   * unknown name warns ONCE and the path falls back to the {@link Material}
   * node, so a document authored against another library still renders.
   */
  private _resolveLibraryMaterial(): Material | null {
    if (!this.MaterialName) return null;
    const found = findMaterialByName(this.node, this.MaterialName);
    if (found) return found;
    if (!this._warnedUnknownMaterial) {
      this._warnedUnknownMaterial = true;
      console.warn(`[RibbonPath] "${this.node.name}": no material called "${this.MaterialName}" `
        + 'in this document; falling back to the Material node.');
    }
    return null;
  }

  setEditorBandPreview(active: boolean): void {
    this.setEditorPreview(false);
    if (!active || !this._context || this._inert || this._sampleCount < 2) {
      this._previewBand?.dispose();
      this._previewBand = null;
      return;
    }
    // Runtime-loaded paths already have a band; authoring loads deliberately do not.
    if (this._band) return;
    const capacity = this._samples3.length / RIBBON_BAND_SAMPLE_STRIDE;
    if (!this._previewBand || this._previewBand.maxSamples !== capacity) {
      this._previewBand?.dispose();
      this._previewBand = new RVRibbonBandMesh(capacity, this.RibbonWidthMm, asNode(this.Material), this._resolveLibraryMaterial());
      const mesh = this._previewBand.mesh;
      mesh.name = '__rvRibbonPreview';
      mesh.matrixAutoUpdate = false;
      // Render with scene depth, not the depth-cleared highlight pass. Layer 0
      // thumbnails still exclude this transient band, as does the AO-only pass.
      mesh.layers.set(NO_AO_LAYER);
      mesh.raycast = () => {};
      this._context.scene.add(mesh);
    }
    const band = this._previewBand;
    this.node.updateWorldMatrix(true, false);
    this._context.scene.updateWorldMatrix(true, false);
    band.mesh.matrix.copy(this._context.scene.matrixWorld).invert().multiply(this.node.matrixWorld);
    band.mesh.matrixWorldNeedsUpdate = true;
    band.write(this._samples3, this._sampleCount, this.RibbonWidthMm, 0,
      this._slitSampleIdx, this.FullWidthMm,
      this._drawsPreSlit || this._slitSampleIdx < 0 ? 0 : this._slitSampleIdx);
    band.setTextureLength(this._lengthMm, this.TextureLengthMm, this._sampleStepMm);
  }

  /** Shows or removes routing-order, tangent, and component-owned preview overlays. */
  setEditorPreview(active: boolean): void {
    this._editorPreview = active;
    if (!active || !this._gizmos) {
      for (const handle of this._editorRouting) handle.dispose();
      for (const handle of this._editorTangents) handle.dispose();
      this._editorRouting.length = 0;
      this._editorTangents.length = 0;
      for (const roller of this._rollers) (roller as RVRibbonRoller).setEditorPreview(false);
      return;
    }
    if (this._editorRouting.length === 0) {
      for (let i = 0; i < this._rollers.length; i++) {
        const roller = this._rollers[i];
        const routing = this._gizmos.create(roller.node, {
          shape: 'text', color: 0xffffff, opacity: 1, text: String(i + 1), attachToNode: true,
          excludeFromRaycast: true, depthTest: false, category: 'ribbon-preview', kind: 'routing',
        });
        routing.root.userData.ribbonPreviewKind = 'routing';
        routing.root.userData.ribbonPreviewScreenScale = true;
        this._editorRouting.push(routing);
        for (let tangent = 0; tangent < 2; tangent++) {
          const marker = this._gizmos.create(roller.node, {
          shape: 'sphere-edges', color: 0xe0e0e0, opacity: 0.9, attachToNode: true,
          excludeFromRaycast: true, depthTest: false, category: 'ribbon-preview', kind: 'tangent',
          });
          marker.root.userData.ribbonPreviewKind = 'tangent';
          marker.root.userData.ribbonPreviewScreenScale = true;
          this._editorTangents.push(marker);
        }
      }
    }
    this.node.updateMatrixWorld(true);
    for (let i = 0; i < this._rollers.length; i++) {
      const roller = this._rollers[i];
      roller.node.updateMatrixWorld(true);
      const range = this.arcSampleRange(i);
      this._placeTangent(this._editorTangents[i * 2], roller.node, range.start);
      this._placeTangent(this._editorTangents[i * 2 + 1], roller.node, range.end);
      const localStart = this._sampleInRollerLocal(roller.node, range.start, _a);
      const startRad = roller.axis === 'X' ? Math.atan2(localStart.z, localStart.y)
        : roller.axis === 'Y' ? Math.atan2(localStart.z, localStart.x)
          : Math.atan2(localStart.y, localStart.x);
      const spanRad = Math.max(1e-4,
        Math.min(Math.PI * 2, Math.abs(range.end - range.start) * this._sampleStepMm / Math.max(roller.radiusMm, 1e-6)));
      (roller as RVRibbonRoller).setEditorPreview(true, this.resolvedSideAt(i), { startRad, spanRad });
    }
  }

  private _sampleInRollerLocal(rollerNode: Object3D, sample: number, out: Vector3): Vector3 {
    const clamped = Math.max(0, Math.min(this._sampleCount - 1, sample));
    const at = clamped * RIBBON_BAND_SAMPLE_STRIDE;
    out.set(this._samples3[at], this._samples3[at + 1], this._samples3[at + 2])
      .multiplyScalar(1 / MM_TO_METERS);
    this.node.localToWorld(out);
    return rollerNode.worldToLocal(out);
  }

  private _placeTangent(handle: GizmoHandle, rollerNode: Object3D, sample: number): void {
    handle.root.position.copy(this._sampleInRollerLocal(rollerNode, sample, _tmp));
    handle.root.userData.ribbonPreviewKind = 'tangent';
  }

  onSceneReady(context: ComponentContext): void {
    this._build(context);
  }

  private _build(context: ComponentContext): void {
    if (this._built || this._inert) return;
    this._built = true;
    resolveComponentRefs(this as unknown as Record<string, unknown>, context.registry);

    this._rollers = [];
    for (let i = 0; i < this.Rollers.length; i++) {
      const roller = asRoller(this.Rollers[i]);
      if (!roller) {
        this._goInert(`entry ${i} of Rollers does not resolve to a RibbonRoller or RibbonWinder`);
        return;
      }
      this._rollers.push(roller);
    }
    if (this._rollers.length < 2) {
      this._goInert(`Rollers holds ${this._rollers.length} entries; an open web path needs at least two`);
      return;
    }

    // A winder is an END of the path, by definition of "open" (plan §2.3).
    for (let i = 1; i < this._rollers.length - 1; i++) {
      if (this._rollers[i] instanceof RVRibbonWinder) {
        this._goInert(
          `"${this._rollers[i].node.name}" is a RibbonWinder in the MIDDLE of Rollers; `
          + 'a winder must be the first or the last entry',
        );
        return;
      }
    }
    const first = this._rollers[0];
    const last = this._rollers[this._rollers.length - 1];
    if (first instanceof RVRibbonWinder) first.role = 'unwind';
    if (last instanceof RVRibbonWinder) last.role = 'rewind';

    this._warnDeprecated();
    this._resolveDancers();

    if (!this._buildFrame()) return;
    this._resolveSlit();

    this._samplesPerMeter = this.SamplesPerMeter > 0 ? this.SamplesPerMeter : 64;
    this._signature = new Float32Array(this._rollers.length * SIGNATURE_STRIDE);

    if (!this._solve()) return;
    this._syncTensionPartition();

    // Capacity: the longest the path can get is bounded by the winders growing
    // to their full diameter, which nothing here knows — the margin plus the
    // halving rule below is the answer plan §NFA settles on.
    const wanted = Math.ceil(((this._lengthMm / MM_TO_METERS) * this._samplesPerMeter) * CAPACITY_MARGIN) + 2;
    const capacity = Math.max(2, Math.min(MAX_SAMPLES, wanted));
    this._samples2 = new Float32Array(capacity * RIBBON_SAMPLE_STRIDE);
    this._samples3 = new Float32Array(capacity * RIBBON_BAND_SAMPLE_STRIDE);

    // An authoring load must not materialise runtime geometry into the document
    // (plan-733 R4, same rule as the Chain element clones). The path still
    // solves, so the inspector shows a real length.
    if (context.authoring !== true) {
      this._band = new RVRibbonBandMesh(capacity, this.RibbonWidthMm, asNode(this.Material), this._resolveLibraryMaterial());
      this.node.add(this._band.mesh);
    }

    this._writeGeometry();
    this._captureSignature();
    this._manager?.register(this);
  }

  /**
   * plan-460: `ConnectedDrive` and `SpeedSource` survive in the v1 schema
   * (additive-only, so a plan-459 GLB still validates) but drive nothing. The
   * warning is PRODUCTION, not dev-only — a 459 document whose web silently
   * stands still is otherwise indistinguishable from a broken viewer — and it
   * fires ONCE per loaded document, which is why the flag lives in the manager
   * and is cleared in its `clear()`.
   */
  private _warnDeprecated(): void {
    if (this.ConnectedDrive == null && this.SpeedSource === 'Drive') return;
    if (this._manager && !this._manager.noteDeprecatedFields()) return;
    console.warn(
      '[RibbonPath] ConnectedDrive / SpeedSource are deprecated since plan-460 and are ignored: '
      + 'a web is moved only by a rotational Drive on a RibbonRoller or RibbonWinder node '
      + `(first seen on "${this.node.name}"). Put a rotational Drive on the driving roller.`,
    );
  }

  /**
   * Collect the dancers of this path. Exactly ONE is supported in plan-460 (a
   * second is warned about and ignored, but `_sections` stays an array so N
   * dancers need no rework); a dancer as the first or last roller has no
   * upstream or downstream section and is ignored too.
   */
  private _resolveDancers(): void {
    this._dancers = [];
    for (let i = 0; i < this._rollers.length; i++) {
      const roller = this._rollers[i];
      if (!(roller instanceof RVRibbonDancer)) continue;
      if (i === 0 || i === this._rollers.length - 1) {
        console.warn(
          `[RibbonPath] "${this.node.name}": "${roller.node.name}" is a RibbonDancer at an END of `
          + 'the path; a dancer needs a section on both sides and is ignored.',
        );
        continue;
      }
      if (this._dancers.length >= 1) {
        console.warn(
          `[RibbonPath] "${this.node.name}": "${roller.node.name}" is a SECOND RibbonDancer; `
          + 'plan-460 supports one dancer per path and ignores the rest.',
        );
        continue;
      }
      this._dancers.push(roller);
    }

    // Roller -> section map. A dancer BELONGS to the section it leaves, so the
    // new section starts AT the dancer (it turns with `v_down`, plan §2.3).
    this._sectionOfRoller = new Int32Array(this._rollers.length);
    this._sections = [{ fromRoller: 0, fromSample: 0, driven: null, speed: 0 }];
    let section = 0;
    for (let i = 0; i < this._rollers.length; i++) {
      const roller = this._rollers[i];
      if (this._dancers.includes(roller as RVRibbonDancer)) {
        section++;
        this._sections.push({ fromRoller: i, fromSample: 0, driven: null, speed: 0 });
      }
      this._sectionOfRoller[i] = section;
    }
  }

  /**
   * mm/s — the speed of every section of this path, written into
   * {@link RibbonSection.speed} and returned as the same array instance
   * (allocation-free after the build).
   *
   * The rule (plan §2.3 Abschnittsvertrag):
   *   - a section's speed is the surface speed of its LAST driven roller in
   *     running direction (the pulling one); several driven rollers that differ
   *     by more than 1 % warn once, because slip is not simulated;
   *   - empty sections are filled in TWO passes — backwards first (take the next
   *     driven section in running direction), then forwards for trailing ones;
   *   - a path without any driven roller stands still, with one warning.
   */
  readSectionSpeeds(): readonly RibbonSection[] {
    const sections = this._sections;
    for (const s of sections) { s.driven = null; s.speed = 0; }

    let anyDriven = false;
    for (let i = 0; i < this._rollers.length; i++) {
      const roller = this._rollers[i];
      if (!roller.isDriven) continue;
      anyDriven = true;
      const s = sections[this._sectionOfRoller[i]];
      const v = roller.surfaceSpeedMmPerS;
      if (s.driven && !this._warnedMismatch) {
        const ref = Math.max(Math.abs(s.speed), Math.abs(v));
        if (ref > 0 && Math.abs(s.speed - v) / ref > SECTION_SPEED_MISMATCH) {
          this._warnedMismatch = true;
          console.warn(
            `[RibbonPath] "${this.node.name}": "${s.driven.node.name}" and "${roller.node.name}" drive `
            + `the same web section at ${s.speed.toFixed(1)} and ${v.toFixed(1)} mm/s; slip is not `
            + 'simulated, so the last roller in running direction wins.',
          );
        }
      }
      // LAST driven roller in running direction wins: keep overwriting.
      s.driven = roller;
      s.speed = v;
    }

    if (!anyDriven) {
      if (!this._warnedNoDrivenRoller) {
        this._warnedNoDrivenRoller = true;
        console.warn(
          `[RibbonPath] "${this.node.name}" has no driven roller — put a rotational Drive on one of `
          + 'its rollers or winders. The web is built but stands still.',
        );
      }
      return sections;
    }

    // Pass 1 (backwards): an empty section takes the next driven one downstream.
    for (let k = sections.length - 2; k >= 0; k--) {
      if (!sections[k].driven) { sections[k].speed = sections[k + 1].speed; sections[k].driven = sections[k + 1].driven; }
    }
    // Pass 2 (forwards): trailing empty sections take the previous one.
    for (let k = 1; k < sections.length; k++) {
      if (!sections[k].driven) { sections[k].speed = sections[k - 1].speed; sections[k].driven = sections[k - 1].driven; }
    }
    return sections;
  }

  /** Build the orthonormal `(e1, e2, a)` frame; false when the axes disagree. */
  private _buildFrame(): boolean {
    this.node.updateMatrixWorld(true);
    _inv.copy(this.node.matrixWorld).invert();

    // The common axis, in the path node's local frame, from the FIRST roller.
    if (!this._localAxisOf(this._rollers[0], this._basisA)) {
      this._goInert(`"${this._rollers[0].node.name}" has a degenerate ${this._rollers[0].axis} axis`);
      return false;
    }
    for (let i = 1; i < this._rollers.length; i++) {
      if (!this._localAxisOf(this._rollers[i], _a)) {
        this._goInert(`"${this._rollers[i].node.name}" has a degenerate ${this._rollers[i].axis} axis`);
        return false;
      }
      const angle = Math.acos(Math.min(1, Math.abs(_a.dot(this._basisA))));
      if (angle > AXIS_TOLERANCE_RAD) {
        this._goInert(
          `"${this._rollers[i].node.name}" deviates ${((angle * 180) / Math.PI).toFixed(2)} deg from the `
          + `path axis of "${this._rollers[0].node.name}"; every roller of a web path must be parallel`,
        );
        return false;
      }
    }

    // Any unit vector perpendicular to `a` will do — the 2D frame is internal.
    _tmp.set(1, 0, 0);
    if (Math.abs(this._basisA.dot(_tmp)) > 0.9) _tmp.set(0, 1, 0);
    this._basisE1.copy(_tmp).cross(this._basisA).normalize();
    this._basisE2.copy(this._basisA).cross(this._basisE1).normalize();

    // Origin at roller 0; axial position at the mean, so the band sits in the
    // middle of the machine rather than on the first roller's face.
    this._localCentreMm(this._rollers[0], this._origin);
    let axialSum = 0;
    for (const r of this._rollers) {
      this._localCentreMm(r, _c);
      axialSum += _c.sub(this._origin).dot(this._basisA);
    }
    this._axialMeanMm = axialSum / this._rollers.length;
    this._localCentreMm(this._rollers[this._rollers.length - 1], _c);
    this._lastAxialMm = _c.sub(this._origin).dot(this._basisA);
    return true;
  }

  /** The roller's rotation axis in the path node's local frame (unit). */
  private _localAxisOf(roller: RibbonRollerLike, out: Vector3): boolean {
    axisVector(roller.axis, out);
    roller.node.updateMatrixWorld(true);
    out.transformDirection(roller.node.matrixWorld).transformDirection(_inv);
    return out.lengthSq() > 1e-12 && Number.isFinite(out.x);
  }

  /** mm — the roller's centre in the path node's local frame. */
  private _localCentreMm(roller: RibbonRollerLike, out: Vector3): Vector3 {
    roller.node.updateMatrixWorld(true);
    out.setFromMatrixPosition(roller.node.matrixWorld).applyMatrix4(_inv).multiplyScalar(MM_TO_METERS);
    return out;
  }

  /** Solve the tangent chain from the CURRENT roller poses and radii. */
  private _solve(): boolean {
    this.node.updateMatrixWorld(true);
    _inv.copy(this.node.matrixWorld).invert();
    const half = this.RibbonThicknessMm / 2;
    const lastIdx = this._rollers.length - 1;
    this._circles.length = 0;
    for (let i = 0; i <= lastIdx; i++) {
      const roller = this._rollers[i];
      this._localCentreMm(roller, _c).sub(this._origin);
      // plan-468: only the two ENDS of the open path can wrap visibly, and only a
      // `RibbonWinder` carries `WrapDeg` — an inner roller already has an arc
      // derived from its two tangents, and a plain roller has no field to read.
      const wrapDeg = (i === 0 || i === lastIdx) && roller instanceof RVRibbonWinder ? roller.WrapDeg : 0;
      this._circles.push({
        cx: _c.dot(this._basisE1),
        cy: _c.dot(this._basisE2),
        // The half thickness rides on the CONTACT radius: correct for a Left and
        // a Right wrap alike, which a flat normal offset would not be.
        r: roller.radiusMm + half,
        side: roller.sideSign,
        wrapRad: wrapDeg > 0 ? wrapDeg * DEG_TO_RAD : undefined,
      });
    }
    const built = buildRibbonSegments(this._circles);
    if ('error' in built) {
      this._goInert(built.error);
      return false;
    }
    this._segments = built.segments;
    this._lengthMm = built.lengthMm;
    this._startArcOffset = (this._circles[0]?.wrapRad ?? 0) > 0 ? 1 : 0;
    this._noteResolvedSides();
    return true;
  }

  /**
   * Bump {@link sidesVersion} when `resolveAutoSides` decided differently than
   * on the previous solve.
   *
   * It genuinely can: `RibbonSide: Auto` is re-resolved from the CURRENT roller
   * positions on every solve, so a travelling dancer that crosses the chord
   * between its neighbours flips a side mid-run — and with it, potentially, the
   * side of a roller SHARED with a sibling strip. The manager's shared-side
   * check runs on grouping only, which would never see that; the counter is what
   * tells it to look again (and it is a counter rather than a flag so a
   * many-to-one comparison stays a single integer compare per member).
   */
  private _noteResolvedSides(): void {
    let changed = this._resolvedSides.length !== this._circles.length;
    if (!changed) {
      for (let i = 0; i < this._circles.length; i++) {
        if (this._resolvedSides[i] !== this._circles[i].side) { changed = true; break; }
      }
    }
    if (!changed) return;
    this._resolvedSides = this._circles.map((c) => c.side as RibbonSideSign);
    this._sidesVersion++;
  }

  /** Sample the current segments and write the band. */
  private _writeGeometry(): void {
    // `sampleArcLength` reports the step it ACTUALLY used — it coarsens the grid
    // by an integer factor when the path does not fit — so the step is taken
    // from its answer and never recomputed from `_samplesPerMeter`. Getting that
    // wrong makes every arc-length → sample-index conversion (the slit, the
    // section starts, the texture mapping) silently disagree with the geometry.
    let sampling = sampleArcLength(this._segments, MM_TO_METERS / this._samplesPerMeter, this._samples2);
    const capacity = Math.floor(this._samples2.length / RIBBON_SAMPLE_STRIDE);
    if (sampling.count >= capacity && !this._capacityWarned) {
      // The path outgrew the buffer — halve the density ONCE instead of
      // reallocating mid-simulation (plan §NFA capacity rule).
      this._capacityWarned = true;
      this._samplesPerMeter = Math.max(1, this._samplesPerMeter / 2);
      console.warn(
        `[RibbonPath] "${this.node.name}" outgrew its sample buffer (${capacity} samples); `
        + `SamplesPerMeter halved to ${this._samplesPerMeter}.`,
      );
      sampling = sampleArcLength(this._segments, MM_TO_METERS / this._samplesPerMeter, this._samples2);
    }
    const count = sampling.count;
    this._sampleStepMm = sampling.stepMm;
    this._sampleCount = count;
    this._slitSampleIdx = this._slitRollerIdx >= 0 ? this._rollerArcStartSample(this._slitRollerIdx, count) : -1;
    // A dancer moves every tick, so its sample boundary is recomputed here with
    // the rest of the geometry rather than cached at build time.
    this._sectionStarts.length = 0;
    for (let k = 1; k < this._sections.length; k++) {
      const at = this._rollerArcEndSample(this._sections[k].fromRoller, count);
      this._sections[k].fromSample = at;
      this._sectionStarts.push(at);
    }

    // 2D (mm) -> 3D (mm) in the path node's local frame; up vector = the axis.
    for (let i = 0; i < count; i++) {
      const s2 = i * RIBBON_SAMPLE_STRIDE;
      const s3 = i * RIBBON_BAND_SAMPLE_STRIDE;
      const x = this._samples2[s2];
      const y = this._samples2[s2 + 1];
      const tx = this._samples2[s2 + 2];
      const ty = this._samples2[s2 + 3];
      // Lateral lane: a slit strip runs centred on the first roller (the full
      // web) up to the slit — the ARRIVAL tangent point of the slit roller —
      // then in its own lane at the last roller's axial offset; an unslit path
      // stays at the rollers' mean, as before.
      const ax = this._slitRollerIdx >= 0
        ? (i < this._slitSampleIdx ? 0 : this._lastAxialMm)
        : this._axialMeanMm;
      this._samples3[s3] = this._origin.x + this._basisE1.x * x + this._basisE2.x * y + this._basisA.x * ax;
      this._samples3[s3 + 1] = this._origin.y + this._basisE1.y * x + this._basisE2.y * y + this._basisA.y * ax;
      this._samples3[s3 + 2] = this._origin.z + this._basisE1.z * x + this._basisE2.z * y + this._basisA.z * ax;
      this._samples3[s3 + 3] = this._basisE1.x * tx + this._basisE2.x * ty;
      this._samples3[s3 + 4] = this._basisE1.y * tx + this._basisE2.y * ty;
      this._samples3[s3 + 5] = this._basisE1.z * tx + this._basisE2.z * ty;
      this._samples3[s3 + 6] = this._basisA.x;
      this._samples3[s3 + 7] = this._basisA.y;
      this._samples3[s3 + 8] = this._basisA.z;
    }

    // Tension deforms the FINISHED 3D samples, in the path's own local frame
    // (Auflage A2), and it is the last thing to touch them: `write()` below sees
    // the sagged buffer, and a taut path never enters either method.
    if (this._tensionOn) {
      this._refreshZoneSamples(count);
      this._applySag(count);
    }

    if (this._band) {
      this._band.write(
        this._samples3, count, this.RibbonWidthMm, 0,
        this._slitSampleIdx, this.FullWidthMm,
        this._drawsPreSlit || this._slitSampleIdx < 0 ? 0 : this._slitSampleIdx,
      );
      // Groups AFTER write(): they are expressed in the sample count write() set,
      // and `setDrawStart` (the slit) is applied inside write() and intersects
      // with the groups rather than replacing them.
      this._applyBandGroups();
      // The step goes with it: the last interval is shorter than a step, so a
      // texture mapping that is uniform per SAMPLE would compress a whole
      // repetition step into it. `setTextureLength` maps by arc length instead.
      this._band.setTextureLength(this._lengthMm, this.TextureLengthMm, this._sampleStepMm);
    }
  }

  // -- Slit -------------------------------------------------------

  /** The roller this strip is slit off at, or `null`. */
  get slitRoller(): RibbonRollerLike | null {
    return this._slitRollerIdx >= 0 ? this._rollers[this._slitRollerIdx] : null;
  }

  /** First sample after the slit, or -1 (diagnostics + tests). */
  get slitSampleIndex(): number {
    return this._slitSampleIdx;
  }

  /** Whether this path draws the shared full-width web before the slit. */
  get drawsPreSlit(): boolean {
    return this._drawsPreSlit;
  }

  /**
   * Set by the manager: of all strips slit at the same roller, exactly ONE draws
   * the full-width web before it. Applies immediately to the band's draw range.
   */
  /**
   * Set by the manager: the strip whose pre-slit zones this one adopts, or
   * `null` when this strip owns them. The manager prepares the owner first, so
   * what is copied is always the value of THIS tick.
   */
  setPreSlitTensionSource(source: RVRibbonPath | null): void {
    this._preSlitSource = source === this ? null : source;
  }

  /** The pre-slit zone spanning the same two rollers as `zone`, or null. */
  private _matchingZone(zone: RibbonTensionZone): RibbonTensionZone | null {
    const source = this._preSlitSource;
    if (!source) return null;
    // Matched on the roller OBJECTS, not their indices: the strips share these
    // rollers but need not list them at the same position.
    const from = this._rollers[zone.fromRoller];
    const to = this._rollers[zone.toRoller];
    for (const candidate of source._zones) {
      if (source._rollers[candidate.fromRoller] === from
        && source._rollers[candidate.toRoller] === to) return candidate;
    }
    return null;
  }

  setDrawsPreSlit(flag: boolean): void {
    if (this._drawsPreSlit === flag) return;
    this._drawsPreSlit = flag;
    if (this._band && this._slitSampleIdx >= 0) {
      this._band.setDrawStart(flag ? 0 : this._slitSampleIdx);
    }
  }

  /** Resolve `SlitAtRoller` to an INNER roller of this path; warn and ignore otherwise. */
  private _resolveSlit(): void {
    this._slitRollerIdx = -1;
    const node = asNode(this.SlitAtRoller);
    if (!node) return;
    const idx = this._rollers.findIndex((r) => r.node === node);
    if (idx <= 0 || idx >= this._rollers.length - 1) {
      console.warn(
        `[RibbonPath] "${this.node.name}": SlitAtRoller must be one of the INNER rollers of `
        + 'this path (not the first or last) - slit ignored.',
      );
      return;
    }
    if (!(this.FullWidthMm > 0)) {
      console.warn(`[RibbonPath] "${this.node.name}": SlitAtRoller set but FullWidthMm is 0 - slit ignored.`);
      return;
    }
    this._slitRollerIdx = idx;
  }

  /**
   * The sample index at arc length `s` (mm from the path start).
   *
   * Rounded onto the ABSOLUTE grid `sampleArcLength` writes — sample `i` at
   * `i * _sampleStepMm` — and NOT onto `lengthMm / (count - 1)`. That is the
   * whole point of the absolute grid: two strips that share every roller up to
   * the cutter but end at different rewinders have different totals, so a
   * length-derived spacing would round the SAME physical point to different
   * indices for the two of them, and the shared full-width web would stop a
   * sample short of the blade or run a sample past it.
   */
  private _sampleAtArcLength(s: number, count: number): number {
    if (count < 2 || !(this._sampleStepMm > 0)) return 0;
    return Math.min(count - 1, Math.max(0, Math.round(s / this._sampleStepMm)));
  }

  /**
   * The sample index where roller `idx`'s arc ENDS — the DEPARTURE tangent
   * point, where the web leaves that roller. Segments alternate line/arc, so
   * roller `k`'s arc is segment `2k - 1` — plus {@link _startArcOffset}, which a
   * `WrapDeg` on the unwinder shifts the whole list by (plan-468).
   *
   * This is the SECTION boundary: a dancer hands the web to the next speed where
   * it lets go of it.
   */
  private _rollerArcEndSample(idx: number, count: number): number {
    let s = 0;
    const last = 2 * idx - 1 + this._startArcOffset;
    for (let i = 0; i <= last && i < this._segments.length; i++) s += this._segments[i].lengthMm;
    return this._sampleAtArcLength(s, count);
  }

  /**
   * The sample index where roller `idx`'s arc BEGINS — the ARRIVAL tangent
   * point, where the web first touches that roller: segments `0` up to
   * `2*idx - 2`, shifted by {@link _startArcOffset} (plan-468).
   *
   * This is the SLIT boundary, and it is deliberately NOT the departure point.
   * The blade of a slitter sits where the web meets the cutting roller, and two
   * strips cut at the same roller LEAVE it at different angles (their wraps
   * differ because their next rollers differ). Cutting at the departure point
   * therefore made the pre-slit owner draw full-width web over an arc its
   * sibling strip was already drawing in its own lane — the two overlapped on
   * the roller and z-fought. From the arrival point on, every strip draws only
   * itself, in its own lane, and all of them start at the same sample.
   */
  private _rollerArcStartSample(idx: number, count: number): number {
    let s = 0;
    const last = 2 * idx - 2 + this._startArcOffset;
    for (let i = 0; i <= last && i < this._segments.length; i++) s += this._segments[i].lengthMm;
    return this._sampleAtArcLength(s, count);
  }

  // ── Dirty gate ─────────────────────────────────────────────────

  /** Write the current pose + radius snapshot into {@link _signature}. */
  private _captureSignature(): void {
    for (let i = 0; i < this._rollers.length; i++) {
      const roller = this._rollers[i];
      const at = i * SIGNATURE_STRIDE;
      roller.node.updateMatrixWorld(true);
      _c.setFromMatrixPosition(roller.node.matrixWorld);
      // The axis image is deliberately UNNORMALISED: it carries direction and
      // axial scale in one, so a scaled roller is a change even when its
      // direction did not move.
      axisVector(roller.axis, _a).transformDirection(roller.node.matrixWorld);
      _radial.copy(this._radialProbe(roller)).applyMatrix4(roller.node.matrixWorld).sub(_c);
      this._signature[at] = _c.x;
      this._signature[at + 1] = _c.y;
      this._signature[at + 2] = _c.z;
      this._signature[at + 3] = _a.x;
      this._signature[at + 4] = _a.y;
      this._signature[at + 5] = _a.z;
      this._signature[at + 6] = _radial.length();
      this._signature[at + 7] = roller.radiusMm;
      this._signature[at + 8] = roller.sideSign;
    }
  }

  /** A unit vector perpendicular to the roller axis, used as the scale probe. */
  private _radialProbe(roller: RibbonRollerLike): Vector3 {
    return _tmp.set(
      roller.axis === 'X' ? 0 : 1,
      roller.axis === 'Y' ? 0 : (roller.axis === 'X' ? 1 : 0),
      roller.axis === 'Z' ? 0 : (roller.axis === 'X' ? 0 : 1),
    );
  }

  /** True when any roller moved, was scaled, or changed radius since the last build. */
  private _isDirty(): boolean {
    for (let i = 0; i < this._rollers.length; i++) {
      const roller = this._rollers[i];
      const at = i * SIGNATURE_STRIDE;
      roller.node.updateMatrixWorld(true);
      _c.setFromMatrixPosition(roller.node.matrixWorld);
      axisVector(roller.axis, _a).transformDirection(roller.node.matrixWorld);
      _radial.copy(this._radialProbe(roller)).applyMatrix4(roller.node.matrixWorld).sub(_c);
      if (Math.abs(_c.x - this._signature[at]) > POSE_EPSILON) return true;
      if (Math.abs(_c.y - this._signature[at + 1]) > POSE_EPSILON) return true;
      if (Math.abs(_c.z - this._signature[at + 2]) > POSE_EPSILON) return true;
      if (Math.abs(_a.x - this._signature[at + 3]) > POSE_EPSILON) return true;
      if (Math.abs(_a.y - this._signature[at + 4]) > POSE_EPSILON) return true;
      if (Math.abs(_a.z - this._signature[at + 5]) > POSE_EPSILON) return true;
      if (Math.abs(_radial.length() - this._signature[at + 6]) > POSE_EPSILON) return true;
      if (Math.abs(roller.radiusMm - this._signature[at + 7]) > RADIUS_EPSILON_MM) return true;
      if (roller.sideSign !== this._signature[at + 8]) return true;
    }
    return false;
  }

  // ── Tick ───────────────────────────────────────────────────────

  /**
   * Advance the path by `vMmPerS` for `dt` seconds. The manager has already
   * determined the group's effective speed and integrated the winders, so this
   * is purely the visual half: rebuild if dirty, turn the rollers, scroll the
   * texture. Returns `true` when anything visible changed.
   */
  updatePose(dt: number, speeds: readonly number[], rotated?: Set<RibbonRollerLike>): boolean {
    if (this._inert || this._segments.length === 0) return false;
    let changed = false;

    // The manager clamped the raw reading (winder limits, dancer stops); write
    // the EFFECTIVE speeds back so `sections` reports what actually ran. It is
    // the diagnostic surface the inspector and the tests read.
    for (let k = 0; k < this._sections.length; k++) this._sections[k].speed = speeds[k] ?? 0;

    // `prepareTension` (step 4c) may already have re-solved this tick, because
    // the zone lengths have to come from THIS tick's geometry. It leaves the
    // write to us rather than doing it itself: sampling and the band write are
    // the expensive half and belong in step 5, where they always were.
    if (this._pendingWrite) {
      this._pendingWrite = false;
      this._writeGeometry();
      this._captureSignature();
      changed = true;
    } else if (this._isDirty()) {
      if (!this._solve()) return false;
      this._writeGeometry();
      this._captureSignature();
      changed = true;
    }

    if (dt > 0) {
      for (let i = 0; i < this._rollers.length; i++) {
        const roller = this._rollers[i];
        const section = this._sectionOfRoller[i];
        const jammedDancer = i === this._dancerIdx && (roller as RVRibbonDancer).jammed;
        const v = speeds[jammedDancer ? section - 1 : section] ?? 0;
        if (v === 0) continue;
        // A DRIVEN roller is turned by its own drive — the path turning it too
        // would double its rotation (plan-460 F0).
        if (roller.isDriven) continue;
        // Shared rollers (slitter) are turned by the first strip that reaches them.
        if (rotated) {
          if (rotated.has(roller)) continue;
          rotated.add(roller);
        }
        roller.advanceAngle(angularSpeedRad(v, roller.radiusMm, 1) * dt);
        changed = true;
      }
      if (this._band && this.TextureLengthMm > 0) {
        for (let k = 0; k < this._sections.length; k++) {
          const v = speeds[k] ?? 0;
          if (v === 0) continue;
          this._band.scroll(k, (v * dt) / this.TextureLengthMm);
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Restore the authored web: rollers, winders, band shape and scroll offset. */
  reset(): void {
    if (this._inert) return;
    for (const roller of this._rollers) roller.reset();
    this._band?.resetScroll();
    this.resetTension();
    if (this._solve()) {
      this._writeGeometry();
      this._captureSignature();
    }
    this._pendingWrite = false;
  }

  // ── Teardown ───────────────────────────────────────────────────

  private _goInert(reason: string): void {
    this._inert = true;
    this._segments = [];
    console.warn(`[RibbonPath] "${this.node.name}" is inactive: ${reason}.`);
  }

  getLiveState(): Record<string, unknown> {
    const last = this._zones.length > 0 ? this._zones[this._zones.length - 1] : null;
    return {
      LengthMm: this._lengthMm,
      SampleCount: this._sampleCount,
      Active: this.isActive,
      TensionEnabled: this._tensionOn,
      ZoneCount: this._zones.length,
      TensionN: last ? last.tensionN : 0,
      SpecificTensionNPerM: last ? specificTension(last.tensionN, this.RibbonWidthMm) : 0,
      StrainPercent: last ? last.eps * 100 : 0,
    };
  }


  // -- Tension ----------------------------------------------------

  /** True while the zone partition exists (diagnostics + tests). */
  get tensionEnabled(): boolean {
    return this._tensionOn;
  }

  /** The tension zones in running order; EMPTY while tension is off. */
  get zones(): readonly RibbonTensionZone[] {
    return this._zones;
  }

  /** The group -> zone map of the current band partition (diagnostics + tests). */
  get groupToZone(): readonly number[] {
    return this._groupToZone;
  }

  /** The group -> section map of the current band partition (diagnostics + tests). */
  get groupToSection(): readonly number[] {
    return this._groupToSection;
  }

  /**
   * The strain every zone starts, resets and enters at: the unwinder pays the
   * web out at `TargetTensionNPerM`, so
   * `eps_ref = (T_target * w / 1000) / (K * w)`. The width cancels, which is
   * why a wider web at the same tension per unit width is not more strained.
   */
  get referenceStrain(): number {
    return strainFromTension(
      (this.TargetTensionNPerM * this.RibbonWidthMm) / 1000,
      this.TensileStiffnessNPerMmWidth,
      this.RibbonWidthMm,
    );
  }

  /** The per-zone readout the inspector and the overlay render. */
  get tensionReadout(): { zones: RibbonZoneReadout[]; specificTenacityNmPerKg: number } {
    const zones: RibbonZoneReadout[] = [];
    let lastNPerM = 0;
    for (const zone of this._zones) {
      const nPerM = specificTension(zone.tensionN, this.RibbonWidthMm);
      lastNPerM = nPerM;
      zones.push({
        eps: zone.eps,
        tensionN: zone.tensionN,
        nPerM,
        pli: pliFromNPerM(nPerM),
        lengthMm: zone.lengthMm,
        mode: zone.mode,
        state: zone.state,
        estimated: zone.estimated,
      });
    }
    return { zones, specificTenacityNmPerKg: specificTenacity(lastNPerM, this.BasisWeightGsm) };
  }

  /**
   * Step 4c of `RibbonManager.update`: bring every zone's strain up to date,
   * with the lengths of THIS tick's geometry.
   *
   * It runs AFTER the dancer and the winders were integrated (4a/4b) and BEFORE
   * the pose (5), and it may therefore have to re-solve the tangent chain
   * itself: the dancer moved a moment ago, and integrating the span equation
   * over yesterday's length is a lag that shows up directly in the readout. The
   * SAMPLING is deliberately not pulled forward with it — that is the expensive
   * half and stays in step 5, which {@link _pendingWrite} hands it over to.
   *
   * `stopped` is the group-wide winder stop of step 3a: it zeroes EVERY boundary
   * slot, which by the span equation leaves every strain exactly where it was.
   */
  prepareTension(dt: number, speeds: readonly number[], stopped: boolean): void {
    if (this._inert) return;
    this._syncTensionPartition();
    if (!this._tensionOn) return;
    if (this._isDirty()) {
      if (!this._solve()) return;
      this._pendingWrite = true;
    }
    this._refreshZoneLengths();
    this._readBoundarySpeeds(speeds, stopped);
    this._integrateZones(dt);
    this._noteSagInvalidation();
  }

  /**
   * The MATERIAL half of the invalidation contract (Auflage A1): the tint
   * saturation and the alarm pulse are written here, every tick, WITHOUT
   * touching the sample buffer. A web whose deviation grows while its rollers
   * stand still changes colour continuously and is never re-sampled.
   */
  updateTensionVisuals(timeSec: number): void {
    this._updateOverlay();
    this._reportAlarm();
    if (!this._band) return;
    if (!this._tensionOn || !this.TensionColoring) {
      this._clearTint();
      return;
    }
    const strength = Math.min(1, Math.max(0, this.TintStrength));
    // The pulse is a brightness modulation, never an on/off blink: an alarm that
    // is invisible for half of every cycle cannot be read from a screenshot,
    // which is exactly what the still-image requirement of E8 forbids.
    const pulse = 0.65 + 0.35 * Math.sin(2 * Math.PI * ALARM_PULSE_HZ * timeSec);
    for (let g = 0; g < this._groupToZone.length; g++) {
      const zone = this._zones[this._groupToZone[g]];
      const tint = zone ? ZONE_TINT[zone.state] : null;
      if (!zone || tint === null) {
        this._band.applyTint(g, null, 0, 0);
        continue;
      }
      const alarm = isRibbonAlarm(zone.state);
      // Out of band the saturation starts at a floor rather than at 0, so the
      // band limit is a visible STEP (plan-471: a hard edge, not a shade to
      // estimate) and then grows continuously to full at the alarm threshold.
      const amount = alarm
        ? strength * pulse
        : strength * (TINT_FLOOR + (1 - TINT_FLOOR) * bandDeviation(zone.eps, this._thresholds));
      this._band.applyTint(g, tint, amount, alarm ? amount * 0.8 : 0);
    }
  }

  /**
   * The path's own six signal slots. Measured at the LAST zone (the one that
   * runs into the rewinder, which is where a machine puts its load cell); the
   * three booleans are an OR over every zone.
   */
  writeTensionSignals(write: (address: string, value: number | boolean) => void): void {
    const last = this._zones.length > 0 ? this._zones[this._zones.length - 1] : null;
    const tensionN = last ? last.tensionN : 0;
    const nPerM = last ? specificTension(last.tensionN, this.RibbonWidthMm) : 0;
    const strainPercent = last ? last.eps * 100 : 0;
    let slack = false;
    let over = false;
    let broken = false;
    for (let k = 0; k < this._zones.length; k++) {
      const state = this._zones[k].state;
      if (state === 'slack') slack = true;
      if (state === 'over' || state === 'broken') over = true;
      if (this._zones[k].broken) broken = true;
    }
    // The hysteresis on the force is expressed in the SAME unit as the one on
    // the tension per unit width, so a wide and a narrow web are equally chatty.
    const forceEpsilon = SIGNAL_EPSILON_N_PER_M * (this.RibbonWidthMm / 1000);
    if (typeof this.TensionN === 'string' && movedBy(tensionN, this._lastTensionN, forceEpsilon)) {
      this._lastTensionN = tensionN;
      write(this.TensionN, tensionN);
    }
    if (typeof this.SpecificTensionNPerM === 'string'
      && movedBy(nPerM, this._lastNPerM, SIGNAL_EPSILON_N_PER_M)) {
      this._lastNPerM = nPerM;
      write(this.SpecificTensionNPerM, nPerM);
    }
    if (typeof this.StrainPercent === 'string'
      && movedBy(strainPercent, this._lastStrainPercent, SIGNAL_EPSILON_STRAIN_PERCENT)) {
      this._lastStrainPercent = strainPercent;
      write(this.StrainPercent, strainPercent);
    }
    if (typeof this.IsSlack === 'string' && slack !== this._lastSlack) {
      this._lastSlack = slack;
      write(this.IsSlack, slack);
    }
    if (typeof this.IsOverstretched === 'string' && over !== this._lastOver) {
      this._lastOver = over;
      write(this.IsOverstretched, over);
    }
    if (typeof this.IsBroken === 'string' && broken !== this._lastBroken) {
      this._lastBroken = broken;
      write(this.IsBroken, broken);
    }
  }

  /**
   * Start / reset: every zone back to `eps_ref`, every break cleared, every
   * once-per-run warning armed again, and a clean geometry write queued so a
   * buffer that still holds a sag is replaced rather than left standing.
   */
  resetTension(): void {
    this._warnedBackwards = false;
    const epsRef = this.referenceStrain;
    for (let k = 0; k < this._zones.length; k++) {
      const zone = this._zones[k];
      zone.eps = epsRef;
      zone.broken = false;
      zone.mode = 'integrated';
      zone.state = 'inBand';
      zone.estimated = false;
      zone.sagDepthMm = 0;
      zone.tensionN = 0;
    }
    this._lastTensionN = Number.NaN;
    this._lastNPerM = Number.NaN;
    this._lastStrainPercent = Number.NaN;
    this._lastSlack = null;
    this._lastOver = null;
    this._lastBroken = null;
    this._writtenSagMm = 0;
    this._pendingWrite = true;
  }

  /**
   * The readout overlay (E7). It is created on the first tick that actually
   * wants it and destroyed again the moment it is switched off, so a path whose
   * `ShowTensionLabels` is never turned on pays nothing for it — and a viewer
   * without a gizmo manager (a plain unit test) simply has no overlay.
   */
  private _updateOverlay(): void {
    if (this._context?.authoring) {
      this._overlay?.dispose();
      this._overlay = null;
      return;
    }
    if (!this._overlay) {
      if (!this._gizmos || !this._wantsOverlay) return;
      this._overlay = new RVRibbonTensionOverlay(this, this._gizmos);
    }
    this._overlay.update();
  }

  /**
   * True when the overlay has anything to say.
   *
   * Only the tension ZONES: the dancer draws its own track and its own readout
   * (`RibbonDancer.ShowTravel` / `ShowValues`), so a scene with a dancer and no
   * tension configured builds no overlay at all.
   *
   * Alarm messages remain active independently of these diagnostic labels.
   */
  private get _wantsOverlay(): boolean {
    return this._tensionOn && this.ShowTensionLabels;
  }

  /** The readout overlay, or `null` while it was never needed (tests). */
  get tensionOverlay(): RVRibbonTensionOverlay | null {
    return this._overlay;
  }

  /**
   * Publish a slack / overstretched / torn web into the viewer-wide
   * {@link ErrorStore} — the SAME registry `WebError` components report into,
   * which feeds the error panel and the `web_errors` tool.
   *
   * The floating label answers "which span, and by how much" for someone looking
   * at the machine; this answers "is anything wrong in this cell" for someone
   * looking at the panel, or for an agent that never looks at all. A fault that
   * is only drawn in 3D is invisible to both.
   *
   * ONE entry per path, carrying the WORST zone: the store is keyed by node path,
   * and a torn web that also has two slack spans is one fault to an operator, not
   * three. `below` / `above` are deliberately not reported — a deviation inside
   * the usable range is a reading, not an alarm (see `RIBBON_ALARM_STATES`).
   */
  private _reportAlarm(): void {
    const store = this._errors;
    if (!store) return;
    let worst: RibbonTensionZone | null = null;
    if (this._tensionOn) {
      for (const zone of this._zones) {
        if (!isRibbonAlarm(zone.state)) continue;
        if (!worst || ALARM_RANK[zone.state] > ALARM_RANK[worst.state]) worst = zone;
      }
    }
    // A TORN web is reported without figures. Once the break latches, the strain
    // the integrator is sitting on is whatever it reached on the way through —
    // hundreds of percent for a hard fault — and printing it in an operator
    // message is worse than printing nothing: a torn web carries no tension at
    // all, so there is no number that would be true.
    const text = !worst
      ? ''
      : worst.state === 'broken'
        ? `${this.node.name}: web ${ALARM_TEXT[worst.state]}`
        : `${this.node.name}: web ${ALARM_TEXT[worst.state]} `
          + `(${(worst.eps * 100).toFixed(2)} % strain, `
          + `${specificTension(worst.tensionN, this.RibbonWidthMm).toFixed(0)} N/m)`;
    if (text === this._lastAlarmText) return;
    this._lastAlarmText = text;
    store.setActive(this._alarmPath, text !== '', text);
  }

  // -- Tension internals ------------------------------------------

  /**
   * Build, keep or tear down the partition, from the CURRENT configuration.
   *
   * Three things can change it at run time: the stiffness being switched on or
   * off, a `Drive` appearing on or leaving a roller (which moves a boundary),
   * and a rebuild of the roller list. All three are handled here rather than at
   * build time, because all three genuinely happen mid-run.
   */
  private _syncTensionPartition(): void {
    const configured = this.TensileStiffnessNPerMmWidth > 0 && this.RibbonWidthMm > 0;
    if (!configured) {
      if (this._tensionOn) this._teardownTension();
      return;
    }
    if (this._tensionOn && !this._boundariesMoved()) return;
    this._buildZones();
  }

  /**
   * Whether `zone` lies upstream of the blade, where the web is still one sheet.
   *
   * A path without a cut has no such zone. With a cut, `_isBoundary` guarantees
   * the blade is a boundary, so every zone is wholly on one side of it and the
   * end roller alone decides the side (SOL R1 #5).
   */
  private _zoneIsPreSlit(zone: RibbonTensionZone): boolean {
    return this._slitRollerIdx > 0 && zone.toRoller <= this._slitRollerIdx;
  }

  /**
   * The width that carries the force in `zone`, in mm.
   *
   * This is where the force splits. Before the blade the sheet is `FullWidthMm`
   * wide and one strain over that width holds the whole force; after it, this
   * strip carries `RibbonWidthMm`. Because a strip leaves the blade at the
   * shared strain, its share of the force is exactly its share of the width —
   * the split is a consequence of the widths, never a separate division.
   */
  private _zoneWidthMm(zone: RibbonTensionZone): number {
    return this._zoneIsPreSlit(zone) && this.FullWidthMm > 0
      ? this.FullWidthMm
      : this.RibbonWidthMm;
  }

  /** True when the set of boundary rollers differs from the built partition. */
  private _boundariesMoved(): boolean {
    const n = this._rollers.length;
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!this._isBoundary(i, n)) continue;
      if (k >= this._boundaries.length || this._boundaries[k] !== i) return true;
      k++;
    }
    return k !== this._boundaries.length;
  }

  /**
   * A boundary is where the web CANNOT slip: the two ends of the open path, any
   * driven roller (the nip pulls), and the dancer (it stores). An idler is not a
   * boundary — the web runs over it at whatever speed the span has, which is
   * exactly why a zone may contain several of them.
   */
  private _isBoundary(i: number, n: number): boolean {
    if (i === 0 || i === n - 1) return true;
    // The blade is a boundary whether or not it is driven: upstream of it the
    // web is one full-width sheet and downstream it is this strip alone, so a
    // zone that straddled the cut would have to carry two widths at once.
    if (i === this._slitRollerIdx) return true;
    const roller = this._rollers[i];
    if (roller.isDriven) return true;
    return roller instanceof RVRibbonDancer && this._dancers.includes(roller);
  }

  /**
   * (Re)build the zone list. A zone whose two boundary rollers are UNCHANGED
   * keeps its strain across the rebuild; anything else starts at `eps_ref`.
   * Losing the strain on every dancer-induced rebuild would reset the model
   * sixty times a second.
   */
  private _buildZones(): void {
    const previous = this._zones;
    const n = this._rollers.length;
    this._boundaries.length = 0;
    for (let i = 0; i < n; i++) if (this._isBoundary(i, n)) this._boundaries.push(i);
    if (this._boundarySpeeds.length !== n * 2) this._boundarySpeeds = new Float32Array(n * 2);

    const epsRef = this.referenceStrain;
    const zones: RibbonTensionZone[] = [];
    for (let k = 0; k + 1 < this._boundaries.length; k++) {
      const fromRoller = this._boundaries[k];
      const toRoller = this._boundaries[k + 1];
      let kept: RibbonTensionZone | null = null;
      for (let p = 0; p < previous.length; p++) {
        if (previous[p].fromRoller === fromRoller && previous[p].toRoller === toRoller) {
          kept = previous[p];
          break;
        }
      }
      zones.push({
        fromRoller,
        toRoller,
        lengthMm: 0,
        eps: kept ? kept.eps : epsRef,
        tensionN: 0,
        mode: 'integrated',
        state: 'inBand',
        broken: kept ? kept.broken : false,
        estimated: false,
        sagDepthMm: 0,
        colorFromSample: 0,
        colorToSample: 0,
        fromSegment: 0,
        toSegment: -1,
        startArcMm: 0,
      });
    }
    this._zones = zones;
    this._tensionOn = zones.length > 0;
    this._dancerIdx = this._dancers.length > 0 ? this._rollers.indexOf(this._dancers[0]) : -1;
    // The group count changed by definition, so the next write must re-group.
    this._bandGroupCount = -1;
    this._pendingWrite = true;
    this._refreshZoneLengths();
  }

  /** Drop the partition and hand the band back exactly as it was found. */
  private _teardownTension(): void {
    this._clearTint();
    this._tensionOn = false;
    this._zones = [];
    this._boundaries.length = 0;
    this._groupToZone.length = 0;
    this._dancerIdx = -1;
    this._bandGroupCount = -1;
    // A clean geometry write: the sample buffer may still hold a sag, and the
    // group list a zone split, neither of which exists any more (Auflage A1).
    this._pendingWrite = true;
    this._lastTensionN = Number.NaN;
    this._lastNPerM = Number.NaN;
    this._lastStrainPercent = Number.NaN;
    this._lastSlack = null;
    this._lastOver = null;
    this._lastBroken = null;
  }

  /**
   * The MECHANICAL length of every zone, from the analytic segment lengths.
   *
   * Segments alternate `line, arc, line, …` (shifted by {@link _startArcOffset}),
   * so roller `k`'s arc is segment `2k - 1` and the line leaving it is `2k`. A
   * zone from boundary `i` to boundary `j` is therefore exactly the segments
   * `2i … 2j - 2`: the lines, plus the arcs of the idlers BETWEEN them, and
   * neither of the two boundary arcs — on those the web lies on the roller and
   * cannot stretch.
   *
   * Never from sample indices: that would couple the physics to the render
   * resolution and make a coarsened sample grid change the tension.
   */
  private _refreshZoneLengths(): void {
    const off = this._startArcOffset;
    const segs = this._segments;
    for (let k = 0; k < this._zones.length; k++) {
      const zone = this._zones[k];
      const from = 2 * zone.fromRoller + off;
      const to = 2 * zone.toRoller - 2 + off;
      zone.fromSegment = from;
      zone.toSegment = to;
      let start = 0;
      for (let i = 0; i < from && i < segs.length; i++) start += segs[i].lengthMm;
      let length = 0;
      for (let i = Math.max(0, from); i <= to && i < segs.length; i++) length += segs[i].lengthMm;
      zone.startArcMm = start;
      zone.lengthMm = length;
    }
  }

  /**
   * The COLOUR range of every zone — wider than the physical span, and gapless
   * by construction (SOL R2 #5).
   *
   * Zone `k` owns the samples from the ARRIVAL point of its upstream boundary up
   * to just before the arrival point of its downstream one, so the wrap arc of a
   * boundary roller (and an end roller's `WrapDeg` winding) belongs to the zone
   * the web LEAVES it into. The first zone therefore starts at sample 0 and the
   * last one ends at the last sample, and every index in between belongs to
   * exactly one zone.
   */
  private _refreshZoneSamples(count: number): void {
    const last = this._zones.length - 1;
    const end = Math.max(0, count - 1);
    for (let k = 0; k <= last; k++) {
      const zone = this._zones[k];
      zone.colorFromSample = k === 0 ? 0 : this._rollerArcStartSample(zone.fromRoller, count);
      zone.colorToSample = k === last
        ? end
        : Math.max(zone.colorFromSample, this._rollerArcStartSample(zone.toRoller, count) - 1);
    }
  }

  /** Fill the two speed slots of every boundary roller (plan-471 §Zugzonen). */
  private _readBoundarySpeeds(speeds: readonly number[], stopped: boolean): void {
    const buf = this._boundarySpeeds;
    for (let k = 0; k < this._boundaries.length; k++) {
      const i = this._boundaries[k];
      const at = i * 2;
      if (stopped) {
        // The group stop is absolute: with both slots at 0 the span equation is
        // a no-op and every strain is PRESERVED, which is the physically right
        // answer for a machine that has come to a standstill.
        buf[at] = 0;
        buf[at + 1] = 0;
        continue;
      }
      if (i === this._dancerIdx) {
        // The dancer is the one boundary whose two sides genuinely differ — that
        // difference IS what it stores — so it takes the two CLAMPED section
        // speeds the manager already computed.
        const down = this._sectionOfRoller[i] ?? 0;
        buf[at] = speeds[down - 1] ?? 0;
        // A seized carriage stores no material. Its roller still turns, but
        // both contacts have ONE transport speed; the downstream mismatch
        // must stretch the span instead of disappearing into fictional travel.
        const dancer = this._rollers[i] as RVRibbonDancer;
        buf[at + 1] = dancer.jammed ? buf[at] : (speeds[down] ?? 0);
        continue;
      }
      // A driven roller keeps its OWN surface speed even when its section is led
      // by another roller further downstream. That is not a detail: it is the
      // only thing that ever builds tension, because a zone between two nips
      // running at the same section speed could never stretch anything.
      if (this._rollers[i].isDriven) {
        const v = this._rollers[i].surfaceSpeedMmPerS;
        buf[at] = v;
        buf[at + 1] = v;
        continue;
      }
      // A FREE end roller is dragged by the nearest driven roller in the
      // direction the web reaches it from: the first one DOWNSTREAM for the
      // unwinder, the first one UPSTREAM for the rewinder.
      //
      // This corrects the rule the plan first wrote down (SOL R2 #1, "the speed
      // of its section"). A section runs at the speed of its LAST driven roller,
      // so a free unwinder would have been fed the speed of the last nip of the
      // line rather than of the first one it is actually pulled by — and the
      // span between the roll and that first nip would show a strain that
      // belongs to a completely different part of the machine. A free unwinder
      // is pulled by the first nip, and the web between them runs at THAT speed.
      const nearest = i === 0
        ? this._nearestDrivenSpeed(1, 1)
        : (i === this._rollers.length - 1 ? this._nearestDrivenSpeed(i - 1, -1) : null);
      // No driven roller on that side at all (a path driven only from the far
      // end, or not driven at all): fall back to the section speed, which is the
      // behaviour every such path had before.
      const v = nearest ?? (speeds[this._sectionOfRoller[i] ?? 0] ?? 0);
      buf[at] = v;
      buf[at + 1] = v;
    }
  }

  /**
   * mm/s — the surface speed of the first driven roller found from `from` in
   * direction `step`, or `null` when there is none.
   *
   * Deliberately the roller's OWN speed, exactly as for a driven boundary: the
   * group stop is handled before this is ever reached, and the dancer clamp acts
   * on SECTION speeds, which is a different quantity.
   */
  private _nearestDrivenSpeed(from: number, step: number): number | null {
    for (let i = from; i >= 0 && i < this._rollers.length; i += step) {
      if (this._rollers[i].isDriven) return this._rollers[i].surfaceSpeedMmPerS;
    }
    return null;
  }

  /** One tick of every zone, in running direction (plan-471 §Zonenmodus). */
  private _integrateZones(dt: number): void {
    const stiffness = this.TensileStiffnessNPerMmWidth;
    const thresholds = this._thresholds;
    const epsRef = this.referenceStrain;
    thresholds.minStrain = this.MinStrainPercent / 100;
    thresholds.maxStrain = this.MaxStrainPercent / 100;
    thresholds.breakStrain = breakStrainOf(this.BreakForceNPer50mm, stiffness);
    thresholds.refStrain = epsRef;
    thresholds.tolerance = this.ToleranceBandPercent / 100;

    const dancer = this._dancerIdx >= 0 ? (this._rollers[this._dancerIdx] as RVRibbonDancer) : null;
    const dancerTension = dancer ? dancer.tensionN : 0;

    let epsIn = epsRef;
    for (let k = 0; k < this._zones.length; k++) {
      const zone = this._zones[k];

      // A mirrored strip does not integrate the shared sheet: it adopts the
      // owner's zone whole — strain, force, state and the break latch — so both
      // strips see one web upstream of the blade. The force copied with it is
      // the FULL-width force, because the owner computed it over `FullWidthMm`.
      const shared = this._zoneIsPreSlit(zone) ? this._matchingZone(zone) : null;
      if (shared) {
        zone.eps = shared.eps;
        zone.tensionN = shared.tensionN;
        zone.mode = shared.mode;
        zone.state = shared.state;
        zone.broken = shared.broken;
        epsIn = zone.eps;
        continue;
      }

      // Per zone, because the blade changes it: the sheet before it, this strip
      // after it. Everything below — the dancer's strain, the force, the break
      // threshold — reads this width, never the strip's alone.
      const zoneWidth = this._zoneWidthMm(zone);
      const dancerStrain = dancerTension > 0
        ? strainFromTension(dancerTension, stiffness, zoneWidth)
        : 0;
      const vA = this._boundarySpeeds[zone.fromRoller * 2 + 1];
      const vB = this._boundarySpeeds[zone.toRoller * 2];
      const atDancer = this._dancerIdx >= 0
        && (zone.fromRoller === this._dancerIdx || zone.toRoller === this._dancerIdx);

      // The mode is decided from the CURRENT state on every tick, never frozen
      // at build time — a load that is switched on mid-run must take effect in
      // the tick it is switched on, and a break must outrank everything.
      if (zone.broken) {
        zone.mode = 'frozen';
      } else if (vB < 0) {
        zone.mode = 'frozen';
        this._warnBackwards();
      } else if (!(zone.lengthMm >= MIN_ZONE_LENGTH_MM)) {
        // Too short to hold a meaningful time constant: it simply passes the
        // upstream strain through, which is the limit of the ODE as L -> 0.
        zone.mode = 'algebraic';
        zone.eps = epsIn;
      } else if (atDancer && !dancer?.jammed && dancerTension > 0) {
        // Only a freely travelling loaded dancer SETS the tension of both its neighbours, immediately
        // and algebraically. Switching the load back off resumes integration
        // from this very value, so there is no jump in either direction.
        zone.mode = 'algebraic';
        zone.eps = dancerStrain;
      } else {
        zone.mode = 'integrated';
        zone.eps = strainStepImplicit(zone.eps, epsIn, vA, vB, zone.lengthMm, dt);
      }

      zone.tensionN = tensionFromStrain(stiffness, zoneWidth, zone.eps);
      zone.state = classify(zone.eps, thresholds);
      // The ONE latching rule of the whole feature: a broken zone stays broken,
      // and its strain stays where it tore, until the simulation is reset.
      if (zone.state === 'broken') zone.broken = true;
      epsIn = zone.eps;
    }
  }

  private _warnBackwards(): void {
    if (this._warnedBackwards) return;
    this._warnedBackwards = true;
    console.warn(
      `[RibbonPath] "${this.node.name}" is running BACKWARDS; web tension is not modelled in `
      + 'reverse (the zone direction would have to flip), so every strain is frozen until it '
      + 'runs forwards again.',
    );
  }

  /**
   * The GEOMETRY half of the invalidation contract (Auflage A1): a sag that
   * moved by more than half a millimetre, or a switch that changes whether there
   * is a sag at all, forces a write. Everything smaller is left to the next
   * write the dirty gate produces anyway.
   */
  private _noteSagInvalidation(): void {
    if (this.EnableSag !== this._writtenSagEnabled
      || this.DeformationScale !== this._writtenDeformationScale) {
      this._pendingWrite = true;
      return;
    }
    let deepest = 0;
    if (this.EnableSag) {
      const scale = this.DeformationScale > 0 ? this.DeformationScale : 0;
      for (let k = 0; k < this._zones.length; k++) {
        const zone = this._zones[k];
        if (!(zone.eps < 0) || !(zone.lengthMm > 0)) continue;
        const d = sagDepth(-zone.eps * zone.lengthMm, zone.lengthMm) * scale;
        if (d > deepest) deepest = d;
      }
    }
    if (Math.abs(deepest - this._writtenSagMm) > SAG_WRITE_EPSILON_MM) this._pendingWrite = true;
  }

  /**
   * Displace the finished 3D samples of every SLACK zone (plan-471 §Durchhang).
   *
   * Four contracts meet here:
   *
   * - **A2 — the frame.** The displacement happens after the 2D -> 3D lift, in
   *   the PATH NODE's local frame, and gravity is rotated INTO that frame. A web
   *   under a parent tilted by 90 degrees then still hangs downwards in the world.
   * - **A3 — the tangents.** Line tangents come from `f'(s)` analytically, never
   *   from a central difference, which would reach across the line/arc corner.
   *   Arc samples are not touched at all.
   * - **The raster invariant.** Only EXISTING samples move. The count, the step
   *   and every index stay exactly what `sampleArcLength` produced, so every
   *   arc-length -> index conversion in the file keeps agreeing with the buffer.
   * - **`DeformationScale`** multiplies the DEPTH and nothing else.
   */
  private _applySag(count: number): void {
    this._writtenSagEnabled = this.EnableSag;
    this._writtenDeformationScale = this.DeformationScale;
    this._writtenSagMm = 0;
    for (let k = 0; k < this._zones.length; k++) {
      this._zones[k].sagDepthMm = 0;
      this._zones[k].estimated = false;
    }
    if (!this.EnableSag || count < 3 || !(this._sampleStepMm > 0)) return;

    // Gravity in the path node's own local frame (A2). `transformDirection`
    // applies the rotation and normalises, which is all a direction needs.
    _gravityInv.copy(this.node.matrixWorld).invert();
    _gravityLocal.set(0, -1, 0).transformDirection(_gravityInv);

    const scale = this.DeformationScale > 0 ? this.DeformationScale : 0;
    if (!(scale > 0)) return;
    const segs = this._segments;
    const step = this._sampleStepMm;

    for (let z = 0; z < this._zones.length; z++) {
      const zone = this._zones[z];
      if (!(zone.eps < 0) || !(zone.lengthMm > 0)) continue;
      const excess = -zone.eps * zone.lengthMm;

      // The excess goes onto the FREE SPANS only, in proportion to their length.
      // An arc carries none: the web lies on the roller there and cannot hang.
      const from = Math.max(0, zone.fromSegment);
      const to = Math.min(zone.toSegment, segs.length - 1);
      let n = 0;
      for (let i = from; i <= to; i++) this._sagLengths[n++] = segs[i].kind === 'line' ? segs[i].lengthMm : 0;
      if (n === 0) continue;
      this._sagLengths.length = n;
      distributeExcess(this._sagLengths, excess, this._sagShare);

      let segStart = zone.startArcMm;
      for (let i = from; i <= to; i++) {
        const seg = segs[i];
        const share = this._sagShare[i - from];
        const chordLength = seg.lengthMm;
        segStart += chordLength;
        if (seg.kind !== 'line' || !(share > 0) || !(chordLength > 0)) continue;
        const start = segStart - chordLength;
        const depth = sagDepth(share, chordLength) * scale;
        if (!(depth > 0)) continue;

        // The chord in 3D, from the 2D endpoints through the path frame. The
        // axial component is the same at both ends and cancels, so the chord is
        // exactly the in-plane direction.
        const dx = seg.x1 - seg.x0;
        const dy = seg.y1 - seg.y0;
        _chord.x = (this._basisE1.x * dx + this._basisE2.x * dy) / chordLength;
        _chord.y = (this._basisE1.y * dx + this._basisE2.y * dy) / chordLength;
        _chord.z = (this._basisE1.z * dx + this._basisE2.z * dy) / chordLength;
        // A vertical run has no direction to sag in — gravity is parallel to it.
        if (!(perpGravity(_gravityLocal, _chord, _sagDir) > 0.1)) continue;

        const first = Math.max(1, Math.ceil(start / step));
        const last = Math.min(count - 2, Math.floor((start + chordLength) / step));
        for (let sample = first; sample <= last; sample++) {
          const u = (sample * step - start) / chordLength;
          if (!(u > 0) || !(u < 1)) continue;
          const offset = sagProfile(u, depth);
          const at = sample * RIBBON_BAND_SAMPLE_STRIDE;
          this._samples3[at] += _sagDir.x * offset;
          this._samples3[at + 1] += _sagDir.y * offset;
          this._samples3[at + 2] += _sagDir.z * offset;
          lineTangentAfterSag(_chord, _sagDir, u, depth, chordLength, _sagTangent);
          this._samples3[at + 3] = _sagTangent.x;
          this._samples3[at + 4] = _sagTangent.y;
          this._samples3[at + 5] = _sagTangent.z;
        }

        if (depth > zone.sagDepthMm) zone.sagDepthMm = depth;
        if (depth > this._writtenSagMm) this._writtenSagMm = depth;
        if (isSagEstimated(depth, chordLength)) zone.estimated = true;
      }
    }
  }

  /**
   * Hand the band its render groups.
   *
   * A render group is the intersection `(section, zone)`: the SCROLL lives at
   * the section (a dancer makes its two sides run at different speeds) and the
   * TINT lives at the zone, and neither partition is a refinement of the other.
   *
   * Auflage A5: `setGroups` — which clones materials and rebuilds the group list
   * — runs only when the group COUNT changed. A moving dancer changes the group
   * BOUNDARIES on every single tick and gets an in-place range update instead.
   * Without tension, the pre-plan-471 `setSections` call stays exactly where it
   * was, so the disabled path is unchanged down to the call sequence.
   */
  private _applyBandGroups(): void {
    const band = this._band;
    if (!band) return;
    if (!this._tensionOn) {
      band.setSections(this._sectionStarts);
      this._bandGroupCount = -1;
      return;
    }
    this._buildGroupPartition();
    if (this._groupStarts.length !== this._bandGroupCount) {
      this._bandGroupCount = this._groupStarts.length;
      band.setGroups(this._groupStarts, this._groupToSection);
    } else {
      band.updateGroupStarts(this._groupStarts);
    }
  }

  /**
   * Merge the section starts and the zone colour starts into one ascending list
   * of group starts, and record which section and which zone each group belongs
   * to.
   *
   * The merge keeps DUPLICATES: two coincident boundaries (a driven roller that
   * is also a dancer, a zero-length wrap arc) produce a zero-WIDTH group rather
   * than collapsing into one. That is deliberate and it is what Auflage A5
   * rests on: the group COUNT is then a function of the topology alone —
   * `sections + zones - 1` — and never of where the dancer happens to stand this
   * tick. Collapsing them would make the count flicker as the carriage crosses a
   * sample boundary, and every such flicker is a `setGroups`, i.e. an allocation
   * in the middle of a warm run.
   */
  private _buildGroupPartition(): void {
    const starts = this._groupStarts;
    const toSection = this._groupToSection;
    const toZone = this._groupToZone;
    starts.length = 0;
    toSection.length = 0;
    toZone.length = 0;
    const limit = Math.max(0, this._sampleCount - 1);
    let si = 0;
    let zi = 1;
    let at = 0;
    starts.push(0);
    toSection.push(0);
    toZone.push(0);
    while (si < this._sectionStarts.length || zi < this._zones.length) {
      const nextSection = si < this._sectionStarts.length
        ? this._sectionStarts[si] : Number.POSITIVE_INFINITY;
      const nextZone = zi < this._zones.length
        ? this._zones[zi].colorFromSample : Number.POSITIVE_INFINITY;
      const takeSection = nextSection <= nextZone;
      const next = takeSection ? nextSection : nextZone;
      if (takeSection) si++; else zi++;
      // Clamped and monotone: a boundary past the end of the band, or behind one
      // already emitted, becomes a zero-width group instead of a broken range.
      at = Math.min(limit, Math.max(at, next));
      starts.push(at);
      toSection.push(si);
      toZone.push(zi - 1);
    }
  }

  /** Restore every group material to the colour and emission it was born with. */
  private _clearTint(): void {
    const band = this._band;
    if (!band) return;
    for (let g = 0; g < band.groupCount; g++) band.applyTint(g, null, 0, 0);
  }

  dispose(): void {
    this.setEditorBandPreview(false);
    this.setEditorPreview(false);
    this._overlay?.dispose();
    this._overlay = null;
    this._gizmos = null;
    this._errors?.remove(this._alarmPath);
    this._errors = null;
    this._lastAlarmText = '';
    this._band?.dispose();
    this._band = null;
    // The winders are disposed HERE, by the path that gave them their roles.
    // `clearModel()` makes no generic per-component sweep (see the ChainManager
    // header), so without this a model switch would leave a winder's roll mesh
    // frozen at whatever diameter the simulation stopped at — and the marker on
    // it pointing at a component that no longer exists. `RVRibbonWinder.dispose()` is
    // idempotent, so a winder shared by two paths of a slitter is safe.
    for (const roller of this._rollers) {
      if (roller instanceof RVRibbonWinder) roller.dispose();
    }
    this._manager?.unregister(this);
    this._manager = null;
    this._context = null;
    this._rollers = [];
    this._segments = [];
    this._circles = [];
    this._sections = [];
    this._dancers = [];
    this._zones = [];
    this._boundaries.length = 0;
    this._tensionOn = false;
    this._dancerIdx = -1;
    removeComponentInstance(this.node, this);
  }
}

// ─── helpers ─────────────────────────────────────────────────────

/** `0..1` — the tint saturation the moment a zone leaves the tolerance band. */
const TINT_FLOOR = 0.25;

/** True when `value` is a first write or moved further than `epsilon`. */
function movedBy(value: number, previous: number, epsilon: number): boolean {
  return !Number.isFinite(previous) || Math.abs(value - previous) > epsilon;
}

function asNode(value: unknown): Object3D | null {
  const candidate = value as Object3D | null;
  if (candidate && (candidate as unknown as { isObject3D?: boolean }).isObject3D) return candidate;
  const owner = (value as { node?: unknown } | null)?.node as Object3D | undefined;
  return owner && (owner as unknown as { isObject3D?: boolean }).isObject3D ? owner : null;
}

/**
 * A `Rollers` entry resolves to a component instance when the referenced node
 * carries `RibbonRoller`/`RibbonWinder` extras. A ref written with `componentType
 * UnityEngine.Transform` resolves to the NODE instead — accept both and pull the
 * component off the node, so an exporter-side `componentType` change cannot
 * silently kill every web path.
 */
function asRoller(value: unknown): RibbonRollerLike | null {
  const direct = value as RibbonRollerLike | null;
  if (direct && typeof (direct as { advanceAngle?: unknown }).advanceAngle === 'function') return direct;
  const node = asNode(value);
  if (!node) return null;
  for (const inst of getComponentInstances(node)) {
    if (typeof (inst as { advanceAngle?: unknown }).advanceAngle === 'function') {
      return inst as unknown as RibbonRollerLike;
    }
  }
  return null;
}

/** Slash-joined ancestry — the stable ordering key for winder ownership. */
function nodePathOf(node: Object3D): string {
  const parts: string[] = [];
  for (let n: Object3D | null = node; n; n = n.parent) parts.unshift(n.name);
  return parts.join('/');
}

registerComponent({
  type: 'RibbonPath',
  schema: RVRibbonPath.schema,
  capabilities: {
    pick: 'select',
    bake: 'keep',    // rewrites its band's position buffer — never baked
    dynamicGeometry: true,  // plan-756 F9: picked by brute force in its current box
    authorable: true,
    ui: { filter: 'Web handling', category: 'transport', badge: '#26a69a' },
  },
  create: (node) => new RVRibbonPath(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
