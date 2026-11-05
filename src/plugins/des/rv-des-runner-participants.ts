// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { scriptParticipants } from './rv-des-script-participant';
import type { ScriptStateSource } from './des-runner';
import type { ProgressWiring } from '../../core/diagnostics/rv-progress-wiring';
import type { BlockageWatch } from '../../core/diagnostics/rv-blockage-watch';
import { SnapshotRegistry } from './rv-snapshot-registry';
import { fromSnapshotData, toSnapshotData, type SnapshotSchema } from './rv-snapshot-contract';
import { DESEventQueue } from './rv-des-event-queue';
import { ACTION_INDEX, getActionSchema } from './rv-des-named-actions';
import { assertPersistableQueueOrThrow, type PersistableQueueEvent } from './rv-des-action-schema';
import { serializeMU, applyMUSnapshot, parentHierarchyVisuals } from './rv-des-mu-snapshot';
import { createDESMUForRestore, type DESMU, type DESMUSnapshot } from './rv-des-mu';
import type { DESComponent, DESComponentSnapshot } from './rv-des-component';
import type { DESManager } from './rv-des-manager';
import type { RVDrive } from '../../core/engine/rv-drive';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import type { FrozenDescriptor, ReservationRecord } from '../../core/material-flow/material-flow-self';
import type { TweenDataSnapshot } from '../../core/material-flow/tween-registry';
import type { DESSnapshotV4 } from './rv-des-snapshot-v4';
import { componentStateKeys, componentServices } from './rv-des-component-state';
import { driveParticipant } from './rv-des-drive-participant';
import type { RngStream } from '../../core/rv-rng-distribution';
import { rngParticipant } from './rv-des-rng-participant';
import { decodeHookPayload } from './rv-des-hook-payload-codec';
import { validateFrozen } from './rv-des-frozen-validation';

export interface ParticipantWorld {
  scripts?: readonly ScriptStateSource[];
  manager: DESManager;
  blockageWatch?: BlockageWatch;
  progressWiring?: ProgressWiring | null;
  /** plan-2241: the DES units the runner's diagnostics push into the ledger; absent while unbound. */
  progressUnits?: () => readonly string[];
  components: ReadonlyMap<string, DESComponent>;
  componentExtraServices?: ReadonlyMap<string, readonly string[]>;
  drives: ReadonlyMap<string, RVDrive>;
  taktDrives?: ReadonlyMap<string, RVDrive>;
  rngOwners?: ReadonlyMap<string, RngStream>;
  signals: SignalStore | null;
  signalKey?(key: string, restoring: boolean): string;
  tweens(): TweenDataSnapshot[];
  pathExists(id: string): boolean;
  jsonPayload(data: unknown): unknown;
  replanOnRestore: ReadonlySet<string>;
}

/** v3 field placement: clock/queue -> envelope; run counters -> des.manager;
 * mus + generations + allocator -> des.mus; streams -> des.rng;
 * reservations/nextReservationId -> des.reservations; drives -> des.drives;
 * signalValues + pins -> des.signals; tween windows -> des.tweens;
 * components -> desId parts. Scripts remain migration-locked until 3b.
 * All lookup/allocation work belongs to prepare. Commits only stage values. */
export function runnerParticipants(w: ParticipantWorld, raw?: DESSnapshotV4, restoring = false) {
  const registry = new SnapshotRegistry();
  const staged = new Map<string, unknown>();
  const scripts = scriptParticipants(registry, w.scripts);
  // MU/queue refs resolve by object identity: component paths are NOT unique
  // (the same asset placed twice yields equal node paths). Only reservations,
  // which the manager itself keys by path, go through the path map — and an
  // ambiguous path refuses the capture instead of guessing.
  const byObject = new Map<object, string>([...w.components].map(([id, c]) => [c, id]));
  const byPath = new Map<string, string | null>();
  for (const [id, c] of w.components) byPath.set(c.path, byPath.has(c.path) ? null : id);
  const idOf = (c: object): string => {
    const id = byObject.get(c);
    if (!id) throw new Error('component without DES id');
    return id;
  };
  const component = (id: string): DESComponent => {
    const c = w.components.get(id);
    if (!c) throw new Error(`unknown DES id '${id}'`);
    return c;
  };
  const idForPath = (path: string): string => {
    const id = byPath.get(path);
    if (id === null) throw new Error(`ambiguous component path '${path}' (reservation)`);
    if (!id) throw new Error(`unknown component path '${path}'`);
    return id;
  };
  const muRecords = () => {
    const records: Array<DESMUSnapshot & { retired: boolean; retireNotified: boolean; nextComponentId: string | null; inTransfer: boolean }> = [];
    for (let i = 0; i < w.manager.muCount; i++) {
      const mu = w.manager.getMU(i) as DESMU | null;
      if (!mu) continue;
      const s = serializeMU(mu);
      s.prop = mu.prop; s.childMUs = mu.childMUs; s.parentMU = mu.parentMU;
      s.currentComponentPath = mu.currentComponent ? idOf(mu.currentComponent) : null;
      s.loadedOnPath = mu.loadedOn ? idOf(mu.loadedOn) : null;
      s.routePaths = mu.route.map(c => idOf(c));
      records.push({ ...s, inTransfer: !!mu.inTransfer, retired: !!mu.retired, retireNotified: !!mu.retireNotified,
        nextComponentId: mu.nextComponent ? idOf(mu.nextComponent) : null });
    }
    return records;
  };
  type MURecord = ReturnType<typeof muRecords>[number];
  type MUState = ReturnType<DESManager['exportMUAllocator']> & { records: MURecord[] };
  // Decoded once per capture/restore: muRef runs for every queued event and
  // every reference, so re-decoding here would be quadratic.
  let savedMUsCache: { state: MUState; byId: Map<number, MURecord> } | null = null;
  const savedMUIndex = () => {
    if (!savedMUsCache) {
      const musPart = raw?.parts.find(p => p.key === 'des.mus');
      if (raw && !musPart) throw new Error('missing participant des.mus');
      const state = raw
        ? fromSnapshotData(musPart!.state, { participant: 'des.mus', ...muSchema }) as MUState
        : { ...w.manager.exportMUAllocator(), records: muRecords() };
      if (!Array.isArray(state?.records)) throw new Error('invalid MU allocator');
      savedMUsCache = { state, byId: new Map(state.records.map(m => [m.id, m])) };
    }
    return savedMUsCache;
  };
  const muRef = (id: number, gen?: number): void => {
    const mu = savedMUIndex().byId.get(id);
    if (!mu || gen !== undefined && mu.generation !== gen) throw new Error(`unknown MU '${id}:${gen ?? '*'}'`);
  };
  const checkRefs = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(checkRefs); return; }
    const obj = value as Record<string, unknown>;
    if (typeof obj.muId === 'number' && obj.muId !== -1) muRef(obj.muId);
    if (obj.muRef) {
      const ref = obj.muRef as { id: number; gen: number };
      // A generation is part of the reference: without it a stale or forged ref would only fail in onRestored, after the live world was replaced.
      if (!Number.isSafeInteger(ref.gen) || ref.gen < 0) throw new Error(`invalid MU reference generation for MU ${ref.id}`);
      muRef(ref.id, ref.gen);
    }
    if (obj.kind === 'drive' && (typeof obj.driveRef !== 'string' || !w.drives.has(obj.driveRef)
      || !Number.isFinite(obj.from) || !Number.isFinite(obj.to))) throw new Error('invalid drive reference');
    if (obj.kind === 'axes') {
      if (typeof obj.anchorRef !== 'string' || !obj.anchorRef || !Array.isArray(obj.phases)
        || obj.ease !== undefined && obj.ease !== 'linear' && obj.ease !== 'scurve') throw new Error('invalid axes tween');
      for (const p of obj.phases as Array<{ at0: number; at1: number; axes: Array<{ driveRef: string; from: number; to: number }> }>) {
        if (!p || ![p.at0, p.at1].every(Number.isFinite) || p.at0 < 0 || p.at1 > 1 || p.at0 > p.at1
          || !Array.isArray(p.axes)) throw new Error('invalid axis phase');
        for (const a of p.axes) if (!a || !w.drives.has(a.driveRef) || ![a.from, a.to].every(Number.isFinite))
          throw new Error('invalid axis drive');
      }
    }
    if (obj.heldDriveTweens !== undefined) {
      if (!Array.isArray(obj.heldDriveTweens)) throw new Error('invalid held drive tweens');
      for (const t of obj.heldDriveTweens as Array<Record<string, unknown>>) {
        if (!t || t.kind !== 'drive' || !Number.isFinite(t.t0) || !Number.isFinite(t.t1)
          || (t.t1 as number) <= (t.t0 as number) || !['linear', 'scurve'].includes(t.ease as string)
          || !['always', 'finalOnly'].includes(t.writePolicy as string)) throw new Error('invalid held drive window');
      }
    }
    if (typeof obj.pathRef === 'string' && !w.pathExists(obj.pathRef)) throw new Error(`unknown path '${obj.pathRef}'`);
    Object.values(obj).forEach(checkRefs);
  };
  // A seated / carried MU can have a -0 pose component: tag the pose numbers like plannedExitTime.
  const muSchema: SnapshotSchema = { codecs: { 'records[].plannedExitTime': 'number-tags',
    'records[].position[]': 'number-tags', 'records[].quaternion[]': 'number-tags',
    'records[].forward[]': 'number-tags', 'records[]._bugSize[]': 'number-tags' } };
  const snapshotTime = () => raw?.simTime ?? w.manager.currentTime;
  const rawPart = raw ? (key: string): unknown => raw.parts.find(p => p.key === key)?.state : null;
  // plan-2241 decision 8: validated before any mutation; no fields -> deterministic default.
  const legacyArmedAt = (c: DESComponent): number | undefined => {
    if (byPath.get(c.path) == null) return undefined;
    const ledger = (rawPart?.('diag.blockage') as { ledger?: { entries?: unknown } } | undefined)?.ledger;
    const hit = Array.isArray(ledger?.entries) ? (ledger.entries as Array<[string, { state?: unknown; lastChangeSec?: unknown }]>)
      .find(e => Array.isArray(e) && e[0] === `des:${c.path}`) : undefined;
    const at = hit?.[1]?.lastChangeSec;
    return hit?.[1]?.state === 'armed' && typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : undefined;
  };
  const progressState = (c: DESComponent, s: Omit<DESComponentSnapshot, 'path'> & { blocked: Array<{ mus: number[]; since?: number }> }) => {
    const time = snapshotTime();
    const stamp = (v: unknown, name: string) => {
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v > time)) throw new Error(`invalid ${name}`);
    };
    for (const b of s.blocked) if (b.since !== undefined) stamp(b.since, 'blocked wait start');
    if (s.categorySince !== undefined) stamp(s.categorySince, 'categorySince');
    // restoreMURefs installs load = held MUs; a disagreeing load would only surface after commit.
    if (s.currentLoad !== s.muIds.length) throw new Error('currentLoad disagrees with the held MUs');
    const armed = c.snapshotProgressArmed(s, s.blocked.filter(b => b.mus.length > 0).length, rawPart);
    const since = s.progressArmedSince, last = s.lastProgressSec;
    if (since === undefined && last === undefined) {
      // Legacy: an earlier armed ledger entry of the unit wins for the progress time.
      const at = armed ? Math.min(time, legacyArmedAt(c) ?? time) : null;
      return { progressArmedSince: at, lastProgressSec: at };
    }
    if (since === undefined || last === undefined) throw new Error('incomplete progress lifecycle');
    stamp(since, 'progressArmedSince'); stamp(last, 'lastProgressSec');
    if ((since !== null) !== armed) throw new Error('progress lifecycle disagrees with the saved state');
    if (since !== null && (last === null || last < since)) throw new Error('lastProgressSec before progressArmedSince');
    return { progressArmedSince: since, lastProgressSec: last };
  };
  function add<T>(key: string, capture: () => T, check: (value: T) => void = () => {},
    prepare: (value: T) => unknown = v => v, schema?: SnapshotSchema) {
    const decode = (json: unknown) => fromSnapshotData(json, { participant: key, ...schema }) as T;
    registry.register({ key, version: 1, schema, capture,
      dependencies: key === 'des.manager' ? ['des.mus', 'des.rng', 'des.reservations', 'des.tweens', 'des.drives', 'des.signals', ...w.components.keys()] : undefined,
      validate(json) { try { check(decode(json)); return []; } catch (e) { return [String(e)]; } },
      prepare(json) { const value = decode(json); check(value); return prepare(value); },
      commit(value) { staged.set(key, value); } });
  }
  add('des.manager', () => w.manager.exportRunState(), s => {
    if (!Number.isSafeInteger(s.customIdCounter) || s.customIdCounter < 0
      || !Number.isSafeInteger(s.totalEventsProcessed) || s.totalEventsProcessed < 0
      || !Number.isFinite(s.statResetTime) || s.statResetTime < 0 || !Number.isFinite(s.masterSeed)
      || typeof s.statResetDone !== 'boolean' || typeof s.completeNotified !== 'boolean' || !Number.isFinite(s.lastListenerTime)
      || !Array.isArray(s.rngState) || s.rngState.length !== 4 || !s.rngState.every(Number.isInteger)) throw new Error('invalid manager state');
    const queue = raw?.eventQueue ?? events;
    for (const [id, action] of [[s.warmupEventId, '__warmup__'], [s.checkpointEventId, '__checkpoint__']] as const) {
      if (id !== -1 && !queue.some(e => e.id === id && e.action === action)) throw new Error(`unknown system event '${id}'`);
    }
  });
  let preparedSlots: (DESMU | null)[] = [];
  add<MUState>('des.mus', () => ({ ...w.manager.exportMUAllocator(), records: muRecords() }), s => {
    if (!Number.isSafeInteger(s.slotLength) || s.slotLength < 0 || !Array.isArray(s.freeSlots)
      || !Array.isArray(s.generations) || !Array.isArray(s.records)) throw new Error('invalid MU allocator');
    const ids = new Set<number>();
    const recById = new Map(s.records.map(r => [r.id, r] as const));
    for (const m of s.records) {
      for (const value of [m.forward, m._bugSize]) {
        if (value !== undefined && (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)))
          throw new Error('invalid MU travel state');
      }
      if (!Number.isInteger(m.id) || m.id < 0 || m.id >= s.slotLength || ids.has(m.id)) throw new Error('invalid MU slot');
      ids.add(m.id);
      if (!Number.isInteger(m.generation) || (m.generation ?? -1) < 0 || s.generations[m.id] !== m.generation) throw new Error('invalid MU generation');
      for (const id of [m.currentComponentPath, m.loadedOnPath, m.nextComponentId, ...m.routePaths]) if (id !== null) component(id);
      for (const ref of [...(m.childMUs ?? []), ...(m.parentMU ? [m.parentMU] : [])]) muRef(ref.id, ref.gen);
      const children = new Set<number>();
      for (const ref of m.childMUs ?? []) {
        const child = recById.get(ref.id)!;
        if (children.has(ref.id) || child.parentMU?.id !== m.id || child.parentMU.gen !== m.generation)
          throw new Error('inconsistent MU hierarchy');
        children.add(ref.id);
      }
      if (m.parentMU && !recById.get(m.parentMU.id)?.childMUs?.some(ref => ref.id === m.id && ref.gen === m.generation))
        throw new Error('inconsistent MU parent');
      const chain = new Set<number>([m.id]);
      let parent = m.parentMU;
      while (parent) {
        if (chain.has(parent.id)) throw new Error('MU hierarchy cycle');
        chain.add(parent.id);
        parent = recById.get(parent.id)?.parentMU ?? null;
      }
    }
    const free = new Set(s.freeSlots);
    if (free.size !== s.freeSlots.length || ids.size + free.size !== s.slotLength
      || [...free].some(id => !Number.isInteger(id) || id < 0 || id >= s.slotLength || ids.has(id))) throw new Error('invalid free slots');
    // plan-2212: optional (older snapshots have none) - each a captured, unretired MU, once.
    const pending = s.pendingRetire ?? [];
    if (!Array.isArray(pending)) throw new Error('invalid pending MU retirements');
    const seen = new Set<number>();
    for (const ref of pending) {
      const rec = recById.get(ref?.id);
      if (!rec || rec.generation !== ref.gen || rec.retired || seen.has(ref.id)) throw new Error('invalid pending MU retirement');
      seen.add(ref.id);
    }
  }, s => {
    preparedSlots = Array.from({ length: s.slotLength }, () => null);
    const comps = new Map(w.components);
    for (const record of s.records) {
      const mu = createDESMUForRestore(record.creationTime, record.customId);
      mu.id = record.id;
      applyMUSnapshot(mu, record, comps);
      mu.loadedOn = record.loadedOnPath ? component(record.loadedOnPath) : null;
      mu.nextComponent = record.nextComponentId ? component(record.nextComponentId) : null;
      mu.inTransfer = record.inTransfer; mu.retired = record.retired; mu.retireNotified = record.retireNotified;
      preparedSlots[mu.id] = mu;
    }
    return { ...s, slots: preparedSlots };
  }, muSchema);
  if (w.blockageWatch) {
    const watch = w.blockageWatch;
    // plan-2241 decision 8 (ledger half): a pushed ledger agrees with the component stamps.
    type Ledger = ReturnType<BlockageWatch['snapshotState']>['ledger'];
    const savedProgress = (id: string, c: DESComponent) => {
      const part = rawPart?.(id);
      const p = part === undefined ? { progressArmedSince: c.progressArmedSince === c.progressArmedSince ? c.progressArmedSince : null,
        lastProgressSec: c.lastProgressSec === c.lastProgressSec ? c.lastProgressSec : null }
        : progressState(c, fromSnapshotData(part, { participant: id }) as Parameters<typeof progressState>[1]);
      return { armed: p.progressArmedSince !== null, last: p.lastProgressSec };
    };
    // An ambiguous path (two components, one unit id) is never guessed: no lifecycle to compare.
    const unitProgress = (unit: string) => {
      const id = unit.startsWith('des:') ? byPath.get(unit.slice(4)) : undefined;
      return id ? savedProgress(id, w.components.get(id)!) : null;
    };
    const desEntries = (ledger: Ledger) => ledger.entries.flatMap(([unit, entry]) => {
      const p = unitProgress(unit);
      return p ? [{ entry, ...p }] : [];
    });
    /** Bound units the saved ledger has no row for (a push-bound world registers every unit at bind). */
    const missingUnits = (ledger: Ledger) => {
      const saved = new Set(ledger.entries.map(([id]) => id));
      return (w.progressUnits?.() ?? []).filter(id => !saved.has(id));
    };
    add('diag.blockage', () => ({ ...watch.snapshotState(), pushed: !!w.progressUnits, sampler: w.progressWiring?.snapshotState(visual => {
      for (let id = 0; id < w.manager.muCount; id++) if ((w.manager.getMU(id) as DESMU | null)?.visual === visual) return { id, gen: (w.manager.getMU(id) as DESMU).generation };
      return null;
    }) ?? null }), s => {
      if (!!s.sampler !== !!w.progressWiring) throw new Error('diag.blockage: sampler unavailable');
      if (s.sampler) w.progressWiring!.validateSnapshot(s.sampler);
      // A sampled (pre-push) ledger is normalised in prepare instead.
      if (s.pushed && Array.isArray(s.ledger?.entries)) {
        for (const { entry, armed, last } of desEntries(s.ledger)) {
          if ((entry.state === 'armed') !== armed || armed && entry.lastChangeSec !== last)
            throw new Error(`diag.blockage: ledger disagrees with the lifecycle of ${entry.unitId}`);
        }
        const missing = missingUnits(s.ledger);
        if (missing.length) throw new Error(`diag.blockage: no ledger entry for ${missing.join(', ')}`);
      }
    }, s => {
      const state = { ...watch.prepareSnapshot(s), sampler: s.sampler };
      if (s.pushed) return state;
      // Sampler era (or an unbound capture): rows follow the component stamps; bound units without a
      // row (e.g. captured right after a mode-switch ledger reset) are added from them, never dropped.
      const fix = new Map(desEntries(state.ledger).map(d => [d.entry, d] as const));
      const time = snapshotTime();
      const added = missingUnits(state.ledger).flatMap(unitId => {
        const p = unitProgress(unitId);
        return p ? [[unitId, { unitId, kind: 'des' as const, instrumentedBy: 'des', count: 0, firstSeenSec: time,
          lastChangeSec: p.armed ? p.last! : time, state: p.armed ? 'armed' as const : 'inactive' as const }] as const] : [];
      });
      return { ...state, ledger: { ...state.ledger, entries: [...state.ledger.entries.map(([id, e]) => {
        const d = fix.get(e);
        return [id, !d ? e : d.armed ? { ...e, state: 'armed' as const, lastChangeSec: d.last! }
          : e.state === 'armed' ? { ...e, state: 'inactive' as const } : e] as const;
      }), ...added] } };
    });
  }
  const snapshotMasterSeed = (): number | undefined => {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.parts)) return undefined;
    const state: unknown = raw.parts.find(p => p && typeof p === 'object' && p.key === 'des.manager')?.state;
    if (!state || typeof state !== 'object' || Array.isArray(state) || !('masterSeed' in state)) return undefined;
    return typeof state.masterSeed === 'number' ? state.masterSeed : undefined;
  };
  const rng = rngParticipant(w.components, w.manager, snapshotMasterSeed, w.rngOwners);
  registry.register(rng);
  add('des.reservations', () => ({ records: w.manager.snapshotReservations().map(r => ({ ...r,
    holderId: idForPath(r.holderId), targetId: idForPath(r.targetId) })), nextId: w.manager.nextReservationId }), s => {
    if (!Number.isSafeInteger(s.nextId) || s.nextId < 1 || new Set(s.records.map(r => r.id)).size !== s.records.length)
      throw new Error('invalid reservations');
    for (const r of s.records) {
      if (!Number.isSafeInteger(r.id) || r.id < 1 || r.id >= s.nextId || r.state !== 'reserved' || !Number.isInteger(r.n) || r.n < 1)
        throw new Error('invalid reservation');
      component(r.holderId); component(r.targetId);
      if (r.carrier) muRef(r.carrier.ref.id, r.carrier.ref.gen);
    }
  }, s => ({ records: new Map(s.records.map(r => ({ ...r, holderId: component(r.holderId).path,
    targetId: component(r.targetId).path })).map(r => [r.id, r] as const)), nextId: s.nextId }));
  add('des.tweens', w.tweens, list => {
    for (const entry of list) {
      if (!Number.isFinite(entry.t0) || !Number.isFinite(entry.t1) || entry.t1 <= entry.t0
        || (entry.kind !== 'position' && entry.kind !== 'path' && entry.kind !== 'drive')) throw new Error('invalid tween');
      if (entry.kind === 'drive') {
        if (!w.drives.has(entry.driveRef) || ![entry.from, entry.to].every(Number.isFinite)
          || !['linear', 'scurve'].includes(entry.ease) || !['always', 'finalOnly'].includes(entry.writePolicy)
          || entry.t0 > (raw?.simTime ?? w.manager.currentTime)
            && entry.writePolicy !== 'finalOnly'
          || !Number.isSafeInteger(entry.eventId)
          || !(raw?.eventQueue ?? events).some(e => e.id === entry.eventId && e.time >= entry.t1 - 0.0011))
          throw new Error('invalid drive tween');
        continue;
      }
      // Complete schema here (plan-2059 review): TweenRegistry.fromSnapshot runs after the
      // live world was torn down, so nothing it dereferences may be missing or non-finite.
      const t = entry as unknown as { muId?: unknown; pathRef?: unknown; from?: unknown; to?: unknown; fromS?: unknown; toS?: unknown };
      if (!Number.isInteger(t.muId) || (t.muId as number) < 0) throw new Error('invalid tween muId');
      muRef(t.muId as number);
      const vec3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
      if (entry.kind === 'position' && (!vec3(t.from) || !vec3(t.to))) throw new Error('invalid position tween');
      if (entry.kind === 'path') {
        if (typeof t.pathRef !== 'string' || !t.pathRef || !Number.isFinite(t.fromS) || !Number.isFinite(t.toS))
          throw new Error('invalid path tween');
        if (!w.pathExists(t.pathRef)) throw new Error(`unknown path '${t.pathRef}'`);
      }
    }
  });
  const drives = driveParticipant(w.drives, w.taktDrives);
  registry.register(drives);
  add('des.signals', () => ({ values: new Map([...(w.signals?.getAll() ?? [])].map(([k, v]) => [w.signalKey?.(k, false) ?? k, v] as const).sort(([a], [b]) => a.localeCompare(b))), pins: new Map([...(w.signals?.getForced() ?? [])].map(([k, v]) => [w.signalKey?.(k, false) ?? k, v] as const).sort(([a], [b]) => a.localeCompare(b))) }), s => {
    if (!(s.values instanceof Map) || !(s.pins instanceof Map)) throw new Error('invalid signals');
    for (const [name, value] of [...s.values, ...s.pins])
      if (typeof name !== 'string' || (typeof value !== 'boolean' && typeof value !== 'number')) throw new Error('invalid signal value');
  }, s => s, { codecs: { values: 'map', pins: 'map', 'values[][1]': 'number-tags', 'pins[][1]': 'number-tags' } });
  for (const [id, c] of w.components) {
    add(id, () => { const { path: _path, ...s } = c.toSnapshot();
      return { ...s, blocked: c.snapshotBlockedMUs().map(([target, mus]) =>
        ({ target: idOf(target), mus: mus.map(mu => mu.id), since: c.blockedSinceOf(target) })) }; }, s => {
      if (!Array.isArray(s.muIds) || !s.prop || typeof s.prop !== 'object' || !s.stateTimings || typeof s.stateTimings !== 'object'
        || typeof s.currentStateName !== 'string' || !Number.isFinite(s.state)) throw new Error('invalid component state');
      if (!Number.isFinite(s.stateStartTime) || s.stateStartTime > (raw?.simTime ?? w.manager.currentTime))
        throw new Error('invalid stateStartTime');
      if (!Number.isSafeInteger(s.pendingTransferCommits) || s.pendingTransferCommits! < 0)
        throw new Error('invalid pending transfer count');
      for (const id of s.muIds) muRef(id);
      for (const b of s.blocked) { component(b.target); b.mus.forEach(id => muRef(id)); }
      progressState(c, s);
      checkRefs(s);
      const saved = s as { behaviourState?: unknown; frozen?: FrozenDescriptor[]; selfRunState?: { fsmState?: string } };
      if (saved.frozen !== undefined) validateFrozen(saved.frozen, muRef, w.pathExists);
      c.validateBehaviourState?.(saved.behaviourState, {
        componentId: id, events: raw?.eventQueue ?? events, frozen: saved.frozen ?? [],
        fsmState: saved.selfRunState?.fsmState, prop: s.prop,
        hasMU: (id, gen) => savedMUIndex().byId.get(id)?.generation === gen,
        ownsMU: (id, gen) => s.muIds.includes(id) && savedMUIndex().byId.has(id)
          && (gen === undefined || savedMUIndex().byId.get(id)?.generation === gen),
      });
    }, s => ({ blocked: s.blocked.map(b => [component(b.target), b.mus.map(id => preparedSlots[id]!)]),
      blockedSince: s.blocked.map(b => b.since ?? snapshotTime()), state: { ...s, ...progressState(c, s), path: c.path }, mus: s.muIds.map(id => {
      const mu = preparedSlots[id]; if (!mu) throw new Error(`unknown MU '${id}'`); return mu;
    }) }));
  }
  for (const p of registry.order()) {
    const c = w.components.get(p.key);
    if (c) Object.assign(p, { owner: c, stateKeys: componentStateKeys, services: [...componentServices, ...(w.componentExtraServices?.get(p.key) ?? [])] });
    if (p.key === 'diag.blockage') Object.assign(p, { owner: w.blockageWatch,
      stateKeys: ['on', 'since', 'lastReport'],
      // Context is live wiring (ledger/budgets are captured through it); interval is fixed config.
      services: ['context', 'sampleEverySec'] });
  }
  const encode = (data: unknown) => {
    if (data && typeof data === 'object' && 'rvScriptHook' in data) {
      const d = data as unknown as { dispatcher: unknown; hook: string; mu: unknown; data?: unknown };
      return toSnapshotData({ hook: d.hook, desId: scripts.idOf(d.dispatcher), mu: d.mu, data: d.data ?? null }, { participant: 'des.queue' });
    }
    if (data && typeof data === 'object' && 'mu' in data) {
      const { mu, ...rest } = data as { mu?: unknown; [key: string]: unknown };
      if (mu != null) {
        const id = (mu as DESMU).id;
        if (w.manager.getMU(id) !== mu) throw Object.assign(new Error('des-snapshot-contract: des.queue.mu: unregistered live MU'),
          { code: 'des-snapshot-contract', participant: 'des.queue', path: 'mu' });
        rest.muId = id;
      }
      data = rest;
    }
    if (data && typeof data === 'object' && 'data' in data) {
      const d = data as Record<string, unknown>;
      data = { ...d, data: w.jsonPayload(d.data) };
    }
    const json = toSnapshotData(data, { participant: 'des.queue' });
    checkRefs(json);
    return json;
  };
  const events = raw?.eventQueue ?? (restoring ? [] : w.manager.exportQueue(entityId => {
    const c = w.manager.getComponentByEntityId(entityId);
    if (!c) throw new Error(`unknown entity '${entityId}'`);
    return idOf(c);
  }, encode)).map(e => !raw && e.action === 'Script.Hook' && e.data && typeof e.data === 'object' && 'desId' in e.data
    ? { ...e, componentId: String(e.data.desId) } : e);
  const participants = new Set(registry.order().map(p => p.key));
  const queueContext = { participants, desOwners: participants, replanOnRestore: w.replanOnRestore,
    componentTypeOf: (id: string) => scripts.has(id) ? 'Script' : w.components.has(id) ? raw?.fingerprint.components.find(c => c.id === id)?.type
      ?? (w.components.get(id) as DESComponent & { def?: { type: string } }).def?.type ?? 'DESComponent' : undefined };
  function prepareQueue() {
    assertPersistableQueueOrThrow(events, queueContext);
    const queue = new DESEventQueue();
    const data = new Map<number, unknown>();
    for (const mu of preparedSlots) if (mu) mu.pendingEvents = 0;
    const persisted = events.filter(e => {
      const schema = getActionSchema(e.action);
      return schema !== 'non-persistent' && !schema?.nonPersistent;
    });
    queue.restoreWithIds(persisted.map(e => {
      const actionIndex = ACTION_INDEX.get(e.action);
      if (actionIndex === undefined) throw new Error(`unknown action '${e.action}'`);
      if (e.muId !== -1) {
        muRef(e.muId);
        const mu = preparedSlots[e.muId];
        if (!mu) throw new Error(`unknown MU '${e.muId}'`);
        mu.pendingEvents = (mu.pendingEvents ?? 0) + 1;
      }
      if (e.data !== undefined) {
        const d = fromSnapshotData(e.data, { participant: 'des.queue' });
        if (e.action === 'Script.Hook') {
          const payload = d as { desId: string; hook: string; mu: unknown; data: unknown };
          if (payload.desId !== e.componentId) throw new Error('script hook owner mismatch');
          data.set(e.id, { rvScriptHook: true, ...payload, dispatcher: scripts.dispatcher(payload.desId) });
        } else {
          checkRefs(d);
          if (d && typeof d === 'object' && 'data' in d) {
            d.data = decodeHookPayload(d.data, { raw, componentId: e.componentId, eventId: e.id, time: e.time });
          }
        }
        if (d && typeof d === 'object' && 'muId' in d) {
          const id = (d as { muId: number }).muId; muRef(id);
          (d as { mu?: DESMU }).mu = preparedSlots[id]!;
        }
        if (e.action !== 'Script.Hook') data.set(e.id, d);
      }
      return { ...e, actionIndex, entityId: e.action === 'Script.Hook' || e.componentId === null ? -1 : component(e.componentId).entityId };
    }), raw?.nextEventId ?? w.manager.nextEventId);
    return { queue, data };
  }
  // The late prepare validates/allocates the queue before any commit.
  const managerPart = registry.order().find(p => p.key === 'des.manager')!;
  // Manager fields are classified independently of component owners above.
  Object.assign(managerPart, { owner: w.manager,
    stateKeys: ['queue', '_mus', '_freeMuIds', '_muGenerations', '_retireAfterEvent', '_reservations', '_nextReservationId',
      '_currentTime', '_totalEventsProcessed', '_statResetTime', '_statResetDone', '_masterSeed', '_rng',
      '_lastListenerTime', '_completeNotified', '_checkpointEventId', '_warmupEventId', '_eventData', 'customIdCounter'],
    services: ['restHold', 'onPostDispatch', '_components', '_componentPaths', 'onEventConsumed', '_lastFailedEvent', 'onMURetired',
      'onHierarchyChanged', 'onReservationsRolledBack', '_isPaused', '_mode', '_duration', '_processingTarget',
      '_processingTargetAlreadyReached', '_rngVersion', '_streams', '_maxEventsPerBatch', 'onTimeAdvance',
      '_timeAdvanceListeners', 'onBeforeReset', 'onCheckpoint', '_ctx'] });
  const prepareManager = managerPart.prepare.bind(managerPart);
  managerPart.prepare = json => ({ state: prepareManager(json), queue: prepareQueue() });
  return { registry, events, queueContext,
    restoreSampler() {
      const state = staged.get('diag.blockage') as { sampler?: ReturnType<ProgressWiring['snapshotState']> } | undefined;
      if (state?.sampler) w.progressWiring!.restoreSnapshot(state.sampler, (id, gen) => (w.manager.getMUByRef({ id, gen }) as DESMU | null)?.visual ?? null);
    },
    restoredHookPayloads: () => (staged.get('des.manager') as { queue: ReturnType<typeof prepareQueue> }).queue.data,
    persistedEvents: () => { assertPersistableQueueOrThrow(events, queueContext); return events.filter(e => {
      const schema = getActionSchema(e.action); return schema === 'non-persistent' ? false : !schema?.nonPersistent;
    }); },
    apply(time: number) {
      // Inputs are replaced silently before drive state; subscriptions must not
      // overwrite a captured drive with a never-delivered model start value.
      const signals = staged.get('des.signals') as { values: Map<string, boolean | number>; pins: Map<string, boolean | number> };
      w.signals?.replaceForcePins(new Map([...signals.pins].map(([k, v]) => [w.signalKey?.(k, true) ?? k, v])));
      w.signals?.restoreValuesSilently(new Map([...signals.values].map(([k, v]) => [w.signalKey?.(k, true) ?? k, v])));
      const mu = staged.get('des.mus') as MUState & { slots: (DESMU | null)[] };
      for (const [id, c] of w.components) c.fromSnapshot((staged.get(id) as { state: DESComponentSnapshot }).state, time);
      w.manager.replaceMUSlots(mu.slots, mu.freeSlots, mu.generations, mu.pendingRetire ?? []);
      for (const [id, c] of w.components) {
        const prepared = staged.get(id) as { mus: DESMU[]; blocked: Array<[DESComponent, DESMU[]]>; blockedSince: number[] };
        c.restoreMURefs(prepared.mus, prepared.blocked, prepared.blockedSince);
      }
      drives.apply();
      rng.apply();
      const reservations = staged.get('des.reservations') as { records: Map<number, ReservationRecord>; nextId: number };
      w.manager.swapPreparedReservations(reservations.records, reservations.nextId);
      const manager = staged.get('des.manager') as { state: ReturnType<DESManager['exportRunState']>; queue: ReturnType<typeof prepareQueue> };
      w.manager.applyRunState(manager.state, time);
      w.manager.swapPreparedQueue(manager.queue.queue, manager.queue.data);
      scripts.apply();
      for (const c of w.components.values()) {
        const result = c.onRestored?.() as unknown;
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false) throw result;
      }
      // Not a second rejection point after commit (the live world is already replaced).
      for (const [id, c] of w.components) if (c._repairProgress(time)) console.warn(`[DES] ${id}: progress lifecycle re-stamped after restore`);
      for (const m of mu.slots) if (m?.isLoaded && m.loadedOn && !m.parentMU) (m.loadedOn as DESComponent).loadMU(m, m.loadedOnNode ?? undefined);
      parentHierarchyVisuals(mu.slots.filter((m): m is DESMU => m !== null));
      if (w.blockageWatch) w.blockageWatch.restoreSnapshot(staged.get('diag.blockage') as ReturnType<BlockageWatch['snapshotState']>);
      return staged.get('des.tweens') as TweenDataSnapshot[];
    },
  };
}
