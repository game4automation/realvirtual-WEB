// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { sceneWorld } from './continuation-scene-world';

/**
 * plan-2059 O5: a model switch (load -> dispose of the viewer) must not accumulate geometry
 * buffers. Before the fix each AGVDemo cycle kept ~300 MB of ArrayBuffer backing store alive
 * (viewer reachable from a module-level overlay listener, the chunk-bounds source, XR and canvas
 * listeners; see RVViewer.dispose). Measured with CDP `Runtime.getHeapUsage` after forced GC.
 */
interface Session { send(method: string, params?: object): Promise<Record<string, number>> }

async function backingMB(): Promise<number> {
  const session = cdp() as unknown as Session;
  for (let i = 0; i < 3; i++) await session.send('HeapProfiler.collectGarbage');
  const usage = await session.send('Runtime.getHeapUsage');
  return usage.backingStorageSize / 1048576;
}

async function cycle(): Promise<void> {
  const w = await sceneWorld('AGVDemo');
  w.step(3);
  w.dispose();
  await new Promise(resolve => setTimeout(resolve, 100));
}

describe('plan-2059 O5: viewer dispose releases the model', () => {
  it('10 load/dispose cycles of the 15 MB AGVDemo GLB do not grow the ArrayBuffer backing store', async () => {
    await cycle(); await cycle(); // warm-up: shared caches, bytes cache, module state
    const before = await backingMB();
    for (let i = 0; i < 10; i++) await cycle();
    const after = await backingMB();
    console.info(`DISPOSE_LEAK ${JSON.stringify({ beforeMB: +before.toFixed(1), afterMB: +after.toFixed(1), growthMB: +(after - before).toFixed(1) })}`);
    // The leak was ~300 MB per cycle (3 GB over 10); allow noise.
    expect(after - before, 'ArrayBuffer backing store growth over 10 cycles (MB)').toBeLessThan(60);
  }, 300_000);
});
