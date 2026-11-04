// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9n (8.11c) — typed dimensions during the click-layout preview
 * (and with an armed catalog tool), by keyboard in the REAL viewer, planner
 * AND des:
 *
 *  - typing digits opens the prompt at the cursor; on a straight preview the
 *    number is the LENGTH: "3.5" Enter places a 3.5 m straight (one step);
 *  - on a curve preview the number is the ANGLE: "45" Enter places a 45° curve;
 *  - Tab switches the field: "2" Tab "90" Enter = 90° curve + 2 m straight;
 *    a suffix (`m`, `°`/`d`) forces the field;
 *  - Esc clears the prompt (nothing placed), a second Esc cancels;
 *  - with an armed straight tool, "3.5" Enter places a 3.5 m straight.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 120_000 });
import {
  blockOf,
  bootRealRig,
  clickPath,
  disposeRealRig,
  execCmd,
  frame,
  hover,
  key,
  netOf,
  screenOf,
  typeKeys,
  undoLen,
  until,
  type RealRig,
} from '../path/path-network-real-rig';

let rig: RealRig | null = null;

afterEach(() => {
  disposeRealRig(rig);
  rig = null;
});

const blocks = (r: RealRig) => netOf(r).blocks ?? [];
const newest = (r: RealRig) => blocks(r).find((b) => b.id === r.ui.getState().selectedBlock?.id)!;
const promptEl = (): HTMLElement | null => document.querySelector('[data-testid="path-network-typed"]');

describe('plan-628 9.9n typed dimensions (real viewer, keyboard)', () => {
  for (const mode of ['planner', 'des'] as const) {
    it(`${mode}: "3.5" Enter = length, "45" Enter = angle, Tab switches, Esc clears; tool ghost takes the typed length`, async () => {
      const r = rig = await bootRealRig(mode);
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
      await clickPath(r, 'PN_S1');
      expect(r.ui.getState().clickLayout).toBe(true);

      // Straight preview → the number is the length.
      await hover(r, screenOf(r, [4, 0, 0]));
      typeKeys('3.5');
      expect(r.ui.getState().typedText).toBe('Length: 3.5 m');
      expect(promptEl()?.style.display).toBe('block');
      expect(r.ui.currentClickPlan!.steps).toEqual([{ kind: 'straight', lengthM: 3.5 }]);
      let u = undoLen(r);
      key('Enter');
      await until(() => blocks(r).length === 2, 'typed straight placed');
      expect(undoLen(r)).toBe(u + 1);
      expect(newest(r).extras.kind).toBe('straight');
      expect(newest(r).extras.params.lengthM).toBe(3.5);
      expect(r.ui.getState().typedText).toBeNull();

      // Curve preview (pointer to the side) → the number is the angle.
      await hover(r, screenOf(r, [6.5, 0, -3]));
      expect(r.ui.currentClickPlan!.side).toBe('left');
      typeKeys('45');
      expect(r.ui.getState().typedText).toBe('Angle: 45°');
      u = undoLen(r);
      key('Enter');
      await until(() => blocks(r).length === 3, 'typed curve placed');
      expect(undoLen(r)).toBe(u + 1);
      expect(newest(r).extras.kind).toBe('curve');
      expect(newest(r).extras.params.degrees).toBe(45);

      // Tab switches: 2 (length) Tab 90 (angle) → curve 90° + straight 2 m, ONE step.
      await hover(r, screenOf(r, [8.5, 0, -2]));
      const fieldFirst = r.ui.getState().typedText;
      expect(fieldFirst).toBeNull();
      typeKeys('2m');
      key('Tab');
      typeKeys('90');
      expect(r.ui.getState().typedText).toBe('Angle: 90°  ·  Length: 2 m');
      u = undoLen(r);
      key('Enter');
      await until(() => blocks(r).length === 5, 'curve + straight placed');
      expect(undoLen(r)).toBe(u + 1);
      const kinds = blocks(r).map((b) => b.extras.kind).sort();
      expect(kinds).toEqual(['curve', 'curve', 'straight', 'straight', 'straight']);
      expect(newest(r).extras.params.lengthM).toBe(2);

      // Esc clears the prompt, nothing placed; a second Esc cancels the selection.
      typeKeys('7');
      expect(r.ui.getState().typedText).not.toBeNull();
      u = undoLen(r);
      key('Escape');
      expect(r.ui.getState().typedText).toBeNull();
      expect(r.ui.getState().clickLayout).toBe(true);
      key('Escape');
      await frame();
      expect(r.ui.getState().clickLayout).toBe(false);
      expect(undoLen(r)).toBe(u);

      // Armed straight tool: "3.5" Enter places a 3.5 m straight at the pointer.
      await r.ui.pickCatalog('straight-2');
      expect(r.ui.getState().toolId).toBe('straight-2');
      await hover(r, screenOf(r, [2, 0, 4]));
      typeKeys('3.5');
      expect(r.ui.getState().typedText).toBe('Length: 3.5 m');
      u = undoLen(r);
      key('Enter');
      await until(() => blocks(r).length === 6, 'tool straight placed');
      expect(undoLen(r)).toBe(u + 1);
      const placed = blocks(r).find((b) => !['PN_S1'].includes(b.id) && b.extras.kind === 'straight' && Math.abs(b.extras.pose[1] - 4) < 0.5)!;
      expect(placed.extras.params.lengthM).toBe(3.5);
      expect(blockOf(r, 'PN_S1')).toBeTruthy();
    });
  }
});
