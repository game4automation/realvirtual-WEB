// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-705 T6 — `web_camera_fly` wiring on a stub viewer (no WebGL).
 *
 * Covers the two things the pure maths cannot: the camera-ownership guards
 * (D-A2) and the ground-probe fallback (F4), including the pre-model-load case
 * where `viewer.raycastManager` is still null (§2.4 step 4).
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { McpViewTools } from '../src/plugins/mcp-bridge/rv-mcp-view-tools';
import type { RVViewer } from '../src/core/rv-viewer';

interface StubOpts {
  position?: Vector3;
  target?: Vector3;
  fpvActive?: boolean;
  followMode?: 'off' | 'follow' | 'siton';
  xrPresenting?: boolean;
  raycastManager?: { raycastRay: () => unknown } | null;
}

function makeStubViewer(o: StubOpts = {}): {
  viewer: RVViewer;
  moves: Array<{ position: Vector3; target: Vector3; easing: string }>;
  plugins: { fpv: { isActive: boolean } };
} {
  const cam = {
    position: (o.position ?? new Vector3()).clone(),
    target: (o.target ?? new Vector3(0, 0, -5)).clone(),
  };
  const moves: Array<{ position: Vector3; target: Vector3; easing: string }> = [];
  const plugins = { fpv: { isActive: o.fpvActive === true } };
  const el = { clientWidth: 1600, clientHeight: 1000 };
  const viewer = {
    projection: 'perspective',
    renderer: { domElement: el },
    cameraFollowMode: o.followMode ?? 'off',
    raycastManager: o.raycastManager === undefined ? null : o.raycastManager,
    getPlugin: (id: string) => {
      if (id === 'fpv') return plugins.fpv;
      if (id === 'webxr') return o.xrPresenting ? { isPresenting: true } : undefined;
      return undefined;
    },
    getCameraState: () => ({ position: cam.position.clone(), target: cam.target.clone() }),
    animateCameraTo: (p: Vector3, t: Vector3, _d: number, easing: string) => {
      cam.position.copy(p); cam.target.copy(t);
      moves.push({ position: p.clone(), target: t.clone(), easing });
    },
  } as unknown as RVViewer;
  return { viewer, moves, plugins };
}

describe('web_camera_fly', () => {
  it('refuses to fly while FPV owns the camera, and moves exactly once otherwise', async () => {
    const { viewer, moves, plugins } = makeStubViewer({ fpvActive: true });
    const tools = new McpViewTools(() => viewer);

    const blocked = JSON.parse(await tools.webCameraFly(3, 0, 0, 0, 0, false, 10));
    expect(blocked.error).toBeDefined();
    expect(blocked.blockedBy).toBe('fpv');
    expect(moves).toHaveLength(0); // NO movement in the guard case

    plugins.fpv.isActive = false;
    const ok = JSON.parse(await tools.webCameraFly(3, 0, 0, 0, 0, false, 10));
    expect(ok.error).toBeUndefined();
    expect(moves).toHaveLength(1);
    expect(moves[0].easing).toBe('easeInOut'); // scripted flight, not easeOut
    expect(ok.deltaM).toEqual({ forward: 3, right: 0, up: 0 });
  });

  it('refuses while a camera-follow mode or XR owns the camera', async () => {
    const follow = makeStubViewer({ followMode: 'siton' });
    const rf = JSON.parse(
      await new McpViewTools(() => follow.viewer).webCameraFly(1, 0, 0, 0, 0, false, 10));
    expect(rf.blockedBy).toBe('follow');
    expect(follow.moves).toHaveLength(0);

    const xr = makeStubViewer({ xrPresenting: true });
    const rx = JSON.parse(
      await new McpViewTools(() => xr.viewer).webCameraFly(1, 0, 0, 0, 0, false, 10));
    expect(rx.blockedBy).toBe('xr');
    expect(xr.moves).toHaveLength(0);
  });

  // The fallback branch that is checked nowhere else (plan-705 F7 triage).
  it('reports groundHit:false when the ray hits nothing, without throwing', async () => {
    const { viewer } = makeStubViewer({
      position: new Vector3(0, 5, 0),
      target: new Vector3(0, 5, -5),
      raycastManager: { raycastRay: () => null }, // no ground hit
    });
    const r = JSON.parse(await new McpViewTools(() => viewer).webCameraFly(
      3, 0, 0, 0, 0, /* ground */ true, 10));
    expect(r.error).toBeUndefined();   // a miss is NOT an error
    expect(r.groundHit).toBe(false);
    expect(r.position[1]).toBeCloseTo(5, 6); // the computed y stays

    // Same branch before the first GLB load: raycastManager is null (§2.4 step 4).
    const noModel = makeStubViewer({
      position: new Vector3(0, 5, 0),
      target: new Vector3(0, 5, -5),
      raycastManager: null,
    });
    const r2 = JSON.parse(await new McpViewTools(() => noModel.viewer).webCameraFly(
      3, 0, 0, 0, 0, true, 10));
    expect(r2.groundHit).toBe(false);
    expect(r2.error).toBeUndefined();
    expect(noModel.moves).toHaveLength(1); // it still flies, just without ground snapping
  });

  it('snaps to eye height above a ground hit and shifts the target with it', async () => {
    const { viewer, moves } = makeStubViewer({
      position: new Vector3(0, 9, 0),
      target: new Vector3(0, 9, -5),
      raycastManager: {
        raycastRay: () => ({ path: 'Floor', hitPoint: [0, 0, -3], hitNormal: [0, 1, 0] }),
      },
    });
    const r = JSON.parse(await new McpViewTools(() => viewer).webCameraFly(
      3, 0, 0, 0, 0, true, 10));
    expect(r.groundHit).toBe(true);
    expect(r.groundY).toBeCloseTo(0, 6);
    expect(r.position[1]).toBeCloseTo(1.7, 6);        // eye height above the floor
    // The target follows by the same Δy, so the view does not tip over on a step.
    expect(moves[0].target.y).toBeCloseTo(1.7, 6);
  });
});
