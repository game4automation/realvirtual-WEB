// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-detection-support-ray.test.ts — plan-2022 Phase 3: the support ray.
 *
 * The distinction the whole feature is about: a part LYING on something versus
 * a part hanging in nothing. Plus the three ways the ray could go wrong:
 *
 *  - it starts inside the part and reports the part as its own support (the MU
 *    instance meshes ARE registered raycast targets, so this would make the
 *    feature silently dead),
 *  - it fires every tick,
 *  - a buffer full of free parts fires hundreds of rays in one tick.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import {
  RVDropManager, MAX_PROBES_PER_TICK,
  type DropMU, type DropProbeHost,
} from '../src/core/engine/rv-drop-manager';
import type { DropDetectionConfig } from '../src/core/engine/rv-drop-detection';
import { __resetDropAlertStore } from '../src/core/hmi/drop-alert-store';
import type { SurfaceHit } from '../src/core/engine/rv-raycast-manager';

const DT = 1 / 60;

const CONFIG: DropDetectionConfig = {
  Enabled: true,
  GraceTime: 0.1,
  SupportProbeDistance: 50,
  SupportMode: 'GeometryBelow',
  SupportRecheckInterval: 0.5,
  DeleteUnsupported: false,
  DeleteDelay: 1,
};

/** Half extents of the test part (metres). */
const HALF = new Vector3(0.05, 0.05, 0.05);

function part(bottomY: number, name = 'Box'): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(0.3, bottomY + HALF.y, -0.7);
  node.updateMatrixWorld(true);
  const mu = new RVMovingUnit(node, 'Source_A', HALF.clone());
  mu.wasCarried = true; // E7: only a part that was carried can lose its support
  mu.updateAABB();
  return mu;
}

/** A probe host that records every ray and answers with a programmable hit. */
function recorder(answer: { distance: number; blocked?: boolean } | null) {
  const origins: Vector3[] = [];
  const directions: Vector3[] = [];
  const host: DropProbeHost = {
    raycastSurfaceAlong: (origin, direction, out: SurfaceHit) => {
      origins.push(origin.clone());
      directions.push(direction.clone());
      if (!answer) return false;
      out.distance = answer.distance;
      out.blocked = answer.blocked ?? true;
      out.path = null;
      return true;
    },
  };
  return { host, origins, directions, get count() { return origins.length; } };
}

function makeWorld(probe: DropProbeHost, config: Partial<DropDetectionConfig> = {}) {
  const mgr = new RVDropManager();
  const authority = new Object3D();
  mgr.setTransportHost({ surfaceVerticalReach: 0.1, gripTargets: [] });
  mgr.setProbeHost(probe);
  mgr.register(authority, { ...CONFIG, ...config },
    { dropActive: null, dropCount: null, resetDrops: null });
  const run = (seconds: number, mus: DropMU[]) => {
    const ticks = Math.round(seconds / DT);
    for (let i = 0; i < ticks; i++) {
      mgr.beginTick();
      for (const mu of mus) mgr.evaluate(mu, DT);
      mgr.endTick(DT);
    }
  };
  const reported = () => mgr.activeDrops.map((d) => d.muKey);
  return { mgr, run, reported };
}

describe('DropDetection — support ray (plan-2022)', () => {
  beforeEach(() => { __resetDropAlertStore(); });

  describe('ray geometry', () => {
    it('REGRESSION: the ray starts BELOW the part\'s own AABB, never inside it', () => {
      const rec = recorder(null);
      const w = makeWorld(rec.host);
      const mu = part(1.0);
      w.run(0.2, [mu]);
      expect(rec.count).toBeGreaterThan(0);
      const origin = rec.origins[0];
      // The oracle is computed here, independently of the production code: the
      // origin must lie strictly outside the part's own box, below it.
      expect(origin.y).toBeLessThan(mu.aabb.min.y);
      expect(origin.y).toBeGreaterThan(mu.aabb.min.y - 0.01);  // just below, not metres off
      // And centred in X/Z, so it looks at what is under the part's middle.
      expect(origin.x).toBeCloseTo(mu.aabb.center.x, 6);
      expect(origin.z).toBeCloseTo(mu.aabb.center.z, 6);
    });

    it('casts straight down in world coordinates', () => {
      const rec = recorder(null);
      const w = makeWorld(rec.host);
      w.run(0.2, [part(1.0)]);
      expect(rec.directions[0].toArray()).toEqual([0, -1, 0]);
    });
  });

  describe('what counts as support', () => {
    it('a plate 5 mm below without a component (blocked hit) counts as support', () => {
      const rec = recorder({ distance: 0.005, blocked: true });
      const w = makeWorld(rec.host);
      const mu = part(1.0);
      w.run(1.0, [mu]);
      expect(w.reported()).toEqual([]);
      expect(mu.supported).toBe(true);
    });

    it('a resolved node below counts as support just the same', () => {
      const rec = recorder({ distance: 0.01, blocked: false });
      const w = makeWorld(rec.host);
      w.run(1.0, [part(1.0)]);
      expect(w.reported()).toEqual([]);
    });

    it('a hit exactly at SupportProbeDistance still counts', () => {
      const rec = recorder({ distance: 0.05 });
      const w = makeWorld(rec.host, { SupportProbeDistance: 50 });
      w.run(1.0, [part(1.0)]);
      expect(w.reported()).toEqual([]);
    });

    it('a hit 1 mm beyond SupportProbeDistance does not', () => {
      const rec = recorder({ distance: 0.051 });
      const w = makeWorld(rec.host, { SupportProbeDistance: 50 });
      const mu = part(1.0);
      w.run(1.0, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
    });

    it('no hit at all = unsupported', () => {
      const rec = recorder(null);
      const w = makeWorld(rec.host);
      const mu = part(2.0);
      w.run(1.0, [mu]);
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
    });

    it('without a raycaster nothing is ever reported (never cry drop blindly)', () => {
      const mgr = new RVDropManager();
      mgr.setTransportHost({ surfaceVerticalReach: 0.1, gripTargets: [] });
      mgr.setProbeHost(null);
      mgr.register(new Object3D(), CONFIG, { dropActive: null, dropCount: null, resetDrops: null });
      const mu = part(2.0);
      for (let i = 0; i < 120; i++) { mgr.beginTick(); mgr.evaluate(mu, DT); mgr.endTick(DT); }
      expect(mgr.activeDrops).toEqual([]);
    });
  });

  describe('cadence and budget', () => {
    it('does NOT fire once per tick — the recheck interval gates it', () => {
      // A supported part keeps probing: 2 s at 0.5 s interval is ~4 rays, not 120.
      const rec = recorder({ distance: 0.005 });
      const w = makeWorld(rec.host, { SupportRecheckInterval: 0.5, GraceTime: 0 });
      w.run(2.0, [part(1.0)]);
      expect(rec.count).toBeLessThanOrEqual(6);
      expect(rec.count).toBeGreaterThanOrEqual(3);
    });

    it('SupportMode StateOnly fires NO ray at all', () => {
      const rec = recorder(null);
      const w = makeWorld(rec.host, { SupportMode: 'StateOnly' });
      const mu = part(1.0);
      w.run(1.0, [mu]);
      expect(rec.count).toBe(0);
      expect(w.mgr.probeCount).toBe(0);
      // …and reports on the state conditions alone.
      expect(w.reported()).toEqual([`mu:${mu.id}`]);
    });

    it('at most MAX_PROBES_PER_TICK rays per tick, and the rest follow', () => {
      const rec = recorder(null);
      const w = makeWorld(rec.host, { GraceTime: 0 });
      const mus = Array.from({ length: 40 }, (_, i) => part(1.0 + i * 0.5, `Box_${i}`));
      // One single tick: the cap must hold.
      w.mgr.beginTick();
      for (const mu of mus) w.mgr.evaluate(mu, DT);
      w.mgr.endTick(DT);
      expect(rec.count).toBeLessThanOrEqual(MAX_PROBES_PER_TICK);
      expect(rec.count).toBe(MAX_PROBES_PER_TICK);
      // And within a few more ticks every one of the 40 is worked off.
      w.run(0.2, mus);
      expect(w.reported().length).toBe(40);
    });
  });
});
