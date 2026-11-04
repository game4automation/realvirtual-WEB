// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * IndexingConveyor.ts -- DES-only fixed-cell indexing conveyor.
 *
 * One ProcessComplete event advances every occupied slot synchronously. The
 * slot map lives in self.prop, while resolved carrier positions remain derived
 * local state and are rebuilt when the simulation starts.
 */

import { Vector3 } from 'three';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../../core/material-flow/define-material-flow';
import type {
  MaterialFlowSelf,
  MU,
  MuRef,
  SignalShape,
  TweenSpec,
} from '../../../core/material-flow/material-flow-self';

const SIGNALS = {
  FreeSlots: 'PLCOutputInt',
  Indexing: 'PLCOutputBool',
} as const satisfies SignalShape;

type Phase = 'idle' | 'index' | 'dwell';
type Slot = MuRef | null;

interface IndexingLocal {
  slotCount: number;
  pitchMm: number;
  speedMmPerSecond: number;
  dwellTime: number;
  reportFreeAt: number;
  indexTime: number;
  /** N slot positions plus one output position for the exiting MU. */
  positions: Array<[number, number, number]>;
}

type IndexingSelf = MaterialFlowSelf<IndexingLocal, typeof SIGNALS>;

interface IndexPayload {
  phase: 'index';
  tweens: TweenSpec['tween'][];
}

interface PhasePayload {
  phase: 'dwell' | 'barrier';
}

const _world = new Vector3();
const _axis = new Vector3();
const _local = new Vector3();

function numeric(self: IndexingSelf, key: string): number {
  const value = self.prop[key];
  return typeof value === 'number' ? value : Number.NaN;
}

function integer(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`IndexingConveyor: ${name} must be a positive integer`);
  }
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`IndexingConveyor: ${name} must be greater than zero`);
  }
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`IndexingConveyor: ${name} must be finite and non-negative`);
  }
  return value;
}

function phase(self: IndexingSelf): Phase {
  const value = self.prop.phase;
  return value === 'index' || value === 'dwell' ? value : 'idle';
}

function slots(self: IndexingSelf): Slot[] {
  return self.prop.slots as unknown as Slot[];
}

function muRef(mu: MU): MuRef {
  return { id: mu.id, gen: mu.generation ?? 0 };
}

function resolveMU(self: IndexingSelf, ref: MuRef | null): MU | null {
  if (!ref) return null;
  return self.mus.find((mu) => mu.id === ref.id && (mu.generation ?? 0) === ref.gen) ?? null;
}

function setVisualPosition(mu: MU, position: readonly [number, number, number]): void {
  const target = mu.visual as { setPosition?: (value: Vector3) => void } | null | undefined;
  if (!target?.setPosition) return;
  _world.set(position[0], position[1], position[2]);
  target.setPosition(_world);
}

function buildPositions(self: IndexingSelf): Array<[number, number, number]> {
  const local = self.local;
  const carriers = self.findAll('carrier');
  const out: Array<[number, number, number]> = [];
  self.root.updateWorldMatrix(true, false);

  if (carriers.length >= local.slotCount) {
    for (let i = 0; i < local.slotCount; i++) {
      carriers[i].getWorldPosition(_world);
      out.push([_world.x, _world.y, _world.z]);
    }
  } else {
    const centre = (local.slotCount - 1) * 0.5;
    for (let i = 0; i < local.slotCount; i++) {
      _local.set((i - centre) * local.pitchMm * 0.001, 0, 0);
      self.root.localToWorld(_local);
      out.push([_local.x, _local.y, _local.z]);
    }
  }

  _axis.set(1, 0, 0).transformDirection(self.root.matrixWorld).multiplyScalar(local.pitchMm * 0.001);
  const last = out[out.length - 1];
  out.push([last[0] + _axis.x, last[1] + _axis.y, last[2] + _axis.z]);
  return out;
}

function updateAvailability(self: IndexingSelf): void {
  const free = slots(self).reduce((count, slot) => count + (slot === null ? 1 : 0), 0);
  self.prop.freeCount = free;
  self.prop.isFree = free >= self.local.reportFreeAt;
  self.sig.FreeSlots.set(free);
}

function setPhase(self: IndexingSelf, next: Phase): void {
  self.prop.phase = next;
  self.sig.Indexing.set(next === 'index');
  self.setState(
    next === 'index'
      ? 'Indexing'
      : next === 'dwell'
        ? (self.prop.processingActive === true ? 'Processing' : 'Dwell')
        : 'Idle',
  );
}

function attachedProcessingTime(self: IndexingSelf): number {
  const value = self.prop.attachedProcessingTime;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function makeTweens(self: IndexingSelf): TweenSpec['tween'][] {
  const result: TweenSpec['tween'][] = [];
  const currentSlots = slots(self);
  for (let i = 0; i < currentSlots.length; i++) {
    const mu = resolveMU(self, currentSlots[i]);
    if (!mu) continue;
    result.push({
      kind: 'position',
      target: null,
      muId: mu.id,
      from: self.local.positions[i],
      to: self.local.positions[i + 1],
    });
  }
  return result;
}

function reserveExit(self: IndexingSelf): boolean {
  const exitRef = slots(self)[self.local.slotCount - 1];
  if (!exitRef) return true;
  const exitMU = resolveMU(self, exitRef);
  if (!exitMU) {
    slots(self)[self.local.slotCount - 1] = null;
    updateAvailability(self);
    return true;
  }
  if (typeof self.prop.exitReservationId === 'number') return true;
  try {
    self.prop.exitReservationId = self.reserveDownstream(1).record.id;
    return true;
  } catch {
    self.setState('Blocked');
    self.statState('Blocked');
    return false;
  }
}

function scheduleIndex(self: IndexingSelf): void {
  if (phase(self) !== 'idle') return;
  if (self.reservedLoad > 0) {
    self.setState('Blocked');
    self.statState('Blocked');
    return;
  }
  if (slots(self).every((slot) => slot === null)) {
    self.setState('Empty');
    self.statState('Empty');
    return;
  }
  if (!reserveExit(self)) return;

  setPhase(self, 'index');
  self.statState('Working');
  self.statCycleStart();
  const payload: IndexPayload = { phase: 'index', tweens: makeTweens(self) };
  self.in(self.local.indexTime, 'ProcessComplete', null, payload);
}

function finalizeExit(self: IndexingSelf): boolean {
  const pending = self.prop.pendingExit as unknown as MuRef | null;
  if (!pending) return true;
  const mu = resolveMU(self, pending);
  const reservationId = self.prop.exitReservationId;
  if (!mu || typeof reservationId !== 'number') return false;
  const reservation = self.reservation(reservationId);
  if (!reservation?.commitMany([mu])) return false;
  self.prop.pendingExit = null;
  self.prop.exitReservationId = null;
  return true;
}

function completeCycle(self: IndexingSelf): void {
  self.prop.completedCycles = (typeof self.prop.completedCycles === 'number'
    ? self.prop.completedCycles
    : 0) + 1;
  self.statCycleEnd();
  self.prop.processingActive = false;
  setPhase(self, 'idle');
  self.statState(self.currentLoad > 0 ? 'Working' : 'Empty');
  self.in(0, 'ProcessComplete', null, { phase: 'barrier' } satisfies PhasePayload);
}

function completeIndex(self: IndexingSelf): void {
  if (phase(self) !== 'index') return;
  const currentSlots = slots(self);
  const exiting = currentSlots[currentSlots.length - 1];
  for (let i = currentSlots.length - 1; i > 0; i--) currentSlots[i] = currentSlots[i - 1];
  currentSlots[0] = null;
  self.prop.pendingExit = exiting ? { id: exiting.id, gen: exiting.gen } : null;
  updateAvailability(self);

  const processingTime = attachedProcessingTime(self);
  const effectiveDwell = Math.max(self.local.dwellTime, processingTime);
  self.prop.effectiveDwellTime = effectiveDwell;
  self.prop.processingActive = processingTime > 0;
  if (effectiveDwell > 0) {
    setPhase(self, 'dwell');
    self.statState('Working');
    self.in(effectiveDwell, 'ProcessComplete', null, { phase: 'dwell' } satisfies PhasePayload);
    return;
  }
  if (!finalizeExit(self)) {
    setPhase(self, 'idle');
    self.setState('Blocked');
    self.statState('Blocked');
    return;
  }
  completeCycle(self);
}

function completeDwell(self: IndexingSelf): void {
  if (phase(self) !== 'dwell') return;
  if (!finalizeExit(self)) {
    setPhase(self, 'idle');
    self.setState('Blocked');
    self.statState('Blocked');
    return;
  }
  completeCycle(self);
}

export const IndexingConveyor: MaterialFlowDefinition<IndexingSelf, typeof SIGNALS> =
  defineMaterialFlow<IndexingSelf, typeof SIGNALS>({
    type: 'IndexingConveyor',
    kind: 'conveyor',
    models: ['*IndexingConveyor*'],
    processingAttachmentPoint: 'cycle-dwell',
    description: 'Advances fixed conveyor slots synchronously at a configured pitch and dwell.',
    schema: {
      slotCount: { type: 'number', default: 4 },
      pitch: { type: 'number', default: 250 },
      speed: { type: 'number', default: 250 },
      dwellTime: { type: 'number', default: 0 },
      reportFreeAt: { type: 'number', default: 1 },
    },
    signals: SIGNALS,
    state: (): IndexingLocal => ({
      slotCount: 4,
      pitchMm: 250,
      speedMmPerSecond: 250,
      dwellTime: 0,
      reportFreeAt: 1,
      indexTime: 1,
      positions: [],
    }),
    capacity: (self): number => self.local.slotCount,

    setup(self): void {
      const local = self.local;
      local.slotCount = integer(numeric(self, 'slotCount'), 'slotCount');
      local.pitchMm = positive(numeric(self, 'pitch'), 'pitch');
      local.speedMmPerSecond = positive(numeric(self, 'speed'), 'speed');
      local.dwellTime = nonNegative(numeric(self, 'dwellTime'), 'dwellTime');
      local.reportFreeAt = integer(numeric(self, 'reportFreeAt'), 'reportFreeAt');
      if (local.reportFreeAt > local.slotCount) {
        throw new Error('IndexingConveyor: reportFreeAt must not exceed slotCount');
      }
      local.indexTime = local.pitchMm / local.speedMmPerSecond;
      local.positions = buildPositions(self);
      self.prop.slots = Array.from({ length: local.slotCount }, () => null);
      self.prop.phase = 'idle';
      self.prop.pendingExit = null;
      self.prop.exitReservationId = null;
      self.prop.completedCycles = 0;
      self.prop.processingActive = false;
      self.prop.effectiveDwellTime = local.dwellTime;
      updateAvailability(self);
      self.sig.Indexing.set(false);
      self.setState('Empty');
      self.statState('Empty');
    },

    continuous: {},

    des: {
      canAccept(self): boolean {
        return phase(self) !== 'index' && slots(self)[0] === null;
      },

      onAccept(self, mu): boolean {
        if (slots(self)[0] !== null) return false;
        slots(self)[0] = muRef(mu);
        setVisualPosition(mu, self.local.positions[0]);
        updateAvailability(self);
        if (phase(self) === 'idle') scheduleIndex(self);
        return true;
      },

      onProcessComplete(self, _mu, data): void {
        const payload = data as IndexPayload | PhasePayload | null;
        if (payload?.phase === 'index') completeIndex(self);
        else if (payload?.phase === 'dwell') completeDwell(self);
        else if (payload?.phase === 'barrier') scheduleIndex(self);
      },

      onDownstreamReady(self): void {
        if (phase(self) !== 'idle') return;
        if (self.prop.pendingExit) {
          if (finalizeExit(self)) completeCycle(self);
          return;
        }
        scheduleIndex(self);
      },

      onFreeze(self): void {
        self.sig.Indexing.set(false);
        self.setState('Failure');
        self.statState('Failure');
      },

      onResume(self): void {
        const restoredPhase = phase(self);
        self.sig.Indexing.set(restoredPhase === 'index');
        self.setState(
          restoredPhase === 'index'
            ? 'Indexing'
            : restoredPhase === 'dwell'
              ? (self.prop.processingActive === true ? 'Processing' : 'Dwell')
              : 'Idle',
        );
        self.statState(restoredPhase === 'idle' ? (self.currentLoad > 0 ? 'Working' : 'Empty') : 'Working');
      },
    },
  });

export default IndexingConveyor;
