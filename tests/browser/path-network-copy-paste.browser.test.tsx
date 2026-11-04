// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9q (8.11f) — Ctrl+C / Ctrl+V of path blocks by mouse and
 * keyboard in the REAL viewer, planner AND des: a chain Straight → Curve R →
 * Straight is selected (click + Shift-click) and copied; Ctrl+V with the
 * cursor on a foreign free END docks the copy tangentially there (new ids,
 * inner edges kept, the edge into the copy written, ONE undo step, the pasted
 * blocks selected); Ctrl+V over empty floor pastes it free at the cursor
 * (relative layout kept, no edge to anything); 0 kinks / gaps; undo removes a
 * paste; the originals are never touched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 120_000 });
import { headingOf, specEnds } from '../../src/core/engine/rv-path-blocks';
import {
  blockIdsOf,
  bootRealRig,
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
const pathsOf = (r: RealRig, blockId: string): string[] => netOf(r).paths.filter((p) => p.block === blockId).map((p) => p.id);
const ends = (r: RealRig, pathId: string) => specEnds(netOf(r).paths.find((p) => p.id === pathId)!.segments)!;

describe('plan-628 9.9q copy / paste path blocks (real viewer, keyboard)', () => {
  for (const mode of ['planner', 'des'] as const) {
    it(`${mode}: Ctrl+C a chain, Ctrl+V docked at a free end and free at the cursor — one undo step each`, async () => {
      const r = rig = await bootRealRig(mode);
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
      await execCmd(r, 'layout.path.place', { block: 'curve', degrees: 90, side: 'right', atPath: 'PN_S1', atEnd: 'end' });
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 1, atPath: 'PN_C1', atEnd: 'end' });
      // A foreign straight whose free END the copy docks onto: ends at (1, 0, -3), heading 0.
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 1, x: 0, z: -3, headingDeg: 0 });
      const originals = JSON.stringify(netOf(r).paths.map((p) => [p.id, p.segments, p.successors]));

      // Select the chain by mouse: click + Shift-click + Shift-click.
      await clickPath(r, 'PN_S1');
      await clickPath(r, 'PN_C1', { shift: true });
      await clickPath(r, 'PN_S2', { shift: true });
      expect(r.ui.getState().selectedBlocks).toHaveLength(3);
      key('c', { ctrlKey: true });
      expect(r.ui.clipboardSize).toBe(3);

      // ── Ctrl+V on the foreign free end: docked ──
      const u0 = undoLen(r);
      await hover(r, screenOf(r, [1, 0, -3]));
      key('v', { ctrlKey: true });
      await until(() => blockIdsOf(r).length === 7, 'three blocks pasted (docked)');
      await until(() => undoLen(r) === u0 + 1, 'one undo step for the docked paste');
      const docked = r.ui.getState().selectedBlocks;
      expect(docked).toEqual(['PN_Block_5', 'PN_Block_6', 'PN_Block_7']);
      const [d1, d2, d3] = docked.map((id) => pathsOf(r, id)[0]);
      expect(succOf(r, 'PN_S3')).toEqual([d1]); // the edge into the copy
      expect(succOf(r, d1)).toEqual([d2]); // inner edges kept
      expect(succOf(r, d2)).toEqual([d3]);
      const s = ends(r, d1).start;
      expect(s.position[0]).toBeCloseTo(1, 4);
      expect(s.position[2]).toBeCloseTo(-3, 4);
      expect(headingOf(s.tangent)).toBeCloseTo(0, 4);
      expect(kinksOrGaps(r)).toBe(0);

      // ── Ctrl+V over empty floor: free at the cursor, layout kept ──
      const u1 = undoLen(r);
      await hover(r, screenOf(r, [-2, 0, 3]));
      key('v', { ctrlKey: true });
      await until(() => blockIdsOf(r).length === 10, 'three more blocks pasted (free)');
      await until(() => undoLen(r) === u1 + 1, 'one undo step for the free paste');
      const free = r.ui.getState().selectedBlocks;
      const [f1, f2, f3] = free.map((id) => pathsOf(r, id)[0]);
      const fs = ends(r, f1).start;
      expect(fs.position[0]).toBeCloseTo(-2, 1);
      expect(fs.position[2]).toBeCloseTo(3, 1);
      expect(headingOf(fs.tangent)).toBeCloseTo(0, 4); // heading kept
      expect(succOf(r, f1)).toEqual([f2]);
      expect(succOf(r, f2)).toEqual([f3]);
      expect(netOf(r).paths.filter((p) => p.successors.includes(f1))).toHaveLength(0); // no edge into a free paste
      // Relative layout: the copy's last end lies where the original's does, shifted by the same offset.
      const off = [fs.position[0] - 0, fs.position[2] - 0];
      const oe = ends(r, 'PN_S2').end.position;
      const fe = ends(r, f3).end.position;
      expect(fe[0]).toBeCloseTo(oe[0] + off[0], 4);
      expect(fe[2]).toBeCloseTo(oe[2] + off[1], 4);
      expect(kinksOrGaps(r)).toBe(0);

      // Undo removes the free paste; the originals were never touched.
      await r.doc.undo();
      await until(() => blockIdsOf(r).length === 7, 'undo removes the free paste');
      await r.doc.undo();
      await until(() => blockIdsOf(r).length === 4, 'undo removes the docked paste');
      expect(JSON.stringify(netOf(r).paths.map((p) => [p.id, p.segments, p.successors]))).toBe(originals);

      // Ctrl+C with nothing selected clears the path clipboard: Ctrl+V pastes nothing.
      key('Escape');
      await frame();
      key('c', { ctrlKey: true });
      expect(r.ui.clipboardSize).toBe(0);
      const u2 = undoLen(r);
      key('v', { ctrlKey: true });
      for (let i = 0; i < 3; i++) await frame();
      expect(undoLen(r)).toBe(u2);
    });
  }
});
