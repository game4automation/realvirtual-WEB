// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-261 test §9.6 — large-model scale (F5): a synthetic warehouse with
 * hundreds of components and thousands of MUs snapshots WITHOUT a stringify
 * overflow, stays under a sane byte threshold, and round-trips its state
 * (assertions on BYTE SIZE / no-throw — deliberately NOT on ms budgets, which
 * are flaky in headless CI).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESManager } from '@rv-private/plugins/des/rv-des-manager';
import { DES } from '@rv-private/plugins/des/rv-des-api';
import { DESStation } from '@rv-private/plugins/des/rv-des-station';
import type { DESComponent } from '@rv-private/plugins/des/rv-des-component';
import { createSnapshot, restoreSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import { createDESMU, resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import type { DESMU, DESMUSnapshot } from '@rv-private/plugins/des/rv-des-mu';
import { registerAction, ACTION_INDEX } from '@rv-private/plugins/des/rv-des-named-actions';

// Guarded registration — a no-op action for the synthetic pending workload.
if (!ACTION_INDEX.has('ScaleTest.Noop')) registerAction('ScaleTest.Noop', () => {});

const COMPONENT_COUNT = 300;
const MU_COUNT = 3000;
/** One snapshot of this synthetic warehouse must stay well under 100 MB (NFR). */
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;

describe('DES snapshot — large model scale (9.6)', () => {
  it('300 components / 3000 MUs snapshot + restore without overflow', () => {
    resetDESMUCounter();
    const scene = new Scene();
    const manager = new DESManager(16384);
    DES.setManager(manager);

    const components: DESComponent[] = [];
    for (let i = 0; i < COMPONENT_COUNT; i++) {
      const node = new Object3D();
      node.name = `Station-${i}`;
      scene.add(node);
      const st = new DESStation(node);
      st.prop['zone'] = `Z${i % 12}`;
      st.ProcessingTime = 0;          // immediate pass-through — no event scheduling
      st.MaxCapacity = MU_COUNT;      // park many MUs per station
      manager.registerComponent(st);
      components.push(st);
    }

    const mus: DESMU[] = [];
    for (let i = 0; i < MU_COUNT; i++) {
      const mu = createDESMU(0);
      manager.registerMU(mu);
      mu.prop['sku'] = `SKU-${i % 500}`;
      mu.prop['weight'] = (i % 37) * 0.5;
      // Park each MU on a station so component muIds serialize too.
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
      const snap = createSnapshot(manager, components, mus, [], null);
      json = JSON.stringify(snap);
    }).not.toThrow();
    expect(json.length).toBeGreaterThan(0);
    expect(json.length).toBeLessThan(MAX_SNAPSHOT_BYTES);

    // Round-trip into a FRESH world (re-created MUs incl. instanced ones).
    resetDESMUCounter();
    const scene2 = new Scene();
    const manager2 = new DESManager(16384);
    DES.setManager(manager2);
    const components2: DESComponent[] = [];
    for (let i = 0; i < COMPONENT_COUNT; i++) {
      const node = new Object3D();
      node.name = `Station-${i}`;
      scene2.add(node);
      const st = new DESStation(node);
      manager2.registerComponent(st);
      components2.push(st);
    }
    const mus2: DESMU[] = [];
    const muFactory = (muSnap: DESMUSnapshot): DESMU => {
      const mu = createDESMU(muSnap.creationTime);
      mu.customId = muSnap.customId;
      manager2.registerMUAt(mu, muSnap.id);
      mus2.push(mu);
      return mu;
    };

    const parsed = JSON.parse(json);
    expect(() => {
      restoreSnapshot(parsed, manager2, components2, mus2, [], null, muFactory);
    }).not.toThrow();

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
