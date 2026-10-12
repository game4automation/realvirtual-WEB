// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plugin-context-simloop.test.ts — `context.simLoop.onTick` must reach the
 * viewer's tick dispatch.
 *
 * Regression: every PluginContextImpl used to build its OWN SimLoopFacadeImpl,
 * whose callbacks `fixedUpdate()` never ran — `fixedUpdate()` only iterates
 * `viewer._simLoop`. A plugin registering through its context (the virtual
 * PLC) was silently never ticked.
 */

import { describe, it, expect } from 'vitest';
import { PluginContextImpl, TickStage } from '../src/core/rv-plugin-context';
import { SimLoopFacadeImpl } from '../src/core/facades/sim-loop-facade';
import type { RVViewer } from '../src/core/rv-viewer';

describe('PluginContext.simLoop', () => {
  it('is the viewer facade, so a context registration fires on the viewer dispatch', () => {
    const viewer = {} as unknown as RVViewer & { _simLoop: SimLoopFacadeImpl };
    viewer._simLoop = new SimLoopFacadeImpl(viewer);
    const root = new PluginContextImpl(viewer);
    const context = root.forPlugin('plc');

    expect(context.simLoop).toBe(viewer._simLoop);

    let ticks = 0;
    context.simLoop.onTick(TickStage.PRE, () => { ticks++; }, 60);
    for (const entry of viewer._simLoop._snapshotTicks(TickStage.PRE)) entry.callback(1 / 60);
    expect(ticks).toBe(1);
  });

  it('falls back to a private facade only when the viewer has none', () => {
    const context = new PluginContextImpl({} as unknown as RVViewer);
    expect(context.simLoop).toBeInstanceOf(SimLoopFacadeImpl);
    expect(context.simLoop).toBe(context.simLoop);
  });
});
