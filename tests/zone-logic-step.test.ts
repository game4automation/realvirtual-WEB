// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * zone-logic-step.test.ts — plan-521 §9.4: `LogicStep_WaitForZone`.
 *
 * The step itself (occupied / free), the engine build through the ONE
 * reference resolver, and a missing reference that is reported instead of
 * silently finishing. The editor palette entry (`web_editor_add_logic_step`)
 * lives in the private asset editor and is covered by zone-box-handles.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVZone } from '../src/core/engine/rv-zone';
import { RVWaitForZone, RVSerialContainer, StepState } from '../src/core/engine/rv-logic-step';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

afterEach(() => vi.restoreAllMocks());

describe('LogicStep_WaitForZone (F8)', () => {
  it('waits for occupied, then for free', () => {
    const zone = new RVZone(new Object3D());
    const waitOcc = new RVWaitForZone(zone, true);
    waitOcc.start();
    expect(waitOcc.state).toBe(StepState.Waiting);
    waitOcc.fixedUpdate(1 / 60);
    expect(waitOcc.state).toBe(StepState.Waiting);
    zone.occupied = true;
    waitOcc.fixedUpdate(1 / 60);
    expect(waitOcc.state).toBe(StepState.Finished);

    const waitFree = new RVWaitForZone(zone, false);
    waitFree.start();
    expect(waitFree.state).toBe(StepState.Waiting);
    zone.occupied = false;
    waitFree.fixedUpdate(1 / 60);
    expect(waitFree.state).toBe(StepState.Finished);

    // Already matching at start → finishes immediately.
    const immediate = new RVWaitForZone(zone, false);
    immediate.start();
    expect(immediate.state).toBe(StepState.Finished);
  });

  it('is built by the engine from the extras, the Zone reference resolved through the registry', () => {
    const root = new Object3D(); root.name = 'Cell';
    const stop = new Object3D(); stop.name = 'Stop'; root.add(stop);
    const seq = new Object3D(); seq.name = 'Seq'; root.add(seq);
    seq.userData.realvirtual = { LogicStep_SerialContainer: {} };
    const wait = new Object3D(); wait.name = 'WaitStop'; seq.add(wait);
    wait.userData.realvirtual = {
      LogicStep_WaitForZone: {
        Zone: { type: 'ComponentReference', path: 'Cell/Stop', componentType: 'realvirtual.Zone' },
        WaitForOccupied: true,
      },
    };
    const registry = new NodeRegistry();
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const zone = new RVZone(stop);
    registry.register('Zone', NodeRegistry.computeNodePath(stop), zone);

    const engine = RVLogicEngine.build(root, registry, new SignalStore());
    const container = engine.roots[0] as RVSerialContainer;
    const step = container.children[0];
    expect(step).toBeInstanceOf(RVWaitForZone);
    expect((step as RVWaitForZone).zone).toBe(zone);
    expect((step as RVWaitForZone).waitForOccupied).toBe(true);
  });

  it('a missing Zone reference is reported (build and start), never a silent finish', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = new Object3D(); root.name = 'Cell';
    const seq = new Object3D(); seq.name = 'Seq'; root.add(seq);
    seq.userData.realvirtual = { LogicStep_SerialContainer: {} };
    const wait = new Object3D(); wait.name = 'WaitStop'; seq.add(wait);
    wait.userData.realvirtual = { LogicStep_WaitForZone: { WaitForOccupied: true } };
    const registry = new NodeRegistry();
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const engine = RVLogicEngine.build(root, registry, new SignalStore());
    const step = (engine.roots[0] as RVSerialContainer).children[0] as RVWaitForZone;
    expect(step.zone).toBeNull();
    step.start();
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toMatch(/WaitForZone "WaitStop": Zone reference missing/);
    expect(text).toMatch(/WaitForZone "WaitStop": no Zone referenced/);
  });
});
