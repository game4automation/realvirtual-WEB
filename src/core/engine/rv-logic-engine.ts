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
import { validateExtras } from './rv-extras-validator';
import { debug } from './rv-debug';

// ─── Step State Info (for UI polling) ────────────────────────────

export interface StepStateInfo {
  state: StepState;
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

  /** Build LogicStep tree from GLB scene graph */
  static build(
    sceneRoot: Object3D,
    registry: NodeRegistry,
    signalStore: SignalStore,
  ): RVLogicEngine {
    const engine = new RVLogicEngine();

    // Find all nodes that have LogicStep components
    const stepNodes: { node: Object3D; rv: Record<string, unknown>; stepType: string }[] = [];

    sceneRoot.traverse((node: Object3D) => {
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

    if (stepNodes.length === 0) return engine;

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

    // Recursively build each top-level step
    for (const tl of topLevelNodes) {
      const step = buildStep(tl.node, tl.stepType, tl.rv, nodeStepMap, registry, signalStore);
      if (step) {
        engine.roots.push(step);
        debug('logic', `Root: "${step.name}" (${tl.stepType})`);
      }
    }

    // Populate stepByPath using registry paths
    const populateStepByPath = (step: RVLogicStep, node: Object3D) => {
      const path = registry.getPathForNode(node);
      if (path) {
        step.hierarchyPath = path;
        engine.stepByPath.set(path, step);
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

    for (const tl of topLevelNodes) {
      const step = engine.roots.find(r => r.name === tl.node.name);
      if (step) {
        populateStepByPath(step, tl.node);
      }
    }

    debug('logic', `Built ${engine.roots.length} root containers from ${stepNodes.length} step nodes (${engine.stepByPath.size} paths mapped)`);
    return engine;
  }

  /** Start all root containers */
  start(): void {
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

/** Recursively build an RVLogicStep from a GLB node */
function buildStep(
  node: Object3D,
  stepType: string,
  rv: Record<string, unknown>,
  nodeStepMap: Map<Object3D, { rv: Record<string, unknown>; stepType: string }>,
  registry: NodeRegistry,
  signalStore: SignalStore,
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
      const children = buildChildren(node, nodeStepMap, registry, signalStore, container);
      container.children = children;
      step = container;
      break;
    }

    case 'LogicStep_ParallelContainer': {
      const children = buildChildren(node, nodeStepMap, registry, signalStore);
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
      const resolved = registry.resolve(ref);
      const setToTrue = (data?.['SetToTrue'] as boolean) ?? true;
      step = new RVSetSignalBool(resolved.signalAddress ?? null, setToTrue, signalStore);
      break;
    }

    case 'LogicStep_WaitForSignalBool': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref);
      const waitForTrue = (data?.['WaitForTrue'] as boolean) ?? true;
      step = new RVWaitForSignalBool(resolved.signalAddress ?? null, waitForTrue, signalStore);
      break;
    }

    case 'LogicStep_WaitForSensor': {
      const ref = data?.['Sensor'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref);
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
      const resolved = registry.resolve(ref);
      const destination = (data?.['Destination'] as number) ?? 0;
      const relative = (data?.['Relative'] as boolean) ?? false;
      const direction = (data?.['Direction'] as string) ?? 'Automatic';
      step = new RVDriveTo(resolved.drive ?? null, destination, relative, direction);
      break;
    }

    case 'LogicStep_SetDriveSpeed': {
      const ref = data?.['drive'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref);
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
      const resolved = registry.resolve(ref);
      const destination = (data?.['Destination'] as number) ?? 0;
      const relative = (data?.['Relative'] as boolean) ?? false;
      const direction = (data?.['Direction'] as string) ?? 'Automatic';
      step = new RVStartDriveTo(resolved.drive ?? null, destination, relative, direction);
      break;
    }

    case 'LogicStep_StartDriveSpeed': {
      const ref = data?.['drive'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref);
      const speed = (data?.['Speed'] as number) ?? 100;
      step = new RVSetDriveSpeed(resolved.drive ?? null, speed);
      break;
    }

    case 'LogicStep_WaitForDrivesAtTarget': {
      const driveRefs = (data?.['Drives'] as ComponentRef[]) ?? [];
      const drives = driveRefs
        .map(ref => registry.resolve(ref).drive)
        .filter((d): d is NonNullable<typeof d> => d != null);
      step = new RVWaitForDrivesAtTarget(drives);
      break;
    }

    case 'LogicStep_SetSignalFloat': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref);
      const value = (data?.['Value'] as number) ?? 0;
      step = new RVSetSignalFloat(resolved.signalAddress ?? null, value, signalStore);
      break;
    }

    case 'LogicStep_WaitForSignalFloat': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref);
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

    case 'LogicStep_JumpOnSignal': {
      const ref = data?.['Signal'] as ComponentRef | undefined;
      const resolved = registry.resolve(ref);
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
  parentContainer?: RVSerialContainer,
): RVLogicStep[] {
  const children: RVLogicStep[] = [];

  // Children are in hierarchy order (child index = execution order)
  for (const childNode of parentNode.children) {
    const info = nodeStepMap.get(childNode);
    if (!info) continue;
    const step = buildStep(childNode, info.stepType, info.rv, nodeStepMap, registry, signalStore, parentContainer);
    if (step) {
      children.push(step);
    }
  }

  return children;
}
