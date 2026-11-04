// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-2053 Phase 0: permanent regression test for the proven DES core — promoted from the
// throwaway spike (`rv-worktrees/spike-2053-agv-fault/.../tests/spike-plan-2053-agv-fault.node.test.ts`,
// green). Proves `Downtime` (plan-2051, unchanged) targeting an `Agv`'s own DES adapter path
// already freezes/resumes it via the generic `DESComponent.setFailure()`/`onFreeze()`/`onResume()`
// contract, with ZERO new `Agv.ts`/`Downtime.ts` code. Adds the zone-holding assertion (F2, SHRINK
// scope): the vehicle keeps every zone it already held across the freeze — no release extension in
// this plan (that remains its own, later, "own spike needed" follow-up — see plan-2053 `open:`).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { clearLiveControl } from '../../src/core/engine/rv-live-control';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { clearShared } from '../helpers/agv-harness';
import AgvBehavior, { AgvFlow } from '../../src/behaviors/Agv';
import Downtime from '../../src/plugins/des/material-flow/Downtime';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { bindSceneToRunner } from '../../src/plugins/des/des-scene-binding';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

const TICK = 1 / 60;

beforeEach(() => { clearShared(); clearLiveControl(); });
afterEach(() => { clearLiveControl(); });

function registerLoop(): void {
  const net = getDefaultPathNetwork();
  net.register(parsePathExtras({
    type: 'Path', version: 1, closed: true, align: [0, 1, 0],
    id: 'Loop', segments: [
      { kind: 'line', from: [-5, 0, 0], to: [5, 0, 0] },
      { kind: 'line', from: [5, 0, 0], to: [-5, 0, 0] },
    ],
  }, 'Loop')!);
  net.resolveGraph();
}

describe('plan-2053: Downtime targeting an Agv freezes/resumes it (DES, unchanged behavior)', () => {
  it('Downtime failure on the Agv path halts it; repair resumes it; held zones are not released', () => {
    registerLoop();
    registerMaterialFlow(AgvFlow as unknown as MaterialFlowDefinition);
    registerMaterialFlow(Downtime as unknown as MaterialFlowDefinition);
    void AgvBehavior; // keep the default export referenced (tree-shake guard, unused otherwise)

    const scene = new Scene();
    const agvNode = new Object3D();
    agvNode.name = 'AGV_1';
    agvNode.userData.realvirtual = { Agv: { PathId: 'Loop', StartPosition: 0, TargetSpeed: 1000 } };
    scene.add(agvNode);

    const downNode = new Object3D();
    downNode.name = 'Down_1';
    downNode.userData.realvirtual = { Downtime: { MTBF: 10, MTTR: 5, TargetComponentPath: 'AGV_1' } };
    scene.add(downNode);
    scene.updateMatrixWorld(true);

    const host: BindContextHost = {
      signalStore: new SignalStore(), registry: null, drives: [],
      on: () => () => {}, contextMenu: new ContextMenuStore(),
      getPlugin: () => undefined,
    };
    const runner = new DESRunner({ subMode: 'animated' });
    bindSceneToRunner(runner, scene, host);
    runner.start([], { root: scene });

    const mb = getDefaultMovementAuthority('des');
    const zones = getDefaultZoneRegistry();
    let posAtFreeze: number | null = null;
    let frozenAt = -1;
    let resumedAt = -1;
    let heldAtFreeze: string[] | null = null;
    let heldMidFreeze: string[] | null = null;
    const scratch: string[] = [];
    for (let i = 1; i <= 30 / TICK; i++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      const t = i * TICK;
      const loc = mb.locate(agvNode.name, t);
      if (frozenAt < 0 && mb.isFrozen(agvNode.name)) {
        frozenAt = t;
        posAtFreeze = loc?.s ?? null;
        scratch.length = 0;
        zones.collectHeld(agvNode.name, scratch);
        heldAtFreeze = [...scratch].sort();
      }
      // F2 (SHRINK scope, no release extension): whatever zones were held at the
      // moment of freezing stay held for the whole frozen window — sampled once,
      // midway through the repair wait, well before resume.
      if (frozenAt >= 0 && heldMidFreeze === null && t >= frozenAt + 2 && mb.isFrozen(agvNode.name)) {
        scratch.length = 0;
        zones.collectHeld(agvNode.name, scratch);
        heldMidFreeze = [...scratch].sort();
      }
      if (frozenAt >= 0 && resumedAt < 0 && !mb.isFrozen(agvNode.name)) resumedAt = t;
    }
    // eslint-disable-next-line no-console
    console.log('[plan-2053] frozenAt', frozenAt, 'resumedAt', resumedAt, 'posAtFreeze', posAtFreeze,
      'heldAtFreeze', heldAtFreeze, 'heldMidFreeze', heldMidFreeze);

    expect(frozenAt).toBeGreaterThan(0);
    expect(resumedAt).toBeGreaterThan(frozenAt);
    expect(resumedAt - frozenAt).toBeGreaterThanOrEqual(4); // ~MTTR
    // Zone-holding behavior is unchanged by this plan: whatever the vehicle held
    // the moment it froze (possibly nothing, on this unzoned Loop) is still held
    // mid-freeze — no automatic release happens during a Downtime fault.
    expect(heldAtFreeze).not.toBeNull();
    expect(heldMidFreeze).not.toBeNull();
    expect(heldMidFreeze).toEqual(heldAtFreeze);
    runner.dispose();
  });
});
