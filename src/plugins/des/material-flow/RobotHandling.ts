// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * RobotHandling.ts -- DES-only transactional robot loading station.
 *
 * Pick candidates are resolved exclusively from the logical MU hierarchy. A
 * cycle owns one persisted downstream reservation and commits the complete
 * batch at its safe transition.
 */

import type { Object3D } from 'three';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../../core/material-flow/define-material-flow';
import type {
  FrozenDescriptor,
  JsonValue,
  MaterialFlowSelf,
  MU,
  MuRef,
  Port,
  SignalShape,
} from '../../../core/material-flow/material-flow-self';
import { DES } from '../rv-des-api';
import type { DESManager } from '../rv-des-manager';
import type { DESMU } from '../rv-des-mu';
import {
  freeCarrierSlots,
  topmostPickable,
} from '../rv-des-component';
import { MaterialFlowAdapter } from '../material-flow-adapter';
import { RVRobotIK } from '../../../core/engine/rv-robot-ik';
import { RVIKTarget } from '../../../core/engine/rv-ik-target';
import { validateAxisPos } from '../../../core/engine/rv-axis-angle-utils';
import {
  attachMuToTcp,
  buildAxesTween,
  detachMuFromTcp,
  snapToPose,
  type TcpAttachment,
} from '../../../behaviors/_shared/robot-ik-des';
import {
  claimAxes,
  releaseAxes,
  type AxisOwner,
} from '../../../core/engine/rv-axis-ownership';

const SIGNALS = {
  Busy: 'PLCOutputBool',
  PartCount: 'PLCOutputInt',
} as const satisfies SignalShape;

type RobotMode = 'unload' | 'load' | 'transfer';
export type RobotTargetKey = 'home' | 'pick' | 'place' | 'approachPick' | 'approachPlace';

export interface RobotHandlingTimingConfig {
  readonly timePerPick: number;
  readonly timePerCycle: number;
  readonly moveTimeToPick?: number;
  readonly moveTimePickToPlace?: number;
  readonly moveTimeToHome?: number;
  readonly moveTimeLoadedFactor?: number;
}

interface RobotCycleWindow {
  at0: number;
  at1: number;
  targetKey: RobotTargetKey;
}

interface ActiveAttachment {
  attachment: TcpAttachment;
  targetParent: Object3D | null;
}

interface RobotHandlingLocal {
  mode: RobotMode;
  batchSize: number;
  timePerPick: number;
  timePerCycle: number;
  pickFilter: string;
  removeEmptyCarriers: boolean;
  maxWaitTime: number;
  moveTimeToPick?: number;
  moveTimePickToPlace?: number;
  moveTimeToHome?: number;
  moveTimeLoadedFactor: number;
  robot: RVRobotIK | null;
  waypoints: Partial<Record<RobotTargetKey, RVIKTarget>>;
  axisOwner: AxisOwner;
  attachments: ActiveAttachment[];
  warnedMaterialize: boolean;
}

interface RobotCycle {
  reservationId: number;
  n: number;
  muRefs: MuRef[];
  cycleStart: number;
  windows: RobotCycleWindow[];
}

interface CyclePayload {
  phase: 'cycle';
  reservationId: number;
  n: number;
}

interface WaitPayload {
  phase: 'wait';
  token: number;
}

interface OutputTarget {
  target: MaterialFlowAdapter;
  port: Port;
}

type RobotPayload = CyclePayload | WaitPayload;
type RobotHandlingSelf = MaterialFlowSelf<RobotHandlingLocal, typeof SIGNALS>;

interface ComponentLookup {
  getByPath<T>(type: string, path: string): T | null;
  getPathForNode?(node: Object3D): string | null;
}

function numberProp(self: RobotHandlingSelf, key: string): number {
  const value = self.prop[key];
  return typeof value === 'number' ? value : Number.NaN;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`RobotHandling: ${name} must be finite and non-negative`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`RobotHandling: ${name} must be a positive integer`);
  }
  return value;
}

function optionalPositive(self: RobotHandlingSelf, key: string): number | undefined {
  const value = self.prop[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`RobotHandling: ${key} must be finite and greater than zero`);
  }
  return value;
}

function optionalPath(self: RobotHandlingSelf, key: string): string | undefined {
  const value = self.prop[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`RobotHandling: ${key} must be a component path`);
  const path = value.trim();
  return path || undefined;
}

function componentRegistry(self: RobotHandlingSelf): ComponentLookup | null {
  const registry = (self.viewer as { registry?: unknown } | null)?.registry;
  return registry && typeof (registry as ComponentLookup).getByPath === 'function'
    ? registry as ComponentLookup
    : null;
}

function resolveComponent<T>(
  registry: ComponentLookup,
  type: string,
  path: string,
  expected: new (...args: never[]) => T,
  field: string,
): T {
  const value = registry.getByPath<T>(type, path);
  if (!(value instanceof expected)) {
    throw new Error(`RobotHandling: ${field} '${path}' does not resolve to ${type}`);
  }
  return value;
}

/** The only RobotHandling event-duration calculation, shared by IK and fallback. */
export function cycleDuration(config: RobotHandlingTimingConfig, n: number): number {
  const count = Math.max(0, Math.floor(n));
  const legacy = config.timePerCycle + count * config.timePerPick;
  if (
    config.moveTimeToPick === undefined
    && config.moveTimePickToPlace === undefined
    && config.moveTimeToHome === undefined
  ) return legacy;

  const factor = config.moveTimeLoadedFactor ?? 1;
  const toPick = config.moveTimeToPick ?? config.timePerCycle * 0.5;
  const pickToPlace = (config.moveTimePickToPlace ?? config.timePerPick) * factor;
  const toHome = config.moveTimeToHome ?? config.timePerCycle * 0.5;
  return toPick + count * pickToPlace + toHome;
}

function timingParts(config: RobotHandlingTimingConfig): {
  toPick: number;
  pickToPlace: number;
  toHome: number;
} {
  const explicit = config.moveTimeToPick !== undefined
    || config.moveTimePickToPlace !== undefined
    || config.moveTimeToHome !== undefined;
  if (!explicit) {
    return {
      toPick: config.timePerCycle * 0.5,
      pickToPlace: config.timePerPick,
      toHome: config.timePerCycle * 0.5,
    };
  }
  return {
    toPick: config.moveTimeToPick ?? config.timePerCycle * 0.5,
    pickToPlace: (config.moveTimePickToPlace ?? config.timePerPick)
      * (config.moveTimeLoadedFactor ?? 1),
    toHome: config.moveTimeToHome ?? config.timePerCycle * 0.5,
  };
}

function buildWindows(self: RobotHandlingSelf, n: number, duration: number): RobotCycleWindow[] {
  const parts = timingParts(self.local);
  const windows: RobotCycleWindow[] = [];
  let elapsed = 0;
  const append = (targetKey: RobotTargetKey, seconds: number): void => {
    const at0 = duration > 0 ? elapsed / duration : 0;
    elapsed += seconds;
    const at1 = duration > 0 ? elapsed / duration : 0;
    windows.push({ at0, at1, targetKey });
  };

  const reverse = self.local.mode === 'load';
  const first = reverse ? 'place' : 'pick';
  const second = reverse ? 'pick' : 'place';
  const firstApproach = reverse ? 'approachPlace' : 'approachPick';
  const secondApproach = reverse ? 'approachPick' : 'approachPlace';

  append(self.local.waypoints[firstApproach] ? firstApproach : first, parts.toPick);
  for (let i = 0; i < n; i++) {
    append(first, parts.pickToPlace * 0.5);
    append(second, parts.pickToPlace * 0.5);
  }
  append(self.local.waypoints[secondApproach] ? secondApproach : second, parts.toHome * 0.5);
  append('home', parts.toHome * 0.5);
  return windows;
}

function bindIk(self: RobotHandlingSelf): void {
  releaseAxes(self.local.axisOwner);
  self.local.robot = null;
  self.local.waypoints = {};
  self.local.attachments.length = 0;

  const robotPath = optionalPath(self, 'robotRef');
  if (!robotPath) return;
  const registry = componentRegistry(self);
  if (!registry) throw new Error('RobotHandling: component registry is unavailable for robotRef');

  const robot = resolveComponent(registry, 'RobotIK', robotPath, RVRobotIK, 'robotRef');
  const required: Array<[RobotTargetKey, string]> = [
    ['home', 'waypointHome'],
    ['pick', 'waypointPick'],
    ['place', 'waypointPlace'],
  ];
  const optional: Array<[RobotTargetKey, string]> = [
    ['approachPick', 'waypointApproachPick'],
    ['approachPlace', 'waypointApproachPlace'],
  ];
  const drives = robot.getAxisDrives();
  if (drives.length === 0) throw new Error('RobotHandling: robotRef has no axis drives');
  for (const [key, field] of required) {
    const path = optionalPath(self, field);
    if (!path) throw new Error(`RobotHandling: ${field} is required when robotRef is set`);
    const target = resolveComponent(registry, 'IKTarget', path, RVIKTarget, field);
    if (!validateAxisPos(target.AxisPos, drives.length)) {
      throw new Error(`RobotHandling: ${field} AxisPos must contain ${drives.length} finite values`);
    }
    self.local.waypoints[key] = target;
  }
  for (const [key, field] of optional) {
    const path = optionalPath(self, field);
    if (!path) continue;
    const target = resolveComponent(registry, 'IKTarget', path, RVIKTarget, field);
    if (!validateAxisPos(target.AxisPos, drives.length)) {
      throw new Error(`RobotHandling: ${field} AxisPos must contain ${drives.length} finite values`);
    }
    self.local.waypoints[key] = target;
  }
  self.local.robot = robot;
}

function detachVisuals(self: RobotHandlingSelf): void {
  for (const active of self.local.attachments) {
    detachMuFromTcp(active.attachment, active.targetParent);
  }
  self.local.attachments.length = 0;
}

function attachVisuals(
  self: RobotHandlingSelf,
  candidates: readonly DESMU[],
  targetParent: Object3D | null,
): void {
  const robot = self.local.robot;
  if (!robot) return;
  const materialize = ownAdapter(self)?.materializeMu;
  if (!materialize) {
    if (!self.local.warnedMaterialize) {
      self.local.warnedMaterialize = true;
      console.warn('RobotHandling: MU materialization is unavailable; using time-only fallback');
    }
    return;
  }
  for (const mu of candidates) {
    const result = materialize(mu as unknown as MU);
    if (!result.ok) {
      if (!self.local.warnedMaterialize) {
        self.local.warnedMaterialize = true;
        console.warn(`RobotHandling: MU ${mu.id} is not materializable (${result.reason}); using time-only fallback`);
      }
      continue;
    }
    const attachment = attachMuToTcp(robot, result.visual);
    if (attachment) self.local.attachments.push({ attachment, targetParent });
  }
}

function targetForWindow(self: RobotHandlingSelf, window: RobotCycleWindow): RVIKTarget | null {
  return self.local.waypoints[window.targetKey] ?? null;
}

function snapWindow(self: RobotHandlingSelf, window: RobotCycleWindow | undefined): void {
  const robot = self.local.robot;
  const target = window ? targetForWindow(self, window) : null;
  if (robot && target) snapToPose(robot, target.AxisPos);
}

function restoreIk(self: RobotHandlingSelf): void {
  releaseAxes(self.local.axisOwner);
  const currentCycle = cycle(self);
  const robot = self.local.robot;
  if (!currentCycle || !robot) {
    restoreSignals(self);
    return;
  }
  claimAxes(robot.getAxisDrives(), self.local.axisOwner);
  const duration = cycleDuration(self.local, currentCycle.n);
  const progress = duration > 0
    ? Math.min(1, Math.max(0, (self.now - currentCycle.cycleStart) / duration))
    : 1;
  let selected = currentCycle.windows[0];
  for (const window of currentCycle.windows) {
    if (progress < window.at0) break;
    selected = window;
    if (progress <= window.at1) break;
  }
  snapWindow(self, selected);
  restoreSignals(self);
}

function finishIk(self: RobotHandlingSelf, currentCycle: RobotCycle): void {
  snapWindow(self, currentCycle.windows[currentCycle.windows.length - 1]);
  detachVisuals(self);
  releaseAxes(self.local.axisOwner);
}

function manager(): DESManager | null {
  return DES.getManager();
}

function ownAdapter(self: RobotHandlingSelf): MaterialFlowAdapter | null {
  const current = manager();
  if (!current) return null;
  for (let i = 0; i < current.componentCount; i++) {
    const component = current.getComponentByEntityId(i);
    if (
      component instanceof MaterialFlowAdapter
      && component.self as unknown === self as unknown
    ) return component;
  }
  return null;
}

function adapterForNode(node: object): MaterialFlowAdapter | null {
  const current = manager();
  if (!current) return null;
  for (let i = 0; i < current.componentCount; i++) {
    const component = current.getComponentByEntityId(i);
    if (component instanceof MaterialFlowAdapter && component.node === node) return component;
  }
  return null;
}

function portLooksEmpty(port: Port): boolean {
  return `${port.id} ${port.snapNode?.name ?? ''}`.toLowerCase().includes('empty');
}

function targetLooksEmpty(target: MaterialFlowAdapter): boolean {
  return `${target.node.name} ${target.componentType}`.toLowerCase().includes('empty');
}

function syntheticPort(target: MaterialFlowAdapter, empty: boolean): Port {
  return {
    id: empty ? 'empty' : 'out',
    role: 'output',
    ownerRoot: target.node,
    ownerComponent: target,
  } as unknown as Port;
}

function outputTarget(self: RobotHandlingSelf, empty: boolean): OutputTarget | null {
  const adapter = ownAdapter(self);
  if (!adapter) return null;
  const outputs = self.outputs();
  const port = outputs.find((candidate) => portLooksEmpty(candidate) === empty);
  if (port) {
    const target = adapter.nextComponents.find(
      (candidate): candidate is MaterialFlowAdapter => (
        candidate instanceof MaterialFlowAdapter && candidate.node === port.ownerRoot
      ),
    ) ?? adapterForNode(port.ownerRoot);
    if (target) return { target, port };
  }

  const candidates = adapter.nextComponents.filter(
    (candidate): candidate is MaterialFlowAdapter => candidate instanceof MaterialFlowAdapter,
  );
  const target = empty
    ? candidates.find(targetLooksEmpty) ?? candidates[1]
    : candidates.find((candidate) => !targetLooksEmpty(candidate)) ?? candidates[0];
  return target ? { target, port: syntheticPort(target, empty) } : null;
}

function isCarrier(mu: DESMU): boolean {
  return mu.carrierCapacity !== undefined
    || mu.carrierType === 'pallet'
    || mu.carrierType === 'blister'
    || mu.carrierType === 'carrier';
}

function isEmptyCarrier(mu: DESMU): boolean {
  return isCarrier(mu) && mu.childMUs.length === 0;
}

function rootMUs(self: RobotHandlingSelf): DESMU[] {
  return (self.mus as ReadonlyArray<DESMU>).filter((mu) => mu.parentMU === null);
}

function collectCandidates(
  self: RobotHandlingSelf,
  limit: number,
  emptyCarriers: boolean,
): DESMU[] {
  const current = manager();
  if (!current || limit <= 0) return [];
  const result: DESMU[] = [];
  const selected = new Set<string>();
  const filter = (candidate: DESMU): boolean => {
    const key = `${candidate.id}:${candidate.generation}`;
    if (selected.has(key)) return false;
    if (emptyCarriers) return isEmptyCarrier(candidate);
    if (isEmptyCarrier(candidate)) return false;
    return self.local.pickFilter === '' || candidate.carrierType === self.local.pickFilter;
  };

  for (const root of rootMUs(self)) {
    while (result.length < limit) {
      const candidate = topmostPickable(root, current, filter);
      if (!candidate) break;
      result.push(candidate);
      selected.add(`${candidate.id}:${candidate.generation}`);
    }
    if (result.length >= limit) break;
  }
  return result;
}

function findCarrierRecursive(mu: DESMU, current: DESManager): DESMU | null {
  for (let i = mu.childMUs.length - 1; i >= 0; i--) {
    const child = current.getMUByRef(mu.childMUs[i]) as DESMU | null;
    if (!child) continue;
    const nested = findCarrierRecursive(child, current);
    if (nested) return nested;
  }
  if (!isCarrier(mu)) return null;
  const ref = { id: mu.id, gen: mu.generation };
  return freeCarrierSlots(mu) - current.reservedForCarrier(ref) > 0 ? mu : null;
}

function findLoadCarrier(target: MaterialFlowAdapter): DESMU | null {
  const current = manager();
  if (!current) return null;
  const roots = target.heldMUs.filter((mu) => mu.parentMU === null);
  for (let i = roots.length - 1; i >= 0; i--) {
    const carrier = findCarrierRecursive(roots[i], current);
    if (carrier) return carrier;
  }
  return null;
}

function cycle(self: RobotHandlingSelf): RobotCycle | null {
  const value = self.prop.cycle as unknown;
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RobotCycle>;
  return typeof candidate.reservationId === 'number'
    && typeof candidate.n === 'number'
    && Array.isArray(candidate.muRefs)
    ? candidate as RobotCycle
    : null;
}

function setBusy(self: RobotHandlingSelf, busy: boolean): void {
  self.sig.Busy.set(busy);
}

function updatePartCount(self: RobotHandlingSelf): void {
  self.sig.PartCount.set(collectCandidates(self, Number.MAX_SAFE_INTEGER, false).length);
}

function invalidateWait(self: RobotHandlingSelf): void {
  const token = typeof self.prop.waitToken === 'number' ? self.prop.waitToken : 0;
  self.prop.waitToken = token + 1;
  self.prop.waitScheduled = false;
  self.prop.waitingSince = null;
}

function schedulePartialWait(self: RobotHandlingSelf): void {
  if (self.prop.waitScheduled === true) return;
  const waitingSince = typeof self.prop.waitingSince === 'number'
    ? self.prop.waitingSince
    : self.now;
  self.prop.waitingSince = waitingSince;
  const token = (typeof self.prop.waitToken === 'number' ? self.prop.waitToken : 0) + 1;
  self.prop.waitToken = token;
  self.prop.waitScheduled = true;
  const delay = Math.max(0, waitingSince + self.local.maxWaitTime - self.now);
  self.in(delay, 'ProcessComplete', null, { phase: 'wait', token } satisfies WaitPayload);
  self.setState('Waiting');
  self.statState('Empty');
}

function startBatch(
  self: RobotHandlingSelf,
  candidates: readonly DESMU[],
  emptyCarriers: boolean,
): boolean {
  const output = outputTarget(self, emptyCarriers);
  if (!output) return false;

  let carrier: DESMU | null = null;
  let carrierCapacity = Number.POSITIVE_INFINITY;
  if (self.local.mode === 'load' && !emptyCarriers) {
    carrier = findLoadCarrier(output.target);
    if (!carrier) return false;
    const current = manager()!;
    carrierCapacity = freeCarrierSlots(carrier) - current.reservedForCarrier({
      id: carrier.id,
      gen: carrier.generation,
    });
  }

  const n = Math.min(
    self.local.batchSize,
    candidates.length,
    self.downstreamFreeCapacity(output.port),
    carrierCapacity,
  );
  if (!Number.isFinite(n) && candidates.length === 0) return false;
  const batchSize = Math.floor(n);
  if (batchSize <= 0) return false;
  const batch = candidates.slice(0, batchSize);

  const duration = cycleDuration(self.local, batchSize);
  const windows = buildWindows(self, batchSize, duration);
  let reservation: ReturnType<RobotHandlingSelf['reserveDownstream']> | null = null;
  try {
    reservation = self.reserveDownstream(
      batchSize,
      output.port,
      carrier ? {
        ref: { id: carrier.id, gen: carrier.generation },
        slots: batchSize,
      } : undefined,
    );
    const currentCycle: RobotCycle = {
      reservationId: reservation.record.id,
      n: batchSize,
      muRefs: batch.map((mu) => ({ id: mu.id, gen: mu.generation })),
      cycleStart: self.now,
      windows,
    };
    let eventData: CyclePayload & { tween?: unknown } = {
      phase: 'cycle',
      reservationId: currentCycle.reservationId,
      n: batchSize,
    };
    const robot = self.local.robot;
    if (robot) {
      claimAxes(robot.getAxisDrives(), self.local.axisOwner);
      const registry = componentRegistry(self);
      const phases = windows.map((window) => ({
        at0: window.at0,
        at1: window.at1,
        targetAxisPos: targetForWindow(self, window)!.AxisPos,
      }));
      if (duration > 0) {
        const drives = robot.getAxisDrives();
        const tween = buildAxesTween(
          robot,
          self.local.waypoints.home!.AxisPos,
          duration,
          {
            phases,
            anchorRef: registry?.getPathForNode?.(robot.node) ?? robotPath(robot.node),
            driveRefs: drives.map((drive) => (
              registry?.getPathForNode?.(drive.node) ?? robotPath(drive.node)
            )),
          },
        );
        eventData = { ...eventData, tween: tween.tween };
      } else {
        snapWindow(self, windows[windows.length - 1]);
      }
      attachVisuals(self, batch, output.target.node);
    }
    self.prop.cycle = currentCycle as unknown as JsonValue;
    invalidateWait(self);
    setBusy(self, true);
    self.setState('Working');
    self.statState('Working');
    self.statCycleStart();
    self.in(duration, 'ProcessComplete', null, eventData);
    return true;
  } catch (error) {
    detachVisuals(self);
    releaseAxes(self.local.axisOwner);
    reservation?.rollback();
    self.prop.cycle = null;
    console.warn(`RobotHandling: cycle start rejected (${String(error)})`);
    return false;
  }
}

function tryStart(self: RobotHandlingSelf): void {
  if (cycle(self) || self.prop.failurePending === true) return;
  updatePartCount(self);
  const candidates = collectCandidates(self, self.local.batchSize, false);

  if (candidates.length === 0) {
    invalidateWait(self);
    const emptyCandidates = self.local.mode === 'unload'
      ? collectCandidates(self, self.local.batchSize, true)
      : [];
    if (emptyCandidates.length > 0) {
      if (self.local.removeEmptyCarriers && startBatch(self, emptyCandidates, true)) return;
      self.setState('Blocked');
      self.statState('Blocked');
      return;
    }
    self.setState(self.currentLoad > 0 ? 'Idle' : 'Empty');
    self.statState(self.currentLoad > 0 ? 'Empty' : 'Empty');
    return;
  }

  if (candidates.length < self.local.batchSize && self.local.maxWaitTime > 0) {
    const waitingSince = typeof self.prop.waitingSince === 'number'
      ? self.prop.waitingSince
      : self.now;
    self.prop.waitingSince = waitingSince;
    if (self.now < waitingSince + self.local.maxWaitTime) {
      schedulePartialWait(self);
      return;
    }
  }

  if (startBatch(self, candidates, false)) return;
  self.setState('Blocked');
  self.statState('Blocked');
}

function resolveCycleMUs(currentCycle: RobotCycle): DESMU[] {
  const current = manager();
  if (!current) return [];
  const result: DESMU[] = [];
  for (const ref of currentCycle.muRefs) {
    const mu = current.getMUByRef(ref) as DESMU | null;
    if (mu) result.push(mu);
  }
  return result;
}

function completeCycle(self: RobotHandlingSelf, payload: CyclePayload): void {
  const currentCycle = cycle(self);
  if (
    !currentCycle
    || currentCycle.reservationId !== payload.reservationId
    || currentCycle.n !== payload.n
  ) return;

  finishIk(self, currentCycle);
  const reservation = self.reservation(currentCycle.reservationId);
  const mus = resolveCycleMUs(currentCycle);
  const committed = mus.length === currentCycle.n && reservation?.commitMany(mus) === true;
  if (!committed) reservation?.rollback();

  self.prop.cycle = null;
  setBusy(self, false);
  self.statCycleEnd();
  if (committed) self.statOutput(currentCycle.n);
  updatePartCount(self);

  if (self.prop.failurePending === true) {
    self.setState('Failure');
    self.statState('Failure');
    return;
  }
  if (!committed) {
    self.setState('Blocked');
    self.statState('Blocked');
  }
  tryStart(self);
}

function restoreSignals(self: RobotHandlingSelf): void {
  setBusy(self, cycle(self) !== null);
  updatePartCount(self);
}

function robotPath(node: Object3D): string {
  const parts: string[] = [];
  let current: Object3D | null = node;
  while (current) {
    if (current.name) parts.unshift(current.name);
    current = current.parent;
  }
  return parts.join('/');
}

export const RobotHandling: MaterialFlowDefinition<RobotHandlingSelf, typeof SIGNALS> =
  defineMaterialFlow<RobotHandlingSelf, typeof SIGNALS>({
    type: 'RobotHandling',
    kind: 'station',
    models: ['*RobotHandling*'],
    description: 'Moves logical MU hierarchy batches with atomic downstream reservations.',
    schema: {
      mode: {
        type: 'enum',
        default: 'unload',
        enumMap: { unload: 'unload', load: 'load', transfer: 'transfer' },
      },
      batchSize: { type: 'number', default: 1 },
      timePerPick: { type: 'number', default: 0 },
      timePerCycle: { type: 'number', default: 0 },
      pickFilter: { type: 'string', default: '' },
      removeEmptyCarriers: { type: 'boolean', default: true },
      maxWaitTime: { type: 'number', default: 0 },
      robotRef: { type: 'componentRef' },
      waypointHome: { type: 'componentRef' },
      waypointPick: { type: 'componentRef' },
      waypointPlace: { type: 'componentRef' },
      waypointApproachPick: { type: 'componentRef' },
      waypointApproachPlace: { type: 'componentRef' },
      moveTimeToPick: { type: 'number' },
      moveTimePickToPlace: { type: 'number' },
      moveTimeToHome: { type: 'number' },
      moveTimeLoadedFactor: { type: 'number', default: 1 },
    },
    signals: SIGNALS,
    state: (): RobotHandlingLocal => ({
      mode: 'unload',
      batchSize: 1,
      timePerPick: 0,
      timePerCycle: 0,
      pickFilter: '',
      removeEmptyCarriers: true,
      maxWaitTime: 0,
      moveTimeToPick: undefined,
      moveTimePickToPlace: undefined,
      moveTimeToHome: undefined,
      moveTimeLoadedFactor: 1,
      robot: null,
      waypoints: {},
      axisOwner: { type: 'RobotHandling' },
      attachments: [],
      warnedMaterialize: false,
    }),
    capacity: (self): number => self.local.batchSize,

    setup(self): void {
      const mode = self.prop.mode;
      if (mode !== 'unload' && mode !== 'load' && mode !== 'transfer') {
        throw new Error("RobotHandling: mode must be 'unload', 'load', or 'transfer'");
      }
      self.local.mode = mode;
      self.local.batchSize = positiveInteger(numberProp(self, 'batchSize'), 'batchSize');
      self.local.timePerPick = nonNegative(numberProp(self, 'timePerPick'), 'timePerPick');
      self.local.timePerCycle = nonNegative(numberProp(self, 'timePerCycle'), 'timePerCycle');
      self.local.maxWaitTime = nonNegative(numberProp(self, 'maxWaitTime'), 'maxWaitTime');
      self.local.moveTimeToPick = optionalPositive(self, 'moveTimeToPick');
      self.local.moveTimePickToPlace = optionalPositive(self, 'moveTimePickToPlace');
      self.local.moveTimeToHome = optionalPositive(self, 'moveTimeToHome');
      self.local.moveTimeLoadedFactor = optionalPositive(self, 'moveTimeLoadedFactor') ?? 1;
      if (typeof self.prop.pickFilter !== 'string') {
        throw new Error('RobotHandling: pickFilter must be a string');
      }
      if (typeof self.prop.removeEmptyCarriers !== 'boolean') {
        throw new Error('RobotHandling: removeEmptyCarriers must be a boolean');
      }
      self.local.pickFilter = self.prop.pickFilter.trim();
      self.local.removeEmptyCarriers = self.prop.removeEmptyCarriers;
      bindIk(self);
      self.prop.cycle = null;
      self.prop.waitingSince = null;
      self.prop.waitScheduled = false;
      self.prop.waitToken = 0;
      self.prop.failurePending = false;
      setBusy(self, false);
      self.sig.PartCount.set(0);
      self.setState('Empty');
      self.statState('Empty');
    },

    continuous: {},

    des: {
      onRestore(self): void {
        restoreIk(self);
      },

      onFastForwardExit(self): void {
        const currentCycle = cycle(self);
        if (!currentCycle || !self.local.robot) return;
        snapWindow(self, currentCycle.windows[currentCycle.windows.length - 1]);
        detachVisuals(self);
      },

      canAccept(self): boolean {
        return cycle(self) === null && self.prop.failurePending !== true;
      },

      onAccept(self): boolean {
        tryStart(self);
        return true;
      },

      onProcessComplete(self, _mu, data): void {
        const payload = data as RobotPayload | null;
        if (payload?.phase === 'cycle') {
          completeCycle(self, payload);
          return;
        }
        if (payload?.phase === 'wait' && payload.token === self.prop.waitToken) {
          self.prop.waitScheduled = false;
          tryStart(self);
        }
      },

      onDownstreamReady(self): void {
        tryStart(self);
      },

      onFreeze(self, frozen): void {
        self.prop.failurePending = true;
        const currentCycle = cycle(self);
        if (!currentCycle) {
          setBusy(self, false);
          self.setState('Failure');
          self.statState('Failure');
          return;
        }

        for (let i = frozen.length - 1; i >= 0; i--) {
          const descriptor = frozen[i];
          const payload = descriptor.payload as RobotPayload | null;
          if (
            payload?.phase === 'cycle'
            && payload.reservationId === currentCycle.reservationId
          ) {
            self.in(descriptor.remaining, 'ProcessComplete', null, descriptor.payload);
            frozen.splice(i, 1);
          }
        }
        setBusy(self, true);
        self.setState('Working');
        self.statState('Working');
      },

      onResume(self, _frozen: FrozenDescriptor[]): void {
        self.prop.failurePending = false;
        if (cycle(self)) {
          setBusy(self, true);
          self.setState('Working');
          self.statState('Working');
          return;
        }
        setBusy(self, false);
        tryStart(self);
      },
    },
  });

export default RobotHandling;
