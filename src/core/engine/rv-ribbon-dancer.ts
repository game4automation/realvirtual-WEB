// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ribbon-dancer.ts — `RibbonDancer`, the accumulator roller between two
 * driven sections of a web path (plan-460 F2-F4).
 *
 * A dancer IS a roller (it extends {@link RVRibbonRoller}) that TRANSLATES along
 * a travel axis instead of standing still. It splits its path into an upstream
 * and a downstream section at its own departure tangent point, and it stores the
 * difference between the two section speeds as web length — which is exactly
 * what a real dancer does to hold tension while two drives run at slightly
 * different surface speeds.
 *
 * ## Three decisions worth keeping
 *
 * 1. **No drive references at all.** `v_up` and `v_down` are the speeds of the
 *    neighbouring sections, which come from the DRIVEN ROLLERS of those sections
 *    (plan-460 F0). A dancer that named its own drives would be a second,
 *    competing speed source — the thing plan-460 exists to remove.
 *
 * 2. **The limits are DIRECTIONAL, and they never stop a drive.** At the upper
 *    stop only further FILLING is prevented (`v_up_eff = min(v_up, v_down)`); at
 *    the lower stop only further EMPTYING (`v_down_eff = min(v_down, v_up)`).
 *    A symmetric "stop everything" clamp deadlocks: with both sections at 0 no
 *    delta can ever free the carriage again (SOL round-1 finding 1). The PLC is
 *    expected to regulate on `PositionMm` / `AtMin` / `AtMax`.
 *
 * 3. **Position is derived from `L_acc`, and `L_acc` is rewound on a clamp.**
 *    See `ribbon/ribbon-dancer-math.ts` — the anti-windup rule is the reason the
 *    mathematics lives in a `three`-free file with its own unit tests.
 */

import { DataTexture, Object3D, Sprite, Vector2, Vector3 } from 'three';
import type { ComponentContext, ComponentSchema } from './rv-component-registry';
import {
  loadSchemaFromSpec,
  registerComponent,
  setComponentInstance,
} from './rv-component-registry';
import { MM_TO_METERS } from './rv-constants';
import { RVRibbonRoller, axisVector, type RibbonAxis } from './rv-ribbon-roller';
import {
  accumulate,
  clampTravel,
  normaliseStrands,
  positionFromAccumulated,
} from './ribbon/ribbon-dancer-math';
import { tensionFromDancerLoad } from './ribbon/ribbon-tension-math';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';

/** mm — a position change below this does not warrant a signal write (F3). */
const SIGNAL_EPSILON_MM = 0.1;

/** World metres a readout floats above the carriage, so it clears the web. */
const LABEL_LIFT = 0.12;

/** CSS pixels — travel ticks stay small at any zoom or display density. */
const TRAVEL_TICK_WIDTH = 8;
const TRAVEL_TICK_HEIGHT = 2;
const _tickViewport = new Vector2();
const _tickPosition = new Vector3();
const _tickViewPosition = new Vector3();
const _tickMin = new Vector3();
const _tickMax = new Vector3();

/** The travel bar and a carriage inside its range. */
const TRACK_COLOR = 0x4fc3f7;

/** The end stops — grey while free. */
const STOP_COLOR = 0x8a8f98;

/** A carriage sitting ON a stop, and the stop it sits on: out of travel. */
const AT_LIMIT_COLOR = 0xff9100;

/** A SEIZED carriage — the same magenta the band tint alarms in. */
const JAMMED_COLOR = 0xff00d0;

/** N — a tension change below this does not warrant a signal write (plan-471). */
const SIGNAL_EPSILON_N = 0.05;

const _travel = new Vector3();
const _trackA = new Vector3();
const _trackB = new Vector3();

/** True when `value` is a first write or moved more than the signal epsilon. */
function changedBy(value: number, previous: number): boolean {
  return !Number.isFinite(previous) || Math.abs(value - previous) > SIGNAL_EPSILON_MM;
}

/** Browser runtime counterpart of Unity's `RibbonDancer` component (plan-460). */
export class RVRibbonDancer extends RVRibbonRoller {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('RibbonDancer');

  // -- Schema fields --
  /** Travel axis of the carriage, in the dancer node's PARENT frame. */
  TravelAxis: RibbonAxis = 'Y';
  /** mm — lower stop relative to `HomeMm`; must be <= 0. */
  TravelMinMm = -200;
  /** mm — upper stop relative to `HomeMm`; must be >= 0. */
  TravelMaxMm = 200;
  /** mm — rest position along the travel axis; 0 = the authored position. */
  HomeMm = 0;
  /** Web strands through the carriage: 1 mm of travel stores `Strands` mm of web. */
  Strands = 2;
  /**
   * N — the force the loaded carriage presses into the web (plan-471 E9).
   *
   * A loaded dancer is a tension SETTER and a position SENSOR in one part, and
   * the two halves are deliberately kept apart:
   *
   * - the FORCE sets the tension of both neighbouring zones immediately and
   *   algebraically, through `T = LoadN / Strands` ({@link tensionN});
   * - the POSITION keeps following the speed difference alone, exactly as it did
   *   before plan-471.
   *
   * So a load step at equal section speeds changes the tension and moves the
   * carriage not at all — which is what the real machine does, and what
   * `tests/ribbon-tension-pipeline.test.ts` pins. `0` (the default) is the
   * purely kinematic dancer of plan-460, and it never enters a tension code path.
   */
  LoadN = 0;
  /**
   * Draw the TRACK this carriage runs on: the two end stops, the bar between
   * them and a marker on the carriage itself.
   *
   * Deliberately independent of `RibbonPath.ShowTensionLabels`, which switches
   * the NUMBERS. The travel a dancer has left is a property of the machine and
   * stays readable with every readout turned off — which is what an operator
   * watching a line actually wants, and why the two are separate switches.
   * Independent of {@link LoadN} too: a purely kinematic dancer has a travel
   * range like any other.
   */
  ShowTravel = false;
  /**
   * Draw this carriage own readout: the force it presses into the web, the
   * tension that makes, and where it sits in its travel.
   *
   * Separate from {@link ShowTravel} for the same reason the track is separate
   * from `RibbonPath.ShowTensionLabels`: the NUMBERS are a readout an operator
   * clears off the picture, the track is how the machine is read. Nothing is
   * drawn while {@link LoadN} is 0 — an unloaded dancer imposes no tension, and a
   * force readout of zero newtons says nothing.
   */
  ShowValues = false;
  /** Signal slots — resolved to signal addresses by `resolveComponentRefs`. */
  PositionMm: unknown = null;
  AtMin: unknown = null;
  AtMax: unknown = null;
  /** Signal slot carrying {@link tensionN}. */
  TensionN: unknown = null;

  // -- Runtime state --
  /** mm — accumulated web length (positive = the loop is longer than at home). */
  lAccMm = 0;
  /** mm — the carriage position along the travel axis. */
  positionMm = 0;
  /**
   * Fault injection: the carriage is SEIZED and cannot travel.
   *
   * A store that cannot change turns every speed difference between its two
   * sections into strain instead of into travel — the web goes tight or slack
   * within a second or two. It is the one disturbance that stays visible in a
   * fully regulated line, where the controllers absorb everything else, which is
   * why it exists: a demo that can only ever show a healthy machine shows
   * nothing about the machine.
   *
   * Runtime-only and deliberately NOT in the schema: a fault is something you do
   * to a model, never something a model is authored with. Cleared by
   * {@link reset}, so the toolbar's simulation reset repairs it.
   */
  jammed = false;

  private _atMin = false;
  private _atMax = false;
  private _inert = false;
  /** Gizmo host, for the travel track this component draws itself. */
  private _minAnchor: Object3D | null = null;
  private _maxAnchor: Object3D | null = null;
  private _carriageAnchor: Object3D | null = null;
  private _minMarker: GizmoHandle | null = null;
  private _maxMarker: GizmoHandle | null = null;
  private _carriage: GizmoHandle | null = null;
  private _bar: GizmoHandle | null = null;
  private _label: GizmoHandle | null = null;
  private _lastLabelText = '';
  private _editorPreview = false;
  private _authoring = false;
  private _tickTexture: DataTexture | null = null;
  private _homeMarker: GizmoHandle | null = null;
  private _strandsLabel: GizmoHandle | null = null;
  /** The colours last written, so an unchanged track costs nothing per tick. */
  private _lastMinColor = -1;
  private _lastMaxColor = -1;
  private _lastCarriageColor = -1;
  private readonly _authoredPosition = new Vector3();
  private _dancerReady = false;
  private _lastPositionMm = Number.NaN;
  private _lastTensionN = Number.NaN;
  private _lastAtMin: boolean | null = null;
  private _lastAtMax: boolean | null = null;

  /**
   * N — the web tension this dancer imposes on each of its neighbouring zones:
   * `LoadN / Strands`, from the force balance at the carriage. `0` means the
   * dancer imposes nothing and the zones around it are integrated as usual.
   */
  get tensionN(): number {
    if (this._inert) return 0;
    return tensionFromDancerLoad(this.LoadN, this.Strands);
  }

  /** True when the configuration is unusable (`warn`ed once, then ignored). */
  get isInert(): boolean {
    return this._inert;
  }

  /** True while the carriage sits at its lower stop (the store is empty). */
  get atMin(): boolean {
    return this._atMin;
  }

  /** True while the carriage sits at its upper stop (the store is full). */
  get atMax(): boolean {
    return this._atMax;
  }

  /** The travel axis, defaulted like {@link RVRibbonRoller.axis}. */
  get travelAxis(): RibbonAxis {
    return this.TravelAxis === 'X' || this.TravelAxis === 'Z' ? this.TravelAxis : 'Y';
  }

  override init(context: ComponentContext): void {
    this._authoring = context.authoring === true;
    super.init(context);
    this._gizmos = context.gizmoManager ?? null;
    this._initDancer();
  }

  // -- The travel track -----------------------------------------
  //
  // Drawn by the DANCER, not by the tension overlay it used to live in. The
  // track is what this component IS — two stops, a run between them and a
  // carriage on it — and it has nothing to do with tension: an unloaded, purely
  // kinematic dancer has a travel range like any other, and a machine whose
  // numeric readouts are switched off still has to show how much store is left.
  //
  // Ownership is the practical half of that: the gizmos are created, coloured and
  // disposed here, so `ShowTravel` works in any scene, with or without a
  // `RibbonPath` that has tension configured.

  /**
   * Bring the track in step with {@link ShowTravel} and the carriage position.
   * Called once per tick by the `RibbonManager`, for every dancer of a group —
   * inert ones included, because a misconfigured dancer showing its (collapsed)
   * range is how the misconfiguration becomes visible.
   */
  updateTravelVisual(): void {
    if (this._inert || !this._gizmos || this._authoring) {
      if (this._carriageAnchor) this._disposeTrack();
      this._disposeLabel();
      return;
    }
    if (this.ShowTravel || this._editorPreview) {
      if (!this._carriageAnchor) this._createTrack();
      this._placeTrack();
      // The stop the carriage has REACHED changes colour, and so does the
      // carriage. That is the point of drawing the limits: "out of travel" has to
      // be readable without comparing the position against both end ticks.
      this._colorTrack();
    } else if (this._carriageAnchor) {
      this._disposeTrack();
    }
    this._updateLabel();
  }

  override setEditorPreview(
    active: boolean,
    resolvedSide = this.sideSign,
    geometry?: { startRad: number; spanRad: number },
  ): void {
    super.setEditorPreview(active, resolvedSide, geometry);
    this._editorPreview = active;
    if (!active || !this._gizmos) {
      this._homeMarker?.dispose();
      this._strandsLabel?.dispose();
      this._homeMarker = null;
      this._strandsLabel = null;
      this.updateTravelVisual();
      return;
    }
    this.updateTravelVisual();
    if (!this._homeMarker) this._homeMarker = this._gizmos.create(this.node, {
      shape: 'sphere-edges', color: TRACK_COLOR, opacity: 1, attachToNode: true,
      excludeFromRaycast: true, depthTest: false, category: 'ribbon-preview',
      kind: 'dancer-track',
    });
    this._homeMarker.root.name = '__rvDancerHome';
    this._homeMarker.root.userData.ribbonPreviewKind = 'dancer-track';
    this._homeMarker.root.userData.ribbonPreviewScreenScale = true;
    axisVector(this.travelAxis, _travel);
    this._homeMarker.root.position.copy(_travel).multiplyScalar((this.HomeMm - this.positionMm) / MM_TO_METERS);
    if (!this._strandsLabel) this._strandsLabel = this._gizmos.create(this.node, {
      shape: 'text', color: TRACK_COLOR, opacity: 1, text: String(this.Strands), attachToNode: true,
      excludeFromRaycast: true, depthTest: false, category: 'ribbon-preview', kind: 'dancer-strands',
    });
    this._strandsLabel.root.userData.ribbonPreviewKind = 'dancer-strands';
    this._strandsLabel.root.userData.ribbonPreviewScreenScale = true;
  }

  /** `Dancer_A  80 N load | 40 N web | -12 mm`, on the carriage, following it. */
  private _updateLabel(): void {
    const tension = this.tensionN;
    if (!this.ShowValues || (!(tension > 0) && !this.jammed)) {
      this._disposeLabel();
      return;
    }
    if (!this._label) {
      this._label = this._gizmos!.create(this.node, {
        shape: 'text', color: TRACK_COLOR, opacity: 1, text: '',
        attachToNode: true, excludeFromRaycast: true, depthTest: false, category: 'status',
      });
      this._lastLabelText = '';
    }
    // NAMED: a slitter has a carriage per strip, and two readouts a hand width
    // apart saying the same numbers cannot be told apart without it.
    const text = `${this.node.name}  ${this.LoadN.toFixed(0)} N load`
      + (this.jammed ? '' : `  |  ${tension.toFixed(0)} N web`)
      + `  |  ${this.positionMm.toFixed(0)} mm`
      + `${this._atMin ? '  MIN' : ''}${this._atMax ? '  MAX' : ''}`
      + `${this.jammed ? '  JAMMED' : ''}`;
    if (text !== this._lastLabelText) {
      this._lastLabelText = text;
      this._label.update({ text });
    }
    // A `text` gizmo is positioned ONCE, at creation, from the node bounds it was
    // attached to — it does not follow a node that moves. The carriage moves, so
    // the readout is placed by hand every tick or it stays where the dancer
    // started.
    this.node.getWorldPosition(_trackA);
    _trackA.y += LABEL_LIFT;
    this._label.root.position.copy(_trackA);
  }

  private _disposeLabel(): void {
    this._label?.dispose();
    this._label = null;
    this._lastLabelText = '';
  }

  private _createTrack(): void {
    const gizmos = this._gizmos;
    if (!gizmos) return;
    const parent = this.node.parent ?? this.node;
    this._minAnchor = new Object3D();
    this._maxAnchor = new Object3D();
    this._carriageAnchor = new Object3D();
    for (const anchor of [this._minAnchor, this._maxAnchor, this._carriageAnchor]) {
      anchor.name = '__rvDancerTravel';
      parent.add(anchor);
    }
    this._tickTexture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this._tickTexture.needsUpdate = true;
    this._minMarker = this._createTravelTick(this._minAnchor, STOP_COLOR, 'dancer-stop');
    this._maxMarker = this._createTravelTick(this._maxAnchor, STOP_COLOR, 'dancer-stop');
    this._carriage = this._createTravelTick(this._carriageAnchor, TRACK_COLOR, 'dancer-position');
    this._bar = gizmos.create(this._minAnchor, {
      shape: 'link-line', color: TRACK_COLOR, opacity: 0.85,
      linkTo: this._maxAnchor, excludeFromRaycast: true, depthTest: false, category: 'status',
    });
    this._lastMinColor = -1;
    this._lastMaxColor = -1;
    this._lastCarriageColor = -1;
  }

  private _createTravelTick(anchor: Object3D, color: number, kind: string): GizmoHandle {
    const handle = this._gizmos!.create(anchor, {
      shape: 'sprite', spriteTexture: this._tickTexture!, color, kind,
      opacity: 0.9, attachToNode: true, excludeFromRaycast: true,
      depthTest: false, category: 'status', worldSize: 0.01,
    });
    const sprite = handle.root as Sprite;
    sprite.frustumCulled = false;
    sprite.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getSize(_tickViewport);
      anchor.getWorldPosition(_tickPosition);
      _tickViewPosition.copy(_tickPosition).applyMatrix4(camera.matrixWorldInverse);
      const perspective = camera.projectionMatrix.elements[15] === 0;
      const depth = perspective ? Math.max(0, -_tickViewPosition.z) : 1;
      const unitsPerPixel = 2 * depth / (Math.abs(camera.projectionMatrix.elements[5]) * Math.max(1, _tickViewport.y));
      // Override the rendered world scale, so CAD parent scaling cannot enlarge ticks.
      sprite.matrixWorld.makeScale(TRAVEL_TICK_WIDTH * unitsPerPixel, TRAVEL_TICK_HEIGHT * unitsPerPixel, 1);
      sprite.matrixWorld.setPosition(_tickPosition);
      this._minAnchor!.getWorldPosition(_tickMin).project(camera);
      this._maxAnchor!.getWorldPosition(_tickMax).project(camera);
      const dx = (_tickMax.x - _tickMin.x) * _tickViewport.x;
      const dy = (_tickMax.y - _tickMin.y) * _tickViewport.y;
      sprite.material.rotation = dx * dx + dy * dy > 1e-8 ? Math.atan2(dy, dx) + Math.PI / 2 : 0;
    };
    return handle;
  }

  /**
   * Put the three anchors on the travel axis, in the dancer's PARENT frame —
   * the frame {@link TravelMinMm} and {@link TravelMaxMm} are authored in.
   *
   * The bar is anchored off the node's CURRENT position minus its travel, so it
   * stays put while the carriage runs along it.
   */
  private _placeTrack(): void {
    if (!this._minAnchor || !this._maxAnchor || !this._carriageAnchor) return;
    axisVector(this.travelAxis, _travel);
    _trackA.copy(this.node.position).addScaledVector(
      _travel, (this.HomeMm + this.TravelMinMm - this.positionMm) / MM_TO_METERS,
    );
    _trackB.copy(this.node.position).addScaledVector(
      _travel, (this.HomeMm + this.TravelMaxMm - this.positionMm) / MM_TO_METERS,
    );
    this._minAnchor.position.copy(_trackA);
    this._maxAnchor.position.copy(_trackB);
    this._carriageAnchor.position.copy(this.node.position);
    for (const anchor of [this._minAnchor, this._maxAnchor, this._carriageAnchor]) {
      anchor.updateMatrix();
      anchor.updateMatrixWorld(true);
    }
    if (this._bar) this._gizmos?.updateLinkLine(this._bar.id);
  }

  private _colorTrack(): void {
    const minColor = this._atMin ? AT_LIMIT_COLOR : STOP_COLOR;
    const maxColor = this._atMax ? AT_LIMIT_COLOR : STOP_COLOR;
    // A seized carriage is the loudest state the track can be in: it is not out
    // of travel, it has stopped USING its travel, and the web is taking the
    // difference. Magenta, the same alarm colour the band tint uses.
    const carriageColor = this.jammed
      ? JAMMED_COLOR
      : this._atMin || this._atMax ? AT_LIMIT_COLOR : TRACK_COLOR;
    if (minColor !== this._lastMinColor) {
      this._lastMinColor = minColor;
      this._minMarker?.update({ color: minColor });
    }
    if (maxColor !== this._lastMaxColor) {
      this._lastMaxColor = maxColor;
      this._maxMarker?.update({ color: maxColor });
    }
    if (carriageColor !== this._lastCarriageColor) {
      this._lastCarriageColor = carriageColor;
      this._carriage?.update({ color: carriageColor });
    }
  }

  private _disposeTrack(): void {
    for (const gizmo of [this._bar, this._minMarker, this._maxMarker, this._carriage]) gizmo?.dispose();
    this._tickTexture?.dispose();
    this._tickTexture = null;
    this._bar = null;
    this._minMarker = null;
    this._maxMarker = null;
    this._carriage = null;
    for (const anchor of [this._minAnchor, this._maxAnchor, this._carriageAnchor]) anchor?.removeFromParent();
    this._minAnchor = null;
    this._maxAnchor = null;
    this._carriageAnchor = null;
  }

  private _initDancer(): void {
    if (this._dancerReady) return;
    this._dancerReady = true;
    this._authoredPosition.copy(this.node.position);
    if (this.TravelMinMm > 0 || this.TravelMaxMm < 0 || this.TravelMinMm >= this.TravelMaxMm) {
      this._inert = true;
      console.warn(
        `[RibbonDancer] "${this.node.name}" is inactive: TravelMinMm (${this.TravelMinMm}) must be `
        + `<= 0 and below TravelMaxMm (${this.TravelMaxMm}), which must be >= 0.`,
      );
      return;
    }
    if (!(this.Strands >= 1)) {
      console.warn(
        `[RibbonDancer] "${this.node.name}": Strands (${this.Strands}) must be at least 1 — using 1.`,
      );
    }
    this.reset();
  }

  // -- Tick -----------------------------------------------------

  /**
   * Apply the directional limit rule to a section speed pair, IN PLACE.
   *
   * `speeds[upIndex]` and `speeds[downIndex]` are the sections above and below
   * this dancer. See decision 2 in the file header for why this is `min` on one
   * side only rather than a symmetric stop.
   */
  clampSpeeds(speeds: number[], upIndex: number, downIndex: number): void {
    if (this._inert || this.jammed) return;
    if (upIndex < 0 || downIndex < 0 || upIndex >= speeds.length || downIndex >= speeds.length) return;
    const vUp = speeds[upIndex];
    const vDown = speeds[downIndex];
    if (this._atMax) speeds[upIndex] = Math.min(vUp, vDown);
    if (this._atMin) speeds[downIndex] = Math.min(vDown, vUp);
  }

  /**
   * Integrate the section difference for `dt` seconds and move the carriage.
   *
   * A {@link jammed} carriage stores NOTHING: the speed difference between the
   * two sections stops going into travel and goes into STRAIN instead, which is
   * exactly what a seized dancer does to a real web. Note the clamp above is
   * skipped too — a jam is not an end stop, and the directional clamp would hide
   * the very difference the strain integrator has to see.
   */
  advance(vUpMmPerS: number, vDownMmPerS: number, dt: number): void {
    if (this._inert || this.jammed || !(dt > 0)) return;
    const next = accumulate(this.lAccMm, vUpMmPerS, vDownMmPerS, dt);
    const pos = positionFromAccumulated(this.HomeMm, next, this.Strands);
    const clamped = clampTravel(pos, this.HomeMm, this.TravelMinMm, this.TravelMaxMm, this.Strands);
    this.lAccMm = clamped.lAccMm;
    this.positionMm = clamped.posMm;
    this._atMin = clamped.atMin;
    this._atMax = clamped.atMax;
    this.applyPosition();
  }

  /**
   * Write `node.position` from {@link positionMm}, relative to the authored pose.
   *
   * `updateMatrix()` for the same reason as `RVRibbonRoller.applyAngle()`: a node
   * with `matrixAutoUpdate = false` never rebuilds its local matrix from the
   * position, so the carriage would travel in the numbers only.
   */
  applyPosition(): void {
    axisVector(this.travelAxis, _travel).multiplyScalar(this.positionMm / MM_TO_METERS);
    this.node.position.copy(this._authoredPosition).add(_travel);
    this.node.updateMatrix();
  }

  /**
   * Write the three feedback slots, but only on a real change: `PositionMm`
   * moves less than {@link SIGNAL_EPSILON_MM}, or a bool that did not flip, is
   * not written at all (F3).
   */
  writeSignals(write: (address: string, value: number | boolean) => void): void {
    if (this._inert) return;
    // `NaN` is the "never written" marker, and `Math.abs(x - NaN) > eps` is
    // FALSE — so the first write has to be its own case, or the PLC would never
    // see the initial position at all.
    const p = this.positionMm;
    if (typeof this.PositionMm === 'string' && changedBy(p, this._lastPositionMm)) {
      this._lastPositionMm = p;
      write(this.PositionMm, p);
    }
    if (typeof this.AtMin === 'string' && this._atMin !== this._lastAtMin) {
      this._lastAtMin = this._atMin;
      write(this.AtMin, this._atMin);
    }
    if (typeof this.AtMax === 'string' && this._atMax !== this._lastAtMax) {
      this._lastAtMax = this._atMax;
      write(this.AtMax, this._atMax);
    }
    const t = this.tensionN;
    if (typeof this.TensionN === 'string'
      && (!Number.isFinite(this._lastTensionN) || Math.abs(t - this._lastTensionN) > SIGNAL_EPSILON_N)) {
      this._lastTensionN = t;
      write(this.TensionN, t);
    }
  }

  /** Restore the authored carriage position, the balance and the edge memory. */
  override reset(): void {
    super.reset();
    // Before the inert guard: a jam is a fault, and a reset repairs it whether or
    // not the dancer is usable.
    this.jammed = false;
    if (this._inert) return;
    this.lAccMm = 0;
    this.positionMm = this.HomeMm;
    const clamped = clampTravel(
      this.positionMm, this.HomeMm, this.TravelMinMm, this.TravelMaxMm, normaliseStrands(this.Strands),
    );
    this._atMin = clamped.atMin;
    this._atMax = clamped.atMax;
    this.applyPosition();
    this._lastPositionMm = Number.NaN;
    this._lastTensionN = Number.NaN;
    this._lastAtMin = null;
    this._lastAtMax = null;
  }

  override getLiveState(): Record<string, unknown> {
    return {
      RadiusMm: this.radiusMm,
      PositionMm: this.positionMm,
      AccumulatedMm: this.lAccMm,
      AtMin: this._atMin,
      AtMax: this._atMax,
      Jammed: this.jammed,
      TensionN: this.tensionN,
      AngleDeg: (this.angle * 180) / Math.PI,
    };
  }

  override dispose(): void {
    this.setEditorPreview(false);
    this._disposeTrack();
    this._disposeLabel();
    this._gizmos = null;
    this.node.position.copy(this._authoredPosition);
    this.node.updateMatrix();
    super.dispose();
  }
}

/** True when `roller` is a dancer (kept here so the path needs no cast). */
export function isRibbonDancer(value: unknown): value is RVRibbonDancer {
  return value instanceof RVRibbonDancer;
}

/** The dancer node type the schema exposes (documentation aid). */
export type RibbonDancerNode = Object3D;

registerComponent({
  type: 'RibbonDancer',
  schema: RVRibbonDancer.schema,
  capabilities: {
    pick: 'select',
    bake: 'keep',    // translates every tick — never baked
    authorable: true,
    ui: { filter: 'Web handling', category: 'transport', badge: '#26a69a' },
  },
  create: (node) => new RVRibbonDancer(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
