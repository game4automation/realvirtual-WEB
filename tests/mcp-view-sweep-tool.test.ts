// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-705 T8/T9 — `web_view_sweep` orchestration on a stub viewer.
 *
 * The riskier of the two tools: it freezes the orbit controls, drives 4-8
 * animated poses, captures and raycasts each of them and must put everything
 * back even when a capture blows up mid-sweep. None of that is provable from the
 * pure maths, so it is pinned here.
 *
 * Timers are faked: the tool sleeps ~700 ms per pose by design, which would make
 * an honest wall-clock test slower than the whole rest of the file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Vector3 } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';

const hooks = vi.hoisted(() => ({
  order: [] as string[],
  labelsSeen: [] as string[][],
  captureFails: null as number | null,
  captureCount: 0,
}));

vi.mock('../src/plugins/mcp-bridge/rv-frame-capture', () => ({
  captureFrameCanvas: () => {
    const i = hooks.captureCount++;
    hooks.order.push(`capture${i}`);
    if (hooks.captureFails === i) throw new Error('capture failed');
    return { canvas: { width: 640, height: 400 }, crop: { left: 0, top: 0, width: 640, height: 400 } };
  },
  compositeMontage: (frames: unknown[], labels: string[]) => {
    hooks.labelsSeen.push(labels);
    return { width: 1600, height: 800, frames: frames.length };
  },
  canvasToRvImage: (_c: unknown, extra: Record<string, unknown>) => JSON.stringify(extra),
  saveCanvasToProject: async () => ({ savedPath: 'captures/x.png' }),
  CAPTURES_FOLDER: 'captures',
}));

const { McpViewTools } = await import('../src/plugins/mcp-bridge/rv-mcp-view-tools');

interface StubOpts {
  fpvActive?: boolean;
  position?: Vector3;
  target?: Vector3;
}

function makeStubViewer(o: StubOpts = {}): {
  viewer: RVViewer;
  moves: Array<[number, number, number]>;
  controls: { enabled: boolean };
} {
  const cam = {
    position: (o.position ?? new Vector3(0, 2, 10)).clone(),
    target: (o.target ?? new Vector3()).clone(),
  };
  const moves: Array<[number, number, number]> = [];
  const controls = { enabled: true };
  const el = {
    clientWidth: 1600, clientHeight: 1000,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 1000 }),
  };
  const viewer = {
    projection: 'perspective',
    renderer: { domElement: el },
    controls,
    cameraFollowMode: 'off',
    currentModelRoot: { name: 'Root' },
    registry: { getNode: () => undefined },
    raycastManager: {
      raycastForRVNodeDetailed: () => {
        hooks.order.push('ray');
        return { path: 'A/Frame', hitPoint: [0, 0, 0], hitNormal: [0, 1, 0] };
      },
    },
    getPlugin: (id: string) => (id === 'fpv' && o.fpvActive ? { isActive: true } : undefined),
    getCameraState: () => ({ position: cam.position.clone(), target: cam.target.clone() }),
    animateCameraTo: (p: Vector3, t: Vector3) => {
      cam.position.copy(p); cam.target.copy(t);
      moves.push([+p.x.toFixed(6), +p.y.toFixed(6), +p.z.toFixed(6)]);
    },
    fitToNodes: () => {},
  } as unknown as RVViewer;
  return { viewer, moves, controls };
}

/** Run the tool to completion while pushing the faked clock forward. */
async function runSweep(p: Promise<string>): Promise<Record<string, unknown>> {
  await vi.advanceTimersByTimeAsync(120_000);
  return JSON.parse(await p);
}

beforeEach(() => {
  hooks.order.length = 0;
  hooks.labelsSeen.length = 0;
  hooks.captureFails = null;
  hooks.captureCount = 0;
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('web_view_sweep', () => {
  // T8
  it('freezes controls and restores pose + controls even when a capture throws', async () => {
    hooks.captureFails = 2; // pose 3 of 6
    const { viewer, moves, controls } = makeStubViewer();
    const tools = new McpViewTools(() => viewer);

    const res = await runSweep(tools.webViewSweep('', 6, undefined, undefined, true, undefined));

    expect(String(res.error)).toMatch(/capture failed/);
    expect(controls.enabled).toBe(true);            // previous value restored
    // restore lives in the finally: the LAST move goes back to the start pose
    expect(moves.at(-1)).toEqual([0, 2, 10]);
    // ... and the sweep really aborts instead of running on
    expect(moves.filter((m) => m[1] !== 2 || m[2] !== 10).length).toBeLessThan(6);
  });

  it('refuses to sweep while FPV owns the camera', async () => {
    const { viewer, controls, moves } = makeStubViewer({ fpvActive: true });
    const res = await runSweep(
      new McpViewTools(() => viewer).webViewSweep('', 6, undefined, undefined, true, undefined));
    expect(res.blockedBy).toBe('fpv');
    expect(controls.enabled).toBe(true);  // the guard does not touch controls
    expect(moves).toHaveLength(0);
  });

  // T9
  it('captures before raycasting and keeps montage cell i aligned with views[i]', async () => {
    const { viewer } = makeStubViewer();
    const res = await runSweep(
      new McpViewTools(() => viewer).webViewSweep('', 4, undefined, undefined, false, undefined));

    // Per pose: the image first, then the rays — otherwise the note belongs to
    // the wrong pose (§2.4).
    expect(hooks.order.filter((o) => o.startsWith('capture')))
      .toEqual(['capture0', 'capture1', 'capture2', 'capture3']);
    expect(hooks.order.indexOf('capture1')).toBeGreaterThan(hooks.order.indexOf('ray'));

    // The index contract: cell caption i, note i and pose i carry the same index.
    const views = res.views as Array<{ index: number; label: string; poseDrift?: number }>;
    expect(views).toHaveLength(4);
    views.forEach((v, i) => {
      expect(v.index).toBe(i);
      expect(hooks.labelsSeen[0][i]).toBe(v.label); // image i ↔ note i
      expect(v.label).toContain(`#${i}`);
    });
    expect(views[0].poseDrift).toBeUndefined();     // stub moves nothing → no drift
    expect(res.restored).toBe(false);
  });

  it('reports the sampled top nodes, background share and sample count per view', async () => {
    const { viewer } = makeStubViewer();
    const res = await runSweep(
      new McpViewTools(() => viewer).webViewSweep('', 4, undefined, undefined, false, undefined));
    const first = (res.views as Array<{
      samples: number; background: number; topNodes: Array<{ path: string; coverage: number }>;
    }>)[0];
    expect(first.samples).toBe(49);                 // the 7×7 default grid
    expect(first.background).toBe(0);               // the stub hits on every ray
    expect(first.topNodes).toEqual([{ path: 'A/Frame', coverage: 1 }]);
    expect(res.radius).toBeGreaterThan(0);
  });
});
