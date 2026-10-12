// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-598 §9.9 — `prefetchPrivateFeatures()` starts the feature imports early,
 * `registerPrivatePlugins(viewer, mods)` registers them later in the old order.
 *
 * Covered here (browser): the runtime helpers every entry shares
 * (`src/core/rv-private-features.ts`), the community stub's contract, the
 * registration-order snapshot of the checked-in private entry, and the
 * idempotent smooth-motion init. The generated customer entry and the
 * manifest/entry agreement are node tests
 * (`tests/private-features-prefetch.node.test.ts`).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  registerPrivateFeature,
  startPrivateFeatureImports,
  type PrivateFeatureModule,
} from '../src/core/rv-private-features';
import * as stub from '../src/private-stubs/private-plugins';
import type { RVViewer } from '../src/core/rv-viewer';

const viewer = {} as RVViewer;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeModule(log: string[], name: string, prefetch?: () => void): PrivateFeatureModule {
  return { register: async () => { log.push(`register:${name}`); }, ...(prefetch ? { prefetch } : {}) };
}

describe('startPrivateFeatureImports — starts every import, registers nothing', () => {
  it('calls every loader synchronously and never calls register', async () => {
    const log: string[] = [];
    const loaders = ['a', 'b', 'c'].map((n) => [n, vi.fn(async () => fakeModule(log, n))] as const);
    const mods = startPrivateFeatureImports(loaders);
    for (const [, load] of loaders) expect(load).toHaveBeenCalledTimes(1);
    await flush();
    expect(log).toEqual([]);
    expect([...mods.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('runs a module prefetch hook once, as soon as the module arrives', async () => {
    const hook = vi.fn();
    startPrivateFeatureImports([['wasm', async () => fakeModule([], 'wasm', hook)]]);
    await flush();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('a failing chunk is not an unhandled rejection; the register pass reports it and goes on', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => { unhandled.push(e.reason); e.preventDefault(); };
    window.addEventListener('unhandledrejection', onUnhandled);
    const log: string[] = [];
    const mods = startPrivateFeatureImports([
      ['broken', () => Promise.reject(new Error('chunk 404'))],
      ['fine', async () => fakeModule(log, 'fine')],
    ]);
    await flush(); await flush();
    expect(unhandled).toEqual([]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await registerPrivateFeature(viewer, 'broken', () => Promise.reject(new Error('unused')), mods);
    await registerPrivateFeature(viewer, 'fine', async () => fakeModule(log, 'NOT-prefetched'), mods);
    expect(err).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['register:fine']);
    err.mockRestore();
    window.removeEventListener('unhandledrejection', onUnhandled);
  });
});

describe('registerPrivateFeature — prefetched where possible, in the caller\'s order', () => {
  it('uses the prefetched module instead of importing again, and keeps the call order', async () => {
    const log: string[] = [];
    // Arrival order deliberately reversed: c arrives first, a last.
    const later = (ms: number, n: string) => () => new Promise<PrivateFeatureModule>((r) => setTimeout(() => r(fakeModule(log, n)), ms));
    const mods = startPrivateFeatureImports([['a', later(30, 'a')], ['c', later(0, 'c')]]);
    const freshB = vi.fn(async () => fakeModule(log, 'b'));
    const notCalled = vi.fn(async () => fakeModule(log, 'WRONG'));
    await registerPrivateFeature(viewer, 'a', notCalled, mods);
    await registerPrivateFeature(viewer, 'b', freshB, mods); // not prefetched (load side effects)
    await registerPrivateFeature(viewer, 'c', notCalled, mods);
    expect(log).toEqual(['register:a', 'register:b', 'register:c']);
    expect(notCalled).not.toHaveBeenCalled();
    expect(freshB).toHaveBeenCalledTimes(1);
  });
});

describe('community stub — same contract, nothing to do', () => {
  it('exports prefetchPrivateFeatures (empty) and registerPrivatePlugins(viewer, mods)', async () => {
    const mods = stub.prefetchPrivateFeatures();
    expect(mods.size).toBe(0);
    await expect(stub.registerPrivatePlugins(viewer, mods)).resolves.toBeUndefined();
  });
});

// ── Private sibling (skipped in a community clone) ─────────────────────────
const privateEntry = import.meta.glob('../../realvirtual-WebViewer-Private~/src/private-plugins.ts', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;
const privateSource = Object.values(privateEntry)[0] ?? null;

describe.skipIf(privateSource === null)('checked-in private entry', () => {
  it('registers in the same order as before plan-598 (snapshot)', () => {
    const customer = privateSource!.split(/if\s*\(\s*__RV_INTERNAL__\s*\)/)[0]!;
    const order = [...customer.matchAll(/await useFeature\(viewer, '([^']+)'/g)].map((m) => m[1]);
    expect(order).toEqual([
      'asset-editor', 'diagnostics', 'step-import', 'jt-import', 'usd-import', 'fbx-import',
      'onshape-import', 'asset-manager-import', 'ik-solver', 'smooth-motion', 'kinematic-mechanism',
      'machining', 'des', 'plc', 'physics', 'feature-matrix', 'cinematic-render', 'video-record-ui',
      'share-decrypt',
    ]);
    // Every registration hands on the prefetched imports.
    expect(customer.match(/await useFeature\(viewer, '[^']+', \(\) => import\('[^']+'\), mods\);/g)?.length)
      .toBe(order.length);
  });

  it('smooth-motion init is explicit and idempotent (a second start is a no-op)', async () => {
    const mods = import.meta.glob('../../realvirtual-WebViewer-Private~/src/features/smooth-motion.register.ts');
    const load = Object.values(mods)[0]!;
    const sm = await load() as { startSmoothMotionInit: () => Promise<boolean>; prefetch: () => void };
    const { smoothMotionRegistry } = await import('../src/core/engine/rv-smooth-motion-port');
    smoothMotionRegistry.reset();
    const first = sm.startSmoothMotionInit();
    expect(smoothMotionRegistry.state).toBe('pending'); // expect() ran synchronously
    expect(sm.startSmoothMotionInit()).toBe(first);
    sm.prefetch();
    expect(sm.startSmoothMotionInit()).toBe(first);
    await first;
    expect(sm.startSmoothMotionInit()).toBe(first);
    smoothMotionRegistry.reset();
  });
});
