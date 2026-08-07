// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Turntable — a multi-port router: a rotating platform that re-routes parts.
 *
 * A part arrives on one side; the disc ROTATES to line up with a free output, then
 * DISCHARGES. That sequence is a state machine (8 states):
 *   idle → aligning_in → receiving → (holding) → rotating_out → discharging
 *        → discharge_clearing → returning_in → idle
 *
 * One definition, two simulations:
 *   • Continuous — `continuous.fixedUpdate` drives the FSM at 60 Hz, polling the
 *     real drive (`isAtTarget`) to detect a finished rotation.
 *   • DES — `des.*` is the same router as events: a rotation just consumes TIME
 *     (|Δangle| / rotationSpeed), no physical drive.
 *
 * Publishes the type-neutral `Flow.*` interop signals (like its belt neighbours),
 * so `signalNamespace: 'Flow'`. Full authoring guide: doc-behavior-modelling.md
 */

import { Vector3, Quaternion } from 'three';
import type { Object3D } from 'three';
import { defineLibraryComponent, type RV } from './_shared/behavior-kit';
import { classifyConnections, listOwnSnaps, type PortConnection } from './_shared/snap-graph-helpers';
import { alignToInputAngle, dispatchToOutputAngle, calibrateBeltNeutralAngle } from './_shared/turntable-angle-math';
import { scheduleDriveMove, schedulePositionMove } from './_shared/drive-des';
import { muBugOffset, muForward, setMuForward } from './_shared/mu-reference';
import { FLOW_OCCUPIED, flowOccupiedRootSignal } from './_shared/transport-links';

// ── Config & signals ────────────────────────────────────────────────────────

// Type-neutral material-flow interop signals — published as `Flow.<key>`.
const SIGNALS = {
  Run:       'PLCInputBool',
  Occupied:  'PLCOutputBool',
  Running:   'PLCOutputBool',
  PartCount: 'PLCOutputInt',
} as const;

const CONFIG = {
  neighborRefreshSec: 0.5,
  dischargeClearSec: 0.5,
  emptyResetSec: 0.75,
} as const;

const DES_DEFAULT_ROTATION_SPEED = 45; // deg/s
const RIDE_SPEED_M_S = 1.2;            // visual ride cadence across the platform

type State =
  | 'idle'
  | 'aligning_in'
  | 'receiving'
  | 'holding'
  | 'rotating_out'
  | 'discharging'
  | 'discharge_clearing'
  | 'returning_in';

interface TurntableLocal {
  rotaryNode: Object3D | null;
  sensorNode: Object3D | null;
  beltNode: Object3D | null;
  drive: RV.DriveHandle | null;
  belt: RV.BeltHandle | null;
  driveAxis: Vector3;

  sensorOccupied: boolean;
  partCount: number;
  lastCommandedAngle: number;
  clearTimer: number;
  connections: PortConnection[];
  selectedInputPort: string | null;
  beltNeutralAngle: number;
  beltCalibrated: boolean;
  refreshTimer: number;
  emptyFor: number;

  // Round-robin cursors: the port id last served, so the next pick rotates on.
  lastInputPort: string | null;
  lastOutputPort: string | null;

  _dir: Vector3;
  _quat: Quaternion;
}

type TurntableSelf = RV.Self<TurntableLocal, typeof SIGNALS>;

// ── Viewer access (one place for the structural casts) ───────────────────────

interface TransportSurfaceLike { getWorldDirection(out?: Vector3): Vector3; }

/** The real engine RVDrive behind the rotary node — carries the technical values
 *  DES needs (`TargetSpeed`) and the overwrite hook the tween drives. */
interface RotaryDrive {
  readonly node: Object3D;
  TargetSpeed?: number;
  currentPosition: number;
  positionOverwrite: boolean;
  applyToNode(): void;
}

/** The bits of the viewer this component reads — narrowed once here. */
interface TurntableViewer {
  registry?: { findInChildren<T = unknown>(node: Object3D, type: string): T | null } | null;
  getPlugin?(id: string): unknown;
  drives?: RotaryDrive[];
  scene?: Object3D;
}
function viewerOf(self: TurntableSelf): TurntableViewer {
  return (self.viewer ?? {}) as TurntableViewer; // tolerate a headless self (DES unit tests)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function portOccupiedSignal(portId: string): string {
  return `${FLOW_OCCUPIED}@${portId}`;
}

function axisFromDriveNodeName(name: string): Vector3 {
  const m = /Drive-Rot-([XYZ])$/.exec(name);
  if (!m) return new Vector3(0, 1, 0);
  return m[1] === 'X' ? new Vector3(1, 0, 0)
       : m[1] === 'Y' ? new Vector3(0, 1, 0)
       :                new Vector3(0, 0, 1);
}

function setBelt(l: TurntableLocal, forward: boolean): void {
  if (l.belt) l.belt.run(forward);
}
function blockAllInputs(self: TurntableSelf): void {
  for (const c of self.local.connections) self.signals.set(portOccupiedSignal(c.snap.id), true);
}
function openInputPort(self: TurntableSelf, openId: string | null): void {
  for (const c of self.local.connections) self.signals.set(portOccupiedSignal(c.snap.id), c.snap.id !== openId);
}

function surfaceOccupied(self: TurntableSelf): boolean {
  return self.local.beltNode ? self.surfaceOccupied(self.local.beltNode) : self.local.sensorOccupied;
}
function publishOccupied(self: TurntableSelf, surf: boolean): void {
  self.sig.Occupied.set(surf || self.state !== 'idle');
}
function publishRunning(self: TurntableSelf): void {
  self.sig.Running.set(self.state !== 'idle');
}

function calibrateBelt(self: TurntableSelf): void {
  const l = self.local;
  if (l.beltCalibrated || !l.beltNode) return;
  const reg = viewerOf(self).registry;
  if (!reg || typeof reg.findInChildren !== 'function') return;
  const surface = reg.findInChildren<TransportSurfaceLike>(l.beltNode, 'TransportSurface');
  if (!surface) return;
  surface.getWorldDirection(l._dir);
  self.root.getWorldQuaternion(l._quat).invert();
  l._dir.applyQuaternion(l._quat);
  l.beltNeutralAngle = calibrateBeltNeutralAngle(l.driveAxis, l._dir, l.lastCommandedAngle);
  l.beltCalibrated = true;
}

function refreshTopology(self: TurntableSelf): void {
  const l = self.local;
  l.connections = classifyConnections(viewerOf(self), self.root);
  calibrateBelt(self);
  if (self.state === 'receiving') openInputPort(self, l.selectedInputPort);
  else blockAllInputs(self);
}

function inputs(l: TurntableLocal): PortConnection[] { return l.connections.filter(c => c.role === 'input'); }
function outputs(l: TurntableLocal): PortConnection[] { return l.connections.filter(c => c.role === 'output'); }

// Per-port-then-root free-output read. The per-port lookup is essential against a
// downstream turntable/chaintransfer: it goes root-"busy" while receiving FROM us
// (mutual-busy deadlock) yet OPENS this exact port to accept. Falls back to root
// for plain conveyors (no per-port signal).
function freeOutputs(self: TurntableSelf): PortConnection[] {
  const out: PortConnection[] = [];
  for (const c of outputs(self.local)) {
    const rootSig = flowOccupiedRootSignal(c.ownerRoot.name);
    const perPort = `${rootSig}@${c.pairedSnap.id}`;
    const v = self.signals.get(perPort);
    if ((v !== undefined ? v : self.signals.get(rootSig)) === true) continue;
    out.push(c);
  }
  return out;
}

function platformHasPart(self: TurntableSelf, surf: boolean): boolean {
  return surf || self.local.sensorOccupied;
}

// Round-robin: the first FREE port after `lastId` in `all`'s order (cyclic). So the
// disc alternates between ports; if the next in rotation is busy, the following free
// one is taken. Falls back to the first free port; null when none is free.
function pickRoundRobin<T>(free: T[], all: T[], idOf: (t: T) => string, lastId: string | null): T | null {
  if (free.length === 0) return null;
  const freeIds = new Set(free.map(idOf));
  const n = all.length;
  const start = lastId == null ? -1 : all.findIndex(t => idOf(t) === lastId);
  for (let i = 1; i <= n; i++) {
    const cand = all[(start + i) % n];
    if (freeIds.has(idOf(cand))) return cand;
  }
  return free[0];
}

function turntableCat(s: State): string {
  switch (s) {
    case 'idle': return 'Empty';
    case 'holding': return 'Blocked';
    case 'aligning_in':
    case 'returning_in': return 'Setup';       // disc turns EMPTY to position/return
    default: return 'Working';                   // receiving / rotating_out / discharging / clearing
  }
}

function enter(self: TurntableSelf, next: State): void {
  self.setState(next);
  self.statState(turntableCat(next));            // utilization category (both modes)
  publishOccupied(self, surfaceOccupied(self));
  publishRunning(self);
}

// ── FSM transitions (shared) ─────────────────────────────────────────────────

function tryReceive(self: TurntableSelf): void {
  const l = self.local;
  if (self.state !== 'idle') return;
  if (!self.sig.Run.get()) return;

  const all = inputs(l);
  const ready = all.filter(c => self.signals.get(flowOccupiedRootSignal(c.ownerRoot.name)) === true);
  const waiting = pickRoundRobin(ready, all, c => c.snap.id, l.lastInputPort);
  if (!waiting) return;

  l.selectedInputPort = waiting.snap.id;
  l.lastInputPort = waiting.snap.id;
  const target = alignToInputAngle(l.driveAxis, l.beltNeutralAngle, waiting.snap.object3D, l.lastCommandedAngle);
  setBelt(l, false);
  l.drive!.moveTo(target);
  l.lastCommandedAngle = target;
  enter(self, 'aligning_in');
}

function tryDispatch(self: TurntableSelf): void {
  const l = self.local;
  if (!self.sig.Run.get()) { setBelt(l, false); enter(self, 'holding'); return; }

  const chosen = pickRoundRobin(freeOutputs(self), outputs(l), c => c.snap.id, l.lastOutputPort);
  if (!chosen) { setBelt(l, false); enter(self, 'holding'); return; }

  l.lastOutputPort = chosen.snap.id;
  const target = dispatchToOutputAngle(l.driveAxis, l.beltNeutralAngle, chosen.snap.object3D, l.lastCommandedAngle);
  setBelt(l, false);
  l.drive!.moveTo(target);
  l.lastCommandedAngle = target;
  enter(self, 'rotating_out');
}

function onPartAtCenter(self: TurntableSelf): void {
  blockAllInputs(self);
  self.local.selectedInputPort = null;
  tryDispatch(self);
}

function onRotationDone(self: TurntableSelf): void {
  const l = self.local;
  if (self.state === 'aligning_in') {
    enter(self, 'receiving');
    openInputPort(self, l.selectedInputPort);
    setBelt(l, true);
  } else if (self.state === 'rotating_out') {
    setBelt(l, true);
    enter(self, 'discharging');
  }
}

function finishCycle(self: TurntableSelf): void {
  setBelt(self.local, false);
  enter(self, 'idle');
}

function abortToIdle(self: TurntableSelf): void {
  const l = self.local;
  l.drive!.stop();
  setBelt(l, false);
  blockAllInputs(self);
  l.selectedInputPort = null;
  l.emptyFor = 0;
  enter(self, 'idle');
}

/** Restore the freshly-loaded start — used by the reset hook and the drive
 *  context-menu "Reset". The rotary Drive snaps back via RVDrive.reset(); we zero
 *  lastCommandedAngle to match so the next moveTo computes a correct delta. */
function resetTurntable(self: TurntableSelf): void {
  const l = self.local;
  l.drive?.stop();
  setBelt(l, false);
  blockAllInputs(self);
  l.selectedInputPort = null;
  l.sensorOccupied = false;
  l.partCount = 0;
  l.clearTimer = 0;
  l.emptyFor = 0;
  l.refreshTimer = CONFIG.neighborRefreshSec;
  l.lastCommandedAngle = 0;
  l.lastInputPort = null;
  l.lastOutputPort = null;
  self.prop['alignedPort'] = null;
  self.prop['selectedOutput'] = null;
  self.prop['heldMU'] = null;
  self.prop['driveTarget'] = 0;
  self.sig.PartCount.set(0);
  enter(self, 'idle');
}

// ── DES timing & rides ───────────────────────────────────────────────────────
// The DES adapter has no physical drive — a rotation just consumes |Δang|/speed
// seconds, scheduled as `RotateComplete`. `prop['driveTarget']` couples the real
// drive so the tween animates it 1:1 in Animated/HybridSynced.

function rotaryDrive(self: TurntableSelf): RotaryDrive | null {
  const node = self.local.rotaryNode;
  if (!node) return null;
  return viewerOf(self).drives?.find(d => d.node === node) ?? null;
}

/** Rotation speed (deg/s) for the DES schedule: the real drive's TargetSpeed
 *  first, else the RotationSpeed param, else a constant. */
function rotationSpeed(self: TurntableSelf, drv: RotaryDrive | null): number {
  const driveSpeed = drv?.TargetSpeed;
  if (typeof driveSpeed === 'number' && driveSpeed > 0) return driveSpeed;
  const v = self.prop['RotationSpeed'];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : DES_DEFAULT_ROTATION_SPEED;
}

// A booking point is WHERE an MU sits when it is "at" this component. The DES
// animation RIDES the MU to/from it; the turntable's booking point is its CENTRE.
// On the platform the MU is parented under the rotary so it spins WITH the disc.

const _wp = new Vector3();

function nodeWorldXYZ(node: Object3D | null | undefined): [number, number, number] {
  if (!node) return [0, 0, 0];
  node.getWorldPosition(_wp);
  return [_wp.x, _wp.y, _wp.z];
}

function muVisual(mu: RV.MU | null): unknown | null {
  return (mu as { visual?: unknown } | null)?.visual ?? null;
}
function muVisualNode(mu: RV.MU | null): Object3D | null {
  return (mu as { visual?: { node?: Object3D } } | null)?.visual?.node ?? null;
}

/** Ride-on: parent the MU under the rotary (so it spins with the disc), then ride
 *  it — in rotary-LOCAL space — from where it arrived to the CENTRE. Registered
 *  after the belt's transit tween, so it wins the hand-off frame (no teleport). */
function rideOnToCentre(self: TurntableSelf, mu: RV.MU): void {
  enter(self, 'receiving');
  const node = muVisualNode(mu);
  const rotary = self.local.rotaryNode;
  if (!rotary) {
    self.in(0.15, 'Arrival', mu);              // no rotary (tests/degenerate) — just time the arrival
    return;
  }
  if (!node) {
    // HEADLESS MU (plan-262 Phase 3 / R5): derive the SAME ride time as the
    // visual path from visual-independent geometry. The belt transit tween
    // ended with the MU origin one bug-offset BEHIND the entry snap (see
    // transit-timing `tween()`), so that point — snap − bug·forward — IS the
    // visual's position at this event. Ride it (world space, null target: the
    // window is kept for FF-exit materialisation) to the disc CENTRE. The old
    // fixed 0.15 s here changed event times vs. the visual path (KPI drift).
    const centre = nodeWorldXYZ(rotary);
    const aligned = self.prop['alignedPort'];
    const inPort = self.inputs().find(p => p.id === aligned) ?? self.inputs()[0];
    const snap = inPort?.snapNode;
    if (!snap) {
      // Distance-fallback port without a snap: no deterministic entry point
      // exists — keep the legacy timing fallback (documented limitation).
      self.in(0.15, 'Arrival', mu);
      return;
    }
    const sp = nodeWorldXYZ(snap);
    const [fx, fz] = muForward(mu);
    const bug = muBugOffset(mu); // template-preset for headless MUs (Phase 3)
    const from: [number, number, number] = [sp[0] - fx * bug, centre[1], sp[2] - fz * bug];
    const dt = Math.max(0.15, Math.hypot(from[0] - centre[0], from[2] - centre[2]) / RIDE_SPEED_M_S);
    schedulePositionMove(self, { target: null, from, to: centre, time: dt }, 'Arrival', mu);
    return;
  }
  rotary.attach(node);                          // reparent, preserving world transform → local coords
  const from: [number, number, number] = [node.position.x, node.position.y, node.position.z];
  const to: [number, number, number] = [0, from[1], 0]; // local centre (keep sit height)
  const dt = Math.max(0.15, Math.hypot(from[0], from[2]) / RIDE_SPEED_M_S);
  schedulePositionMove(self, { target: muVisual(mu), from, to, time: dt }, 'Arrival', mu);
}

/** Ride-off: release the MU back to the scene (keeping its spun orientation), then
 *  ride it — in WORLD space — from the centre out to the discharge-edge (the output
 *  snap). The MU ORIGIN rides to one bug-offset BEHIND the snap, so its LEADING edge
 *  reaches it and the downstream belt continues from exactly there (no jump). */
function rideOffToOutput(self: TurntableSelf, mu: RV.MU, outNode: Object3D | null | undefined): void {
  const node = muVisualNode(mu);
  // HEADLESS MU (plan-262 Phase 3 / R5): the part sits at the disc CENTRE (the
  // ride-on ended there and it rotated WITH the disc), so the ride starts at
  // the rotary's world position — static geometry, identical to the visual
  // path. Before this guard a null visual read the WORLD ORIGIN ([0,0,0]) as
  // `from`, corrupting the discharge direction AND the ride time — and the
  // ride time DIRECTLY sets the next event time (the hardest determinism break
  // of the phase). Null target: the tween window is kept for materialisation.
  const from = node ? nodeWorldXYZ(node) : nodeWorldXYZ(self.local.rotaryNode);
  const scene = viewerOf(self).scene;
  if (node && scene) scene.attach(node);
  const tgt = nodeWorldXYZ(outNode);
  let dx = tgt[0] - from[0], dz = tgt[2] - from[2];
  const d = Math.hypot(dx, dz);
  if (d > 1e-6) { dx /= d; dz /= d; } else { dx = 0; dz = 1; }
  setMuForward(mu, dx, dz);                      // the disc rotated the part to face the output — record it
  const bug = muBugOffset(mu);                   // template-preset for headless MUs (Phase 3)
  const to: [number, number, number] = [tgt[0] - dx * bug, from[1], tgt[2] - dz * bug];
  const dt = Math.max(0.15, Math.hypot(to[0] - from[0], to[2] - from[2]) / RIDE_SPEED_M_S);
  schedulePositionMove(self, { target: muVisual(mu), from, to, time: dt }, 'Arrival', mu);
}

/** Linear speed (m/s) the discharged part leaves at on the DOWNSTREAM belt — drives
 *  the tail clear-time so the disc waits the exact time the tail needs, not a
 *  constant (a fixed speed would free early when the next belt is slower → drift). */
function outputClearSpeedMs(self: TurntableSelf, out: RV.Port | undefined): number {
  const root = out?.ownerRoot;
  if (!root) return RIDE_SPEED_M_S;
  let belt: Object3D | undefined;
  root.traverse(o => { if (!belt && /transport/i.test(o.name)) belt = o; });
  const mmS = belt ? self.drive(belt)?.TargetSpeed : undefined;
  return typeof mmS === 'number' && mmS > 0 ? mmS / 1000 : RIDE_SPEED_M_S;
}

function maxCapacity(self: TurntableSelf): number {
  const v = self.prop['MaxCapacity'];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** DES rotate: command a logical rotation and schedule `RotateComplete` after
 *  |Δang|/speed seconds. `mu` is threaded to the completion hook. */
function desRotateTo(self: TurntableSelf, targetAngle: number, next: State, mu: RV.MU | null): void {
  const l = self.local;
  const from = l.lastCommandedAngle;
  l.lastCommandedAngle = targetAngle;
  self.prop['driveTarget'] = targetAngle;        // tween coupling target
  enter(self, next);
  const drive = rotaryDrive(self);
  scheduleDriveMove(self, { drive, speed: rotationSpeed(self, drive), from, to: targetAngle }, 'RotateComplete', mu);
}

/** Round-robin over the OUTPUT ports, restricted to the currently free ones. */
function desSelectOutput(self: TurntableSelf): RV.Port | null {
  return pickRoundRobin(self.freeOutputs(), self.outputs(), p => p.id, self.local.lastOutputPort);
}

/** Dispatch angle that aligns the disc to a chosen OUTPUT. Uses this turntable's
 *  OWN local output snap node (root-local angle frame), not the downstream root. */
function dispatchAngleFor(self: TurntableSelf, out: RV.Port): number {
  return dispatchToOutputAngle(self.local.driveAxis, self.local.beltNeutralAngle, out.snapNode ?? out.ownerRoot, self.local.lastCommandedAngle);
}

/** Angle that aligns the disc to RECEIVE from its (first) input; null when the
 *  input has no snap node (distance-fallback port). */
function desInputAlignAngle(self: TurntableSelf): number | null {
  const inNode = self.inputs()[0]?.snapNode;
  if (!inNode) return null;
  return alignToInputAngle(self.local.driveAxis, self.local.beltNeutralAngle, inNode, self.local.lastCommandedAngle);
}

// ── def ──────────────────────────────────────────────────────────────────────

const def = {
  type: 'Turntable' as const,
  kind: 'router' as const,
  description: 'Rotating platform that re-routes parts 90° between conveyor sides.',
  mcpDocs:
    'Multi-port router / corner piece. 4 snaps Snap-{ZN,ZP,XN,XP}-convroll (all bidi, typeId ' +
    'convroll) — connect a conveyor on any side. A part arrives, the table rotates to a free ' +
    'output, then discharges. Use it for 90° corners and junctions: snap-attach it to a ' +
    'conveyor output, then continue the next run off a perpendicular snap (Snap-XP = left, ' +
    'Snap-XN = right). RotationSpeed (deg/s) and MaxCapacity are DES params.',
  models: ['*Turntable*'],
  // DES-only params (read by the des block; the continuous FSM drives the real drive
  // and reads neither), hence scope:'des' (read-only "(DES)" rows in the live view).
  schema: {
    RotationSpeed: { type: 'number' as const, default: 45, scope: 'des' as const }, // deg/s
    MaxCapacity:   { type: 'number' as const, default: 1, scope: 'des' as const },
  },

  signalNamespace: 'Flow' as const,
  signals: SIGNALS,

  state: (): TurntableLocal => ({
    rotaryNode: null,
    sensorNode: null,
    beltNode: null,
    drive: null,
    belt: null,
    driveAxis: new Vector3(0, 1, 0),

    sensorOccupied: false,
    partCount: 0,
    lastCommandedAngle: 0,
    clearTimer: 0,
    connections: [],
    selectedInputPort: null,
    beltNeutralAngle: 0,
    beltCalibrated: false,
    refreshTimer: CONFIG.neighborRefreshSec,
    emptyFor: 0,
    lastInputPort: null,
    lastOutputPort: null,

    _dir: new Vector3(),
    _quat: new Quaternion(),
  }),

  logic: { enter, tryReceive, tryDispatch, onPartAtCenter, onRotationDone, finishCycle, abortToIdle },

  // Mode-agnostic init (continuous AND DES): resolve nodes, attach drive models,
  // calibrate, build the Reset context menu.
  setup(self: TurntableSelf): void {
    const l = self.local;
    const rootTag = self.root.name || '<unnamed>';
    const rotaryNode = self.find('rotary');
    const sensorNode = self.find('sensor');
    const beltNode = self.find('transport');
    if (!rotaryNode) return self.disable('no Drive-Rot-* node');
    if (!sensorNode) return self.disable('no Sensor node');
    if (!beltNode)   console.warn(`[Turntable:${rootTag}] no Transport-* node found — belt stop/start will be a no-op`);

    l.rotaryNode = rotaryNode;
    l.sensorNode = sensorNode;
    l.beltNode = beltNode;
    l.driveAxis = axisFromDriveNodeName(rotaryNode.name);

    self.sig.Run.set(true);                       // Run defaults TRUE (the one non-default signal)
    self.stamp('TurntableBehavior', {
      Drive: rotaryNode.name,
      Sensor: sensorNode.name,
      ...(beltNode ? { Belt: beltNode.name } : {}),
    });

    // AddComponent (Unity-style): attach each drive's behaviour model and create +
    // wire its control signals — visibly. A PLC binds these to drive the real axis
    // (see the isWired guard). Role prefixes (Rot./Transport.) namespace the two
    // drives; the drive's remaining standard slots auto-provision under its node.
    self.addComponent(rotaryNode, 'Drive_DestinationMotor', {
      StartDrive:  self.addSignal(rotaryNode, 'Rot.StartDrive',  'PLCOutputBool'),
      Destination: self.addSignal(rotaryNode, 'Rot.Destination', 'PLCOutputFloat'),
    });
    if (beltNode) self.addComponent(beltNode, 'Drive_Simple', {
      Forward:  self.addSignal(beltNode, 'Transport.Forward',  'PLCOutputBool'),
      Backward: self.addSignal(beltNode, 'Transport.Backward', 'PLCOutputBool'),
    });

    calibrateBelt(self);
    self.prop['alignedPort'] = null;
    self.prop['selectedOutput'] = null;
    self.prop['heldMU'] = null;
    self.prop['driveTarget'] = l.lastCommandedAngle;
    self.setState('idle');
    self.statState('Empty');

    self.contextMenu(rotaryNode, [
      { id: 'reset', label: 'Reset', action: () => resetTurntable(self) },
    ]);
  },

  reset(self: TurntableSelf): void {
    resetTurntable(self);
  },
  start(self: TurntableSelf): void {
    self.sig.Run.set(true);
  },

  continuous: {
    setup(self: TurntableSelf): void {
      const l = self.local;
      l.drive = self.attachDrive(l.rotaryNode!);
      l.belt = l.beltNode ? self.attachBelt(l.beltNode) : null;

      for (const sp of listOwnSnaps(viewerOf(self), self.root)) {
        self.signals.set(portOccupiedSignal(sp.id), true);
      }
      l.connections = classifyConnections(viewerOf(self), self.root);
      calibrateBelt(self);

      self.onSensorChanged(l.sensorNode!, (present) => {
        if (present && !l.sensorOccupied) {
          l.partCount += 1;
          self.sig.PartCount.set(l.partCount);
        }
        l.sensorOccupied = present;
        publishOccupied(self, surfaceOccupied(self));

        if (present) {
          if (self.state === 'receiving') onPartAtCenter(self);
        } else if (self.state === 'discharging') {
          l.clearTimer = CONFIG.dischargeClearSec;
          enter(self, 'discharge_clearing');
        }
      });
    },

    fixedUpdate(self: TurntableSelf, dt: number): void {
      const l = self.local;
      if (self.isWired) return;          // an interface controls the drive → stay silent
      if (!l.rotaryNode) return;

      const surf = surfaceOccupied(self);
      publishOccupied(self, surf);

      l.refreshTimer += dt;
      if (l.refreshTimer >= CONFIG.neighborRefreshSec) {
        l.refreshTimer = 0;
        refreshTopology(self);
        if (self.state === 'idle') tryReceive(self);
        else if (self.state === 'holding' && l.sensorOccupied) tryDispatch(self);
      }

      if (self.state !== 'idle' && self.state !== 'aligning_in') {
        if (!platformHasPart(self, surf)) {
          l.emptyFor += dt;
          if (l.emptyFor >= CONFIG.emptyResetSec) abortToIdle(self);
        } else {
          l.emptyFor = 0;
        }
      } else {
        l.emptyFor = 0;
      }

      switch (self.state as State) {
        case 'idle':
          setBelt(l, false);
          break;
        case 'aligning_in':
          if (l.drive!.isAtTarget()) onRotationDone(self);
          break;
        case 'receiving':
          setBelt(l, true);
          break;
        case 'holding':
          setBelt(l, false);
          break;
        case 'rotating_out':
          if (l.drive!.isAtTarget()) onRotationDone(self);
          break;
        case 'discharging':
          break;
        case 'discharge_clearing':
          setBelt(l, true);
          l.clearTimer -= dt;
          if (l.clearTimer <= 0) finishCycle(self);
          break;
      }
    },
  },

  des: {
    // The ride-on/ride-off hooks sample the MU's LIVE world position at event
    // time (rideOnToCentre/rideOffToOutput) — keep the per-event-time tween
    // settle active while a turntable instance exists (plan-262 Phase 2).
    samplesLiveGeometry: true,
    // Accept only when IDLE and below capacity — otherwise reject so the upstream
    // holds the next part (back-pressure). `alignedPort` restricts to the aligned input.
    canAccept(self: TurntableSelf, _mu: RV.MU, port?: RV.Port): boolean {
      if (self.currentLoad >= maxCapacity(self)) return false;
      if (self.state !== 'idle') return false;
      if (port && self.prop['alignedPort'] != null && port.id !== self.prop['alignedPort']) return false;
      return true;
    },
    // Align-on-accept (identical to continuous): FIRST rotate the disc to the input
    // (the part waits at the edge), THEN ride it on straight — so it always enters
    // straight regardless of where the previous discharge left the disc.
    onAccept(self: TurntableSelf, mu: RV.MU, port?: RV.Port): boolean {
      if (!self.local.beltCalibrated) calibrateBelt(self); // lazy retry if setup couldn't resolve the surface
      self.prop['alignedPort'] = port?.id ?? null;
      const align = desInputAlignAngle(self);
      if (align == null) rideOnToCentre(self, mu);          // no input snap — ride on at the current angle
      else desRotateTo(self, align, 'aligning_in', mu);
      return true;
    },
    // 'Arrival' branched on state:
    //   receiving          — the leading edge reached the CENTRE → rotate to a free
    //                        output, or HOLD if none free.
    //   discharging        — the leading edge reached the output → hand the part off,
    //                        but the TAIL is still on the disc → start the clear gate.
    //   discharge_clearing — the tail has cleared → the disc is empty → return to input.
    onArrival(self: TurntableSelf, mu: RV.MU): void {
      if (self.state === 'receiving') {
        const out = desSelectOutput(self);
        if (!out) { self.prop['heldMU'] = mu.id; enter(self, 'holding'); return; }
        self.prop['selectedOutput'] = out.id;
        self.local.lastOutputPort = out.id;
        desRotateTo(self, dispatchAngleFor(self, out), 'rotating_out', mu);
      } else if (self.state === 'discharging') {
        const outId = self.prop['selectedOutput'] as string | null;
        const out = outId != null ? self.outputs().find(p => p.id === outId) : undefined;
        self.transfer(mu, out);
        self.prop['selectedOutput'] = null;
        self.prop['heldMU'] = null;
        // Tail gate: the leading edge is at the output but the tail is still on the
        // disc — do NOT rotate yet. Wait one part-length (2·bug) / downstream speed,
        // so the disc never frees early (canAccept rejects meanwhile).
        enter(self, 'discharge_clearing');
        const clearTime = Math.max(0.05, (2 * muBugOffset(mu)) / outputClearSpeedMs(self, out));
        self.in(clearTime, 'Arrival', mu);
      } else if (self.state === 'discharge_clearing') {
        // Tail cleared → disc empty → return to the input alignment (only rotates empty).
        const align = desInputAlignAngle(self);
        if (align == null) enter(self, 'idle');
        else desRotateTo(self, align, 'returning_in', null);
      }
    },
    // RotateComplete fires for the input-align, the dispatch and the gated return rotations.
    onRotateComplete(self: TurntableSelf, mu: RV.MU): void {
      if (self.state === 'aligning_in') { rideOnToCentre(self, mu); return; }  // aligned → ride the part on
      if (self.state === 'returning_in') { enter(self, 'idle'); return; }       // returned empty → ready
      // Dispatch rotation done — the part sits at the rotated centre (spun with the
      // disc). Release it and ride it out to the discharge edge; onArrival hands off.
      const outId = self.prop['selectedOutput'] as string | null;
      const out = outId != null ? self.outputs().find(p => p.id === outId) : undefined;
      enter(self, 'discharging');
      rideOffToOutput(self, mu, out?.snapNode ?? out?.ownerRoot);
    },
    // A chosen output freed while a part is HELD at the centre — dispatch it now.
    onDownstreamReady(self: TurntableSelf, _from: unknown): void {
      if (self.state !== 'holding') return;
      const heldId = self.prop['heldMU'] as number | null;
      if (heldId == null) return;
      const out = desSelectOutput(self);
      if (!out) return; // still blocked — wait for the next ready signal
      const held = self.mus.find(m => m.id === heldId) ?? null;
      self.prop['selectedOutput'] = out.id;
      self.local.lastOutputPort = out.id;
      desRotateTo(self, dispatchAngleFor(self, out), 'rotating_out', held);
    },
  },
};

/** Turntable — multi-port router (factory-built; behaviour identical to the def). */
const TurntableBehavior = defineLibraryComponent(def);

/** The material-flow definition (schema + logic + continuous + des) — for DES tests / runner. */
export const TurntableFlow = def;

export default TurntableBehavior;
