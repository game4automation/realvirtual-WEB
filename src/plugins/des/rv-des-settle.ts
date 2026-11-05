// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { SETTLE_MAX_BATCHES, SETTLE_MAX_ROUNDS, type EventParticipant, type SignalValue } from '../../core/sim-event-facade';
import type { Snapshottable, SnapshotProviderFrame, ParticipantHandleField } from '../../core/sdk/rv-snapshot-contract-types';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import { withSpeedOverrideNeutral } from '../../core/engine/rv-speed-override';
import { clearProblem, reportProblem as reportDefaultProblem, type ProblemInput } from '../../core/hmi/problems-store';
import type { DESManager } from './rv-des-manager';
import { NO_ENTITY, NO_MU, PLANNING_PRIORITY } from './rv-des-event';
import { ACTION_INDEX, registerAction } from './rv-des-named-actions';
import { fromSnapshotData, type SnapshotJson, type SnapshotSchema } from './rv-snapshot-contract';
import { participantHandleProblems } from './rv-des-preflight';

export const SETTLE_PRIORITY = PLANNING_PRIORITY + 1;
export const DUE_PRIORITY = 0;
const controllers = new WeakMap<object, SettleController>();
const settleAction = ACTION_INDEX.get('Core.Settle') ?? registerAction('Core.Settle', ctx => {
  controllers.get(ctx.manager)?.settle(ctx.simTime);
}, { owner: 'core.settle', payload: 'none', handleFields: ['handle'] });
const dueAction = ACTION_INDEX.get('Core.Due') ?? registerAction('Core.Due', ctx => {
  controllers.get(ctx.manager)?.due((ctx.data as { participant: string }).participant);
}, {
  owner: 'core.settle',
  payload: data => data && typeof data === 'object' && !Array.isArray(data)
    && typeof data.participant === 'string' && Object.keys(data).length === 1
    ? [] : ['Core.Due requires { participant: string }'],
  handleFields: ['dues[][1].handle'],
});

export interface SettleRun {
  dirty: string[];
  handle: number;
  dues: Map<string, { t: number; handle: number }>;
  image: Map<string, Map<string, SignalValue>>;
  batches: Map<string, Map<string, SignalValue>[]>;
}

export class SettleController {
  run: SettleRun = { dirty: [], handle: -1, dues: new Map(), image: new Map(), batches: new Map() };
  private readonly participants = new Map<string, { order: number; p: EventParticipant; reads: Set<string> }>();
  private readonly afterSettleHooks = new Set<() => void>();
  private readonly lastChange = new Map<string, string>();
  private readonly overflowed = new Set<string>();
  private offWrites: (() => void) | undefined;
  private restoring = false;
  private executing = false;
  private current: string | null = null;

  constructor(readonly manager: DESManager, private store?: SignalStore,
    readonly reportProblem: (problem: ProblemInput) => void = reportDefaultProblem) {
    if (controllers.has(manager)) throw new Error('SettleController already installed');
    controllers.set(manager, this);
    this.offWrites = store?.observeWrites(batch => this.onWrites(batch));
  }

  bindStore(store?: SignalStore): void {
    if (this.store === store) return;
    this.offWrites?.();
    this.store = store;
    this.offWrites = store?.observeWrites(batch => this.onWrites(batch));
    for (const id of this.participants.keys()) this.fillImage(id);
  }

  registerEventParticipant(id: string, order: number, p: EventParticipant): () => void {
    if (!id || this.participants.has(id)) throw new Error(`duplicate or empty event participant '${id}'`);
    const entry = { order, p, reads: new Set(p.readSet()) };
    this.participants.set(id, entry);
    this.fillImage(id);
    this.run.batches.set(id, []);
    this.planDue(id, this.manager.currentTime);
    return () => {
      if (this.participants.get(id) !== entry) return;
      this.cancelDue(id);
      this.participants.delete(id);
      this.run.image.delete(id);
      this.run.batches.delete(id);
      this.run.dirty = this.run.dirty.filter(key => key !== id);
      this.lastChange.delete(id);
      if (!this.hasWork() && this.run.handle >= 0) {
        this.manager.cancelEvent(this.run.handle);
        this.run.handle = -1;
      }
    };
  }

  get currentParticipant(): string | null { return this.current; }

  reorderEventParticipant(id: string, order: number): void {
    const entry = this.participants.get(id);
    if (!entry) throw new Error(`unknown event participant '${id}'`);
    if (entry.order === order) return;
    entry.order = order;
    this.run.dirty.sort((a, b) => this.participants.get(a)!.order - this.participants.get(b)!.order
      || (a < b ? -1 : a > b ? 1 : 0));
  }

  refreshEventParticipant(id: string, p: EventParticipant): void {
    const entry = this.participants.get(id);
    if (!entry) throw new Error(`unknown event participant '${id}'`);
    const reads = new Set(p.readSet());
    const image = this.run.image.get(id)!;
    for (const name of image.keys()) if (!reads.has(name)) image.delete(name);
    for (const name of reads) if (!entry.reads.has(name)) {
      const value = this.store?.get(name);
      if (value !== undefined) image.set(name, value);
    }
    const queue = this.run.batches.get(id)!;
    for (const batch of queue) for (const name of batch.keys()) if (!reads.has(name)) batch.delete(name);
    this.run.batches.set(id, queue.filter(batch => batch.size > 0));
    entry.p = p;
    entry.reads = reads;
    this.planDue(id, this.manager.currentTime);
    this.wake(id);
  }

  private ordered(): string[] {
    return [...this.participants.keys()].sort((a, b) =>
      this.participants.get(a)!.order - this.participants.get(b)!.order || (a < b ? -1 : a > b ? 1 : 0));
  }

  private fillImage(id: string): void {
    const image = new Map<string, SignalValue>();
    for (const name of this.participants.get(id)!.reads) {
      const value = this.store?.get(name);
      if (value !== undefined) image.set(name, value);
    }
    this.run.image.set(id, image);
  }

  private markDirty(id: string): void {
    if (this.run.dirty.includes(id)) return;
    this.run.dirty.push(id);
    this.run.dirty.sort((a, b) => this.participants.get(a)!.order - this.participants.get(b)!.order
      || (a < b ? -1 : a > b ? 1 : 0));
  }

  private hasWork(): boolean {
    return this.run.dirty.length > 0 || [...this.run.batches.values()].some(q => q.length > 0);
  }

  private onWrites(batch: ReadonlyMap<string, SignalValue>): void {
    if (this.restoring) return;
    for (const id of this.ordered()) {
      const entry = this.participants.get(id);
      if (!entry) continue;
      const reads = entry.reads;
      const filtered = new Map([...batch].filter(([name]) => reads.has(name)));
      if (!filtered.size) continue;
      this.lastChange.set(id, [...filtered.keys()].at(-1)!);
      if (this.current === id) {
        for (const [name, value] of filtered) this.run.image.get(id)!.set(name, value);
        this.markDirty(id);
      } else {
        const queue = this.run.batches.get(id)!;
        queue.push(filtered);
        if (queue.length > SETTLE_MAX_BATCHES) this.overflow(id,
          `DES settle exceeded ${SETTLE_MAX_BATCHES} batches at t=${this.manager.currentTime} (last change: ${this.lastChange.get(id)})`);
      }
    }
    if (!this.hasWork() && this.run.handle >= 0 && !this.executing) {
      this.manager.cancelEvent(this.run.handle);
      this.run.handle = -1;
    }
    this.requestSettle();
  }

  wake(id: string): void {
    if (this.restoring || !this.participants.has(id)) return;
    this.markDirty(id);
    this.requestSettle();
  }

  requestSettle(): void {
    if (this.restoring || this.executing || this.run.handle >= 0 || !this.hasWork()) return;
    this.run.handle = this.manager.scheduleEventByIndex(this.manager.currentTime, settleAction, NO_ENTITY, NO_MU, SETTLE_PRIORITY);
  }

  settle(t: number): void {
    this.run.handle = -1;
    this.lastChange.clear();
    const evaluated = new Set<string>();
    this.executing = true;
    try {
      for (let round = 1; round <= SETTLE_MAX_ROUNDS && this.hasWork(); round++) {
        const dirty = this.ordered().filter(id => this.run.dirty.includes(id) || this.run.batches.get(id)!.length > 0);
        this.run.dirty = [];
        for (const id of dirty) {
          const entry = this.participants.get(id);
          if (!entry) continue;
          const image = this.run.image.get(id)!;
          const queue = this.run.batches.get(id)!;
          for (const [name, value] of queue.shift() ?? []) {
            image.set(name, value);
            this.lastChange.set(id, name);
          }
          evaluated.add(id);
          this.current = id;
          let changed: boolean;
          try { changed = withSpeedOverrideNeutral(() => entry.p.settle(t, image)); }
          finally { this.current = null; }
          if (this.participants.get(id) !== entry) continue;
          if (changed) { this.markDirty(id); this.lastChange.set(id, 'state'); }
          if (queue.length) this.markDirty(id);
        }
      }
      if (this.hasWork()) {
        const pending = this.ordered().filter(id => this.run.dirty.includes(id) || this.run.batches.get(id)!.length > 0);
        for (const id of pending) this.overflow(id,
          `DES settle did not converge after ${SETTLE_MAX_ROUNDS} rounds at t=${t} (last change: ${this.lastChange.get(id) ?? 'state'})`);
      }
      for (const id of evaluated) if (this.participants.has(id)) this.planDue(id, t);
    } finally { this.executing = false; }
    for (const hook of this.afterSettleHooks) hook();
  }

  private overflow(id: string, message: string): void {
    this.cancelDue(id);
    this.run.dirty = this.run.dirty.filter(key => key !== id);
    const queue = this.run.batches.get(id);
    if (queue) queue.length = 0;
    this.participants.get(id)?.p.onSettleOverflow?.(message);
    this.run.dirty = this.run.dirty.filter(key => key !== id);
    const remaining = this.run.batches.get(id);
    if (remaining) remaining.length = 0;
    this.overflowed.add(id);
    this.reportProblem({ id: `des-settle-overflow:${id}`, code: 'des-settle-overflow', severity: 'error',
      title: 'DES settle overflow', detail: `${id}: ${message}`, nodePath: id, at: this.manager.currentTime * 1000 });
  }

  /** Overflow problems belong to this run; reset and teardown retire them. */
  private clearOverflowProblems(): void {
    for (const id of this.overflowed) clearProblem(`des-settle-overflow:${id}`);
    this.overflowed.clear();
  }

  private cancelDue(id: string): void {
    const due = this.run.dues.get(id);
    if (due) this.manager.cancelEvent(due.handle);
    this.run.dues.delete(id);
  }

  private planDue(id: string, now: number): void {
    const t = this.participants.get(id)!.p.dueTime(now);
    if (t === null || t <= now) { this.cancelDue(id); return; }
    if (!Number.isFinite(t)) throw new Error(`invalid due time for '${id}'`);
    if (this.run.dues.get(id)?.t === t) return;
    this.cancelDue(id);
    const handle = this.manager.scheduleEventByIndex(t, dueAction, NO_ENTITY, NO_MU, DUE_PRIORITY, { participant: id });
    this.run.dues.set(id, { t, handle });
  }

  due(id: string): void {
    this.run.dues.delete(id);
    this.wake(id);
  }

  afterSettle(fn: () => void): () => void {
    this.afterSettleHooks.add(fn);
    return () => { this.afterSettleHooks.delete(fn); };
  }

  beginRestore(): void { this.restoring = true; }
  endRestore(): void { this.restoring = false; }
  isResting(): boolean { return [...this.participants.values()].some(({ p }) => p.holdsRun?.() === true); }

  reset(): void {
    this.clearOverflowProblems();
    if (this.run.handle >= 0) this.manager.cancelEvent(this.run.handle);
    for (const id of this.run.dues.keys()) this.cancelDue(id);
    this.run = { dirty: [], handle: -1, dues: new Map(), image: new Map(), batches: new Map() };
    this.lastChange.clear();
    for (const id of this.ordered()) {
      this.fillImage(id);
      this.run.batches.set(id, []);
      if (startPassOf(this.participants.get(id)!.p)) this.markDirty(id);
      this.planDue(id, this.manager.currentTime);
    }
    this.requestSettle();
  }

  dispose(): void {
    this.clearOverflowProblems();
    this.offWrites?.();
    if (this.run.handle >= 0) this.manager.cancelEvent(this.run.handle);
    for (const id of this.run.dues.keys()) this.cancelDue(id);
    if (controllers.get(this.manager) === this) controllers.delete(this.manager);
    this.participants.clear();
    this.afterSettleHooks.clear();
    this.run = { dirty: [], handle: -1, dues: new Map(), image: new Map(), batches: new Map() };
  }

  /** Validate decoded state against the target world's registration and read sets. */
  stateProblems(value: unknown): string[] {
    const errors: string[] = [];
    const r = value as SettleRun;
    const handle = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= -1;
    if (!r || typeof r !== 'object' || !Array.isArray(r.dirty) || !handle(r.handle)
      || !(r.dues instanceof Map) || !(r.image instanceof Map) || !(r.batches instanceof Map)) return ['invalid settle run'];
    for (const id of [...r.dirty, ...r.dues.keys(), ...r.image.keys(), ...r.batches.keys()])
      if (!this.participants.has(id)) errors.push(`unknown participant '${id}'`);
    if (new Set(r.dirty).size !== r.dirty.length) errors.push('duplicate dirty participant');
    for (const [id, due] of r.dues) if (!due || !Number.isFinite(due.t) || !handle(due.handle) || due.handle < 0)
      errors.push(`invalid due for '${id}'`);
    const imageProblems = (id: string, image: unknown): void => {
      if (!(image instanceof Map)) { errors.push(`invalid image/batch for '${id}'`); return; }
      for (const [name, value] of image) if (!this.participants.get(id)?.reads.has(name)
        || typeof value !== 'number' && typeof value !== 'boolean') errors.push(`invalid signal '${name}' for '${id}'`);
    };
    for (const [id, image] of r.image) imageProblems(id, image);
    for (const [id, queue] of r.batches) {
      if (!Array.isArray(queue) || queue.length > SETTLE_MAX_BATCHES) errors.push(`invalid batch queue for '${id}'`);
      else for (const batch of queue) imageProblems(id, batch);
    }
    for (const id of this.participants.keys()) if (!r.image.has(id) || !r.batches.has(id)) errors.push(`missing image/batches for '${id}'`);
    return errors;
  }
}

const schema: SnapshotSchema = { codecs: {
  dues: 'map', image: 'map', 'image[][1]': 'map', 'image[][1][][1]': 'number-tags',
  batches: 'map', 'batches[][1][]': 'map', 'batches[][1][][][1]': 'number-tags',
} };

export function settleSnapshotParticipant(controller: SettleController, raw?: SnapshotProviderFrame): Snapshottable {
  const decode = (json: SnapshotJson): SettleRun => fromSnapshotData(json, { participant: 'core.settle', ...schema }) as SettleRun;
  const handles = (json: SnapshotJson): ParticipantHandleField[] => {
    const run = decode(json);
    return [{ path: 'handle', eventId: run.handle, owner: null, alternatives: [{ action: 'Core.Settle', kind: null }] },
      ...[...run.dues].map(([id, due]) => ({ path: `dues.${id}.handle`, eventId: due.handle, owner: null,
        alternatives: [{ action: 'Core.Due', kind: null }] }))];
  };
  return {
    key: 'core.settle', version: 1, owner: controller, stateKeys: ['run'],
    services: ['manager', 'store', 'reportProblem', 'participants', 'afterSettleHooks', 'lastChange', 'overflowed', 'offWrites', 'restoring', 'executing', 'current'],
    schema, handleFields: handles,
    capture: () => controller.run,
    validate: json => {
      try {
        const run = decode(json);
        const errors = controller.stateProblems(run);
        if (errors.length) return errors;
        // Inspect only our handles/payloads; unrelated live model payloads need their own codecs.
        const events = raw?.eventQueue ?? controller.manager.exportQueue(() => '', data => data as SnapshotJson);
        errors.push(...participantHandleProblems(handles(json), events));
        const now = raw?.simTime ?? controller.manager.currentTime;
        for (const [id, due] of run.dues) {
          const event = events.find(e => e.id === due.handle);
          if (!event || event.time !== due.t || (event.data as { participant?: string })?.participant !== id || due.t < now)
            errors.push(`due '${id}' handle/time/participant mismatch`);
        }
        for (const event of events.filter(e => e.action === 'Core.Due')) {
          const id = (event.data as { participant?: string })?.participant;
          const due = id === undefined ? undefined : run.dues.get(id);
          if (!due || due.handle !== event.id || due.t !== event.time) errors.push(`Core.Due ${event.id} has no matching due`);
        }
        for (const event of events.filter(e => e.action === 'Core.Settle'))
          if (event.id !== run.handle || event.time !== now) errors.push(`Core.Settle ${event.id} has no matching handle/time`);
        if (run.handle >= 0 && !run.dirty.length && ![...run.batches.values()].some(q => q.length)) errors.push('settle handle without work');
        if (run.handle < 0 && (run.dirty.length || [...run.batches.values()].some(q => q.length))) errors.push('settle work without handle');
        return errors;
      } catch (error) { return [String(error)]; }
    },
    prepare: json => {
      const run = decode(json);
      const errors = controller.stateProblems(run);
      if (errors.length) throw new Error(`des-snapshot-contract: ${errors.join('; ')}`);
      return run;
    },
    commit: prepared => { controller.run = prepared as SettleRun; },
  };
}

/** Start/reset evaluate every participant except those that opt out (pure deadline owners such as scene buttons). */
export function startPassOf(p: EventParticipant): boolean {
  return (p as { readonly startPass?: boolean }).startPass !== false;
}
