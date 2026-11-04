// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Conveyor — a zone-accumulation belt (one part per zone).
 *
 * The rule, in one sentence: the belt RUNS, unless a part is sitting at its exit
 * sensor AND the next zone downstream is still full — then it STOPS so parts queue
 * up instead of crashing together. (This is "ZPA" — Zoned Part Accumulation.)
 *
 * Like every material-flow component this ONE definition runs two ways:
 *   • Continuous — 60 Hz physics: the belt surface slides the part, the sensor
 *     fires on overlap, `continuous.fixedUpdate` jogs the belt.
 *   • DES — events: `des.onAccept` schedules the part's arrival after its transit
 *     time (length / speed) and the handshake hands it downstream.
 * The shared decision (`logic.shouldFlow`) is written once and used by both.
 *
 * How to read this file: SIGNALS (the PLC contract) → the `logic` functions (the
 * shared brain) → the `def` object (schema, signals, state, setup, continuous, des).
 *
 * The Transport drive carries a `Drive_Simple` model (added in setup via
 * `self.addComponent`): its standard control/feedback signals live in the
 * component's `Signals` folder and mirror the real belt state every tick.
 *
 * Full authoring guide: doc-behavior-modelling.md
 */

import { captureConveyor, restoreConveyor, validateConveyor } from './_shared/conveyor-snapshot';
import {
  defineLibraryComponent,
  createTransitTimer,
  POSE_ALIGN_TOLERANCE_M,
  type RV,
  type TransitTimer,
  type PoseProjection,
} from './_shared/behavior-kit';
import type { AcceptContext, Port } from '../core/material-flow/material-flow-self';
import { reportProblem, clearProblem } from '../core/hmi/problems-store';
import { isDesRestoring } from '../core/material-flow/des-restore-guard';
import { isSurfaceOccupiedByOwner } from './_shared/surface-occupancy';
import { createDownstreamInterlock } from './_shared/transport-links';
import { behaviorWaitEdges } from '../core/diagnostics/rv-behavior-wait-sources';
import { findOutputPairings } from './_shared/snap-graph-helpers';

// Public 4-signal material-flow contract — auto-declared (by createSelf) as
// `Flow.<key>` (signalNamespace: 'Flow') and exposed as typed `self.sig.<key>`
// accessors. The namespace is type-neutral (`Flow`, not `Conveyor`) because
// turntables and sinks publish/read the SAME interop signals to join the line.
const SIGNALS = {
  Run:       'PLCInputBool',
  Occupied:  'PLCOutputBool',
  Running:   'PLCOutputBool',
  PartCount: 'PLCOutputInt',
} as const;

// Local state slot (type-inferred from `state`). `belt`/`sensor` are resolved
// path-agnostically in setup() (the finders work on BOTH the continuous and DES
// paths) and stored here.
export interface ConveyorLocal {
  belt: RV.Node | null;
  sensor: RV.Node | null;
  beltHandle: RV.BeltHandle | null;
  interlock: { occupied(): boolean } | null;
  partAtSensor: boolean;
  partCount: number;
  blockedMUs: RV.MU[];
  blockedTarget: Port | null;
  /** Resolved DES transit-timing model (speed/length/transitTime + entry/exit tween). */
  timer: TransitTimer | null;
  /** MUs currently in transit → their DES arrival event id (cancel-on-reset). */
  transitMUs: Map<number, number>;
  /** plan-645 L7: the DES `Flow.Run` edge subscription exists for this bind (once per self). */
  runWakeSubscribed: boolean;
  /** Last seen `Flow.Run` value (edge detection). */
  runWasOn: boolean;
  /** Re-entrancy guard of {@link wakeOnRun}: a nested wake is a no-op. */
  waking: boolean;
}
export type ConveyorSelf = RV.Self<ConveyorLocal, typeof SIGNALS>;

// ── ZPA rule (shared: continuous + DES) ──
// partAtSensor is the LOCAL discharge trigger — NOT the published surface-based Flow.Occupied.
function shouldFlow(self: ConveyorSelf): boolean {
  const l = self.local;
  // ZPA: run unless a part sits at the sensor AND the downstream zone is occupied.
  return self.sig.Run.get() && !(l.partAtSensor && (l.interlock?.occupied() ?? true));
}
function onPartAtSensor(self: ConveyorSelf, present: boolean): void {
  const l = self.local;
  if (present && !l.partAtSensor) self.sig.PartCount.set(++l.partCount);
  l.partAtSensor = present;
}
function tryRelease(self: ConveyorSelf, mu: RV.MU): boolean {
  // ZPA release: hand off only when the belt runs AND the downstream can accept.
  // Otherwise park the part on the belt and retry on onDownstreamReady / run-signal.
  const out = self.outputs()[0];
  if (self.sig.Run.get() && self.downstreamCanAccept(mu, out)) {
    self.transfer(mu, out);
    self.local.partAtSensor = false;
    self.local.blockedTarget = null;
    return true;
  }
  self.local.blockedMUs.push(mu);
  self.local.blockedTarget = out ?? null;
  return false;
}
// plan-645 L7 — Flow.Run false→true in DES releases what the stopped belt parked.
// Bounded: the list is detached (work list = the parked MUs at this moment), each
// MU gets at most ONE try, the first refusal ends the pass and the refused MU and
// everything behind it go back in their order (FIFO). A nested wake (a transfer
// that re-enters) is a no-op. Every parked MU is kept: `self.mus` is not
// authoritative for every DES holder (a PalletYard input conveyor parks MUs that
// are not in its adapter view; plan-645 regression fix, 2026-10-21).
function wakeOnRun(self: ConveyorSelf): void {
  const l = self.local;
  if (l.waking || l.blockedMUs.length === 0 || !self.sig.Run.get()) return;
  l.waking = true;
  try {
    const work = l.blockedMUs.splice(0);
    for (let i = 0; i < work.length; i++) {
      if (!tryRelease(self, work[i])) {      // refused → pushed back once by tryRelease
        for (let j = i + 1; j < work.length; j++) l.blockedMUs.push(work[j]);
        break;
      }
    }
  } finally {
    l.waking = false;
  }
  conveyorStat(self, false);
}
function onRunChanged(self: ConveyorSelf, value: boolean | number): void {
  const on = !!value;
  const edge = on && !self.local.runWasOn;
  self.local.runWasOn = on;
  if (!edge) return;
  // plan-2059 phase 8: a Run value written by a restore is restored state, not an edge. The
  // restored blocked list and queue already are the uninterrupted run; a catch-up wake would
  // add one extra release attempt (blockedCount, utilization) that the uninterrupted run never made.
  if (isDesRestoring()) return;
  wakeOnRun(self);
}

// Canonical utilization category (shared: continuous + DES). Blocked = a part sits at
// the exit and the downstream zone is full (DES: parked in blockedMUs; continuous: the
// interlock is occupied). Working = a part is on the belt (in transit, at the sensor,
// or overlapping the surface). Empty = no part. Reported via self.statState so the
// continuous StateStatistics AND the DES component both capture it (de-duped).
function conveyorStat(self: ConveyorSelf, occ: boolean): void {
  const l = self.local;
  const blocked = l.blockedMUs.length > 0 || (l.partAtSensor && (l.interlock?.occupied() ?? false));
  const hasPart = blocked || l.partAtSensor || l.transitMUs.size > 0 || occ;
  self.statState(blocked ? 'Blocked' : hasPart ? 'Working' : 'Empty');
}

// ── Pose take-over (plan-631, DES only) ──
// Problems id of a refused pose hand-over — one entry per conveyor, re-reported
// (not appended) while the cause persists, cleared by the next good take-over.
function poseProblemId(self: ConveyorSelf): string {
  return `transfer-pose-off-belt:${self.root.name}`;
}
const mm = (m: number): string => (m * 1000).toFixed(1);
function reportPoseOffBelt(self: ConveyorSelf, p: PoseProjection): void {
  const tol = mm(POSE_ALIGN_TOLERANCE_M);
  reportProblem({
    id: poseProblemId(self),
    severity: 'warning',
    code: 'transfer-pose-off-belt',
    title: `Hand-over pose is off the belt of '${self.root.name}'`,
    detail:
      `reason ${p.reason}; actual: along ${mm(p.along)} mm, lateral ${mm(p.lateral)} mm, ` +
      `height ${mm(p.height)} mm (MU underside − roller top ${p.rollerTop.toFixed(4)} m); ` +
      `expected: along ${mm(-p.bug)}…${mm(p.lengthM - p.bug)} mm, lateral 0, height 0 (±${tol} mm each)`,
    nodePath: self.root.name,
  });
}

const def = {
  type: 'Conveyor' as const,
  kind: 'conveyor' as const,
  description: 'Straight conveyor that transports parts along its length.',
  mcpDocs:
    'Straight transport conveyor. Material flows along its local +Z: input snap ' +
    'Snap-ZN-convroll (-Z end), output snap Snap-ZP-convroll (+Z end). Chain a run by ' +
    'snap-attaching the next conveyor to the previous output (Snap-ZP-convroll). For a 90° ' +
    'turn, insert a Turntable. Speed comes from the embedded Transport Drive (TargetSpeed); ' +
    'the central drive-speed override scales it.',
  models: ['*Conveyor*'],
  // No DES timing fields: the transit timing is derived from the real belt
  // geometry (length) and the Transport Drive's TargetSpeed (speed), so there is
  // nothing for the user to configure here. See _shared/transit-timing.ts.
  schema: {},

  // Type-neutral interop signals — auto-declared as `Flow.<key>` + typed self.sig.
  signalNamespace: 'Flow' as const,
  signals: SIGNALS,

  // Per-instance state slot (type-inferred). Used by BOTH the continuous shim and
  // the DES model-load binding so a directly-created self gets its local fields.
  state: (): ConveyorLocal => ({
    belt: null, sensor: null, beltHandle: null, interlock: null,
    partAtSensor: false, partCount: 0, blockedMUs: [], blockedTarget: null, timer: null, transitMUs: new Map(),
    runWakeSubscribed: false, runWasOn: false, waking: false,
  }),

  logic: { shouldFlow, onPartAtSensor },

  // Runs once for continuous AND DES: resolve nodes, add components, wire signals.
  setup(self: ConveyorSelf): void {
    const l = self.local;
    l.belt = self.find('transport');
    l.sensor = self.find('sensor');
    if (!l.belt || !l.sensor) return self.disable('missing Transport-*/Sensor-* node');
    self.registerWaitSource({ id: `conveyor:${self.root.uuid}`, edges: () => {
      if (self.disabled || !self.sig.Run.get()) return [];
      if (self.mode === 'des') {
        if (l.blockedMUs.length === 0) return [];
        const out = l.blockedTarget;
        return behaviorWaitEdges(self, out?.ownerRoot ?? null,
          out?.id ?? `output:${self.root.uuid}`, 'conveyor-interlock');
      }
      if (!l.partAtSensor || !(l.interlock?.occupied() ?? true)) return [];
      const out = findOutputPairings(self.viewer as { getPlugin?(id: string): unknown }, self.root)[0];
      return behaviorWaitEdges(self, out?.ownerRoot ?? null,
        out?.pairedSnap.id ?? `output:${self.root.uuid}`, 'conveyor-interlock');
    } });

    l.partAtSensor = false;
    l.blockedMUs.length = 0;
    l.blockedTarget = null;
    l.transitMUs.clear();

    // The belt runs unless told to stop (a live CONNECT source owns Run when bound).
    if (!self.isWired) self.sig.Run.set(true);
    self.stamp('ConveyorBehavior', { Belt: l.belt.name, Sensor: l.sensor.name });

    // AddComponent (Unity-style): attach a Drive_Simple to the belt and create +
    // wire its control signals — visibly. A PLC binds Transport.Forward/Backward to
    // drive the belt (see the isWired guard); the drive's other standard slots
    // auto-provision under the belt node.
    self.addComponent(l.belt, 'Drive_Simple', {
      Forward:  self.addSignal(l.belt, 'Transport.Forward',  'PLCOutputBool'),
      Backward: self.addSignal(l.belt, 'Transport.Backward', 'PLCOutputBool'),
    });

    // DES transit timing: speed from the Transport drive, length from the belt geometry.
    l.timer = createTransitTimer(self, l.belt);
    // plan-645 L7: DES releases parked MUs on a Run edge. Subscribed once per
    // bind (setup re-runs on every start; the bind context drops it on unbind).
    l.runWasOn = !!self.sig.Run.get();
    if (self.mode === 'des' && !l.runWakeSubscribed) {
      l.runWakeSubscribed = true;
      self.signals.on('Flow.Run', (v) => onRunChanged(self, v));
    }
    self.contextMenu(l.belt, [
      { id: 'run',  label: 'Run',  action: () => self.sig.Run.set(true) },
      { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
        action: () => self.sig.Run.set(false) },
    ]);
  },

  reset(self: ConveyorSelf): void {
    const l = self.local;
    l.partAtSensor = false;
    l.partCount = 0;
    l.blockedMUs.length = 0;
    l.blockedTarget = null;
    l.transitMUs.clear();
    self.sig.PartCount.set(0);
    self.sig.Occupied.set(false);
    self.sig.Running.set(false);
  },
  start(self: ConveyorSelf): void {
    if (!self.isWired) self.sig.Run.set(true);
  },

  continuous: {
    setup(self: ConveyorSelf): void {
      const l = self.local;
      l.beltHandle = self.attachBelt(l.belt!);
      l.interlock = createDownstreamInterlock(self, { sinkAtOutput: true });
      self.onSensorChanged(l.sensor!, (occupied) => onPartAtSensor(self, occupied));
    },
    fixedUpdate(self: ConveyorSelf): void {
      const l = self.local;
      if (self.isWired) return;          // an interface controls the belt → stay silent
      const occ = isSurfaceOccupiedByOwner(self.viewer, l.belt!);
      self.sig.Occupied.set(occ);
      const moving = shouldFlow(self);
      self.sig.Running.set(moving);
      l.beltHandle!.run(moving);
      conveyorStat(self, occ); // utilization: Working / Blocked / Empty (de-duped)
    },
  },

  des: {
    // plan-631: canAccept/onAccept honour ctx.acceptPose (take-over where the MU
    // was set down). Without a pose both hooks run exactly the legacy path.
    acceptsPose: true,
    // Capacity stays the runner's global MaxCapacity check (F4). A pose hand-over
    // is additionally checked for plausibility BEFORE the owner changes (F3):
    // off the belt → refuse, report, the current owner keeps the MU.
    canAccept(self: ConveyorSelf, mu: RV.MU, _port?: RV.Port, ctx?: AcceptContext): boolean {
      const pose = ctx?.acceptPose;
      if (!pose) return true;
      const p = self.local.timer!.fromPose(mu, pose);
      if (p.ok) return true;
      reportPoseOffBelt(self, p);
      return false;
    },
    // Accept = enter transit. Schedule the arrival at the discharge point (the
    // belt exit) after the full-belt transit time of SIM time (NOT an immediate
    // release), and attach a straight entry→exit position tween. Capacity is
    // single-zone; the runner's canAccept already enforces MaxCapacity, so
    // returning true here accepts the MU into transit. With a take-over pose the
    // transit starts AT the pose: remaining time (L − s)/v, tween pose → exit.
    onAccept(self: ConveyorSelf, mu: RV.MU, _port?: RV.Port, ctx?: AcceptContext): boolean {
      const l = self.local;
      const pose = ctx?.acceptPose;
      if (pose) {
        const p = l.timer!.fromPose(mu, pose, { commit: true });
        if (!p.ok) { reportPoseOffBelt(self, p); return false; }
        clearProblem(poseProblemId(self));
        l.transitMUs.set(mu.id, self.in(p.remaining, 'Arrival', mu, p.tween!));
      } else {
        l.transitMUs.set(mu.id, self.in(l.timer!.transitTime, 'Arrival', mu, l.timer!.tween(mu)));
      }
      conveyorStat(self, false); // part entered transit → Working
      return true;
    },
    // Arrival at the discharge point (belt exit): mark the part present (the
    // local discharge trigger), then run the existing release handshake. A
    // downstream block parks the MU in blockedMUs (back-pressure).
    onArrival(self: ConveyorSelf, mu: RV.MU): void {
      self.local.transitMUs.delete(mu.id);
      onPartAtSensor(self, true);
      tryRelease(self, mu);
      conveyorStat(self, false); // released → Empty, or parked → Blocked
    },
    onDownstreamReady(self: ConveyorSelf): void {
      const mu = self.local.blockedMUs.shift();
      if (mu) tryRelease(self, mu);
      conveyorStat(self, false); // unblocked → Empty/Working, or re-parked → Blocked
    },
    validateSnapshot: validateConveyor,
    onSnapshot(self: ConveyorSelf): unknown {
      return captureConveyor(self.local, self.mus);
    },
    onRestore(self: ConveyorSelf, state?: unknown): void {
      restoreConveyor(self, state);
      self.local.blockedTarget = null;
      // No catch-up wake (plan-2059 phase 8, replaces plan-645 L7): the v4 restore is exact.
      self.local.runWasOn = !!self.sig.Run.get();
    },
  },
};

/** Conveyor — zone-accumulation conveyor (factory-built; behaviour identical to the def). */
const ConveyorBehavior = defineLibraryComponent(def);

/** The material-flow definition (schema + logic + continuous + des) — for DES tests / runner. */
export const ConveyorFlow = def;

export default ConveyorBehavior;
