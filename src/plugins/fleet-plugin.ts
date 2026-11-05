// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Snapshottable } from './des/rv-snapshot-registry';
import type { Object3D } from 'three';
import type { RVViewer } from '../core/rv-viewer';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { PluginContext, SimLoopFacade } from '../core/rv-plugin-context';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { getDefaultAgvFleet } from '../core/engine/rv-agv-fleet';
import { clearProblem, reportProblem } from '../core/hmi/problems-store';
import {
  PLANT_PLUGIN_API_VERSION, type PlantParameterContext, type PlantPluginDefinition,
} from '../core/fleet/define-plant-plugin';
import type { FleetKernelAdapters } from '../core/fleet/exec/backends';
import type { FleetJobRunner } from '../core/fleet/exec/job-runner';
import type { ContinuousHandover } from '../core/fleet/continuous/handover';
import type { PlanningChange, PlanningHandle, PlanningRegistry } from '../core/planning/rv-planning-registry';
import type { DesLifecycleEvent } from '../core/material-flow/simulation-kernel';
import { findDesManager } from '../core/material-flow/des-manager-settings';
import type { DESRunner } from './des/des-runner';
import type { DesHandoverBackend } from './des/fleet/des-handover';
import type { RngFactory } from '../core/fleet/core/order-sources';
import { SFC32 } from '../core/rv-rng-distribution';
import { fleetSnapshotProvider } from './fleet-snapshot-participants';
import { fleetJobsProvider } from './fleet-job-participants';
import type { DesLift } from './des/fleet/des-lift';
import { getDefaultZoneRegistry } from '../core/engine/rv-zone-registry';
import { getDefaultPathNetwork } from '../core/engine/rv-path-network';

/** Seed of a scene without a positive DESManager seed — the DES manager's own default. */
const DEFAULT_MASTER_SEED = 42;

/**
 * RNG stream of a plant's fleet takt (plan-2051): an offset on the master seed far
 * above any DES entity id (component streams are `masterSeed + entityId`), plus a
 * hash of the plant id so two plants never share a stream.
 */
export function fleetRngStream(plantId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < plantId.length; i++) h = Math.imul(h ^ plantId.charCodeAt(i), 0x01000193) >>> 0;
  return 0x40000000 + (h & 0x00ffffff);
}

/**
 * A fresh fleet RNG for one bind (plan-2051), `new SFC32(masterSeed + stream)` —
 * the same derivation as `DESManager.createComponentRng(stream)`. DES: the run's
 * master seed (`runner.masterSeed`, incl. batch/API overrides); continuous (no
 * DES manager): the scene's DESManager seed, resolved like the DES runner
 * resolves it (positive scene seed, else the default) — so the same scene seed
 * gives the same takt stream in both kernels.
 */
export function deriveFleetRng(plantId: string, runner: DESRunner | null, root: Object3D): SFC32 {
  let masterSeed: number;
  if (runner) masterSeed = runner.masterSeed;
  else {
    const sceneSeed = findDesManager(root)?.masterSeed ?? 0;
    masterSeed = sceneSeed > 0 ? sceneSeed : DEFAULT_MASTER_SEED;
  }
  return new SFC32(masterSeed + fleetRngStream(plantId));
}

/** One shared legacy stream, or a named v2 stream for each output purpose. */
export function deriveFleetRngFactory(plantId: string, runner: DESRunner | null, root: Object3D): RngFactory {
  if (runner?.rngVersion === 2) return (purpose) => runner.getManager().stream(plantId, purpose);
  const legacy = deriveFleetRng(plantId, runner, root);
  return () => legacy;
}

export interface FleetBindContext {
  readonly root: Object3D;
  readonly viewer: RVViewer;
  readonly cfg: PlantPluginDefinition['config'];
  readonly definition: PlantPluginDefinition;
  readonly planning: PlanningHandle | null;
}

/** Project binding only. Results match the existing yard bind functions structurally. */
export interface FleetSceneBinder {
  snapshotParticipants?(runtime: FleetJobRunner): Snapshottable[];
  /**
   * Asked at every reset: true drops the binding, so the next start binds against the current scene
   * (for example when the set of active vehicles changed). False keeps the binding — the old reset.
   */
  rebindOnReset?(): boolean;
  bindContinuous(ctx: FleetBindContext):
    { ok: true; backend: ContinuousHandover } | { ok: false; missing: string[]; pending: boolean };
  bindDes(ctx: FleetBindContext & { runner: DESRunner }):
    { ok: true; backend: DesHandoverBackend } | { ok: false; missing: string[]; pending: boolean };
  /** Construct, but do not start: the plugin owns start/reset/dispose. */
  createRun(adapters: FleetKernelAdapters, ctx: FleetBindContext): FleetJobRunner;
  /** Apply project config to its run (dispatcher and sources), without replacing the run. */
  reconfigure(runtime: FleetJobRunner, config: NonNullable<PlantPluginDefinition['config']>): void;
  /** Project presentation follows the owner's run; it never owns binding. */
  onBound?(runtime: FleetJobRunner, ctx: FleetBindContext): void;
  onFrame?(runtime: FleetJobRunner): void;
  onReset?(): void;
  onUnbind?(): void;
  reportBindGap?(missing: readonly string[], ctx: FleetBindContext): void;
  reportSnapshot?(): void;
}

/** One lifecycle owner; no node discovery, geometry, or project-specific configuration. */
export class FleetPlugin implements RVViewerPlugin {
  readonly id: string;
  readonly order = 200;
  readonly definition: PlantPluginDefinition;
  runtime: FleetJobRunner | null = null;
  bindTrigger: string | null = null;
  get bindGeneration(): number | null { return this.generation; }
  private viewer: RVViewer | null = null;
  private root: Object3D | null = null;
  private simLoop: SimLoopFacade | null = null;
  private config: PlantPluginDefinition['config'];
  private planning: PlanningHandle | null = null;
  private declared = false;
  private parametersDisposed = false;
  private disposers: Array<() => void> = [];
  private waitSourcesOff: (() => void)[] = [];
  private tickOff: (() => void) | null = null;
  private lifecycleOff: (() => void) | null = null;
  private kernel: RVViewer['simulationKernel'] | null = null;
  private runner: DESRunner | null = null;
  private manager: unknown = null;
  private generation: number | null = null;
  private snapshotProviderOff: (() => void) | null = null;
  private ready = false;
  private readyRequest = 0;
  private pendingTrigger: string | null = null;
  private documentEpoch = 0;
  private sceneDirty = false;
  private resetting = false;
  private disposed = false;

  constructor(def: PlantPluginDefinition, private readonly binder?: FleetSceneBinder) {
    this.id = def.id;
    const problemId = `plant-plugin-api-version:${def.id}`;
    if (def.apiVersion !== PLANT_PLUGIN_API_VERSION) {
      reportProblem({ id: problemId, code: 'plant-plugin-api-version', severity: 'warning',
        title: `Plant ${def.id}: unsupported API version`,
        detail: `API version ${String(def.apiVersion)} is unsupported; expected ${PLANT_PLUGIN_API_VERSION}. Project overrides are ignored.` });
      this.definition = { apiVersion: PLANT_PLUGIN_API_VERSION, id: def.id };
    } else {
      clearProblem(problemId);
      this.definition = def;
    }
    this.config = this.definition.config;
  }

  init(viewer: RVViewer, context?: PluginContext): void {
    this.viewer = viewer;
    this.simLoop = context?.simLoop ?? viewer._simLoop;
    const on = (name: string, fn: () => void): void => {
      this.disposers.push((viewer as unknown as { on(n: string, f: () => void): () => void }).on(name, fn));
    };
    on('placements-materialized', () => this.requestBind(true, 'placements-materialized'));
    on('layout-content-added', () => this.requestBind(true, 'layout-content-added'));
    on('simulation-mode-changed', () => {
      this.ensureLifecycle();
      if (this.ready) this.tryBind('simulation-mode-changed');
      else this.requestBind(false, 'simulation-mode-changed');
    });
    on('simulation-run-started', () => {
      if (this.ready) this.tryBind('simulation-run-started');
      else this.requestBind(false, 'simulation-run-started');
    });
    on('simulation-reset', () => {
      this.runtime?.prepareReset();
      this.binder?.onReset?.();
      if (this.binder?.rebindOnReset?.()) this.unbind();
    });
    on('simulation-start', () => {
      const previous = this.runtime;
      this.tryBind('simulation-start');
      // A kept binding restarts without reconstruction: re-derive its RNG first (plan-2051),
      // so a changed scene seed takes effect and the same seed replays the same stream.
      if (previous && this.runtime === previous) { this.reseed(); previous.start(); }
    });
    this.disposers.push(getDefaultAgvFleet().onRegister(() => this.runtime?.kick()));
    this.ensureLifecycle();
  }

  onModelLoaded(result: LoadResult): void {
    this.clearDocument();
    this.root = result.root;
    this.config = this.definition.config;
    this.parametersDisposed = false;
    this.definition.parameters?.adoptDocument(result.root, this.parameterContext());
    this.declarePlanning();
    this.requestBind();
  }

  onModelCleared(): void { this.clearDocument(); }
  onRender(): void {
    if (this.runtime) { this.runtime.frame(); this.binder?.onFrame?.(this.runtime); }
  }

  /** Join the load AND its deferred placements; invalidate queued work on clear/dispose. */
  private requestBind(changed = false, trigger = 'scene-ready'): void {
    const viewer = this.viewer;
    if (!viewer || !this.root || this.disposed) return;
    this.ready = false;
    this.sceneDirty ||= changed;
    if (this.pendingTrigger !== 'des-lifecycle') this.pendingTrigger = trigger;
    const request = ++this.readyRequest;
    const epoch = this.documentEpoch;
    // The viewer's placement listener resets DES in the same event stack, after ours.
    queueMicrotask(() => {
      if (this.disposed || epoch !== this.documentEpoch || request !== this.readyRequest) return;
      void viewer.whenSceneReady().then(() => {
        if (this.disposed || epoch !== this.documentEpoch || request !== this.readyRequest) return;
        this.ready = true;
        const reason = this.pendingTrigger ?? trigger;
        this.pendingTrigger = null;
        this.tryBind(reason);
      }).catch(error => {
        if (!this.disposed && epoch === this.documentEpoch && request === this.readyRequest) this.reportBind([String(error)]);
      });
    });
  }

  private ensureLifecycle(): void {
    const kernel = this.viewer?.simulationKernel ?? null;
    if (kernel === this.kernel) return;
    this.lifecycleOff?.();
    this.lifecycleOff = null;
    this.unbind();
    this.kernel = kernel;
    if (kernel) this.lifecycleOff = kernel.onDesLifecycle(e => this.onDesLifecycle(e), { replay: true });
  }

  private onDesLifecycle(event: DesLifecycleEvent): void {
    if (this.disposed) return;
    if (event.type === 'reset' || event.type === 'disposed') {
      if (this.runtime?.adapters.kind === 'des') this.unbind();
    } else if (event.type === 'bound') {
      if (this.ready) this.tryBind('des-lifecycle');
      else this.requestBind(false, 'des-lifecycle');
    }
    else if (event.type === 'restored' && this.runtime?.adapters.kind === 'des') {
      // The backend clock re-arms this run once; don't mistake the new generation for a rebind.
      this.generation = event.generation;
    }
  }

  tryBind(trigger = 'direct'): void {
    const viewer = this.viewer;
    const root = this.root;
    if (!viewer || !root || !this.ready || this.disposed || this.resetting || viewer.inStructuralEdit) return;
    this.ensureLifecycle();
    if (!this.ready) return;
    this.declarePlanning();
    if (!this.binder) return;
    const kernel = viewer.simulationKernel;
    const runner = kernel?.mode === 'des' ? kernel.desControl() as DESRunner | null : null;
    const generation = runner?.lifecycleGeneration ?? null;
    const manager = runner?.getManager() ?? null;
    if (this.runtime && (this.runner !== runner || this.generation !== generation || this.manager !== manager)) this.unbind();
    if (kernel?.mode === 'des' && (!runner || runner.liveInstances.length === 0
      || (kernel.hasDesLifecycle() && runner.lifecycleState !== 'bound'))) return;
    if (this.runtime && (!this.sceneDirty || runner !== null) && this.runner === runner
      && this.generation === generation && this.manager === manager) { this.sceneDirty = false; return; }
    this.unbind();
    const ctx: FleetBindContext = { root, viewer, cfg: this.config, definition: this.definition, planning: this.planning };
    const result = runner
      ? this.binder.bindDes({ ...ctx, runner })
      : this.binder.bindContinuous(ctx);
    if (!result.ok) {
      if (!result.pending) {
        if (this.binder.reportBindGap) this.binder.reportBindGap(result.missing, ctx);
        else this.reportBind(result.missing);
      }
      return;
    }
    const backend = result.backend;
    try {
      this.runtime = this.binder.createRun(backend, ctx);
      if (runner) {
        const dispatcher = this.runtime.dispatcher;
        const offFleet = runner.registerSnapshotProvider(this.definition.id + ':fleet', fleetSnapshotProvider({
          orders: dispatcher.orders,
          stationKnown: id => { try { dispatcher.station(id); return true; } catch { return false; } },
          zones: getDefaultZoneRegistry(), paths: getDefaultPathNetwork(),
        }));
        // plan-2059 phase 6: the execution state (runner, dispatcher, timers, lift, hand-over, project KPIs).
        const runtime = this.runtime, binder = this.binder, des = backend as unknown as DesHandoverBackend;
        const offJobs = runner.registerSnapshotProvider(this.definition.id + ':jobs', ({ raw }) =>
          [...fleetJobsProvider(runtime, des.lift as unknown as DesLift, des, raw), ...(binder.snapshotParticipants?.(runtime) ?? [])]);
        this.snapshotProviderOff = () => { offJobs(); offFleet(); };
      }
      if (viewer.waitRegistry) {
        const runtime = this.runtime;
        // The wrappers carry what the sources declare (plan-2241): endpoint domain and vocabulary.
        // Reservation owners are vehicle ids; per-edge flags (`ownerMUs`) ride on the edges themselves.
        this.waitSourcesOff.push(
          viewer.waitRegistry.addSource({ id: `${this.id}:fleet`, vehicles: runtime.waitWatch.vehicles,
            kinds: () => runtime.waitWatch.kinds(), edges: now => runtime.waitWatch.edges(now) }),
          viewer.waitRegistry.addSource({ id: `${this.id}:reservations`, vehicles: true,
            edges: now => runtime.dispatcher.reservations.edges(now) }),
        );
      }
      this.runner = runner;
      this.generation = generation;
      this.manager = manager;
      this.bindTrigger = trigger;
      this.sceneDirty = false;
      // plan-2051: a fresh takt RNG per bind, derived like runner/generation/manager above.
      this.reseed();
      backend.onClockRestart = (why?: string) => {
        // 'restore': state already came from the snapshot (fleet.clock + fleet participants) - no start (plan-2059 2.1).
        if (why === 'restore') return;
        // 'restore-replan': a restore without a fleet snapshot part - the fleet restarts as before.
        if (why === 'restore-replan') this.reportSnapshot();
        this.reseed();
        this.runtime?.start();
      };
      if (backend.kind === 'des') backend.onSnapshotRestored = () => {};
      this.runtime.start();
      if (backend.kind === 'continuous') this.tickOff = backend.attach(this.simLoop!);
      this.binder.onBound?.(this.runtime, ctx);
      clearProblem(`fleet-bind-incomplete:${this.id}`);
    } catch (error) {
      if (this.runtime) this.unbind(); else backend.dispose();
      throw error;
    }
  }

  /**
   * Set a freshly derived takt RNG on the bound run (plan-2051) — before every start
   * of it, never mid-run. Generic for every fleet project; the run only draws from it
   * when its TaktPlan is `stochastic`.
   */
  private reseed(): void {
    if (!this.runtime || !this.root) return;
    this.runtime.setRng(deriveFleetRngFactory(this.id, this.runner, this.root));
  }

  private parameterContext(): PlantParameterContext {
    const epoch = this.documentEpoch;
    const owner = this;
    return { root: this.root!, viewer: this.viewer!,
      get planning() { return epoch === owner.documentEpoch ? owner.planning : null; },
      get runtime() { return epoch === owner.documentEpoch ? owner.runtime : null; },
      prepareUnbind: () => { if (!this.disposed && epoch === this.documentEpoch) this.prepareUnbind(); },
      reconfigure: config => {
        if (this.disposed || epoch !== this.documentEpoch) return;
        this.config = config;
        if (this.runtime) this.binder?.reconfigure(this.runtime, config);
      } };
  }

  /** Replay a recorded protocol on the active run clock; reset/unbind drops pending rows. */
  replayChanges(log: readonly PlanningChange[]): void {
    const runtime = this.runtime;
    const registry = this.viewer?.getPlugin<{ id: string; registry: PlanningRegistry }>('planning-parameters')?.registry;
    if (!runtime || !registry) throw new Error('Planning replay requires an active fleet run');
    const epoch = this.documentEpoch;
    registry.replayChanges(log, (at, apply, opts) => {
      runtime.clock.schedule(at, () => {
        if (!this.disposed && this.runtime === runtime && this.documentEpoch === epoch) apply();
      }, opts);
    });
  }

  private declarePlanning(): void {
    const parameters = this.definition.parameters;
    if (this.declared || !parameters || !this.root || !this.viewer) return;
    const registry = this.viewer.getPlugin<{ id: string; registry: PlanningRegistry }>('planning-parameters')?.registry;
    if (!registry) return;
    const epoch = this.documentEpoch;
    const declaration = parameters.declare(this.root);
    if (!declaration) { this.declared = true; return; }
    this.planning = registry.declare({
      ...declaration,
      onLive: (change, applied, isValid, opts) => {
        const valid = () => !this.disposed && epoch === this.documentEpoch && (isValid?.() ?? true);
        const apply = () => { if (valid()) parameters.onLive(change, { ...this.parameterContext(), applied, isValid: valid }); };
        if (this.runtime && !opts?.alreadyScheduled) this.runtime.scheduleNow(apply, valid, { afterModelEvents: true }); else apply();
      },
      onStructuralReset: async (req, ctx) => {
        if (this.disposed || epoch !== this.documentEpoch || ctx.signal.aborted) throw new Error('Plant document changed');
        this.resetting = true;
        try {
          this.prepareUnbind();
          await parameters.onStructuralReset(req, { ...this.parameterContext(), ...ctx });
          if (this.disposed || epoch !== this.documentEpoch || ctx.signal.aborted) throw new Error('Plant document changed');
        } finally {
          if (epoch === this.documentEpoch) this.resetting = false;
          // The planning transaction owns the subsequent engine reset/start, also on rollback.
        }
      },
    });
    this.declared = true;
    parameters.afterDeclare?.(this.parameterContext());
  }

  private reportBind(missing: readonly string[]): void {
    reportProblem({ id: `fleet-bind-incomplete:${this.id}`, code: 'fleet-bind-incomplete', severity: 'warning',
      title: `Plant ${this.id}: scene incomplete`, detail: `Missing: ${missing.join(', ')}.` });
  }


  private reportSnapshot(): void {
    if (this.binder?.reportSnapshot) { this.binder.reportSnapshot(); return; }
    reportProblem({ id: `fleet-snapshot-unsupported:${this.id}`, code: 'fleet-snapshot-unsupported', severity: 'warning',
      title: `Plant ${this.id}: DES snapshot unsupported`,
      detail: 'Fleet orders, carried loads, pauses and battery state are not part of the DES snapshot. The fleet restarted; use Reset instead.' });
  }

  private unbind(): void {
    this.snapshotProviderOff?.();
    this.snapshotProviderOff = null;
    for (const off of this.waitSourcesOff) off();
    this.waitSourcesOff = [];
    this.tickOff?.();
    this.tickOff = null;
    this.binder?.onUnbind?.();
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) {
      const backend = runtime.adapters as DesHandoverBackend | ContinuousHandover;
      backend.onClockRestart = null;
      if (backend.kind === 'des') backend.onSnapshotRestored = null;
      runtime.dispose();
    }
    this.runner = null;
    this.manager = null;
    this.generation = null;
    this.bindTrigger = null;
  }

  /** The sole owner releases tasks and visuals before a project mutates the scene. */
  prepareUnbind(): void {
    this.runtime?.prepareReset();
    this.binder?.onReset?.();
    this.unbind();
  }

  private clearDocument(): void {
    this.documentEpoch++;
    this.readyRequest++;
    this.ready = false;
    this.pendingTrigger = null;
    this.resetting = false;
    this.unbind();
    this.planning?.dispose();
    this.planning = null;
    this.declared = false;
    if (this.root && !this.parametersDisposed) {
      this.definition.parameters?.dispose();
      this.parametersDisposed = true;
    }
    this.root = null;
    this.sceneDirty = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearDocument();
    this.lifecycleOff?.();
    this.lifecycleOff = null;
    this.kernel = null;
    for (const off of this.disposers.splice(0)) off();
    if (!this.parametersDisposed) this.definition.parameters?.dispose();
    this.parametersDisposed = true;
    this.viewer = null;
  }
}
