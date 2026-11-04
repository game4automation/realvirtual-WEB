// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-645 9.3 (E9) — the runner's ONE scene teardown: `dispose()` and
// `rebindScene()` run every scene instance's `scene.dispose()` handle exactly
// once; `onDispose` keeps working (D2). Before plan-645 `dispose()` never
// released the bind contexts of scene-discovered instances.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { resetWorld, startLine, newRunner, line, lineDefs } from './des-lifecycle-line';

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWorld();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { infoSpy.mockRestore(); });

/** Count `scene.dispose()` calls per bound instance (wraps addInstance). */
function countSceneDisposes(runner: DESRunner): { disposes: Map<string, number>; bound: () => number } {
  const disposes = new Map<string, number>();
  let bound = 0;
  const orig = runner.addInstance.bind(runner);
  runner.addInstance = ((def, self, node, scene) => {
    if (scene) {
      bound++;
      const key = `${node.name}#${bound}`;
      disposes.set(key, 0);
      const inner = scene.dispose;
      scene = { ...scene, dispose: () => { disposes.set(key, (disposes.get(key) ?? 0) + 1); inner(); } };
    }
    return orig(def, self, node, scene);
  }) as DESRunner['addInstance'];
  return { disposes, bound: () => bound };
}

describe('plan-645 9.3 — runner dispose (E9)', () => {
  it('dispose() runs every scene binding dispose exactly once; a second dispose adds nothing', () => {
    const runner = newRunner();
    const c = countSceneDisposes(runner);
    const l = line();
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    expect(c.bound()).toBe(4);
    runner.dispose();
    expect([...c.disposes.values()]).toEqual([1, 1, 1, 1]);
    runner.dispose();
    expect([...c.disposes.values()], 'idempotent').toEqual([1, 1, 1, 1]);
  });

  it('rebindScene() disposes the old bindings once; dispose() then the new ones once', () => {
    const runner = newRunner();
    const c = countSceneDisposes(runner);
    const l = line();
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    runner.rebindScene();
    expect(c.bound(), 'four bound, four rebound').toBe(8);
    const values = (): number[] => [...c.disposes.values()];
    expect(values().slice(0, 4), 'old bindings disposed by the rebind').toEqual([1, 1, 1, 1]);
    expect(values().slice(4), 'new bindings live').toEqual([0, 0, 0, 0]);
    runner.dispose();
    expect(values(), 'each binding exactly once in total').toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('the bind contexts release their signal-store subscriptions', () => {
    const l = line();
    const before = countStoreListeners(l.store);
    const runner = newRunner();
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    runner.dispose();
    expect(countStoreListeners(l.store), 'no subscription survives the dispose').toBe(before);
  });

  it('onDispose callbacks still run once (D2)', () => {
    const { runner } = startLine();
    const cb = vi.fn();
    runner.onDispose(cb);
    runner.dispose();
    runner.dispose();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

/** Subscriber count of a SignalStore (its per-name listener sets). */
function countStoreListeners(store: unknown): number {
  const map = (store as { listeners: Map<string, Set<unknown>> }).listeners;
  let n = 0;
  for (const set of map.values()) n += set.size;
  return n;
}
