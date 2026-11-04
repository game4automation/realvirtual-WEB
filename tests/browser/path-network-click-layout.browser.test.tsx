// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9m (8.11b) — click layout by mouse in the REAL viewer, planner
 * AND des: with a straight selected (free end), hovering the floor shows the
 * ghost, a click ahead places a straight (0.25 m raster), a click to the side
 * a tangential curve + straight — each click ONE undo step, the new block is
 * selected so the next click continues the run; a click on a foreign free
 * start docks onto it tangentially (edge written, 0 kinks); Esc cancels.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 120_000 });
import { directionOf, specEnds } from '../../src/core/engine/rv-path-blocks';
import {
  blockIdsOf,
  blockOf,
  bootRealRig,
  clickAt,
  clickPath,
  disposeRealRig,
  execCmd,
  frame,
  hover,
  key,
  netOf,
  screenOf,
  succOf,
  undoLen,
  until,
  type RealRig,
} from '../path/path-network-real-rig';

let rig: RealRig | null = null;

afterEach(() => {
  disposeRealRig(rig);
  rig = null;
});

const kinksOrGaps = (r: RealRig): number => r.viz.liveValidation?.run().issues.filter((i) => i.code === 'path-kink' || i.code === 'path-link-gap').length ?? 0;

/** The free END of the selected block (what the click layout builds from). */
function selectedEnd(r: RealRig): { position: number[]; headingDeg: number; pathId: string } {
  const b = r.ui.getState().selectedBlock!;
  const n = netOf(r);
  const p = n.paths.find((x) => b.paths.includes(x.id) && x.successors.length === 0)!;
  const e = specEnds(p.segments)!;
  return { position: e.end.position, headingDeg: Math.atan2(e.end.tangent[2], e.end.tangent[0]) * 180 / Math.PI, pathId: p.id };
}

describe('plan-628 9.9m click layout (real viewer, mouse)', () => {
  for (const mode of ['planner', 'des'] as const) {
    it(`${mode}: straight ahead, curve + straight to the side, dock onto a foreign free start, Esc cancels`, async () => {
      const r = rig = await bootRealRig(mode);
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
      await clickPath(r, 'PN_S1');
      expect(r.ui.getState().clickLayout).toBe(true);

      // Hover ahead (2° off): ghost + straight plan on the raster.
      await hover(r, screenOf(r, [5.2, 0, 0.1]));
      await until(() => !!r.ui.currentClickPlan, 'click plan under the pointer');
      expect(r.ui.ghostObject).not.toBeNull();
      expect(r.ui.currentClickPlan!.steps).toEqual([{ kind: 'straight', lengthM: 3.25 }]);
      const u0 = undoLen(r);
      await clickAt(r, screenOf(r, [5.2, 0, 0.1]));
      await until(() => blockIdsOf(r).length === 2, 'straight placed by the click');
      expect(undoLen(r)).toBe(u0 + 1);
      expect(succOf(r, 'PN_S1')).toEqual(['PN_S2']);
      const s2 = netOf(r).blocks!.find((b) => b.id === blockOf(r, 'PN_S2'))!;
      expect(s2.extras.params.lengthM).toBe(3.25);
      expect(r.ui.getState().selectedBlock?.id).toBe(s2.id); // the run continues from here

      // Click to the side (left of travel = −Z): curve + straight in ONE step.
      const u1 = undoLen(r);
      await hover(r, screenOf(r, [6.75, 0, -2.5]));
      await clickAt(r, screenOf(r, [6.75, 0, -2.5]));
      await until(() => blockIdsOf(r).length === 4, 'curve + straight placed by one click');
      expect(undoLen(r)).toBe(u1 + 1);
      const kinds = (netOf(r).blocks ?? []).map((b) => b.extras.kind).sort();
      expect(kinds).toEqual(['curve', 'straight', 'straight', 'straight']);
      expect(kinksOrGaps(r)).toBe(0);
      expect(r.ui.getState().clickLayout).toBe(true);

      // A foreign free start reachable by a right turn R = 2 m + 1 m straight.
      const e = selectedEnd(r);
      const f = directionOf(e.headingDeg);
      const right = [-f[2], 0, f[0]];
      const tgt = [e.position[0] + 2 * f[0] + 3 * right[0], 0, e.position[2] + 2 * f[2] + 3 * right[2]];
      const foreign = await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 1, x: tgt[0], z: tgt[2], headingDeg: e.headingDeg + 90 });
      const foreignPath = (foreign.createdPaths as string[])[0];
      await clickPath(r, e.pathId, { f: 0.9 }); // re-select the run's last block
      await until(() => r.ui.getState().clickLayout, 'armed again');
      await hover(r, screenOf(r, tgt));
      await until(() => !!r.ui.currentClickPlan?.target, 'plan docks onto the foreign start');
      const u2 = undoLen(r);
      await clickAt(r, screenOf(r, tgt));
      await until(() => undoLen(r) === u2 + 1, 'one undo step for the docking');
      for (let i = 0; i < 3; i++) await frame();
      const into = netOf(r).paths.filter((p) => p.successors.includes(foreignPath));
      expect(into.length, 'an edge into the foreign start').toBe(1);
      expect(kinksOrGaps(r)).toBe(0);

      // Esc cancels: selection cleared, a floor click builds nothing.
      key('Escape');
      await frame();
      expect(r.ui.getState().clickLayout).toBe(false);
      const u3 = undoLen(r);
      await clickAt(r, screenOf(r, [1, 0, 3]));
      for (let i = 0; i < 3; i++) await frame();
      expect(undoLen(r)).toBe(u3);
    });
  }
});
