// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9r (8.11g) — live check markers at the path, in the REAL viewer,
 * planner AND des:
 *
 *  - building a network (open ends = info) reports its entries `quiet`: the
 *    Problems panel does NOT open by itself;
 *  - the open end has its ring at the path; hovering it shows the tip next to
 *    the cursor ("Path ends without a successor — Open end");
 *  - a kink in LOADED data (an edge written past the layout.path.* guard) is
 *    an error: ring + a label next to it ("Kink 5.0°"), reported loud (not quiet) — the
 *    entry kind that opens the panel (the open rule itself: problems-panel-dismiss.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 120_000 });
import type { Object3D, Sprite } from 'three';
import { freshOpId } from '../../src/core/ops/rv-op-utils';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import { getProblems, resetProblemsForTests } from '../../src/core/hmi/problems-store';
import { getProblemsPanelOpenForTests, setProblemsPanelOpen } from '../../src/core/hmi/ProblemsPanel';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import {
  bootRealRig,
  disposeRealRig,
  execCmd,
  frame,
  hover,
  pointOn,
  screenOf,
  until,
  type RealRig,
} from '../path/path-network-real-rig';

let rig: RealRig | null = null;

beforeEach(() => {
  resetProblemsForTests();
  setProblemsPanelOpen(false);
});

afterEach(() => {
  disposeRealRig(rig);
  rig = null;
  resetProblemsForTests();
});

const markerRoot = (r: RealRig): Object3D => r.v.scene.getObjectByName('__pathMarkers')!;
const tipEl = (): HTMLElement | null => document.querySelector('[data-testid="path-network-marker-tip"]');

describe('plan-628 9.9r live markers at the path (real viewer)', () => {
  for (const mode of ['planner', 'des'] as const) {
    it(`${mode}: open ends are quiet (panel stays closed) with a hover tip; a loaded kink gets a label and opens the panel`, async () => {
      const r = rig = await bootRealRig(mode);
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
      await until(() => getProblems().some((p) => p.id === 'path-network:path-open-end:PN_S1'), 'open-end entry published');
      const entry = getProblems().find((p) => p.id === 'path-network:path-open-end:PN_S1')!;
      expect(entry.quiet).toBe(true);
      expect(getProblemsPanelOpenForTests()).toBe(false);
      // The ring sits at the end of the path.
      const ring = markerRoot(r).getObjectByName('__pathMarker:path-open-end:PN_S1')!;
      expect(ring).toBeTruthy();
      expect(ring.position.x).toBeCloseTo(2, 3);
      // Info rings carry no permanent label …
      expect(markerRoot(r).children.some((c) => c.name.startsWith('__pathMarkerLabel:'))).toBe(false);
      // … their explanation shows next to the cursor on hover (a little past the end, off the line).
      await hover(r, screenOf(r, [2.12, 0, 0.12]));
      await until(() => tipEl()?.style.display === 'block', 'marker tip shown');
      expect(tipEl()!.textContent).toContain('Path ends without a successor — Open end');
      await hover(r, screenOf(r, [0.5, 0, 3]));
      await until(() => tipEl()?.style.display === 'none', 'tip hidden away from the marker');

      // A kink in loaded data: a second straight at +5° and the edge written by a raw field op.
      await execCmd(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 2, z: 0, headingDeg: 5 });
      const { locator } = snapshotNetwork(r.v as never);
      await r.doc.applyOp({
        id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'setField',
        nodePath: locator.pathNodes.get('PN_S1')!, componentType: 'Path', fieldName: 'successors', value: ['PN_S2'], prev: [],
      } as unknown as RvOp);
      r.viz.liveValidation!.markDirty();
      await until(() => getProblems().some((p) => p.id === 'path-network:path-kink:PN_S1>PN_S2'), 'kink entry');
      const kink = getProblems().find((p) => p.id === 'path-network:path-kink:PN_S1>PN_S2')!;
      expect(kink.severity).toBe('error');
      expect(kink.quiet).toBeUndefined();
      // An error is reported loud = news for the panel. (Whether it pops up here also depends on
      // the persistent acknowledgement list of this browser profile, so the rule is pinned with
      // fresh ids in problems-panel-dismiss.test.ts.)
      const label = markerRoot(r).getObjectByName('__pathMarkerLabel:path-kink:PN_S1>PN_S2') as Sprite | undefined;
      expect(label, 'label next to the kink ring').toBeTruthy();
      expect(label!.userData.pathIssueLabel).toBe('Kink 5.0°');
      expect(label!.position.x).toBeCloseTo(pointOn('PN_S1', 1)[0], 3);
      await frame();
    });
  }
});
