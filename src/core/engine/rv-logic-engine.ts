// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { createSignalWriter, type SignalStore, type SignalWriter } from './rv-signal-store';
import { NodeRegistry, type ComponentRef } from './rv-node-registry';
import { isComponentReference } from './rv-node-path-rewrite.mjs';
import { isActiveForState, parseActiveOnly, type ActiveOnly } from './rv-active-only';
import type { RVDrive } from './rv-drive';
import {
  describeChannelAuthority,
  isRemoteOwnershipActive,
  isSignalLiveControlled,
  type SignalChannelId,
} from './rv-slot-authority';
import {
  type RVLogicStep,
  type LogicRootContext,
  parseSignalEdge,
  RVSerialContainer,
  RVJavaScriptStep,
  RVParallelContainer,
  RVDelay,
  RVSetSignalBool,
  RVWaitForSignalBool,
  RVWaitForSensor,
  RVWaitForZone,
  RVDriveTo,
  RVSetDriveSpeed,
  RVEnable,
  RVStartDriveTo,
  RVWaitForDrivesAtTarget,
  RVSetSignalFloat,
  RVWaitForSignalFloat,
  RVGripPick,
  RVGripPlace,
  RVJumpOnSignal,
  StepState,
} from './rv-logic-step';
import type { RVGrip } from './rv-grip';
import { RVZone } from './rv-zone';
import type { RVIKPath } from './rv-ik-path';
import { RVIKPathStep } from './rv-ik-path-step';
import { getLogicStepBuilder } from './rv-logic-step-registry';
import { validateExtras, logicRootRuleWarnings, type LogicRootRuleInput } from './rv-extras-validator';
import { debug } from './rv-debug';
import { MAINTENANCE_PROCEDURE_TYPE } from './rv-maintenance-components';

// ─── Step State Info (for UI polling) ────────────────────────────

export interface StepStateInfo {
  state: StepState;
  /** Present when live control intentionally suppressed an internal command. */
  reason?: 'suppressed-live';
  name: string;
  type: string;
  progress: number;
  // Container-specific:
  currentIndex?: number;
  childCount?: number;
  completedCycles?: number;
  finishedCount?: number;
  // Cycle time stats (SerialContainer only):
  minCycleTime?: number;
  maxCycleTime?: number;
  medianCycleTime?: number;
  // Leaf-specific:
  elapsed?: number;
  duration?: number;
}

/**
 * Per-root lifecycle state (plan-538). One per top-level root; the root's
 * `Active` (ActiveOnly) is evaluated against the connection state on its own.
 */
/** A root runs when its `Active` fits the connection state and nothing suppressed it. */
function wantsActive(rt: LogicRootRuntime, connected: boolean): boolean {
  return !rt.suppressed && isActiveForState(rt.activeOnly, connected);
}

class LogicRootRuntime implements LogicRootContext {
  /** True while the root runs (it was started and is wanted for the state). */
  active = false;
  /** Scratch of the two-phase transition: wanted for the NEW state. */
  want = false;
  /**
   * Suppressed: the root is replaced by something else (a virtual PLC program
   * that took over its job) and stays inactive in every connection state until
   * released or the model is reloaded.
   */
  suppressed = false;
  /** Owned outputs: signal address -> GLB start value (captured at build). */
  readonly ownedOutputs = new Map<string, boolean | number>();
  /** Drives the root's motion steps reference (validator input). */
  readonly drives: RVDrive[] = [];
  /** Steps that start motion without a cancel hook (validator input). */
  readonly motionWithoutCancel: string[] = [];

  constructor(
    readonly root: RVLogicStep,
    readonly activeOnly: ActiveOnly,
    private readonly engine: RVLogicEngine,
  ) {}

  noteDriveCommand(drive: RVDrive): void {
    this.engine._noteDriveCommand(drive, this);
  }

  isLastCommander(drive: RVDrive): boolean {
    return this.engine._lastCommanderOf(drive) === this;
  }
}

/**
 * RVLogicEngine - Reconstructs LogicStep hierarchies from GLB node trees
 * and runs them in the simulation loop.
 *
 * Each top-level SerialContainer (with autoLoop) runs independently; nested SerialContainers
 * run once per start and report Finished to their parent container (as in Unity).
 * Engine is updated via fixedUpdate() from the simulation loop.
 *
 * plan-538 — per-root `Active` lifecycle. Every top-level root carries its own
 * `Active` (read from its extras; missing / `DontChange` = `Always`), so a
 * model can hold a virtual PLC (`Disconnected`) that steps aside as soon as a
 * real PLC connects:
 * - a root starts only when it is active for the CURRENT connection state —
 *   at load, on `addSubtree()` (placements) and after a simulation reset;
 *   an inactive root stays `Idle` and writes nothing;
 * - {@link setConnected} (called every tick by `CoreSubsystems.early()`, also
 *   while the engine-wide {@link activeOnly} guard is closed) processes the
 *   transitions in TWO phases: every deactivation completes before any
 *   activation starts;
 * - deactivation cancels the root's steps (`cancel()` hooks stop the motion
 *   they started), resets the root to `Idle` and writes the outputs it owns
 *   back to their GLB start value — never one an active root owns, never one
 *   that is bound, forced or remote-owned;
 * - activation restarts the root from step 0.
 */
export class RVLogicEngine {
  /** All top-level containers that run independently */
  readonly roots: RVLogicStep[] = [];

  /** O(1) path-to-step lookup, populated during build() */
  readonly stepByPath = new Map<string, RVLogicStep>();

  /** Engine-wide ActiveOnly outer guard — defaults to 'Always' (the per-root
   *  `Active` of plan-538 is evaluated independently of it). */
  activeOnly: ActiveOnly = 'Always';

  /** Load-time warnings of the root rules (plan-538 F1f/F1g), refreshed on every addSubtree. */
  readonly warnings: string[] = [];

  /** Per-root lifecycle state (plan-538); roots pushed directly get an `Always` entry lazily. */
  private readonly runtimeByRoot = new Map<RVLogicStep, LogicRootRuntime>();
  /** Root whose step commanded a drive LAST (plan-538 F1f). */
  private readonly lastCommander = new Map<RVDrive, LogicRootRuntime>();
  /** Connection state the roots were last evaluated against. */
  private connected = false;
  /** Store + writer for the owned-output reset (set by addSubtree). */
  private resetStore: SignalStore | null = null;
  private resetWriter: SignalWriter | null = null;

  /** GLB node each root was built from — enables subtree-scoped removal. */
  private readonly rootNodeByStep = new Map<RVLogicStep, Object3D>();

  /** True once start() ran — roots added later (placed assets) start immediately. */
  private started = false;

  /**
   * plan-522: registry paths of the LogicStep nodes inside a maintenance
   * procedure that `addSubtree()` skipped → their node (for subtree-scoped
   * removal). `reapplyStepFields` is a no-op for them.
   */
  private readonly skippedMaintenancePaths = new Map<string, Object3D>();

  /** Build LogicStep tree from GLB scene graph */
  static build(
    sceneRoot: Object3D,
    registry: NodeRegistry,
    signalStore: SignalStore,
  ): RVLogicEngine {
    const engine = new RVLogicEngine();
    engine.addSubtree(sceneRoot, registry, signalStore);
    return engine;
  }

  /** Cheap pre-scan: does this subtree carry any LogicStep components? */
  static hasLogicSteps(root: Object3D): boolean {
    let found = false;
    root.traverse((node: Object3D) => {
      if (found) return;
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;
      for (const key of Object.keys(rv)) {
        if (key.startsWith('LogicStep_')) { found = true; return; }
      }
    });
    return found;
  }

  /**
   * Build the LogicSteps found in a subtree and merge them as new roots.
   * Used through `mergePlacedLogic()` for the main model (once its scene is
   * complete, plan-769 Phase 6) and for every placed asset (processExtras
   * handles components but not logic). A runtime placement BELOW the subtree
   * root is skipped — it merges its own steps. Roots added after start() ran
   * are started immediately so a dropped asset's sequences run without a sim
   * restart.
   *
   * @returns number of root containers added.
   */
  addSubtree(
    subtreeRoot: Object3D,
    registry: NodeRegistry,
    signalStore: SignalStore,
  ): number {
    // Find all nodes that have LogicStep components
    const stepNodes: { node: Object3D; rv: Record<string, unknown>; stepType: string }[] = [];

    // plan-522 F2: a maintenance procedure (node with
    // `LogicStep_MaintenanceProcedure`) and its whole subtree are data for the
    // maintenance guide, never logic — its step nodes carry DriveTo /
    // SetSignalBool that must not run at load. Filtered BEFORE the root
    // selection (plan-538 contract): no root, no stepByPath entry, no root-rule
    // warning, no owned output. Also when the subtree itself lies under one.
    for (let p = subtreeRoot.parent; p; p = p.parent) {
      if (isMaintenanceProcedureNode(p)) return 0;
    }
    const collect = (node: Object3D): void => {
      // plan-769 Phase 6: a runtime placement below the subtree root brings its
      // own logic — merged at its integration, or held by the trust gate
      // (plan-757 F6). The main model's merge runs AFTER its placements
      // materialised and must neither build their steps a second time nor
      // start the steps of a gated asset.
      if (node !== subtreeRoot && isPlacementContentRoot(node)) return;
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rv) {
        if (rv[MAINTENANCE_PROCEDURE_TYPE] != null) {
          this.rememberSkipped(node, registry);
          return;
        }
        // Find any LogicStep_* key
        for (const key of Object.keys(rv)) {
          if (key.startsWith('LogicStep_')) {
            stepNodes.push({ node, rv, stepType: key });
            break; // One LogicStep per node rule
          }
        }
      }
      const children = node.children;
      for (let i = 0; i < children.length; i++) collect(children[i]);
    };
    collect(subtreeRoot);

    if (stepNodes.length === 0) return 0;

    // Build a lookup: node -> step info
    const nodeStepMap = new Map<Object3D, { rv: Record<string, unknown>; stepType: string }>();
    for (const sn of stepNodes) {
      nodeStepMap.set(sn.node, { rv: sn.rv, stepType: sn.stepType });
    }

    // Find top-level containers (whose parent is NOT a LogicStep node)
    const topLevelNodes = stepNodes.filter((sn) => {
      const parent = sn.node.parent;
      return !parent || !nodeStepMap.has(parent);
    });

    // Populate stepByPath using registry paths
    const populateStepByPath = (step: RVLogicStep, node: Object3D) => {
      const path = registry.getPathForNode(node);
      if (path) {
        step.hierarchyPath = path;
        this.stepByPath.set(path, step);
      }
      if (step instanceof RVSerialContainer || step instanceof RVParallelContainer) {
        // Find child nodes from the GLB hierarchy
        for (const child of step.children) {
          // Match child step to a child node by name
          for (const childNode of node.children) {
            if (childNode.name === child.name && nodeStepMap.has(childNode)) {
              populateStepByPath(child, childNode);
              break;
            }
          }
        }
      }
    };

    if (this.resetStore !== signalStore) {
      this.resetStore = signalStore;
      this.resetWriter = createSignalWriter(signalStore, 'component:LogicEngine:owned-output-reset', 'component');
    }

    // Recursively build each top-level step
    let added = 0;
    for (const tl of topLevelNodes) {
      const step = buildStep(tl.node, tl.stepType, tl.rv, nodeStepMap, registry, signalStore, subtreeRoot);
      if (!step) continue;
      disableNestedAutoLoop(step);
      this.roots.push(step);
      this.rootNodeByStep.set(step, tl.node);
      populateStepByPath(step, tl.node);
      const data = (tl.rv[tl.stepType] as Record<string, unknown> | undefined) ?? {};
      const rt = this.registerRoot(step, parseActiveOnly(data), signalStore);
      // plan-538 F1b: a root starts only when it is active for the CURRENT state.
      if (this.started && rt.want) this.activateRoot(rt);
      added++;
      debug('logic', `Root: "${step.name}" (${tl.stepType}, Active=${rt.activeOnly})${this.started && rt.active ? ' [started]' : ''}`);
    }

    if (added > 0) this.refreshWarnings();
    debug('logic', `addSubtree: +${added} root containers from ${stepNodes.length} step nodes (${this.stepByPath.size} paths mapped)`);
    return added;
  }

  /**
   * Remove every root that was built from a node inside the given subtree
   * (used when a placed layout object is deleted). Purges the roots, their
   * node bookkeeping and all stepByPath entries of the removed trees.
   *
   * @returns number of root containers removed.
   */
  removeSubtree(subtreeRoot: Object3D): number {
    const removedRoots = new Set<RVLogicStep>();
    for (const [step, node] of this.rootNodeByStep) {
      for (let p: Object3D | null = node; p; p = p.parent) {
        if (p === subtreeRoot) { removedRoots.add(step); break; }
      }
    }
    for (const [path, node] of this.skippedMaintenancePaths) {
      for (let p: Object3D | null = node; p; p = p.parent) {
        if (p === subtreeRoot) { this.skippedMaintenancePaths.delete(path); break; }
      }
    }
    if (removedRoots.size === 0) return 0;

    // Collect every step of the removed trees so their path entries go too.
    const doomed = new Set<RVLogicStep>();
    const collect = (s: RVLogicStep) => {
      doomed.add(s);
      if (s instanceof RVSerialContainer || s instanceof RVParallelContainer) {
        for (const c of s.children) collect(c);
      }
    };
    for (const r of removedRoots) collect(r);
    for (const [path, s] of this.stepByPath) {
      if (doomed.has(s)) this.stepByPath.delete(path);
    }

    let removed = 0;
    for (let i = this.roots.length - 1; i >= 0; i--) {
      if (removedRoots.has(this.roots[i])) {
        this.roots.splice(i, 1);
        removed++;
      }
    }
    for (const r of removedRoots) {
      this.rootNodeByStep.delete(r);
      const rt = this.runtimeByRoot.get(r);
      this.runtimeByRoot.delete(r);
      if (rt) {
        for (const [drive, owner] of this.lastCommander) if (owner === rt) this.lastCommander.delete(drive);
      }
    }

    debug('logic', `removeSubtree: -${removed} root containers (${this.stepByPath.size} paths remain)`);
    return removed;
  }

  /**
   * True once {@link start} ran. `RVViewer.resetSimulation()` restarts the
   * roots only for an engine that was running before the reset, so a reset
   * never starts logic a gate (signature, plan-757 F6) still holds.
   */
  snapshotBlockerReason(): string | null {
    if (!this.started) return null;
    const roots = this.roots.filter(root => this.runtimeOf(root).active
      && (root.state === StepState.Active || root.state === StepState.Waiting));
    return roots.length ? `LogicStep ${roots.map(root => root.name).join(', ')}` : null;
  }

  /** Root containers that run (or will run on start) for the current connection state — the LogicSteps the DES batch guard names. */
  batchPresence(): string[] {
    return this.roots.filter(root => { const rt = this.runtimeOf(root); return rt.active || wantsActive(rt, this.connected); }).map(root => root.name);
  }

  get isStarted(): boolean { return this.started; }

  /** The connection state the roots are evaluated against (plan-538). */
  get isConnected(): boolean { return this.connected; }

  /**
   * Start the root containers that are active for the connection state — also
   * the restart after `reset()` (every such root back to its first step). An
   * inactive root stays `Idle` (plan-538 F1b). `connected`, when given, is the
   * CURRENT connection state (known before the first start, so a document
   * loaded while a PLC is already connected never starts a `Disconnected` root).
   */
  start(connected?: boolean): void {
    if (connected !== undefined) this.connected = connected;
    this.started = true;
    debug('logic', `LogicEngine.start(): ${this.roots.length} roots (connected=${this.connected})`);
    for (const root of this.roots) {
      const rt = this.runtimeOf(root);
      rt.want = wantsActive(rt, this.connected);
      if (!rt.want) {
        if (rt.active) this.deactivateRoot(rt);
        debug('logic', `  Root "${root.name}" inactive (Active=${rt.activeOnly}) — stays Idle`);
        continue;
      }
      debug('logic', `  Starting root "${root.name}" (state=${root.state})`);
      root.start();
      rt.active = true;
      debug('logic', `  After start: "${root.name}" state=${root.state}`);
    }
  }

  /**
   * Evaluate every root's `Active` against `connected` (plan-538 F1/F1f).
   * Called every tick by `CoreSubsystems.early()` — independent of the
   * engine-wide {@link activeOnly} guard. Before {@link start} it only records
   * the state. Two phases: ALL deactivations complete before ANY activation
   * starts, so the result never depends on the order of the roots.
   * Allocation-free in the steady state (no transition).
   */
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!this.started) return;
    let changes = false;
    for (let i = 0; i < this.roots.length; i++) {
      const rt = this.runtimeOf(this.roots[i]);
      rt.want = wantsActive(rt, connected);
      if (rt.want !== rt.active) changes = true;
    }
    if (!changes) return;
    for (let i = 0; i < this.roots.length; i++) {
      const rt = this.runtimeOf(this.roots[i]);
      if (rt.active && !rt.want) this.deactivateRoot(rt);
    }
    for (let i = 0; i < this.roots.length; i++) {
      const rt = this.runtimeOf(this.roots[i]);
      if (!rt.active && rt.want) this.activateRoot(rt);
    }
  }

  /**
   * Suppresses (or releases) every top-level root with this name — used when
   * something else took over its job, e.g. a virtual PLC program that replaces
   * the sequence. A suppressed root deactivates like on a connection change
   * (running steps cancelled, outputs it owns back to their start value) and
   * stays inactive in every connection state and after a simulation reset.
   * @returns true when at least one root has this name.
   */
  setRootSuppressed(name: string, suppressed: boolean): boolean {
    let found = false;
    for (const root of this.roots) {
      if (root.name !== name) continue;
      found = true;
      this.runtimeOf(root).suppressed = suppressed;
    }
    if (found) this.setConnected(this.connected);
    return found;
  }

  /** True when a root with this name is suppressed (see {@link setRootSuppressed}). */
  isRootSuppressed(name: string): boolean {
    return this.roots.some((r) => r.name === name && this.runtimeOf(r).suppressed);
  }

  /** `LogicEngineLike` per-tick hook of `CoreSubsystems.early()` — see {@link setConnected}. */
  updateConnection(connected: boolean): void {
    this.setConnected(connected);
  }

  /** Update all active or waiting containers (an inactive root is Idle and never ticks). */
  fixedUpdate(dt: number): void {
    for (const root of this.roots) {
      if (root.state === StepState.Active || root.state === StepState.Waiting) {
        root.fixedUpdate(dt);
      }
    }
  }

  /** Reset all containers (every root `Idle`, inactive until the next start). */
  reset(): void {
    for (const root of this.roots) {
      root.reset();
      const rt = this.runtimeByRoot.get(root);
      if (rt) rt.active = false;
    }
  }

  /**
   * plan-538 F6 — simulation reset: write the outputs owned by every root that
   * is ACTIVE for the current connection state back to their GLB start value.
   * Outputs of an inactive root belong to the real PLC and are left alone, as
   * is every bound, forced or remote-owned signal.
   *
   * @returns number of signals written.
   */
  resetOwnedOutputs(): number {
    let written = 0;
    for (const root of this.roots) {
      const rt = this.runtimeOf(root);
      if (!wantsActive(rt, this.connected)) continue;
      for (const [address, startValue] of rt.ownedOutputs) {
        if (this.writeStartValue(address, startValue)) written++;
      }
    }
    return written;
  }

  // --- plan-538 root lifecycle internals ---------------------------

  /** @internal — called through a root's LogicRootContext. */
  _noteDriveCommand(drive: RVDrive, rt: LogicRootRuntime): void {
    this.lastCommander.set(drive, rt);
  }

  /** @internal — called through a root's LogicRootContext. */
  _lastCommanderOf(drive: RVDrive): LogicRootRuntime | undefined {
    return this.lastCommander.get(drive);
  }

  /** The runtime of a root; roots pushed directly onto `roots` get an `Always` entry. */
  private runtimeOf(root: RVLogicStep): LogicRootRuntime {
    let rt = this.runtimeByRoot.get(root);
    if (!rt) {
      rt = new LogicRootRuntime(root, 'Always', this);
      rt.active = root.state === StepState.Active || root.state === StepState.Waiting;
      this.runtimeByRoot.set(root, rt);
      attachRootContext(root, rt);
    }
    return rt;
  }

  /** Register a freshly built root: Active, owned outputs (with start values), drives. */
  private registerRoot(root: RVLogicStep, activeOnly: ActiveOnly, signalStore: SignalStore): LogicRootRuntime {
    const rt = new LogicRootRuntime(root, activeOnly, this);
    this.runtimeByRoot.set(root, rt);
    attachRootContext(root, rt);
    walkSteps(root, (step) => {
      if (step instanceof RVSetSignalBool || step instanceof RVSetSignalFloat) {
        const address = step.signalAddress;
        if (address && !rt.ownedOutputs.has(address)) {
          const start = signalStore.getByPath(address);
          rt.ownedOutputs.set(address, start ?? (step instanceof RVSetSignalBool ? false : 0));
        }
      }
      if (step instanceof RVDriveTo || step instanceof RVStartDriveTo || step instanceof RVSetDriveSpeed) {
        if (step.drive && !rt.drives.includes(step.drive)) rt.drives.push(step.drive);
      }
      if (step.startsMotion && typeof step.cancel !== 'function') rt.motionWithoutCancel.push(step.name);
    });
    rt.want = wantsActive(rt, this.connected);
    return rt;
  }

  /** Inactive -> active: restart the root from step 0 (plan-538 F1c). */
  private activateRoot(rt: LogicRootRuntime): void {
    rt.root.reset();
    rt.root.start();
    rt.active = true;
    debug('logic', `Root "${rt.root.name}" activated (Active=${rt.activeOnly}, connected=${this.connected})`);
  }

  /**
   * Active -> inactive (plan-538 F1d): cancel the running steps (their hooks
   * stop the motion they started), reset the root to Idle and write its owned
   * outputs back to their GLB start value — except those an active (or about
   * to become active) root owns and those under external control.
   */
  private deactivateRoot(rt: LogicRootRuntime): void {
    walkSteps(rt.root, (step) => { step.cancel?.(); });
    rt.root.reset();
    rt.active = false;
    for (const [address, startValue] of rt.ownedOutputs) {
      if (this.ownedByWantedRoot(address, rt)) continue;
      this.writeStartValue(address, startValue);
    }
    debug('logic', `Root "${rt.root.name}" deactivated (Active=${rt.activeOnly}, connected=${this.connected})`);
  }

  /** True when another root that is (or becomes) active owns this output. */
  private ownedByWantedRoot(address: string, except: LogicRootRuntime): boolean {
    for (const root of this.roots) {
      const other = this.runtimeByRoot.get(root);
      if (!other || other === except || !other.want) continue;
      if (other.ownedOutputs.has(address)) return true;
    }
    return false;
  }

  /**
   * Write one owned output back to its start value — never when the signal is
   * bound, forced or remote-owned (checked BEFORE the write, so nothing reaches
   * subscribers even when the store's write gate only logs in `shadow` mode).
   */
  private writeStartValue(address: string, startValue: boolean | number): boolean {
    const store = this.resetStore;
    const writer = this.resetWriter;
    if (!store || !writer) return false;
    const name = store.nameForPath(address) ?? address;
    if (isExternallyControlled(store, name)) return false;
    if (store.getByPath(address) === startValue) return false;
    writer.setByPath(address, startValue);
    return true;
  }

  /** Record the LogicStep nodes of a skipped maintenance procedure (plan-522). */
  private rememberSkipped(procedureNode: Object3D, registry: NodeRegistry): void {
    procedureNode.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;
      for (const key in rv) {
        if (!key.startsWith('LogicStep_')) continue;
        const path = registry.getPathForNode(node);
        if (path) this.skippedMaintenancePaths.set(path, node);
        return;
      }
    });
  }

  /** Recompute the root-rule warnings (plan-538 F1f/F1g) and log new ones. */
  private refreshWarnings(): void {
    const inputs: LogicRootRuleInput[] = [];
    for (const root of this.roots) {
      const rt = this.runtimeOf(root);
      inputs.push({
        name: root.name,
        active: rt.activeOnly,
        outputs: [...rt.ownedOutputs.keys()],
        drives: rt.drives,
        motionWithoutCancel: rt.motionWithoutCancel,
      });
    }
    const next = logicRootRuleWarnings(inputs);
    for (const w of next) {
      if (!this.warnings.includes(w)) console.warn(`[LogicEngine] ${w}`);
    }
    this.warnings.length = 0;
    this.warnings.push(...next);
  }

  /**
   * plan-502 F13 — push an edited LogicStep field set into the RUNNING step at
   * `path`, so an Inspector edit (setField / unsetField op → scene or asset
   * executor → `reapplySchemaForComponent`) takes effect without a reload.
   * LogicSteps are not registry components, so the generic schema reapply never
   * reaches them. Covered: `LogicStep_Delay.Duration` (a running delay finishes
   * as soon as `elapsed >= Duration`, so a shorter value applies to the current
   * wait already) and `LogicStep_SetSignalBool.SetToTrue`. Other fields keep
   * their load-time value until the next load.
   *
   * @returns true when a running step took the new values.
   */
  reapplyStepFields(path: string, stepType: string, data: Record<string, unknown>): boolean {
    // plan-522: a step node of a maintenance procedure is never a running step —
    // editing it in the Inspector must not build or touch one.
    if (this.skippedMaintenancePaths.has(path)) return false;
    const step = this.stepByPath.get(path);
    if (!step) return false;
    if (stepType === 'LogicStep_Delay' && step instanceof RVDelay) {
      const d = data['Duration'];
      step.duration = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : 1;
      return true;
    }
    if (stepType === 'LogicStep_SetSignalBool' && step instanceof RVSetSignalBool) {
      step.value = (data['SetToTrue'] as boolean | undefined) ?? true;
      return true;
    }
    return false;
  }

  /** Get step info for a given hierarchy path (for UI display) */
  getStepInfo(path: string): StepStateInfo | null {
    const step = this.stepByPath.get(path);
    if (!step) return null;

    const info: StepStateInfo = {
      state: step.state,
      reason: step.reason,
      name: step.name,
      type: step.constructor.name.replace('RV', ''),
      progress: step.progress,
    };

    if (step instanceof RVSerialContainer) {
      info.currentIndex = step.currentIndex;
      info.childCount = step.children.length;
      info.completedCycles = step.completedCycles;
      info.minCycleTime = step.minCycleTime;
      info.maxCycleTime = step.maxCycleTime;
      info.medianCycleTime = step.medianCycleTime;
    } else if (step instanceof RVParallelContainer) {
      info.finishedCount = step.finishedCount;
      info.childCount = step.children.length;
    } else if (step instanceof RVDelay) {
      info.elapsed = step.elapsed;
      info.duration = step.duration;
    }

    return info;
  }

  get stats() {
    let activeSteps = 0;
    let waitingSteps = 0;
    let totalSteps = 0;
    const countSteps = (step: RVLogicStep) => {
      totalSteps++;
      if (step.state === StepState.Active) activeSteps++;
      if (step.state === StepState.Waiting) waitingSteps++;
      if (step instanceof RVSerialContainer || step instanceof RVParallelContainer) {
        for (const child of step.children) countSteps(child);
      }
    };
    for (const root of this.roots) countSteps(root);
    return { roots: this.roots.length, totalSteps, activeSteps, waitingSteps };
  }
}

/** True when the node is the root of a maintenance procedure (plan-522). */
function isMaintenanceProcedureNode(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  return !!rv && rv[MAINTENANCE_PROCEDURE_TYPE] != null;
}

/**
 * True for the root of a runtime placement — a planner record (`_layoutId`) or
 * a nested placement (`_layoutNestedOf`); the markers of
 * `rv-placement-instancer.ts` (`isPlacementRoot`), read inline so the engine
 * does not import the instancer.
 */
function isPlacementContentRoot(node: Object3D): boolean {
  const ud = node.userData as Record<string, unknown> | undefined;
  return typeof ud?._layoutId === 'string' || typeof ud?._layoutNestedOf === 'string';
}

/** Visit a step and (for containers) all its descendants, depth-first. */
function walkSteps(step: RVLogicStep, visit: (step: RVLogicStep) => void): void {
  visit(step);
  if (step instanceof RVSerialContainer || step instanceof RVParallelContainer) {
    for (const child of step.children) walkSteps(child, visit);
  }
}

/** Give every step of a root its root context (plan-538). */
function attachRootContext(root: RVLogicStep, ctx: LogicRootContext): void {
  walkSteps(root, (step) => { step.rootContext = ctx; });
}

/**
 * True when a signal is under EXTERNAL control (plan-538 F1d/F6): live-bound to
 * a CONNECT source, operator-forced, claimed bound/forced on its channel, or
 * pre-empted by a remote session owner. Such a signal is never reset by the
 * engine — the external owner's value stands. Exported for the virtual PLC,
 * whose output reset follows the same rule.
 */
export function isExternallyControlled(store: SignalStore, name: string): boolean {
  if (isRemoteOwnershipActive()) return true;
  if (isSignalLiveControlled(name)) return true;
  if (store.isForced(name)) return true;
  const authority = describeChannelAuthority(name as SignalChannelId);
  return authority !== null && (authority.authority === 'bound' || authority.authority === 'forced');
}

/**
 * Only a root chain runs cyclically (Unity: LogicStep.NextStep / SerialContainer.OnFinished — a
 * container with a parent container reports its end to that parent instead of restarting).
 * Clears `autoLoop` on every SerialContainer below `root`, whether its ancestor is a Serial or a
 * Parallel container; the root itself keeps its flag. plan-2016 S2.
 */
export function disableNestedAutoLoop(root: RVLogicStep): void {
  const walk = (s: RVLogicStep, nested: boolean): void => {
    if (s instanceof RVSerialContainer) {
      if (nested) s.autoLoop = false;
      for (const c of s.children) walk(c, true);
    } else if (s instanceof RVParallelContainer) {
      for (const c of s.children) walk(c, true);
    }
  };
  walk(root, false);
}

/**
 * Recursively build an RVLogicStep from a GLB node.
 * `scope` is the subtree the steps were authored in — passed to
 * `registry.resolve()` as the name-fallback boundary so ComponentReferences
 * with stale hierarchy prefixes still bind inside their own asset instance.
 */
function buildStep(
  node: Object3D,
  stepType: string,
  rv: Record<string, unknown>,
  nodeStepMap: Map<Object3D, { rv: Record<string, unknown>; stepType: string }>,
  registry: NodeRegistry,
  signalStore: SignalStore,
  scope: Object3D | null,
  parentContainer?: RVSerialContainer,
): RVLogicStep | null {
  const data = rv[stepType] as Record<string, unknown> | undefined;
  if (data) {
    validateExtras(stepType, data);
  }

  let step: RVLogicStep | null = null;

  switch (stepType) {
    case 'LogicStep_JavaScript': {
      step = new RVJavaScriptStep();
      break;
    }
    case 'LogicStep_SerialContainer': {
      // autoLoop is the root default; disableNestedAutoLoop() clears it on every nested Serial.
      const container = new RVSerialContainer([], true);
      const children = buildChildren(node, nodeStepMap, registry, signalStore, scope, container);
      container.children = children;
      step = container;
      break;
    }

    case 'LogicStep_ParallelContainer': {
      const children = buildChildren(node, nodeStepMap, registry, signalStore, scope);
      step = new RVParallelContainer(children);
      break;
    }

    case 'LogicStep_Delay': {
      const duration = (data?.['Duration'] as number) ?? 1;
      step = new RVDelay(duration);
      break;
    }

    case 'LogicStep_SetSignalBool': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const setToTrue = (data?.['SetToTrue'] as boolean) ?? true;
      step = new RVSetSignalBool(resolved.signalAddress ?? null, setToTrue, signalStore);
      break;
    }

    case 'LogicStep_WaitForSignalBool': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const waitForTrue = (data?.['WaitForTrue'] as boolean) ?? true;
      // plan-538 F5: optional edge mode, default Level (today's behaviour).
      step = new RVWaitForSignalBool(resolved.signalAddress ?? null, waitForTrue, signalStore, parseSignalEdge(data?.['Edge']));
      break;
    }

    case 'LogicStep_WaitForSensor': {
      const ref = data?.['Sensor'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const waitForOccupied = (data?.['WaitForOccupied'] as boolean) ?? true;
      step = new RVWaitForSensor(resolved.sensor ?? null, waitForOccupied, data?.['WaitForStopped'] === true);
      break;
    }

    case 'LogicStep_WaitForZone': {
      // plan-521 — Zone reference through the generic component branch of the
      // ONE resolver (asset-relative, three steps).
      const ref = data?.['Zone'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const zone = resolved.component instanceof RVZone ? resolved.component : null;
      if (!zone) {
        console.warn(`[LogicStep] WaitForZone "${node.name}": Zone reference ${ref?.path ? `"${ref.path}" not found` : 'missing'}`);
      }
      const waitForOccupied = (data?.['WaitForOccupied'] as boolean) ?? true;
      step = new RVWaitForZone(zone, waitForOccupied);
      break;
    }

    case 'LogicStep_DriveToPosition':
    case 'LogicStep_DriveTo': {
      const ref = data?.['drive'] as ComponentRef | undefined;
      if (!ref) {
        debug('logic', `DriveTo "${node.name}": no 'drive' field in data. Keys: ${data ? Object.keys(data).join(', ') : 'no data'}`);
      } else {
        debug('logic', `DriveTo "${node.name}": ref type="${ref.type}" path="${ref.path}" componentType="${ref.componentType}"`);
      }
      const resolved = registry.resolve(ref, scope, node);
      const destination = (data?.['Destination'] as number) ?? 0;
      const relative = (data?.['Relative'] as boolean) ?? false;
      // plan-2016 S3 — Unity `DestinationFromPLCOutput` (PLCOutputFloat). The
      // signal is read here, at build time: signals are registered by the
      // loader before the logic is built, so this is the Unity `Awake` moment.
      const destRef = data?.['DestinationFromPLCOutput'] as ComponentRef | undefined;
      const destSignal = destRef ? (registry.resolve(destRef, scope, node).signalAddress ?? null) : null;
      step = new RVDriveTo(resolved.drive ?? null, destination, relative, destSignal, signalStore);
      break;
    }

    case 'LogicStep_SetDriveSpeed': {
      const ref = data?.['drive'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const speed = (data?.['Speed'] as number) ?? 100;
      step = new RVSetDriveSpeed(resolved.drive ?? null, speed);
      break;
    }

    case 'LogicStep_Enable': {
      // Enable targets a GameObject. plan-769: a declared path field (PATH_FIELDS) —
      // a path (Unity export) or, in a web-saved file, `{ address }` / `{ unresolvedPath }`;
      // read through the file's verdict, never a guess.
      const rawTarget = data?.['Target'] as string | { address?: string; unresolvedPath?: string } | undefined;
      let target: { visible: boolean } | null = null;
      if (rawTarget) {
        target = registry.storedNode(node, rawTarget as Parameters<typeof registry.storedNode>[1]);
      }
      const enable = (data?.['Enable'] as boolean) ?? true;
      step = new RVEnable(target, enable);
      break;
    }

    case 'LogicStep_Pause': {
      // Pause is a debugging breakpoint — treat as 0-delay in WebViewer
      step = new RVDelay(0);
      break;
    }

    case 'LogicStep_StartDriveTo': {
      const ref = data?.['drive'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const destination = (data?.['Destination'] as number) ?? 0;
      const relative = (data?.['Relative'] as boolean) ?? false;
      step = new RVStartDriveTo(resolved.drive ?? null, destination, relative);
      break;
    }

    case 'LogicStep_StartDriveSpeed': {
      const ref = data?.['drive'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const speed = (data?.['Speed'] as number) ?? 100;
      step = new RVSetDriveSpeed(resolved.drive ?? null, speed);
      break;
    }

    case 'LogicStep_WaitForDrivesAtTarget': {
      const driveRefs = (data?.['Drives'] as ComponentRef[]) ?? [];
      const drives = driveRefs
        .map(ref => registry.resolve(ref, scope, node).drive)
        .filter((d): d is NonNullable<typeof d> => d != null);
      step = new RVWaitForDrivesAtTarget(drives);
      break;
    }

    case 'LogicStep_SetSignalFloat': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const value = (data?.['Value'] as number) ?? 0;
      step = new RVSetSignalFloat(resolved.signalAddress ?? null, value, signalStore);
      break;
    }

    case 'LogicStep_WaitForSignalFloat': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const comparison = (data?.['Comparison'] as string) ?? 'Equals';
      const value = (data?.['Value'] as number) ?? 0;
      const tolerance = (data?.['Tolerance'] as number) ?? 0.0001;
      step = new RVWaitForSignalFloat(resolved.signalAddress ?? null, comparison, value, tolerance, signalStore);
      break;
    }

    case 'LogicStep_GripPick': {
      const ref = data?.['Grip'] as ComponentRef | undefined;
      const grip = isComponentReference(ref) ? registry.storedComponent<RVGrip>(node, ref, 'Grip') : null;
      const blocking = (data?.['Blocking'] as boolean) ?? false;
      step = new RVGripPick(grip, blocking);
      break;
    }

    case 'LogicStep_GripPlace': {
      const ref = data?.['Grip'] as ComponentRef | undefined;
      const grip = isComponentReference(ref) ? registry.storedComponent<RVGrip>(node, ref, 'Grip') : null;
      const blocking = (data?.['Blocking'] as boolean) ?? false;
      step = new RVGripPlace(grip, blocking);
      break;
    }

    case 'LogicStep_IKPath': {
      const ref = data?.['IKPath'] as ComponentRef | undefined;
      const ikPath = isComponentReference(ref) ? registry.storedComponent<RVIKPath>(node, ref, 'IKPath') : null;
      step = new RVIKPathStep(ikPath);
      break;
    }

    case 'LogicStep_JumpOnSignal': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope, node);
      const jumpOn = (data?.['JumpOn'] as boolean) ?? true;
      const jumpToStep = (data?.['JumpToStep'] as string) ?? '';
      step = new RVJumpOnSignal(resolved.signalAddress ?? null, jumpOn, jumpToStep, signalStore, parentContainer ?? null);
      break;
    }

    // No-ops: not applicable in WebViewer
    case 'LogicStep_SetActiveOnly':
    case 'LogicStep_CinemachineCamera':
    case 'LogicStep_StatStartCycle':
    case 'LogicStep_StatEndCycle':
    case 'LogicStep_StatState':
    case 'LogicStep_StatOutput': {
      step = new RVDelay(0);
      break;
    }

    default: {
      // Plugin step types (plan-729): a private feature registers its builder
      // in rv-logic-step-registry.ts — the public core never imports the type.
      // Without a registration (community build) the old warning stands.
      const builder = getLogicStepBuilder(stepType);
      if (!builder) {
        console.warn(`[LogicEngine] Unknown step type: "${stepType}" on "${node.name}"`);
        return null;
      }
      step = builder({ data: data ?? {}, node, stepType, registry, signalStore, scope });
      break;
    }
  }

  if (step) {
    step.name = node.name;
  }
  return step;
}

/** Build children steps for a container node (sorted by sibling index / child order) */
function buildChildren(
  parentNode: Object3D,
  nodeStepMap: Map<Object3D, { rv: Record<string, unknown>; stepType: string }>,
  registry: NodeRegistry,
  signalStore: SignalStore,
  scope: Object3D | null,
  parentContainer?: RVSerialContainer,
): RVLogicStep[] {
  const children: RVLogicStep[] = [];

  // Children are in hierarchy order (child index = execution order)
  for (const childNode of parentNode.children) {
    const info = nodeStepMap.get(childNode);
    if (!info) continue;
    const step = buildStep(childNode, info.stepType, info.rv, nodeStepMap, registry, signalStore, scope, parentContainer);
    if (step) {
      children.push(step);
    }
  }

  return children;
}
