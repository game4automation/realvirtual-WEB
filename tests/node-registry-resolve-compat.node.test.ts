// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-614 F4 — `NodeRegistry.resolve()` hands out what it handed out in
 * 452703ed (before plan-610 split it into `_resolveChain` + `resolveWithStage`).
 *
 * F4: a typed instance registered at a path WITHOUT a `nodes` entry. 452703ed's
 * `getByPath` returned it and `resolve` delivered it — no later stage was asked.
 * The plan-610 chain demanded a node for that hit and fell through (to the scoped
 * name fallback or to a miss). `resolve` delivers the instance again;
 * `resolveWithStage` has no node to report there and says so with `null`.
 *
 * Checked in both directions for drive, sensor and the generic component branch:
 * with a node entry, without one, and a plain miss — each with a type-true result.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

function n(name: string, parent?: Object3D): Object3D {
  const o = new Object3D();
  o.name = name;
  parent?.add(o);
  return o;
}

function registerAll(registry: NodeRegistry, root: Object3D): void {
  root.traverse((o) => { if (o.parent) registry.registerNode(NodeRegistry.computeNodePath(o), o); });
}

const ref = (path: string, componentType: string) => ({ type: 'ComponentReference' as const, path, componentType });

/** The three typed branches of `resolve`, with the key each one answers under. */
const KINDS = [
  { label: 'drive', type: 'Drive', componentType: 'realvirtual.Drive', key: 'drive' },
  { label: 'sensor', type: 'Sensor', componentType: 'realvirtual.Sensor', key: 'sensor' },
  { label: 'generic component', type: 'MachiningTool', componentType: 'realvirtual.MachiningTool', key: 'component' },
] as const;

function station() {
  const world = new Object3D();
  const root = n('Station', world);
  const mount = n('Mount', root);
  const kine = n('Kine', mount);
  const registry = new NodeRegistry();
  registerAll(registry, world);
  registry.registerScopeNames(root, ['Machine']);
  return { world, root, kine, registry };
}

describe('NodeRegistry.resolve — 452703ed compatibility (plan-614 F4)', () => {
  let warn: MockInstance;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  for (const k of KINDS) {
    describe(k.label, () => {
      it('(a) an instance WITH a node entry is delivered, and resolveWithStage names its node', () => {
        const { registry, root, kine } = station();
        const inst = { kind: `${k.label}-on-node` };
        registry.register(k.type, 'Station/Mount/Kine', inst);

        expect(registry.resolve(ref('Station/Mount/Kine', k.componentType))).toEqual({ [k.key]: inst });
        expect(registry.resolve(ref('Mount/Kine', k.componentType), root)).toEqual({ [k.key]: inst });
        expect(registry.resolveWithStage({ path: 'Station/Mount/Kine' }, k.type, null))
          .toMatchObject({ node: kine, stage: 'exact' });
        expect(registry.resolveWithStage({ path: 'Mount/Kine' }, k.type, root))
          .toMatchObject({ node: kine, stage: 'exact', spelling: 'relative', scopeRootPath: 'Station' });
        expect(warn).not.toHaveBeenCalled();
      });

      it('(b) an instance WITHOUT a node entry is delivered too — same shape, never null', () => {
        const { registry } = station();
        const inst = { kind: `${k.label}-virtual` };
        registry.register(k.type, 'Virtual/Axis', inst);
        expect(registry.getNode('Virtual/Axis')).toBeNull();

        const result = registry.resolve(ref('Virtual/Axis', k.componentType));
        expect(result).toEqual({ [k.key]: inst });
        expect(warn).not.toHaveBeenCalled();
      });

      it('(b) the node-less instance wins over a same-named node in scope — no later stage is consulted', () => {
        const { registry, root } = station();
        const decoyNode = n('Axis', root);
        registry.registerNode('Station/Axis', decoyNode);
        const decoy = { kind: `${k.label}-decoy` };
        registry.register(k.type, 'Station/Axis', decoy);
        const inst = { kind: `${k.label}-virtual` };
        registry.register(k.type, 'Virtual/Axis', inst);

        // Scoped: the scoped resolver misses (`Station/Virtual/Axis` does not
        // exist, `Virtual` is no root name), the exact path names the node-less
        // instance, and the name fallback (`Axis` under the scope) must not run.
        expect(registry.resolve(ref('Virtual/Axis', k.componentType), root)).toEqual({ [k.key]: inst });
        expect(warn).not.toHaveBeenCalled();
      });

      it('(c) resolveWithStage reports the node-less hit as null, without throwing', () => {
        const { registry, root } = station();
        registry.register(k.type, 'Virtual/Axis', { kind: `${k.label}-virtual` });

        expect(() => registry.resolveWithStage({ path: 'Virtual/Axis' }, k.type, null)).not.toThrow();
        expect(registry.resolveWithStage({ path: 'Virtual/Axis' }, k.type, null)).toBeNull();
        expect(registry.resolveWithStage({ path: 'Virtual/Axis' }, k.type, root)).toBeNull();
        expect(warn).not.toHaveBeenCalled();
      });

      it('(d) a plain miss stays a miss, with a type-true result', () => {
        const { registry, root } = station();
        // Make the type known (the generic branch only exists for known types).
        registry.register(k.type, 'Station/Mount/Kine', { kind: `${k.label}-other` });

        const unscoped = registry.resolve(ref('Nowhere/Missing', k.componentType));
        const scoped = registry.resolve(ref('Nowhere/Missing', k.componentType), root);
        if (k.key === 'component') {
          // Generic branch: a miss is the raw-path pass-through (`{}`), never `{ component: null }`.
          expect(unscoped).toEqual({});
          expect(scoped).toEqual({});
        } else {
          expect(unscoped).toEqual({ [k.key]: null });
          expect(scoped).toEqual({ [k.key]: null });
        }
        expect(warn).toHaveBeenCalledTimes(2);
        expect(registry.resolveWithStage({ path: 'Nowhere/Missing' }, k.type, null)).toBeNull();
        expect(registry.resolveWithStage({ path: 'Nowhere/Missing' }, k.type, root)).toBeNull();
      });
    });
  }
});
