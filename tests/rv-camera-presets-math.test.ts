// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-713 T5 — camera presets: the pure maths, the tool schema, and the
 * D-A2 refusal.
 *
 * The maths half is where the value is: a preset is a direction, and a direction
 * that is wrong by a sign is a view that looks plausible in a screenshot and is
 * the opposite of what was asked for. Those assertions need no renderer.
 *
 * The tool half asserts only what a headless test can honestly assert: the
 * schema, the unknown-preset message, and that the three camera OWNERS produce a
 * refusal WITHOUT moving anything. The last one is the point of D-A2 — under FPV,
 * follow or XR a scripted move is overwritten in the next frame, so a silent
 * success is a lie.
 */

import { describe, it, expect } from 'vitest';
import { Box3, Vector3 } from 'three';
import {
  CAMERA_PRESETS,
  applyMeasuredDistance,
  isCameraPreset,
  presetDirection,
  presetPose,
  presetUp,
} from '../src/plugins/mcp-bridge/rv-camera-presets-math';
import { McpViewTools } from '../src/plugins/mcp-bridge/rv-mcp-view-tools';
import { generateToolSchemas } from '../src/core/engine/rv-mcp-tools';
import type { RVViewer } from '../src/core/rv-viewer';

const box = (min: [number, number, number], max: [number, number, number]): Box3 =>
  new Box3(new Vector3(...min), new Vector3(...max));

// ─── The maths ──────────────────────────────────────────────────────────

describe('T5 — preset directions', () => {
  it('top looks DOWN: the camera sits above the target', () => {
    const pose = presetPose('top', box([-1, -1, -1], [1, 1, 1]));
    expect(pose.position.y).toBeGreaterThan(pose.target.y);
    expect(pose.position.x).toBeCloseTo(pose.target.x, 6);
    expect(pose.position.z).toBeCloseTo(pose.target.z, 6);
  });

  it('top uses a non-degenerate up vector', () => {
    // Looking along −Y with up = +Y is degenerate and Three.js resolves it with
    // an arbitrary roll — a plan view that is randomly rotated per call.
    const up = presetUp('top');
    expect(Math.abs(up.dot(presetDirection('top')))).toBeLessThan(1e-6);
    for (const p of CAMERA_PRESETS) {
      if (p === 'top') continue;
      expect(presetUp(p).equals(new Vector3(0, 1, 0)), `${p} keeps Y up`).toBe(true);
    }
  });

  it('front and back are opposites, as are left and right', () => {
    expect(presetDirection('front').clone().add(presetDirection('back')).length())
      .toBeCloseTo(0, 6);
    expect(presetDirection('left').clone().add(presetDirection('right')).length())
      .toBeCloseTo(0, 6);
  });

  it('the four side presets stay level with the target', () => {
    for (const p of ['front', 'back', 'left', 'right'] as const) {
      const pose = presetPose(p, box([-2, 0, -2], [2, 4, 2]));
      expect(pose.position.y, `${p} must not tilt`).toBeCloseTo(pose.target.y, 6);
    }
  });

  it('iso comes from front-right-above, and home is the same view', () => {
    const iso = presetDirection('iso');
    expect(iso.x).toBeGreaterThan(0);
    expect(iso.y).toBeGreaterThan(0);
    expect(iso.z).toBeGreaterThan(0);
    expect(iso.length()).toBeCloseTo(1, 6);
    expect(presetDirection('home').equals(iso)).toBe(true);
  });

  it('every preset direction is a unit vector', () => {
    for (const p of CAMERA_PRESETS) {
      expect(presetDirection(p).length(), `${p}`).toBeCloseTo(1, 6);
    }
  });

  it('the target is the AABB centre, not its corner', () => {
    const pose = presetPose('front', box([0, 0, 0], [10, 4, 2]));
    expect(pose.target.toArray()).toEqual([5, 2, 1]);
  });

  it('a bigger box is framed from further away', () => {
    const near = presetPose('iso', box([-1, -1, -1], [1, 1, 1])).distance;
    const far = presetPose('iso', box([-10, -10, -10], [10, 10, 10])).distance;
    expect(far).toBeGreaterThan(near);
  });

  it('an EMPTY box yields a finite pose rather than NaN', () => {
    // Box3.getBoundingSphere on an empty box gives an infinite centre, and a
    // camera at infinity renders black with no error attached.
    const pose = presetPose('iso', new Box3().makeEmpty());
    for (const n of [...pose.position.toArray(), ...pose.target.toArray(), pose.distance]) {
      expect(Number.isFinite(n)).toBe(true);
    }
    expect(pose.distance).toBeGreaterThan(0);
  });

  it('isCameraPreset accepts every listed name and nothing else', () => {
    for (const p of CAMERA_PRESETS) expect(isCameraPreset(p)).toBe(true);
    for (const bad of ['ISO', 'bottom', 'perspective', '', 'iso ']) {
      expect(isCameraPreset(bad), bad).toBe(false);
    }
  });
});

describe('T5 — the measured fit replaces the fallback distance (D-A5)', () => {
  it('keeps the preset DIRECTION and takes the measured DISTANCE and TARGET', () => {
    const pose = presetPose('front', box([-1, -1, -1], [1, 1, 1]));
    const before = pose.position.clone().sub(pose.target).normalize();

    const measured = { position: new Vector3(0, 0, 40), target: new Vector3(0, 5, 0) };
    const after = applyMeasuredDistance(pose, measured);

    expect(after.distance).toBeCloseTo(measured.position.distanceTo(measured.target), 6);
    expect(after.target.equals(measured.target)).toBe(true);
    // Direction preserved exactly — the whole point of measuring rather than
    // adopting the fit's own pose.
    const dir = after.position.clone().sub(after.target).normalize();
    expect(dir.distanceTo(before)).toBeCloseTo(0, 6);
    expect(after.position.distanceTo(after.target)).toBeCloseTo(after.distance, 6);
  });

  it('ignores a degenerate measurement instead of collapsing the camera', () => {
    const pose = presetPose('iso', box([-1, -1, -1], [1, 1, 1]));
    const zero = { position: new Vector3(1, 1, 1), target: new Vector3(1, 1, 1) };
    expect(applyMeasuredDistance(pose, zero)).toEqual(pose);
    const nan = { position: new Vector3(NaN, 0, 0), target: new Vector3(0, 0, 0) };
    expect(applyMeasuredDistance(pose, nan)).toEqual(pose);
  });
});

// ─── The tool ───────────────────────────────────────────────────────────

/** A viewer whose camera is owned by `owner`. */
function ownedViewer(owner: 'fpv' | 'follow' | 'xr'): RVViewer {
  return {
    getPlugin: (id: string) => {
      if (id === 'fpv') return owner === 'fpv' ? { id, isActive: true } : { id, isActive: false };
      if (id === 'webxr') return owner === 'xr' ? { isPresenting: true } : { isPresenting: false };
      return undefined;
    },
    cameraFollowMode: owner === 'follow' ? 'sit-on' : 'off',
    getCameraState: () => { throw new Error('the guard must refuse BEFORE reading the camera'); },
    animateCameraTo: () => { throw new Error('the guard must refuse BEFORE moving the camera'); },
    fitToNodes: () => { throw new Error('the guard must refuse BEFORE fitting'); },
  } as unknown as RVViewer;
}

describe('T5 — web_camera_view schema and guards', () => {
  const schemas = generateToolSchemas(new McpViewTools(() => undefined));
  const view = schemas.find((s) => s.name === 'web_camera_view');
  const orbit = schemas.find((s) => s.name === 'web_camera_orbit');

  it('is announced, takes preset + optional target, and is gated as a write', () => {
    expect(view, 'web_camera_view must be announced').toBeTruthy();
    expect(Object.keys(view!.inputSchema.properties).sort()).toEqual(['preset', 'target']);
    expect(view!.inputSchema.required).toEqual(['preset']);
    // Viewport-transient tools are writes: a watching operator sees the jump.
    expect(view!.annotations?.readOnlyHint).toBe(false);
  });

  it('names every preset in its description, so the list is discoverable', () => {
    for (const p of CAMERA_PRESETS) expect(view!.description).toContain(p);
  });

  it('web_camera_orbit gained pivot WITHOUT losing anything', () => {
    expect(Object.keys(orbit!.inputSchema.properties).sort())
      .toEqual(['distanceFactor', 'pitchDeg', 'pivot', 'yawDeg']);
    // Still the only required parameter — `pivot` may not become mandatory, or
    // every existing caller breaks.
    expect(orbit!.inputSchema.required).toEqual(['yawDeg']);
  });

  it('refuses an unknown preset by listing the valid ones', async () => {
    const tools = new McpViewTools(() => ({
      getPlugin: () => undefined, cameraFollowMode: 'off',
    } as unknown as RVViewer));
    const out = JSON.parse(await tools.webCameraView('bottom')) as { error: string };
    expect(out.error).toContain('bottom');
    expect(out.error).toContain('iso');
  });

  it('refuses under FPV, follow and XR — and moves NOTHING (D-A2)', async () => {
    for (const owner of ['fpv', 'follow', 'xr'] as const) {
      // The stub throws from getCameraState/animateCameraTo/fitToNodes, so a
      // guard that ran too late would surface as an exception, not a pass.
      const tools = new McpViewTools(() => ownedViewer(owner));
      const viewOut = JSON.parse(await tools.webCameraView('top')) as { blockedBy: string };
      expect(viewOut.blockedBy, `web_camera_view under ${owner}`).toBe(owner);
      const orbitOut = JSON.parse(await tools.webCameraOrbit(90, 0, 1)) as { blockedBy: string };
      expect(orbitOut.blockedBy, `web_camera_orbit under ${owner}`).toBe(owner);
    }
  });

  it('refuses pivot="selection" with an empty selection instead of orbiting the origin', async () => {
    const tools = new McpViewTools(() => ({
      getPlugin: () => undefined,
      cameraFollowMode: 'off',
      getCameraState: () => ({ position: new Vector3(0, 0, 10), target: new Vector3() }),
      selectionManager: { getSnapshot: () => ({ selectedPaths: [] }) },
    } as unknown as RVViewer));
    const out = JSON.parse(await tools.webCameraOrbit(45, 0, 1, 'selection')) as { error: string };
    expect(out.error).toContain('nothing is selected');
  });
});
