// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * robot-fk-oracle.ts — the solver double and the viewer shim the robotics
 * suites share (plan-773; extracted from `robot-path-mcp-tools.test.ts` in
 * Phase 4, when a second suite needed the same two pieces).
 *
 * ## What the double is honestly worth
 *
 * The real solver is a closed WASM artifact that ships only in licensed builds,
 * so in this repository the tier is `'none'` and nothing can be solved. The
 * suites that use this are not testing a solver though — they test the PLUMBING
 * around one: frame routing, the atomic pose-and-angles write, the order of a
 * path, the conversion into a vendor-neutral program. {@link fkOracleProvider}
 * therefore answers from the chain's own forward kinematics: a test poses the
 * robot at joint vectors it chose, `chainFk` computes the resulting TCP pose,
 * and the double maps that pose back to those angles. A pose it has no sample
 * for is unreachable, which is how the refusal paths get exercised.
 *
 * It reports tier `'pro'` and implements `solveCobot`, because the shipped
 * robot is a cobot: that is what makes `solveFrameFor` answer `'chain'`, and
 * the chain frame is the one `chainFk` works in. **A caller that handed over a
 * Unity-frame pose gets "unreachable" here** — the plan-772 frame defect shows
 * up as a red test rather than as a plausible number.
 *
 * Two things it deliberately does NOT claim: that a second branch it offers is
 * geometrically a solution (it is synthetic, for listing and selection only —
 * the real branch set is asserted against the real WASM in
 * `ik-cobot-glb-chain.test.ts`), and that its tolerance says anything about
 * solver accuracy.
 */

import type { Scene } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import {
  createRuntimeNode, removeRuntimeNode,
  type LoadResult, type RuntimeNodeSpec,
} from '../../src/core/engine/rv-scene-loader';
import type { RVIKPath } from '../../src/core/engine/rv-ik-path';
import type {
  IKSolution, IKSolverProvider, JointChainParams,
} from '../../src/core/engine/rv-ik-solver';
import { chainFk, type Quat, type Vec3 } from '../../src/core/engine/rv-robot-fk';

/** A pose the double can answer, with the joint vector it answers with. */
export interface OracleSample {
  angles: number[];
  pos: Vec3;
  quat: Quat;
  /** A synthetic second branch, to exercise listing/selection only. */
  alternative?: number[];
}

/** The solver double: an {@link IKSolverProvider} that can be taught poses. */
export interface FkOracle extends IKSolverProvider {
  /** Register a joint vector: its chain-frame TCP pose becomes solvable. */
  teach(angles: readonly number[], alternative?: readonly number[]): OracleSample;
  readonly samples: OracleSample[];
}

/** Build a double that answers for the poses it was taught. See the header. */
export function fkOracleProvider(chain: JointChainParams): FkOracle {
  const samples: OracleSample[] = [];
  const POS_EPS = 1e-6;
  const solve = (pos: readonly number[], quat: readonly number[]): IKSolution[] => {
    void quat;
    for (const s of samples) {
      const d = Math.hypot(pos[0] - s.pos[0], pos[1] - s.pos[1], pos[2] - s.pos[2]);
      if (d > POS_EPS) continue;
      const out: IKSolution[] = [{ angles: [...s.angles], reachable: true }];
      if (s.alternative) out.push({ angles: [...s.alternative], reachable: true });
      return out;
    }
    return [{ angles: [0, 0, 0, 0, 0, 0], reachable: false }];
  };
  return {
    tier: 'pro',
    maxRobots: 8,
    canBlend: true,
    samples,
    solvePieper: (_p, pos, quat) => solve(pos, quat),
    solveCobot: (_c, pos, quat) => solve(pos, quat),
    teach(angles, alternative): OracleSample {
      const fk = chainFk(chain, angles);
      const sample: OracleSample = {
        angles: [...angles], pos: fk.tcp.pos, quat: fk.tcp.quat,
        ...(alternative ? { alternative: [...alternative] } : {}),
      };
      samples.push(sample);
      return sample;
    },
  };
}

/**
 * A viewer shaped as `McpRobotTools` uses one — including the three node verbs
 * the waypoint tools need. They are the REAL implementations
 * (`createRuntimeNode` / `removeRuntimeNode` / the IKPath re-resolve), not
 * stand-ins: `RVViewer`'s own methods are these calls plus its overlay
 * managers, and a fake that merely recorded the call would prove nothing about
 * whether the node arrives.
 */
export function robotToolsViewer(result: LoadResult, sceneRef: Scene): RVViewer {
  const deps = {
    registry: result.registry, signalStore: result.signalStore,
    scene: sceneRef, transportManager: result.transportManager,
  };
  return {
    ...deps,
    markRenderDirty(): void { /* nothing renders in these suites */ },
    markShadowsDirty(): void { /* idem */ },
    createComponentNode(spec: RuntimeNodeSpec): boolean {
      return !!createRuntimeNode(deps, spec);
    },
    removeComponentNode(nodePath: string): void {
      removeRuntimeNode(result.registry, nodePath);
    },
    rebuildIKPaths(): void {
      for (const { instance } of result.registry.getAll<RVIKPath>('IKPath')) {
        instance.rebuildTargets(result.registry);
      }
    },
    emit(): void { /* no listeners here */ },
    on(): void { /* idem */ },
    off(): void { /* idem */ },
  } as unknown as RVViewer;
}
