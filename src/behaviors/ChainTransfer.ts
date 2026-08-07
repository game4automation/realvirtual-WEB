// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ChainTransfer — a right-angle chain transfer, modelled as a Turntable whose
 * "alignment" is a LIFT instead of a rotation.
 *
 * Geometry / convention nodes:
 *   • Transport-Z   the main roller line. Ports Snap-Z*-convroll (FIXED in/out).
 *   • Transport-X   the cross chain (90° to Z), a CHILD of the lift. One port
 *                   Snap-X*-convchain — BIDIRECTIONAL (role taken from the
 *                   connected conveyor's direction, like the Turntable).
 *   • Drive-Lin-Y   the lift. At rest Transport-X sits below Transport-Z (Z
 *                   rollers carry the goods). Raising the lift engages the X
 *                   chains (they lift the goods off the rollers and move them
 *                   sideways). So: lift DOWN = Z engaged, lift UP = X engaged.
 *   • Sensor        single centre sensor — fires when the pallet is at the
 *                   transfer spot (detects it whether on the rollers or lifted).
 *
 * Behaviour — a Turntable-style router (always stop & route): a pallet is
 * received to the centre, held, then dispatched to a FREE output (preferring the
 * straight Z-out; using the X branch only when Z-out is busy). The lift selects
 * the axis for the active port; the X chain direction comes from the neighbour.
 *
 * Full authoring guide: doc-behavior-modelling.md
 */

import { Vector3 } from 'three';
import type { Object3D } from 'three';
import { defineLibraryComponent, createTransitTimer, type RV, type TransitTimer } from './_shared/behavior-kit';
import { classifyConnections, listOwnSnaps, type PortConnection } from './_shared/snap-graph-helpers';
import { FLOW_OCCUPIED, flowOccupiedRootSignal } from './_shared/transport-links';
import { findFirst, findSensor, parseTransportName, parseDriveName } from '../core/library-component-loader';

// Same type-neutral material-flow interop contract as Conveyor/Turntable.
const SIGNALS = {
  Run:       'PLCInputBool',
  Occupied:  'PLCOutputBool',
  Running:   'PLCOutputBool',
  PartCount: 'PLCOutputInt',
} as const;

const CONFIG = {
  /** How often the snap topology + branch direction are re-evaluated. */
  topologyRefreshSec: 0.5,
  /** Belt run-on after the centre clears on discharge, so the pallet fully
   *  crosses onto the downstream before the lift returns to neutral. */
  dischargeClearSec: 0.1,
  /** Default lift travel (mm) from rest to engaged when no LiftHeight is set.
   *  Use a negative value if Drive-Lin-Y's positive axis points down. */
  defaultLiftHeight: 20,
} as const;

type State =
  | 'idle'
  | 'engage_in'
  | 'receiving'
  | 'holding'
  | 'engage_out'
  | 'discharging'
  | 'lowering';

// Map the internal FSM phase to a CANONICAL utilization category (Plan 201): the
// part is engaged / riding across the transfer → Working; the lift lowers back
// EMPTY after discharge → Setup; it holds a part it cannot dispatch → Blocked;
// nothing on it → Empty. Reported via self.statState (both modes, de-duped).
function chainCat(s: State): string {
  switch (s) {
    case 'idle': return 'Empty';
    case 'holding': return 'Blocked';
    case 'lowering': return 'Setup';
    default: return 'Working'; // engage_in / receiving / engage_out / discharging
  }
}

type Axis = 'X' | 'Z';

interface ChainTransferLocal {
  zNode: Object3D | null;
  xNode: Object3D | null;
  liftNode: Object3D | null;
  sensorNode: Object3D | null;

  zBelt: RV.BeltHandle | null;
  lift: RV.DriveHandle | null;

  sensorOccupied: boolean;
  partCount: number;

  state: State;
  clearTimer: number;
  refreshTimer: number;

  connections: PortConnection[];
  /** snap.id of the X-branch connection (the convchain port), or null. */
  branchSnapId: string | null;
  /** +1 → Transport-X forward jog moves goods toward the branch; -1 → reverse. */
  forwardGoesToBranch: number;

  /** snap.id of the input port currently being received from (for openInputPort). */
  selectedInputId: string | null;
  /** Axis currently engaged for receive / dispatch. */
  inAxis: Axis | null;
  outAxis: Axis | null;

  // DES bookkeeping (minimal passthrough+overflow).
  timer: TransitTimer | null;
  transitMUs: Map<number, number>;
  blockedMUs: RV.MU[];

  _xDir: Vector3;
  _v: Vector3;
  _pos: Vector3;
  _center: Vector3;
}

type ChainTransferSelf = RV.Self<ChainTransferLocal, typeof SIGNALS>;

interface ComponentRegistryShape {
  findInChildren<T = unknown>(node: Object3D, type: string): T | null;
}
interface TransportSurfaceLike {
  getWorldDirection(out?: Vector3): Vector3;
}

// ── Node finders (suffix-tolerant: glTF `_N` dedup + Unity `(N)` duplicates) ──
const baseName = (name: string): string =>
  name.replace(/\s*\(\d+\)\s*$/, '').replace(/_\d+$/, '');

const findTransportAxis = (root: Object3D, axis: 'X' | 'Z'): Object3D | null =>
  findFirst(root, (n) => parseTransportName(baseName(n.name)) === `+${axis}`);

const findLinearYDrive = (root: Object3D): Object3D | null =>
  findFirst(root, (n) => parseDriveName(baseName(n.name)) === 'LinearY');

const componentRegistry = (self: ChainTransferSelf): ComponentRegistryShape | null => {
  const r = (self.viewer as { registry?: unknown }).registry as Partial<ComponentRegistryShape> | undefined | null;
  return r && typeof r.findInChildren === 'function' ? (r as ComponentRegistryShape) : null;
};

const numProp = (self: ChainTransferSelf, key: string, fallback: number): number => {
  const v = self.prop[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const liftHeight = (self: ChainTransferSelf): number =>
  numProp(self, 'LiftHeight', CONFIG.defaultLiftHeight);

// ── Belts ──
// X chain is bidirectional — BeltHandle.run can only jog forward/stop, so drive it
// directly. dir>0 → toward the branch; dir<0 → toward the centre.
const runX = (self: ChainTransferSelf, dir: number): void => {
  const xNode = self.local.xNode;
  if (!xNode) return;
  const d = self.drive(xNode);
  if (!d) return;
  d.jogForward = dir > 0;
  d.jogBackward = dir < 0;
};

const stopBelts = (self: ChainTransferSelf): void => {
  self.local.zBelt?.run(false);
  runX(self, 0);
};

// ── Per-port Occupied interlock (mirrors the Turntable) ──
const portOccupiedSignal = (id: string): string => `${FLOW_OCCUPIED}@${id}`;
const blockAllInputs = (self: ChainTransferSelf): void => {
  for (const c of self.local.connections) self.signals.set(portOccupiedSignal(c.snap.id), true);
};
// Open exactly one port (Occupied=false) so its upstream conveyor PUSHES the pallet
// across the surface gap; block all the others.
const openInputPort = (self: ChainTransferSelf, openId: string | null): void => {
  for (const c of self.local.connections) self.signals.set(portOccupiedSignal(c.snap.id), c.snap.id !== openId);
};

// "Is the UPSTREAM neighbour waiting (has a good for me)?" — its root Occupied.
const occupiedRoot = (self: ChainTransferSelf, root: Object3D): boolean =>
  self.signals.get(flowOccupiedRootSignal(root.name)) === true;

// "Can the DOWNSTREAM across `conn` accept?" — read its PER-PORT Occupied first,
// falling back to its root. This is essential against a downstream turntable /
// chaintransfer, which goes root-"busy" the moment it starts receiving FROM us
// (a mutual-busy deadlock) yet OPENS this exact port (Occupied=false) to accept.
// Matches the conveyor interlock (transport-links makeLink.occupied()).
const downstreamOccupied = (self: ChainTransferSelf, conn: PortConnection): boolean => {
  const rootSig = flowOccupiedRootSignal(conn.ownerRoot.name);
  const perPort = `${rootSig}@${conn.pairedSnap.id}`;
  const v = self.signals.get(perPort);
  return (v !== undefined ? v : self.signals.get(rootSig)) === true;
};

// ── Ports ──
const isX = (l: ChainTransferLocal, c: PortConnection): boolean => c.snap.id === l.branchSnapId;
// X is bidirectional (geometric role from the neighbour); Z is fixed (authored flow).
const roleOf = (l: ChainTransferLocal, c: PortConnection): 'input' | 'output' =>
  isX(l, c) ? c.role : (c.snap.flow === 'out' ? 'output' : 'input');
const axisOf = (l: ChainTransferLocal, c: PortConnection): Axis => (isX(l, c) ? 'X' : 'Z');
const connFor = (l: ChainTransferLocal, id: string | null): PortConnection | null =>
  id == null ? null : (l.connections.find(c => c.snap.id === id) ?? null);

const inputsList = (l: ChainTransferLocal): PortConnection[] => l.connections.filter(c => roleOf(l, c) === 'input');
const outputsList = (l: ChainTransferLocal): PortConnection[] => l.connections.filter(c => roleOf(l, c) === 'output');

/** The X branch connection, if any (single convchain port). */
const xConn = (l: ChainTransferLocal): PortConnection | null => connFor(l, l.branchSnapId);
/** The Z output connection (convroll, role output), if connected. */
const zOutConn = (l: ChainTransferLocal): PortConnection | null =>
  outputsList(l).find(c => !isX(l, c)) ?? null;

// ── Lift engagement (replaces the Turntable's rotation) ──
const engage = (self: ChainTransferSelf, axis: Axis): void => {
  self.local.lift?.moveTo(axis === 'X' ? liftHeight(self) : 0);
};

/** Run the belt of `axis`. `towardPort`=false → toward the centre (receive);
 *  true → toward the port (dispatch). Z is fixed-direction (always forward). */
const runByAxis = (self: ChainTransferSelf, axis: Axis, towardPort: boolean): void => {
  const l = self.local;
  if (axis === 'Z') {
    runX(self, 0);
    l.zBelt?.run(true);
  } else {
    l.zBelt?.run(false);
    runX(self, towardPort ? l.forwardGoesToBranch : -l.forwardGoesToBranch);
  }
};

// Gated runtime diagnostics: set `window.__rvDiagCT = true` in the console.
const dbg = (self: ChainTransferSelf, msg: string, extra?: Record<string, unknown>): void => {
  if (typeof window === 'undefined' || !(window as unknown as Record<string, unknown>).__rvDiagCT) return;
  // eslint-disable-next-line no-console
  console.log(`[CT ${self.root.name}] ${msg}`, extra ?? '');
};

const setState = (self: ChainTransferSelf, next: State): void => {
  if (next !== self.local.state) dbg(self, `${self.local.state} → ${next}`);
  self.local.state = next;
  self.setState(next);
  self.statState(chainCat(next)); // utilization category (both modes, de-duped)
};

/**
 * Recompute the snap topology, the X-branch id (geometric — the connection
 * aligned with the Transport-X axis), and the sign mapping X forward jog to
 * "toward the branch".
 */
const refreshTopology = (self: ChainTransferSelf): void => {
  const l = self.local;
  l.connections = classifyConnections(self.viewer as { getPlugin?(id: string): unknown }, self.root);
  l.branchSnapId = null;
  if (!l.xNode || l.connections.length === 0) return;

  const reg = componentRegistry(self);
  const xSurf = reg ? reg.findInChildren<TransportSurfaceLike>(l.xNode, 'TransportSurface') : null;
  if (!xSurf) return;
  xSurf.getWorldDirection(l._xDir).normalize();
  self.root.getWorldPosition(l._center);

  let best = -1;
  for (const c of l.connections) {
    c.snap.object3D.getWorldPosition(l._pos);
    l._v.copy(l._pos).sub(l._center);
    if (l._v.lengthSq() < 1e-6) continue;
    const align = Math.abs(l._v.normalize().dot(l._xDir));
    if (align > best) { best = align; l.branchSnapId = c.snap.id; }
  }
  if (best < 0.5) { l.branchSnapId = null; return; } // no clear X-aligned port

  const branch = connFor(l, l.branchSnapId);
  if (branch) {
    branch.snap.object3D.getWorldPosition(l._pos);
    l._v.copy(l._pos).sub(l._center);
    const proj = l._xDir.dot(l._v);
    if (Math.abs(proj) > 1e-4) l.forwardGoesToBranch = proj > 0 ? 1 : -1;
  }
};

// ── FSM transitions (mirror the Turntable) ──
const tryReceive = (self: ChainTransferSelf): void => {
  const l = self.local;
  if (l.state !== 'idle' || !self.sig.Run.get()) return;
  const ins = inputsList(l);
  const ready = ins.filter(c => occupiedRoot(self, c.ownerRoot));
  if (ready.length === 0) {
    if (ins.length > 0) dbg(self, 'tryReceive: inputs present but none waiting', {
      inputs: ins.map(c => ({ owner: c.ownerRoot.name, axis: axisOf(l, c), upstreamOccupied: occupiedRoot(self, c.ownerRoot) })),
    });
    return;
  }
  const chosen = ready[0];
  l.selectedInputId = chosen.snap.id;
  l.inAxis = axisOf(l, chosen);
  dbg(self, 'receive from', { owner: chosen.ownerRoot.name, axis: l.inAxis });
  engage(self, l.inAxis);
  setState(self, 'engage_in');
};

/**
 * Decide the output AXIS for the held pallet and engage the lift for it.
 *   • Z is a valid target only when a Z-out successor is CONNECTED and can
 *     accept — otherwise the belt would just shove the good off a dead end.
 *   • If Z can't take it, DIVERT to a free X branch (overflow). A good that
 *     arrived on X can't go back out X, so it has no divert.
 *   • If neither route is open, drop the good onto the rolls (lower) and HOLD —
 *     it waits at the centre, belts stopped (back-pressure), until a route opens.
 */
const tryDispatch = (self: ChainTransferSelf): void => {
  const l = self.local;
  const zOut = zOutConn(l);
  const canZ = !!zOut && !downstreamOccupied(self, zOut); // connected AND can accept
  const x = xConn(l);
  const xIsFreeOutput = !!x && roleOf(l, x) === 'output' && !downstreamOccupied(self, x);
  dbg(self, 'tryDispatch', {
    inAxis: l.inAxis, canZ, zOut: zOut?.ownerRoot.name ?? null,
    zOutOccupied: zOut ? downstreamOccupied(self, zOut) : null,
    xIsFreeOutput, xOwner: x?.ownerRoot.name ?? null,
  });

  let target: Axis;
  if (canZ) {
    target = 'Z';                       // straight / merge onto a free successor
  } else if (l.inAxis !== 'X' && xIsFreeOutput) {
    target = 'X';                       // overflow divert (Z dead-end or blocked)
  } else {
    // No open route — rest the good on the rolls and wait.
    stopBelts(self);
    engage(self, 'Z'); // lower onto the rolls (no-op if already down)
    setState(self, 'holding');
    return;
  }

  l.outAxis = target;
  stopBelts(self);
  engage(self, target);
  setState(self, 'engage_out');
};

const onPartAtCenter = (self: ChainTransferSelf): void => {
  blockAllInputs(self);
  stopBelts(self);
  tryDispatch(self);
};

/**
 * Restore the chain transfer to its freshly-loaded start — used by BOTH the
 * `'simulation-reset'` hook and the context-menu "Reset". Stops both belts,
 * lowers the lift to neutral (Z engaged), re-blocks every input, clears the FSM,
 * part counter, timers and routing bookkeeping, then returns to `idle`. The lift
 * Drive itself also snaps to its StartPosition via `RVDrive.reset()`.
 */
function resetChainTransfer(self: ChainTransferSelf): void {
  const l = self.local;
  stopBelts(self);
  l.lift?.moveTo(0);
  blockAllInputs(self);
  l.selectedInputId = null;
  l.inAxis = null;
  l.outAxis = null;
  l.sensorOccupied = false;
  l.partCount = 0;
  l.clearTimer = 0;
  l.refreshTimer = CONFIG.topologyRefreshSec;
  l.transitMUs.clear();
  l.blockedMUs.length = 0;
  self.sig.PartCount.set(0);
  setState(self, 'idle');
}

const def = {
  type: 'ChainTransfer' as const,
  kind: 'router' as const,
  description: 'Chain transfer that lifts parts and moves them 90° sideways to a parallel line.',
  mcpDocs:
    'Right-angle transfer / merge-diverge unit. A part arrives on the roller direction; chains ' +
    'lift it and move it perpendicular (left or right) onto an adjacent conveyor. convroll snaps ' +
    'on the through and the transfer sides. Use it to split or merge between two parallel ' +
    'conveyor lines (lighter than a Turntable for a simple 90° hand-off). LiftHeight is config.',
  models: ['*ChainTransfer*'],

  schema: {
    LiftHeight: { type: 'number' as const, default: CONFIG.defaultLiftHeight },
  },

  signalNamespace: 'Flow' as const,
  signals: SIGNALS,

  state: (): ChainTransferLocal => ({
    zNode: null, xNode: null, liftNode: null, sensorNode: null,
    zBelt: null, lift: null,
    sensorOccupied: false, partCount: 0,
    state: 'idle', clearTimer: 0, refreshTimer: CONFIG.topologyRefreshSec,
    connections: [], branchSnapId: null, forwardGoesToBranch: 1,
    selectedInputId: null, inAxis: null, outAxis: null,
    timer: null, transitMUs: new Map(), blockedMUs: [],
    _xDir: new Vector3(1, 0, 0), _v: new Vector3(), _pos: new Vector3(), _center: new Vector3(),
  }),

  // Mode-agnostic init: resolve the two transports, the lift and the single sensor.
  setup(self: ChainTransferSelf): void {
    const l = self.local;
    l.zNode = findTransportAxis(self.root, 'Z');
    l.xNode = findTransportAxis(self.root, 'X');
    l.liftNode = findLinearYDrive(self.root);
    l.sensorNode = findSensor(self.root);
    if (!l.zNode)      return self.disable('no Transport-Z node');
    if (!l.xNode)      return self.disable('no Transport-X node');
    if (!l.liftNode)   return self.disable('no Drive-Lin-Y (lift) node');
    if (!l.sensorNode) return self.disable('no Sensor node');

    // Reset transient state (setup re-runs on Reset-on-Switch / DESRunner.start()).
    l.sensorOccupied = false;
    l.state = 'idle';
    l.clearTimer = 0;
    l.selectedInputId = null;
    l.inAxis = null;
    l.outAxis = null;
    l.transitMUs.clear();
    l.blockedMUs.length = 0;

    self.sig.Run.set(true);
    self.setState('idle');
    self.statState('Empty'); // reset baseline (both modes)
    self.stamp('ChainTransferBehavior', {
      TransportZ: l.zNode.name, TransportX: l.xNode.name,
      Lift: l.liftNode.name, Sensor: l.sensorNode.name,
    });
    l.timer = createTransitTimer(self, l.zNode);

    self.contextMenu(l.zNode, [
      { id: 'reset', label: 'Reset', action: () => resetChainTransfer(self) },
    ]);
  },

  // Lifecycle: restore the FSM/lift/counters to the start on reset, and re-assert
  // the Run signal on start so the unit resumes routing after a reset.
  reset(self: ChainTransferSelf): void {
    resetChainTransfer(self);
  },
  start(self: ChainTransferSelf): void {
    self.sig.Run.set(true);
  },

  continuous: {
    setup(self: ChainTransferSelf): void {
      const l = self.local;
      l.zBelt = self.attachBelt(l.zNode!);
      l.lift = self.attachDrive(l.liftNode!);
      l.lift.moveTo(0); // start lowered (Z engaged)
      refreshTopology(self);

      // Block every own port up front so neighbours never see us as free until
      // we open exactly one input to receive.
      for (const sp of listOwnSnaps(self.viewer as { getPlugin?(id: string): unknown }, self.root)) {
        self.signals.set(portOccupiedSignal(sp.id), true);
      }

      self.onSensorChanged(l.sensorNode!, (present) => {
        if (present && !l.sensorOccupied) self.sig.PartCount.set(++l.partCount);
        l.sensorOccupied = present;
        if (present && l.state === 'receiving') onPartAtCenter(self);
        // Discharge completion is surface-based (good fully off the unit), not
        // sensor-based — see the 'discharging' case in fixedUpdate.
      });
    },

    fixedUpdate(self: ChainTransferSelf, dt: number): void {
      const l = self.local;
      if (!l.zBelt || !l.lift) return;

      l.refreshTimer += dt;
      if (l.refreshTimer >= CONFIG.topologyRefreshSec) {
        l.refreshTimer = 0;
        refreshTopology(self);
      }

      self.sig.Occupied.set(l.state !== 'idle' || self.surfaceOccupied(l.zNode!) || self.surfaceOccupied(l.xNode!));
      self.sig.Running.set(l.state !== 'idle');

      switch (l.state) {
        case 'idle':
          stopBelts(self);
          blockAllInputs(self);
          tryReceive(self);
          break;

        case 'engage_in':
          if (l.lift.isAtTarget() && l.inAxis) {
            openInputPort(self, l.selectedInputId); // upstream pushes across the gap
            runByAxis(self, l.inAxis, false);       // run toward the centre
            setState(self, 'receiving');
          }
          break;

        case 'receiving':
          if (l.inAxis) runByAxis(self, l.inAxis, false); // keep pulling until sensor hits
          break;

        case 'holding':
          stopBelts(self);
          tryDispatch(self); // retry until Z-out frees / a route opens
          break;

        case 'engage_out':
          if (l.lift.isAtTarget() && l.outAxis) {
            runByAxis(self, l.outAxis, true);       // run toward the output
            setState(self, 'discharging');
          }
          break;

        case 'discharging': {
          if (l.outAxis) runByAxis(self, l.outAxis, true); // keep running
          // Done only when the good has FULLY left our output surface (i.e. it is
          // fully on the successor) — keeps the chains UP and running through the
          // whole transfer so a roll→chain divert never drops the good early.
          const outNode = l.outAxis === 'X' ? l.xNode : l.zNode;
          if (outNode && !self.surfaceOccupied(outNode)) {
            l.clearTimer += dt; // small grace so a brief flicker doesn't lower early
            if (l.clearTimer >= CONFIG.dischargeClearSec) {
              l.clearTimer = 0;
              stopBelts(self);
              engage(self, 'Z'); // return the lift to neutral (no-op for a Z exit)
              setState(self, 'lowering');
            }
          } else {
            l.clearTimer = 0;
          }
          break;
        }

        case 'lowering':
          if (l.lift.isAtTarget()) {
            l.selectedInputId = null;
            l.inAxis = null;
            l.outAxis = null;
            setState(self, 'idle');
          }
          break;
      }
    },
  },

  // Minimal DES: behave like a single-zone conveyor that releases to the first
  // FREE output (a blocked Z output naturally overflows onto the branch). The
  // rich receive→route lift sequence is continuous-first.
  des: {
    // onAccept samples the MU's LIVE position for its transit tween endpoints
    // (transit-timing leadingEdge) — keep the per-event-time tween settle
    // active while a chain-transfer instance exists (plan-262 Phase 2).
    samplesLiveGeometry: true,
    onAccept(self: ChainTransferSelf, mu: RV.MU): boolean {
      const l = self.local;
      l.transitMUs.set(mu.id, self.in(l.timer!.transitTime, 'Arrival', mu, l.timer!.tween(mu)));
      return true;
    },
    onArrival(self: ChainTransferSelf, mu: RV.MU): void {
      self.local.transitMUs.delete(mu.id);
      releaseDes(self, mu);
    },
    onDownstreamReady(self: ChainTransferSelf): void {
      const mu = self.local.blockedMUs.shift();
      if (mu) releaseDes(self, mu);
    },
  },
};

/** DES release: prefer the first free output; park on back-pressure. */
function releaseDes(self: ChainTransferSelf, mu: RV.MU): void {
  const out = self.freeOutputs(mu)[0];
  if (out && self.downstreamCanAccept(mu, out)) {
    self.transfer(mu, out);
  } else {
    self.local.blockedMUs.push(mu);
  }
}

/** ChainTransfer — right-angle chain transfer (factory-built). */
const ChainTransferBehavior = defineLibraryComponent(def);

/** The material-flow definition — for DES tests / runner. */
export const ChainTransferFlow = def;

export default ChainTransferBehavior;
