// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { CycleParticipant } from '../../core/sim-event-facade';
import type { Snapshottable, SnapshotProviderFrame, ParticipantHandleField } from '../../core/sdk/rv-snapshot-contract-types';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import { withSpeedOverrideNeutral } from '../../core/engine/rv-speed-override';
import type { DESManager } from './rv-des-manager';
import type { SettleController } from './rv-des-settle';
import { NO_ENTITY, NO_MU } from './rv-des-event';
import { ACTION_INDEX, registerAction } from './rv-des-named-actions';
import { fromSnapshotData, type SnapshotJson } from './rv-snapshot-contract';
import { participantHandleProblems } from './rv-des-preflight';

export const CYCLE_PRIORITY = 0x7ffffffe;
const controllers = new WeakMap<object, CycleController>();
const cycleAction = ACTION_INDEX.get('Core.Cycle') ?? registerAction('Core.Cycle', ctx => {
  controllers.get(ctx.manager)?.cycle();
}, { owner: 'core.cycle', payload: 'none', handleFields: ['handle'] });

export interface CycleHost {
  motion(dt: number): void;
  /** Reports position changes, including motion completed in this update. */
  taktDrives(dt: number): boolean | void;
  alive(): boolean;
}

export interface CycleRun { k: number; handle: number; armed: boolean; lastK: number; trailing: boolean }

export class CycleController {
  run: CycleRun = { k: 0, handle: -1, armed: false, lastK: -1, trailing: false };
  private readonly participants = new Map<string, { order: number; p: CycleParticipant }>();
  private claimedDrives: readonly object[] = [];
  private readonly offWrites: (() => void) | undefined;
  private readonly offSettle: (() => void) | undefined;
  private restoring = false;
  private executing = false;
  private disposed = false;

  constructor(readonly manager: DESManager, readonly host: CycleHost, readonly cycleTime = 1 / 60,
    store?: SignalStore, settle?: SettleController) {
    if (!Number.isFinite(cycleTime) || cycleTime <= 0) throw new Error('positive finite cycleTime required');
    if (controllers.has(manager)) throw new Error('CycleController already installed');
    controllers.set(manager, this);
    this.offWrites = store?.observeWrites(() => { if (!this.restoring && !this.run.armed) this.arm(); });
    this.offSettle = settle?.afterSettle(() => this.armIfAlive());
  }

  registerCycleParticipant(id: string, order: number, p: CycleParticipant): () => void {
    if (!id || this.participants.has(id)) throw new Error(`duplicate or empty cycle participant '${id}'`);
    const entry = { order, p };
    this.participants.set(id, entry);
    this.armIfAlive();
    return () => {
      if (this.participants.get(id) !== entry) return;
      this.participants.delete(id);
      if (!this.executing && !this.run.trailing && !this.alive()) this.disarm();
    };
  }

  alive(): boolean { return this.host.alive() || [...this.participants.values()].some(({ p }) => p.alive()); }
  armIfAlive(): void { if (this.alive()) this.arm(); }

  arm(): void {
    if (this.disposed || this.restoring || this.executing || this.run.armed) return;
    if (this.run.handle !== -1) throw new Error('Core.Cycle already has a pending handle');
    let k = Math.max(this.run.lastK + 1, Math.ceil(this.manager.currentTime / this.cycleTime));
    if (!Number.isSafeInteger(k)) throw new Error('Core.Cycle index exceeds the safe integer range');
    while (k * this.cycleTime < this.manager.currentTime) k++;
    this.schedule(k);
  }

  private schedule(k: number): void {
    if (!Number.isSafeInteger(k) || this.run.handle !== -1) throw new Error('invalid or duplicate Core.Cycle schedule');
    this.run.k = k;
    this.run.handle = this.manager.scheduleEventByIndex(k * this.cycleTime, cycleAction, NO_ENTITY, NO_MU, CYCLE_PRIORITY);
    this.run.armed = true;
  }

  cycle(): void {
    this.run.handle = -1;
    const k = this.run.k;
    const wasAlive = this.alive();
    let moved = false;
    // Keep armed during callbacks: signal writes must not enqueue another cycle.
    this.executing = true;
    try {
      withSpeedOverrideNeutral(() => {
        this.host.motion(this.cycleTime);
        const ordered = [...this.participants.entries()].sort(([a, x], [b, y]) =>
          x.order - y.order || (a < b ? -1 : a > b ? 1 : 0));
        for (const [id, entry] of ordered) if (this.participants.get(id) === entry) entry.p.step(this.cycleTime);
        moved = this.host.taktDrives(this.cycleTime) === true;
      });
    } finally { this.executing = false; }
    this.run.lastK = k;
    if (this.disposed) return;
    if (this.alive()) {
      this.run.trailing = false;
      this.schedule(k + 1);
    } else if (wasAlive || moved) {
      // Behaviors publish before physics; one final pass publishes the stop.
      this.run.trailing = true;
      this.schedule(k + 1);
    } else this.disarm();
  }

  private disarm(): void {
    if (this.run.handle >= 0) this.manager.cancelEvent(this.run.handle);
    this.run.handle = -1;
    this.run.armed = false;
    this.run.trailing = false;
  }

  setClaimedDrives(drives: readonly object[]): void { this.claimedDrives = [...drives]; }
  claimsDrives(): readonly object[] { return this.claimedDrives; }
  beginRestore(): void { this.restoring = true; }
  endRestore(): void { this.restoring = false; }

  reset(): void {
    this.disarm();
    this.run = { k: 0, handle: -1, armed: false, lastK: -1, trailing: false };
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
    this.offWrites?.();
    this.offSettle?.();
    this.participants.clear();
    if (controllers.get(this.manager) === this) controllers.delete(this.manager);
  }
}

export function cycleSnapshotParticipant(controller: CycleController, raw?: SnapshotProviderFrame): Snapshottable {
  const decode = (json: SnapshotJson): CycleRun => fromSnapshotData(json, { participant: 'core.cycle' }) as CycleRun;
  const handles = (json: SnapshotJson): ParticipantHandleField[] => [{ path: 'handle', eventId: decode(json).handle,
    owner: null, alternatives: [{ action: 'Core.Cycle', kind: null }] }];
  const stateProblems = (run: CycleRun): string[] => {
    if (!run || !Number.isSafeInteger(run.k) || run.k < 0 || !Number.isSafeInteger(run.lastK) || run.lastK < -1
      || !Number.isSafeInteger(run.handle) || run.handle < -1 || typeof run.armed !== 'boolean'
      || typeof run.trailing !== 'boolean' || run.trailing && !run.armed
      || run.armed !== (run.handle >= 0) || run.armed && run.k <= run.lastK) return ['invalid cycle run'];
    return [];
  };
  return {
    key: 'core.cycle', version: 1, owner: controller, stateKeys: ['run'],
    services: ['manager', 'host', 'cycleTime', 'participants', 'claimedDrives', 'offWrites', 'offSettle', 'restoring', 'executing', 'disposed'],
    handleFields: handles,
    claimsDrives: () => controller.claimsDrives(),
    capture: () => controller.run,
    validate: json => {
      try {
        const run = decode(json);
        const errors = stateProblems(run);
        if (errors.length) return errors;
        const events = raw?.eventQueue ?? controller.manager.exportQueue(() => '', data => data as SnapshotJson);
        errors.push(...participantHandleProblems(handles(json), events));
        const now = raw?.simTime ?? controller.manager.currentTime;
        for (const event of events.filter(e => e.action === 'Core.Cycle'))
          if (event.id !== run.handle || event.time !== run.k * controller.cycleTime || event.time < now)
            errors.push(`Core.Cycle ${event.id} handle/time mismatch`);
        return errors;
      } catch (error) { return [String(error)]; }
    },
    prepare: json => {
      const run = decode(json);
      const errors = stateProblems(run);
      if (errors.length) throw new Error(`des-snapshot-contract: ${errors.join('; ')}`);
      return run;
    },
    commit: prepared => { controller.run = prepared as CycleRun; },
  };
}
