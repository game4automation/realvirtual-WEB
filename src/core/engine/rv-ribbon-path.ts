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

import { Matrix4, Object3D, Vector3 } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import {
  getComponentInstances,
  loadSchemaFromSpec,
  registerComponent,
  removeComponentInstance,
  resolveComponentRefs,
  setComponentInstance,
} from './rv-component-registry';
import { MM_TO_METERS } from './rv-constants';
import { RVRibbonBandMesh, RIBBON_BAND_SAMPLE_STRIDE } from './rv-ribbon-band-mesh';
import { RVRibbonWinder } from './rv-ribbon-winder';
import { axisVector, type RibbonRollerLike, type RibbonSideSign } from './rv-ribbon-roller';
import {
  buildRibbonSegments,
  sampleArcLength,
  RIBBON_SAMPLE_STRIDE,
  type Circle2,
  type RibbonSegment2,
} from './ribbon/ribbon-geometry';
import { angularSpeedRad } from './ribbon/ribbon-winder-math';
import type { RibbonManager } from './rv-ribbon-manager';
import { RVRibbonDancer } from './rv-ribbon-dancer';

/** Floats per roller in the transform signature: centre, axis, radial scale, radius. */
const SIGNATURE_STRIDE = 8;

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
  /** Optional material donor node. Wire: `ComponentReference`. */
  Material: unknown = null;
  /**
   * Roller at which the full web is slit into this strip — the cut happens where
   * the web MEETS that roller. Wire: `ComponentReference`.
   */
  SlitAtRoller: unknown = null;
  /** mm - width of the full web BEFORE the slit; 0 = this path is not a slit strip. */
  FullWidthMm = 0;

  // ── Runtime state ──
  private _manager: RibbonManager | null = null;
  private _rollers: RibbonRollerLike[] = [];
  private _circles: Circle2[] = [];
  private _segments: RibbonSegment2[] = [];
  private _band: RVRibbonBandMesh | null = null;
  private _samples2: Float32Array = new Float32Array(0);
  private _samples3: Float32Array = new Float32Array(0);
  private _signature: Float32Array = new Float32Array(0);
  private _sampleCount = 0;
  private _lengthMm = 0;
  private _inert = false;
  private _built = false;
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
  /** mm — the absolute sample grid step the last {@link _writeGeometry} used. */
  private _sampleStepMm = 0;
  /** The resolved wrap side per roller as of the last solve. */
  private _resolvedSides: RibbonSideSign[] = [];
  /** Bumped whenever {@link _resolvedSides} changed; read by `RibbonManager`. */
  private _sidesVersion = 0;

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

  // ── Build ──────────────────────────────────────────────────────

  init(context: ComponentContext): void {
    this._manager = context.ribbonManager ?? null;
    this._sortKey = nodePathOf(this.node);
    // Like `RVChain`: wait for `onSceneReady()` where the loader has one, because
    // the Kinematic re-parenting pass runs between init and onSceneReady and a
    // roller may still move.
    if (!context.expectSceneReady) this._build(context);
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
      this._band = new RVRibbonBandMesh(capacity, this.RibbonWidthMm, asNode(this.Material));
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
    const half = this.RibbonThicknessMm / 2;
    this._circles.length = 0;
    for (const roller of this._rollers) {
      this._localCentreMm(roller, _c).sub(this._origin);
      this._circles.push({
        cx: _c.dot(this._basisE1),
        cy: _c.dot(this._basisE2),
        // The half thickness rides on the CONTACT radius: correct for a Left and
        // a Right wrap alike, which a flat normal offset would not be.
        r: roller.radiusMm + half,
        side: roller.sideSign,
      });
    }
    const built = buildRibbonSegments(this._circles);
    if ('error' in built) {
      this._goInert(built.error);
      return false;
    }
    this._segments = built.segments;
    this._lengthMm = built.lengthMm;
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

    if (this._band) {
      this._band.write(
        this._samples3, count, this.RibbonWidthMm, 0,
        this._slitSampleIdx, this.FullWidthMm,
        this._drawsPreSlit || this._slitSampleIdx < 0 ? 0 : this._slitSampleIdx,
      );
      // Groups AFTER write(): they are expressed in the sample count write() set,
      // and `setDrawStart` (the slit) is applied inside write() and intersects
      // with the groups rather than replacing them.
      this._band.setSections(this._sectionStarts);
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
   * roller `k`'s arc is segment `2k - 1`.
   *
   * This is the SECTION boundary: a dancer hands the web to the next speed where
   * it lets go of it.
   */
  private _rollerArcEndSample(idx: number, count: number): number {
    let s = 0;
    const last = 2 * idx - 1;
    for (let i = 0; i <= last && i < this._segments.length; i++) s += this._segments[i].lengthMm;
    return this._sampleAtArcLength(s, count);
  }

  /**
   * The sample index where roller `idx`'s arc BEGINS — the ARRIVAL tangent
   * point, where the web first touches that roller (segments `0 .. 2*idx - 2`).
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
    const last = 2 * idx - 2;
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

    if (this._isDirty()) {
      if (!this._solve()) return false;
      this._writeGeometry();
      this._captureSignature();
      changed = true;
    }

    if (dt > 0) {
      for (let i = 0; i < this._rollers.length; i++) {
        const roller = this._rollers[i];
        const v = speeds[this._sectionOfRoller[i]] ?? 0;
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
    if (this._solve()) {
      this._writeGeometry();
      this._captureSignature();
    }
  }

  // ── Teardown ───────────────────────────────────────────────────

  private _goInert(reason: string): void {
    this._inert = true;
    this._segments = [];
    console.warn(`[RibbonPath] "${this.node.name}" is inactive: ${reason}.`);
  }

  getLiveState(): Record<string, unknown> {
    return {
      LengthMm: this._lengthMm,
      SampleCount: this._sampleCount,
      Active: this.isActive,
    };
  }

  dispose(): void {
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
    this._rollers = [];
    this._segments = [];
    this._circles = [];
    this._sections = [];
    this._dancers = [];
    removeComponentInstance(this.node, this);
  }
}

// ─── helpers ─────────────────────────────────────────────────────

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
    hoverable: true,
    selectable: true,
    authorable: true,
    filterLabel: 'Web handling',
    badgeColor: '#26a69a',
  },
  create: (node) => new RVRibbonPath(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
