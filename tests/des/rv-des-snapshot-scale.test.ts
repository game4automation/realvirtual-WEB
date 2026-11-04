// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { muRecords } from './snapshot-test-utils';
/**
 * plan-261 test §9.6 — large-model scale (F5): a synthetic warehouse with
 * hundreds of components and thousands of MUs snapshots WITHOUT a stringify
 * overflow, stays under a sane byte threshold, and round-trips its state
 * (assertions on BYTE SIZE / no-throw — deliberately NOT on ms budgets, which
 * are flaky in headless CI).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { runnerFixture } from './runner-fixture';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import type { DESMU } from '@rv/plugins/des/rv-des-mu';
import { registerAction, ACTION_INDEX } from '@rv/plugins/des/rv-des-named-actions';

// Guarded registration — a no-op action for the synthetic pending workload.
if (!ACTION_INDEX.has('ScaleTest.Noop')) registerAction('ScaleTest.Noop', () => {}, { owner: 'component', payload: 'none' });

const COMPONENT_COUNT = 300;
const MU_COUNT = 3000;
/** One snapshot of this synthetic warehouse must stay well under 100 MB (NFR). */
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;

describe('DES snapshot — large model scale (9.6)', () => {
  it('300 components / 3000 MUs snapshot + restore without overflow', () => {
    resetDESMUCounter();
    const makeWorld = () => {
      const scene = new Scene();
      for (let i = 0; i < COMPONENT_COUNT; i++) {
        const node = new Object3D(); node.name = `Storage-${i}`;
        // Storage parks the synthetic workload without scheduling processing events.
        node.userData.realvirtual = { Storage: { MaxCapacity: MU_COUNT, AutoRelease: false } };
        scene.add(node);
      }
      const fixture = runnerFixture(scene);
      expect(fixture.components).toHaveLength(COMPONENT_COUNT);
      fixture.runner.start([], { root: scene });
      fixture.components.forEach((c, i) => { c.prop['zone'] = `Z${i % 12}`; });
      return fixture;
    };
    const { runner, manager, components } = makeWorld();

    const mus: DESMU[] = [];
    for (let i = 0; i < MU_COUNT; i++) {
      const mu = runner.createMU() as DESMU;
      mu.prop['sku'] = `SKU-${i % 500}`;
      mu.prop['weight'] = (i % 37) * 0.5;
      // Park each MU in storage so component muIds serialize too.
      const comp = components[i % COMPONENT_COUNT];
      comp.acceptMU(mu);
      mus.push(mu);
    }

    // Load the queue with pending work.
    for (let i = 0; i < 2000; i++) {
      manager.scheduleEvent(10 + i, 'ScaleTest.Noop', i % COMPONENT_COUNT, mus[i % MU_COUNT].id, 0);
    }

    // Snapshot: must not throw, and one stringify stays snapshot-sized.
    let json = '';
    expect(() => {
      const snap = runner.fullSnapshot();
      json = JSON.stringify(snap);
    }).not.toThrow();
    expect(json.length).toBeGreaterThan(0);
    expect(json.length).toBeLessThan(MAX_SNAPSHOT_BYTES);

    // Round-trip into a FRESH world (re-created MUs incl. instanced ones).
    resetDESMUCounter();
    const { runner: runner2, manager: manager2, components: components2 } = makeWorld();

    const parsed = JSON.parse(json);
    expect(() => {
      runner2.restoreFull(parsed);
    }).not.toThrow();

    const mus2 = muRecords(runner2.fullSnapshot());
    expect(mus2.length).toBe(MU_COUNT);
    expect(manager2.pendingEventCount).toBe(2000);
    expect(manager2.currentTime).toBe(manager.currentTime);
    // Spot-check MU + component state round-trip.
    expect(mus2[123].prop['sku']).toBe(mus[123].prop['sku']);
    const c0 = components2[0].toSnapshot();
    expect(c0.currentLoad).toBe(components[0].toSnapshot().currentLoad);
    expect(c0.muIds).toEqual(components[0].toSnapshot().muIds);
  });
});
