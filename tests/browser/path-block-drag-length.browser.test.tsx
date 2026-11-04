// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9o (8.11d) — length / radius handle by mouse in the REAL viewer,
 * planner AND des: Straight → Curve R → Straight chained; the selected
 * straight shows the length handle at its end — dragging it (0.25 m raster)
 * shows the ghost + the value at the cursor, the release is ONE undo step, the
 * block keeps its start, the chain slides along and every edge stays
 * (0 kinks / gaps); the selected curve's radius handle (arc midpoint) does the
 * same for the radius; undo restores; while the simulation runs the handle is
 * gone (the lock of every path verb).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 120_000 });
import { specEnds } from '../../src/core/engine/rv-path-blocks';
import { paramHandle } from '../../src/plugins/path-network/path-network-ui-model';
import {
  bootRealRig,
  clickPath,
  disposeRealRig,
  down,
  execCmd,
  frame,
  move,
  netOf,
  screenOf,
  succOf,
  undoLen,
  until,
  up,
  type RealRig,
} from '../path/path-network-real-rig';

let rig: RealRig | null = null;

afterEach(() => {
  disposeRealRig(rig);
  rig = null;
});

const kinksOrGaps = (r: RealRig): number => r.viz.liveValidation?.run().issues.filter((i) => i.code === 'path-kink' || i.code === 'path-link-gap').length ?? 0;
const blockById = (r: RealRig, id: string) => netOf(r).blocks!.find((b) => b.id === id)!;
const startOf = (r: RealRig, pathId: string): number[] => specEnds(netOf(r).paths.find((p) => p.id === pathId)!.segments)!.start.position;
const endOf = (r: RealRig, pathId: string): number[] => specEnds(netOf(r).paths.find((p) => p.id === pathId)!.segments)!.end.position;

/** Drag from world point `a` to world point `b` with the mouse (handle drag). */
async function dragWorld(r: RealRig, a: readonly number[], b: readonly number[], steps = 6): Promise<void> {
  r.v.scene.updateMatrixWorld(true);
  const sa = screenOf(r, a);
  const sb = screenOf(r, b);
  down(r, sa);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    move(r, { clientX: sa.clientX + (sb.clientX - sa.clientX) * t, clientY: sa.clientY + (sb.clientY - sa.clientY) * t }, 1);
    await frame();
  }
  up(r, sb);
  await frame();
}

describe('plan-628 9.9o length / radius handle (real viewer, mouse)', () => {
  for (const mode of ['planner', 'des'] as const) {
    it(`${mode}: drag the straight's length and the curve's radius — the chain follows, one undo step each`, async () => {
      const r = rig = await bootRealRig(mode);
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
      await execCmd(r, 'layout.path.place', { block: 'curve', degrees: 90, side: 'right', atPath: 'PN_S1', atEnd: 'end' });
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, atPath: 'PN_C1', atEnd: 'end' });
      expect(succOf(r, 'PN_S1')).toEqual(['PN_C1']);
      expect(succOf(r, 'PN_C1')).toEqual(['PN_S2']);

      // ── Length handle on the straight ──
      await clickPath(r, 'PN_S1');
      await until(() => !!r.ui.paramHandleObject, 'length handle shown');
      const hs = r.ui.paramHandleObject!.position;
      expect(hs.x).toBeCloseTo(2, 4);
      expect(hs.z).toBeCloseTo(0, 4);
      const u0 = undoLen(r);
      // Drag in steps; check the preview mid-drag.
      r.v.scene.updateMatrixWorld(true);
      const a = screenOf(r, [2, 0, 0]);
      const b = screenOf(r, [3.3, 0, 0.2]);
      down(r, a);
      for (let i = 1; i <= 5; i++) {
        move(r, { clientX: a.clientX + (b.clientX - a.clientX) * i / 5, clientY: a.clientY + (b.clientY - a.clientY) * i / 5 }, 1);
        await frame();
      }
      expect(r.ui.ghostObject, 'ghost shows the new length').not.toBeNull();
      const label = document.querySelector('[data-testid="path-network-typed"]') as HTMLElement | null;
      expect(label?.textContent ?? '').toContain('Length: 3.25 m');
      expect(undoLen(r), 'nothing written while dragging').toBe(u0);
      up(r, b);
      await until(() => undoLen(r) === u0 + 1, 'one undo step for the length drag');
      await until(() => blockById(r, 'PN_Block_1').extras.params.lengthM === 3.25, 'length on the raster');
      expect(blockById(r, 'PN_Block_1').extras.pose).toEqual([0, 0, 0]); // start stays
      expect(startOf(r, 'PN_C1')[0]).toBeCloseTo(3.25, 4); // chain slid along
      expect(succOf(r, 'PN_S1')).toEqual(['PN_C1']);
      expect(succOf(r, 'PN_C1')).toEqual(['PN_S2']);
      expect(kinksOrGaps(r)).toBe(0);
      expect(r.ui.ghostObject).toBeNull();

      // ── Radius handle on the curve ──
      await clickPath(r, 'PN_C1');
      await until(() => !!r.ui.paramHandleObject, 'radius handle shown');
      const h = paramHandle(blockById(r, 'PN_Block_2').extras)!;
      expect(h.field).toBe('radiusM');
      const target = [h.origin[0] + h.dir[0] * h.unit * 2, 0, h.origin[2] + h.dir[1] * h.unit * 2];
      const u1 = undoLen(r);
      await dragWorld(r, h.position, target);
      await until(() => undoLen(r) === u1 + 1, 'one undo step for the radius drag');
      expect(blockById(r, 'PN_Block_2').extras.params.radiusM).toBe(2);
      const ce = endOf(r, 'PN_C1');
      const s2 = startOf(r, 'PN_S2');
      expect(s2[0]).toBeCloseTo(ce[0], 4);
      expect(s2[2]).toBeCloseTo(ce[2], 4);
      expect(succOf(r, 'PN_C1')).toEqual(['PN_S2']);
      expect(succOf(r, 'PN_S1')).toEqual(['PN_C1']); // predecessor edge untouched
      expect(kinksOrGaps(r)).toBe(0);

      // Undo: radius and chain back.
      await r.doc.undo();
      await until(() => blockById(r, 'PN_Block_2').extras.params.radiusM !== 2, 'radius restored');
      expect(succOf(r, 'PN_C1')).toEqual(['PN_S2']);
      expect(kinksOrGaps(r)).toBe(0);

      // Simulation running: the handle is gone (lock of every path verb).
      r.v.setSimulationPaused(`pn-l5-${mode}`, false);
      await until(() => !r.ui.getState().editable, 'locked while simulating');
      expect(r.ui.paramHandleObject).toBeNull();
    });
  }
});
