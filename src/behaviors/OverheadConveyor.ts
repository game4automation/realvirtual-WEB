// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * OverheadConveyor — a circulating chain system (overhead / power-and-free
 * conveyor, plan-268 Phase 4, F8).
 *
 * ONE chain phase scalar `s_chain` drives N carriers on a CLOSED `RVPath`
 * (rv_extras.Path with `closed: true`): carrier `i` sits at the arc-length
 * position `(s_chain + i·pitch) mod L`. The chain speed uses the DRIVE's ramp
 * (`computeRampedSpeed`, rv-drive.ts — the exact same ramp the Agv uses, not
 * re-invented); no per-carrier state, no traffic — the chain is rigid.
 *
 * Carrier binding (Phase-4 decision): carriers are the convention-named nodes
 * `Carrier` / `Carrier-<id>` in the component subtree, discovered via
 * `self.findAll('carrier')` (NODE_KIND_TESTS.carrier — same name-convention
 * table as Transport/Sensor). The `requires` block is NOT used because it
 * injects only the FIRST match while carriers are inherently plural. The DFS
 * traversal order of `findAll` fixes the deterministic pitch index `i`.
 *
 * Carrier pose (plan-268 §5.1 — loop twist / Frenet flip): hanging carriers
 * are GRAVITY-ORIENTED — up is the path's align axis (world axis, default
 * (0,1,0)) and only the YAW comes from the tangent: the tangent is flattened
 * against the up axis before `lookRotation(flatTangent, up)` (rv-pose-align).
 * A vertical tangent (flattening degenerates) keeps the carrier's previous
 * orientation — no roll, no Frenet flip anywhere on the loop. Poses are
 * applied in the carrier's LOCAL frame under the identity-parent assumption
 * (same Phase-1 convention as the Agv; nested-parent world→local conversion
 * is a documented follow-up).
 *
 * Degenerate cases (no NaN, no crash): `L == 0` → phase stays 0, carriers sit
 * at the path start; `N == 0` → the instance disables at setup; `pitch <= 0`
 * (incl. the default 0) → automatic even distribution `L / N`.
 *
 * Accumulating FREE trolleys (power-and-free with a signed gap clamp) are a
 * documented FOLLOW-UP, not part of this component: they need per-carrier
 * travelers instead of the one chain scalar — the Phase-2 SpacingController
 * closed-wrap is ready to be reused for that.
 *
 * DELIBERATELY NO `des` BLOCK (plan-268 Phase 3 decision): a rigid circulating
 * chain has no discrete arrival events to model — the closed loop never routes,
 * never blocks and never ends, so there is no `L/v` leg to schedule and nothing
 * a Blockade-Reschedule could act on. Discretising the one continuous phase
 * scalar would add events without adding model value. In a DES scene the chain
 * simply does not advance (it is presentation, not material flow) — DES-visible
 * behaviour arrives with the free-trolley follow-up above, which has real
 * per-carrier arrival/accumulation events (and would then reuse the Agv's
 * `path`-tween + reschedule pattern).
 *
 * Signals (F9 pattern, as far as meaningful for a chain):
 * `OverheadConveyor.Run` (command), `.Moving`, `.Position` (chain phase in mm,
 * drive parity). When PLC-wired (`self.isWired`) the internal simulation stays
 * silent — live values are authoritative.
 *
 * No GC in the tick: all pose temps are pre-allocated.
 */

import { Quaternion, Vector3 } from 'three';
import { defineLibraryComponent, type RV } from './_shared/behavior-kit';
import { pathFromNode, type RVPath } from '../core/engine/rv-path';
import { getDefaultPathNetwork } from '../core/engine/rv-path-network';
import { computeRampedSpeed } from '../core/engine/rv-drive';
import { lookRotation } from '../core/engine/rv-pose-align';
import type { Object3D } from 'three';

// PLC contract — auto-declared as `OverheadConveyor.<key>` with typed
// `self.sig.<key>` accessors (Run = command in, status out — F9 pattern).
const SIGNALS = {
  Run:      'PLCInputBool',
  Moving:   'PLCOutputBool',
  Position: 'PLCOutputFloat', // chain phase s_chain in mm (drive parity)
} as const;

// Schema defaults (stamped as OverheadConveyorBehavior inspector rows).
const DEFAULTS = {
  TargetSpeed: 500,      // mm/s — chain speed (drive parity)
  Acceleration: 250,     // mm/s²
  UseAcceleration: true,
  PathId: '',
  Pitch: 0,              // mm — carrier spacing; <= 0 → automatic L/N
  StartPhase: 0,         // mm — initial chain phase (deterministic reset seed)
} as const;

interface OverheadLocal {
  path: RVPath | null;
  carriers: Object3D[];
  /** The ONE chain phase scalar, in METERS on the closed path. */
  sChainM: number;
  /** Current chain speed in mm/s (drive ramp output). */
  v: number;
  pitchM: number;
  startPhaseM: number;
  targetSpeed: number;     // mm/s
  acceleration: number;    // mm/s²
  useAcceleration: boolean;
  // Pre-allocated pose temps — no GC in the tick.
  _pos: Vector3;
  _tan: Vector3;
  _flat: Vector3;
  _up: Vector3;
  _quat: Quaternion;
}

type OverheadSelf = RV.Self<OverheadLocal, typeof SIGNALS>;

// ── Config (rv_extras bag, defensive `?? default`) ──────────────────────────

function configBag(self: OverheadSelf): Record<string, unknown> {
  const rv = (self.root.userData?.realvirtual ?? {}) as Record<string, unknown>;
  return {
    ...((rv['OverheadConveyorBehavior'] as Record<string, unknown> | undefined) ?? {}),
    ...((rv['OverheadConveyor'] as Record<string, unknown> | undefined) ?? {}),
  };
}

function cfgNumber(bag: Record<string, unknown>, key: string, def: number): number {
  const n = Number(bag[key]);
  return Number.isFinite(n) ? n : def;
}

// ── Shared helpers (logic layer) ────────────────────────────────────────────

/** Wrap an arc-length phase onto `[0, L)` — `L <= 0` collapses to 0 (no NaN). */
function wrapPhase(meters: number, L: number): number {
  if (!(L > 0)) return 0;
  const m = meters % L;
  return m < 0 ? m + L : m;
}

/**
 * Place every carrier at `(s_chain + i·pitch) mod L`, gravity-oriented:
 * up = the path's align axis, only the yaw comes from the (flattened) tangent.
 * A degenerate flattened tangent (vertical travel) keeps the carrier's
 * previous orientation — never a roll, never a Frenet flip (plan-268 §5.1).
 */
function applyPoses(self: OverheadSelf): void {
  const l = self.local;
  const p = l.path;
  if (!p) return;
  const n = l.carriers.length;
  for (let i = 0; i < n; i++) {
    const carrier = l.carriers[i];
    const si = wrapPhase(l.sChainM + i * l.pitchM, p.length);
    p.getAbsPosition(si, l._pos);
    p.getAbsDirection(si, l._tan);
    // Gravity-oriented: strip the up component from the tangent (yaw only).
    l._flat.copy(l._tan).addScaledVector(l._up, -l._tan.dot(l._up));
    if (l._flat.lengthSq() >= 1e-12) {
      lookRotation(l._flat, l._up, l._quat);
      carrier.quaternion.copy(l._quat);
    }
    // Identity-parent assumption (Phase-1 convention, see module JSDoc).
    carrier.position.copy(l._pos);
  }
}

const def = {
  type: 'OverheadConveyor' as const,
  kind: 'conveyor' as const,
  description: 'Circulating overhead-conveyor chain: N carriers on a closed rv_extras.Path.',
  mcpDocs:
    'Circulating chain system (plan-268 Phase 4). ONE chain phase scalar moves N carriers on a ' +
    'CLOSED rv_extras.Path at (s_chain + i*pitch) mod L. Carriers are the Carrier/Carrier-<id> ' +
    'convention nodes under the root (DFS order = pitch index). PathId selects a registered ' +
    'path (else the first Path node under the root). Speed/ramp come from TargetSpeed/' +
    'Acceleration (mm/s, mm/s2 — drive parity). Pitch in mm (<= 0 = automatic even L/N ' +
    'distribution); StartPhase in mm seeds the chain deterministically. Carriers hang gravity-' +
    'oriented (up = path align axis, yaw from the tangent — no roll on the loop). Signals: ' +
    'OverheadConveyor.Run (command), .Moving, .Position (chain phase in mm).',
  models: ['*OverheadConveyor*'],
  schema: {
    TargetSpeed:     { type: 'number' as const, default: DEFAULTS.TargetSpeed },
    Acceleration:    { type: 'number' as const, default: DEFAULTS.Acceleration },
    UseAcceleration: { type: 'boolean' as const, default: DEFAULTS.UseAcceleration },
    PathId:          { type: 'string' as const, default: DEFAULTS.PathId },
    Pitch:           { type: 'number' as const, default: DEFAULTS.Pitch },
    StartPhase:      { type: 'number' as const, default: DEFAULTS.StartPhase },
  },

  signals: SIGNALS,

  state: (): OverheadLocal => ({
    path: null,
    carriers: [],
    sChainM: 0,
    v: 0,
    pitchM: 0,
    startPhaseM: 0,
    targetSpeed: DEFAULTS.TargetSpeed,
    acceleration: DEFAULTS.Acceleration,
    useAcceleration: DEFAULTS.UseAcceleration,
    _pos: new Vector3(),
    _tan: new Vector3(),
    _flat: new Vector3(),
    _up: new Vector3(0, 1, 0),
    _quat: new Quaternion(),
  }),

  logic: { applyPoses },

  // Mode-agnostic init: resolve the closed path, bind the carrier nodes.
  setup(self: OverheadSelf): void {
    const l = self.local;
    const bag = configBag(self);
    l.targetSpeed = cfgNumber(bag, 'TargetSpeed', DEFAULTS.TargetSpeed);
    l.acceleration = cfgNumber(bag, 'Acceleration', DEFAULTS.Acceleration);
    l.useAcceleration = bag['UseAcceleration'] !== undefined
      ? bag['UseAcceleration'] === true
      : DEFAULTS.UseAcceleration;
    const pathId = typeof bag['PathId'] === 'string' ? (bag['PathId'] as string) : DEFAULTS.PathId;
    const pitchMm = cfgNumber(bag, 'Pitch', DEFAULTS.Pitch);
    const startPhaseMm = cfgNumber(bag, 'StartPhase', DEFAULTS.StartPhase);

    // Path resolution — same convention as the Agv: PathId → shared network;
    // else the first rv_extras.Path node under the root (payload-detected).
    const net = getDefaultPathNetwork();
    let path: RVPath | null = pathId ? net.get(pathId) : null;
    if (!path) {
      const node = self.find('path');
      if (node) {
        path = pathFromNode(node);
        if (path && !net.get(path.id)) net.register(path);
      }
    }
    if (!path) return self.disable('no rv_extras.Path found (PathId or a Path node under the root)');
    if (!path.closed) {
      console.warn(
        `[OverheadConveyor] path '${path.id}' is not closed — circulating anyway ` +
          '(phase wraps mod L; carriers jump from the end to the start).',
      );
    }

    // Carrier binding (Phase-4 decision, see module JSDoc): all Carrier/
    // Carrier-<id> convention nodes under the root, in DFS traversal order.
    const carriers = self.findAll('carrier');
    if (carriers.length === 0) {
      return self.disable('no Carrier/Carrier-<id> nodes under the root');
    }
    l.carriers = carriers;
    l.path = path;
    l._up.copy(path.align).normalize();

    // Pitch: explicit (> 0) in mm, else automatic even distribution L/N.
    // Degenerate inputs (pitch 0, L 0) never produce NaN — see wrapPhase.
    l.pitchM = pitchMm > 0
      ? pitchMm / 1000
      : (path.length > 0 ? path.length / carriers.length : 0);
    l.startPhaseM = wrapPhase(startPhaseMm / 1000, path.length);
    l.sChainM = l.startPhaseM;
    l.v = 0;

    // The chain runs unless told to stop (a live CONNECT source owns Run when bound).
    if (!self.isWired) self.sig.Run.set(true);
    self.stamp('OverheadConveyorBehavior', { Path: path.id, Carriers: carriers.length });
    applyPoses(self);

    self.contextMenu(self.root, [
      { id: 'run',  label: 'Run',  action: () => self.sig.Run.set(true) },
      { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
        action: () => self.sig.Run.set(false) },
    ]);
  },

  reset(self: OverheadSelf): void {
    const l = self.local;
    l.sChainM = l.startPhaseM;
    l.v = 0;
    if (l.path) applyPoses(self);
    self.sig.Moving.set(false);
    self.sig.Position.set(l.startPhaseM * 1000);
  },
  start(self: OverheadSelf): void {
    if (!self.isWired) self.sig.Run.set(true);
  },

  continuous: {
    fixedUpdate(self: OverheadSelf, dt: number): void {
      const l = self.local;
      if (!l.path) return;
      if (self.isWired) return;          // an interface controls the chain → stay silent

      const run = self.sig.Run.get() === true;
      const target = run ? l.targetSpeed : 0;
      // The DRIVE's ramp (computeRampedSpeed IS RVDrive.update's ramp). A loop
      // has no positional stop — the remaining distance is unbounded.
      l.v = computeRampedSpeed(
        l.v, target, l.acceleration, l.useAcceleration, Number.POSITIVE_INFINITY, dt,
      );
      l.sChainM = wrapPhase(l.sChainM + (l.v / 1000) * dt, l.path.length);
      applyPoses(self);

      self.sig.Moving.set(Math.abs(l.v) > 1e-3);
      self.sig.Position.set(l.sChainM * 1000); // mm — drive parity
    },
  },
};

/** OverheadConveyor — circulating chain (factory-built; behaviour identical to the def). */
const OverheadConveyorBehavior = defineLibraryComponent(def);

/** The material-flow definition (schema + logic + continuous) — for tests. */
export const OverheadConveyorFlow = def;

export default OverheadConveyorBehavior;
