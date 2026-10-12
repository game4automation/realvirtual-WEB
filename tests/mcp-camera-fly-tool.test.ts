// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-705 T6 / plan-740 T8 — `web_camera_fly` wiring on a stub viewer (no WebGL).
 *
 * What this file checks changed fundamentally with plan-740: the tool no longer
 * flies the VISIBLE camera, it sets the agent's own pose (D-U2/D-A7). So:
 *
 *   - the FPV / camera-follow / XR REFUSAL is gone. Those three own the user's
 *     viewport, and the agent no longer touches it — a fly under any of them
 *     must now MOVE, not answer `blockedBy`. The refusal did not disappear,
 *     it moved to `attach()`; the contrast is asserted here so a future
 *     "restore the guard" reflex fails loudly (review T2).
 *   - no `animateCameraTo`, no waiting: the call returns with the new pose.
 *
 * The ground probe (F4) is unchanged and still covered, including the
 * pre-model-load case where `viewer.raycastManager` is null.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Vector3 } from 'three';
import { McpViewTools } from '../src/plugins/mcp-bridge/rv-mcp-view-tools';
import { AgentEye } from '../src/core/engine/rv-agent-eye';
import { AgentEyePlugin } from '../src/plugins/agent-eye-plugin';
import type { RVViewer } from '../src/core/rv-viewer';

interface StubOpts {
  position?: Vector3;
  target?: Vector3;
  fpvActive?: boolean;
  followMode?: 'off' | 'follow' | 'siton';
  xrPresenting?: boolean;
  raycastManager?: { raycastRay: () => unknown } | null;
  /** Omit the agent-eye plugin entirely (the embed-viewer case). */
  noAgentEye?: boolean;
}

function makeStubViewer(o: StubOpts = {}): {
  viewer: RVViewer;
  eye: AgentEye | undefined;
  /** Every animateCameraTo the tools trigger — must stay empty since plan-740. */
  moves: Array<{ position: Vector3; target: Vector3 }>;
  plugins: { fpv: { id: string; isActive: boolean } };
} {
  const cam = {
    position: (o.position ?? new Vector3()).clone(),
    target: (o.target ?? new Vector3(0, 0, -5)).clone(),
  };
  const moves: Array<{ position: Vector3; target: Vector3 }> = [];
  const plugins = { fpv: { id: 'fpv', isActive: o.fpvActive === true } };
  const el = { clientWidth: 1600, clientHeight: 1000 };

  const eye = o.noAgentEye ? undefined : new AgentEye({
    getViewportState: () => ({
      position: [cam.position.x, cam.position.y, cam.position.z],
      target: [cam.target.x, cam.target.y, cam.target.z],
      fov: 50,
      projection: 'perspective',
    }),
    modelKey: null,
  });

  const viewer = {
    projection: 'perspective',
    fov: 50,
    renderer: { domElement: el },
    cameraFollowMode: o.followMode ?? 'off',
    raycastManager: o.raycastManager === undefined ? null : o.raycastManager,
    agentEye: eye,
    getPlugin: (id: string) => {
      if (id === 'fpv') return plugins.fpv;
      if (id === 'webxr') return o.xrPresenting ? { id: 'webxr', isPresenting: true } : undefined;
      return undefined;
    },
    getCameraState: () => ({ position: cam.position.clone(), target: cam.target.clone() }),
    animateCameraTo: (p: Vector3, t: Vector3) => {
      cam.position.copy(p); cam.target.copy(t);
      moves.push({ position: p.clone(), target: t.clone() });
    },
  } as unknown as RVViewer;
  return { viewer, eye, moves, plugins };
}

describe('web_camera_fly', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('moves the AGENT pose, not the viewport, and never animates', async () => {
    const { viewer, eye, moves } = makeStubViewer({
      position: new Vector3(0, 1.7, 0), target: new Vector3(0, 1.7, -5),
    });
    const r = JSON.parse(await new McpViewTools(() => viewer).webCameraFly(3, 0, 0, 0, 0, false, 10));

    expect(r.error).toBeUndefined();
    expect(r.deltaM).toEqual({ forward: 3, right: 0, up: 0 });
    // Three metres along -Z from the spawn pose.
    expect(eye!.pose.pz).toBeCloseTo(-3, 6);
    expect(r.position[2]).toBeCloseTo(-3, 6);
    // The whole point: the user's camera stayed put and nothing was animated.
    expect(moves).toHaveLength(0);
    expect(r.attached).toBe(false);
  });

  it('flies anyway while FPV, camera-follow or XR own the USER camera', async () => {
    // plan-740 D-A7 / review T2. These three no longer block a camera verb —
    // they own the viewport, which the agent stopped touching.
    for (const opts of [
      { fpvActive: true } as StubOpts,
      { followMode: 'siton' } as StubOpts,
      { xrPresenting: true } as StubOpts,
    ]) {
      const { viewer, eye, moves } = makeStubViewer(opts);
      const r = JSON.parse(await new McpViewTools(() => viewer).webCameraFly(2, 0, 0, 0, 0, false, 10));
      expect(r.error, `owner ${JSON.stringify(opts)} must not refuse`).toBeUndefined();
      expect(r.blockedBy).toBeUndefined();
      expect(eye!.pose.pz).toBeCloseTo(-2, 6);
      expect(moves).toHaveLength(0);
    }
  });

  it('CONTRAST: the same three states still refuse an attach', () => {
    // The refusal moved, it did not vanish — attaching a human viewport to the
    // agent is exactly the operation FPV/follow/XR must still block.
    const cases: Array<[StubOpts, string]> = [
      [{ fpvActive: true }, 'fpv'],
      [{ followMode: 'siton' }, 'follow'],
      [{ xrPresenting: true }, 'xr'],
    ];
    for (const [opts, expected] of cases) {
      const { viewer } = makeStubViewer(opts);
      const plugin = new AgentEyePlugin();
      // The plugin only needs the ownership surface for this check; wiring the
      // scene/canvas is the attach test's job.
      (plugin as unknown as { _viewer: RVViewer })._viewer = {
        ...(viewer as unknown as object),
        controls: {},
        renderer: { xr: { isPresenting: opts.xrPresenting === true } },
      } as unknown as RVViewer;
      (plugin as unknown as { _eye: unknown })._eye = new AgentEye({
        getViewportState: () => ({ position: [0, 0, 0], target: [0, 0, -1], fov: 45, projection: 'perspective' }),
        modelKey: null,
      });
      expect(plugin.attach()).toEqual({ attached: false, refused: expected });
    }
  });

  it('errors cleanly when there is no agent eye at all (embed viewer)', async () => {
    const { viewer } = makeStubViewer({ noAgentEye: true });
    const r = JSON.parse(await new McpViewTools(() => viewer).webCameraFly(1, 0, 0, 0, 0, false, 10));
    expect(r.error).toBe('No agent eye');
  });

  // The fallback branch that is checked nowhere else (plan-705 F7 triage).
  it('reports groundHit:false when the ray hits nothing, without throwing', async () => {
    const { viewer, eye } = makeStubViewer({
      position: new Vector3(0, 5, 0),
      target: new Vector3(0, 5, -5),
      raycastManager: { raycastRay: () => null }, // no ground hit
    });
    const r = JSON.parse(await new McpViewTools(() => viewer).webCameraFly(
      3, 0, 0, 0, 0, /* ground */ true, 10));
    expect(r.error).toBeUndefined();   // a miss is NOT an error
    expect(r.groundHit).toBe(false);
    expect(r.position[1]).toBeCloseTo(5, 6); // the computed y stays
    expect(eye!.pose.py).toBeCloseTo(5, 6);

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
    expect(noModel.eye!.pose.pz).toBeCloseTo(-3, 6); // it still flies, just without ground snapping
  });

  it('snaps to eye height above a ground hit and shifts the target with it', async () => {
    const { viewer, eye } = makeStubViewer({
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
    expect(eye!.pose.ty).toBeCloseTo(1.7, 6);
  });
});

describe('web_camera_set / _get / _projection retarget', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('web_camera_set writes the pose and the lens, instantly', async () => {
    const { viewer, eye, moves } = makeStubViewer();
    const tools = new McpViewTools(() => viewer);
    const r = JSON.parse(await tools.webCameraSet(1, 2, 3, 4, 5, 6, 600, 33, 2));
    expect(r.position).toEqual([1, 2, 3]);
    expect(r.target).toEqual([4, 5, 6]);
    expect(r.fov).toBe(33);
    expect(r.aspect).toBe(2);
    expect(moves).toHaveLength(0);
    expect(eye!.pose.px).toBe(1);

    // Out-of-range lens values are clamped rather than refused.
    const clamped = JSON.parse(await tools.webCameraSet(1, 2, 3, 4, 5, 6, 0, 999, 99));
    expect(clamped.fov).toBe(120);
    expect(clamped.aspect).toBe(5);
  });

  it('web_camera_get reports the agent pose, not the viewport state', async () => {
    const { viewer, eye } = makeStubViewer({ position: new Vector3(7, 7, 7) });
    const tools = new McpViewTools(() => viewer);
    eye!.ensure();
    eye!.setPose({ px: -1, py: -2, pz: -3 });
    const r = JSON.parse(await tools.webCameraGet());
    expect(r.position).toEqual([-1, -2, -3]);
    expect(r.attached).toBe(false);
    expect(r.canvas).toEqual({ width: 1600, height: 1000 });
  });

  it('web_camera_projection toggles the AGENT projection and reports orthoHalfHeight', async () => {
    const { viewer, eye, moves } = makeStubViewer({
      position: new Vector3(0, 0, 10), target: new Vector3(0, 0, 0),
    });
    const tools = new McpViewTools(() => viewer);

    const r = JSON.parse(await tools.webCameraProjection('ortho'));
    expect(r).toEqual({ projection: 'orthographic', changed: true });
    expect(eye!.pose.projection).toBe('orthographic');
    expect(viewer.projection).toBe('perspective');   // the user's view is untouched

    const state = JSON.parse(await tools.webCameraGet());
    expect(state.orthoHalfHeight).toBeCloseTo(10 * Math.tan((50 * Math.PI) / 360), 3);

    expect(JSON.parse(await tools.webCameraProjection('ortho')).changed).toBe(false);
    expect(JSON.parse(await tools.webCameraProjection('')).projection).toBe('perspective');
    expect(JSON.parse(await tools.webCameraProjection('sideways')).error).toBeDefined();
    expect(moves).toHaveLength(0);
  });
});
