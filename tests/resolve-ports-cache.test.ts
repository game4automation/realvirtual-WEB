// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * resolve-ports-cache.test.ts — plan-644 § 9.2 (the DES port cache, E7).
 *
 * `resolvePorts` memoises the partner transport surfaces under a
 * `PortResolveCacheScope` — only with `mode === 'des'` AND an injected scope.
 * The roles are still computed per call. The subtree traversal is counted at
 * `findInChildren` of the component registry: `surfacesFromComponentRegistry`
 * calls it once per `Transport-*` node it finds under a partner root, so the
 * count rises exactly when a partner subtree is traversed (the ES-module
 * `findAll` itself cannot be spied in browser mode).
 *
 *   a) 1000 outputs(): traversal only on the first call per partner root; ports
 *      field-equal to an uncached reference;
 *   b) a partner root turned by 180°: the role flips on the next call, as uncached;
 *   c) pair / markFree / unregister / a swapped registry: next call = uncached result;
 *   d) continuous mode, or DES without a scope: no cache — also on the same host
 *      a DES self used before;
 *   e) the runner raises the generation on start / reset / rebindScene with the
 *      SAME registry, and the first query after it traverses again;
 *   f) a surface added during a run without registry mutation: visible from the
 *      next generation on (the documented contract limit).
 *
 * Runs are bounded by events / sim time. Part e imports
 * `@rv/plugins/des/*` (DES is core code since plan-680).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Quaternion, Scene, Vector3 } from 'three';
import { createBindContext, type BindContextHost, type KinematicsSpec } from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  createSelf,
  resolvePorts,
  type Port,
  type PortResolveCacheScope,
} from '../src/core/material-flow/material-flow-self';
import {
  attachHeadlessConnectionRegistry,
  detachHeadlessConnectionRegistry,
} from '../src/core/connect/rv-connection-registry';
import type { SnapPointRegistry } from '../src/core/engine/rv-snap-point-registry';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { ConveyorFlow } from '../src/behaviors/Conveyor';
import {
  _resetMaterialFlowRegistry,
  registerMaterialFlow,
} from '../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../src/core/material-flow/define-material-flow';

// ─── Fixture: a conveyor chain C0 → C1 → C2 → C3 along +X ────────────────

const _q = new Quaternion();

/** A transport surface reading its node's CURRENT world orientation (+X local = travel). */
function surfaceOf(node: Object3D): { getWorldDirection(out?: Vector3): Vector3 } {
  return {
    getWorldDirection(out = new Vector3()): Vector3 {
      node.updateWorldMatrix(true, false);
      return out.set(1, 0, 0).applyQuaternion(node.getWorldQuaternion(_q));
    },
  };
}

interface Chain {
  scene: Scene;
  roots: Object3D[];
  host: BindContextHost;
  registry: SnapPointRegistry;
  /** findInChildren calls = partner-subtree traversals that found a surface. */
  traversals: () => number;
}

function chain(withSurfaceOn: (i: number) => boolean = () => true): Chain {
  const scene = new Scene();
  const roots: Object3D[] = [];
  for (let i = 0; i < 4; i++) {
    const r = new Object3D();
    r.name = `C${i}`;
    r.position.set(i, 0, 0);
    scene.add(r);
    if (withSurfaceOn(i)) {
      const t = new Object3D(); t.name = 'Transport-X'; r.add(t);
    }
    const sIn = new Object3D(); sIn.name = 'Snap-XN-conv'; sIn.position.set(-0.5, 0, 0); r.add(sIn);
    const sOut = new Object3D(); sOut.name = 'Snap-XP-conv'; sOut.position.set(0.5, 0, 0); r.add(sOut);
    roots.push(r);
  }
  scene.updateMatrixWorld(true);
  let calls = 0;
  const compReg = {
    findInChildren<T>(node: Object3D, type: string): T | null {
      if (type !== 'TransportSurface') return null;
      calls++;
      return surfaceOf(node) as unknown as T;
    },
  };
  const events = new EventEmitter<Record<string, unknown>>();
  const host = {
    signalStore: new SignalStore(),
    on: (e: string, cb: (...args: unknown[]) => void) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: compReg,
    getPlugin: () => undefined,
  } as unknown as BindContextHost;
  const registry = attachHeadlessConnectionRegistry(host, roots);
  return { scene, roots, host, registry, traversals: () => calls };
}

function selfOf(c: Chain, i: number, opts: { mode: 'des' | 'continuous'; portCache?: PortResolveCacheScope | null }) {
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(c.roots[i], c.host, accum);
  const self = createSelf(ctx, { type: 'Conveyor', kind: 'conveyor' }, opts);
  return { ctx, self };
}

/** The fields that make a port (functions excluded). */
const fields = (ports: readonly Port[]): unknown[] => ports.map((p) => ({
  id: p.id, role: p.role, mySnapId: p.mySnapId, partnerSnapId: p.partnerSnapId,
  ownerRoot: p.ownerRoot.name, partnerRoot: p.partnerRoot.name, snapNode: p.snapNode?.name ?? null,
}));

describe('resolvePorts — DES port cache (plan-644 § 9.2)', () => {
  it('a) 1000 outputs(): one traversal per partner root, ports field-equal to the uncached reference', () => {
    const c = chain();
    const scope = { generation: 1 };
    const { ctx, self } = selfOf(c, 1, { mode: 'des', portCache: scope });
    const ref = fields(resolvePorts(ctx)); // uncached reference
    const before = c.traversals();
    let first: unknown[] | null = null;
    for (let k = 0; k < 1000; k++) {
      const out = self.outputs();
      if (k === 0) first = fields(out);
    }
    // C1 has two partners (C0 upstream, C2 downstream), each with one surface.
    expect(c.traversals() - before, 'traversals for 1000 calls').toBe(2);
    expect(first).toEqual(fields(resolvePorts(ctx).filter((p) => p.role === 'output')));
    expect(fields(self.ports as Port[])).toEqual(ref);
    expect(fields(self.inputs())).toEqual(fields(resolvePorts(ctx).filter((p) => p.role === 'input')));
    expect(ref.length).toBe(2);
  });

  it('b) a partner root turned by 180°: the role flips on the next call, exactly as uncached', () => {
    const c = chain();
    const { ctx, self } = selfOf(c, 1, { mode: 'des', portCache: { generation: 1 } });
    const roleToC2 = (ports: readonly Port[]): string | undefined => ports.find((p) => p.ownerRoot === c.roots[2])?.role;
    expect(roleToC2(self.ports as Port[])).toBe('output');
    c.roots[2].quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    c.scene.updateMatrixWorld(true);
    const cached = fields(self.ports as Port[]);
    expect(roleToC2(self.ports as Port[])).toBe('input');
    expect(cached).toEqual(fields(resolvePorts(ctx)));
  });

  it('c) pair / markFree / unregister and a swapped registry: the next call equals the uncached result', () => {
    const c = chain();
    const { ctx, self } = selfOf(c, 1, { mode: 'des', portCache: { generation: 1 } });
    void self.ports;
    const reg = c.registry;
    const outSnap = reg.getByOwnerRoot(c.roots[1]).find((s) => s.object3D.name === 'Snap-XP-conv')!;
    expect(outSnap.pairedSnapId).toBeDefined();
    const partnerId = outSnap.pairedSnapId!;

    reg.markFree(outSnap.id);
    let t0 = c.traversals();
    expect(fields(self.ports as Port[])).toEqual(fields(resolvePorts(ctx)));
    expect(c.traversals(), 'markFree invalidates').toBeGreaterThan(t0);

    reg.pair(outSnap.id, partnerId);
    t0 = c.traversals();
    expect(fields(self.ports as Port[])).toEqual(fields(resolvePorts(ctx)));
    expect(c.traversals(), 'pair invalidates').toBeGreaterThan(t0);

    reg.unregister(partnerId);
    expect(fields(self.ports as Port[])).toEqual(fields(resolvePorts(ctx)));

    // Swap: a rebuilt registry instance (new identity; its version may well be lower).
    detachHeadlessConnectionRegistry(c.host, reg);
    const swapped = attachHeadlessConnectionRegistry(c.host, c.roots);
    expect(swapped).not.toBe(reg);
    t0 = c.traversals();
    const got = fields(self.ports as Port[]);
    expect(c.traversals(), 'registry identity invalidates').toBeGreaterThan(t0);
    expect(got).toEqual(fields(resolvePorts(ctx)));
  });

  it('d) continuous mode, or DES without a scope: no cache — also on a host a DES self used before', () => {
    const c = chain();
    const des = selfOf(c, 1, { mode: 'des', portCache: { generation: 1 } });
    void des.self.ports; // DES cache filled on this host
    for (const opts of [
      { mode: 'continuous' as const, portCache: { generation: 1 } },
      { mode: 'continuous' as const },
      { mode: 'des' as const },
    ]) {
      const { ctx, self } = selfOf(c, 1, opts);
      const t0 = c.traversals();
      for (let k = 0; k < 10; k++) void self.outputs();
      expect(c.traversals() - t0, JSON.stringify(opts)).toBe(20); // 2 partners × 10 calls, as today
      expect(fields(self.ports as Port[])).toEqual(fields(resolvePorts(ctx)));
    }
  });

  it('f) a surface added during the run without a registry mutation: seen from the next generation on', () => {
    // C2 starts WITHOUT a surface → C1's port to C2 takes its role from the authored flow ('out').
    const c = chain((i) => i !== 2);
    const scope = { generation: 1 };
    const { ctx, self } = selfOf(c, 1, { mode: 'des', portCache: scope });
    const roleToC2 = (ports: readonly Port[]): string | undefined => ports.find((p) => p.ownerRoot === c.roots[2])?.role;
    expect(roleToC2(self.ports as Port[])).toBe('output');
    // Add a surface on C2 travelling TOWARD C1 (−X): uncached it reads 'input'.
    const t = new Object3D(); t.name = 'Transport-X';
    t.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    c.roots[2].add(t);
    c.scene.updateMatrixWorld(true);
    expect(roleToC2(resolvePorts(ctx)), 'uncached sees the new surface').toBe('input');
    expect(roleToC2(self.ports as Port[]), 'contract limit: same run, same registry').toBe('output');
    scope.generation++; // what the runner does on start / reset / rebindScene
    expect(roleToC2(self.ports as Port[]), 'next generation').toBe('input');
  });
});

// ─── e) the runner owns the scope ─────────────────────────────────────────


describe('DESRunner.portCacheScope (plan-644 § 9.2 e)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    registerMaterialFlow(ConveyorFlow as unknown as MaterialFlowDefinition);
    _resetDesHookCache();
    resetDESMUCounter();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => { infoSpy.mockRestore(); });

  function boundLine(): { runner: DESRunner; c: Chain } {
    const c = chain();
    // Scene-discovered conveyors (the binding reads `rv_extras`).
    for (const r of c.roots) r.userData.realvirtual = { Conveyor: {}, LayoutObject: { Name: r.name } };
    detachHeadlessConnectionRegistry(c.host, c.registry); // the binding builds its own
    const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: 30, masterSeed: 7 });
    runner.start([ConveyorFlow as unknown as MaterialFlowDefinition], { root: c.scene, host: c.host });
    return { runner, c };
  }

  const conveyor = (runner: DESRunner, name: string) =>
    runner.liveInstances.find((i) => i.self.root.name === name)!;

  it('raises the generation on start, reset and rebindScene; the first query after it traverses again', () => {
    const { runner, c } = boundLine();
    expect(runner.liveInstances.length).toBe(4);
    const g0 = runner.portCacheScope.generation;
    expect(g0).toBeGreaterThan(0);

    const queryCost = (): [number, number] => {
      const inst = conveyor(runner, 'C1');
      const t0 = c.traversals();
      void inst.self.outputs();
      const first = c.traversals() - t0;
      const t1 = c.traversals();
      for (let k = 0; k < 50; k++) void inst.self.outputs();
      return [first, c.traversals() - t1];
    };

    // Within one run repeats never traverse (the first query may, or setup warmed it).
    const [, repeat0] = queryCost();
    expect(repeat0, 'repeats in one run').toBe(0);

    runner.reset();
    expect(runner.portCacheScope.generation).toBeGreaterThan(g0);
    const [, repeat1] = queryCost();
    const g1 = runner.portCacheScope.generation;
    expect(repeat1).toBe(0);

    runner.rebindScene();
    expect(runner.portCacheScope.generation).toBeGreaterThan(g1);
    const [, repeat2] = queryCost();
    expect(repeat2).toBe(0);
    runner.getManager().processUpTo(30, 2000);
    runner.dispose();
  });

  it('a generation bump with the SAME registry re-reads the surfaces (no stale entry)', () => {
    const { runner, c } = boundLine();
    const inst = conveyor(runner, 'C1');
    void inst.self.outputs();
    const t0 = c.traversals();
    void inst.self.outputs();
    expect(c.traversals(), 'warm').toBe(t0);
    (runner.portCacheScope as { generation: number }).generation++;
    void inst.self.outputs();
    expect(c.traversals(), 'after the bump').toBeGreaterThan(t0);
    runner.dispose();
  });
});
