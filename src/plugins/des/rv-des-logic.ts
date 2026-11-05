// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVLogicEngine } from '../../core/engine/rv-logic-engine';
import type { CoreSubsystemsHost, DriveLike } from '../../core/engine/rv-core-subsystems';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import { isActiveForState } from '../../core/engine/rv-active-only';
import {
  RVDelay, RVDriveTo, RVEnable, RVGripPick, RVGripPlace, RVJumpOnSignal, RVSerialContainer, RVWaitForDrivesAtTarget,
  RVWaitForSensor, RVWaitForSignalBool, RVWaitForSignalFloat, RVWaitForZone, StepState,
  type RVLogicStep,
} from '../../core/engine/rv-logic-step';
import { nextUp, type EventParticipant, type SimEventFacade } from '../../core/sim-event-facade';
import { addArrivedListener } from './rv-des-core-takt';
import { logicCyclePolled, logicSteps } from './rv-des-logic-check';
import { logicColdReset } from './rv-des-logic-snapshot';
import { addGripHeldListener } from './rv-des-grip-snapshot';

export interface LogicRun { lastEval: number }
export interface LogicEventParticipant extends EventParticipant {
  run: LogicRun;
  reattachWakeListeners(): void;
  dispose(): void;
}

// Run keys include private step fields; snapshot ownership is declared separately.
const delayDue = (startT: number, duration: number, t: number): boolean => t - startT >= duration;
const stateKeys = ['state', 'reason', 'currentIndex', 'completedCycles', 'cycleStartTime', 'cycleTimes',
  'finishedCount', 'elapsed', 'startT', 'duration', '_edgePrev', '_edgeSeen', 'destination',
  'startPosition', 'targetPosition', '_commandedTarget', 'value', 'runId', '_ownsPath', '_cancelled'] as const;

function signature(steps: readonly RVLogicStep[], root: RVLogicStep): string {
  let value = '';
  const runtime = root.rootContext as unknown as { active?: boolean; want?: boolean; suppressed?: boolean } | null;
  value += `${runtime?.active},${runtime?.want},${runtime?.suppressed};`;
  for (const step of steps) {
    const fields = step as unknown as Record<string, unknown>;
    for (const key of stateKeys) if (key in fields) {
      const field = fields[key];
      // Cycle history only appends or clears during evaluation; keep long runs constant-cost.
      value += key === 'cycleTimes' && Array.isArray(field)
        ? `${key}:${field.length},${field.at(-1)};` : `${key}:${field};`;
    }
    if (step instanceof RVEnable) value += `visible:${step.target?.visible};`;
  }
  return value;
}

export function logicEventParticipant(engine: RVLogicEngine, host: CoreSubsystemsHost,
  opts: { store: SignalStore; events: SimEventFacade; existingRoots?: ReadonlySet<RVLogicStep> }): LogicEventParticipant {
  const roots = engine.roots.map(root => ({ root, steps: logicSteps(root) }));
  // Only roots started before DES attachment need conversion from the viewer clock.
  // Do this before snapshots can capture the participant, with no derived pending state.
  for (const { root, steps } of roots) if (!opts.existingRoots?.has(root)
    && (root.state === StepState.Active || root.state === StepState.Waiting)) {
    for (const step of steps) if (step.state === StepState.Active || step.state === StepState.Waiting) {
      if (step instanceof RVDelay) step.startT = opts.events.now - step.elapsed;
      else if (step instanceof RVSerialContainer)
        (step as unknown as { cycleStartTime: number }).cycleStartTime = opts.events.now;
    }
  }
  const steps = roots.flatMap(entry => entry.steps);
  const coldReset = logicColdReset(engine);
  const run: LogicRun = { lastEval: opts.events.now };
  const reads = new Set<string>();
  const drives = new Set<DriveLike>();
  const sensors = new Set(steps.filter((s): s is RVWaitForSensor => s instanceof RVWaitForSensor).map(s => s.sensor));
  const zones = new Set(steps.filter((s): s is RVWaitForZone => s instanceof RVWaitForZone).map(s => s.zone));
  const polled = steps.filter(step => logicCyclePolled(step, engine));
  for (const step of steps) {
    const address = step instanceof RVWaitForSignalBool || step instanceof RVWaitForSignalFloat || step instanceof RVJumpOnSignal
      ? step.signalAddress : step instanceof RVDriveTo && step.valueBySignal ? step.destinationSignal : null;
    if (address) reads.add(opts.store.nameForPath(address) ?? address);
    if (step instanceof RVDriveTo && step.drive) drives.add(step.drive);
    if (step instanceof RVWaitForDrivesAtTarget) for (const drive of step.drives) drives.add(drive);
  }
  let changedRoots: RVLogicStep[] = [];
  const wake = (): void => opts.events.wake('core.logic');
  const wakeOff: (() => void)[] = [];
  const reattachWakeListeners = (): void => {
    for (const unsubscribe of wakeOff.splice(0).reverse()) unsubscribe();
    try {
      wakeOff.push(addArrivedListener(host, drive => { if (drives.has(drive)) wake(); }));
      for (const sensor of sensors) if (sensor) { wakeOff.push(() => sensor.removeFeedbackListener(wake)); sensor.addFeedbackListener(wake); }
      for (const zone of zones) if (zone) wakeOff.push(zone.addOccupiedListener(wake));
      const grips = new Set(steps.filter((step): step is RVGripPick | RVGripPlace =>
        (step instanceof RVGripPick || step instanceof RVGripPlace) && step.blocking).map(step => step.grip));
      for (const grip of grips) if (grip) wakeOff.push(addGripHeldListener(grip, wake));
    } catch (error) {
      for (const unsubscribe of wakeOff.splice(0).reverse()) unsubscribe();
      throw error;
    }
  };
  reattachWakeListeners();
  const off: (() => void)[] = [];
  off.push(opts.events.registerCycleParticipant('core.logic.poll', 10, {
    alive: () => false,
    step: () => { if (polled.some(s => s.state === StepState.Active || s.state === StepState.Waiting)) wake(); },
  }));
  off.push(opts.events.registerResetHook('core.logic', () => {
    const restart = engine.isStarted;
    coldReset();
    run.lastEval = opts.events.now;
    engine.updateConnection(host.isConnected);
    engine.resetOwnedOutputs();
    if (restart) engine.start(host.isConnected);
  }));
  return {
    run,
    reattachWakeListeners,
    readSet: () => reads,
    settle(t, image) {
      const before = roots.map(({ root, steps }) => signature(steps, root));
      engine.eventTime = t;
      engine.eventImage = image;
      try {
        engine.updateConnection(host.isConnected);
        if (isActiveForState(engine.activeOnly, host.isConnected)) engine.fixedUpdate(t - run.lastEval);
        run.lastEval = t;
      } finally { engine.eventTime = null; engine.eventImage = null; }
      changedRoots = roots.filter(({ root, steps }, i) => signature(steps, root) !== before[i]).map(entry => entry.root);
      return changedRoots.length > 0;
    },
    dueTime(now) {
      let earliest = Infinity;
      for (const step of steps) if (step instanceof RVDelay && step.state === StepState.Active) {
        let t = step.startT + step.duration;
        if (!Number.isFinite(t)) continue;
        while (!delayDue(step.startT, step.duration, t)) t = nextUp(t);
        if (t > now) earliest = Math.min(earliest, t);
      }
      return earliest === Infinity ? null : earliest;
    },
    holdsRun: () => engine.isRunning(),
    onSettleOverflow(message) {
      const halt = changedRoots.length ? changedRoots : roots.map(entry => entry.root)
        .filter(root => root.state === StepState.Active || root.state === StepState.Waiting);
      for (const root of halt) engine.haltRoot(root, message);
      changedRoots = [];
    },
    dispose() { for (const unsubscribe of [...off.splice(0), ...wakeOff.splice(0)].reverse()) unsubscribe(); },
  };
}
