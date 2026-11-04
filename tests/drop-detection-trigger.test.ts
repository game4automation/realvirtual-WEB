// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-detection-trigger.test.ts — plan-2022 Phase 6: producing the case on
 * purpose.
 *
 * The point of the trigger is that it does NOT fake a report: it only releases
 * a part from what holds it, and the real detector then answers on real state.
 * These tests pin exactly that — and that the trigger refuses rather than doing
 * nothing silently when the feature is not armed.
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
import {
  diagUnsupportPart, diagDropStatus, diagDropReset,
  createDropDiagnosticsCommandDescriptors,
} from '../src/core/hmi/drop-diagnostics-commands';
import type { CommandContext } from '../src/core/hmi/rv-command-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import { __resetDropAlertStore } from '../src/core/hmi/drop-alert-store';

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

const NOTHING_BELOW: DropProbeHost = { raycastSurfaceAlong: () => false };

function belt(top: number): RVTransportSurface {
  const node = new Object3D();
  node.name = 'Belt_In';
  node.position.set(0, top - 0.04, 0);
  node.updateMatrixWorld(true);
  const s = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(0.5, 0.04, 2)));
  s.TransportDirection.set(0, 0, 1);
  s.reapplyConfig();
  s.initTransport();
  return s;
}

function part(bottomY: number, name = 'Box_7'): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(0, bottomY + 0.05, 0);
  node.updateMatrixWorld(true);
  const mu = new RVMovingUnit(node, 'Source_A', new Vector3(0.05, 0.05, 0.05));
  mu.wasCarried = true; // E7: only a part that was carried can lose its support
  mu.updateAABB();
  return mu;
}

function makeWorld(opts: { armed?: boolean; gripTargets?: RVGripTarget[] } = {}) {
  const mgr = new RVDropManager();
  const gripTargets = opts.gripTargets ?? [];
  mgr.setTransportHost({ surfaceVerticalReach: 0.1, gripTargets });
  mgr.setProbeHost(NOTHING_BELOW);
  if (opts.armed !== false) {
    mgr.register(new Object3D(), CONFIG, { dropActive: null, dropCount: null, resetDrops: null });
  }
  const mus: DropMU[] = [];
  const viewer = {
    dropManager: mgr,
    transportManager: { mus },
  } as unknown as RVViewer;
  const ctx = { viewer } as unknown as CommandContext;
  const run = (seconds: number) => {
    const ticks = Math.round(seconds / DT);
    for (let i = 0; i < ticks; i++) {
      mgr.beginTick();
      for (const mu of mus) mgr.evaluate(mu, DT);
      mgr.endTick(DT);
    }
  };
  return { mgr, mus, viewer, ctx, gripTargets, run };
}

beforeEach(() => __resetDropAlertStore());

describe('diag.unsupportPart — the artificial trigger (plan-2022 Phase 6)', () => {
  it('is listed as a command, and only the release one writes', () => {
    const ds = createDropDiagnosticsCommandDescriptors();
    const byId = Object.fromEntries(ds.map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(['diag.dropReset', 'diag.dropStatus', 'diag.unsupportPart']);
    expect(byId['diag.dropStatus'].readOnly).toBe(true);
    expect(byId['diag.unsupportPart'].readOnly).toBe(false);
    // It names itself as a diagnostic — no hidden flag anywhere.
    for (const d of ds) expect(String(d.label)).toMatch(/^Diagnostics:/);
    expect(byId['diag.unsupportPart'].argsSchema).toEqual({ part: 'string', liftMm: 'number' });
  });

  it('works without a component and reports the schema defaults', async () => {
    const w = makeWorld({ armed: false });
    expect(diagUnsupportPart.enabled(w.ctx, {})).toBe(true);
    expect(w.mgr.isArmed).toBe(true);
    expect(w.mgr.hasComponent).toBe(false);
    const mu = part(1);
    w.mus.push(mu);
    const result = await diagUnsupportPart.run(w.ctx, { part: 'Box_7' }) as { muKey: string };
    expect(result.muKey).toBe(`mu:${mu.id}`);
    w.run(0.7);
    expect(w.mgr.activeDrops).toHaveLength(1);
  });

  it('refuses when Options is off or the component has Enabled=false', () => {
    const w = makeWorld();
    setDropDetectionEnabled(false);
    try {
      expect(diagUnsupportPart.enabled(w.ctx, {})).toEqual({
        reason: expect.stringContaining('Settings > Simulation'),
      });
    } finally { setDropDetectionEnabled(true); }
    const mgr = new RVDropManager();
    mgr.register(new Object3D(), { ...CONFIG, Enabled: false }, { dropActive: null, dropCount: null, resetDrops: null });
    expect(diagUnsupportPart.enabled({ viewer: { dropManager: mgr } } as unknown as CommandContext, {}))
      .toEqual({ reason: expect.stringContaining('Enabled=false') });
  });

  it('releases a part from its surface, and the REAL detector then reports it', async () => {
    const w = makeWorld();
    const mu = part(1.0);
    mu.currentSurface = belt(0.98);          // properly carried right now
    w.mus.push(mu);

    w.run(1.0);
    expect(w.mgr.activeDrops).toEqual([]);   // nothing wrong yet

    const res = await diagUnsupportPart.run(w.ctx, { part: 'Box_7' }) as { released: string[]; muKey: string };
    expect(res.released.join(' ')).toContain('Belt_In');
    expect(mu.currentSurface).toBeNull();

    // No report is faked — it appears only because the detector finds the state.
    expect(w.mgr.activeDrops).toEqual([]);
    w.run(0.2);
    expect(w.mgr.activeDrops.map((d) => d.muKey)).toEqual([res.muKey]);
  });

  it('also frees a GripTarget seat and can lift the part out of reach', async () => {
    const node = new Object3D();
    node.name = 'Seat';
    const target = new RVGripTarget(node);
    const w = makeWorld({ gripTargets: [target] });
    const mu = part(1.0);
    mu.heldBy = 'grip';
    target.occupiedBy = mu;
    w.mus.push(mu);

    const res = await diagUnsupportPart.run(
      w.ctx, { part: `mu:${mu.id}`, liftMm: 500 },
    ) as { released: string[] };
    expect(res.released.join(' ')).toContain('heldBy=grip');
    expect(res.released.join(' ')).toContain('gripTarget');
    expect(res.released.join(' ')).toContain('lifted 500 mm');
    expect(mu.heldBy).toBeNull();
    expect(target.occupiedBy).toBeNull();
    expect(mu.aabb.min.y).toBeCloseTo(1.5, 3);

    w.run(0.2);
    expect(w.mgr.activeDrops.length).toBe(1);
  });

  it('refuses a physics-owned part and says why', async () => {
    const w = makeWorld();
    const mu = part(1.0);
    mu.owner = 'rapier';
    w.mus.push(mu);
    const res = await diagUnsupportPart.run(w.ctx, { part: 'Box_7' }) as { error?: string };
    expect(res.error).toContain('rapier');
    expect(w.mgr.activeDrops).toEqual([]);
  });

  it('lists the live parts when the named one does not exist', async () => {
    const w = makeWorld();
    w.mus.push(part(1.0, 'Box_7'));
    const res = await diagUnsupportPart.run(
      w.ctx, { part: 'Nope' },
    ) as { error?: string; parts?: { name: string }[] };
    expect(res.error).toContain('Nope');
    expect(res.parts?.map((p) => p.name)).toEqual(['Box_7']);
  });

  it('diag.dropStatus is read-only and reports configuration and findings', async () => {
    const w = makeWorld();
    const mu = part(1.0);
    w.mus.push(mu);
    w.run(0.2);
    const res = await diagDropStatus.run(w.ctx, {}) as {
      armed: boolean; optionsEnabled: boolean; hasComponent: boolean; reports: { part: string }[]; supportProbes: number;
    };
    expect(res.armed).toBe(true);
    expect(res.optionsEnabled).toBe(true);
    expect(res.hasComponent).toBe(true);
    expect(res.reports.map((r) => r.part)).toEqual(['Box_7']);
    expect(res.supportProbes).toBeGreaterThan(0);
  });

  it('diag.dropReset clears the findings', async () => {
    const w = makeWorld();
    w.mus.push(part(1.0));
    w.run(0.2);
    expect(w.mgr.activeDrops.length).toBe(1);
    await diagDropReset.run(w.ctx, {});
    expect(w.mgr.activeDrops).toEqual([]);
  });
});
