// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { SignalStore } from './rv-signal-store';
import { NodeRegistry, type ComponentRef } from './rv-node-registry';
import type { ActiveOnly } from './rv-active-only';
import {
  type RVLogicStep,
  RVSerialContainer,
  RVParallelContainer,
  RVDelay,
  RVSetSignalBool,
  RVWaitForSignalBool,
  RVWaitForSensor,
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
import type { RVIKPath } from './rv-ik-path';
import { RVIKPathStep } from './rv-ik-path-step';
import { validateExtras } from './rv-extras-validator';
import { debug } from './rv-debug';

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
 * RVLogicEngine - Reconstructs LogicStep hierarchies from GLB node trees
 * and runs them in the simulation loop.
 *
 * Each top-level SerialContainer (with autoLoop) runs independently.
 * Engine is updated via fixedUpdate() from the simulation loop.
 */
export class RVLogicEngine {
  /** All top-level containers that run independently */
  readonly roots: RVLogicStep[] = [];

  /** O(1) path-to-step lookup, populated during build() */
  readonly stepByPath = new Map<string, RVLogicStep>();

  /** ActiveOnly mode — defaults to 'Always' since LogicEngine has no single GLB node. */
  activeOnly: ActiveOnly = 'Always';

  /** GLB node each root was built from — enables subtree-scoped removal. */
  private readonly rootNodeByStep = new Map<RVLogicStep, Object3D>();

  /** True once start() ran — roots added later (placed assets) start immediately. */
  private started = false;

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
   * Used by build() for the whole model and by the Layout Planner for placed
   * library assets (processExtras handles components but not logic). Roots
   * added after start() ran are started immediately so a dropped asset's
   * sequences run without a sim restart.
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

    subtreeRoot.traverse((node: Object3D) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;

      // Find any LogicStep_* key
      for (const key of Object.keys(rv)) {
        if (key.startsWith('LogicStep_')) {
          stepNodes.push({ node, rv, stepType: key });
          break; // One LogicStep per node rule
        }
      }
    });

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

    // Recursively build each top-level step
    let added = 0;
    for (const tl of topLevelNodes) {
      const step = buildStep(tl.node, tl.stepType, tl.rv, nodeStepMap, registry, signalStore, subtreeRoot);
      if (!step) continue;
      this.roots.push(step);
      this.rootNodeByStep.set(step, tl.node);
      populateStepByPath(step, tl.node);
      if (this.started) step.start();
      added++;
      debug('logic', `Root: "${step.name}" (${tl.stepType})${this.started ? ' [started]' : ''}`);
    }

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
    for (const r of removedRoots) this.rootNodeByStep.delete(r);

    debug('logic', `removeSubtree: -${removed} root containers (${this.stepByPath.size} paths remain)`);
    return removed;
  }

  /** Start all root containers */
  start(): void {
    this.started = true;
    debug('logic', `LogicEngine.start(): ${this.roots.length} roots`);
    for (const root of this.roots) {
      debug('logic', `  Starting root "${root.name}" (state=${root.state})`);
      root.start();
      debug('logic', `  After start: "${root.name}" state=${root.state}`);
    }
  }

  /** Update all active or waiting containers */
  fixedUpdate(dt: number): void {
    for (const root of this.roots) {
      if (root.state === StepState.Active || root.state === StepState.Waiting) {
        root.fixedUpdate(dt);
      }
    }
  }

  /** Reset all containers */
  reset(): void {
    for (const root of this.roots) {
      root.reset();
    }
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
    case 'LogicStep_SerialContainer': {
      const container = new RVSerialContainer([], true); // autoLoop for top-level
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
      const resolved = registry.resolve(ref, scope);
      const setToTrue = (data?.['SetToTrue'] as boolean) ?? true;
      step = new RVSetSignalBool(resolved.signalAddress ?? null, setToTrue, signalStore);
      break;
    }

    case 'LogicStep_WaitForSignalBool': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope);
      const waitForTrue = (data?.['WaitForTrue'] as boolean) ?? true;
      step = new RVWaitForSignalBool(resolved.signalAddress ?? null, waitForTrue, signalStore);
      break;
    }

    case 'LogicStep_WaitForSensor': {
      const ref = data?.['Sensor'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope);
      const waitForOccupied = (data?.['WaitForOccupied'] as boolean) ?? true;
      step = new RVWaitForSensor(resolved.sensor ?? null, waitForOccupied);
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
      const resolved = registry.resolve(ref, scope);
      const destination = (data?.['Destination'] as number) ?? 0;
      const relative = (data?.['Relative'] as boolean) ?? false;
      step = new RVDriveTo(resolved.drive ?? null, destination, relative);
      break;
    }

    case 'LogicStep_SetDriveSpeed': {
      const ref = data?.['drive'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope);
      const speed = (data?.['Speed'] as number) ?? 100;
      step = new RVSetDriveSpeed(resolved.drive ?? null, speed);
      break;
    }

    case 'LogicStep_Enable': {
      // Enable targets a GameObject — resolve by path via registry
      const targetPath = (data?.['Target'] as string) ?? '';
      let target: { visible: boolean } | null = null;
      if (targetPath) {
        target = registry.getNode(targetPath);
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
      const resolved = registry.resolve(ref, scope);
      const destination = (data?.['Destination'] as number) ?? 0;
      const relative = (data?.['Relative'] as boolean) ?? false;
      step = new RVStartDriveTo(resolved.drive ?? null, destination, relative);
      break;
    }

    case 'LogicStep_StartDriveSpeed': {
      const ref = data?.['drive'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope);
      const speed = (data?.['Speed'] as number) ?? 100;
      step = new RVSetDriveSpeed(resolved.drive ?? null, speed);
      break;
    }

    case 'LogicStep_WaitForDrivesAtTarget': {
      const driveRefs = (data?.['Drives'] as ComponentRef[]) ?? [];
      const drives = driveRefs
        .map(ref => registry.resolve(ref, scope).drive)
        .filter((d): d is NonNullable<typeof d> => d != null);
      step = new RVWaitForDrivesAtTarget(drives);
      break;
    }

    case 'LogicStep_SetSignalFloat': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope);
      const value = (data?.['Value'] as number) ?? 0;
      step = new RVSetSignalFloat(resolved.signalAddress ?? null, value, signalStore);
      break;
    }

    case 'LogicStep_WaitForSignalFloat': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope);
      const comparison = (data?.['Comparison'] as string) ?? 'Equals';
      const value = (data?.['Value'] as number) ?? 0;
      const tolerance = (data?.['Tolerance'] as number) ?? 0.0001;
      step = new RVWaitForSignalFloat(resolved.signalAddress ?? null, comparison, value, tolerance, signalStore);
      break;
    }

    case 'LogicStep_GripPick': {
      const ref = data?.['Grip'] as ComponentRef | undefined;
      const grip = ref?.path ? registry.getByPath<RVGrip>('Grip', ref.path) : null;
      const blocking = (data?.['Blocking'] as boolean) ?? false;
      step = new RVGripPick(grip, blocking);
      break;
    }

    case 'LogicStep_GripPlace': {
      const ref = data?.['Grip'] as ComponentRef | undefined;
      const grip = ref?.path ? registry.getByPath<RVGrip>('Grip', ref.path) : null;
      const blocking = (data?.['Blocking'] as boolean) ?? false;
      step = new RVGripPlace(grip, blocking);
      break;
    }

    case 'LogicStep_IKPath': {
      const ref = data?.['IKPath'] as ComponentRef | undefined;
      const ikPath = ref?.path ? registry.getByPath<RVIKPath>('IKPath', ref.path) : null;
      step = new RVIKPathStep(ikPath);
      break;
    }

    case 'LogicStep_JumpOnSignal': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref, scope);
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

    default:
      console.warn(`[LogicEngine] Unknown step type: "${stepType}" on "${node.name}"`);
      return null;
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
