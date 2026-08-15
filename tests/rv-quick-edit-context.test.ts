// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * computeQuickEditContext tests — the Kinematics window's selection analysis
 * (the web port of Unity QuickEditContext/QuickEditVisibility): component
 * flags, signal rebase onto the parent, and ancestor walks.
 */
import { describe, it, expect } from 'vitest';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import type { SelectionSnapshot } from '../src/core/engine/rv-selection-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { computeQuickEditContext } from '@rv-private/plugins/asset-editor/kinematics/quick-edit-context';

function makeViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  };
  const viewer = {
    registry,
    get currentModelRoot() { return model; },
  } as unknown as RVViewer;
  return { viewer, model, register };
}

function child(parent: Object3D, name: string, rv?: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  if (rv) node.userData.realvirtual = rv;
  parent.add(node);
  return node;
}

function sel(...paths: string[]): SelectionSnapshot {
  return { selectedPaths: paths, primaryPath: paths[paths.length - 1] ?? null };
}

describe('computeQuickEditContext', () => {
  it('returns the empty context without a selection', () => {
    const { viewer, register } = makeViewer();
    register();
    const qe = computeQuickEditContext(viewer, sel());
    expect(qe.hasSelection).toBe(false);
    expect(qe.node).toBeNull();
  });

  it('detects components on the selected node (dedup-suffix tolerant)', () => {
    const { viewer, model, register } = makeViewer();
    child(model, 'Axis', {
      Drive: { Direction: 'LinearX' },
      Drive_Simple: {},
      Sensor_1: {},
      Group: { GroupName: 'Axis1' },
    });
    register();
    const qe = computeQuickEditContext(viewer, sel('Asset/Axis'));
    expect(qe.hasSelection).toBe(true);
    expect(qe.isSingle).toBe(true);
    expect(qe.hasDrive).toBe(true);
    expect(qe.hasSensor).toBe(true);
    expect(qe.hasKinematic).toBe(false);
    expect(qe.existingDriveBehaviors.has('Drive_Simple')).toBe(true);
    expect(qe.hasOtherRvComponents).toBe(true);
  });

  it('rebases a selected signal node onto its parent (Unity parity)', () => {
    const { viewer, model, register } = makeViewer();
    const axis = child(model, 'Axis', { Drive: { Direction: 'LinearX' } });
    child(axis, 'PLCOutputBool', { PLCOutputBool: { Status: { Value: false } } });
    register();
    const qe = computeQuickEditContext(viewer, sel('Asset/Axis/PLCOutputBool'));
    expect(qe.hasSignal).toBe(true);
    expect(qe.signalType).toBe('PLCOutputBool');
    expect(qe.signalNodePath).toBe('Asset/Axis/PLCOutputBool');
    // Context node is the PARENT: its Drive is visible to the rules.
    expect(qe.nodePath).toBe('Asset/Axis');
    expect(qe.hasDrive).toBe(true);
  });

  it('walks ancestors for isUnderTransportSurface / isUnderSerialContainer (self included)', () => {
    const { viewer, model, register } = makeViewer();
    const belt = child(model, 'Belt', { TransportSurface: {} });
    const deep = child(child(belt, 'Mid'), 'Deep');
    const container = child(model, 'Sequence', { LogicStep_SerialContainer: {} });
    const step = child(container, 'Step1', { LogicStep_Delay: { Duration: 1 } });
    void deep; void step;
    register();

    const onBelt = computeQuickEditContext(viewer, sel('Asset/Belt'));
    expect(onBelt.isUnderTransportSurface).toBe(true); // self counts (GetComponentInParent)
    const under = computeQuickEditContext(viewer, sel('Asset/Belt/Mid/Deep'));
    expect(under.isUnderTransportSurface).toBe(true);
    const stepCtx = computeQuickEditContext(viewer, sel('Asset/Sequence/Step1'));
    expect(stepCtx.isUnderSerialContainer).toBe(true);
    expect(stepCtx.hasLogicStep).toBe(true);
    expect(stepCtx.logicStepType).toBe('LogicStep_Delay');
    const plain = computeQuickEditContext(viewer, sel('Asset/Belt'));
    expect(plain.isUnderSerialContainer).toBe(false);
  });

  it('hasOtherRvComponents ignores Hidden, signals and LogicSteps', () => {
    const { viewer, model, register } = makeViewer();
    child(model, 'Plain', { Hidden: true });
    child(model, 'Sig', { PLCInputFloat: { Status: { Value: 0 } } });
    child(model, 'Stepper', { LogicStep_Delay: { Duration: 1 } });
    child(model, 'Comp', { Sensor: {} });
    register();
    expect(computeQuickEditContext(viewer, sel('Asset/Plain')).hasOtherRvComponents).toBe(false);
    // 'Sig' rebases to the model root — check the root has no components.
    expect(computeQuickEditContext(viewer, sel('Asset/Stepper')).hasOtherRvComponents).toBe(false);
    expect(computeQuickEditContext(viewer, sel('Asset/Comp')).hasOtherRvComponents).toBe(true);
  });
});
