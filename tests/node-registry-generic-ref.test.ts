// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.7 of plan-362 — the Phase-0 core change.
 *
 * `NodeRegistry.resolve()` gained ONE additive branch for plain node
 * references. The point of this file is that the three new cases are checked
 * SEPARATELY, because they are deliberately not the same rule:
 *
 *   componentType 'UnityEngine.Transform'  → resolves (the Unity wire contract)
 *   componentType missing / null / ''      → resolves (legacy tolerance)
 *   componentType non-empty but unknown    → stays UNRESOLVED, as before
 *
 * Treating "unknown" as legacy would silently bend a future reference type onto
 * a node instead of leaving it visibly broken — the distinction Re-Challenge R4
 * forced into the plan.
 */

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { resolveComponentRefs } from '../src/core/engine/rv-component-registry';

function ref(path: string, componentType?: unknown): ComponentRef {
  return { type: 'ComponentReference', path, componentType } as ComponentRef;
}

describe('NodeRegistry.resolve — generic node references', () => {
  let registry: NodeRegistry;
  let target: Object3D;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Root';
    scene.add(root);
    target = new Object3D();
    target.name = 'Slide';
    root.add(target);
    registry = new NodeRegistry();
    registry.registerNode('Root', root);
    registry.registerNode('Root/Slide', target);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('resolves the Unity wire contract componentType', () => {
    const res = registry.resolve(ref('Root/Slide', 'UnityEngine.Transform'));
    expect(res.node).toBe(target);
  });

  it('resolves a legacy ref with a missing, null or empty componentType', () => {
    for (const ct of [undefined, null, '']) {
      const res = registry.resolve(ref('Root/Slide', ct));
      expect(res.node).toBe(target);
    }
  });

  it('leaves a non-empty UNKNOWN componentType unresolved, as before', () => {
    const res = registry.resolve(ref('Root/Slide', 'UnityEngine.Rigidbody'));
    expect(res.node).toBeUndefined();
    expect(res.drive).toBeUndefined();
    expect(res.sensor).toBeUndefined();
    expect(res.signalAddress).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('keeps the Drive, Sensor and Signal branches untouched', () => {
    // Drive / Sensor resolve through their own component registries; with none
    // registered they must report "not found" — NOT fall into the node branch.
    const drive = registry.resolve(ref('Root/Slide', 'realvirtual.Drive'));
    expect('drive' in drive).toBe(true);
    expect(drive.node).toBeUndefined();

    const sensor = registry.resolve(ref('Root/Slide', 'realvirtual.Sensor'));
    expect('sensor' in sensor).toBe(true);
    expect(sensor.node).toBeUndefined();

    const signal = registry.resolve(ref('Root/Slide', 'realvirtual.PLCOutputBool'));
    expect(signal.signalAddress).toBe('Root/Slide');
    expect(signal.node).toBeUndefined();
  });

  // plan-405 live finding F2: Unity writes componentType NAMESPACED
  // (`realvirtual.MachiningTool`), the registry keys components by their bare name.
  // The pass-through itself always worked — `resolveComponentRefs()` keeps the raw
  // path — but every load logged "Unknown componentType" for a type that plainly
  // existed in the scene.
  it('recognises a NAMESPACED componentType of a registered component', () => {
    const tool = { marker: true };
    registry.register('MachiningTool', 'Root/Slide', tool);

    const res = registry.resolve(ref('Root/Slide', 'realvirtual.MachiningTool'));
    // plan-411 §2.2 turned the silent pass-through into a real resolution: a
    // registered type at a resolvable path now comes back as the INSTANCE. The
    // raw-path pass-through survives for a MISS, which is the case the late
    // resolvers (MachiningVolume.Tools, DES refs) actually depend on — see
    // node-registry-generic-resolve.test.ts.
    expect(res.component).toBe(tool);
    expect(warn).not.toHaveBeenCalled();

    // The bare spelling behaves identically — stripping is the only difference.
    registry.resolve(ref('Root/Slide', 'MachiningTool'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('still flags a namespaced componentType nothing in the scene carries', () => {
    registry.resolve(ref('Root/Slide', 'realvirtual.SomeFutureComponent'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown componentType: "realvirtual.SomeFutureComponent"'),
    );
  });

  it('returns nothing at all for a ref without a path', () => {
    expect(registry.resolve(ref('', 'UnityEngine.Transform'))).toEqual({});
    expect(registry.resolve(null)).toEqual({});
  });

  it('reports an unresolvable node ref as null instead of throwing', () => {
    const res = registry.resolve(ref('Root/Missing', 'UnityEngine.Transform'));
    expect(res.node).toBeNull();
  });

  it('resolves through a path alias registered after re-parenting', () => {
    // The loader re-parents kinematic subtrees and then aliases the AUTHORING
    // path, so GLB-serialized references keep working (rv-scene-loader Phase 8c).
    const moved = new Object3D();
    moved.name = 'Carriage';
    registry.registerNode('Root/Axis/Carriage', moved);
    registry.registerAlias('Root/Carriage', moved);
    expect(registry.resolve(ref('Root/Carriage', 'UnityEngine.Transform')).node).toBe(moved);
  });
});

describe('resolveComponentRefs — node refs are not flattened to null', () => {
  it('assigns the resolved node instead of the old silent null', () => {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Root';
    scene.add(root);
    const target = new Object3D();
    target.name = 'Slide';
    root.add(target);
    const registry = new NodeRegistry();
    registry.registerNode('Root', root);
    registry.registerNode('Root/Slide', target);

    const instance: Record<string, unknown> = {
      Follower: ref('Root/Slide', 'UnityEngine.Transform'),
      Anchor: ref('Root', ''),
      Untouched: 42,
    };
    resolveComponentRefs(instance, registry);

    expect(instance.Follower).toBe(target);
    expect(instance.Anchor).toBe(root);
    expect(instance.Untouched).toBe(42);
  });

  it('still nulls a genuinely unresolvable reference', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new NodeRegistry();
    const instance: Record<string, unknown> = {
      Follower: ref('Nowhere', 'UnityEngine.Rigidbody'),
    };
    resolveComponentRefs(instance, registry);
    expect(instance.Follower).toBeNull();
    warn.mockRestore();
  });
});
