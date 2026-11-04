// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>


import { describeLogicPresence, type DesLogicPresence, type DesSnapshotBlockers } from '../../core/material-flow/des-snapshot-blockers';
import { snapshotUserMessage } from '../../core/sdk/rv-des-snapshot-messages';
import { scriptTimerHandleRefs, scriptTimerQueueProblems, type ScriptSnapshotState } from './rv-des-script-participant';
import { scriptSeed32 } from '../../core/rv-rng-streams';
import { makeScriptHookScheduler } from './rv-des-script-hook';
import type { ScriptHookDispatcher, SdkScheduler } from '../../core/sdk/rv-script-hook';
import { DES_SCRIPTS_UNAVAILABLE_CODE, type WebComponentDesBinding, type WebComponentDesSinkRef, type WebComponentDesSinks } from '../../core/engine/rv-web-component-registry';

import { runnerParticipants } from './rv-des-runner-participants';
import { preflightSnapshotEnvelope } from './rv-des-preflight';
import type { DESSnapshotV4 } from './rv-des-snapshot-v4';
import { captureDetached } from './rv-snapshot-capture';
import { restoreTransaction, createDeferredReactions } from './rv-snapshot-restore';
import { ACTION_SCHEMA, getActionSchema } from './rv-des-named-actions';
import { finishDesRestore } from '../../core/material-flow/des-restore-guard';

import { collectFingerprintInput, type ModelInputHost } from './rv-des-model-input';
import { buildDesFingerprint, type FingerprintInput, type FingerprintResult, type FingerprintSceneNode } from './rv-des-fingerprint';
import { documentHashOf, whenDocumentHashesSettled } from '../../core/engine/rv-model-content-ledger';
import { modelEditEpoch } from '../../core/engine/rv-model-edit-epoch';
import type { ProgressLedger } from '../../core/diagnostics/rv-progress-ledger';
import type { WaitRegistry } from '../../core/diagnostics/rv-wait-registry';
/**
 * des-runner.ts -- `DESRunner implements SimulationExecutor` (Plan 194 §2.6 P5).
 *
 * The private DES executor behind the public `SimulationKernel`. It OWNS a
 * `DESManager` (event queue, named-action dispatch, RNG) and a public
 * `TweenRegistry`, builds a `MaterialFlowAdapter` (extends `DESComponent`) per
 * `MaterialFlowInstance`, runs the event loop, and drives the tween registry on
 * render. The kernel switches to it via Reset-on-Switch (clearMUs → start).
 *
 * Sub-modes (Plan 194 §3.2 / F10):
 *   - Animated (1×)     — `simNow += dt`; process events up to simNow; render 1:1.
 *   - HybridSynced (N×) — `simNow += dt · N`; process up to simNow; render 1:1.
 *                         B4 fix: a per-frame event BUDGET spreads a large batch
 *                         across frames (never drops events); when the budget is
 *                         hit the render clock is frozen at the real sim position
 *                         so visuals never outrun the events still to process.
 *   - FastForward       — jump straight to event time; NO render (tween write off).
 *   - Step              — process exactly one event per `step()`; optional render.
 *
 * Scheduling is GC-free (R3): `self.in('Arrival', mu, data)` namespaces the
 * short suffix to `<type>.<Suffix>` and resolves the integer action index from
 * a per-type map built ONCE at registration (`des-hook-adapter`).
 *
 * PRIVATE — imports `DESManager`/`DESComponent` (private). Never imported by the
 * public build; the kernel reaches it only through the injected factory
 * (`register-des-runner` → `createDesRunner`, falling back to the public stub).
 */

import { parseNodeAddress } from '../../core/engine/rv-node-id';
import { readComponentField } from '../../core/params/rv-param-field';
import { freezeVariant } from '../../core/variants/rv-variant-model';
import type { RunLease } from '../../core/hmi/rv-run-lease';
import type { VariantsPlugin } from '../variants';
import { RunIdentity } from './rv-des-run-identity';
import { componentMatches, parseTrackKey } from '../sim-controller/des-kpi-defs';
import { numericValue, rowSourceReader, type KpiSourceReader } from './des-kpi-track';
import { runScopeStore } from '../../core/material-flow/rv-run-history-store';
import { modelKeyOf, type ProjectManagerViewerLike } from '../../core/material-flow/rv-project-manager';
import { registerExperimentRunner, EXPERIMENT_METHODS, type ExperimentBackend } from './des-experiment-seam';
import type { SimDesControl } from '../../core/material-flow/simulation-kernel';
import { PLANNING_PRIORITY } from './rv-des-event';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import {
  trafficOwnedOf,
  type SimulationExecutor,
  type SimulationTopology,
  type MaterialFlowInstance,
} from '../../core/material-flow/simulation-executor';
import { getDefaultMovementAuthority } from '../../core/engine/rv-movement-authority';
import type { MaterialFlowDefinition } from '../../core/material-flow/define-material-flow';
import type {
  MaterialFlowSelf,
  TransferResult,
  SelfScheduler,
  MU,
  DesHookName,
  TweenSpec,
  FrozenDescriptor,
  FrozenTweenDescriptor,
  AcceptPose,
  PortResolveCacheScope,
} from '../../core/material-flow/material-flow-self';
import {
  TweenRegistry,
  type TweenSubMode,
  type PositionTweenTarget,
  type DriveTweenTarget,
  type PathTweenSampler,
  type PathTweenTarget,
  type TweenHandle,
  type TweenDataSnapshot,
} from '../../core/material-flow/tween-registry';
import { getDefaultPathNetwork } from '../../core/engine/rv-path-network';
import type { SnapshotProvider, SnapshotComponentProvider } from './rv-des-snapshot-provider';
import { getEngineSourceForNode } from '../../core/engine/rv-source';
import type { SimKpiSnapshot, SimEventStats, SimDesComponentState, SimDesStatistics, SimDesComponentStat, DesLifecycleEvent, DesLifecycleEventType, DesLifecycleListener, DesCallbackHandle } from '../../core/material-flow/simulation-kernel';
import type { DesRunCompleteReason, DesPeekResult } from '../../core/material-flow/simulation-kernel';
import type { CoreSubsystems } from '../../core/engine/rv-core-subsystems';
import { findDesManager } from '../../core/material-flow/des-manager-node';
import { yieldToBrowser, yieldToTimers } from '../../core/engine/rv-des-yield';
import { beginDesRestore, endDesRestore } from '../../core/material-flow/des-restore-guard';
import { reportProblem, clearProblem, clearProblemsOfCode } from '../../core/hmi/problems-store';
import { applyMuForwardToVisual } from '../../behaviors/_shared/mu-reference';
import { kindOf, sortByMaterialFlow } from './des-flow-order';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import type { RVDrive } from '../../core/engine/rv-drive';
import { releaseAllAxes } from '../../core/engine/rv-axis-ownership';
import { RVMovingUnit } from '../../core/engine/rv-mu';
import { DESManager, DESMode, DES_CALLBACK_ACTION } from './rv-des-manager';
import { ACTION_INDEX, registerAction, getActionName } from './rv-des-named-actions';
import { DES } from './rv-des-api';
import { computeAllStatistics, snapshotStatistics } from './rv-des-statistics';
import { MaterialFlowAdapter, type PoseTransferResult } from './material-flow-adapter';
import { registerDesHooks, type HookDispatch, type HookEventData } from './des-hook-adapter';
import { createDESMU } from './rv-des-mu';
import type { DESMU } from './rv-des-mu';
import { bindSceneToRunner, bindLoopSaturation, clearSceneBindingProblems, reconfigureInstancesFromExtras, releaseUnownedSignals } from './des-scene-binding';
import { findUnaddressable, type DesIdentityEntry, type DesUnaddressable } from './rv-des-identity';
import type { DESComponent } from './rv-des-component';
import { createDESGizmoBox } from './rv-des-gizmo-helpers';
import { isParamApplyBusy } from '../../core/params/rv-param-apply';
import { getDesRunSettings, updateDesRunSettings } from '../../core/hmi/des-run-settings-store';
import { movementSnapshotProvider } from './fleet/des-movement-participants';
import { encodeHookPayload } from './rv-des-hook-payload-codec';
import { legTweenWindow } from '../../core/engine/rv-leg-tween';
import { agvSelfForSnapshot } from '../../behaviors/Agv';
import { scopedInstanceId } from '../../core/engine/rv-instance-scope';

/**
 * Drives whose position is not DES run state: followers (Drive_Gear / Drive_FollowPosition) are
 * derived from their master every tick; a TransportSurface belt drive only scrolls the belt in
 * DES mode (DES moves the MUs, not the surface).
 */
function isFollowerDrive(drive: RVDrive): boolean {
  const extras = (drive.node.userData as { realvirtual?: Record<string, unknown> }).realvirtual;
  return !!extras && ('Drive_Gear' in extras || 'Drive_FollowPosition' in extras || 'TransportSurface' in extras);
}

/** DES sub-mode (Plan 194 §3.2). HybridSynced is NEW vs. the native DESMode enum. */
export type DesSubMode = 'animated' | 'hybrid' | 'fastforward' | 'step';
export type MuVisualFactory = () => DESMU['visual'];
export type MuVisualDisposer = (visual: NonNullable<DESMU['visual']>) => void;
export type MaterializeMuResult =
  | { readonly ok: true; readonly visual: RVMovingUnit; readonly created: boolean }
  | {
      readonly ok: false;
      readonly reason: 'invalid-mu' | 'retired' | 'missing-template' | 'instanced-visual' | 'factory-error';
      readonly message: string;
    };

/** Max events processed per Animated/Hybrid frame before spreading to the next (B4). */
const DEFAULT_FRAME_EVENT_BUDGET = 2000;

/** Main-thread time slice per FastForward yield cycle (plan-262 Phase 1). */
const FF_SLICE_MS = 12;
/** plan-2006 A3: at least one plain macrotask yield per this many ms — `scheduler.yield()`
 *  continuations run ahead of timers and starved them for a whole FastForward. */
const FF_TIMER_YIELD_MS = 50;
/** Events per deadline check inside a FastForward slice (granularity, NOT a cap). */
const FF_INNER_BATCH = 2000;

/** Module-level tween-endpoint scratch — reused every schedule (no per-event alloc). */
const _from = new Vector3();
const _to = new Vector3();
/** Materialisation placement scratch (plan-262 Phase 3, FF-exit only). */
const _matPos = new Vector3();
const _matQuat = new Quaternion();

/** Resolve a node by its hierarchy path under `root` (segments = node names).
 *  Tolerates a leading `root.name` segment. When the strict walk misses, falls
 *  back to a deep search for a UNIQUE node named like the last segment — so a
 *  bare node name ('Src', 'EuropalletLoaded') works for param overrides and
 *  `setField` scripts regardless of hierarchy depth. Ambiguity returns null. */
/** Viewer pause reason while an experiment batch holds the live simulation (plan-2005 Phase 7). */
export const DES_BATCH_PAUSE_REASON = 'des-experiment-batch';

function findNodeByPath(root: Object3D, path: string): Object3D | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  let cur: Object3D | null = root;
  let start = 0;
  if (parts[0] === root.name) start = 1;
  for (let i = start; i < parts.length; i++) {
    const next: Object3D | undefined = cur!.children.find((c) => c.name === parts[i]);
    if (!next) { cur = null; break; }
    cur = next;
  }
  if (cur) return cur;
  const leaf = parts[parts.length - 1];
  const hits: Object3D[] = [];
  root.traverse((o) => { if (o.name === leaf) hits.push(o); });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    console.warn(`[des] node name '${leaf}' is ambiguous (${hits.length}×) — use the full hierarchy path.`);
  }
  return null;
}

/**
 * Exhaustiveness guard for the TweenSpec dispatch (plan-268 §10 finding 1):
 * a NEW spec kind that `_attachTweenFromData` does not handle fails to COMPILE
 * here (the parameter would not be `never`), and malformed runtime data fails
 * LOUDLY instead of being silently mis-dispatched as a drive tween.
 */
function assertNever(x: never): never {
  throw new Error(
    `DES: unhandled TweenSpec kind '${String((x as { kind?: unknown } | null)?.kind)}'`,
  );
}

/** Problems code of a material-flow instance that disabled itself in setup. */
const DISABLED_PROBLEM_CODE = 'des-component-disabled';
/** Problems code of a DES event action that threw (`_actionFailed`); retired on dispose. */
const ACTION_FAILED_PROBLEM_CODE = 'des-action-failed';

/**
 * Problems entry for an instance whose shared setup disabled itself
 * (`self.disable(reason)`): it is registered but refuses every MU and runs no
 * hook (`MaterialFlowAdapter`), so the line stops in front of it — say why
 * instead of leaving a silent stall. Every start clears the code first and
 * re-reports, so a removed or repaired component loses its entry. Typical
 * cause: a material-flow type bound by its placement NAME onto a node
 * without the parts it needs (a virtual DES
 * 'Conveyor (Straight)' block has no Transport or Sensor node).
 */
function reportDisabledInstance(inst: RunnerInstance): void {
  const name = inst.self.root?.name || inst.adapter.node?.name || inst.def.type;
  if (!inst.self.disabled) return;
  reportProblem({
    id: `${DISABLED_PROBLEM_CODE}:${inst.adapter.node?.uuid ?? name}:${inst.def.type}`,
    severity: 'warning',
    code: DISABLED_PROBLEM_CODE,
    title: `'${name}' takes no part in the DES run (${inst.def.type} disabled)`,
    detail: `${inst.self.disabledReason ?? 'disabled during setup'}. The component accepts no parts, so the line `
      + 'stops in front of it. Use a component that carries the parts this type needs, or remove it.',
    nodePath: name,
  });
}

/** A live material-flow instance the runner owns (def + self + concrete adapter). */
export interface RunnerInstance {
  readonly def: MaterialFlowDefinition;
  readonly self: MaterialFlowSelf;
  readonly adapter: MaterialFlowAdapter;
  /** Set when the scene binding discovered this instance (plan-612 CP1d-b):
   *  `rebindScene()` drops exactly these. Absent for programmatic instances. */
  readonly scene?: SceneInstanceBinding;
  /**
   * plan-2059 Phase 1: the DES component id (`<plan-769 address>@<type>`,
   * `rv-des-identity.ts`), `null` when the instance is unaddressable (no
   * registry address, programmatic instance without an explicit id). Phase 1
   * only records it; the capture refuses unaddressable instances once
   * Phase 3 activates the snapshot contract.
   */
  readonly desId: string | null;
  /**
   * plan-2059 Phase 1: the instance node's LOCAL matrix at bind (column-major,
   * composed from position/quaternion/scale) — the rest pose the strict
   * fingerprint uses for a node the simulation itself moves (an Agv).
   */
  readonly bindPose: readonly number[];
  readonly bindPoses: ReadonlyMap<Object3D, readonly number[]>;
}

/** plan-2059 Phase 1: identity options of {@link DESRunner.addInstance}. */
export interface RunnerInstanceIdentity {
  /** The DES component id; omitted or `null` = unaddressable. */
  readonly desId?: string | null;
}

/** Local matrix of `node` composed from its TRS (never a possibly stale `.matrix`). */
function localPoseOf(node: Object3D): number[] {
  return new Matrix4().compose(node.position, node.quaternion, node.scale).toArray();
}

/** What the scene binding hands over for an instance it discovered. */
export interface SceneInstanceBinding {
  /** Dispose the instance's bind context (subscriptions, onDispose callbacks). */
  dispose(): void;
  /** The (scoped) signal names the instance declared. */
  readonly signals: readonly string[];
}

// -- Callback scheduler dispatch (plan-645 Phase 2) --
// `DES.Callback` is registered ONCE per page. The dispatcher resolves the runner
// by id at dispatch time; a disposed runner is gone from the table, so a stray
// event is a no-op.
const callbackRunners = new Map<number, { fireCallback(g: number, k: number): void }>();
let nextRunnerId = 1;
function ensureCallbackDispatcher(): void {
  if (ACTION_INDEX.has(DES_CALLBACK_ACTION)) return;
  registerAction(DES_CALLBACK_ACTION, (ctx) => {
    const d = ctx.data as { r?: unknown; g?: unknown; k?: unknown } | null;
    if (!d || typeof d.r !== 'number' || typeof d.g !== 'number' || typeof d.k !== 'number') return;
    callbackRunners.get(d.r)?.fireCallback(d.g, d.k);
  }, { owner: 'des.manager', payload: () => [], originRequired: true, nonPersistent: true });
}

/** Lifecycle state of the service (plan-645 L2 / R2-3). */
export type DesLifecycleState = 'idle' | 'bound' | 'ended' | 'disposed';

/**
 * Build options. `instances` are the material-flow components to simulate; each
 * carries the shared `self` (built in DES mode) and the node to anchor the
 * adapter. When omitted, the runner starts empty and `start()` is a no-op until
 * instances are added (the kernel passes definitions; full scene→instance
 * discovery is the model-load path, out of the runner's core).
 */
export interface DESRunnerOptions {
  /** Initial sub-mode (default 'animated'). */
  subMode?: DesSubMode;
  /** Per-frame event budget for Animated/Hybrid (B4 spreading). */
  frameEventBudget?: number;
  /** HybridSynced default multiplier. */
  multiplier?: number;
  /** Simulation duration in seconds (default 1 day). */
  durationSeconds?: number;
  /** Master PRNG seed (shared with continuous for comparability). */
  masterSeed?: number;
  /**
   * The viewer's CoreSubsystems pipeline (Phase B runtime unification). When
   * present, the runner composes it around the event advance: `earlyTick` runs
   * playback/logic/IK/replay, `tick` wraps the event queue with the drive loop
   * and the visual managers — so those subsystems keep ticking at 60 Hz in the
   * DES workspace exactly like they did when the viewer hard-wired them.
   */
  core?: CoreSubsystems;
}

/** Explicit batch/API seed, then positive scene seed, then the default. */
export function resolveSeed(override: number | null, scene: number | undefined, defaultSeed = 42): number {
  return override ?? (scene !== undefined && scene > 0 ? scene : defaultSeed);
}

export interface ScriptStateSource {
  node?: Object3D;
  desId?: string | null;
  source?: string;
  path: string;
  adapter: {
    setRunRngSeed?(seed: number | null, next?: () => number | null): void;
    captureScriptState(): ScriptSnapshotState | null;
    restoreScriptState(saved: ScriptSnapshotState): void;
    /** plan-2212 Phase 3: undeclared closure state found by the DES lint ('warn' policy), else null. */
    readonly undeclaredState?: string | null;
  };
}


/**
 * plan-2212: the structural surface of the public `web-component` plugin the
 * runner binds Model-Scripts through (`WebComponentPlugin.bindDes/unbindDes`).
 * Only public types cross; the plugin never imports DES.
 */
export interface ScriptDesBindingTarget {
  bindDes(binding: WebComponentDesBinding): void;
  unbindDes(): void;
  /** True while script wiring (QuickJS host load, placement) is still in flight. */
  readonly wiringPending?: boolean;
  /** Joins every wiring in flight. Never rejects. */
  whenWired?(): Promise<void>;
  /** Why the last wiring created no scripts (QuickJS load failure), else null. */
  wiringError?(): string | null;
}

/** Problem code: a DES run started without its Model-Scripts (plan-2212 R2-3). */
export { DES_SCRIPTS_UNAVAILABLE_CODE };

export class DESRunner implements SimulationExecutor {
  private readonly _experimentSubscriptions = new Set<() => void>();
  private _trackExperimentSubscription(off: () => void): () => void {
    const unsubscribe = () => { this._experimentSubscriptions.delete(unsubscribe); off(); };
    this._experimentSubscriptions.add(unsubscribe);
    return unsubscribe;
  }
  private _experimentHost() {
    const runner = this;
    let scheduledTime: number | null = null;
    const modelInputs = {
      get liveInstances() { return runner.liveInstances; },
      fingerprintScripts: () => runner.fingerprintScripts(),
    };
    const variants = async () => {
      const plugin = (runner._topology?.host as { getPlugin?(id: string): unknown } | undefined)?.getPlugin?.('variants') as VariantsPlugin | undefined;
      return plugin && (plugin.runtimeLoaded || plugin.documentHasVariants) ? plugin.commandRuntime() : null;
    };
    return {
      freezeCurrentVariant: async () => {
        const runtime = await variants();
        const variant = runtime?.store.sceneVariant ? runtime.store.variant(runtime.store.sceneVariant) : null;
        return variant ? freezeVariant(variant) : null;
      },
      applyVariant: async (id: string | null, lease: RunLease | null = null) => {
        const runtime = await variants();
        return runtime ? runtime.store.activateAsHolder(id, lease) : { ok: true as const };
      },
      get topology() { return runner._topology; },
      get nodes() { return runner._instances; },
      get manager() { return runner.manager; },
      get modelInputs() { return modelInputs; },
      get started() { return runner._started; },
      get masterSeed() { return runner.masterSeed; },
      get rngVersion() { return runner.rngVersion; },
      get subMode() { return runner.subMode; },
      get preFastForwardSubMode() { return runner.preFastForwardSubMode; },
      get seedOverride() { return runner._seedOverride; },
      set seedOverride(value: number | null) { runner._seedOverride = value; },
      get held() { return runner._batchHeld; },
      set held(value: boolean) { runner._batchHeld = value; },
      // Resolve operations at call time, as before the backend split.
      // Runner wrappers must also observe batch operations after attachment.
      setSubMode: (...args: Parameters<DESRunner["_setSubMode"]>) => runner._setSubMode(...args),
      snapshotFailure: (...args: Parameters<DESRunner["_snapshotFailure"]>) => runner._snapshotFailure(...args),
      logicHazards: (...args: Parameters<DESRunner["_logicHazards"]>) => runner._logicHazards(...args),
      reportLogicProblem: (...args: Parameters<DESRunner["_reportLogicProblem"]>) => runner._reportLogicProblem(...args),
      reset: (...args: Parameters<DESRunner["reset"]>) => runner.reset(...args), clearMUs: (...args: Parameters<DESRunner["clearMUs"]>) => runner.clearMUs(...args),
      cancelFastForward: (...args: Parameters<DESRunner["cancelFastForward"]>) => runner.cancelFastForward(...args), runFastForward: (opts?: { untilSimTime?: number }) => runner.runFastForward(opts),
      setMasterSeed: (...args: Parameters<DESRunner["setMasterSeed"]>) => runner.setMasterSeed(...args), setRngVersion: (...args: Parameters<DESRunner["setRngVersion"]>) => runner.setRngVersion(...args),
      fingerprintNow: (...args: Parameters<DESRunner["fingerprintNow"]>) => runner.fingerprintNow(...args), fullSnapshot: () => runner.fullSnapshot(),
      restoreFull: (...args: Parameters<DESRunner["restoreFull"]>) => runner.restoreFull(...args), statistics: () => runner.statistics(),
      snapshotJson: () => runner.snapshotJson(), restoreJson: (...args: Parameters<DESRunner["restoreJson"]>) => runner.restoreJson(...args),
      onTimeAdvance: (cb: (time: number) => void) => runner._trackExperimentSubscription(runner.manager.addTimeAdvanceListener(cb)),
      scheduleAt: (time: number, cb: (time: number) => void) => {
        const previous = runner.manager.onCheckpoint;
        const hook = (t: number) => { if (t === time) { scheduledTime = null; cb(t); } else previous?.(t); };
        runner.manager.onCheckpoint = hook;
        runner.manager.scheduleCheckpoint(time);
        scheduledTime = time;
        return runner._trackExperimentSubscription(() => {
          if (runner.manager.onCheckpoint === hook) {
            runner.manager.cancelCheckpoint(); scheduledTime = null; runner.manager.onCheckpoint = previous;
          }
        });
      },
      get scheduledTime(): number | null {
        return runner.manager.hasScheduledCheckpoint ? scheduledTime : null;
      },
      get hasScheduledEvent() { return runner.manager.hasScheduledCheckpoint; },
      statisticsSections: () => (runner._topology?.host as { stats?: { list(): readonly import('../../core/stats/rv-stats-registry').StatsSectionSpec[] } } | undefined)?.stats?.list() ?? [],
      readProperty: (pathOrAddress: string, component: string, field: string): unknown => {
        const root = runner._topology?.root;
        const pathNode = root ? findNodeByPath(root, pathOrAddress) : null;
        if (pathNode) return readComponentField(pathNode as never, component, field);
        const registry = (runner._topology?.host as { registry?: { getNodeByAddress?(id: string, occurrence?: string): Object3D | null } } | undefined)?.registry;
        try {
          const { nodeId, occurrence } = parseNodeAddress(pathOrAddress);
          const node = registry?.getNodeByAddress?.(nodeId, occurrence);
          return node ? readComponentField(node as never, component, field) : undefined;
        } catch { return undefined; }
      },
      readNodeProperty: (node: Object3D, component: string, field: string) => readComponentField(node as never, component, field),
      nodeAtAddress: (address: string): Object3D | null => {
        const registry = (runner._topology?.host as { registry?: { getNodeByAddress?(id: string, occurrence?: string): Object3D | null } } | undefined)?.registry;
        try { const { nodeId, occurrence } = parseNodeAddress(address); return registry?.getNodeByAddress?.(nodeId, occurrence) ?? null; }
        catch { return null; }
      },
      reconfigureFromExtras: (...args: Parameters<DESRunner["reconfigureFromExtras"]>) => runner.reconfigureFromExtras(...args),
      fastForwardTo: (untilSimTime: number) => runner.runFastForward({ untilSimTime }),
      setPauseReason: (reason: string, paused: boolean) => {
        (runner._topology?.host as { setSimulationPaused?(reason: string, paused: boolean): void } | undefined)?.setSimulationPaused?.(reason, paused);
      },
    };
  }
  /**
   * Reader of a component-property KPI source. A DES instance's runtime value wins: the
   * synthetic `TotalProcessed` counter (raw, never reset by the warm-up) and the instance's
   * `prop` bag (`failureCount` …); otherwise the field of the node's rv_extras. A name pattern
   * (`*Sink_*`) sums the field over every matching instance of that component type.
   */
  kpiPropertyReader(key: string): KpiSourceReader | null {
    const ref = parseTrackKey(key);
    if (!ref) return null;
    const typeMatches = (type: string) => type === ref.component || ref.component === `${type}Behavior` || type.endsWith(ref.component);
    const instances = this._instances.filter(i => typeMatches(i.def.type) && (ref.address
      ? i.desId?.startsWith(`${ref.address}@`) : componentMatches(ref.match ?? '', i.adapter.path)));
    const fieldOf = (i: RunnerInstance): number | undefined => {
      if (ref.field === 'TotalProcessed') return i.adapter.totalProcessed;
      return numericValue((i.self as unknown as { prop?: Record<string, unknown> }).prop?.[ref.field])
        ?? numericValue(readComponentField(i.adapter.node as never, ref.component, ref.field));
    };
    if (instances.length) return () => {
      let sum = 0, any = false;
      for (const i of instances) { const v = fieldOf(i); if (v !== undefined) { sum += v; any = true; } }
      return any ? sum : undefined;
    };
    if (!ref.address) return null;
    const registry = (this._topology?.host as unknown as { registry?: { getNodeByAddress?(id: string, occurrence?: string): unknown } } | undefined)?.registry;
    let node: unknown = null;
    try { const { occurrence, nodeId } = parseNodeAddress(ref.address); node = registry?.getNodeByAddress?.(nodeId, occurrence) ?? null; }
    catch { node = null; }
    return node ? () => numericValue(readComponentField(node as never, ref.component, ref.field)) : null;
  }

  /**
   * Runtime counters a KPI can read besides the authored fields: per DES instance `TotalProcessed` and numeric `prop` entries.
   * IMPLEMENTS SimDesControl::kpiRuntimeFields
   */
  kpiRuntimeFields(): Array<{ address: string; path: string; component: string; field: string; value: number }> {
    const out: Array<{ address: string; path: string; component: string; field: string; value: number }> = [];
    for (const i of this._instances) {
      const address = i.desId?.slice(0, i.desId.lastIndexOf('@'));
      if (!address) continue;
      const schema = (i.def as { schema?: Record<string, unknown> }).schema ?? {};
      out.push({ address, path: i.adapter.path, component: i.def.type, field: 'TotalProcessed', value: i.adapter.totalProcessed });
      const prop = (i.self as unknown as { prop?: Record<string, unknown> }).prop ?? {};
      for (const [field, raw] of Object.entries(prop)) {
        const value = numericValue(raw);
        if (value !== undefined && !Object.hasOwn(schema, field)) out.push({ address, path: i.adapter.path, component: i.def.type, field, value });
      }
    }
    return out;
  }

  /** KPI points of the current (or last ended) run, recorded by the core run identity (G4). */
  kpiTrack(): import('../sim-controller/des-kpi-defs').KpiTrack | undefined { return this.identity.kpiTrack(); }

  private _nextRunSeed(): number {
    const sceneSeed = this._topology?.root ? findDesManager(this._topology.root)?.masterSeed : undefined;
    return resolveSeed(this._seedOverride, sceneSeed, this.manager.masterSeed);
  }

  readonly mode = 'des' as const;

  private readonly manager: DESManager;
  private readonly tweens: TweenRegistry;
  private readonly _eventTweens = new Map<number, Array<{
    handle: TweenHandle;
    descriptor?: FrozenTweenDescriptor;
  }>>();
  private readonly frameEventBudget: number;

  private _seedOverride: number | null = null;
  private _instances: RunnerInstance[] = [];
  /** Definitions handed to `start()` (kept so a restart rebuilds adapters). */
  private _defs: MaterialFlowDefinition[] = [];
  private _topology: SimulationTopology | null = null;
  private readonly _muVisualFactories = new Map<string, {
    factory: MuVisualFactory;
    dispose: MuVisualDisposer;
  }>();
  private readonly _ownedMuVisuals = new Map<object, MuVisualDisposer>();
  private readonly _warnedUnknownVisualTemplates = new Set<string>();
  private readonly _warnedDanglingAxisDriveRefs = new Set<string>();
  private readonly _driveTweenTargets = new WeakMap<RVDrive, DriveTweenTarget>();
  private _activeMuVisualTemplateId: string | undefined;
  private _tearingDownMUs = false;

  /** Per-type hook dispatch maps (suffix → action index), resolved once (R3). */
  private _dispatchByType = new Map<string, HookDispatch>();

  private _subMode: DesSubMode;
  private _multiplier: number;
  /** Sub-mode active BEFORE the last switch into FastForward — the mode the FF
   *  toggle returns to. Lives on the runner (not in UI state) so it survives
   *  toolbar remounts and covers every FF entry path (UI, MCP, persisted mode). */
  private _preFfSubMode: Exclude<DesSubMode, 'fastforward'>;
  private _started = false;

  /** FastForward run state (Plan 194 §4.1 — progress + cancel for the UI). */
  private _ffActive = false;
  private _ffProgress = 0;
  private _ffTarget: { time: number; subMode: DesSubMode; multiplier: number } | null = null;
  /** FF generation token (R2, plan-262): `await`-continuations cannot be
   *  retracted (unlike `cancelIdleCallback`), so a cancel + immediate restart
   *  would leave a STALE drain loop behind. `runFastForward()` bumps the id;
   *  a loop that wakes to a mismatched id exits without touching anything
   *  (same generation pattern as the TweenRegistry handles). */
  private _ffRunId = 0;
  private _ffResolve: ((done: boolean) => void) | null = null;

  /**
   * The runner's render clock — the (possibly time-lapsed) sim time used to
   * interpolate tweens. Advances by `dt · multiplier`; frozen at the real sim
   * position while a Hybrid batch is being spread across frames (B4).
   */
  private _renderClock = 0;
  /** Render clock at the last `lateTick` — FastForward marks the frame dirty when it moved. */
  private _lastDirtyClock = 0;

  /** Core subsystem pipeline (drive loop / visuals / early stage) — see DESRunnerOptions.core. */
  private readonly core: CoreSubsystems | null;

  /**
   * Number of live settle consumers (plan-262 Phase 2): instances whose
   * definition declares `des.samplesLiveGeometry`, plus one conservative slot
   * when active script components with DES hooks exist (Phase 2b / R4 — their
   * hooks dispatch outside the MaterialFlowAdapter path and have no opt-in
   * channel). While 0, the per-event-time tween settle (`manager.onTimeAdvance`)
   * is unwired entirely — pure conveyor/station lines pay zero settle cost in
   * FastForward. The FF-EXIT settle in `setSubMode` stays UNCONDITIONAL.
   */
  private _settleRequired = 0;
  /** DEV-only: types already warned about by the settle dev guard (once each). */
  private readonly _devWarnedSettleTypes = new Set<string>();

  /** Explicit script-component source override (plan-261 B4; tests/wiring). */
  private _scriptComponentSource: (() => ScriptStateSource[]) | null = null;
  /** Explicit script binding target (plan-2212; tests/wiring); default: the host's `web-component` plugin. */
  private _scriptBindingTarget: ScriptDesBindingTarget | null = null;
  /** The target the current DES binding went to (unbound on continuous / dispose). */
  private _boundScriptTarget: ScriptDesBindingTarget | null = null;
  /**
   * plan-2212 R2-3: readiness barrier of the current run - resolves when the
   * scripts present at run start are wired. While set, no DES event runs
   * (tick, step and the FastForward drain wait for it).
   */
  private _scriptBarrier: Promise<void> | null = null;
  /** review #3: material setup + generators of a run whose scripts are still being wired. */
  private _pendingMaterialStart: (() => void) | null = null;
  private readonly identity: RunIdentity;
  private _backend: ExperimentBackend | null = null;
  private _detachBackend: () => void;
  private _batchHeld = false;

  // -- Lifecycle service + callback scheduler (plan-645 Phase 2) --
  /** Process-unique runner id (lifecycle events, callback dispatch). */
  readonly runnerId = nextRunnerId++;
  private _lcState: DesLifecycleState = 'idle';
  /** Service generation - own counter, never an entity id (N5). +1 per event. */
  private _lcGeneration = 0;
  private readonly _lcListeners: DesLifecycleListener[] = [];
  private readonly _callbacks = new Map<number, { fn: () => void; eventId: number }>();
  private _callbackKey = 1;

  // -- Scene binding generation (plan-645 L4 / R2-4) --
  /** True after a successful scene discovery (also of an empty scene); cleared on dispose. */
  private _hasSceneBinding = false;
  /** `topology.sceneGeneration()` at the last successful scene bind; null = none. */
  private _boundSceneGen: number | null = null;

  // -- Signal ownership of the bound scene instances (plan-645 L6 / S7) --
  /** Owner paths this runner registered for the current bound generation. */
  private _ownedSignals: Array<{ name: string; path: string }> = [];

  constructor(opts: DESRunnerOptions = {}) {
    this.manager = new DESManager();
    this.tweens = new TweenRegistry(256);
    this.manager.onEventConsumed = (eventId) => { this._eventTweens.delete(eventId); };
    this.manager.onMURetired = (mu) => { this._disposeMuVisual(mu as DESMU); };
    this.manager.onHierarchyChanged = () => {
      if (!this._tearingDownMUs && !this.headlessSpawnActive) this._materializeHeadlessMUs();
    };
    this.manager.onReservationsRolledBack = (records) => {
      for (const record of records) {
        const holder = this.manager.getComponentByPath(record.holderId);
        const target = this.manager.getComponentByPath(record.targetId);
        if (holder instanceof MaterialFlowAdapter && target instanceof MaterialFlowAdapter) {
          holder.onDownstreamReady(target);
        }
      }
    };
    this.core = opts.core ?? null;
    this.frameEventBudget = Math.max(1, opts.frameEventBudget ?? DEFAULT_FRAME_EVENT_BUDGET);
    this._subMode = opts.subMode ?? 'animated';
    this._multiplier = Math.max(1, opts.multiplier ?? 1);
    // Starting directly IN FastForward (persisted mode): derive the return mode
    // from the multiplier so the FF toggle still lands on a sensible speed.
    this._preFfSubMode = this._subMode !== 'fastforward'
      ? this._subMode
      : (this._multiplier > 1 ? 'hybrid' : 'animated');
    if (opts.durationSeconds !== undefined) this.manager.duration = opts.durationSeconds;
    if (opts.masterSeed !== undefined) this.manager.setMasterSeed(opts.masterSeed);
    // Native manager mode tracks the sub-mode for the existing HMI windows.
    this.manager.mode = this._toNativeMode(this._subMode);
    // Event-time settle: before the first event at each distinct sim time
    // dispatches, snap every active tween to that time. Event handlers that
    // sample live geometry (Turntable attach/ride endpoints, world positions)
    // then ALWAYS see visuals at the exact event time — also in FastForward,
    // where whole hand-off sequences process inside one frame batch and stale
    // visuals previously produced tweens with garbage endpoints (parts landing
    // beside the plant).
    //
    // plan-262 Phase 2: the settle is GATED — it is only wired while at least
    // one live instance declares `des.samplesLiveGeometry` (or script
    // components with DES hooks are active, R4). A fresh runner has no
    // instances yet, so this starts unwired; every instance mutation point
    // (start/addInstance/clearMUs/reset/dispose) recomputes.
    this._recomputeSettleRequired();
    this.identity = new RunIdentity(this.manager, (event, data) => {
      const host = this._topology?.host as { emit?(event: string, data: unknown): void } | undefined;
      host?.emit?.(event, data);
    }, {
      // KPI recording is core (G4): the run's model key, its sources and their readers.
      modelKey: () => {
        const scoped = runScopeStore.getSnapshot()?.model;
        if (scoped) return scoped;
        const host = this._topology?.host as Partial<ProjectManagerViewerLike> | undefined;
        return host && 'currentModelUrl' in host ? modelKeyOf(host as ProjectManagerViewerLike) : null;
      },
      projectId: () => runScopeStore.getSnapshot()?.projectId ?? null,
      readSource: key => key.startsWith('row:')
        ? rowSourceReader(key, () => (this._topology?.host as { stats?: { list(): readonly import('../../core/stats/rv-stats-registry').StatsSectionSpec[] } } | undefined)?.stats?.list() ?? [])
        : this.kpiPropertyReader(key),
    });
    this._detachBackend = registerExperimentRunner(this._experimentHost(), this.identity, backend => {
      this._backend = backend;
      for (const name of EXPERIMENT_METHODS) {
        const method = backend?.[name];
        Object.defineProperty(this, name, { configurable: true, value: typeof method === 'function' ? method.bind(backend) : undefined });
      }
    });
    DES.setManager(this.manager);
  }

  // ─── Lifecycle service (plan-645 Phase 2, L2 / R2-3) ───────────────────

  /** Current lifecycle state (diagnostics / tests). */
  get lifecycleState(): DesLifecycleState { return this._lcState; }

  /** Current service generation (diagnostics / tests). */
  get lifecycleGeneration(): number { return this._lcGeneration; }

  /**
   * Subscribe to lifecycle events. Synchronous dispatch over a copy of the
   * listener list; unsubscribing while it fires is allowed; a throwing listener
   * is logged and does not stop the others. `replay: true` delivers `bound` at
   * once when the runner is bound. Ending events (`reset`, `disposed`) arrive
   * BEFORE the instances are torn down.
   * IMPLEMENTS SimDesControl::onLifecycle
   */
  onLifecycle(fn: DesLifecycleListener, opts?: { replay?: boolean }): () => void {
    this._lcListeners.push(fn);
    if (opts?.replay && this._lcState === 'bound') {
      try { fn({ type: 'bound', generation: this._lcGeneration, runnerId: this.runnerId }); } catch (e) {
        console.error('[DESRunner] lifecycle listener threw:', e);
      }
    }
    return () => {
      const i = this._lcListeners.indexOf(fn);
      if (i >= 0) this._lcListeners.splice(i, 1);
    };
  }

  /**
   * Run `fn` once at sim time `t` (clamped to now) as a `DES.Callback` queue
   * event. Not persistable: snapshots filter the action, and every lifecycle
   * event drops the pending callbacks (consumers plan again after `restored`).
   * IMPLEMENTS SimDesControl::scheduleCallback
   */
  scheduleCallback(t: number, fn: () => void, opts: { afterModelEvents?: boolean; origin: { owner: string; kind: 'ui' | 'replan' } }): DesCallbackHandle {
    ensureCallbackDispatcher();
    callbackRunners.set(this.runnerId, this);
    const key = this._callbackKey++;
    const g = this._lcGeneration;
    const now = this.manager.currentTime;
    const at = Number.isFinite(t) ? Math.max(t, now) : now;
    const eventId = this.manager.scheduleEvent(at, DES_CALLBACK_ACTION, -1, -1, opts?.afterModelEvents ? PLANNING_PRIORITY : 0, { r: this.runnerId, g, k: key, ...(opts?.origin ? { origin: opts.origin } : {}) });
    this._callbacks.set(key, { fn, eventId });
    return { generation: g, key };
  }

  /**
   * Cancel a pending callback; a handle of an older generation is ignored (its
   * queue id may belong to a model event by now).
   * IMPLEMENTS SimDesControl::cancelCallback
   */
  cancelCallback(h: DesCallbackHandle | null | undefined): void {
    if (!h || h.generation !== this._lcGeneration) return;
    const entry = this._callbacks.get(h.key);
    if (!entry) return;
    this._callbacks.delete(h.key);
    this.manager.cancelEvent(entry.eventId);
  }

  /** Dispatch from the `DES.Callback` action (internal). */
  fireCallback(g: number, k: number): void {
    if (g !== this._lcGeneration) return;
    const entry = this._callbacks.get(k);
    if (!entry) return;
    this._callbacks.delete(k);
    entry.fn();
  }

  /** Pending callbacks of the current generation (diagnostics / tests). */
  get pendingCallbacks(): number { return this._callbacks.size; }

  private _lcEmit(type: DesLifecycleEventType): void {
    this._lcGeneration++;
    // Every event drops the pending callbacks: their queue events are gone
    // (reset / restore replaced the queue) or fire into a foreign generation.
    this._callbacks.clear();
    const e: DesLifecycleEvent = { type, generation: this._lcGeneration, runnerId: this.runnerId };
    for (const fn of this._lcListeners.slice()) {
      try { fn(e); } catch (err) { console.error(`[DESRunner] lifecycle listener threw on '${type}':`, err); }
    }
  }

  /** `bound` - only on a real transition into the bound state. */
  private _lcBind(): void {
    if (this._lcState === 'bound' || this._lcState === 'disposed') return;
    this._lcState = 'bound';
    this._lcEmit('bound');
    this._claimSceneSignals();
  }

  /** `reset` - only when bound; nested / repeated ends are silent. */
  private _lcEnd(): void {
    if (this._lcState !== 'bound') return;
    this._lcState = 'ended';
    this._lcEmit('reset');
    this._releaseSceneSignals();
  }

  /**
   * plan-645 L6: every signal a scene instance declared gets an owner path of
   * THIS bind (runner id, generation, instance, name) - a name nobody else owns
   * (an unscoped `Flow.Occupied`, `Agv.*`) then leaves the store when the bind
   * ends instead of staying behind after DES <-> continuous. The preferred path
   * of a name (a model path) is never moved (`addOwnerPath`).
   */
  private _claimSceneSignals(): void {
    const store = this.resolveSignalStore() as (SignalStore & {
      addOwnerPath?: (n: string, p: string, v: boolean | number) => boolean;
    }) | null;
    if (!store || typeof store.addOwnerPath !== 'function') return;
    const prefix = `__des-owner__/${this.runnerId}`;
    for (const inst of this._instances) {
      if (!inst.scene) continue;
      for (const name of inst.scene.signals) {
        // A forced signal retains this fixed owner across resets and new node UUIDs.
        const path = `${prefix}/${name}`;
        if (store.addOwnerPath(name, path, store.get(name) ?? false)) this._ownedSignals.push({ name, path });
      }
    }
  }

  /** plan-645 L6: release exactly the owner paths of the ending bind. A forced name keeps its owner. */
  private _releaseSceneSignals(): void {
    if (this._ownedSignals.length === 0) return;
    const owned = this._ownedSignals;
    this._ownedSignals = [];
    const store = this.resolveSignalStore();
    if (!store) return;
    for (const { name, path } of owned) {
      if (store.isForced?.(name)) continue;
      store.unregisterPath(path, name);
    }
  }

  /** `restored` - no state change, only in bound / ended. */
  private _lcRestored(): void {
    if (this._lcState !== 'bound' && this._lcState !== 'ended') return;
    this._lcEmit('restored');
  }

  // ─── Read accessors / diagnostics ──────────────────────────────────────

  get muCount(): number {
    return this.manager.muCount;
  }

  get subMode(): DesSubMode {
    return this._subMode;
  }

  /**
   * plan-2212 Phase 4: true while Model-Script frame hooks may run (display
   * only) — the run animates: not FastForward (sub-mode or an in-flight
   * `runFastForward()` drain) and not inside an experiment batch. Script state
   * and KPIs come from DES events only, so they are the same in every profile.
   */
  get scriptFramesActive(): boolean {
    return this._subMode !== 'fastforward' && !this._ffActive && !this._batchHeld;
  }

  get multiplier(): number {
    return this._multiplier;
  }

  /** Current simulation time (seconds). */
  get simTime(): number {
    return this.manager.currentTime;
  }

  /** The render clock (time-lapsed sim time used for tween interpolation). */
  get renderClock(): number {
    return this._renderClock;
  }

  /** Time of the next pending event (+Infinity when empty) — read-only queue peek (plan-629). */
  get nextEventTime(): number {
    return this.manager.nextEventTime;
  }

  /**
   * Observe the event loop (plan-629, `SimDesControl.addTimeAdvanceListener`):
   * passes through to the manager's multi-slot listener — once per distinct
   * event time, before that time's first event is dequeued. Survives reset.
   */
  addTimeAdvanceListener(fn: (time: number) => void): () => void {
    return this.manager.addTimeAdvanceListener(fn);
  }

  /** The owned DES manager (HMI windows / stats read it — Plan 194 B1). */
  getManager(): DESManager {
    return this.manager;
  }

  /** Register one template-keyed MU visual factory. The registry owns disposal. */
  registerMuVisualFactory(
    templateId: string,
    factory: MuVisualFactory,
    dispose: MuVisualDisposer = (visual) => { visual.dispose(); },
  ): void {
    if (!templateId) throw new Error('DES: visual template id must not be empty');
    this._muVisualFactories.set(templateId, { factory, dispose });
  }

  /** Create a registered visual immediately (scene binding and tests). */
  createMuVisual(templateId: string): DESMU['visual'] {
    return this._createMuVisual(templateId);
  }

  /**
   * Idempotently ensure that a logical DES MU has a non-instanced visual which
   * can be re-parented to a robot TCP. Failures are data, never partial writes.
   */
  materializeMu(mu: MU | null | undefined): MaterializeMuResult {
    if (!mu || typeof mu.id !== 'number') {
      return { ok: false, reason: 'invalid-mu', message: 'DES MU is null or has no numeric id' };
    }
    const logical = mu as DESMU;
    if (logical.retired) {
      return { ok: false, reason: 'retired', message: `DES MU ${mu.id} is retired` };
    }
    if (logical.visual) {
      if (logical.visual instanceof RVMovingUnit && !logical.visual.isInstanced) {
        return { ok: true, visual: logical.visual, created: false };
      }
      return {
        ok: false,
        reason: 'instanced-visual',
        message: `DES MU ${mu.id} uses an instanced/non-reparentable visual`,
      };
    }
    if (!logical.visualTemplateId) {
      return {
        ok: false,
        reason: 'missing-template',
        message: `DES MU ${mu.id} has no visualTemplateId`,
      };
    }

    let candidate: DESMU['visual'];
    try {
      candidate = this._createMuVisual(logical.visualTemplateId);
    } catch (error) {
      return {
        ok: false,
        reason: 'factory-error',
        message: `DES MU ${mu.id} visual factory failed: ${String(error)}`,
      };
    }
    if (!(candidate instanceof RVMovingUnit) || candidate.isInstanced) {
      const disposer = candidate ? this._ownedMuVisuals.get(candidate as object) : undefined;
      if (candidate && disposer) {
        this._ownedMuVisuals.delete(candidate as object);
        disposer(candidate);
      }
      return {
        ok: false,
        reason: 'instanced-visual',
        message: `DES MU ${mu.id} factory returned an instanced/non-reparentable visual`,
      };
    }

    logical.visual = candidate;
    const now = this.manager.currentTime;
    if (this.tweens.positionForMu(logical.id, now, _matPos)) {
      candidate.setPosition(_matPos);
    } else if (logical.restoredPosition) {
      _matPos.set(...logical.restoredPosition);
      candidate.setPosition(_matPos);
    } else if (logical.currentComponent?.node) {
      logical.currentComponent.node.getWorldPosition(_matPos);
      candidate.setPosition(_matPos);
    }
    if (logical.restoredQuaternion) {
      _matQuat.set(...logical.restoredQuaternion);
      candidate.setQuaternion(_matQuat);
    } else {
      applyMuForwardToVisual(logical as unknown as MU);
    }
    delete logical.restoredPosition;
    delete logical.restoredQuaternion;
    if (logical.restoredVisualParent) { logical.restoredVisualParent.add(candidate.node); delete logical.restoredVisualParent; }
    this.tweens.attachTargetForMu(logical.id, candidate);
    return { ok: true, visual: candidate, created: true };
  }

  private _createMuVisual(templateId: string): DESMU['visual'] {
    const entry = this._muVisualFactories.get(templateId);
    let visual = entry?.factory() ?? null;
    let disposer = entry?.dispose;
    if (!visual) {
      if (!this._warnedUnknownVisualTemplates.has(templateId)) {
        this._warnedUnknownVisualTemplates.add(templateId);
        console.warn(`[DESRunner] unknown MU visualTemplateId '${templateId}'; using fallback gizmo`);
      }
      const node = createDESGizmoBox([100, 100, 100], 0xffa000, { fillOpacity: 0.2 });
      node.name = `MU_Fallback_${templateId}`;
      this._topology?.root.add(node);
      visual = new RVMovingUnit(node, `DES:${templateId}`);
      disposer = (owned) => { owned.dispose(); };
    }
    this._ownedMuVisuals.set(visual as object, disposer ?? ((owned) => { owned.dispose(); }));
    return visual;
  }

  private _disposeMuVisual(mu: DESMU): void {
    const visual = mu.visual;
    if (!visual) return;
    const host = this._topology?.host as { progressWiring?: import('../../core/diagnostics/rv-progress-wiring').ProgressWiring | null } | undefined;
    host?.progressWiring?.retireMU(visual, { id: mu.id, gen: mu.generation });
    const disposer = this._ownedMuVisuals.get(visual as object);
    if (disposer) {
      this._ownedMuVisuals.delete(visual as object);
      disposer(visual);
    } else {
      // Programmatic adapters and focused tests may provide a structural tween
      // target rather than an engine-owned RVMovingUnit. Only registry-created
      // visuals carry a mandatory disposer; foreign targets are best-effort.
      (visual as { dispose?: () => void }).dispose?.();
    }
    mu.visual = null;
  }

  /** The owned tween registry (diagnostics). */
  getTweenRegistry(): TweenRegistry {
    return this.tweens;
  }

  // ─── Sub-mode / multiplier ─────────────────────────────────────────────

  /** Sub-mode that was active before the last switch into FastForward — the
   *  mode the FF toggle returns to (never 'fastforward' itself). */
  get preFastForwardSubMode(): DesSubMode {
    return this._preFfSubMode;
  }

  /** Set the active sub-mode (Animated/Hybrid/FastForward/Step). */
  setSubMode(m: DesSubMode): void {
    if (this._batchHeld) return;
    this._setSubMode(m);
  }

  private _setSubMode(m: DesSubMode): void {
    const wasFastForward = this._subMode === 'fastforward';
    // Entering FastForward: remember where we came from so the UI toggle can
    // return DIRECTLY to the previous speed (no dropdown re-pick needed).
    if (this._subMode !== 'fastforward' && m === 'fastforward') this._preFfSubMode = this._subMode;
    this._subMode = m;
    this.manager.mode = this._toNativeMode(m);
    // plan-2062: logic cycles are counted wrongly outside animated mode — a warning, never a refusal.
    if (m === 'fastforward' || m === 'hybrid') {
      const hazards = this._logicHazards();
      if (hazards.length) this._reportLogicProblem('des-fastforward-logic-warning', 'warning', describeLogicPresence(hazards));
    } else clearProblem('des-fastforward-logic-warning');

    // Leaving FastForward for an animating sub-mode: settle every MU to its
    // EXACT current sim position before continuous animation resumes. During
    // FastForward the tween registry skips the transform write for still-running
    // tweens (max throughput), so every mid-transit part is stranded at its
    // pre-FF position. Without this snap the first animated frame teleports the
    // parts to the live sim state ("weird MU animations after FastForward").
    if (wasFastForward && m !== 'fastforward') {
      // Leaving FF must also terminate an in-flight drain loop cleanly — its
      // promise resolves `false` synchronously (R3) and the loop exits at its
      // next wake-up. Without this the async drain would keep racing the
      // animated tick after the mode switch.
      this.cancelFastForward();
      this._renderClock = this.manager.currentTime;
      // plan-262 Phase 3: MUs spawned DURING FastForward are headless
      // (visual === null). Materialise them BEFORE the exit settle so the
      // settle's unconditional write positions the re-connected tweens exactly.
      this._materializeHeadlessMUs();
      this.tweens.settle(this._renderClock, 'ffExit', true);
      for (const inst of this._instances) {
        inst.def.des?.onFastForwardExit?.(inst.self);
      }
    }
  }

  /**
   * True while new MUs must spawn WITHOUT a visual (plan-262 Phase 3): in
   * FastForward no per-frame animation happens, so the mesh clone per MU is
   * pure churn. The scene binding's `spawnMU` wiring gates on this; the WIP
   * MUs are materialised when the runner leaves FastForward (`setSubMode`).
   */
  get headlessSpawnActive(): boolean {
    return this._subMode === 'fastforward';
  }

  /** Mutable backing of {@link portCacheScope}. */
  private readonly _portCache: { generation: number } = { generation: 0 };

  /**
   * Validity scope of the DES port cache (plan-644 Phase 2.2), injected into
   * every scene-bound `createSelf` (`portCache`). Its `generation` is raised at
   * the start of every `start` / `reset` / `rebindScene` (all run through
   * `_startWith`), BEFORE the first port query of the new run, so a restart
   * with the same snap registry never reads a surface list of the old run.
   */
  get portCacheScope(): PortResolveCacheScope {
    return this._portCache;
  }

  /**
   * FF-exit materialisation (plan-262 Phase 3, Plan-100 Phase 8 "Virtual MUs"):
   * spawn a visual for every live MU with `visual === null`, position it from
   * its ACTIVE tween window at the current sim time (exact interpolation),
   * falling back to the booking component's node position, and re-connect the
   * running headless tween records to the new visual so animation continues
   * seamlessly. Runs in ONE pass — the MU count is WIP-bounded (capacity, not
   * production), so this is a handful of clones, not thousands.
   */
  private _materializeHeadlessMUs(): void {
    const now = this.manager.currentTime;
    const n = this.manager.muCount;
    for (let i = 0; i < n; i++) {
      const mu = this.manager.getMU(i) as DESMU | null;
      if (!mu || mu.retired || mu.visual || !mu.visualTemplateId) continue;
      if (!this._isTopmostHierarchyLayer(mu)) continue;
      const spawnVisual = this.findVisualFactory(mu.visualTemplateId);
      const visual = (spawnVisual() ?? null) as DESMU['visual'];
      if (!visual) continue;
      mu.visual = visual;
      const positioned = this.tweens.positionForMu(mu.id, now, _matPos);
      if (positioned) {
        visual.setPosition(_matPos);
      } else {
        const w = this.tweens.activeWindowForMu(mu.id, now);
        if (w) {
        const t = Math.min(1, Math.max(0, (now - w.t0) / Math.max(0.001, w.t1 - w.t0)));
        _matPos.lerpVectors(w.from, w.to, t);
        visual.setPosition(_matPos);
        } else if (mu.restoredPosition) {
        _matPos.set(mu.restoredPosition[0], mu.restoredPosition[1], mu.restoredPosition[2]);
        visual.setPosition(_matPos);
        } else if (mu.currentComponent?.node) {
        // No running tween — the MU rests AT its booking component.
        mu.currentComponent.node.getWorldPosition(_matPos);
        visual.setPosition(_matPos);
        }
      }
      if (mu.restoredQuaternion) {
        _matQuat.set(
          mu.restoredQuaternion[0], mu.restoredQuaternion[1],
          mu.restoredQuaternion[2], mu.restoredQuaternion[3],
        );
        visual.setQuaternion(_matQuat);
      } else {
        // A restored pose can differ from the last travel heading after a fork
        // turn. Only synthesize orientation for a visual without a saved pose.
        applyMuForwardToVisual(mu as unknown as MU);
      }
      delete mu.restoredPosition;
      delete mu.restoredQuaternion;
      if (mu.restoredVisualParent && !visual.isInstanced) { mu.restoredVisualParent.add((visual as { node: Object3D }).node); }
      delete mu.restoredVisualParent;
      // Re-connect running headless records → the tween keeps moving the new
      // visual; the FF-exit settle right after re-writes the exact position.
      this.tweens.attachTargetForMu(mu.id, visual as unknown as PositionTweenTarget);

      if (mu.parentMU && !visual.isInstanced) {
        const parent = this.manager.getMUByRef(mu.parentMU) as DESMU | null;
        if (parent?.visual && !parent.visual.isInstanced) {
          const parentNode = (parent.visual as { node: Object3D }).node;
          const childNode = (visual as { node: Object3D }).node;
          parentNode.attach(childNode);
          const grid = mu.prop['gridPosition'];
          if (Array.isArray(grid) && grid.length >= 3 && grid.every((v) => typeof v === 'number')) {
            childNode.position.set(grid[0] as number, grid[1] as number, grid[2] as number);
          }
        }
      }
    }
  }

  private _isTopmostHierarchyLayer(mu: DESMU): boolean {
    let current = mu;
    const seen = new Set<string>();
    while (current.parentMU) {
      const key = `${current.id}:${current.generation}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const parent = this.manager.getMUByRef(current.parentMU) as DESMU | null;
      if (!parent) return false;
      let top: DESMU | null = null;
      for (let i = parent.childMUs.length - 1; i >= 0; i--) {
        top = this.manager.getMUByRef(parent.childMUs[i]) as DESMU | null;
        if (top) break;
      }
      if (top !== current) return false;
      current = parent;
    }
    return true;
  }

  /** Set the HybridSynced multiplier (clamped to ≥ 1). */
  setMultiplier(n: number): void {
    this._multiplier = Math.max(1, n);
  }

  // ─── FastForward run (progress + cancel for the UI, Plan 194 §4.1) ──────

  /** FastForward progress 0–1 while a FF run is in flight; undefined otherwise. */
  get ffProgress(): number | undefined {
    return this._ffActive ? this._ffProgress : undefined;
  }

  /** Manager pause set when an FF-until-target run ended. The viewer ticks the runner only while
   *  the public (user) pause is released, so the next tick means Play: release the hold. */
  private _heldByFf = false;
  private _lastFfError: unknown = null;
  private _actionFailure = false;
  get lastFfError(): unknown { return this._lastFfError; }

  private _actionFailed(error: unknown): void {
    this._actionFailure = true;
    this.manager.pause();
    this._renderClock = this.manager.currentTime;
    const failed = this.manager.lastFailedEvent;
    reportProblem({
      id: `${ACTION_FAILED_PROBLEM_CODE}:${failed.componentPath}:${failed.actionIndex}`,
      code: ACTION_FAILED_PROBLEM_CODE, severity: 'error', title: 'DES action failed',
      nodePath: failed.componentPath,
      detail: `${failed.componentPath}: ${getActionName(failed.actionIndex) ?? failed.actionIndex} at ${failed.time}: ${String(error)}`,
    });
  }

  /**
   * Drain the event queue at full speed (FastForward) in time-sliced batches
   * (plan-262 Phase 1): each slice processes events against a
   * `performance.now()` deadline, then yields one scheduling turn
   * (`scheduler.yield()` / MessageChannel) so the browser stays responsive —
   * throughput scales with the CPU instead of being frame-capped. Progress
   * tracks against the sim duration. Resolves `true` on completion, `false`
   * when cancelled. Idempotent: a second call while running returns `false`
   * immediately.
   */
  runFastForward(opts?: { untilSimTime?: number }): Promise<boolean> {
    if (!this._started || this._ffActive) return Promise.resolve(false);
    const target = opts?.untilSimTime;
    if (target !== undefined && (!Number.isFinite(target) || target < 0)) {
      return Promise.reject(new RangeError('untilSimTime must be a finite non-negative time'));
    }
    this._ffTarget = target === undefined ? null : {
      time: target,
      subMode: this._subMode === 'fastforward' ? this._preFfSubMode : this._subMode,
      multiplier: this._multiplier,
    };
    this.manager.setProcessingTarget(target ?? null);
    this._heldByFf = false;
    this._lastFfError = null;
    this._actionFailure = false;
    this.manager.resume();
    this._setSubMode('fastforward');
    this._ffActive = true;
    this._ffProgress = 0;
    // R2: only the STARTER bumps the generation token — cancel never does, so
    // a stale continuation is always detectable by id mismatch.
    const runId = ++this._ffRunId;
    return new Promise<boolean>((resolve) => {
      this._ffResolve = resolve;
      void this._ffDrainLoop(runId).catch(error => {
        if (runId !== this._ffRunId) return;
        this._lastFfError = error;
        try { this._actionFailed(error); }
        finally { this._finishFf(false); }
      });
    });
  }

  /** Public structural SimDesControl surface (the kernel exposes this runner). */
  fastForwardUntil(seconds: number): Promise<boolean> {
    return this.runFastForward({ untilSimTime: seconds });
  }

  /** Cancel an in-flight FastForward run. Resolves the pending promise `false`
   *  SYNCHRONOUSLY (R3 — the `.then()` consumer hangs otherwise);
   *  the drain loop exits at its next wake-up via the `_ffActive` check. */
  cancelFastForward(): void {
    if (!this._ffActive) return;
    this._finishFf(false);
  }

  /**
   * Time-sliced FastForward drain loop (plan-262 Phase 1). Replaces the old
   * one-fixed-batch-per-`requestIdleCallback` scheduling.
   *
   * INVARIANT: after EVERY `await`, check `_ffActive` AND `runId` BEFORE
   * touching the manager or the tweens — `dispose()`/`clearMUs()`/
   * `restoreFull()` cancel synchronously ahead of their teardown
   * (use-after-dispose protection), and a cancel + immediate restart leaves a
   * stale continuation behind that must not drive the NEW run (R2).
   */
  private async _ffDrainLoop(runId: number): Promise<void> {
    // plan-2212 R2-3: FastForward / batch wait for the run's scripts first; plan-2211: and for
    // the run's KPI sources (a provider may answer asynchronously).
    for (let barrier = this._progressBarrier(); barrier; barrier = this._progressBarrier()) {
      await barrier;
      if (!this._ffActive || runId !== this._ffRunId) {
        if (runId === this._ffRunId) this._finishFf(false);
        return;
      }
    }
    let lastTimerYield = performance.now();
    while (this._ffActive && runId === this._ffRunId) {
      const deadline = performance.now() + FF_SLICE_MS;
      let done = false;
      try {
        do {
          ({ done } = this.manager.runBatch(FF_INNER_BATCH));
          // Retire consumed MUs before another batch can allocate their slots.
          this._sweepConsumedVisuals();
        } while (!done && performance.now() < deadline);
      } catch (error) {
        this._lastFfError = error;
        this._finishFf(false);
        this._actionFailed(error);
        return;
      }

      this._renderClock = this.manager.currentTime;
      // Render the MU meshes at the new clock between slices so FastForward is
      // VISIBLE (parts jump quickly to their current positions) instead of frozen.
      // Use 'hybrid' so the tween registry actually writes transforms (its
      // 'fastforward' sub-mode intentionally writes nothing for headless analysis).
      if (this.tweens.onRender(this._renderClock, 'hybrid', true)) this.core?.markGeometryMoved();
      this._sweepConsumedVisuals();
      const end = Math.min(this._ffTarget?.time ?? Infinity, this.manager.duration);
      this._ffProgress = Math.min(1, this.manager.currentTime / (end || 1));
      if (done) {
        this._finishFf(true);
        return;
      }
      if (performance.now() - lastTimerYield >= FF_TIMER_YIELD_MS) {
        await yieldToTimers();
        lastTimerYield = performance.now();
      } else {
        await yieldToBrowser();
      }
    }
    // Cancel-/mode-switch exit: ALWAYS resolve the promise (false) — otherwise
    // the `.then()` consumer hangs forever (R3). This is
    // idempotent (a synchronous cancel already resolved and nulled it); a
    // superseding restart (runId mismatch) owns the state and is left alone.
    if (runId === this._ffRunId) this._finishFf(false);
  }

  /** Terminal FF transition — idempotent on EVERY exit path (R3). Resolves and
   *  clears the pending promise, deactivates FF; a completed run pins the
   *  progress to 1 and fires the completion edge (plan-260). */
  private _finishFf(done: boolean): void {
    this._ffActive = false;
    if (done) this._ffProgress = 1;
    const resolve = this._ffResolve;
    this._ffResolve = null;
    const target = this._ffTarget;
    this._ffTarget = null;
    try {
      // A target is not a run-complete edge: only the actual model end is.
      if (done && this.manager.isComplete) this._checkRunComplete();
      // Deactivate/detach the run BEFORE setSubMode calls cancelFastForward.
      // The regular exit materialises headless MUs and settles their tweens.
      if (target && this._subMode === 'fastforward') this._setSubMode(target.subMode);
    } catch (error) {
      done = false;
      throw error;
    } finally {
      if (target) {
        this._multiplier = target.multiplier;
        if (done) { this.manager.pause(); this._heldByFf = true; }   // a cancelled run (reset, mode switch) must not pause
      }
      this.manager.setProcessingTarget(null);
      resolve?.(done);
    }
  }

  // ─── KPI snapshot (Plan 194 §4.2 — throughput / bottleneck / utilization) ─

  /**
   * Build a public, private-type-free KPI snapshot the FastForward analysis
   * panel reads through the kernel's `SimDesControl` surface. Aggregates the
   * native DES statistics over the live adapters.
   */
  kpiSnapshot(): SimKpiSnapshot {
    const adapters = this._instances.map(i => i.adapter);
    const stats = computeAllStatistics(this.manager, adapters);
    const components: Array<{ name: string; utilization: number }> = [];
    let throughputPerHour = 0;
    let bottleneck: { name: string; utilization: number } | null = null;
    for (const [path, s] of Object.entries(stats)) {
      const name = path.split('/').pop() ?? path;
      components.push({ name, utilization: s.utilization });
      throughputPerHour += s.outputPerHour;
      if (!bottleneck || s.utilization > bottleneck.utilization) {
        bottleneck = { name, utilization: s.utilization };
      }
    }
    return {
      simTimeSeconds: this.manager.currentTime,
      throughputPerHour,
      bottleneck,
      components,
    };
  }

  // ─── Event stats + snapshot (toolbar clock/counters + Save/Load) ───────

  /**
   * Lightweight clock + counters for the top DES toolbar (all O(1) on the
   * manager). The full row snapshot lives on the private side and is read by the
   * private Event Queue window directly (`manager.getEventQueueSnapshot()`).
   */
  eventStats(): SimEventStats {
    return {
      currentTime: this.manager.currentTime,
      processed: this.manager.totalEventsProcessed,
      pending: this.manager.pendingEventCount,
      nextEventTime: this.manager.nextEventTime,
    };
  }

  // ─── Sim end + statistics-reset (clock settings) ───────────────────────
  /** Sim END time in seconds (the run stops past it); Infinity = run until the
   *  event queue empties ("infinite"). */
  get endTime(): number { return this.manager.duration; }
  setEndTime(seconds: number): void {
    this._continueBaseEnd = null;   // an explicit end is the new "original" end
    this.manager.duration = Number.isFinite(seconds) ? Math.max(0, seconds) : Infinity;
    this._refreshRunComplete();
  }

  /** Original run length while a finished run was continued; null = never continued. */
  private _continueBaseEnd: number | null = null;

  /**
   * Continue a finished run (Play after "Run finished"): extends the end time by one more
   * run length (24:00:00 -> 48:00:00), re-arms completion and resumes from the current sim
   * time - no reset, statistics continue. Returns false when there is nothing to continue
   * (not finished by reaching the end, or an unbounded end). Reset restores the original end.
   */
  continueRun(): boolean {
    const rc = this._runComplete;
    if (!rc || rc.reason !== 'duration-reached') return false;
    const end = this.manager.duration;
    if (!Number.isFinite(end)) return false;
    const base = this._continueBaseEnd ?? end;
    if (!(base > 0)) return false;
    this._continueBaseEnd = base;
    this.manager.duration = end + base;
    this.manager.rearmWarmup();
    this.identity.reopen();   // same run: id + seed kept, archive entry replaced at the next finish
    this._refreshRunComplete();
    return true;
  }

  private _runComplete: { reason: DesRunCompleteReason; simTime: number } | null = null;
  get runComplete(): { reason: DesRunCompleteReason; simTime: number } | null { return this._runComplete; }
  get paused(): boolean { return this.manager.isPaused; }

  /** Sample model events on demand in the same order as queue dispatch. */
  peekEvents(n: number, filter?: { component?: string; action?: string }): DesPeekResult {
    const limit = Number.isFinite(n) ? Math.max(1, Math.min(200, Math.floor(n))) : 20;
    const component = filter?.component?.toLowerCase();
    const action = filter?.action?.toLowerCase();
    const checkpointId = this.manager.checkpointEventId;
    const events = this.manager.getEventQueueSnapshot().filter(e =>
      !e.cancelled && e.id !== checkpointId
      && (!component || e.componentPath.toLowerCase().includes(component) || e.componentShortName.toLowerCase().includes(component))
      && (!action || e.actionName.toLowerCase().includes(action)));
    events.sort((a, b) => {
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
      return a.id < b.id ? -1 : a.id === b.id ? 0 : 1;
    });
    return {
      events: events.slice(0, limit).map(e => ({
        time: e.time, component: e.componentShortName, componentPath: e.componentPath,
        action: e.actionName, muId: e.muId, priority: e.priority,
      })),
      total: events.length,
      truncated: events.length > limit,
    };
  }

  private _restoreBaseEnd(): void {
    if (this._continueBaseEnd !== null) {
      this.manager.duration = this._continueBaseEnd;
      this._continueBaseEnd = null;
    }
  }

  private _refreshRunComplete(): void {
    this._runComplete = null;
    this.manager.rearmCompleteNotified();
    this._checkRunComplete();
  }
  /** Sim time at which component statistics reset (warmup); 0 = off. */
  get statResetTime(): number { return this.manager.statResetTime; }
  setStatResetTime(seconds: number): void { this.manager.statResetTime = Math.max(0, seconds) || 0; }

  /**
   * Per-component runtime states for inspection / debugging (MCP `web_des_*`).
   * Reads the live topology + load off each adapter; `inTransit`/`blocked` come
   * from the component's own `self.local` bookkeeping when present (conveyor /
   * turntable track these), defaulting to 0 for components that don't.
   */
  componentStates(): SimDesComponentState[] {
    return this._instances.map(({ def, self, adapter }) => {
      const local = (self as { local?: Record<string, unknown> }).local ?? {};
      const transit = local.transitMUs as { size?: number } | undefined;
      const blocked = local.blockedMUs as { length?: number } | undefined;
      return {
        name: adapter.node.name,
        type: def.type,
        kind: def.kind ?? '',
        entityId: adapter.entityId,
        load: adapter.currentLoad,
        maxCapacity: adapter.MaxCapacity,
        inTransit: transit?.size ?? 0,
        blocked: blocked?.length ?? 0,
        isBlocked: adapter.isBlocked,
        next: adapter.nextComponents.map(c => c.node.name),
        prev: adapter.previousComponents.map(c => c.node.name),
      };
    });
  }

  /**
   * Per-component utilization statistics + bottleneck, in material-flow order
   * (MCP `web_des_stats` / `web_des_bottleneck`). The bottleneck is the busiest
   * component (highest Working%) excluding sources/sinks — upstream of it parts
   * pile up (Blocked), downstream they starve (Empty).
   */
  statistics(): SimDesStatistics {
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    const comps = sortByMaterialFlow(this._instances.map((i) => i.adapter));
    const components: SimDesComponentStat[] = comps.map((c) => {
      const s = c.getStatistics();
      return {
        path: c.path,
        name: c.node?.name ?? (c.path.split('/').pop() ?? c.path),
        kind: kindOf(c),
        working: r1(s.workingPercent), transport: r1(s.transportPercent ?? 0), setup: r1(s.setupPercent), blocked: r1(s.blockedPercent),
        slowed: r1(s.slowedPercent ?? 0), stopped: r1(s.stoppedPercent ?? 0),
        empty: r1(s.emptyPercent), failure: r1(s.failurePercent), utilization: r1(s.utilization),
        outputPerHour: r1(s.outputPerHour), totalProcessed: s.totalProcessed, currentState: s.currentState,
      };
    });
    let bottleneck: SimDesStatistics['bottleneck'] = null;
    let meanSum = 0, meanN = 0, throughput = 0;
    for (const c of components) {
      if (c.kind === 'source') continue;
      if (c.kind === 'sink') { throughput += c.outputPerHour; continue; }
      meanSum += c.utilization; meanN++;
      if (!bottleneck || c.working > bottleneck.working) bottleneck = { path: c.path, name: c.name, working: c.working };
    }
    return {
      simTime: r1(this.manager.currentTime),
      components, bottleneck,
      meanUtilization: meanN ? r1(meanSum / meanN) : 0,
      throughputPerHour: r1(throughput),
    };
  }

  /**
   * Serialize the FULL simulation state to JSON (plan-261 B2 / Phase 2.5):
   * manager (clock, RNG, event queue) + components + MUs + drives + signals +
   * script-component states through the shared snapshot pipeline,
   * so F2/F3/F4 hold for the customer-facing `SimDesControl` path too.
   */
  snapshotJson(): string {
    return JSON.stringify(this.fullSnapshot());
  }

  /** Restore a v4 JSON envelope; preflight refuses legacy data before mutation. */
  restoreJson(json: string): void {
    this.restoreFull(JSON.parse(json));
  }

  /** Owners explicitly promising to rebuild transient callbacks after restore. */
  readonly replanOnRestore = new Set<string>();

  private _snapshotFailure(code: string, detail: string, context: object = {}): never {
    const { title, text } = snapshotUserMessage(code);
    reportProblem({ id: code, code, severity: 'warning', title, detail: `${text} [${code}] ${detail}` });
    throw Object.assign(new Error(`${code}: ${detail}`), { code, userMessage: text, ...context });
  }

  private _snapshotFingerprint() {
    const now = this.fingerprintNow();
    if (!now.ok) this._snapshotFailure('des-snapshot-fingerprint', now.reasons.join('; '));
    const bound = this.fingerprintAtBind();
    if ('pending' in bound) this._snapshotFailure('des-snapshot-fingerprint', 'fingerprint pending; model hashes not ready');
    if (!bound.ok) this._snapshotFailure('des-snapshot-fingerprint', bound.reasons.join('; '));
    if (bound.fingerprint.modelHash !== now.fingerprint.modelHash)
      this._snapshotFailure('des-snapshot-fingerprint', 'model changed since run start — restart the run');
    return now.fingerprint;
  }

  private _snapshotComponents = new Map<string, { provider: SnapshotComponentProvider; services: readonly string[] }>();

  registerSnapshotComponents(id: string, provider: SnapshotComponentProvider,
    services: readonly string[] = []): () => void {
    if (this._snapshotComponents.has(id)) throw new Error(`duplicate snapshot components '${id}'`);
    this._snapshotComponents.set(id, { provider, services });
    let registered = true;
    return () => { if (registered) { this._snapshotComponents.delete(id); registered = false; } };
  }

  private _snapshotProviders = new Map<string, SnapshotProvider>();

  registerSnapshotProvider(id: string, provider: SnapshotProvider): () => void {
    if (this._snapshotProviders.has(id)) throw new Error(`duplicate snapshot provider '${id}'`);
    const providers = this._snapshotProviders;
    providers.set(id, provider);
    let registered = true;
    return () => { if (registered) { providers.delete(id); registered = false; } };
  }

  private _snapshotParticipants(raw?: DESSnapshotV4, restoring = false) {
    const components = new Map(this._instances.map(i => [i.desId!, i.adapter as DESComponent] as const).sort(([a], [b]) => a.localeCompare(b)));
    type AddressSource = { getAddressForNode(node: unknown): string | null };
    const host = this._topology?.host as unknown as { registry?: AddressSource | null; desAddresses?: AddressSource | null; blockageWatch?: import('../../core/diagnostics/rv-blockage-watch').BlockageWatch; progressWiring?: import('../../core/diagnostics/rv-progress-wiring').ProgressWiring | null } | undefined;
    const addresses = host?.desAddresses ?? host?.registry;
    const componentExtraServices = new Map<string, readonly string[]>();
    const addressOf = (node: Object3D): string | null => {
      const address = addresses?.getAddressForNode(node);
      if (!address) this._snapshotFailure('des-snapshot-unaddressable', `Component: ${node.name}`);
      return address!;
    };
    // Derived owners are participants, not model identity/fingerprint entries.
    for (const { provider, services } of this._snapshotComponents.values()) {
      for (const [id, component] of provider({ addressOf })) {
        if (!id || components.has(id) || [...components.values()].includes(component))
          this._snapshotFailure('des-snapshot-contract', `duplicate snapshot component '${id}'`);
        components.set(id, component);
        componentExtraServices.set(id, services);
      }
    }
    const sortedComponents = new Map([...components].sort(([a], [b]) => a.localeCompare(b)));
    const drives = new Map<string, RVDrive>();
    for (const drive of this.collectDrives()) {
      const id = this._driveAddress(drive.node);
      if (!id || (drives.has(id) && drives.get(id) !== drive)) this._snapshotFailure('des-snapshot-unaddressable', `Drive: ${drive.node.name}`);
      drives.set(id, drive);
    }
    // uuid <-> address map for `Flow.Occupied@<uuid>` signal keys, built only when such a key occurs
    // (a full scene walk costs hundreds of ms on large scenes).
    let signalMaps: { ids: Map<string, string>; live: Map<string, string> } | null = null;
    const maps = () => {
      if (signalMaps) return signalMaps;
      const ids = new Map<string, string>();
      this._topology?.root.traverse(node => {
        const id = addresses?.getAddressForNode(node);
        if (id) ids.set(node.uuid, id);
      });
      return (signalMaps = { ids, live: new Map([...ids].map(([uuid, address]) => [address, uuid])) });
    };
    const frame = runnerParticipants({ scripts: this.resolveScriptComponents(), manager: this.manager, components: sortedComponents, componentExtraServices, drives, blockageWatch: host?.blockageWatch, progressWiring: host?.progressWiring,
      signalKey: (key, restoring) => {
        const at = key.indexOf('Flow.Occupied@');
        if (at < 0) return key;
        const start = at + 'Flow.Occupied@'.length;
        const suffix = key.slice(start);
        return key.slice(0, start) + ((restoring ? maps().live : maps().ids).get(suffix) ?? suffix);
      },
      signals: this.resolveSignalStore(), // A tween of a retired / released MU has no effect and its MU is not in the MU parts: leave it out.
      tweens: () => this.tweens.toSnapshot(target => {
        const ref = target.node ? this._driveAddress(target.node as Object3D) : null;
        if (!ref || !drives.has(ref)) throw new Error('drive tween has no registered address');
        return ref;
      }, handle => [...this._eventTweens].find(([, list]) => list.some(t => t.handle === handle))?.[0] ?? null)
        .filter(t => { if (t.kind === 'drive') return true; const mu = this.manager.getMU(t.muId); return !!mu && !mu.retired; }),
      pathExists: id => !!getDefaultPathNetwork().get(id), jsonPayload: data => this._jsonHookPayload(data, true),
      replanOnRestore: this.replanOnRestore }, raw, restoring);
    try {
      for (const provider of this._snapshotProviders.values()) for (const part of provider({ raw, restoring })) {
        frame.registry.register(part);
        frame.queueContext.participants.add(part.key);
      }
    } catch (error) { this._snapshotFailure('des-snapshot-contract', String(error)); }
    this._checkUnclaimedDrives([...drives.values(), ...frame.registry.order().flatMap(p => [...(p.claimsDrives?.() ?? [])])],
      node => addresses?.getAddressForNode(node) ?? null);
    return frame;
  }

  /**
   * Unclaimed drives that move or rest away from their start position refuse capture and restore (plan-2059 phase 8).
   * `isRunning` alone is no motion: ChainTransfer parks its lift with `moveTo(0)` in setup, which leaves a pending
   * no-op command (target = position = start, speed 0) on a fresh world; DES never moves that lift (plan-2059 O4).
   */
  private _checkUnclaimedDrives(claimedDrives: readonly object[], addressOf: (node: Object3D) => string | null): void {
    const claimed = new Set<object>(claimedDrives);
    const all = (this._topology?.host as { drives?: readonly RVDrive[] } | undefined)?.drives ?? [];
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0); // a drive-like object without the field is at rest
    for (const drive of all) if (!claimed.has(drive) && !isFollowerDrive(drive) && (num(drive.currentSpeed) !== 0
      || drive.jogForward === true || drive.jogBackward === true || (num(drive.targetPosition) !== 0 && num(drive.targetPosition) !== num(drive.currentPosition)) || num(drive.currentPosition) !== num(drive.StartPosition))) {
      this._snapshotFailure('des-state-not-declared', `Drive: ${addressOf(drive.node) ?? drive.node.name}`);
    }
  }

  private _checkSnapshotBlockers(): void {
    const reasons = (this._topology?.host as { snapshotBlockers?: DesSnapshotBlockers } | undefined)?.snapshotBlockers?.reasons() ?? [];
    if (reasons.length) this._snapshotFailure('des-snapshot-unsupported-component', reasons.join('; '));
  }

  /**
   * plan-2212: while the run waits for its scripts (cold QuickJS host) the
   * material startup (setup, generators) has not run yet. A capture would save
   * half-initialised state, and a restore would be overrun by the pending
   * startup when the barrier opens (state reset, generator events twice).
   */
  private _refuseWhileStartupPending(): void {
    if (this._pendingMaterialStart) {
      this._snapshotFailure('des-snapshot-scripts-pending', 'the run waits for its scripts; material startup pending');
    }
  }

  /**
   * plan-2212 Phase 3 - the snapshot rule for Model-Scripts: a script's DECLARED
   * state (persist, FSM state, `self.every` timers, RNG position, published
   * `statValue` rows, `onSnapshot`/`onRestore`) is captured in full. A script
   * that runs on the DES clock with a `des-script-undeclared-state` lint WARNING
   * (not `DesSafe`) also holds closure state no snapshot can see - capturing it
   * would lose that state silently, and restoring into it would continue from a
   * fresh closure. Both are refused visibly instead, naming the script and the
   * finding; the script itself keeps running (Phase 1 rule).
   */
  private _refuseUndeclaredScriptState(): void {
    const found = this.resolveScriptComponents()
      .filter(s => typeof s.adapter.undeclaredState === 'string' && s.adapter.undeclaredState.length > 0)
      .map(s => `Script ${s.path}: ${s.adapter.undeclaredState}`);
    if (found.length) this._snapshotFailure('des-script-undeclared-state', found.join('; '));
  }

  fullSnapshot(): DESSnapshotV4 {
    this._refuseWhileStartupPending();
    this._checkSnapshotBlockers();
    this._refuseUndeclaredScriptState();
    const identity = this.desIdentity();
    if (identity.unaddressable.length) this._snapshotFailure('des-snapshot-unaddressable', identity.unaddressable.map(i => i.label).join('; '));
    // plan-2059 phase 8: a capture is side-effect free. It used to advance the event clock
    // to the render clock first; code that reads the clock between events (fleet SOC status,
    // dock due times, progress sampling) then saw a different time than in a run without that
    // capture, so an autosave changed the run. Both clocks are stored instead.
    const fingerprint = this._snapshotFingerprint();
    try {
      const frame = this._snapshotParticipants();
      const eventQueue = frame.persistedEvents();
      const muIds: number[] = [];
      for (let i = 0; i < this.manager.muCount; i++) if (this.manager.getMU(i)) muIds.push(i);
      return captureDetached(frame.registry, { version: 4, fingerprint, simTime: this.manager.currentTime,
        // A render clock behind the event clock (direct manager stepping) counts as the event clock, as in _advanceTimed.
        renderClock: Math.max(this._renderClock, this.manager.currentTime),
        nextEventId: this.manager.nextEventId, eventQueue, muIds,
        statisticsCurrent: Object.fromEntries(this._instances.map(i =>
          [i.desId!, snapshotStatistics([i.adapter as DESComponent])[i.adapter.path]])) }) as unknown as DESSnapshotV4;
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'des-snapshot-contract';
      return this._snapshotFailure(code, String(error));
    }
  }

  restoreFull(raw: unknown): void {
    this._refuseWhileStartupPending();
    this._checkSnapshotBlockers();
    this._refuseUndeclaredScriptState();
    this._refuseRestoreOnSceneChange();
    const fingerprint = this._snapshotFingerprint();
    // Legacy shapes reach the frame's preflight without any v4 field access.
    const snapshot = raw as DESSnapshotV4;
    const frame = this._snapshotParticipants(snapshot?.version === 4 ? snapshot : undefined, true);
    const deferred = createDeferredReactions();
    let bracket = false;
    const result = restoreTransaction(raw, { registry: frame.registry, deferred,
      preflight: { fingerprint, componentTypeOf: frame.queueContext.componentTypeOf,
        getActionSchema, desOwners: frame.queueContext.desOwners, replanOnRestore: this.replanOnRestore,
        queueChecks: (events, parts) => scriptTimerQueueProblems(events, parts, new Set(this.resolveScriptComponents().map(s => s.desId!))),
        handleRefs: parts => {
          const refs: import('./rv-des-preflight').SnapshotHandleRef[] = [];
          const actions = ACTION_SCHEMA.keys();
          for (const action of actions) {
            const schema = getActionSchema(action);
            if (!schema || schema === 'non-persistent') continue;
            for (const part of parts) {
              if (schema.owner !== 'component' && schema.owner !== part.key) continue;
              if (schema.owner === 'component' && !fingerprint.components.some(c => c.id === part.key
                && (!schema.targetType || schema.targetType === c.type))) continue;
              for (const path of schema.handleFields ?? []) {
                let value: unknown = part.state;
                for (const segment of path.split('.')) value = value && typeof value === 'object'
                  ? (value as Record<string, unknown>)[segment] : undefined;
                refs.push({ participant: part.key, path, eventId: value as number, action,
                  owner: schema.owner === 'component' ? part.key : schema.owner });
              }
            }
          }
          return refs.concat(scriptTimerHandleRefs(parts, new Set(this.resolveScriptComponents().map(s => s.desId!))));
        } },
      hooks: [{ label: 'des.apply', run: () => {
        this.identity.beginRestore();
        beginDesRestore(); bracket = true;
        this._prepareSnapshotApply();
        const tweens = frame.apply(snapshot.simTime);
        if (!this.headlessSpawnActive) this._materializeHeadlessMUs();
        frame.restoreSampler();
        const handles = this.tweens.fromSnapshot(tweens,
          id => (this.manager.getMU(id) as DESMU | null)?.visual as unknown as PositionTweenTarget | null,
          id => getDefaultPathNetwork().get(id),
          ref => { const drive = this._driveByAddress(ref); return drive ? this._axisTweenTarget(drive) : null; });
        this._relinkRestoredTweens(tweens, handles);
        // Leg windows are owned by queued events, not MU tween snapshots.
        // Reattach once after fromSnapshot (which clears the registry), retaining
        // original clocks and the event->handle link used by cancellation.
        for (const [eventId, payload] of frame.restoredHookPayloads()) {
          const data = (payload as { data?: unknown } | null)?.data;
          const window = legTweenWindow(data);
          if (!window) continue;
          const attached = this._attachTweenFromData(data, window.duration, window.t0);
          this._eventTweens.set(eventId, attached);
          for (const tween of attached) this.tweens.samplePathAt(tween.handle, window.renderT ?? snapshot.simTime);
        }
        // The render clock may run ahead of the last processed event (animated mode): restore both.
        this._renderClock = typeof snapshot.renderClock === 'number' ? snapshot.renderClock : this.manager.currentTime;
        if (this._instances.length > 0) this._started = true;
        for (const reaction of finishDesRestore(true)) deferred.defer(reaction);
        bracket = false;
        this.identity.endRestore();
      } }],
      onCorrupt: () => {
        if (bracket) { finishDesRestore(false); bracket = false; }
        this.identity.endRestore();
        reportProblem({ id: 'des-restore-commit-failed', code: 'des-restore-commit-failed', severity: 'error',
          title: snapshotUserMessage('des-restore-commit-failed').title, detail: `${snapshotUserMessage('des-restore-commit-failed').text} [des-restore-commit-failed] Apply or finalization failed.` });
        this.reset();
      },
    });
    if (!result.ok) {
      if (bracket) { finishDesRestore(false); this.identity.endRestore(); }
      this._snapshotFailure(result.status === 'corrupt' ? 'des-restore-commit-failed'
        : result.problems?.[0]?.code ?? 'des-snapshot-contract', result.problems?.map(p => p.reason).join('; ') ?? String(result.cause), { status: result.status, stage: result.stage });
    }
    this._refreshRunComplete();
    this._lcRestored();
  }

  /** plan-645 R2-2: throws (and reports) when the scene changed since the last bind. */
  private _refuseRestoreOnSceneChange(): void {
    const gen = this._topology?.sceneGeneration;
    if (!this._hasSceneBinding || !gen || gen() === this._boundSceneGen) return;
    reportProblem({
      id: 'des-restore-scene-changed',
      severity: 'warning',
      code: 'des-restore-scene-changed',
      title: snapshotUserMessage('des-restore-scene-changed').title,
      detail: `${snapshotUserMessage('des-restore-scene-changed').text} [des-restore-scene-changed] Scene generation changed.`,
    });
    throw Object.assign(new Error('DES: restore refused - the scene changed since the last bind; rebind first (plan-645).'), { code: 'des-restore-scene-changed', userMessage: snapshotUserMessage('des-restore-scene-changed').text });
  }

  private _prepareSnapshotApply(): void {
    this.cancelFastForward();
    releaseAllAxes();

    // Drop current MUs: dispose spawned meshes, clear adapter MU state.
    this._tearingDownMUs = true;
    try {
      this.manager.reset();        // recursively retires MUs and clears the queue
    } finally {
      this._tearingDownMUs = false;
    }
    this.tweens.clear();
    this._eventTweens.clear();
    for (const inst of this._instances) {
      inst.adapter.clearMUState();
      inst.self.prop['__load'] = 0;
    }

  }

  /** The adapters ARE the DES components in the runner path. */
  private collectComponents(): DESComponent[] {
    return this._instances.map((i) => i.adapter as DESComponent);
  }

  /** All live (non-retired) MUs off the manager's slot array. */
  private collectMUs(): DESMU[] {
    const out: DESMU[] = [];
    const n = this.manager.muCount;
    for (let i = 0; i < n; i++) {
      const mu = this.manager.getMU(i) as DESMU | null;
      if (mu && !mu.retired) out.push(mu);
    }
    return out;
  }

  /** Drives registered on the adapters (usually empty in the unified path). */
  private collectDrives(): RVDrive[] {
    const out: RVDrive[] = [];
    for (const inst of this._instances) {
      for (const d of inst.adapter.drives) out.push(d);
    }
    const host = this._topology?.host as { drives?: readonly RVDrive[] } | undefined;
    const registry = (this._topology?.host as { registry?: { getByPath?<T>(type: string, path: string): T | null } } | undefined)?.registry;
    for (const inst of this._instances) {
      const ref = inst.adapter.prop['robotRef'];
      if (inst.def.type === 'RobotHandling' && typeof ref === 'string') {
        const robot = registry?.getByPath?.<{ getAxisDrives(): RVDrive[] }>('RobotIK', ref);
        for (const drive of robot?.getAxisDrives() ?? []) if (!out.includes(drive)) out.push(drive);
      }
    }
    for (const drive of host?.drives ?? []) {
      if (this._instances.some(i => {
        if (i.def.type !== 'Turntable' && i.def.type !== 'RobotHandling') return false;
        let node: Object3D | null = drive.node;
        while (node) { if (node === i.adapter.node) return true; node = node.parent; }
        return false;
      }) && !out.includes(drive)) out.push(drive);
    }
    return out;
  }

  /** The viewer's SignalStore, resolved structurally off the topology host. */
  private resolveSignalStore(): SignalStore | null {
    const host = this._topology?.host as unknown as { signalStore?: { getAll?: () => unknown } } | undefined;
    const store = host?.signalStore;
    return store && typeof store.getAll === 'function' ? (store as unknown as SignalStore) : null;
  }

  /**
   * Script components (plan-261 B4): explicit injection wins; otherwise the
   * public `web-component` plugin is resolved off the topology host.
   */
  private resolveScriptComponents(): ScriptStateSource[] {
    if (this._scriptComponentSource) return this._scriptComponentSource();
    const host = this._topology?.host as unknown as { getPlugin?(id: string): unknown } | undefined;
    const plugin = host?.getPlugin?.('web-component') as
      { listScriptComponents?(): ScriptStateSource[] } | undefined | null;
    return plugin?.listScriptComponents?.() ?? [];
  }

  /** plan-2212: inject the script binding target explicitly (tests / custom wiring). */
  setScriptBindingTarget(target: ScriptDesBindingTarget | null): void {
    this._scriptBindingTarget = target;
  }

  /** The script binding target: explicit injection wins, else the host's `web-component` plugin. */
  private _resolveScriptBinding(): ScriptDesBindingTarget | null {
    if (this._scriptBindingTarget) return this._scriptBindingTarget;
    const host = this._topology?.host as unknown as { getPlugin?(id: string): unknown } | undefined;
    const plugin = host?.getPlugin?.('web-component') as Partial<ScriptDesBindingTarget> | undefined | null;
    return plugin && typeof plugin.bindDes === 'function' && typeof plugin.unbindDes === 'function'
      ? plugin as ScriptDesBindingTarget : null;
  }

  /**
   * IMPLEMENTS SimDesControl::makeScriptScheduler (plan-2212): the DES-clock
   * scheduler of one script component - `self.in/at` become `Script.Hook`
   * events on this runner's queue.
   */
  makeScriptScheduler(dispatcher: ScriptHookDispatcher): SdkScheduler {
    return makeScriptHookScheduler(this.manager, dispatcher);
  }

  /** The run seed of one script: v2 = `scriptSeed32(master, desId)`, v1 = path seed (null). */
  private _scriptRunSeed(desId: string | null): number | null {
    if (this.manager.rngVersion !== 2 || !desId) return null;
    return scriptSeed32(this.manager.masterSeed, desId);
  }

  /**
   * plan-2212: (re)build every Model-Script for this run on the DES clock -
   * called from `_startWith` after the discovery, the seed choice and the
   * component-registration cleanup, before any generator starts. Every
   * replication rebuilds (fresh persist / FSM / timers, run seed before
   * `setup()`); the binding stays active for scripts created later in the run.
   */
  private _bindScripts(): void {
    const target = this._resolveScriptBinding();
    if (this._boundScriptTarget && this._boundScriptTarget !== target) this._unbindScripts();
    this._scriptBarrier = null;
    this._pendingMaterialStart = null;
    if (!target) return;
    this._boundScriptTarget = target;
    target.bindDes({
      makeScheduler: (dispatcher) => this.makeScriptScheduler(dispatcher),
      seedFor: (desId) => this._scriptRunSeed(desId),
      onInstance: () => { if (this._started) this._recomputeSettleRequired(); },
      onLintWarning: (path, code, message) => {
        console.warn(`[DESRunner] script ${path}: ${code}: ${message}`);
      },
      displayFrames: () => this.scriptFramesActive,
      sinks: this._scriptSinks,
    });
    // R2-3: scripts still being wired (cold QuickJS host) must exist before the
    // first event; a load failure is visible and the run goes on without them.
    clearProblem(DES_SCRIPTS_UNAVAILABLE_CODE);
    if (target.wiringPending && typeof target.whenWired === 'function') {
      const barrier: Promise<void> = target.whenWired()
        .catch(() => { /* the wiring reports its own failure */ })
        .then(() => {
          if (this._scriptBarrier !== barrier) return;
          this._scriptBarrier = null;
          this._reportScriptWiring(target);
          // review #3: material startup waited for the scripts - ONE startup
          // order (scripts' setup, then material setup + generators) cold or warm.
          const start = this._pendingMaterialStart;
          this._pendingMaterialStart = null;
          clearProblem('des-snapshot-scripts-pending');   // a refusal while waiting is resolved now
          if (start && this._started) {
            try { start(); } catch (error) { this._actionFailed(error); }
          }
          this._recomputeSettleRequired();
        });
      this._scriptBarrier = barrier;
    } else {
      this._reportScriptWiring(target);
    }
  }

  private _reportScriptWiring(target: ScriptDesBindingTarget): void {
    const error = target.wiringError?.() ?? null;
    // A successful wiring retires an earlier refusal (the plugin also clears it per model).
    if (!error) { clearProblem(DES_SCRIPTS_UNAVAILABLE_CODE); return; }
    reportProblem({
      id: DES_SCRIPTS_UNAVAILABLE_CODE, code: DES_SCRIPTS_UNAVAILABLE_CODE, severity: 'warning',
      title: 'Scripts not running in this DES run',
      detail: `The DES run starts without its Model-Scripts: ${error}`,
    });
  }

  /**
   * plan-2212 Phase 2: the DES sinks behind `self.sink(path).on` of Model-Scripts.
   * A subscription is a listener on the sink's `MaterialFlowAdapter`
   * (`addConsumedListener`), called synchronously at the end of `acceptMU` at the
   * DES time of the arrival - no queue event, nothing extra in a snapshot.
   * Delivery order among scripts on one sink = script node path order (the
   * `orderKey`), independent of when a script was (re)built. Every listener
   * belongs to one script VM and is released with it: the rebuild of each
   * replication / `rebindScene()` (`bindDes` re-mints), `unbindDes` and a
   * single-script reload all dispose the VM, whose SDK unsubscribes every `on`.
   * Adapters are only replaced by a scene rebind, which re-mints the scripts in
   * the same `_startWith` - a subscription never outlives its adapter's run.
   */
  private readonly _scriptSinks: WebComponentDesSinks = {
    find: (path, node) => {
      const sinks = this._instances.filter(i => i.def.kind === 'sink');
      const hit = node
        ? sinks.find(i => i.adapter.node === node)
        : this._findSinkByPath(sinks, path);
      return hit ? this._sinkRef(hit.adapter) : null;
    },
    all: () => this._instances.filter(i => i.def.kind === 'sink').map(i => this._sinkRef(i.adapter)),
  };

  private _sinkRef(adapter: MaterialFlowAdapter): WebComponentDesSinkRef {
    return {
      node: adapter.node,
      subscribe: (cb, orderKey) => adapter.addConsumedListener(mu => cb({ id: mu.id }), orderKey),
    };
  }

  /**
   * A sink by script path when the viewer registry cannot name its node
   * (headless hosts): the node-name path below the run's scene root, else a
   * unique node name.
   */
  private _findSinkByPath(sinks: RunnerInstance[], path: string): RunnerInstance | undefined {
    const root = this._topology?.root ?? null;
    const rel = (n: Object3D): string => {
      const parts: string[] = [];
      for (let cur: Object3D | null = n; cur && cur !== root; cur = cur.parent) parts.unshift(cur.name);
      return parts.join('/');
    };
    const exact = sinks.find(i => rel(i.adapter.node) === path);
    if (exact) return exact;
    const named = sinks.filter(i => i.adapter.node.name === path);
    return named.length === 1 ? named[0] : undefined;
  }

  /**
   * plan-2212: Model-Scripts back to the frame clock (switch to continuous,
   * dispose). Callers run it AFTER the open run is archived (R2-2) - the
   * rebuild throws the scripts' end state away.
   */
  private _unbindScripts(): void {
    const target = this._boundScriptTarget;
    this._boundScriptTarget = null;
    this._scriptBarrier = null;
    this._pendingMaterialStart = null;
    if (!target) return;
    try { target.unbindDes(); } catch (e) {
      console.error('[DESRunner] script unbind failed:', e);
    }
  }

  /**
   * IMPLEMENTS SimulationExecutor::archiveOpenRun (plan-2212 review #2): archive
   * the open run with the live state, before a teardown disposes its scripts.
   */
  archiveOpenRun(): void {
    this.identity.archiveOpenRun();
  }

  /** What the simulation clock must wait for: the run's scripts (plan-2212), then its KPI sources (plan-2211). */
  private _progressBarrier(): Promise<void> | null {
    return this._scriptBarrier ?? this.identity.kpiSourcesPending;
  }

  /**
   * Resolves once the run's progress barrier is gone (scripts and KPI sources). Synchronous
   * drivers (`tick`, `step`) do not advance while it is pending; FastForward awaits it itself.
   */
  async kpiSourcesReady(): Promise<void> {
    for (let barrier = this._progressBarrier(); barrier; barrier = this._progressBarrier()) await barrier;
  }

  /** True while the run waits for its scripts (plan-2212 R2-3 readiness barrier). */
  get scriptsPending(): boolean {
    return this._scriptBarrier !== null;
  }

  /** Inject the script-component source explicitly (tests / custom wiring). */
  setScriptComponentSource(fn: (() => ScriptStateSource[]) | null): void {
    this._scriptComponentSource = fn;
    // The script components count into the settle gating (Phase 2b / R4).
    this._recomputeSettleRequired();
  }

  // ─── Settle gating (plan-262 Phase 2) ────────────────────────────────────

  /**
   * Recount the settle consumers and (re)wire `manager.onTimeAdvance`:
   *  - every live instance whose definition declares `des.samplesLiveGeometry`,
   *  - plus ONE slot when any active script component may read live geometry
   *    (plan-2212 Phase 4b, exact gate `samplesLiveGeometry()`: the script's
   *    `des: { samplesLiveGeometry: true }` opt-in, or a source the conservative
   *    static check cannot prove geometry-free). Adapters without that probe
   *    fall back to `hasDesHooks()` (Phase 2b / R4), and without any probe they
   *    count (conservative).
   *
   * With 0 consumers the single-slot `onTimeAdvance` is null — the manager
   * skips the per-event-time settle entirely (pure conveyor/station lines).
   * The multi-slot `addTimeAdvanceListener` (checkpoints, plan-260) is a
   * separate mechanism and is never touched here.
   */
  private _recomputeSettleRequired(): void {
    let n = 0;
    for (const inst of this._instances) {
      if (inst.def.des?.samplesLiveGeometry === true) n++;
    }
    if (n === 0) {
      for (const sc of this.resolveScriptComponents()) {
        // plan-2212 Phase 4b: the exact gate - a script counts only when it may
        // read live geometry (explicit opt-in or not proven geometry-free).
        const exact = (sc.adapter as { samplesLiveGeometry?(): boolean }).samplesLiveGeometry;
        if (typeof exact === 'function') {
          if (exact.call(sc.adapter)) { n++; break; }
          continue;
        }
        const probe = (sc.adapter as { hasDesHooks?(): boolean }).hasDesHooks;
        // No probe (older/structural adapter) → conservative: count it.
        if (typeof probe !== 'function' || probe.call(sc.adapter)) { n++; break; }
      }
    }
    this._settleRequired = n;
    this._updateSettleWiring();
  }

  /** Wire/unwire the per-event-time settle according to `_settleRequired`. */
  private _updateSettleWiring(): void {
    this.manager.onTimeAdvance = this._settleRequired > 0
      ? (t): void => {
          this.tweens.settle(t, 'event', this._subMode === 'fastforward' || this._ffActive);
        }
      : null;
  }

  /**
   * DEV-ONLY safety net (plan-262 Phase 2, risk "forgotten flag"): warn once
   * per type when a des hook of a definition WITHOUT `samplesLiveGeometry`
   * dispatches while the settle is globally off and the dispatched MU's visual
   * is still mid-tween — if that hook samples live geometry it reads a STALE
   * position. Pragmatic approximation (only the MU's own position tween is
   * checked); wired by `addInstance` behind `import.meta.env.DEV`, so it is
   * dead code in production builds.
   */
  private _devSettleGuard(def: MaterialFlowDefinition, suffix: string, mu: MU | null): void {
    if (this._settleRequired > 0) return;                // settle is on — fine
    if (def.des?.samplesLiveGeometry === true) return;   // opted in
    if (this._devWarnedSettleTypes.has(def.type)) return;
    // Cheap early-outs BEFORE building the dev target set (this guard runs on
    // every dispatch in dev builds — keep the common path allocation-free).
    const visual = (mu as { visual?: unknown } | null)?.visual;
    if (!visual || this.tweens.activeCount === 0) return;
    const running = this.tweens.devActivePositionTargets(this.manager.currentTime);
    if (!running || !running.has(visual as PositionTweenTarget)) return;
    this._devWarnedSettleTypes.add(def.type);
    console.warn(
      `[DESRunner] des hook '${def.type}.${suffix}' dispatched while the event-time tween settle `
      + `is disabled and its MU is mid-tween. If this hook samples live geometry `
      + `(getWorldPosition / world transforms), declare 'des: { samplesLiveGeometry: true }' `
      + `on the '${def.type}' definition — otherwise it reads STALE positions in FastForward.`,
    );
  }

  /** Template-keyed visual lookup; unknown ids receive the registry fallback. */
  private findVisualFactory(templateId: string): () => DESMU['visual'] {
    return () => this._createMuVisual(templateId);
  }

  // ── Experiment / snapshot storage (plan-261 Phase 3, SimDesControl) ─────

  /** Master PRNG seed of the DES manager (SimDesControl surface). */
  get masterSeed(): number {
    return this.manager.masterSeed;
  }

  /** RNG algorithm version is a run parameter (1 = legacy, 2 = named streams; plan-2061). */
  get rngVersion(): import('../../core/rv-rng-streams').RngVersion {
    return this.manager.rngVersion;
  }

  setRngVersion(v: number): void {
    this.manager.setRngVersion(v);
  }

  /** Set the master seed (RNG streams re-derive from the next reset/start). */
  setMasterSeed(seed: number): void {
    this._seedOverride = seed;
    this.manager.setMasterSeed(seed);
  }

  /** LogicSteps, PLC programs and IK paths present in the model (viewer's blocker registry); they do not advance in a batch. */
  private _logicHazards(): readonly DesLogicPresence[] {
    return (this._topology?.host as { snapshotBlockers?: DesSnapshotBlockers } | undefined)?.snapshotBlockers?.batchHazards() ?? [];
  }

  private _reportLogicProblem(code: 'des-batch-logic-unsupported' | 'des-fastforward-logic-warning', severity: 'error' | 'warning', detail: string): void {
    const { title, text } = snapshotUserMessage(code);
    reportProblem({ id: code, code, severity, title, detail: `${text} [${code}] ${detail}` });
  }


  // ─── SimulationExecutor lifecycle ──────────────────────────────────────

  /**
   * Begin simulating. Registers each definition's `des` hooks as named actions
   * (once per type, R3), runs the shared `def.setup(self)` for every instance,
   * registers the adapters with the manager, then runs `des.onGenerate` /
   * source starts. Sources re-spawn fresh with the same seed (Reset-on-Switch).
   */
  start(defs: MaterialFlowDefinition[], topology: SimulationTopology): void {
    this._actionFailure = false;
    // plan-645 L4 (c7): the scene moved on since this runner bound it (e.g.
    // placements arrived while continuous was active) → bind anew instead of
    // reusing stale instances. Only with a scene binding; the internal start of
    // rebindScene() goes through _startWith directly (no recursion).
    if (this._hasSceneBinding && this._topology === topology && topology.sceneGeneration
        && topology.sceneGeneration() !== this._boundSceneGen
        // same condition as rebindScene's ownsDiscovery - never its reset() fallback (no loop)
        && (this._instances.length === 0 || this._instances.some((i) => i.scene))) {
      this.rebindScene();
      return;
    }
    this._startWith(defs, topology, false);
  }

  /** Scene generation of the last successful scene bind (plan-645 L4); null = none. */
  get boundSceneGeneration(): number | null { return this._boundSceneGen; }

  /** True after a successful scene discovery (plan-645 R2-4). */
  get hasSceneBinding(): boolean { return this._hasSceneBinding; }

  private _diagnosticsOff: (() => void) | null = null;
  private _diagnosticsHookBound = false;

  /** The topology host supplies core services structurally; core never imports DES. */
  private _bindDiagnostics(topology: SimulationTopology): void {
    this._diagnosticsOff?.();
    this._diagnosticsOff = null;
    const host = topology.host as unknown as {
      readonly progressLedger?: ProgressLedger | null;
      readonly waitRegistry?: WaitRegistry | null;
    } | undefined;
    const ledger = host?.progressLedger, registry = host?.waitRegistry;
    if (!ledger || !registry) return;
    const tracked = new Map<MaterialFlowAdapter, { off(): void; count: number; credited: number }>();
    const sample = (): void => {
      for (const inst of this.liveInstances) {
        const a = inst.adapter, id = a.progressUnitId;
        let state = tracked.get(a);
        if (!state) {
          state = { off: () => {}, count: 0, credited: 0 };
          const counter = state;
          state.off = a.subscribeCompletions(n => {
            counter.count += n;
            ledger.register(id, 'des', 'des');
            ledger.bump(id, 'des', counter.count - counter.credited);
            counter.credited = counter.count;
          });
          tracked.set(a, state);
        }
        ledger.register(id, 'des', 'des');
        if (a.progressArmed) ledger.arm(id); else ledger.inactive(id);
      }
    };
    const offPopulation = ledger.addPopulation({ id: 'des', kind: 'des',
      expected: () => this.liveInstances.map(i => i.adapter.progressUnitId).sort() });
    const offAdapter = ledger.addAdapter({ id: 'des', sample });
    const offEdges = registry.addSource({ id: 'des', edges: now =>
      this.liveInstances.flatMap(i => i.adapter.waitEdges(now)) });
    this._diagnosticsOff = () => {
      offPopulation(); offAdapter(); offEdges();
      for (const [a, state] of tracked) { state.off(); ledger.unregister(a.progressUnitId); }
      tracked.clear();
    };
    if (!this._diagnosticsHookBound) {
      this._diagnosticsHookBound = true;
      this.onSceneUnbind(() => {
        this._diagnosticsOff?.(); this._diagnosticsOff = null; this._diagnosticsHookBound = false;
      });
    }
    sample();
  }

  private _startWith(defs: MaterialFlowDefinition[], topology: SimulationTopology, rediscover: boolean): void {
    this._runComplete = null;
    this._restoreBaseEnd();
    // plan-644: a new run invalidates the port cache before any port query.
    this._portCache.generation++;
    this._defs = defs;
    this._topology = topology;

    // Model-load discovery: when a bind-context host is supplied and no instances
    // were added programmatically (tests do that directly), discover placed
    // material-flow components in the scene and bind each one (Plan 194 P5b). This
    // is what makes a loaded layout actually flow MUs under the DESRunner.
    // `rediscover` (only from `rebindScene()`) binds the scene again after its
    // previously discovered instances were dropped.
    if ((rediscover || this._instances.length === 0) && topology.host && topology.root) {
      const count = bindSceneToRunner(this, topology.root, topology.host);
      console.info(`[DESRunner] bound ${count} material-flow instance(s) from the scene.`);
      // plan-645 R2-4 / L4: recorded AFTER the successful discovery only.
      this._hasSceneBinding = true;
      this._boundSceneGen = topology.sceneGeneration ? topology.sceneGeneration() : null;
      clearProblem('des-restore-scene-changed');
    }

    this._bindDiagnostics(topology);

    // Register hooks for every definition type (R3 — once per type). Cover both
    // the kernel-passed defs AND every discovered instance's def.
    const ensureHooks = (def: MaterialFlowDefinition): void => {
      if (!this._dispatchByType.has(def.type)) {
        this._dispatchByType.set(def.type, registerDesHooks(def));
      }
    };
    for (const def of defs) ensureHooks(def);
    for (const inst of this._instances) ensureHooks(inst.def);

    // Clock settings from the scene (GLB-first): apply the DESManager component's
    // EndTime / StatisticsResetTime so a saved-and-reloaded scene restores them.
    // Absent → keep the manager defaults (86400 s / one day, no warmup reset).
    if (topology.root) {
      const ds = findDesManager(topology.root);
      if (ds) {
        this.manager.duration = ds.endTime;
        this.manager.statResetTime = ds.statResetTime;
      }
    }
    this._backend?.beforeStart();
    this.manager.setMasterSeed(this._nextRunSeed());

    // Register the adapters with the manager (assigns entityIds) and run the
    // shared setup + scheduler wiring. Every start registers ALL instances, so
    // the previous run's registrations go first — without this each reset /
    // mode switch appended the same adapters again (entity ids and the
    // manager's component list grew by one scene per start). Safe only without
    // queued model events (they address components by entity id). Every restart
    // clears model events; warm-up/checkpoint system events may remain queued.
    // plan-2212 R2-1: this runs BEFORE the script rebuild below - a script's
    // setup() may already queue events, which would otherwise skip the cleanup.
    if (this.manager.nextModelEventTime === Number.POSITIVE_INFINITY) this.manager.clearComponents();

    // plan-2212: Model-Scripts rebuilt on the DES clock with the run seed of
    // THIS run fixed before their setup() (the seeding loop below then leaves
    // them alone - their stream must not start twice).
    this._bindScripts();
    for (const script of this.resolveScriptComponents()) {
      if (this.manager.rngVersion === 2) {
        if (!script.desId) throw new Error(`des-rng-id-missing: Script ${script.path}`);
      }
      const desId = script.desId!;
      script.adapter.setRunRngSeed?.(
        this.manager.rngVersion === 2 ? scriptSeed32(this.manager.masterSeed, desId) : null,
        () => this.manager.rngVersion === 2 ? scriptSeed32(this._nextRunSeed(), desId) : null,
      );
    }

    clearProblemsOfCode(DISABLED_PROBLEM_CODE);
    for (const inst of this._instances) {
      const engineSource = inst.def.kind === 'source'
        ? getEngineSourceForNode(inst.adapter.node)
        : null;
      // plan-2059: reload-stable (stored per MU in snapshots) — same id as des-scene-binding.
      const sourceTemplateId = engineSource ? `source:${inst.desId ?? inst.adapter.node.uuid}` : undefined;
      if (engineSource && sourceTemplateId) {
        this.registerMuVisualFactory(
          sourceTemplateId,
          () => engineSource.spawnMU(true) as ReturnType<DESRunner['createMuVisual']>,
          (visual) => { visual.dispose(); },
        );
      }
      inst.adapter.beforeHookDispatch = () => {
        this._activeMuVisualTemplateId = sourceTemplateId;
      };
      this.manager.registerComponent(inst.adapter);
    }

    // Material startup: shared init, then the generators. plan-2212 review #3:
    // it runs AFTER the Model-Scripts' setup - at once with a warm script host,
    // after the readiness barrier with a cold one - so the startup order (and
    // with it the order of same-time events) is the same in both cases.
    const instances = this._instances;
    const startMaterial = (): void => {
      for (const inst of instances) {
        // Shared init (Plan 194 §2.2 `def.setup`) — runs BEFORE any des hook so
        // self.local nodes / signals / prop fields are all initialised.
        if (inst.def.setup) inst.def.setup(inst.self);
        if (inst.def.capacity) inst.adapter.reconfigureCapacity(inst.def.capacity(inst.self));
        reportDisabledInstance(inst);
      }

      bindLoopSaturation(this);

      this._bindModelFingerprint();

      // Kick off generators (des.onGenerate) — every definition that DECLARES
      // the hook gets exactly one start kick: sources spawn their first MU, a
      // downtime component starts its failure cycle, an Agv (plan-268 Phase 3)
      // schedules its first path leg. Declaration-gated (not kind-gated) so a
      // self-driving non-source component can bootstrap without a kind change;
      // behaviour-identical for every pre-268 definition (only source/downtime
      // ever declared onGenerate).
      for (const inst of instances) {
        if (inst.self.disabled) continue; // takes no part in the run (reported above)
        inst.def.des?.onGenerate?.(inst.self);
      }
    };
    if (this._scriptBarrier) {
      // plan-2212: the previous bind's fingerprint must not stay valid while
      // the startup is deferred - startMaterial binds the new one.
      this._fingerprintGeneration++;
      this._bindFingerprint = { pending: true };
      this._pendingMaterialStart = startMaterial;
    } else startMaterial();

    // plan-262 Phase 2: instances (kernel-passed AND scene-discovered) plus the
    // now-resolvable script components decide whether the event-time settle runs.
    this._recomputeSettleRequired();

    this._started = true;

    // Plan-260: a start with LIVE material-flow instances opens a new run
    // (fresh run id at the current master seed). Empty engines never open a
    // run — non-DES scenes stay unaffected (S1).
    if (this._instances.length > 0) {
      this.identity.start();
    }

    // plan-645 L2: the run is bound (first start, reset, rebind).
    this._lcBind();
  }

  /**
   * Pre-PRE pass — the CoreSubsystems early stage (playback → logic → IK →
   * replay). Deliberately NOT gated on `_started`: these viewer-level
   * subsystems always ticked regardless of the DES engine state.
   */
  earlyTick(dt: number): void {
    this.core?.early(dt);
  }

  /**
   * Advance one fixed tick. The sub-mode decides how `simNow` and the event
   * budget interact (Animated/Hybrid/FastForward/Step). The render clock is
   * updated here; `lateTick()` flushes the tweens.
   *
   * Phase B: the CoreSubsystems drive loop runs BEFORE and the visual managers
   * AFTER the event advance — the exact positions the viewer's fixedUpdate
   * hard-wired them into. Both run even when the engine isn't `_started`
   * (drives/gizmos are viewer-level, not DES-level).
   */
  tick(dt: number): void {
    if (this._heldByFf) {
      this._heldByFf = false;
      if (!this._actionFailure) this.manager.resume();
    }
    this.core?.drives(dt);

    // plan-2212 R2-3: no event runs before the scripts present at run start exist.
    if (this._started && this._progressBarrier() === null) {
      switch (this._subMode) {
        case 'animated':
          this._advanceTimed(dt, 1);
          break;
        case 'hybrid':
          this._advanceTimed(dt, this._multiplier);
          break;
        case 'fastforward': {
          // R1 (plan-262): while `runFastForward()`'s async drain loop is in
          // flight it is the ONLY queue driver — the 60 Hz tick must not
          // double-drain on top of it.
          if (this._ffActive) break;
          // Standalone FF (`setSubMode('fastforward')` without
          // `runFastForward()` — the SimModeToggle path): the same time-based
          // deadline as the drain loop, synchronously INSIDE this tick —
          // CPU-limited instead of one fixed batch per frame. No per-frame
          // tween interpolation (lateTick uses the noWrite sub) — but the
          // event-time settle (manager.onTimeAdvance) writes every part at
          // each distinct event time, so positions stay CORRECT (parts
          // visibly jump along their real paths). The slice still yields to
          // the browser every frame, which keeps the toggle INSTANT.
          // (Set a longer / infinite end time on the clock to FF for longer.)
          const deadline = performance.now() + FF_SLICE_MS;
          let processed = 0;
          try {
            do {
              processed = this.manager.processEvents(FF_INNER_BATCH);
              this._sweepConsumedVisuals();
            } while (processed > 0 && !this.manager.isComplete && performance.now() < deadline);
          } catch (error) {
            this._lastFfError = error;
            this._actionFailed(error);
          }
          this._renderClock = this.manager.currentTime;
          // One slice per tick; the frame loop returns to the event loop between
          // ticks, so timers are not starved here (unlike the async drain loop).
          break;
        }
        case 'step':
          // No automatic time advance — `step()` is driven by the UI.
          break;
      }

      this._checkRunComplete();
    }

    this.core?.visuals(dt);
  }

  /** Completion edge detection (plan-260): close the run ONCE when the sim
   *  end is reached (queue drained or next event past the duration). Uses the
   *  manager's once-per-run guard, re-armed by `manager.reset()`. */
  private _checkRunComplete(): void {
    if (this._actionFailure) return;
    if (
      this.manager.totalEventsProcessed > 0
      && this.manager.isComplete
      && this.manager.markCompleteNotified()
    ) {
      const next = this.manager.nextModelEventTime;
      this._runComplete = {
        reason: next !== Infinity ? 'duration-reached'
          : this.manager.duration === Infinity ? 'queue-drained' : 'queue-empty-before-end',
        simTime: this.manager.currentTime,
      };
      this.identity.complete('duration-reached');
    }
  }

  /** Render pass — interpolate the tweens at the render clock, then drop the
   *  meshes of MUs a sink consumed this step (sink sets `visual.markedForRemoval`;
   *  the DES path owns the visual lifecycle, so we dispose it here). */
  lateTick(_dt: number): void {
    if (!this._started) return;
    // FastForward: no per-frame INTERPOLATION here (the 'fastforward' sub is
    // noWrite) — part positions are maintained by the event-time settle instead
    // (manager.onTimeAdvance → tweens.settle), which keeps them exact at every
    // event. Switching back to a slower factor (animated/hybrid) resumes smooth
    // animation from the live sim state. (Animated/Hybrid/Step still write here
    // via _renderSubMode.)
    const wrote = this.tweens.onRender(
      this._renderClock,
      this._renderSubMode(),
      this._subMode === 'fastforward' || this._ffActive,
    );
    // The viewer renders on demand: without this the tweened vehicles / MUs move
    // in the scene graph but only reach the screen on the next user input.
    // FastForward moves parts through the event-time settle instead, so there
    // an advanced clock is the signal.
    const ffAdvanced = (this._subMode === 'fastforward' || this._ffActive)
      && this._renderClock !== this._lastDirtyClock;
    if (wrote || ffAdvanced) this.core?.markGeometryMoved();
    this._lastDirtyClock = this._renderClock;
    this._sweepConsumedVisuals();
  }

  /** Retires sink-consumed MUs still pending outside an event dispatch. Consumed
   *  MUs normally retire at the end of their consuming event in the manager
   *  (`retireAfterEvent`, plan-2212: deterministic MU slot ids); retirement
   *  disposes the visual (`onMURetired`) and frees the slot (deferred while events
   *  still reference it), so retained memory stays bounded by WIP. */
  private _sweepConsumedVisuals(): void {
    // plan-2212: consumed MUs retire at the end of their consuming event inside
    // the manager; only a consumption outside any dispatch can still be pending.
    this.manager.flushRetirements();
  }

  /** Process exactly one event (Step mode). Renders once afterwards. */
  step(): boolean {
    if (!this._started || this._progressBarrier() !== null) return false;
    let ok: boolean;
    try {
      ok = this.manager.processStep();
    } catch (error) {
      this._actionFailed(error);
      return false;
    }
    this._renderClock = this.manager.currentTime;
    if (this.tweens.onRender(this._renderClock, 'step')) this.core?.markGeometryMoved();
    this._checkRunComplete();
    return ok;
  }

  /**
   * Remove all MUs (Reset-on-Switch outgoing step) WITHOUT disposing the engine.
   * Clears the event queue, MUs, and live tweens, and re-seeds the RNG so a
   * restart is reproducible. Components (adapters) stay registered.
   */
  clearMUs(): void {
    this._lcEnd();              // plan-645: `reset` BEFORE anything is torn down
    this.cancelFastForward();   // abort any in-flight FF drain before resetting
    releaseAllAxes();
    // Release the whole previous fleet before setup registers any start pose.
    // Sequential setup otherwise plans against vehicles still at their old poses.
    // Do this before queue ids are reused by manager.reset().
    // Only vehicles + waits: clear() would also reset the authority's clock/time keeping.
    this._releaseTrafficOwners();
    getDefaultMovementAuthority('des').releaseVehicles();
    this._tearingDownMUs = true;
    try {
      this.manager.reset();    // recursively retires MUs + disposes owned visuals
      this._runComplete = null;
      this._restoreBaseEnd();
    } finally {
      this._tearingDownMUs = false;
    }
    this.tweens.clear();
    this._eventTweens.clear();
    this._renderClock = 0;
    // Reset per-instance adapter MU/load state. clearMUState (plan-225 B4) drops
    // held + blocked MUs and the flags so a restart carries no ghost references.
    for (const inst of this._instances) {
      inst.adapter.clearMUState();
      inst.self.prop['__load'] = 0;
    }
    // Instances stay registered, but manager.reset() re-arms internal state —
    // recount so the settle wiring is consistent with the surviving instances.
    this._recomputeSettleRequired();
    this._started = false;
  }

  /**
   * Kernel switch OUT of DES (plan-648 §2.4 / G6): stop a FastForward run, every
   * instance that owns a vehicle id releases it (owner-checked), the DES
   * planner drops its vehicles, and only THEN the queue is cleared for good —
   * a release can still schedule events. The instances stay; the next
   * `start()` re-runs their setup (the one activation point) and they acquire
   * again from their start pose.
   * IMPLEMENTS SimulationExecutor::suspend
   */
  suspend(): void {
    this._lcEnd();              // plan-645: `reset` before the ids are released
    this.cancelFastForward();
    this._releaseTrafficOwners();
    getDefaultMovementAuthority('des').clear();
    this.clearMUs();
    // plan-2212 R2-2: the open run was archived by clearMUs (manager reset hook);
    // only now do the scripts return to the frame clock (fresh continuous VMs).
    this._unbindScripts();
  }

  /** plan-648: every traffic-owning instance (Agv) gives its vehicle id up — a no-op for non-owners. */
  private _releaseTrafficOwners(): void {
    for (const inst of this._instances) {
      const traffic = trafficOwnedOf(inst.def);
      if (!traffic) continue;
      try { traffic.trafficRelease(inst.self); } catch (e) {
        console.error(`[DESRunner] traffic release of '${inst.def.type}' failed:`, e);
      }
    }
  }

  /** Reset to the initial state and restart from the cached defs/topology. */
  reset(): void {
    this.clearMUs();
    clearProblemsOfCode(ACTION_FAILED_PROBLEM_CODE);   // a reset starts a fresh run: old action failures are stale
    if (this._topology) this.start(this._defs, this._topology);
  }

  /**
   * The scene changed under the started runner (plan-612 CP1d-b): the deferred
   * placements of a load materialised AFTER the runner bound the scene (boot
   * into DES). `reset()` keeps its instances and never rediscovers, so the
   * placements would stay outside the runner. This drops the instances the
   * scene binding discovered — their Agv-style traffic records via the
   * definition's existing teardown, their bind contexts, the binding's
   * connection registry, their manager registration and the signal names that
   * no rebound instance declares again (only names without a model path,
   * interface owner or force pin) — then rediscovers and restarts like
   * `reset()`. Programmatic instances (tests) stay. Without a bind host, or
   * when the runner never owned the scene discovery, it is exactly `reset()`.
   * IMPLEMENTS SimulationExecutor::rebindScene
   */
  rebindScene(): void {
    const topology = this._topology;
    if (!topology) return;                       // never started — the first start discovers
    const ownsDiscovery = this._instances.length === 0 || this._instances.some((i) => i.scene);
    if (!ownsDiscovery || !topology.host || !topology.root) {
      this.reset();
      return;
    }
    this._lcEnd();                               // plan-645: `reset` before the teardown
    this.cancelFastForward();
    // plan-644: teardowns below already belong to the ending binding.
    this._portCache.generation++;
    // 1. Tear the scene instances down BEFORE the queue is cleared: a teardown
    //    may wake other vehicles, whose re-plan events must not survive into
    //    the restarted run (the entity ids are reassigned below).
    const dropped = this._instances.filter((i) => i.scene);
    for (const inst of dropped) {
      try { inst.def.continuous?.teardown?.(inst.self); } catch (e) {
        console.error(`[DESRunner] rebind: teardown of '${inst.def.type}' failed:`, e);
      }
    }
    this._disposeSceneBindings(dropped, 'rebind');
    this.clearMUs();                             // queue, MUs, tweens of ALL instances
    this._muVisualFactories.clear();
    this._instances = this._instances.filter((i) => !i.scene);
    this._runSceneHooks();
    this.manager.clearComponents();              // start() re-registers the survivors
    // 2. Bind the scene again and restart (same seed, like reset()).
    this._startWith(this._defs, topology, true);
    // 3. Release names only the dropped instances declared (e.g. an unscoped
    //    `Agv.Run` from a bind before the placement scope stamp existed).
    const declared = new Set<string>();
    for (const inst of this._instances) for (const n of inst.scene?.signals ?? []) declared.add(n);
    const stale = new Set<string>();
    for (const inst of dropped) for (const n of inst.scene!.signals) if (!declared.has(n)) stale.add(n);
    if (stale.size > 0) releaseUnownedSignals(topology.host, stale);
  }

  /**
   * plan-265: re-seed every bound instance's `self.prop` from its (possibly
   * overridden) rv_extras. Call BEFORE `reset()` so the restart's
   * `def.setup(self)` re-reads the refreshed config and a written value takes effect.
   * The `des-extras` re-config path of the planning parameters (plan-630 §2.14):
   * `SimDesControl.reconfigureFromExtras`, called by the one component-property writer —
   * experiment factors reach it through the same writer (plan-2005 Phase 7).
   */
  reconfigureFromExtras(): void {
    reconfigureInstancesFromExtras(this);
  }

  /** Teardown callbacks registered through {@link onDispose}. Run once on dispose. */
  private _disposeHooks: (() => void)[] = [];

  /**
   * Public hook: register a callback that runs once when this runner is disposed
   * (runner lifetime, unlike {@link onSceneUnbind}, which ends with each scene
   * binding). No built-in caller uses it today — the binding's headless registry
   * moved to `onSceneUnbind` (plan-612 CP1d-b) — it stays for project plugins
   * that hold runner-lifetime resources (plan-644 D2).
   */
  onDispose(cb: () => void): void {
    this._disposeHooks.push(cb);
  }

  /** Callbacks whose lifetime is ONE scene binding (plan-612 CP1d-b): run on
   *  `rebindScene()` and on dispose, whichever comes first. */
  private _sceneHooks: (() => void)[] = [];

  /** Register a callback that runs once when the current scene binding ends
   *  (`rebindScene()` or dispose) — e.g. a headless connection registry. */
  onSceneUnbind(cb: () => void): void {
    this._sceneHooks.push(cb);
  }

  private _runSceneHooks(): void {
    const hooks = this._sceneHooks;
    this._sceneHooks = [];
    for (const h of hooks) {
      try { h(); } catch (e) { console.error('[DESRunner] scene unbind hook failed:', e); }
    }
  }

  /**
   * E9 (plan-645): the ONE teardown of scene bind contexts, shared by
   * `rebindScene()` and `dispose()` - each scene instance's `scene.dispose()`
   * handle (subscriptions, bind-context onDispose callbacks) runs once.
   */
  private _disposeSceneBindings(instances: readonly RunnerInstance[], why: 'rebind' | 'dispose'): void {
    for (const inst of instances) {
      if (!inst.scene) continue;
      try { inst.scene.dispose(); } catch (e) {
        console.error(`[DESRunner] ${why}: bind-context dispose of '${inst.def.type}' failed:`, e);
      }
    }
  }

  /** Tear down everything (model-cleared / kernel dispose). */
  dispose(): void {
    // plan-2058 F21: every teardown step runs in isolation — one that throws
    // (script host, manager, a visual disposer, …) must not skip the rest, and
    // the global manager reference is released in `finally`, whatever happened.
    // The failures are collected and reported once at the end.
    const errors: Array<{ step: string; error: unknown }> = [];
    const step = (what: string, fn: () => void): void => {
      try { fn(); } catch (error) { errors.push({ step: what, error }); }
    };
    try {
      // plan-645 L2 / R2-3: from bound `reset` then `disposed`; else only
      // `disposed`; a repeated dispose is silent. Both BEFORE any teardown.
      if (this._lcState !== 'disposed') {
        step('lifecycle end', () => this._lcEnd());
        this._lcState = 'disposed';
        step('lifecycle disposed', () => this._lcEmit('disposed'));
      }
      callbackRunners.delete(this.runnerId);
      this._snapshotProviders = new Map();
      // Document-scoped Problems of this runner leave with the model: the kernel
      // disposes the runner in `RVViewer.clearModel()` (every load) and on viewer dispose.
      step('problems', () => { clearProblemsOfCode(ACTION_FAILED_PROBLEM_CODE); clearSceneBindingProblems(); });
      step('scene bindings', () => this._disposeSceneBindings(this._instances, 'dispose'));
      this._hasSceneBinding = false;
      this._boundSceneGen = null;
      this._fingerprintGeneration++;
      this._bindFingerprint = { pending: true };
      this._bindSceneRows = null; this._fingerprintCache = null;
      step('scene hooks', () => this._runSceneHooks());
      const hooks = this._disposeHooks;
      this._disposeHooks = [];
      for (const h of hooks) {
        try { h(); } catch (e) { console.error('[DESRunner] dispose hook failed:', e); }
      }
      step('cancelFastForward', () => this.cancelFastForward());
      step('releaseAllAxes', () => releaseAllAxes());
      step('tweens', () => { this.tweens.clear(); this._eventTweens.clear(); });

      this._tearingDownMUs = true;
      step('manager', () => this.manager.dispose()); // archives an open run via the reset hook first
      this._tearingDownMUs = false;
      // plan-2212 R2-2: after the archive - Model-Scripts back to the frame clock.
      step('script binding', () => this._unbindScripts());
      for (const [visual, disposer] of this._ownedMuVisuals) {
        step('MU visual disposer', () => disposer(visual as NonNullable<DESMU['visual']>));
      }
      this._ownedMuVisuals.clear();
      this._muVisualFactories.clear();
      this._warnedUnknownVisualTemplates.clear();
      this._activeMuVisualTemplateId = undefined;
      step('experiment backend', () => this._detachBackend());
      for (const off of [...this._experimentSubscriptions]) step('experiment subscription', off);
      step('run identity', () => this.identity.dispose());
      this._instances = [];
      this._defs = [];
      this._topology = null;
      this._dispatchByType.clear();
      step('settle wiring', () => this._recomputeSettleRequired()); // no instances left → settle unwired
    } finally {
      if (DES.getManager() === this.manager) DES.setManager(null);
    }
    if (errors.length > 0) console.error(`[DESRunner] dispose: ${errors.length} teardown step(s) failed:`, errors);
  }

  instances(): ReadonlyArray<MaterialFlowInstance> {
    return this._instances.map(i => ({ def: i.def, self: i.self, adapter: i.adapter }));
  }

  /**
   * The live instances WITHOUT the per-call wrapper allocation of `instances()`.
   * Hot-path readers (the source loop-saturation guard runs on EVERY generate
   * attempt) iterate this directly. Read-only — never mutate.
   */
  get liveInstances(): ReadonlyArray<RunnerInstance> {
    return this._instances;
  }

  /**
   * plan-2059 Phase 1: the DES component ids of the bound instances and every
   * instance that cannot carry snapshot state (no id, or an id shared with
   * another instance). Read-only; nothing is refused here — the capture uses
   * it once Phase 3 activates the snapshot contract.
   */
  private _bindEpoch: number | null = null;
  private _bindFingerprint: FingerprintResult | { readonly pending: true } = { pending: true };
  private _fingerprintGeneration = 0;

  fingerprintScripts(): Array<{ id: string; source: string }> {
    return this.resolveScriptComponents().map(s => ({ id: s.desId ?? '', source: s.source ?? '' }));
  }

  // Batch parameter overrides are already materialised in authored extras.
  // beginRun rebinds after its end/warmup overrides replace the scene settings.
  fingerprintRunConfig(): unknown {
    return { endTime: this.manager.duration, statResetTime: this.manager.statResetTime,
      masterSeed: this.manager.masterSeed, seedOverride: this._seedOverride,
      rngVersion: this.rngVersion };
  }

  fingerprintNow(): FingerprintResult {
    if (this._bindEpoch !== null && modelEditEpoch() !== this._bindEpoch) {
      return { ok: false, reasons: ['model changed since run start — restart the run'] };
    }
    try {
      return this._fingerprintCached(this._collectFingerprintInput());
    } catch (error) {
      return { ok: false, reasons: [`model input unavailable: ${String(error)}`] };
    }
  }

  /**
   * Scene rows taken at bind (plan-2059 C5, R4 re-check in real scenes). The
   * authored scene is fixed for a run: an authored change bumps the model-edit
   * epoch (refused as "changed since run start"), while everything the RUN moves
   * — drives, AGVs, carriers, but also HMI buttons/switches animated by signals —
   * is not model. So the rows of the bind stand for the whole run; while the
   * epoch is unchanged they are reused, never re-collected from live poses.
   * Also the capture budget: one standard-demo node alone carries 3.5 MB of
   * extras, re-serialising and re-hashing it per capture cost ~165 ms.
   */
  private _bindSceneRows: { epoch: number; rows: readonly FingerprintSceneNode[] } | null = null;
  private _fingerprintCache: { key: string; rows: readonly FingerprintSceneNode[] | undefined; result: FingerprintResult } | null = null;

  private _collectFingerprintInput(): FingerprintInput {
    const host = (this._topology?.host ?? { registry: null }) as unknown as ModelInputHost;
    const rows = this._bindSceneRows && this._bindSceneRows.epoch === modelEditEpoch() ? this._bindSceneRows.rows : undefined;
    return collectFingerprintInput(host, this, { mainDocumentKey: host.mainDocumentKey ?? null, scene: rows });
  }

  /** Re-hash only when something besides the (bind-fixed) scene rows changed. */
  private _fingerprintCached(input: FingerprintInput): FingerprintResult {
    const rows = this._bindSceneRows && this._bindSceneRows.epoch === modelEditEpoch() ? this._bindSceneRows.rows : undefined;
    const key = rows ? JSON.stringify({ ...input, scene: null, epoch: modelEditEpoch(),
      unaddressable: this.desIdentity().unaddressable.length }) : '';
    const c = this._fingerprintCache;
    if (rows && c && c.rows === rows && c.key === key) return c.result;
    const result = this._fingerprintFromInput(input);
    this._fingerprintCache = rows ? { key, rows, result } : null;
    return result;
  }

  private _fingerprintFromInput(input: FingerprintInput): FingerprintResult {
    // modelHash excludes the run configuration (Thomas 2026-11-01): the bind-vs-capture
    // check and the restore preflight both compare the model part only.
    const result = buildDesFingerprint(input);
    const reasons = this.desIdentity().unaddressable.map(e => `unaddressable component: ${e.label}`);
    for (const script of this.resolveScriptComponents()) {
      if (script.source === undefined) reasons.push(`bound script source unavailable: ${script.path}`);
    }
    return reasons.length ? { ok: false, reasons: [...(!result.ok ? result.reasons : []), ...reasons] } : result;
  }

  fingerprintAtBind(): FingerprintResult | { readonly pending: true } { return this._bindFingerprint; }

  private _bindModelFingerprint(): void {
    const generation = ++this._fingerprintGeneration;
    this._bindEpoch = modelEditEpoch();
    this._bindFingerprint = { pending: true };
    clearProblemsOfCode('des-snapshot-fingerprint');
    const report = (result: FingerprintResult): void => {
      if (!result.ok) reportProblem({ id: 'des-snapshot-fingerprint', code: 'des-snapshot-fingerprint',
        severity: 'warning', title: snapshotUserMessage('des-snapshot-fingerprint').title, detail: `${snapshotUserMessage('des-snapshot-fingerprint').text} [des-snapshot-fingerprint] ${result.reasons.join('; ')}` });
    };
    const finish = (result: FingerprintResult): void => {
      if (generation !== this._fingerprintGeneration) return;
      this._bindFingerprint = result;
      report(result);
    };
    const host = (this._topology?.host ?? { registry: null }) as unknown as ModelInputHost;
    let input: FingerprintInput;
    this._bindSceneRows = null;
    this._fingerprintCache = null;
    try {
      input = collectFingerprintInput(host, this, { mainDocumentKey: host.mainDocumentKey ?? null });
      this._bindSceneRows = { epoch: this._bindEpoch!, rows: input.scene as readonly FingerprintSceneNode[] };
    } catch (error) {
      finish({ ok: false, reasons: [`model input unavailable: ${String(error)}`] });
      return;
    }
    const result = this._fingerprintFromInput(input);
    if (!result.ok && result.reasons.some(r => r.includes('content hash still pending'))) {
      const knownReasons = result.reasons.filter(r => !r.includes('content hash still pending'));
      if (knownReasons.length) report({ ok: false, reasons: knownReasons });
      void whenDocumentHashesSettled().then(() => {
        if (generation !== this._fingerprintGeneration) return;
        if (modelEditEpoch() !== this._bindEpoch) finish(this.fingerprintNow());
        else {
          finish(this._fingerprintFromInput({ ...input,
            documents: input.documents.map(d => ({ ...d, hash: d.key ? documentHashOf(d.key) : d.hash })) }));
        }
      });
    } else finish(result);
  }

  desIdentity(): { entries: DesIdentityEntry[]; unaddressable: DesUnaddressable[] } {
    const entries: DesIdentityEntry[] = this._instances.map((inst) => ({
      desId: inst.desId,
      type: inst.def.type,
      label: inst.adapter.node?.name || inst.def.type,
    }));
    for (const script of this.resolveScriptComponents()) entries.push({
      desId: script.desId ?? null, type: 'WebComponent', label: script.path,
    });
    return { entries, unaddressable: findUnaddressable(entries) };
  }

  // ─── Instance construction (used by the model-load wiring / tests) ──────

  /**
   * Add a material-flow instance. Builds the concrete `MaterialFlowAdapter`,
   * wires a DES scheduler into `self` (so `self.in/at/cancel/now` resolve to the
   * named-action int dispatch, R3), and tracks it for `start()`. The provided
   * `self` MUST be in DES mode and carry a `__attachScheduler` hook (createSelf
   * in DES mode exposes one) OR be re-projected here.
   *
   * @param def the definition.
   * @param self a DES-mode `MaterialFlowSelf` for this instance.
   * @param node the scene node the adapter anchors to.
   * @param scene set by the scene binding for a discovered instance (dropped and
   *   rebound by `rebindScene()`); omit for programmatic instances.
   * @param identity plan-2059: the DES component id — the scene binding passes
   *   the plan-769 address based id, a programmatic instance an explicit one.
   */
  addInstance(
    def: MaterialFlowDefinition,
    self: MaterialFlowSelf,
    node: Object3D,
    scene?: SceneInstanceBinding,
    identity?: RunnerInstanceIdentity,
  ): MaterialFlowAdapter {
    const adapter = new MaterialFlowAdapter(def, self, node);
    adapter.materializeMu = (mu) => this.materializeMu(mu);
    adapter.beforeHookDispatch = () => { this._activeMuVisualTemplateId = undefined; };
    // Sink consumes report here so the visual sweep drains a small pending list
    // instead of scanning every MU ever registered per frame.
    // plan-2212: retired at the end of the consuming event (deterministic MU ids);
    // the visual goes with the retirement (onMURetired).
    adapter.onMUConsumed = (mu) => { this.manager.retireAfterEvent(mu); };
    adapter.synchronizeScheduledClock = () => this._synchronizeManagerClock();
    adapter.freezeScheduledWork = () => this._freezeAdapter(adapter);
    adapter.resumeScheduledWork = (frozen) => this._resumeAdapter(adapter, frozen);
    // DEV-only settle guard (plan-262 Phase 2): compile-time constant — the
    // wiring AND the per-dispatch call site are dead code in production.
    if (import.meta.env.DEV) {
      adapter.devSettleGuard = (suffix, mu) => this._devSettleGuard(def, suffix, mu);
    }
    const desId = identity?.desId ?? null;
    // plan-2061: named RNG streams are keyed by this id; programmatic instances need it on the adapter too.
    if (desId !== null) adapter.desId = desId;
    const bindPose = localPoseOf(node);
    const bindPoses = new Map((def.des?.movedNodes?.(self) ?? []).map(n => [n, localPoseOf(n)] as const));
    this._instances.push(scene ? { def, self, adapter, scene, desId, bindPose, bindPoses } : { def, self, adapter, desId, bindPose, bindPoses });
    if (def.type === 'Agv' && !this._snapshotProviders.has('fleet.authority')) this.registerSnapshotProvider('fleet.authority', movementSnapshotProvider({ agvs: () => this._instances.filter(i => i.def.type === 'Agv' && i.desId !== null).map(i => ({ desId: i.desId!, vehicleId: scopedInstanceId(i.self.root, i.self.root.name || 'Agv'), self: agvSelfForSnapshot(i.self) })) }));
    // A dynamically added live-geometry sampler re-arms the settle immediately.
    this._recomputeSettleRequired();
    return adapter;
  }

  /**
   * Build the DES scheduler for an instance — namespaces a short hook suffix to
   * `<type>.<Suffix>` and resolves the integer action index from the per-type
   * dispatch map (R3, GC-free). Pass this to `createSelf({ scheduler })`.
   */
  makeScheduler(def: MaterialFlowDefinition, getEntityId: () => number): SelfScheduler {
    const manager = this.manager;
    const ensureDispatch = (): HookDispatch => {
      let d = this._dispatchByType.get(def.type);
      if (!d) {
        d = registerDesHooks(def);
        this._dispatchByType.set(def.type, d);
      }
      return d;
    };

    const schedule = (
      atTime: number,
      hook: DesHookName,
      mu: MU | null | undefined,
      data: unknown,
      relative: boolean,
    ): number => {
      const dispatch = ensureDispatch();
      // The action index was registered under MF.<type>.<suffix> ONCE
      // (registerDesHooks) — scheduling goes by INDEX, so no string is built or
      // resolved per event (R3, GC-free).
      const idx = dispatch.indexBySuffix.get(hook);
      if (idx === undefined) {
        throw new Error(`DES: hook '${hook}' is not declared on def.des of type '${def.type}'`);
      }
      const entityId = getEntityId();
      const muId = mu && typeof (mu as { id?: number }).id === 'number' ? (mu as { id: number }).id : -1;
      // GC discipline: a REGISTERED MU rides the queue as its integer id and is
      // resolved back via manager.getMU() at dispatch (des-hook-adapter). A
      // payload object + side-channel Map entry is only allocated when there is
      // real user data, or an MU the queue id cannot round-trip (unregistered /
      // identity mismatch — e.g. a test literal `{ id: 1 }`).
      const muRidesQueue = muId >= 0 && manager.getMU(muId) === (mu as unknown);
      const payload: HookEventData | null =
        data != null || (mu != null && !muRidesQueue)
          ? { mu: muRidesQueue ? null : mu ?? null, data }
          : null;
      // plan-558: an optional `data.priority` (higher fires first at the
      // same time) — the moving-block flush runs AFTER all same-time events.
      const prio = typeof (data as { priority?: unknown } | null)?.priority === 'number'
        ? (data as { priority: number }).priority : 0;
      const eventId = relative
        ? manager.scheduleInByIndex(atTime, idx, entityId, muId, prio, payload)
        : manager.scheduleEventByIndex(atTime, idx, entityId, muId, prio, payload);

      // Attach a tween for the scheduled DURATION (Plan 194 §3.1). A `des` block
      // passes a `TweenSpec` as the event `data`; the runner registers it on its
      // tween registry keyed by the event window (t0 = now, duration = the
      // scheduled interval). The public side never touches the registry — it only
      // describes the interpolation, keeping the tween coupling private.
      const tweens = this._attachTweensFromData(
        data,
        relative ? atTime : atTime - manager.currentTime,
      );
      if (tweens.length > 0) this._eventTweens.set(eventId, tweens);

      return eventId;
    };

    return {
      in: (delay, hook, mu, data) => schedule(delay, hook, mu, data, true),
      at: (time, hook, mu, data) => schedule(time, hook, mu, data, false),
      cancel: (eventId: number) => {
        const tweens = this._eventTweens.get(eventId);
        if (tweens) for (const tween of tweens) this.tweens.cancel(tween.handle);
        this._eventTweens.delete(eventId);
        manager.cancelEvent(eventId);
      },
      get now(): number { return manager.currentTime; },
      get nextEventTime(): number { return manager.nextEventTime; },
    };
  }

  /**
   * Build the DES MU-transfer backend for an instance — runs the native
   * blocking handshake against the adapter's resolved downstream. Pass this to
   * `createSelf({ onTransfer })` so a definition's `self.transfer(mu)` hands the
   * MU off with the same semantics the native DES components use.
   */
  makeTransfer(adapter: MaterialFlowAdapter): (mu: MU) => TransferResult {
    return (mu: MU) => {
      return adapter.transferMU(mu as unknown as DESMU);
    };
  }

  /**
   * Explicit pose hand-over (plan-631 F2): hand `mu` to `target`, which takes it
   * over AT `pose` (a conveyor starts the transit there instead of at its entry).
   * Opt-in per hand-over; the pose is valid for exactly this MU and this target
   * and is dropped after success or refusal. `from` = the current owner
   * (default `mu.currentComponent`; pass the source adapter for a freshly
   * spawned MU). Synchronous only — see `MaterialFlowAdapter.transferInWithPose`.
   */
  transferMUWithPose(
    mu: MU,
    target: MaterialFlowAdapter,
    pose: AcceptPose,
    from?: DESComponent,
  ): PoseTransferResult {
    const dmu = mu as unknown as DESMU;
    const owner = from ?? (dmu.currentComponent as unknown as DESComponent | null);
    if (!owner) throw new Error(`DES: transferMUWithPose — MU ${mu.id} has no owner; pass 'from'`);
    return target.transferInWithPose(owner, dmu, pose);
  }

  /**
   * One-call pose hand-over (plan-645 Phase 3): pre-check, visual detach,
   * hand-over and re-seat on `ownerKept` — what every caller of
   * {@link transferMUWithPose} wrote by hand (PalletYard `dropOnConveyorHead`).
   * Order: `target.canAcceptWithPose(mu, pose)` (refused → nothing moves, not
   * even the visual) → `opts.detach?.()` → `transferInWithPose` → on
   * `ownerKept` `opts.reseat?.()`. `from` = the current owner (default
   * `mu.currentComponent`). Additive: `transferMUWithPose` and both
   * `canAcceptWithPose` forms stay.
   */
  handOver(
    mu: MU,
    target: MaterialFlowAdapter,
    opts: { pose: AcceptPose; from?: DESComponent; detach?: () => void; reseat?: () => void },
  ): PoseTransferResult {
    const dmu = mu as unknown as DESMU;
    const owner = opts.from ?? (dmu.currentComponent as unknown as DESComponent | null);
    if (!owner) throw new Error(`DES: handOver — MU ${mu.id} has no owner; pass 'from'`);
    const unsupported = target.poseUnsupportedReason();
    if (unsupported) return { ok: false, reason: unsupported, ownerKept: true };
    if (!target.canAcceptWithPose(dmu, opts.pose)) return { ok: false, reason: 'refused', ownerKept: true };
    opts.detach?.();
    const r = target.transferInWithPose(owner, dmu, opts.pose);
    if (!r.ok && r.ownerKept) opts.reseat?.();
    return r;
  }

  /**
   * Pre-validate a pose hand-over BEFORE the MU exists (plan-631 R2-3): would
   * `target` take an MU of `templateSize` (m, own frame) at `pose` right now?
   * Same capacity + plausibility check as the hand-over itself; nothing is
   * spawned or changed (a refusal reports the target's Problems entry).
   * NOTE: the signature differs from the adapter's `canAcceptWithPose(mu, pose)` —
   * this runner form is a PROBE `(target, templateSize, pose)`, there is no MU yet.
   */
  canAcceptWithPose(
    target: MaterialFlowAdapter,
    templateSize: readonly [number, number, number],
    pose: AcceptPose,
  ): boolean {
    return target.canAcceptPoseProbe(templateSize, pose);
  }

  /** Create + register a fresh DESMU (sources call this via their hook helper). */
  createMU(visualTemplateId?: string): DESMU {
    const effectiveTemplateId = visualTemplateId ?? this._activeMuVisualTemplateId;
    const mu = createDESMU(this.manager.currentTime, null, this.manager);
    this.manager.registerMU(mu);
    if (effectiveTemplateId) {
      mu.visualTemplateId = effectiveTemplateId;
      if (!this.headlessSpawnActive) mu.visual = this._createMuVisual(effectiveTemplateId);
    }
    return mu;
  }

  // ─── Tween coupling (Plan 194 §3.1) ─────────────────────────────────────

  private _freezeAdapter(adapter: MaterialFlowAdapter): FrozenDescriptor[] {
    this._synchronizeManagerClock();
    const events = this.manager.freezeEventsForEntity(adapter.entityId);
    const frozen: FrozenDescriptor[] = [];
    for (const event of events) {
      const trackedTweens = this._eventTweens.get(event.id) ?? [];
      const hookData = (event.data as HookEventData | null)?.data ?? null;
      const remaining = Math.max(0, event.time - this.manager.currentTime);
      const eventMU = event.muId >= 0 ? this.manager.getMU(event.muId) as DESMU | null : null;
      const frozenTweens = trackedTweens.flatMap((tracked) => {
        if (!tracked.descriptor) return [];
        let descriptor: FrozenTweenDescriptor = {
          ...structuredClone(tracked.descriptor),
          remaining,
        };
        if (
          descriptor.kind === 'position'
          && descriptor.muRef
          && this.tweens.positionForMu(descriptor.muRef.id, this.manager.currentTime, _from)
        ) {
          descriptor = { ...descriptor, from: [_from.x, _from.y, _from.z] };
        }
        if (descriptor.kind === 'path' && descriptor.muRef) {
          const fromS = this.tweens.pathSForMu(descriptor.muRef.id, this.manager.currentTime);
          if (fromS !== null) descriptor = { ...descriptor, fromS };
        }
        return [descriptor];
      });
      const heldDriveTweens = this.tweens.toSnapshot(target => {
        const ref = target.node ? this._driveAddress(target.node as Object3D) : null;
        if (!ref) throw new Error('drive tween has no stable address');
        return ref;
      }, handle => trackedTweens.some(t => t.handle === handle) ? event.id : null)
        .filter((t): t is Extract<TweenDataSnapshot, { kind: 'drive' }> => t.kind === 'drive')
        .map(t => ({ ...t, t0: t.t0 - this.manager.currentTime, t1: t.t1 - this.manager.currentTime, eventId: null }));
      for (const tween of trackedTweens) this.tweens.cancel(tween.handle);
      this._eventTweens.delete(event.id);
      const descriptor: FrozenDescriptor = {
        action: event.action,
        muRef: eventMU ? { id: eventMU.id, gen: eventMU.generation } : null,
        payload: this._jsonHookPayload(hookData),
        remaining,
        ...(frozenTweens.length === 1
          ? { tween: frozenTweens[0] }
          : {}),
        ...(frozenTweens.length > 1
          ? { tweens: frozenTweens }
          : {}),
      };
      // Keep the payload copy aligned with the descriptors used by resume.
      // Detached copy: the payload must not alias the descriptor tween arrays (snapshot alias check).
      const payload = this._dataFromFrozen(descriptor) as Record<string, unknown> | null;
      frozen.push({ ...descriptor, payload: structuredClone(heldDriveTweens.length
        ? { ...payload, heldDriveTweens } : payload) });
    }
    return frozen;
  }

  private _resumeAdapter(adapter: MaterialFlowAdapter, frozen: readonly FrozenDescriptor[]): void {
    for (const descriptor of frozen) {
      const muId = descriptor.muRef && this.manager.getMUByRef(descriptor.muRef)
        ? descriptor.muRef.id
        : -1;
      const data = this._dataFromFrozen(descriptor);
      const eventId = this.manager.scheduleIn(
        descriptor.remaining,
        descriptor.action,
        adapter.entityId,
        muId,
        0,
        { data } satisfies HookEventData,
      );
      const tweens = this._attachTweensFromData(data, descriptor.remaining);
      if (tweens.length > 0) this._eventTweens.set(eventId, tweens);
    }
  }

  private _jsonHookPayload(data: unknown, live = false): unknown {
    const encoded = live ? encodeHookPayload(data) : undefined;
    if (encoded) return encoded.value;
    if (!data || typeof data !== 'object') return live ? data : structuredClone(data);
    const source = data as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key !== 'tween' && key !== 'tweens') out[key] = live ? value : structuredClone(value);
    }
    const spec = (source.tween ?? null) as TweenSpec['tween'] | null;
    if (spec?.kind === 'position') {
      out.tween = {
        kind: 'position', from: [...spec.from], to: [...spec.to],
        ...(typeof spec.muId === 'number' ? { muId: spec.muId } : {}),
      };
    } else if (spec?.kind === 'path') {
      const pathRef = spec.pathRef
        ?? (typeof (spec.path as { id?: unknown } | null)?.id === 'string'
          ? (spec.path as { id: string }).id
          : '');
      out.tween = {
        kind: 'path', pathRef, fromS: spec.fromS, toS: spec.toS,
        ...(typeof spec.muId === 'number' ? { muId: spec.muId } : {}),
      };
    } else if (spec?.kind === 'axes' || spec?.kind === 'drive') {
      out.tween = this._jsonTweenSpec(spec);
    }
    const specs = Array.isArray(source.tweens)
      ? source.tweens as TweenSpec['tween'][]
      : [];
    if (specs.length > 0) out.tweens = specs.map((entry) => this._jsonTweenSpec(entry));
    return out;
  }

  private _jsonTweenSpec(spec: TweenSpec['tween']): Record<string, unknown> {
    if (spec.kind === 'position') {
      return {
        kind: 'position', from: [...spec.from], to: [...spec.to],
        ...(typeof spec.muId === 'number' ? { muId: spec.muId } : {}),
      };
    }
    if (spec.kind === 'path') {
      const pathRef = spec.pathRef
        ?? (typeof (spec.path as { id?: unknown } | null)?.id === 'string'
          ? (spec.path as { id: string }).id
          : '');
      return {
        kind: 'path', pathRef, fromS: spec.fromS, toS: spec.toS,
        ...(typeof spec.muId === 'number' ? { muId: spec.muId } : {}),
      };
    }
    if (spec.kind === 'axes') {
      return {
        kind: 'axes',
        anchorRef: spec.anchorRef,
        phases: spec.phases.map((phase) => ({
          at0: phase.at0,
          at1: phase.at1,
          axes: phase.axes.map((axis) => {
            const drive = this._resolveAxisDrive(axis.driveRef);
            const ref = drive ? this._driveAddress(drive.node) : null;
            if (!ref) throw new Error(`unknown axis drive '${axis.driveRef}'`);
            return { ...axis, driveRef: ref };
          }),
        })),
        ...(spec.ease ? { ease: spec.ease } : {}),
      };
    }
    const target = spec.drive as (DriveTweenTarget & { node?: Object3D }) | null | undefined;
    const driveRef = spec.driveRef ?? (target?.node ? this._driveAddress(target.node) : null);
    if (!driveRef) throw new Error('drive tween has no stable address');
    return { kind: 'drive', driveRef, from: spec.from, to: spec.to };
  }

  private _dataFromFrozen(descriptor: FrozenDescriptor): unknown {
    const data = structuredClone(descriptor.payload);
    if (descriptor.tweens?.length) {
      const out = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      out.tweens = descriptor.tweens.map((tween) => tween.kind === 'path'
        ? {
            kind: 'path', pathRef: tween.pathRef, fromS: tween.fromS, toS: tween.toS,
            ...(tween.muRef ? { muId: tween.muRef.id } : {}),
          }
        : {
            kind: 'position', from: tween.from, to: tween.to,
            ...(tween.muRef ? { muId: tween.muRef.id } : {}),
          });
      return out;
    }
    if (!descriptor.tween) return data;
    const out = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const tween = descriptor.tween;
    out.tween = tween.kind === 'path'
      ? {
          kind: 'path', pathRef: tween.pathRef, fromS: tween.fromS, toS: tween.toS,
          ...(tween.muRef ? { muId: tween.muRef.id } : {}),
        }
      : {
          kind: 'position', from: tween.from, to: tween.to,
          ...(tween.muRef ? { muId: tween.muRef.id } : {}),
        };
    return out;
  }

  /** Align event time with the already-rendered simulation clock before persistence/freeze. */
  private _synchronizeManagerClock(): void {
    const delta = this._renderClock - this.manager.currentTime;
    if (delta > 0) this.manager.processAnimated(delta);
  }

  /**
   * Load-stable key of a drive node. Drive nodes the loader generates at load (e.g. a
   * split `Drive-Rot-Y_1` under an authored node) carry no plan-769 address: they are
   * keyed by the nearest addressed ancestor plus the child name path, which the loader
   * rebuilds identically on every load (duplicates refuse in `_snapshotParticipants`).
   */
  private _driveAddress(node: Object3D): string | null {
    type Addresses = { getAddressForNode(node: Object3D): string | null };
    const host = this._topology?.host as { registry?: Addresses | null; desAddresses?: Addresses | null } | undefined;
    const addresses = host?.desAddresses ?? host?.registry;
    if (!addresses) return null;
    const names: string[] = [];
    for (let n: Object3D | null = node; n; n = n.parent) {
      const address = addresses.getAddressForNode(n);
      if (address) return names.length ? `${address}/${names.reverse().join('/')}` : address;
      if (!n.name) return null;
      names.push(n.name);
    }
    return null;
  }

  private _driveByAddress(ref: string): RVDrive | null {
    const host = this._topology?.host as { drives?: readonly RVDrive[] } | undefined;
    return [...this.collectDrives(), ...(host?.drives ?? [])].find(d => this._driveAddress(d.node) === ref) ?? null;
  }

  /** Resolve a stable Drive node path against the active viewer/topology. */
  private _resolveAxisDrive(driveRef: string): RVDrive | null {
    const addressed = this._driveByAddress(driveRef);
    if (addressed) return addressed;
    const host = this._topology?.host as unknown as {
      drives?: RVDrive[];
      registry?: {
        getByPath?<T>(type: string, path: string): T | null;
        getNode?(path: string): Object3D | null;
      } | null;
    } | undefined;
    const direct = host?.registry?.getByPath?.<RVDrive>('Drive', driveRef) ?? null;
    if (direct) return direct;
    const node = host?.registry?.getNode?.(driveRef)
      ?? (this._topology ? findNodeByPath(this._topology.root, driveRef) : null);
    if (node) {
      const byNode = host?.drives?.find((drive) => drive.node === node);
      if (byNode) return byNode;
    }
    const all = host?.drives ?? this.collectDrives();
    const leaf = driveRef.split('/').filter(Boolean).pop() ?? driveRef;
    const byName = all.filter((drive) => drive.name === leaf || drive.node.name === leaf);
    return byName.length === 1 ? byName[0] : null;
  }

  /** Stable wrapper used by TweenRegistry; avoids per-render allocations. */
  private _axisTweenTarget(drive: RVDrive): DriveTweenTarget {
    let target = this._driveTweenTargets.get(drive);
    if (!target) {
      target = {
        node: drive.node,
        setPosition(value: number): void {
          drive.currentPosition = value;
          drive.applyToNode();
        },
      };
      this._driveTweenTargets.set(drive, target);
    }
    return target;
  }

  /**
   * Register a tween from a `des` block's event `data` payload. The public
   * material-flow side passes a `TweenSpec` (`{ tween: {...} }`) as `data`; the
   * runner translates it onto its `TweenRegistry` over the scheduled window
   * (t0 = the manager's current time, `duration` = the scheduled interval).
   * Anything that is not a `TweenSpec` is ignored (no-op). Null visual/drive
   * targets are skipped by the registry itself (V4).
   */
  private _attachTweenFromData(
    data: unknown,
    duration: number,
    startTime = this.manager.currentTime,
  ): Array<{ handle: TweenHandle; descriptor?: FrozenTweenDescriptor }> {
    const spec = (data as { tween?: TweenSpec['tween'] } | null)?.tween;
    if (!spec) return [];
    const t0 = startTime;
    // Exhaustive switch (plan-268 Phase 3 / §10 finding 1): the old if/else
    // silently mis-read any NEW spec kind as a drive tween — `default:
    // assertNever(spec)` makes a missing case a COMPILE error and junk data a
    // loud runtime error.
    switch (spec.kind) {
      case 'position':
        _from.set(spec.from[0], spec.from[1], spec.from[2]);
        _to.set(spec.to[0], spec.to[1], spec.to[2]);
        {
        const muId = typeof spec.muId === 'number' ? spec.muId : -1;
        const mu = muId >= 0 ? this.manager.getMU(muId) as DESMU | null : null;
        const target = muId >= 0
          ? (mu?.visual as unknown as PositionTweenTarget | null) ?? null
          : (spec.target as PositionTweenTarget | null) ?? null;
        const handle = this.tweens.addPosition(
          target,
          _from,
          _to,
          t0,
          duration,
          // plan-262 Phase 3: keep the window for a headless MU (null target) so
          // the FF-exit materialisation can position / re-connect its visual.
          muId,
        );
        return [{
          handle,
          ...(muId >= 0 ? {
            descriptor: {
              kind: 'position' as const,
              muRef: { id: muId, gen: mu?.generation ?? 0 },
              from: [...spec.from] as [number, number, number],
              to: [...spec.to] as [number, number, number],
              remaining: duration,
            },
          } : {}),
        }];
        }
      case 'drive': {
        const drive = spec.driveRef ? this._driveByAddress(spec.driveRef) : null;
        return [{ handle: this.tweens.addDrive(
          drive ? this._axisTweenTarget(drive) : (spec.drive as DriveTweenTarget | null) ?? null,
          spec.from,
          spec.to,
          t0,
          duration,
        ) }];
      }
      case 'axes': {
        const attached: Array<{ handle: TweenHandle }> = [];
        const eventDuration = Math.max(0.001, duration);
        for (const phase of spec.phases) {
          const at0 = Math.min(1, Math.max(0, phase.at0));
          const at1 = Math.min(1, Math.max(at0, phase.at1));
          for (const axis of phase.axes) {
            const drive = this._resolveAxisDrive(axis.driveRef);
            if (!drive) {
              if (!this._warnedDanglingAxisDriveRefs.has(axis.driveRef)) {
                this._warnedDanglingAxisDriveRefs.add(axis.driveRef);
                console.warn(
                  `[DESRunner] axes tween driveRef '${axis.driveRef}' could not be resolved; axis skipped.`,
                );
              }
              continue;
            }
            attached.push({
              handle: this.tweens.addDrive(
                this._axisTweenTarget(drive),
                axis.from,
                axis.to,
                t0 + at0 * eventDuration,
                Math.max(0.001, (at1 - at0) * eventDuration),
                { writePolicy: 'finalOnly', ease: spec.ease ?? 'scurve' },
              ),
            });
          }
        }
        return attached;
      }
      case 'path':
        // plan-268 Phase 3: arc-length transit — the registry samples the path
        // (`getAbsPosition`) instead of lerping a straight chord.
        {
        const pathRef = spec.pathRef
          ?? (typeof (spec.path as { id?: unknown } | null)?.id === 'string'
            ? (spec.path as { id: string }).id
            : '');
        const sampler = pathRef
          ? getDefaultPathNetwork().get(pathRef)
          : (spec.path as PathTweenSampler | null) ?? null;
        const muId = typeof spec.muId === 'number' ? spec.muId : -1;
        const mu = muId >= 0 ? this.manager.getMU(muId) as DESMU | null : null;
        const target = muId >= 0
          ? (mu?.visual as unknown as PathTweenTarget | null) ?? null
          : (spec.target as PathTweenTarget | null) ?? null;
        const handle = this.tweens.addPath(
          sampler,
          target,
          spec.fromS,
          spec.toS,
          t0,
          duration,
          muId,
          pathRef,
          spec.sAt ?? null,
        );
        return [{
          handle,
          ...(muId >= 0 && pathRef ? {
            descriptor: {
              kind: 'path' as const,
              muRef: { id: muId, gen: mu?.generation ?? 0 },
              pathRef,
              fromS: spec.fromS,
              toS: spec.toS,
              remaining: duration,
            },
          } : {}),
        }];
        }
      default:
        return assertNever(spec);
    }
  }

  /**
   * Re-own the restored tween windows by their queued events. Without the link a
   * Downtime freeze after a restore finds no tween to capture or cancel: the window
   * stays alive next to the one the resume creates, and the resumed tween restarts
   * from the payload's original start instead of the position where the MU stopped.
   * Match key: event payload tween spec (kind + MU) and window end == event time.
   */
  private _relinkRestoredTweens(saved: readonly TweenDataSnapshot[], handles: readonly TweenHandle[]): void {
    this._eventTweens.clear();
    const taken = new Set<number>();
    saved.forEach((t, i) => {
      if (t.kind !== 'drive' || t.eventId === null) return;
      const linked = this._eventTweens.get(t.eventId) ?? [];
      linked.push({ handle: handles[i] }); this._eventTweens.set(t.eventId, linked);
    });
    for (const event of this.manager.queuedEventsWithData()) {
      const payload = (event.data as HookEventData | null)?.data as
        { tween?: TweenSpec['tween']; tweens?: TweenSpec['tween'][] } | null | undefined;
      const specs = payload?.tweens ?? (payload?.tween ? [payload.tween] : []);
      const linked: Array<{ handle: TweenHandle; descriptor?: FrozenTweenDescriptor }> = this._eventTweens.get(event.id) ?? [];
      for (const spec of specs) {
        if ((spec.kind !== 'position' && spec.kind !== 'path') || typeof spec.muId !== 'number' || spec.muId < 0) continue;
        const kind = spec.kind;
        const index = saved.findIndex((t, i) => !taken.has(i) && t.kind !== 'drive' && t.kind === kind && t.muId === spec.muId
          && Math.abs(t.t1 - event.time) <= 0.0011);
        if (index < 0) continue;
        taken.add(index);
        const mu = this.manager.getMU(spec.muId) as DESMU | null;
        const muRef = { id: spec.muId, gen: mu?.generation ?? 0 };
        const remaining = Math.max(0, event.time - this.manager.currentTime);
        if (spec.kind === 'position') {
          linked.push({ handle: handles[index], descriptor: { kind: 'position', muRef,
            from: [...spec.from] as [number, number, number], to: [...spec.to] as [number, number, number], remaining } });
        } else {
          const pathRef = spec.pathRef ?? (spec.path as { id?: string } | null)?.id ?? '';
          if (pathRef) linked.push({ handle: handles[index], descriptor: { kind: 'path', muRef, pathRef,
            fromS: spec.fromS, toS: spec.toS, remaining } });
        }
      }
      if (linked.length > 0) this._eventTweens.set(event.id, linked);
    }
  }

  private _attachTweensFromData(
    data: unknown,
    duration: number,
  ): Array<{ handle: TweenHandle; descriptor?: FrozenTweenDescriptor }> {
    const source = data as { tween?: TweenSpec['tween']; tweens?: TweenSpec['tween'][] } | null;
    const held = (data as { heldDriveTweens?: Extract<TweenDataSnapshot, { kind: 'drive' }>[] } | null)?.heldDriveTweens;
    const specs = source?.tweens ?? (source?.tween ? [source.tween] : []);
    const attached: Array<{ handle: TweenHandle; descriptor?: FrozenTweenDescriptor }> = [];
    for (const spec of specs) {
      if (held && (spec.kind === 'drive' || spec.kind === 'axes')) continue;
      attached.push(...this._attachTweenFromData({ tween: spec }, duration));
    }
    for (const t of held ?? []) {
      const drive = this._driveByAddress(t.driveRef);
      if (!drive) throw new Error(`unknown held drive '${t.driveRef}'`);
      attached.push({ handle: this.tweens.addDrive(this._axisTweenTarget(drive), t.from, t.to,
        this.manager.currentTime + t.t0, t.t1 - t.t0, t) });
    }
    return attached;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * Animated/Hybrid time advance with the B4 budget-spreading guard.
   *
   * The render clock accumulates `dt · multiplier`. Events are processed up to
   * the render clock with a per-frame budget. When the budget is hit (more
   * events still due ≤ render clock), the render clock is pulled back to the
   * real sim position so visuals never outrun the un-processed events — the
   * remainder drains over the next frames (never dropped).
   *
   * The render clock is CLAMPED to the sim END time (`manager.duration`) so
   * Animated/Hybrid stop at the end exactly like FastForward does. Without the
   * clamp a time-lapse run drifted PAST the end (events kept processing beyond
   * `duration`), and a later switch to FastForward — which caps at `duration` —
   * then processed nothing and looked frozen ("draining" with a static queue).
   */
  private _advanceTimed(dt: number, multiplier: number): void {
    if (this.manager.isPaused) return;

    // Clamp to the end time; never below the real sim position (lowering the
    // end mid-run must not pull rendered tweens backwards).
    this._renderClock = Math.max(
      this.manager.currentTime,
      Math.min(this._renderClock + dt * Math.max(1, multiplier), this.manager.duration),
    );
    let hitBudget: boolean;
    try {
      ({ hitBudget } = this.manager.processUpTo(this._renderClock, this.frameEventBudget));
    } catch (error) {
      this._actionFailed(error);
      return;
    }

    if (hitBudget) {
      // Freeze the render clock at the real sim position; the next frame
      // continues processing the backlog from here (B4 spread, no drop).
      this._renderClock = this.manager.currentTime;
    }
  }

  /** Map a sub-mode to the native DESMode enum the existing HMI windows read. */
  private _toNativeMode(m: DesSubMode): DESMode {
    switch (m) {
      case 'fastforward': return DESMode.FastForward;
      case 'step': return DESMode.Step;
      default: return DESMode.Animated; // animated + hybrid both animate
    }
  }

  /** The tween-registry sub-mode tag for the current runner sub-mode. */
  private _renderSubMode(): TweenSubMode {
    return this._subMode;
  }
}

export interface DESRunner extends Required<Pick<SimDesControl, 'listExperiments' | 'readManifestJson' | 'readColumnSeriesJson' | 'saveSnapshot' | 'loadSnapshot' | 'deleteSnapshot' | 'deleteReplication' | 'deleteExperiment' | 'renameExperiment' | 'exportExperiment' | 'importExperiment' | 'estimateStorage' | 'activeRunInfoJson' | 'patchExperimentMetaJson' | 'batchBlockReason' | 'runExperimentBatch' | 'runAllExperiments' | 'cancelBatch' | 'batchOutcomeJson' | 'batchProgressJson'>> {
 setExperimentStore: (store: unknown) => void;
}

export type RunnerExperimentOperations = ReturnType<DESRunner["_experimentHost"]>;
