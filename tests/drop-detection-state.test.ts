// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-detection-state.test.ts — plan-2022 Phase 2: the state stage.
 *
 * The four conditions and the five exclusions, and above all the TWO cases the
 * whole feature stands or falls on:
 *
 *  - the measured Festo constellation (2026-10-28): 105 unsupported parts
 *    carried a SET `currentSurface` pointing at a conveyor 445 mm lower. The
 *    original four conditions counted them as properly carried and would have
 *    reported nothing. They must be reported now.
 *  - the counter-check: the same part owned by a physics engine must NOT be
 *    reported, because there falling is the intended behaviour.
 */

import { setDropDetectionEnabled } from '../src/core/drop-detection-settings-store';
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVGripTarget } from '../src/core/engine/rv-grip-target';
import { RVDropManager, type DropMU, type DropProbeHost } from '../src/core/engine/rv-drop-manager';
import type { DropDetectionConfig } from '../src/core/engine/rv-drop-detection';
import { __resetDropAlertStore } from '../src/core/hmi/drop-alert-store';
import type { SurfaceHit } from '../src/core/engine/rv-raycast-manager';

const DT = 1 / 60;

// ── The measured Festo numbers (metres) ────────────────────────────────
/** Collider bottom of the unsupported part. */
const PART_Y = 1.285;
/** Top of the conveyor its `currentSurface` pointed at — 445 mm lower. */
const BELT_TOP = 0.84;
/** The transport's own tolerance (`RVTransportManager.surfaceVerticalReach`). */
const REACH = 0.1;

const CONFIG: DropDetectionConfig = {
  Enabled: true,
  GraceTime: 0.5,
  SupportProbeDistance: 50,
  SupportMode: 'GeometryBelow',
  SupportRecheckInterval: 0.5,
  DeleteUnsupported: false,
  DeleteDelay: 1,
};

/** A belt whose TOP sits at `top`; half height 0.04 m. */
function belt(top: number, name = 'Belt'): RVTransportSurface {
  const node = new Object3D();
  node.name = name;
  node.position.set(0, top - 0.04, 0);
  node.updateMatrixWorld(true);
  const s = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(0.5, 0.04, 2)));
  s.TransportDirection.set(0, 0, 1);
  s.reapplyConfig();
  s.initTransport();
  return s;
}

/** A part whose collider BOTTOM sits at `bottomY`; half height 0.05 m. */
function part(bottomY: number, name = 'Box_7', source = 'Source_Infeed'): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(0, bottomY + 0.05, 0);
  node.updateMatrixWorld(true);
  const mu = new RVMovingUnit(node, source, new Vector3(0.05, 0.05, 0.05));
  mu.wasCarried = true; // E7: only a part that was carried can lose its support
  mu.updateAABB();
  return mu;
}

/** A probe host that answers "nothing below" — the honest empty-space case. */
const NOTHING_BELOW: DropProbeHost = {
  raycastSurfaceAlong: () => false,
};

/** A probe host that reports a hit `distance` metres down. */
function hitAt(distance: number, blocked = true): DropProbeHost {
  return {
    raycastSurfaceAlong: (_o, _d, out: SurfaceHit) => {
      out.distance = distance;
      out.blocked = blocked;
      out.path = blocked ? null : 'Table';
      return true;
    },
  };
}

function makeWorld(opts: {
  config?: Partial<DropDetectionConfig>;
  probe?: DropProbeHost;
  gripTargets?: RVGripTarget[];
} = {}) {
  const mgr = new RVDropManager();
  const authority = new Object3D();
  authority.name = 'Scene';
  const gripTargets = opts.gripTargets ?? [];
  mgr.setTransportHost({ surfaceVerticalReach: REACH, gripTargets });
  mgr.setProbeHost(opts.probe ?? NOTHING_BELOW);
  mgr.register(authority, { ...CONFIG, ...opts.config },
    { dropActive: null, dropCount: null, resetDrops: null });

  /** Run `seconds` of simulated time over the given MUs, as the transport does. */
  const run = (seconds: number, mus: DropMU[]) => {
    const ticks = Math.round(seconds / DT);
    for (let i = 0; i < ticks; i++) {
      mgr.beginTick();
      for (const mu of mus) mgr.evaluate(mu, DT);
      mgr.endTick(DT);
    }
  };
  const reported = () => mgr.activeDrops.map((d) => d.muKey);
  return { mgr, authority, gripTargets, run, reported };
}

describe('DropDetection — state stage (plan-2022)', () => {
  beforeEach(() => {
    __resetDropAlertStore();
  });

  // ── The Festo proof ───────────────────────────────────────────────
  describe('the measured Festo constellation', () => {
    it('REPORTS a part whose assigned surface is 445 mm below it', () => {
      const w = makeWorld();
      const mu = part(PART_Y);
      // Exactly what was measured: a SET currentSurface, 445 mm lower,
      // owner 'transport', physicsBodyId null, blocked true.
      mu.currentSurface = belt(BELT_TOP);
      mu.blocked = true;
      mu.physicsBodyId = null;
      expect(mu.owner).toBe('transport');
      expect(mu.aabb.min.y - (mu.currentSurface.aabb.max.y)).toBeCloseTo(0.445, 3);

      w.run(0.6, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
      expect(w.mgr.activeDrops[0].muName).toBe('Box_7');
      expect(w.mgr.activeDrops[0].sourceName).toBe('Source_Infeed');
    });

    it('COUNTER-CHECK: the same part owned by Rapier is NOT reported', () => {
      const w = makeWorld();
      const mu = part(PART_Y);
      mu.currentSurface = belt(BELT_TOP);
      mu.owner = 'rapier';   // a WebPhysicsZone has it: falling is intended
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([]);
    });

    it('COUNTER-CHECK: the same part owned by Box2D is NOT reported', () => {
      const w = makeWorld();
      const mu = part(PART_Y);
      mu.currentSurface = belt(BELT_TOP);
      mu.owner = 'box2d';
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([]);
    });

    it('a part the SAME belt really carries is NOT reported', () => {
      const w = makeWorld();
      // Collider bottom 20 mm above the belt top — inside the 100 mm reach.
      const mu = part(BELT_TOP + 0.02);
      mu.currentSurface = belt(BELT_TOP);
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([]);
    });

    it('the plausibility boundary is the transport\'s own vertical reach', () => {
      const inside = makeWorld();
      const muIn = part(BELT_TOP + REACH - 0.001);
      muIn.currentSurface = belt(BELT_TOP);
      inside.run(1.0, [muIn]);
      expect(inside.reported()).toEqual([]);

      const outside = makeWorld();
      const muOut = part(BELT_TOP + REACH + 0.001);
      muOut.currentSurface = belt(BELT_TOP);
      outside.run(1.0, [muOut]);
      expect(outside.reported()).toEqual([`mu:${muOut.id}`]);
    });

    it('a surface entirely ABOVE the part does not carry it either', () => {
      const w = makeWorld();
      const mu = part(0.2);
      mu.currentSurface = belt(1.5);  // a main belt over the return belt
      w.run(1.0, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
    });
  });

  // ── The four conditions ───────────────────────────────────────────
  describe('the four conditions', () => {
    it('reports a genuinely free part after the grace time', () => {
      const w = makeWorld();
      const mu = part(1.0);
      w.run(0.6, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
    });

    it('OK on the card removes the reported part and clears the card (Thomas 2026-11-04)', () => {
      const w = makeWorld();
      const mu = part(1.0);
      w.run(0.6, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
      w.mgr.acknowledge(`mu:${mu.id}`);
      expect(mu.markedForRemoval).toBe(true);
      expect(w.reported()).toEqual([]);
      // Marked for removal: never reported again while the transport tick disposes it.
      w.run(0.6, [mu]);
      expect(w.reported()).toEqual([]);
    });

    it('E7: a part that was never carried is NOT reported (a static hose, a pre-placed pallet)', () => {
      const w = makeWorld();
      const mu = part(1.0);
      mu.wasCarried = false;
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([]);
    });

    it('E7: held once, then let go, is reported - the part LOST its support', () => {
      const w = makeWorld();
      const mu = part(1.0);
      mu.wasCarried = false;
      mu.heldBy = 'grip';
      w.run(0.2, [mu]);
      expect(mu.wasCarried).toBe(true);
      mu.heldBy = null;
      w.run(0.6, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
    });

    it('does NOT report before the grace time has passed', () => {
      const w = makeWorld({ config: { GraceTime: 0.5 } });
      const mu = part(1.0);
      w.run(0.4, [mu]);
      expect(w.reported()).toEqual([]);
    });

    for (const holder of ['grip', 'zone', 'connection', 'user'] as const) {
      it(`never reports a part held by '${holder}'`, () => {
        const w = makeWorld();
        const mu = part(1.0);
        mu.heldBy = holder;
        w.run(2.0, [mu]);
        expect(w.reported()).toEqual([]);
      });
    }

    it('never reports a part seated on a GripTarget', () => {
      const node = new Object3D();
      node.name = 'Seat';
      const target = new RVGripTarget(node);
      const w = makeWorld({ gripTargets: [target] });
      const mu = part(1.0);
      target.occupiedBy = mu;
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([]);
    });

    it('never reports a passive load on a carrier part', () => {
      const w = makeWorld();
      const carrier = part(0.5, 'Pallet');
      const load = part(1.0, 'Lid');
      load.loadedOn = carrier;
      w.run(2.0, [load]);
      expect(w.reported()).toEqual([]);
    });
  });

  // ── The exclusions ────────────────────────────────────────────────
  describe('exclusions', () => {
    it('never reports a part marked for removal', () => {
      const w = makeWorld();
      const mu = part(1.0);
      mu.markedForRemoval = true;
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([]);
    });

    it('never reports a part mid end-of-line vanish', () => {
      const w = makeWorld();
      const mu = part(1.0);
      mu.vanishElapsed = 0.1;
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([]);
    });

    it('reports without a DropDetection component using schema defaults (E5)', () => {
      const mgr = new RVDropManager();
      mgr.setTransportHost({ surfaceVerticalReach: REACH, gripTargets: [] });
      mgr.setProbeHost(NOTHING_BELOW);
      const mu = part(1.0);
      for (let i = 0; i < 200; i++) { mgr.beginTick(); mgr.evaluate(mu, DT); mgr.endTick(DT); }
      expect(mgr.activeDrops).toHaveLength(1);
      expect(mgr.isArmed).toBe(true);
      expect(mu.unsupportedTime).toBeGreaterThanOrEqual(mgr.config.GraceTime);
    });

    it('Options off overrides an enabled component and resets the candidate clock', () => {
      const w = makeWorld();
      const mu = part(1.0);
      w.run(0.25, [mu]);
      setDropDetectionEnabled(false);
      try {
        w.run(2, [mu]);
        expect(w.mgr.isArmed).toBe(false);
        expect(w.reported()).toEqual([]);
        expect(mu.unsupportedTime).toBe(0);
      } finally { setDropDetectionEnabled(true); }
      w.run(0.25, [mu]);
      expect(w.reported()).toEqual([]);
      w.run(0.4, [mu]);
      expect(w.reported()).toHaveLength(1);
    });

    it('Options off pauses deletion while existing reports stay latched', () => {
      const w = makeWorld({ config: { DeleteUnsupported: true, DeleteDelay: 1 } });
      const mu = part(1.0);
      w.run(0.7, [mu]);
      expect(w.reported()).toHaveLength(1);
      setDropDetectionEnabled(false);
      try {
        w.run(3, [mu]);
        expect(mu.markedForRemoval).toBe(false);
        expect(w.reported()).toHaveLength(1);
      } finally { setDropDetectionEnabled(true); }
      w.run(1.1, [mu]);
      expect(mu.markedForRemoval).toBe(true);
    });

    it('reports nothing while Enabled is off', () => {
      const w = makeWorld({ config: { Enabled: false } });
      const mu = part(1.0);
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([]);
      expect(w.mgr.isArmed).toBe(false);
    });
  });

  // ── The grace clock ──────────────────────────────────────────────
  describe('the grace clock', () => {
    it('resets when a surface picks the part up again', () => {
      const w = makeWorld();
      const mu = part(1.0);
      w.run(0.4, [mu]);                   // 0.4 s of the 0.5 s grace
      mu.currentSurface = belt(1.0 - 0.02); // caught just in time
      w.run(0.4, [mu]);
      expect(mu.unsupportedTime).toBe(0);
      expect(w.reported()).toEqual([]);
    });

    it('a report LATCHES — it stays after the part is supported again', () => {
      const w = makeWorld();
      const mu = part(1.0);
      w.run(0.6, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
      mu.currentSurface = belt(1.0 - 0.02);
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);   // the finding stands
    });
  });

  // ── The support ray decides (stage 2 is wired to stage 1) ────────
  describe('support below', () => {
    it('a part 5 mm above a plain plate without any component is NOT reported', () => {
      const w = makeWorld({ probe: hitAt(0.005, true) });  // `blocked` = opaque, unowned
      const mu = part(1.0);
      w.run(2.0, [mu]);
      expect(w.reported()).toEqual([]);
      expect(mu.supported).toBe(true);
    });

    it('a part 2 m above nothing IS reported', () => {
      const w = makeWorld({ probe: NOTHING_BELOW });
      const mu = part(2.0);
      w.run(0.6, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
    });

    it('a hit beyond SupportProbeDistance does not count as support', () => {
      const w = makeWorld({ probe: hitAt(0.2), config: { SupportProbeDistance: 50 } });
      const mu = part(1.0);
      w.run(0.6, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
    });
  });

  // Codex review 2026-11-04: the carriage history (E7) must also be kept while the
  // detection is switched off, or a part released then is never reported later.
  it('records the carriage of a part while detection is off and reports it once switched on', () => {
    const w = makeWorld({ config: { Enabled: false } });
    const mu = part(BELT_TOP + 0.3);
    mu.wasCarried = undefined;
    mu.heldBy = { kind: 'grip' } as never;
    w.run(0.2, [mu]);
    expect(mu.wasCarried).toBe(true);
    mu.heldBy = null;
    w.mgr.register(w.authority, { ...CONFIG, Enabled: true }, { dropActive: null, dropCount: null, resetDrops: null });
    w.run(0.6, [mu]);
    expect(w.reported()).toEqual([`mu:${mu.id}`]);
  });
});
