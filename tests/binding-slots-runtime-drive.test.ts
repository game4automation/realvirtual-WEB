// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T5 of plan-411 — the BindingManager side of the Phase-1 gap.
 *
 * `resolveBindableSlots()` discovers slots from `userData.realvirtual` and then
 * demands the INSTANCE (`registry.getByPath(componentType, path)`), skipping the
 * component when it is missing. Runtime-attached drive behaviors used to have
 * extras but no instance, so a behavior added in the editor offered no slots
 * and could not be bound until the model was reloaded. No separate code change
 * was expected here — Phase 1 is the fix, this file is the proof.
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import {
  constructComponentOnNode,
  type DriveLifecycleHost,
  type RuntimeNodeDeps,
} from '../src/core/engine/rv-scene-loader';
import { resolveBindableSlots, type ActiveBindableSlot, type BindableSlot } from '../src/core/engine/rv-binding-slot-resolver';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveFollowPosition } from '../src/core/engine/rv-drive-follow-position';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

class FakeDriveHost implements DriveLifecycleHost {
  readonly drives: RVDrive[] = [];
  addDrive(drive: RVDrive): boolean {
    if (this.drives.includes(drive)) return false;
    this.drives.push(drive);
    return true;
  }
  removeDrive(drive: RVDrive): boolean {
    const i = this.drives.indexOf(drive);
    if (i < 0) return false;
    this.drives.splice(i, 1);
    return true;
  }
}

function harness() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const deps: RuntimeNodeDeps = {
    registry, signalStore, scene, transportManager, driveHost: new FakeDriveHost(),
  };
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = {};
  root.add(axis);
  registry.registerNode('Root/Axis', axis);
  return { scene, root, axis, registry, signalStore, deps };
}

/** Narrow away the `unavailable` arm of the union — it carries no componentType. */
function active(slots: readonly BindableSlot[]): ActiveBindableSlot[] {
  return slots.filter((s): s is ActiveBindableSlot => s.kind !== 'unavailable');
}

describe('plan-411 T5 — bindable slots for a runtime-attached drive behavior', () => {
  it('offers the behavior slots without a reload', () => {
    const h = harness();
    constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' });
    const behavior = constructComponentOnNode(
      h.deps, h.axis, 'Drive_FollowPosition', {},
    ) as RVDriveFollowPosition;
    expect(behavior).toBeInstanceOf(RVDriveFollowPosition);

    const own = active(resolveBindableSlots(h.root, h.signalStore, h.registry))
      .filter((s) => s.componentType === 'Drive_FollowPosition');

    expect(own.length).toBeGreaterThan(0);
    expect(own.map((s) => s.slot)).toContain('Position');
    // Every slot points at the LIVE instance — that is what the binding manager
    // writes through, and what was missing before Phase 1.
    for (const slot of own) expect(slot.instance).toBe(behavior);
  });

  it('the Position slot binds and actually reaches the drive', () => {
    const h = harness();
    const drive = constructComponentOnNode(h.deps, h.axis, 'Drive', {
      Direction: 'LinearX',
    }) as RVDrive;
    constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {});

    const position = active(resolveBindableSlots(h.root, h.signalStore, h.registry)).find(
      (s) => s.componentType === 'Drive_FollowPosition' && s.slot === 'Position',
    );
    expect(position).toBeDefined();
    // An unwired behavior exposes the DIRECT command contract (plan-325), which
    // is exactly what makes it bindable without a GLB-authored signal.
    expect(position!.kind).toBe('direct-property');

    (position as unknown as { command: (v: number) => void }).command(120);
    drive.update(1 / 60);

    expect(drive.currentPosition).toBeCloseTo(120, 3);
  });

  it('the slots disappear again when the behavior is removed', async () => {
    const { removeDriveComponentFromNode } = await import('../src/core/engine/rv-scene-loader');
    const h = harness();
    constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' });
    constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {});
    // The extras stamp goes with it, exactly as the executor's remove does.
    removeDriveComponentFromNode(h.deps, 'Root/Axis', 'Drive_FollowPosition');
    delete (h.axis.userData.realvirtual as Record<string, unknown>)['Drive_FollowPosition'];

    const slots = active(resolveBindableSlots(h.root, h.signalStore, h.registry));
    expect(slots.filter((s) => s.componentType === 'Drive_FollowPosition')).toHaveLength(0);
  });
});

// ─── Authored signal-slot values (editor.addComponent / editor.setField) ──

describe.runIf(__RV_HAS_PRIVATE__)('signal slots: authored values are normalised to ComponentReference (private)', () => {
  type Ctx = ReturnType<typeof normalizeCtx>;
  function normalizeCtx(h: ReturnType<typeof harness>, added: Array<Record<string, unknown>>) {
    return {
      doc: {
        lockOwner: null,
        addComponent: (_p: string, t: string, fields: Record<string, unknown>) => { added.push(fields); return t; },
        whenIdle: async () => {},
        withTransaction: async (_l: string, fn: () => Promise<void>) => fn(),
      },
      viewer: { registry: h.registry, currentModelRoot: h.root },
      selection: [],
    };
  }
  async function addImpl() {
    const { impls } = await import('@rv-private/plugins/asset-editor/editor-commands');
    return impls['editor.addComponent'] as unknown as {
      run(ctx: Ctx, a: { path: string; type: string; propsJson?: string }): Promise<Record<string, unknown>>;
    };
  }

  it('a {path} object without type and a bare signal path become typed references; the drive moves', async () => {
    const { addSignal } = await import('../src/core/engine/rv-signal-construction');
    const h = harness();
    const drive = constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX', TargetSpeed: 100 }) as RVDrive;
    const fwd = addSignal(h.axis, 'Fwd', 'PLCOutputBool', h.signalStore, h.registry);
    const bwd = addSignal(h.axis, 'Bwd', 'PLCOutputBool', h.signalStore, h.registry);
    const added: Array<Record<string, unknown>> = [];
    const impl = await addImpl();
    await impl.run(normalizeCtx(h, added), {
      path: 'Root/Axis', type: 'Drive_Simple', propsJson: JSON.stringify({ Forward: { path: fwd.path }, Backward: bwd.path }),
    });
    const fields = added[0]!;
    expect(fields['Forward']).toEqual({ type: 'ComponentReference', path: fwd.path, componentType: 'PLCOutputBool' });
    // A typed reference to a real signal passes unchanged.
    const typed = { type: 'ComponentReference', path: fwd.path, componentType: 'PLCOutputBool' };
    await impl.run(normalizeCtx(h, added), { path: 'Root/Axis', type: 'Drive_Simple', propsJson: JSON.stringify({ Forward: typed }) });
    expect(added[1]!['Forward']).toEqual(typed);
    expect(fields['Backward']).toEqual({ type: 'ComponentReference', path: bwd.path, componentType: 'PLCOutputBool' });

    constructComponentOnNode(h.deps, h.axis, 'Drive_Simple', fields);
    h.signalStore.set(fwd.name, true);
    for (let i = 0; i < 30; i++) drive.update(1 / 60);
    expect(drive.currentPosition).toBeGreaterThan(0);
  });

  it('malformed shapes, unresolved paths and non-signal nodes are refused with a field-specific error', async () => {
    const h = harness();
    constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' });
    const impl = await addImpl();
    const run = (props: Record<string, unknown>) => impl.run(normalizeCtx(h, []), {
      path: 'Root/Axis', type: 'Drive_Simple', propsJson: JSON.stringify(props),
    });
    await expect(run({ Forward: { type: 'Signal', path: 'Root/Axis' } })).rejects.toThrow(/Drive_Simple\.Forward .*"type" must be "ComponentReference"/);
    await expect(run({ Forward: { address: 'x' } })).rejects.toThrow(/Drive_Simple\.Forward .*no "path"/);
    await expect(run({ Forward: 42 })).rejects.toThrow(/Drive_Simple\.Forward .*got number/);
    await expect(run({ Forward: 'Root/Nope' })).rejects.toThrow(/Drive_Simple\.Forward .*no node at "Root\/Nope"/);
    await expect(run({ Forward: 'Root/Axis' })).rejects.toThrow(/is not a signal node/);
    // Typed references are checked too: an empty path, or a resolving non-signal node.
    // One that does not resolve yet stays legal (plan-769 unresolvedPath contract).
    await expect(run({ Forward: { type: 'ComponentReference', path: '' } })).rejects.toThrow(/empty "path"/);
    await expect(run({ Forward: { type: 'ComponentReference' } })).rejects.toThrow(/names no target/);
    await expect(run({ Forward: { type: 'ComponentReference', path: 'Later/Signal' } })).resolves.toBeTruthy();
    // A PLC node that is not a signal (a PLC program) does not qualify.
    const program = new Object3D();
    program.name = 'Program';
    program.userData.realvirtual = { PLCProgram: {} };
    h.root.add(program);
    h.registry.registerNode('Root/Program', program);
    await expect(run({ Forward: 'Root/Program' })).rejects.toThrow(/is not a signal node/);
    await expect(run({ Forward: { type: 'ComponentReference', path: 'Root/Program' } })).rejects.toThrow(/is not a signal node/);
    // Clearing stays allowed.
    await expect(run({ Forward: null })).resolves.toBeTruthy();
  });
});
