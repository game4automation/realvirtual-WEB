// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-447 §9.4 — zone claims survive a live path edit.
 *
 * Before plan-447 `RVPathComponent.reapplyConfig()` called
 * `ZoneRegistry.undefine()` (documented for MODEL-CLEAR: it drops the
 * definition AND every holder). During a planner edit that silently freed the
 * exclusive zone a driving vehicle was standing in — two vehicles could then
 * occupy one crossing.
 *
 * The live-edit route is `ZoneRegistry.redefine()`: capacity HARD-overwritten
 * (so a SHRINK actually takes effect — `define()` is max-wins, gate round 2),
 * holders untouched. `undefine()` stays the model-clear route (`dispose()`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { RVPathComponent } from '../../src/core/engine/rv-path';
import type { PathSegmentSpec } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import {
  DEFAULT_ZONE_CAPACITY,
  ZoneRegistry,
  getDefaultZoneRegistry,
} from '../../src/core/engine/rv-zone-registry';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import {
  cloneSegmentSpecs,
  movePathHandle,
  writeSegmentSpecs,
} from '../../src/core/engine/rv-path-edit';

const L10: PathSegmentSpec = { kind: 'line', from: [0, 0, 0], to: [0, 0, 10] };

function pathNode(name: string, fields: Record<string, unknown>): Object3D {
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = { Path: fields };
  return node;
}

function commit(comp: RVPathComponent, specs: readonly PathSegmentSpec[]): void {
  writeSegmentSpecs(comp.node as unknown as { userData: Record<string, unknown> }, specs);
  comp.reapplyConfig();
}

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultSpacingController().clear();
});

describe('ZoneRegistry.redefine — hard capacity overwrite, holders preserved', () => {
  it('overwrites the capacity instead of max-combining it (SHRINK works)', () => {
    const zones = new ZoneRegistry();
    zones.define('X1', 3);
    expect(zones.capacityOf('X1')).toBe(3);
    // `define` is max-wins — a shrink through it is a no-op …
    zones.define('X1', 1);
    expect(zones.capacityOf('X1')).toBe(3);
    // … `redefine` overwrites hard.
    zones.redefine('X1', 1);
    expect(zones.capacityOf('X1')).toBe(1);
  });

  it('keeps every holder across the redefinition', () => {
    const zones = new ZoneRegistry();
    zones.define('X1', 2);
    expect(zones.claim('X1', 'agvA')).toBe(true);
    zones.redefine('X1', 2);
    expect(zones.isHolder('X1', 'agvA')).toBe(true);
    expect(zones.holderCount('X1')).toBe(1);
  });

  it('undefined capacity resets the zone to the default, holders still kept', () => {
    const zones = new ZoneRegistry();
    zones.define('X1', 5);
    zones.claim('X1', 'agvA');
    zones.redefine('X1');
    expect(zones.capacityOf('X1')).toBe(DEFAULT_ZONE_CAPACITY);
    expect(zones.isHolder('X1', 'agvA')).toBe(true);
  });

  it('a shrink below the current holder count blocks NEW claims but keeps the old one', () => {
    const zones = new ZoneRegistry();
    zones.define('X1', 2);
    zones.claim('X1', 'agvA');
    zones.claim('X1', 'agvB');
    zones.redefine('X1', 1);
    expect(zones.holderCount('X1')).toBe(2); // no vehicle is teleported out
    expect(zones.claim('X1', 'agvC')).toBe(false);
    zones.release('X1', 'agvA');
    zones.release('X1', 'agvB');
    expect(zones.claim('X1', 'agvC')).toBe(true);
    expect(zones.claim('X1', 'agvD')).toBe(false); // capacity 1 in force
  });
});

describe('live path edit — the claim survives', () => {
  it('a held claim survives the geometry edit and still blocks a second vehicle', () => {
    const zones = getDefaultZoneRegistry();
    const comp = new RVPathComponent(
      pathNode('Crossing', { segments: cloneSegmentSpecs([L10]), zone: 'X1', zoneCapacity: 1 }),
    );
    comp.init({} as never);
    expect(zones.capacityOf('X1')).toBe(1);
    expect(zones.claim('X1', 'agvA')).toBe(true);

    // Somebody drags the crossing segment while agvA holds it.
    commit(comp, movePathHandle([L10], 'v1', [0, 0, 16]));

    expect(zones.isHolder('X1', 'agvA')).toBe(true);
    expect(zones.holderCount('X1')).toBe(1);
    expect(zones.claim('X1', 'agvB')).toBe(false); // still exclusive
    expect(comp.path!.length).toBeCloseTo(16, 10);
  });

  it('a capacity SHRINK during the live edit takes effect (redefine, not define)', () => {
    const zones = getDefaultZoneRegistry();
    const node = pathNode('Crossing', {
      segments: cloneSegmentSpecs([L10]),
      zone: 'X1',
      zoneCapacity: 3,
    });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    expect(zones.capacityOf('X1')).toBe(3);

    (node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.zoneCapacity = 1;
    comp.reapplyConfig();

    expect(zones.capacityOf('X1')).toBe(1);
    expect(zones.claim('X1', 'agvA')).toBe(true);
    expect(zones.claim('X1', 'agvB')).toBe(false);
  });

  it('a capacity GROW during the live edit takes effect too', () => {
    const zones = getDefaultZoneRegistry();
    const node = pathNode('Crossing', {
      segments: cloneSegmentSpecs([L10]),
      zone: 'X1',
      zoneCapacity: 1,
    });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    zones.claim('X1', 'agvA');
    expect(zones.claim('X1', 'agvB')).toBe(false);

    (node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.zoneCapacity = 2;
    comp.reapplyConfig();

    expect(zones.capacityOf('X1')).toBe(2);
    expect(zones.isHolder('X1', 'agvA')).toBe(true);
    expect(zones.claim('X1', 'agvB')).toBe(true);
  });

  it('an unparsable payload during the edit does NOT free the claim', () => {
    const zones = getDefaultZoneRegistry();
    const node = pathNode('Crossing', {
      segments: cloneSegmentSpecs([L10]),
      zone: 'X1',
      zoneCapacity: 1,
    });
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    zones.claim('X1', 'agvA');

    (node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.type = 'Foreign';
    comp.reapplyConfig();
    expect(comp.path).toBeNull();
    expect(zones.isHolder('X1', 'agvA')).toBe(true);
  });
});

describe('model-clear still wipes everything (undefine)', () => {
  it('dispose() drops the zone definition AND its holders', () => {
    const zones = getDefaultZoneRegistry();
    const comp = new RVPathComponent(
      pathNode('Crossing', { segments: cloneSegmentSpecs([L10]), zone: 'X1', zoneCapacity: 4 }),
    );
    comp.init({} as never);
    zones.claim('X1', 'agvA');
    expect(zones.capacityOf('X1')).toBe(4);

    comp.dispose();

    expect(zones.holderCount('X1')).toBe(0);
    expect(zones.isHolder('X1', 'agvA')).toBe(false);
    // Definition gone → a later model declaring a SMALLER capacity is not
    // widened by a stale max() (the reason undefine exists).
    expect(zones.capacityOf('X1')).toBe(DEFAULT_ZONE_CAPACITY);
    expect(getDefaultPathNetwork().get('Crossing')).toBeNull();
  });

  it('clear() drops every zone and claim', () => {
    const zones = getDefaultZoneRegistry();
    zones.define('X1', 2);
    zones.claim('X1', 'agvA');
    zones.clear();
    expect(zones.holderCount('X1')).toBe(0);
    expect(zones.capacityOf('X1')).toBe(DEFAULT_ZONE_CAPACITY);
  });
});
