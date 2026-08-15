// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T4 of plan-411 — `NodeRegistry.resolve()` resolves ANY registered type.
 *
 * Before this, `resolve()` branched on Drive / Sensor / signal / Transform and
 * every other known type fell out as `{}` — which `resolveComponentRefs()`
 * flattens to `null` for a SCALAR field. That is why plan-404 had to keep the
 * raw `Mechanism` path in a component-local `mechanismRefPath` workaround.
 *
 * Two contracts are asserted side by side, because they pull in opposite
 * directions and both matter:
 *   - a registered type at a resolvable path now yields the INSTANCE
 *   - a MISS still falls through to the raw-path pass-through, so the late
 *     resolvers (`MachiningVolume.Tools`, DES refs) keep working
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { resolveComponentRefs } from '../src/core/engine/rv-component-registry';

function ref(path: string, componentType?: unknown): ComponentRef {
  return { type: 'ComponentReference', path, componentType } as ComponentRef;
}

describe('plan-411 T4 — generic component resolution', () => {
  let registry: NodeRegistry;
  let mechanism: { id: string };
  let target: Object3D;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Root';
    scene.add(root);
    target = new Object3D();
    target.name = 'Mechanism';
    root.add(target);
    registry = new NodeRegistry();
    registry.registerNode('Root', root);
    registry.registerNode('Root/Mechanism', target);
    mechanism = { id: 'mech' };
    registry.register('KinematicMechanism', 'Root/Mechanism', mechanism);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  it('resolves a namespaced componentType to the registered instance', () => {
    const res = registry.resolve(ref('Root/Mechanism', 'realvirtual.KinematicMechanism'));
    expect(res.component).toBe(mechanism);
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves the bare spelling identically', () => {
    expect(registry.resolve(ref('Root/Mechanism', 'KinematicMechanism')).component).toBe(mechanism);
  });

  it('resolves through a path ALIAS (kinematic re-parenting)', () => {
    const moved = new Object3D();
    moved.name = 'Deep';
    registry.registerNode('Root/Group/Deep', moved);
    registry.register('KinematicMechanism', 'Root/Group/Deep', { id: 'deep' });
    registry.registerAlias('Root/Deep', moved);

    const res = registry.resolve(ref('Root/Deep', 'realvirtual.KinematicMechanism'));
    expect((res.component as { id: string }).id).toBe('deep');
  });

  it('resolves through the SCOPE fallback when every path lookup misses', () => {
    const scopeRoot = new Object3D();
    scopeRoot.name = 'Placed';
    const inner = new Object3D();
    inner.name = 'Mech2';
    scopeRoot.add(inner);
    registry.registerNode('Placed/Mech2', inner);
    const scoped = { id: 'scoped' };
    registry.register('KinematicMechanism', 'Placed/Mech2', scoped);

    // The AUTHORED path no longer exists; only the name still matches.
    const res = registry.resolve(ref('Authoring/Root/Mech2', 'realvirtual.KinematicMechanism'), scopeRoot);
    expect(res.component).toBe(scoped);
  });

  it('assigns a SCALAR reference field the instance instead of null', () => {
    const instance: Record<string, unknown> = {
      Mechanism: ref('Root/Mechanism', 'realvirtual.KinematicMechanism'),
      Untouched: 7,
    };
    resolveComponentRefs(instance, registry);
    expect(instance.Mechanism).toBe(mechanism);
    expect(instance.Untouched).toBe(7);
  });

  it('assigns ARRAY reference elements the instances', () => {
    const second = { id: 'second' };
    const other = new Object3D();
    other.name = 'Mechanism2';
    registry.registerNode('Root/Mechanism2', other);
    registry.register('KinematicMechanism', 'Root/Mechanism2', second);

    const instance: Record<string, unknown> = {
      Mechanisms: [
        ref('Root/Mechanism', 'realvirtual.KinematicMechanism'),
        ref('Root/Mechanism2', 'realvirtual.KinematicMechanism'),
      ],
    };
    resolveComponentRefs(instance, registry);
    expect(instance.Mechanisms).toEqual([mechanism, second]);
  });

  it('a registered type at a NON-EXISTENT path: null for a scalar, raw path in an array', () => {
    const scalar: Record<string, unknown> = {
      Mechanism: ref('Root/Nowhere', 'realvirtual.KinematicMechanism'),
    };
    resolveComponentRefs(scalar, registry);
    expect(scalar.Mechanism).toBeNull();

    // The array side keeps the path on purpose — `MachiningVolume.Tools` and the
    // DES references resolve LATE, when the target may finally exist. Turning
    // the miss into a hard null here would break that contract.
    const array: Record<string, unknown> = {
      Tools: [ref('Root/Nowhere', 'realvirtual.KinematicMechanism')],
    };
    resolveComponentRefs(array, registry);
    expect(array.Tools).toEqual(['Root/Nowhere']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('KinematicMechanism not found'));
  });

  it('leaves the Drive, Sensor, Signal and Transform branches untouched', () => {
    const drive = registry.resolve(ref('Root/Mechanism', 'realvirtual.Drive'));
    expect('drive' in drive).toBe(true);
    expect(drive.component).toBeUndefined();

    const sensor = registry.resolve(ref('Root/Mechanism', 'realvirtual.Sensor'));
    expect('sensor' in sensor).toBe(true);
    expect(sensor.component).toBeUndefined();

    const signal = registry.resolve(ref('Root/Mechanism', 'realvirtual.PLCOutputBool'));
    expect(signal.signalAddress).toBe('Root/Mechanism');
    expect(signal.component).toBeUndefined();

    const node = registry.resolve(ref('Root/Mechanism', 'UnityEngine.Transform'));
    expect(node.node).toBe(target);
    expect(node.component).toBeUndefined();
  });

  it('still flags a componentType nothing in the scene carries', () => {
    const res = registry.resolve(ref('Root/Mechanism', 'realvirtual.SomeFutureComponent'));
    expect(res).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown componentType: "realvirtual.SomeFutureComponent"'),
    );
  });
});

describe('plan-411 T4 — KinematicTarget after the workaround rollback', () => {
  it('gets its Mechanism through the ordinary componentRef path, alias included', async () => {
    const { RVKinematicMechanism, RVKinematicTarget } =
      await import('@rv-private/kinematic-mechanism/rv-kinematic-mechanism');

    const registry = new NodeRegistry();
    const root = new Object3D();
    root.name = 'Root';
    const mechNode = new Object3D();
    mechNode.name = 'Mech';
    root.add(mechNode);
    registry.registerNode('Root', root);
    registry.registerNode('Root/Axes/Mech', mechNode);
    // The kinematic re-parent alias the loader registers in Phase 8c.
    registry.registerAlias('Root/Mech', mechNode);

    const mech = new RVKinematicMechanism(mechNode);
    registry.register('KinematicMechanism', 'Root/Axes/Mech', mech);

    const targetNode = new Object3D();
    targetNode.name = 'Target';
    root.add(targetNode);
    registry.registerNode('Root/Target', targetNode);

    const target = new RVKinematicTarget(targetNode);
    const targetInstance = target as unknown as Record<string, unknown>;
    // Exactly what applySchema leaves behind for the `Mechanism` componentRef,
    // written with the AUTHORED (aliased) path.
    targetInstance.Mechanism = ref('Root/Mech', 'realvirtual.KinematicMechanism');
    resolveComponentRefs(targetInstance, registry);

    expect(targetInstance.Mechanism).toBe(mech);
    expect(target.mechanism).toBe(mech);
  });
});
