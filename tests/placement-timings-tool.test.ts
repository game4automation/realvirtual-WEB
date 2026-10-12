// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.8 — `web_layout_timings` reports all three measurement rings
 * (decode, bake, placement) plus the long tasks, and `clear=true` empties
 * every ring.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { McpSceneTools } from '../src/plugins/mcp-bridge/rv-mcp-scene-tools';
import {
  recordBakeTiming,
  beginBakeTiming,
  getBakeTimings,
  clearBakeTimings,
} from '../src/core/engine/rv-bake-timings';
import {
  getDecodeTimings,
  clearDecodeTimings,
  type DecodeTiming,
} from '../src/plugins/layout-planner/model-cache';
import type { PlacementTiming } from '../src/plugins/layout-planner/scene-mutations';
import type { RVViewer } from '../src/core/rv-viewer';

interface TimingsOut {
  now: number;
  decode: Array<{ cacheKey: string; totalMs: number; phases: Record<string, number> }>;
  bake: Array<{ assetId: string; totalMs: number; chunks: number; vertices: number; triangles: number; phases: Record<string, number> }>;
  placements: Array<{ op: string; id: string; totalMs: number; firstFrameMs?: number; drawCallsAfter?: number; phases: Record<string, number> }>;
  longTasks: Array<{ start: number; ms: number }>;
}

/** A viewer stub whose only plugin is a planner exposing the placement ring. */
function makeViewer(placements: PlacementTiming[]): RVViewer {
  const planner = {
    getPlacementTimings: () => placements,
    clearPlacementTimings: () => { placements.length = 0; },
  };
  return {
    getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined),
  } as unknown as RVViewer;
}

describe('web_layout_timings', () => {
  beforeEach(() => {
    clearDecodeTimings();
    clearBakeTimings();
  });

  it('reports bake, placeComponent and long-task records', async () => {
    // Decode ring — pushed the way ModelCache._decode does (the array is the ring).
    const decode: DecodeTiming = { cacheKey: 'asset-a', phases: [{ phase: 'gltfParse', ms: 12.4 }], totalMs: 20.6, meshes: 3, triangles: 900 };
    (getDecodeTimings() as DecodeTiming[]).push(decode);

    // Bake ring — via the profiler and via the raw record.
    const prof = beginBakeTiming('asset-a');
    prof.mark('roles'); prof.mark('split'); prof.mark('stage'); prof.mark('pick');
    prof.finish({ chunks: 4, vertices: 1200, triangles: 900 });
    recordBakeTiming({ assetId: 'asset-b', phases: [{ phase: 'roles', ms: 1.2 }], totalMs: 5.7, chunks: 1, vertices: 10, triangles: 4 });
    expect(getBakeTimings()).toHaveLength(2);

    // The Phase-3 `placeComponent` record: bakeWait (cache hit ≈ 0) →
    // instantiate → registerPlaced, first frame sampled after the op.
    const placements: PlacementTiming[] = [{
      op: 'placeComponent', id: 'p1', mode: 'full', totalMs: 321.4, t0: 10, t1: 331.4,
      firstFrameMs: 48.2, drawCallsAfter: 77,
      phases: [
        { phase: 'bakeWait', ms: 0.4 }, { phase: 'instantiate', ms: 12.2 },
        { phase: 'registerPlaced', ms: 100.4 }, { phase: 'arena', ms: 200 },
      ],
    }];
    const tools = new McpSceneTools(() => makeViewer(placements));

    const out = JSON.parse(await tools.webLayoutTimings(false)) as TimingsOut;

    expect(out.decode).toEqual([{ cacheKey: 'asset-a', totalMs: 21, meshes: 3, triangles: 900, phases: { gltfParse: 12 } }]);
    expect(out.bake).toHaveLength(2);
    expect(out.bake[0].assetId).toBe('asset-a');
    expect(out.bake[0].chunks).toBe(4);
    expect(out.bake[0].vertices).toBe(1200);
    expect(out.bake[0].triangles).toBe(900);
    expect(Object.keys(out.bake[0].phases)).toEqual(['roles', 'split', 'stage', 'pick']);
    expect(out.bake[1]).toEqual({ assetId: 'asset-b', totalMs: 6, chunks: 1, vertices: 10, triangles: 4, phases: { roles: 1 } });
    expect(out.placements).toEqual([{
      op: 'placeComponent', id: 'p1', mode: 'full', totalMs: 321, t0: 10, t1: 331,
      firstFrameMs: 48, drawCallsAfter: 77,
      phases: { bakeWait: 0, instantiate: 12, registerPlaced: 100, arena: 200 },
    }]);
    expect(Object.keys(out.placements[0].phases)).toEqual(['bakeWait', 'instantiate', 'registerPlaced', 'arena']);
    // Long tasks: the ring is fed by a PerformanceObserver; the tool reports
    // only blocks >= 100 ms as {start, ms}.
    expect(Array.isArray(out.longTasks)).toBe(true);
    for (const l of out.longTasks) {
      expect(l.ms).toBeGreaterThanOrEqual(100);
      expect(typeof l.start).toBe('number');
    }
    expect("batch" in out).toBe(false); // the arena stats went with the arenas (Phase 4b)

    // Reading without clear keeps every ring.
    expect(getDecodeTimings()).toHaveLength(1);
    expect(getBakeTimings()).toHaveLength(2);
    expect(placements).toHaveLength(1);
  });

  it('clear=true empties the decode, bake and placement rings', async () => {
    (getDecodeTimings() as DecodeTiming[]).push({ cacheKey: 'x', phases: [], totalMs: 1 });
    recordBakeTiming({ assetId: 'x', phases: [], totalMs: 1, chunks: 0, vertices: 0, triangles: 0 });
    const placements: PlacementTiming[] = [{ op: 'registerPlaced', id: 'p', phases: [], totalMs: 1 }];
    const tools = new McpSceneTools(() => makeViewer(placements));

    const first = JSON.parse(await tools.webLayoutTimings(true)) as TimingsOut;
    expect(first.decode).toHaveLength(1);
    expect(first.bake).toHaveLength(1);
    expect(first.placements).toHaveLength(1);

    expect(getDecodeTimings()).toHaveLength(0);
    expect(getBakeTimings()).toHaveLength(0);
    expect(placements).toHaveLength(0);

    const second = JSON.parse(await tools.webLayoutTimings(false)) as TimingsOut;
    expect(second.decode).toEqual([]);
    expect(second.bake).toEqual([]);
    expect(second.placements).toEqual([]);
  });

  it('works without a planner (no viewer): placements are empty, the other rings still report', async () => {
    recordBakeTiming({ assetId: 'solo', phases: [], totalMs: 2, chunks: 1, vertices: 3, triangles: 1 });
    const tools = new McpSceneTools(() => undefined);
    const out = JSON.parse(await tools.webLayoutTimings(true)) as TimingsOut;
    expect(out.placements).toEqual([]);
    expect(out.bake.map((b) => b.assetId)).toEqual(['solo']);
    expect(getBakeTimings()).toHaveLength(0);
  });
});
