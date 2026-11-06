// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { WasmIKSolver } from '@rv-private/ik-solver/rv-ik-solver-provider';
import { ikSolverRegistry, type IKSolverProvider } from '../../src/core/engine/rv-ik-solver';
import type { RVIKPath, IKPathRunEvent } from '../../src/core/engine/rv-ik-path';
import type { SignalWriter } from '../../src/core/engine/rv-signal-store';
import { sceneWorld } from './continuation-scene-world';

export class IKProSolverUnavailable extends Error {}
export const IK_WAIT = 'Continuation.IK.Continue';

/** Real library robot, real Core.Cycle, identical authoring in every fresh world. */
export async function ikWorld(opts: { solver: boolean }) {
  // The registry has no public provider getter. Preserve the singleton's services
  // and claims in this fixture, including on a failed load or a skipped pro suite.
  const registry = ikSolverRegistry as unknown as {
    provider: IKSolverProvider | null; liveSolveClaims: Set<string>;
  };
  const previous = registry.provider, claims = [...registry.liveSolveClaims];
  const restoreRegistry = () => {
    ikSolverRegistry.register(previous);
    ikSolverRegistry.resetLiveSolveClaims();
    for (const id of claims) ikSolverRegistry.claimLiveSolve(id);
  };
  let paths: RVIKPath[] = [];
  let writer: SignalWriter;
  const runs: Array<IKPathRunEvent & { t: number }> = [];
  const off: Array<() => void> = [];
  try {
    const world = await sceneWorld('FanucCRX-10iA-L', {
      async ready(v) {
        if (opts.solver) {
          const s = new WasmIKSolver(); await s.load();
          if (s.tier !== 'pro') throw new IKProSolverUnavailable(`IK continuation suite requires pro WASM solver; got ${s.tier}`);
          ikSolverRegistry.register(s);
        } else ikSolverRegistry.register(null);
        ikSolverRegistry.resetLiveSolveClaims();
        paths = v.registry!.getAll<RVIKPath>('IKPath').map(r => r.instance);
        if (paths.length !== 1 || paths[0].targets.length < 3) throw new Error('Expected one library IK path with at least three targets');
        // A dedicated store signal avoids dependence on a shipped PLC program.
        // Its stable name/path and identified writer are the same in every world.
        v.signalStore!.register(IK_WAIT, IK_WAIT, false, 'PLCOutputBool');
        writer = v.signalStore!.createWriter('test:continuation-ik:quarter-second', 'component');
        writer.set(IK_WAIT, false, 0);
        for (const path of paths) {
          path.StartPath = true; path.LoopPath = true;
          path.targets.forEach((target, index) => {
            target.InterpolationToTarget = index === 1 ? 'Linear' : 'PointToPoint';
            target.LinearSpeedToTarget = 100; target.LinearAcceleration = 200;
            target.waitForSignalAddr = index === path.targets.length - 1 ? IK_WAIT : null;
          });
          for (const drive of path.robot!.getAxisDrives()) {
            drive.TargetSpeed = 45; drive.UseAcceleration = true; drive.Acceleration = 90;
          }
          off.push(path.addRunListener(event => runs.push({ ...event,
            t: (path as unknown as { _simTime: number })._simTime })));
        }
      },
      step(_v, before, next) {
        // Stateless absolute schedule: a restored world crosses exactly the
        // same boundaries. FALSE for fourteen seconds, TRUE for two, each loop.
        if (before < next && next % 16 === 14) writer.set(IK_WAIT, true, next);
        if (before < next && next % 16 === 0) writer.set(IK_WAIT, false, next);
      },
    });
    return { ...world, paths, path: paths[0], drives: paths[0].robot!.getAxisDrives(), runs,
      dispose() {
        try { off.forEach(fn => fn()); world.dispose(); }
        finally { restoreRegistry(); }
      },
    };
  } catch (error) { off.forEach(fn => fn()); restoreRegistry(); throw error; }
}

export type IKWorld = Awaited<ReturnType<typeof ikWorld>>;
