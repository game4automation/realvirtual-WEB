// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { flow, transferFixture } from './phase2-transfer-fixture';

describe('9.6 Storage refusal and per-MU dwell time', () => {
  it('a: retains a refused MU and retries it at the next independent ready', () => {
    let ready = false;
    const f = transferFixture([
      { type: 'Storage', props: { AutoRelease: false } },
      { type: flow({ des: { canAccept: () => ready } }) },
    ]);
    const [storage, target] = f.parts;
    const mu = f.runner.createMU();
    expect(storage.acceptMU(mu)).toBe(true);
    // Explicit wake also exercises the pre-fix path, which does not push on accept.
    storage.onDownstreamReady(target);
    expect(storage.self.mus).toEqual([mu]);
    expect(mu.currentComponent).toBe(storage);
    expect(storage.currentLoad).toBe(1);
    expect(storage.totalProcessed).toBe(0);
    expect(target.totalProcessed).toBe(0);
    expect(storage.currentLoad + target.currentLoad).toBe(1);

    ready = true;
    storage.onDownstreamReady(target);
    expect(target.self.mus).toEqual([mu]);
    expect(storage.self.mus).toHaveLength(0);
    expect(mu.currentComponent).toBe(target);
    expect(storage.totalProcessed).toBe(1);
    expect(storage.currentLoad + target.currentLoad).toBe(1);
  });

  it.each(['FIFO', 'LIFO', 'Priority'])('b: %s ignores ready before either MU is due', Strategy => {
    const f = transferFixture([
      { type: 'Storage', props: { Strategy, AutoRelease: true, AutoReleaseDelay: 10 } },
      { type: flow(), props: { MaxCapacity: 10 } },
    ]);
    const [storage, target] = f.parts;
    // The test flow declares no schema, so the MaxCapacity prop never reaches the
    // adapter (default 1) — set it directly; the target must hold both MUs.
    target.MaxCapacity = 10;
    const first = f.runner.createMU();
    storage.acceptMU(first);
    f.advance(3);
    const second = f.runner.createMU();
    second.prop.priority = 100;
    storage.acceptMU(second);
    f.advance(4);
    storage.onDownstreamReady(target);
    expect(target.self.mus).toHaveLength(0);
    expect(storage.self.mus).toEqual([first, second]);
    expect(storage.totalProcessed).toBe(0);
    expect(first.currentComponent).toBe(storage);
    expect(second.currentComponent).toBe(storage);
  });

  it.each(['FIFO', 'LIFO', 'Priority'])('b: %s selects only due MUs at auto-release and ready', Strategy => {
    const f = transferFixture([
      { type: 'Storage', props: { Strategy, AutoRelease: true, AutoReleaseDelay: 10 } },
      { type: flow(), props: { MaxCapacity: 10 } },
    ]);
    const [storage, target] = f.parts;
    // The test flow declares no schema, so the MaxCapacity prop never reaches the
    // adapter (default 1) — set it directly; the target must hold both MUs.
    target.MaxCapacity = 10;
    const first = f.runner.createMU();
    storage.acceptMU(first);
    f.advance(5);
    const second = f.runner.createMU();
    second.prop.priority = 100;
    storage.acceptMU(second);
    f.advance(10);
    // The newest/highest-priority MU is not yet eligible at the first timer.
    expect(target.self.mus).toEqual([first]);
    expect(storage.self.mus).toEqual([second]);
    f.advance(12);
    storage.onDownstreamReady(target);
    expect(target.self.mus).toEqual([first]);
    expect(storage.totalProcessed).toBe(1);
    f.advance(15);
    expect(target.self.mus).toEqual([first, second]);
    expect(storage.self.mus).toHaveLength(0);
    expect(storage.totalProcessed).toBe(2);
    expect(storage.currentLoad + target.currentLoad).toBe(2);
  });
});
