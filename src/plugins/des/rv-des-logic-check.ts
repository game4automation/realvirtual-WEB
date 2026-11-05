// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVLogicEngine } from '../../core/engine/rv-logic-engine';
import type { Object3D } from 'three';
import {
  RVDelay, RVDriveTo, RVEnable, RVGripPick, RVGripPlace, RVJavaScriptStep, RVJumpOnSignal,
  RVSetDriveSpeed, RVSetSignalBool, RVSetSignalFloat, RVStartDriveTo,
  RVParallelContainer, RVSerialContainer, RVWaitForDrivesAtTarget, RVWaitForSensor,
  RVWaitForSignalBool, RVWaitForSignalFloat, RVWaitForZone, StepState, type RVLogicStep,
} from '../../core/engine/rv-logic-step';
import { RVIKPathStep } from '../../core/engine/rv-ik-path-step';

export interface LogicStepDesOptions {
  eventMode?: 'instant' | 'wait' | 'motion';
  snapshot?: boolean;
}
const options = new Map<string, LogicStepDesOptions>();

export function registerLogicStepDesOptions(type: string, opts: LogicStepDesOptions): () => void {
  options.set(type, opts);
  return () => { if (options.get(type) === opts) options.delete(type); };
}

const builtins = [RVDelay, RVDriveTo, RVEnable, RVGripPick, RVGripPlace, RVJavaScriptStep,
  RVJumpOnSignal, RVParallelContainer, RVSerialContainer, RVSetDriveSpeed, RVSetSignalBool,
  RVSetSignalFloat, RVStartDriveTo, RVWaitForDrivesAtTarget, RVWaitForSensor,
  RVWaitForSignalBool, RVWaitForSignalFloat, RVWaitForZone, RVIKPathStep];
const nodeCache = new WeakMap<RVLogicEngine, { roots: readonly RVLogicStep[]; nodes: Map<RVLogicStep, Object3D> }>();

/** Reconstruct the engine's child-by-name mapping only when its root inventory changes. */
export function logicStepNodes(engine: RVLogicEngine): Map<RVLogicStep, Object3D> {
  const cached = nodeCache.get(engine);
  if (cached && cached.roots.length === engine.roots.length
    && cached.roots.every((root, i) => root === engine.roots[i])) return cached.nodes;
  const nodes = new Map<RVLogicStep, Object3D>();
  const visit = (step: RVLogicStep, node: Object3D): void => {
    nodes.set(step, node);
    if (step instanceof RVSerialContainer || step instanceof RVParallelContainer) for (const child of step.children) {
      const childNode = node.children.find(n => n.name === child.name
        && Object.keys(n.userData?.realvirtual ?? {}).some(key => key.startsWith('LogicStep_')));
      if (childNode) visit(child, childNode);
    }
  };
  const roots = (engine as unknown as { rootNodeByStep: Map<RVLogicStep, Object3D> }).rootNodeByStep;
  for (const root of engine.roots) { const node = roots.get(root); if (node) visit(root, node); }
  nodeCache.set(engine, { roots: [...engine.roots], nodes });
  return nodes;
}

export function logicStepDesInfo(step: RVLogicStep, engine: RVLogicEngine): ({ type: string } & LogicStepDesOptions) | null {
  if (builtins.some(type => Object.getPrototypeOf(step) === type.prototype)) return null;
  const type = Object.keys(logicStepNodes(engine).get(step)?.userData?.realvirtual ?? {})
    .find(key => key.startsWith('LogicStep_')) ?? step.constructor.name;
  return { type, ...options.get(type) };
}

export function logicSteps(root: RVLogicStep): RVLogicStep[] {
  return [root, ...(root instanceof RVSerialContainer || root instanceof RVParallelContainer
    ? root.children.flatMap(logicSteps) : [])];
}

export function logicCyclePolled(step: RVLogicStep, engine: RVLogicEngine): boolean {
  return step instanceof RVIKPathStep
    || logicStepDesInfo(step, engine)?.eventMode === 'motion';
}

function waits(step: RVLogicStep, engine: RVLogicEngine): boolean {
  const plugin = logicStepDesInfo(step, engine);
  if (plugin) return plugin.eventMode === 'wait' || plugin.eventMode === 'motion';
  if (step instanceof RVSerialContainer || step instanceof RVParallelContainer) return step.children.some(child => waits(child, engine));
  return step instanceof RVDelay && step.duration > 0
    || step instanceof RVWaitForSignalBool || step instanceof RVWaitForSignalFloat
    || step instanceof RVWaitForSensor || step instanceof RVWaitForZone
    || (step instanceof RVGripPick || step instanceof RVGripPlace) && step.blocking
    || step instanceof RVDriveTo || step instanceof RVWaitForDrivesAtTarget || logicCyclePolled(step, engine);
}

export interface LogicDesFinding {
  root: RVLogicStep;
  path: string;
  rule: 'auto-loop' | 'instant-jump' | 'event-mapping' | 'poll-delay';
  severity: 'error' | 'warning';
  message: string;
}

export function logicDesFindings(engine: RVLogicEngine): LogicDesFinding[] {
  const findings: LogicDesFinding[] = [];
  for (const root of engine.roots) {
    const add = (step: RVLogicStep, rule: LogicDesFinding['rule'], message: string,
      severity: LogicDesFinding['severity'] = 'error'): void => {
      findings.push({ root, path: step.hierarchyPath || step.name || root.name, rule, severity, message });
    };
    const autoLoop = root instanceof RVSerialContainer && root.autoLoop;
    if (autoLoop && !waits(root, engine)) add(root, 'auto-loop', `${root.name}: autoLoop has no waiting step`);
    for (const step of logicSteps(root)) {
      const plugin = logicStepDesInfo(step, engine);
      if (plugin ? !plugin.eventMode : step instanceof RVJavaScriptStep
        || step instanceof RVWaitForSensor && step.waitForStopped) {
        add(step, 'event-mapping', plugin ? `LogicStep type ${plugin.type} has no event mapping`
          : step instanceof RVWaitForSensor ? 'WaitForSensor(WaitForStopped) without MU-stop notification'
            : 'JavaScriptStep has no event mapping');
      }
      if (step instanceof RVSerialContainer) for (let i = 0; i < step.children.length; i++) {
        const jump = step.children[i];
        if (!(jump instanceof RVJumpOnSignal)) continue;
        const target = step.children.findIndex(child => child.name === jump.jumpToStep);
        if (target >= 0 && target <= i && !step.children.slice(target, i + 1).some(child => waits(child, engine)))
          add(jump, 'instant-jump', `${jump.name}: backward or self jump has no waiting step`);
      }
      if (autoLoop && step instanceof RVDelay && step.duration > 0 && step.duration < 0.1)
        add(step, 'poll-delay', `${step.name}: costs 1/duration events per second in DES (${1 / step.duration}/s)`, 'warning');
    }
  }
  return findings;
}

/** Only unsupported, currently executing steps block the Phase-3 snapshot seam. */
export function logicSnapshotBlockerReason(engine: RVLogicEngine): string | null {
  const reasons = new Set<string>();
  for (const root of engine.roots) {
    if (root.state !== StepState.Active && root.state !== StepState.Waiting) continue;
    for (const step of logicSteps(root)) {
      if (step.state !== StepState.Active && step.state !== StepState.Waiting) continue;
      const plugin = logicStepDesInfo(step, engine);
      if (plugin) {
        if (plugin.snapshot !== true) reasons.add(`LogicStep type ${plugin.type} has no snapshot participant`);
      } else if (step instanceof RVJavaScriptStep) reasons.add('LogicStep JavaScriptStep has no snapshot participant');
      else if (step instanceof RVWaitForSensor && step.waitForStopped)
        reasons.add('LogicStep WaitForSensor(WaitForStopped) without MU-stop notification');
    }
  }
  return [...reasons].join('; ') || null;
}
