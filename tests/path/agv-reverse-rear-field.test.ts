// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.4 (F6/F9) — the scanner field at the LEADING end.
 *
 * Through a full stub cycle (forward approach, reverse leg, dock, forward exit)
 * the motion snapshot the overlay reads (`AgvMotionInfo`) reports the travel
 * direction and the rear reach; on the reverse leg the field lengths follow the
 * slower ReverseSpeed (protective ≤ fieldLength(0.3 m/s)); the signals
 * `Reverse` / `FieldRear` follow the applied plan in both direction changes,
 * observed over at least two plans after each change (a 1 s stop on the reverse
 * leg forces a second reverse plan). The restart lock and the
 * hysteresis in reverse are covered by agv-reverse-field-opposite (9.16), the
 * overlay geometry and the body by agv-reverse-overlay (9.13).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultAgvFleet, type AgvMotionInfo } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { clearShared, sig } from '../helpers/agv-harness';
import { stubLayout, makeStubWorld, forkCfg, FORK, FORK_MESH, delay, type Mode } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

/** Protective field length (m) at speed v with the Agv defaults: v·0.2 + v²/(2·0.5) + 0.2. */
const P = (v: number): number => v * 0.2 + (v * v) / (2 * 0.5) + 0.2;

describe('plan-595 9.4 — field at the leading end', () => {
  for (const mode of ['continuous', 'animated'] as Mode[]) {
    it(`${mode}: motion info, field lengths and signals follow the direction through a stub cycle`, () => {
      stubLayout();
      const w = makeStubWorld(mode, [{ name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK }], 300);
      const fleet = getDefaultAgvFleet();
      let done = false;
      getDefaultPathDockRegistry().register('S2', { onVehicleArrive: (_id, rel) => delay(4, rel) });
      fleet.get('F')!.assign({ destination: 'S2', approach: 'reverse', onServiceEnd: () => { done = true; fleet.get('F')!.clear(); } });
      const info: AgvMotionInfo = { speed: 0, field: 'clear', protectiveLength: 0, warningLength: 0, front: 0, rear: 0, width: 0, dir: 1, scanner: false };
      const plansAfter = { rev: new Set<number>(), fwd: new Set<number>() };
      let revFrames = 0, fwdAfterFrames = 0, maxRevProt = 0, badInfo = 0, badSig = 0, sawRev = false;
      while (!w.done()) {
        w.step();
        expect(fleet.get('F')!.motion!(info)).toBe(true);
        const dir = w.mb.planDirOf('F');
        if (info.dir !== dir || Math.abs(info.rear - FORK.rear) > 1e-6 || Math.abs(info.front - FORK.front) > 1e-6) badInfo++;
        if (sig(w.hostOf(), 'F', 'Reverse') !== (dir === -1) || sig(w.hostOf(), 'F', 'FieldRear') !== (dir === -1)) badSig++;
        if (dir === -1) {
          // 2 s into the reverse leg: a 1 s stop and go on — the reverse leg then has two plans.
          if (!sawRev) delay(2, () => w.pause('F', 1));
          sawRev = true;
          revFrames++;
          plansAfter.rev.add(w.mb.versionOf('F'));
          maxRevProt = Math.max(maxRevProt, info.protectiveLength);
        } else if (sawRev) {
          fwdAfterFrames++;
          plansAfter.fwd.add(w.mb.versionOf('F'));
        }
        if (done && fwdAfterFrames > 60 * 10) break;
      }
      w.dispose();
      expect(done).toBe(true);
      expect(revFrames).toBeGreaterThan(0);
      expect(plansAfter.rev.size).toBeGreaterThanOrEqual(2);   // at least two plans after the change to reverse
      expect(plansAfter.fwd.size).toBeGreaterThanOrEqual(2);   // … and after the change back
      expect(badInfo).toBe(0);
      expect(badSig).toBe(0);
      expect(maxRevProt).toBeGreaterThan(P(0) + 1e-3);         // the field grew with the reverse speed …
      expect(maxRevProt).toBeLessThanOrEqual(P(0.3) + 1e-9);   // … but never beyond the ReverseSpeed field
    }, 120000);
  }
});
