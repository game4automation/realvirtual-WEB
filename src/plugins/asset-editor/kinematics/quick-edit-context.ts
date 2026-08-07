// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * quick-edit-context — selection analysis for the Kinematics window.
 *
 * The web port of Unity's QuickEditContext + QuickEditVisibility: one pure
 * function that reads the current selection and derives every flag the
 * context-sensitive sections need. Mirrors Unity's rules:
 *
 *  - Selecting a SIGNAL node rebases the context onto its parent (transform /
 *    creation act on the parent; new signals become siblings). The original
 *    signal node stays addressable via `signalNodePath` / `signalType`.
 *  - "Under X" flags walk self + ancestors (Unity `GetComponentInParent`),
 *    stopping at the asset root.
 *  - Unity's `IsUnderInterface` has no web counterpart (interfaces are a
 *    Unity-runtime concept) — treated as always false.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../../core/rv-viewer';
import type { SelectionSnapshot } from '../../../core/engine/rv-selection-manager';
import type { RVDrive } from '../../../core/engine/rv-drive';
import { NodeRegistry } from '../../../core/engine/rv-node-registry';
import { SIGNAL_TYPES, DRIVE_BEHAVIOR_MAP } from '../../../core/engine/rv-signal-construction';

/** Drive-behavior component types offered by the behaviors palette. */
export const DRIVE_BEHAVIOR_TYPES: readonly string[] = Object.keys(DRIVE_BEHAVIOR_MAP);

/** Base component keys, tolerant of the `_N` dedup suffix (`Drive`, `Drive_1`). */
const DRIVE_KEY_RE = /^Drive(_\d+)?$/;
const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;
const SENSOR_KEY_RE = /^Sensor(_\d+)?$/;
const GRIP_KEY_RE = /^Grip(_\d+)?$/;
const TRANSPORT_SURFACE_KEY_RE = /^TransportSurface(_\d+)?$/;

export interface QuickEditContext {
  /** True when at least one node is selected (and resolvable). */
  hasSelection: boolean;
  /** Exactly one node selected. */
  isSingle: boolean;
  /** Context node (post signal-rebase) — actions target this node. */
  node: Object3D | null;
  /** Registry path of the context node. */
  nodePath: string | null;
  /** Display name of the context node. */
  nodeName: string;
  /** All selected paths (original selection, no rebase). */
  selectedPaths: ReadonlyArray<string>;

  // Signal rebase (original selection was a signal node)
  hasSignal: boolean;
  signalNodePath: string | null;
  signalType: string | null;

  // Component flags on the context node
  hasDrive: boolean;
  hasKinematic: boolean;
  hasSensor: boolean;
  hasGrip: boolean;
  hasTransportSurface: boolean;
  hasLogicStep: boolean;
  logicStepType: string | null;
  /** rv_extras keys of Drive_* behaviors already on the node. */
  existingDriveBehaviors: ReadonlySet<string>;
  /** Any rv component other than `Hidden` and LogicStep_* (gates the lone
   *  "LogicSteps" starter button, Unity parity). */
  hasOtherRvComponents: boolean;

  // Hierarchy flags (self + ancestors, stopping at the asset root)
  isUnderTransportSurface: boolean;
  isUnderSerialContainer: boolean;

  /** Live RVDrive instance on the context node (null until save & reload for
   *  freshly stamped drives without a constructed runtime component). */
  drive: RVDrive | null;
}

const NO_SELECTION: QuickEditContext = Object.freeze({
  hasSelection: false,
  isSingle: false,
  node: null,
  nodePath: null,
  nodeName: '',
  selectedPaths: Object.freeze([]) as ReadonlyArray<string>,
  hasSignal: false,
  signalNodePath: null,
  signalType: null,
  hasDrive: false,
  hasKinematic: false,
  hasSensor: false,
  hasGrip: false,
  hasTransportSurface: false,
  hasLogicStep: false,
  logicStepType: null,
  existingDriveBehaviors: Object.freeze(new Set<string>()) as ReadonlySet<string>,
  hasOtherRvComponents: false,
  isUnderTransportSurface: false,
  isUnderSerialContainer: false,
  drive: null,
});

/** rv_extras of a node ({} when absent). */
function rvOf(node: Object3D): Record<string, unknown> {
  return (node.userData as Record<string, unknown>)?.['realvirtual'] as Record<string, unknown> ?? {};
}

function firstKey(rv: Record<string, unknown>, pred: (key: string) => boolean): string | null {
  for (const key of Object.keys(rv)) {
    if (pred(key)) return key;
  }
  return null;
}

/** Walk self + ancestors (up to and including the asset root) for a predicate. */
function selfOrAncestorHas(
  node: Object3D, root: Object3D | null, pred: (rv: Record<string, unknown>) => boolean,
): boolean {
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    if (pred(rvOf(cur))) return true;
    if (cur === root) break;
  }
  return false;
}

/** Derive the Kinematics window's context from the current selection. */
export function computeQuickEditContext(viewer: RVViewer, selection: SelectionSnapshot): QuickEditContext {
  const registry = viewer.registry;
  const primaryPath = selection.primaryPath;
  if (!registry || !primaryPath) return NO_SELECTION;
  const selectedNode = registry.getNode(primaryPath);
  if (!selectedNode) return NO_SELECTION;

  const root = viewer.currentModelRoot;

  // Signal rebase: a selected signal node hands the context to its parent
  // (Unity QuickEditOverlay.CreateEditModeUI). New signals become siblings,
  // transform tools act on the carrier object.
  const selectedRv = rvOf(selectedNode);
  const signalType = firstKey(selectedRv, (k) => SIGNAL_TYPES.includes(stripDedupSuffix(k)));
  let node = selectedNode;
  if (signalType && selectedNode.parent && selectedNode !== root) {
    node = selectedNode.parent;
  }
  const nodePath = NodeRegistry.computeNodePath(node);

  const rv = rvOf(node);
  const keys = Object.keys(rv);
  const logicStepType = firstKey(rv, (k) => k.startsWith('LogicStep_'));
  const behaviors = new Set<string>();
  for (const key of keys) {
    if (DRIVE_BEHAVIOR_MAP[stripDedupSuffix(key)]) behaviors.add(stripDedupSuffix(key));
  }
  const hasOtherRvComponents = keys.some((k) =>
    k !== 'Hidden'
    && !k.startsWith('LogicStep_')
    && !SIGNAL_TYPES.includes(stripDedupSuffix(k)),
  );

  return {
    hasSelection: true,
    isSingle: selection.selectedPaths.length === 1,
    node,
    nodePath,
    nodeName: node.name,
    selectedPaths: selection.selectedPaths,
    hasSignal: signalType !== null,
    signalNodePath: signalType ? primaryPath : null,
    signalType: signalType ? stripDedupSuffix(signalType) : null,
    hasDrive: keys.some((k) => DRIVE_KEY_RE.test(k)),
    hasKinematic: keys.some((k) => KINEMATIC_KEY_RE.test(k)),
    hasSensor: keys.some((k) => SENSOR_KEY_RE.test(k)),
    hasGrip: keys.some((k) => GRIP_KEY_RE.test(k)),
    hasTransportSurface: keys.some((k) => TRANSPORT_SURFACE_KEY_RE.test(k)),
    hasLogicStep: logicStepType !== null,
    logicStepType,
    existingDriveBehaviors: behaviors,
    hasOtherRvComponents,
    isUnderTransportSurface: selfOrAncestorHas(node, root, (r) =>
      Object.keys(r).some((k) => TRANSPORT_SURFACE_KEY_RE.test(k))),
    isUnderSerialContainer: selfOrAncestorHas(node, root, (r) =>
      Object.keys(r).some((k) => k.startsWith('LogicStep_SerialContainer'))),
    drive: registry.getByPath<RVDrive>('Drive', nodePath),
  };
}

/** `Drive_1` → `Drive`; leaves non-suffixed keys untouched. */
function stripDedupSuffix(key: string): string {
  return key.replace(/_\d+$/, '');
}
