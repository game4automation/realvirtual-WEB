// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9p (8.11e) — "Replace with …" by mouse in the REAL viewer,
 * planner AND des: right-click on the curve of Straight → Curve R → Straight
 * opens the context menu with a "Replace with …" submenu (Straight, Curve
 * left — not the identical Curve right); choosing Straight replaces the block
 * at the same start pose in ONE undo step, the predecessor edge stays, the
 * downstream straight moves onto the new end (edge kept, 0 kinks / gaps);
 * undo restores the curve; a junction block offers no "Replace with …".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 120_000 });
import { headingOf, specEnds } from '../../src/core/engine/rv-path-blocks';
import { PATH_MENU_IDS, replaceMenuId } from '../../src/plugins/path-network/path-network-interaction';
import type { ResolvedContextMenuItem } from '../../src/core/hmi/context-menu-store';
import {
  bootRealRig,
  disposeRealRig,
  execCmd,
  frame,
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

const kinksOrGaps = (r: RealRig): number => r.viz.liveValidation?.run().issues.filter((i) => i.code === 'path-kink' || i.code === 'path-link-gap').length ?? 0;
const blockById = (r: RealRig, id: string) => netOf(r).blocks!.find((b) => b.id === id)!;

/** A right click (pointerdown button 2 + contextmenu) on a path, as the browser delivers it. */
async function rightClickPath(r: RealRig, pathId: string, f = 0.5): Promise<void> {
  await until(() => r.viz.getLineObjects().has(pathId), `line of ${pathId}`);
  r.v.scene.updateMatrixWorld(true);
  const at = screenOf(r, pointOn(pathId, f));
  r.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 2, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { ...at, button: 2, bubbles: true }));
  r.canvas.dispatchEvent(new MouseEvent('contextmenu', { ...at, button: 2, bubbles: true, cancelable: true }));
  await frame();
}

const childrenOf = (item: ResolvedContextMenuItem | undefined): ResolvedContextMenuItem[] => (Array.isArray(item?.children) ? item!.children : []);

describe('plan-628 9.9p Replace with … (real viewer, context menu)', () => {
  for (const mode of ['planner', 'des'] as const) {
    it(`${mode}: replace the curve with a straight — same start, chain follows, one undo step`, async () => {
      const r = rig = await bootRealRig(mode);
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
      await execCmd(r, 'layout.path.place', { block: 'curve', degrees: 90, side: 'right', atPath: 'PN_S1', atEnd: 'end' });
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, atPath: 'PN_C1', atEnd: 'end' });
      const poseBefore = [...blockById(r, 'PN_Block_2').extras.pose];

      await rightClickPath(r, 'PN_C1');
      const snap = r.v.contextMenu.getSnapshot();
      expect(snap.open).toBe(true);
      const replace = snap.items.find((i) => i.id === PATH_MENU_IDS.replace);
      expect(replace, `items ${JSON.stringify(snap.items.map((i) => i.id))}`).toBeTruthy();
      const choices = childrenOf(replace);
      expect(choices.map((c) => c.id)).toEqual([replaceMenuId('straight'), replaceMenuId('curve-l')]);

      const u0 = undoLen(r);
      choices[0].action!(snap.target!);
      r.v.contextMenu.close();
      await until(() => undoLen(r) === u0 + 1, 'one undo step for the replace');
      await until(() => blockById(r, 'PN_Block_2').extras.kind === 'straight', 'replaced by a straight');
      expect(blockById(r, 'PN_Block_2').extras.pose).toEqual(poseBefore); // same start pose
      expect(netOf(r).paths.find((p) => p.id === 'PN_C1')!.block).toBe('PN_Block_2'); // id kept (E69)
      expect(succOf(r, 'PN_S1')).toEqual(['PN_C1']);
      expect(succOf(r, 'PN_C1')).toEqual(['PN_S2']);
      const s2 = specEnds(netOf(r).paths.find((p) => p.id === 'PN_S2')!.segments)!.start;
      expect(s2.position[0]).toBeCloseTo(4, 4);
      expect(s2.position[2]).toBeCloseTo(0, 4);
      expect(headingOf(s2.tangent)).toBeCloseTo(0, 4);
      expect(kinksOrGaps(r)).toBe(0);
      expect(r.ui.getState().selectedBlock?.id).toBe('PN_Block_2');

      // Undo restores the curve (and the chain where it was).
      await r.doc.undo();
      await until(() => blockById(r, 'PN_Block_2').extras.kind === 'curve', 'undo restores the curve');
      expect(succOf(r, 'PN_C1')).toEqual(['PN_S2']);
      expect(kinksOrGaps(r)).toBe(0);

      // A junction block: no "Replace with …".
      await execCmd(r, 'layout.path.junction', { kind: 'diverge', pathId: 'PN_S1', s: 1 });
      const junction = netOf(r).blocks!.find((b) => b.extras.kind === 'diverge')!;
      const branch = netOf(r).paths.find((p) => p.block === junction.id)!;
      await rightClickPath(r, branch.id, 0.7);
      const jItems = r.v.contextMenu.getSnapshot().items.map((i) => i.id);
      expect(jItems).not.toContain(PATH_MENU_IDS.replace);
      r.v.contextMenu.close();
    });
  }
});
