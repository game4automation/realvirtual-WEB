// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9l (8.11a, E57) — the planner's rubber-band marquee selects path
 * blocks together with placements, by mouse, in the REAL viewer (snap plugin,
 * path visualizer, path-network UI, the real `BoxSelectController` wired like
 * the planner's canvas interaction), in planner AND des:
 *
 *  - a marquee over two blocks and a placement selects both kinds: the
 *    placement goes to the viewer's selection manager, the blocks to the
 *    path-network block selection;
 *  - Shift adds, Ctrl toggles (same semantics as for placements);
 *  - Delete removes blocks AND placement as ONE undo step; Ctrl+Z (one undo)
 *    restores all of it;
 *  - dragging a selected block moves the whole selection (blocks + placement)
 *    as ONE step; the edge to an unselected neighbour is released, never a
 *    kink (8.10), the edge inside the selection stays;
 *  - a composition-owned block (`Generated.owner`, plan-681) is never selected.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 120_000 });
import {
  blockIdsOf,
  blockOf,
  bootRealRig,
  clickAt,
  disposeRealRig,
  drag,
  execCmd,
  frame,
  key,
  netOf,
  pointOn,
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

/** Straight 2 m at x 0..2 → straight 2 m at 2..4 → straight 2 m at 4..6, chained (PN_S1 → PN_S2 → PN_S3). */
async function threeStraights(r: RealRig): Promise<void> {
  await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
  await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, atPath: 'PN_S1', atEnd: 'end' });
  await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, atPath: 'PN_S2', atEnd: 'end' });
  expect(succOf(r, 'PN_S1')).toEqual(['PN_S2']);
  expect(succOf(r, 'PN_S2')).toEqual(['PN_S3']);
  await until(() => r.viz.getLineObjects().has('PN_S3'), 'lines drawn');
}

const sel = (r: RealRig): readonly string[] => r.v.selectionManager.getSnapshot().selectedPaths;
const kinks = (r: RealRig): number => r.viz.liveValidation?.run().issues.filter((i) => i.code === 'path-kink').length ?? 0;

describe('plan-628 9.9l marquee selects path blocks with placements (real viewer, mouse)', () => {
  for (const mode of ['planner', 'des'] as const) {
    it(`${mode}: marquee over blocks + placement → both selected; Shift adds, Ctrl toggles; Delete = ONE step, Ctrl+Z restores`, async () => {
      const r = rig = await bootRealRig(mode, { withPlanner: { x: 5, z: 2.5 } });
      await threeStraights(r);
      const b2 = blockOf(r, 'PN_S2');
      const b3 = blockOf(r, 'PN_S3');
      // Rectangle over x 2.6..6 (S2 partly, S3) and the placement at (5, 2.5); S1 (x 0..2) outside.
      const a = screenOf(r, [2.6, 0, -0.6]);
      const b = screenOf(r, [6.0, 0, 3.2]);
      await drag(r, a, b);
      expect(sel(r)).toEqual([r.planner!.placementPath]);
      expect([...r.ui.getState().selectedBlocks].sort()).toEqual([b2, b3].sort());

      // Shift adds S1's block (placements untouched by a rectangle that holds none).
      const b1 = blockOf(r, 'PN_S1');
      await drag(r, screenOf(r, [0.4, 0, -0.5]), screenOf(r, [1.0, 0, 0.5]), { shiftKey: true });
      expect([...r.ui.getState().selectedBlocks].sort()).toEqual([b1, b2, b3].sort());
      expect(sel(r)).toEqual([r.planner!.placementPath]);
      // Ctrl toggles it out again.
      await drag(r, screenOf(r, [0.4, 0, -0.5]), screenOf(r, [1.0, 0, 0.5]), { ctrlKey: true });
      expect([...r.ui.getState().selectedBlocks].sort()).toEqual([b2, b3].sort());

      // Delete: blocks + placement in ONE step.
      const topo = (): string => JSON.stringify(netOf(r).paths.map((p) => [p.id, [...p.successors].sort()]).sort());
      const before = topo();
      const u0 = undoLen(r);
      key('Delete');
      await until(() => !blockIdsOf(r).includes(b2) && !r.planner!.node.parent, 'blocks and placement deleted');
      expect(undoLen(r)).toBe(u0 + 1);
      expect(blockIdsOf(r)).toEqual([b1]);
      expect(succOf(r, 'PN_S1')).toEqual([]);
      // Ctrl+Z (the scene undo) — one step restores blocks, edges and placement.
      await r.doc.undo();
      await until(() => blockIdsOf(r).length === 3 && !!r.v.registry!.getNode(r.planner!.placementPath), 'all restored');
      expect(topo()).toBe(before);
    });

    it(`${mode}: drag a selected block moves blocks + placement as ONE step; border edge released, inner edge kept, 0 kinks`, async () => {
      const r = rig = await bootRealRig(mode, { withPlanner: { x: 5, z: 2.5 } });
      await threeStraights(r);
      const b2 = blockOf(r, 'PN_S2');
      const b3 = blockOf(r, 'PN_S3');
      await drag(r, screenOf(r, [2.6, 0, -0.6]), screenOf(r, [6.0, 0, 3.2]));
      expect([...r.ui.getState().selectedBlocks].sort()).toEqual([b2, b3].sort());
      expect(sel(r)).toEqual([r.planner!.placementPath]);
      const px0 = r.planner!.node.position.x;
      const u0 = undoLen(r);
      // Grab S3 (selected) and drag it 1 m along -Z.
      const from = screenOf(r, pointOn('PN_S3'));
      const p3 = pointOn('PN_S3');
      const to = screenOf(r, [p3[0], 0, p3[2] - 1]);
      await drag(r, from, to);
      await until(() => undoLen(r) === u0 + 1, 'one undo step for the group move');
      for (let i = 0; i < 5; i++) await frame();
      expect(Math.abs(pointOn('PN_S3')[2] - (p3[2] - 1))).toBeLessThan(0.05);
      expect(Math.abs(r.planner!.node.position.z - (2.5 - 1))).toBeLessThan(0.05);
      expect(r.planner!.node.position.x).toBeCloseTo(px0, 2);
      expect(succOf(r, 'PN_S1')).toEqual([]); // border edge released (open end, no kink)
      expect(succOf(r, 'PN_S2')).toEqual(['PN_S3']); // inner edge kept
      expect(kinks(r)).toBe(0);
      // Selection survives the move.
      expect([...r.ui.getState().selectedBlocks].sort()).toEqual([b2, b3].sort());
    });
  }

  it('a composition-owned block (Generated.owner) is never selected by the marquee', async () => {
    const r = rig = await bootRealRig('planner', { withPlanner: { x: 5, z: 2.5 } });
    await threeStraights(r);
    const b3 = blockOf(r, 'PN_S3');
    const loc = (await import('../../src/plugins/path-network/path-network-scene')).snapshotNetwork(r.v as never).locator;
    const node = r.v.registry!.getNode(loc.blockNodes.get(b3)!)!;
    (node.userData.realvirtual as Record<string, unknown>).Generated = { owner: 'composition:yard' };
    await drag(r, screenOf(r, [2.6, 0, -0.6]), screenOf(r, [6.0, 0, 3.2]));
    expect(r.ui.getState().selectedBlocks).toEqual([blockOf(r, 'PN_S2')]);
    // A tiny click on empty floor still leaves the selection to the normal click handling.
    await clickAt(r, screenOf(r, [3, 0, 4]));
  });
});
