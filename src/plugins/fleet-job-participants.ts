// SPDX-License-Identifier: AGPL-3.0-only
import type { TaktSource, PauseSource, PreparedTaktSource } from '../core/fleet/core/order-sources';
import type { WaitWatch, PreparedWaitWatch } from '../core/fleet/exec/wait-watch';
import type { Snapshottable } from './des/rv-snapshot-registry';

export interface FleetSourceWorld { takt: TaktSource; pause: PauseSource; wait: WaitWatch }

export function fleetSourceParticipants({ takt, pause, wait }: FleetSourceWorld): Snapshottable[] {
  return [{
    key: 'fleet.takt', version: 1, dependencies: ['fleet.clock'], owner: takt,
    stateKeys: ['states', 'handles', 'generation', 'rng', 'rngStart'], services: ['clock', 'plan', 'count', 'hooks', 'rngs', 'outputIds'],
    capture: () => takt.exportState(), validate: json => takt.validateState(json),
    prepare: json => takt.prepareState(json), commit: p => takt.swapState(p as PreparedTaktSource),
  }, {
    key: 'fleet.pause', version: 1, dependencies: ['fleet.clock'], owner: pause,
    stateKeys: ['generation'], services: ['clock', 'plan', 'count', 'hooks'],
    capture: () => pause.exportState(), validate: json => pause.validateState(json),
    prepare: json => pause.prepareState(json), commit: p => pause.swapState(p as { generation: number }),
  }, {
    key: 'fleet.wait', version: 1, dependencies: ['fleet.clock'], owner: wait,
    stateKeys: ['waits', 'kindStats', 'defaultLimit', 'nextToken'], services: ['id', 'clock', 'sink', 'cancelOnEnd', 'onTimeout', 'resolver'],
    capture: () => wait.exportState(), validate: json => wait.validateState(json),
    prepare: json => wait.prepareState(json), commit: p => wait.swapState(p as PreparedWaitWatch),
  }];
}

import type { FleetDispatcher, PreparedFleetDispatcher } from '../core/fleet/core/dispatcher';

/**
 * Order ids of the snapshot's `fleet.orders` part (open orders), or null when the part is absent / raw is absent.
 * Lets the dispatcher participant refuse a dangling pick-job order in `validate`/`prepare` instead of at commit.
 */
export function snapshotOrderIds(raw: { parts?: ReadonlyArray<{ key: string; state: unknown }> } | undefined): ReadonlySet<number> | null {
  const part = raw?.parts?.find(p => p.key === 'fleet.orders');
  const open = (part?.state as { open?: ReadonlyArray<{ id?: unknown }> } | undefined)?.open;
  if (!Array.isArray(open)) return null;
  return new Set(open.map(o => o?.id).filter((id): id is number => typeof id === 'number'));
}

export function fleetDispatcherParticipant(dispatcher: FleetDispatcher, orderIds: ReadonlySet<number> | null = null): Snapshottable {
  const dangling = (json: unknown): string[] => {
    if (!orderIds) return [];
    const jobs = (json as { jobs?: ReadonlyArray<{ kind?: string; order?: unknown }> } | null)?.jobs;
    return Array.isArray(jobs) ? jobs.filter(j => j?.kind === 'pick' && typeof j.order === 'number' && !orderIds.has(j.order))
      .map(j => `pick job order ${String(j.order)} is not in fleet.orders`) : [];
  };
  return {
    key: 'fleet.dispatcher', version: 1, dependencies: ['fleet.orders'], owner: dispatcher,
    stateKeys: ['reservations', 'chargerQueue', 'jobs', 'late'],
    services: ['orders', 'options', 'picks', 'drops', 'chargers', 'stations', 'groups', 'groupOfPlace',
      'firstGroup', 'retrieval', 'retrievalContext'],
    capture: () => dispatcher.exportState(),
    // All participants prepare before orders commits. Resolve references at dispatcher commit.
    validate: json => [...dispatcher.validateState(json, false), ...dangling(json)],
    prepare: json => {
      const errors = dangling(json);
      if (errors.length) throw new Error(`fleet.dispatcher: ${errors.join('; ')}`);
      return dispatcher.prepareState(json, false);
    },
    commit: p => dispatcher.swapState(p as PreparedFleetDispatcher),
  };
}

import type { DesLift, PreparedLift } from './des/fleet/des-lift';
import type { DesHandoverBackend } from './des/fleet/des-handover';

export function fleetLiftParticipant(lift: DesLift): Snapshottable {
  return {
    key: 'fleet.lift', version: 1, dependencies: ['fleet.clock'], owner: lift,
    stateKeys: ['strokes'], services: ['runner', 'clock', 'drives', 'doneHandler', 'tweenIds', 'subscribedRunner', 'offLifecycle', 'disposed'],
    claimsDrives: () => lift.claimsDrives(),
    capture: () => lift.exportState(), validate: json => lift.validateState(json),
    prepare: json => lift.prepareState(json), commit: p => lift.swapState(p as PreparedLift),
  };
}

export function fleetHandoverParticipant(handover: DesHandoverBackend): Snapshottable {
  return {
    key: 'fleet.handover', version: 2, dependencies: ['fleet.clock'], owner: handover,
    stateKeys: ['pickWaiters', 'handovers', 'templateSizes'],
    services: ['kind', 'offOwnerSnapshot', 'offOwnerRestore', 'clock', 'lift', 'manager', 'onPalletReady', 'onInputFreed', 'onClockRestart',
      'onSnapshotRestored', 'carriers', 'floor', 'pickHandler', 'ownerList',
      'poses', 'disposed', 'offClockSnapshot', 'runner', 'root', 'outputs', 'inputs', 'vehicles', 'owners'],
    capture: () => handover.exportState(), validate: json => handover.validateState(json),
    prepare: json => handover.prepareState(json), commit: p => handover.swapState(p as ReturnType<DesHandoverBackend['prepareState']>),
  };
}

import type { FleetJobRunner, PreparedFleetRunner } from '../core/fleet/exec/job-runner';

/** Job kind per vehicle of the snapshot's `fleet.dispatcher` part, or null when the part / raw is absent. */
export function snapshotJobKinds(raw: { parts?: ReadonlyArray<{ key: string; state: unknown }> } | undefined): ReadonlyMap<string, string> | null {
  const jobs = (raw?.parts?.find(p => p.key === 'fleet.dispatcher')?.state as { jobs?: ReadonlyArray<{ vehicle?: unknown; kind?: unknown }> } | undefined)?.jobs;
  if (!Array.isArray(jobs)) return null;
  return new Map(jobs.filter(j => typeof j?.vehicle === 'string' && typeof j.kind === 'string').map(j => [j.vehicle as string, j.kind as string]));
}

/**
 * `jobKinds` (restore only): the staged dispatcher jobs of the snapshot. The live dispatcher still holds its OLD jobs
 * during prepare, so the runner's job link is checked against the snapshot's own dispatcher part instead.
 */
export function fleetRunnerParticipant(runner: FleetJobRunner, jobKinds: ReadonlyMap<string, string> | null = null): Snapshottable {
  const linkErrors = (json: unknown): string[] => {
    if (!jobKinds) return [];
    const vehicles = (json as { vehicles?: ReadonlyArray<{ id?: unknown; job?: unknown; terminalJob?: unknown }> } | null)?.vehicles;
    return Array.isArray(vehicles) ? vehicles.filter(v => typeof v?.id === 'string' && typeof v.job === 'string' && (v.terminalJob ? jobKinds.has(v.id) : jobKinds.get(v.id) !== v.job))
      .map(v => `fleet.runner: job link mismatch for ${String(v.id)} (runner ${String(v.job)}, dispatcher ${jobKinds.get(v.id as string) ?? 'none'})`) : [];
  };
  return {
    key: 'fleet.runner', version: 1, owner: runner,
    dependencies: ['fleet.clock', 'fleet.orders', 'fleet.dispatcher', 'fleet.takt', 'fleet.pause', 'fleet.wait', 'fleet.lift', 'fleet.handover'],
    stateKeys: ['_epoch', 'waitOwner', 'counters', 'firstJobs', 'jobRing', 'jobHead', 'jobCount', 'unbrakeableHolds', 'vehicles', 'dispatching', 'redispatch', 'pendingNow'],
    services: ['adapters', 'site', 'dispatcher', 'params', 'orders', 'clock', 'handover', 'lift', 'lamps', 'fleetName',
      'fleet', 'docks', 'zones', 'routes', 'waits', 'limits', 'socKey', 'decel', 'authority', 'signalScratch',
      'statusInput', 'locScratch', 'motionScratch', 'stationByPath', 'pickIds', 'dropIds', 'takt', 'pauses',
      'disposers', 'startPaths', 'ownerToken', 'disposed', 'dockReleases', 'orderKpis'],
    capture: () => runner.exportState(),
    // The dispatcher still has its old jobs during prepare; it commits before the runner.
    validate: json => [...runner.validateState(json, false), ...linkErrors(json)],
    prepare: json => {
      const errors = linkErrors(json);
      if (errors.length) throw new Error(errors.join('; '));
      return runner.prepareState(json, false);
    },
    commit: p => runner.swapState(p as PreparedFleetRunner),
    onRestore: () => runner.relinkStateJobs(),
  };
}

/**
 * Compose execution participants; clock and orders are provided by the outer providers.
 * `raw` (restore only) lets the dispatcher participant refuse a dangling pick-job order in prepare.
 */
export function fleetJobsProvider(runtime: FleetJobRunner, lift: DesLift, handover: DesHandoverBackend,
  raw?: { parts?: ReadonlyArray<{ key: string; state: unknown }> }): Snapshottable[] {
  const world = runtime.snapshotWorld();
  return [...fleetSourceParticipants(world), fleetDispatcherParticipant(world.dispatcher, snapshotOrderIds(raw)),
    fleetRunnerParticipant(runtime, snapshotJobKinds(raw)), fleetLiftParticipant(lift), fleetHandoverParticipant(handover)];
}
