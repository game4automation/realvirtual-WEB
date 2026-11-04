// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Scene } from 'three';
import { loadBakedGLB } from './load-baked-glb';
import { ikSolverRegistry } from '../../src/core/engine/rv-ik-solver';
import { fkOracleProvider, robotToolsViewer } from './robot-fk-oracle';
import type { RVIKPath } from '../../src/core/engine/rv-ik-path';
import type { RVViewer } from '../../src/core/rv-viewer';

/** Real baked library replay with manual time; pausing stops ticks, not wall time. */
export async function robotRunHarness() {
  const scene = new Scene();
  const result = await loadBakedGLB('/library/Robots/FanucCRX-10iA-L.glb', scene);
  let paused = false;
  const listeners = new Map<string, Set<() => void>>();
  const viewer = Object.assign(robotToolsViewer(result, scene), {
    currentModelRoot: scene,
    loop: { fixedTimeStep: 0.02 },
    runtime: { isAttached: true },
    on(event: string, fn: () => void) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set); set.add(fn);
      return () => { set.delete(fn); };
    },
    emit(event: string) { for (const fn of listeners.get(event) ?? []) fn(); },
  }) as unknown as RVViewer;
  Object.defineProperty(viewer, 'isSimulationPaused', { get: () => paused });
  const paths = result.registry.getAll<RVIKPath>('IKPath').map(r => r.instance);
  const path = paths[0];
  // Sim-start is deliberately explicit in these tests; no fixture auto-start.
  for (const p of paths) { p.StartPath = false; p.LoopPath = false; p.cancel(); }
  const drives = path.robot!.getAxisDrives();
  const oracle = fkOracleProvider(path.robot!.getJointChain()!);
  for (const target of path.targets) oracle.teach(target.AxisPos);
  ikSolverRegistry.register(oracle);
  ikSolverRegistry.resetLiveSolveClaims();
  return {
    viewer, path, result, drives,
    pause(value: boolean) { paused = value; },
    listenerCount() { return [...listeners.values()].reduce((n, s) => n + s.size, 0); },
    tick(frames = 1) {
      for (let i = 0; i < frames; i++) {
        if (paused) continue;
        for (const p of paths) p.fixedUpdate(0.02);
        for (const d of drives) d.update(0.02);
      }
    },
    dispose() { ikSolverRegistry.register(null); ikSolverRegistry.resetLiveSolveClaims(); for (const p of paths) { p.cancel(); p.dispose(); } },
  };
}
