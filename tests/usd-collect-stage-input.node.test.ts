// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { collectStageInput } from '../src/core/usd/collect-stage-input';
import { buildRuntimeStageTree } from '../src/core/usd/runtime-stage-export';

describe('shared stage input', () => {
  it('timeline excludes all MUs including passive preplaced MUs without sources; Live-Link keeps preplaced nodes', () => {
    const root = new Object3D(), pre = new Object3D(), spawned = new Object3D();
    root.add(pre, spawned);
    const tm = new RVTransportManager();
    const mu = new RVMovingUnit(pre, '', new Vector3(1, 1, 1)); tm.registerPreplaced(mu, root);
    tm.mus.push(new RVMovingUnit(spawned, '', new Vector3(1, 1, 1)));
    const live = collectStageInput({ root, transportManager: tm }), timeline = collectStageInput({ root, transportManager: tm }, { timeline: true });
    expect(live.input.exclude.has(pre)).toBe(false); expect(live.input.exclude.has(spawned)).toBe(true);
    expect(timeline.input.exclude.has(pre)).toBe(true); expect(timeline.input.exclude.has(spawned)).toBe(true);
    expect(timeline.input.templates).toEqual([]);
    expect(timeline.input.preplaced).toEqual([{ muId: mu.id, node: pre }]);
    expect(buildRuntimeStageTree(timeline.input).nodes).toEqual([root]);
    expect(buildRuntimeStageTree(live.input).nodes).toEqual([root, pre]);
  });

  it('passive loads (plan-516) are classified like active MUs: a spawned load on a pre-placed carrier is never exported, a pre-placed load is (plan-2239 review #2)', () => {
    const root = new Object3D(), carrierNode = new Object3D(), spawnedLoad = new Object3D(), preLoad = new Object3D(), stacked = new Object3D();
    carrierNode.name = 'Carrier'; spawnedLoad.name = 'SpawnedLoad'; preLoad.name = 'PreLoad'; stacked.name = 'Stacked';
    root.add(carrierNode);
    const tm = new RVTransportManager();
    const carrier = new RVMovingUnit(carrierNode, '', new Vector3(1, 1, 1)); carrier.preplaced = true; tm.registerPreplaced(carrier, root);
    const pre = new RVMovingUnit(preLoad, '', new Vector3(1, 1, 1)); pre.preplaced = true; tm.registerPreplaced(pre, root);
    const load = new RVMovingUnit(spawnedLoad, '', new Vector3(1, 1, 1));
    const onTop = new RVMovingUnit(stacked, '', new Vector3(1, 1, 1));
    // Passive: attached under the carrier node, NOT in tm.mus.
    carrierNode.add(spawnedLoad, preLoad); spawnedLoad.add(stacked);
    carrier.loadedMus.push(load, pre); load.loadedMus.push(onTop);
    tm.mus.push(carrier);
    const live = collectStageInput({ root, transportManager: tm });
    expect(live.input.exclude.has(spawnedLoad)).toBe(true);
    expect(live.input.exclude.has(stacked)).toBe(true);
    expect(live.input.exclude.has(preLoad)).toBe(false);
    expect(live.input.exclude.has(carrierNode)).toBe(false);
    expect(buildRuntimeStageTree(live.input).nodes).toEqual([root, carrierNode, preLoad]);
    const timeline = collectStageInput({ root, transportManager: tm }, { timeline: true });
    expect(buildRuntimeStageTree(timeline.input).nodes).toEqual([root]);
  });
});
