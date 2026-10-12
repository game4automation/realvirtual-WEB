// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-740 T1 (§9.1) — the agent's camera body: spawn, independence, lens
 * clamps, the hand-rolled ortho frustum, fault-tolerant persistence and
 * unprojection.
 *
 * Pure unit tests: `AgentEye` takes its viewport pose through a callback and
 * owns two three.js cameras, so none of this needs a viewer, a renderer or WebGL.
 *
 * The last test is a BUNDLE assertion, not a behaviour one: the embed viewer
 * imports `core/engine/*` directly and loads no plugins, so a single `.tsx`
 * import reachable from here would pull React + MUI into that bundle
 * (D-A3 / review R2-A-N1). It is the only guard on that, so it stays.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import {
  AgentEye, isValidPose, AGENT_EYE_STORAGE_PREFIX,
  EYE_DEFAULT_ASPECT, type ViewportPoseSnapshot,
} from '../src/core/engine/rv-agent-eye';
import agentEyeSource from '../src/core/engine/rv-agent-eye.ts?raw';

function makeEye(v: Partial<ViewportPoseSnapshot> = {}, modelKey: string | null = 'm1'): AgentEye {
  return new AgentEye({
    getViewportState: () => ({
      position: v.position ?? [1, 2, 3],
      target: v.target ?? [0, 0, 0],
      fov: v.fov ?? 50,
      projection: v.projection ?? 'perspective',
    }),
    modelKey,
  });
}

describe('AgentEye', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('spawns at the viewport pose on first ensure and is then independent of it', () => {
    let viewport: ViewportPoseSnapshot = {
      position: [1, 2, 3], target: [0, 0, 0], fov: 50, projection: 'perspective',
    };
    const eye = new AgentEye({ getViewportState: () => viewport, modelKey: 'm1' });
    expect(eye.exists).toBe(false);   // asking does not spawn

    const s = eye.ensure();
    expect([s.pose.px, s.pose.py, s.pose.pz]).toEqual([1, 2, 3]);
    expect(s.pose.fov).toBe(50);
    expect(s.pose.aspect).toBe(EYE_DEFAULT_ASPECT);
    expect(eye.exists).toBe(true);

    // The human now navigates somewhere else entirely — the body must not care.
    viewport = { position: [99, 99, 99], target: [9, 9, 9], fov: 20, projection: 'orthographic' };
    expect(eye.ensure().pose.px).toBe(1);

    eye.setPose({ px: 9 });
    expect(eye.ensure().pose.px).toBe(9);
  });

  it('clamps fov and aspect ON SET, so a reader never sees an out-of-range lens', () => {
    const eye = makeEye();
    eye.ensure();
    expect(eye.setLens({ aspect: 500 }).pose.aspect).toBe(5);
    expect(eye.setLens({ aspect: 0.001 }).pose.aspect).toBe(0.2);
    expect(eye.setLens({ fov: 1 }).pose.fov).toBe(5);
    expect(eye.setLens({ fov: 999 }).pose.fov).toBe(120);
    // Non-finite input is ignored rather than clamped to a boundary.
    expect(eye.setLens({ fov: Number.NaN }).pose.fov).toBe(120);
  });

  it('builds the orthographic frustum from distance x tan(fov/2) and aspect', () => {
    const eye = makeEye({ position: [0, 0, 10], target: [0, 0, 0], fov: 60, projection: 'orthographic' });
    eye.ensure();
    eye.setLens({ aspect: 500 });
    expect(eye.pose.aspect).toBe(5);

    const halfH = 10 * Math.tan((60 * Math.PI) / 360);
    expect(eye.orthoHalfHeight).toBeCloseTo(halfH, 6);
    const cam = eye.camera();
    expect(cam).toBeInstanceOf(OrthographicCamera);
    const ortho = cam as OrthographicCamera;
    expect(ortho.top).toBeCloseTo(halfH, 6);
    expect(ortho.right).toBeCloseTo(halfH * 5, 6);
    expect(ortho.bottom).toBeCloseTo(-halfH, 6);
    expect(ortho.left).toBeCloseTo(-halfH * 5, 6);

    // Moving further away widens the ortho frustum — the "zoom" of an ortho eye.
    eye.setPose({ pz: 20 });
    expect(ortho.top).toBeCloseTo(20 * Math.tan((60 * Math.PI) / 360), 6);
  });

  it('hands out a perspective camera carrying the pose lens', () => {
    const eye = makeEye({ position: [0, 0, 4], target: [0, 0, 0], fov: 35 });
    eye.ensure();
    eye.setLens({ aspect: 2 });
    const cam = eye.camera();
    expect(cam).toBeInstanceOf(PerspectiveCamera);
    expect((cam as PerspectiveCamera).fov).toBe(35);
    expect((cam as PerspectiveCamera).aspect).toBe(2);
    expect(cam.position.toArray()).toEqual([0, 0, 4]);
  });

  it('persists per model key, survives a throwing storage and rejects corrupt entries', () => {
    const eye = makeEye({ position: [0, 0, 1], fov: 45 });
    eye.ensure();
    eye.setPose({ px: 4 });
    expect(JSON.parse(sessionStorage.getItem(AGENT_EYE_STORAGE_PREFIX + 'm1')!).px).toBe(4);

    // Safari private mode throws on setItem; a failing write must be a no-op,
    // never an exception out of an MCP tool call.
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('quota', 'SecurityError'); };
    try {
      expect(() => eye.setPose({ px: 5 })).not.toThrow();
      expect(eye.pose.px).toBe(5);   // in-memory state still moves
    } finally {
      Storage.prototype.setItem = orig;
    }

    expect(isValidPose(JSON.parse('{"px":"nope"}'))).toBe(false);
    expect(isValidPose(null)).toBe(false);
    expect(isValidPose({ px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, fov: 45, aspect: 1, projection: 'sideways' })).toBe(false);
    expect(isValidPose({ px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, fov: 500, aspect: 1, projection: 'perspective' })).toBe(false);
    expect(isValidPose({ px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, fov: 45, aspect: 1, projection: 'perspective' })).toBe(true);
  });

  it('restores a persisted pose instead of the viewport pose, and drops a corrupt one', () => {
    const first = makeEye({ position: [7, 8, 9] });
    first.ensure();

    // Same tab, same model, fresh body (an F5): the stored pose wins.
    const reloaded = makeEye({ position: [0, 0, 0] });
    expect(reloaded.ensure().pose.px).toBe(7);

    sessionStorage.setItem(AGENT_EYE_STORAGE_PREFIX + 'm1', '{ not json');
    const corrupt = makeEye({ position: [3, 3, 3] });
    expect(corrupt.ensure().pose.px).toBe(3);   // falls back to the viewport pose

    // A different model gets its own body, and no key at all disables storage.
    const other = new AgentEye({
      getViewportState: () => ({ position: [5, 5, 5], target: [0, 0, 0], fov: 45, projection: 'perspective' }),
      modelKey: null,
    });
    other.ensure();
    expect(sessionStorage.getItem(AGENT_EYE_STORAGE_PREFIX + 'null')).toBeNull();
  });

  it('loadPersisted adopts a stored pose but never spawns one', () => {
    const seeded = makeEye({ position: [2, 4, 6] });
    seeded.ensure();

    const fresh = makeEye({ position: [0, 0, 0] });
    expect(fresh.loadPersisted()).toBe(true);
    expect(fresh.pose.py).toBe(4);

    sessionStorage.clear();
    const bodiless = makeEye({ position: [0, 0, 0] });
    expect(bodiless.loadPersisted()).toBe(false);
    expect(bodiless.exists).toBe(false);
  });

  it('unproject aims at the view direction in perspective and stays parallel in ortho', () => {
    const eye = makeEye({ position: [0, 0, 10], target: [0, 0, 0], fov: 60 });
    eye.ensure();
    eye.setLens({ aspect: 1 });

    const centre = eye.unproject(0.5, 0.5);
    expect(centre.origin.toArray()).toEqual([0, 0, 10]);
    expect(centre.direction.x).toBeCloseTo(0, 6);
    expect(centre.direction.y).toBeCloseTo(0, 6);
    expect(centre.direction.z).toBeCloseTo(-1, 6);

    // y = 0 is the TOP of the image, so the ray must go up (+y).
    const top = eye.unproject(0.5, 0);
    expect(top.direction.y).toBeGreaterThan(0);
    const right = eye.unproject(1, 0.5);
    expect(right.direction.x).toBeGreaterThan(0);

    // Writing into caller-owned vectors keeps a pick loop allocation-free.
    const o = new Vector3(); const d = new Vector3();
    const out = eye.unproject(0.5, 0.5, o, d);
    expect(out.origin).toBe(o);
    expect(out.direction).toBe(d);

    eye.setLens({ projection: 'orthographic' });
    const a = eye.unproject(0.2, 0.3);
    const b = eye.unproject(0.8, 0.7);
    expect(a.direction.dot(b.direction)).toBeCloseTo(1, 6);   // parallel
    expect(a.origin.distanceTo(b.origin)).toBeGreaterThan(0); // origin slides
  });

  it('frustumCornersFor writes 12 floats into the caller buffer, aspect-correct', () => {
    const eye = makeEye({ position: [0, 0, 5], target: [0, 0, 0], fov: 90 });
    eye.ensure();
    eye.setLens({ aspect: 2 });

    const buf = new Array<number>(12).fill(0);
    const corners = eye.frustumCornersFor(1, buf);
    expect(corners).toBe(buf);                    // no allocation
    expect(corners[1]).toBeCloseTo(1, 6);         // halfH = tan(45) x 1
    expect(corners[0]).toBeCloseTo(-2, 6);        // halfW = halfH x aspect
    expect(corners[2]).toBeCloseTo(-1, 6);        // depth on -Z

    // Ortho corners do not shrink with depth: the frustum is a box.
    eye.setLens({ projection: 'orthographic' });
    const near = eye.frustumCornersFor(0.05);
    const far = eye.frustumCornersFor(0.6);
    expect(near[1]).toBeCloseTo(far[1], 6);
  });

  it('reset drops the body, and the next ensure spawns at the CURRENT viewport pose', () => {
    let viewport: ViewportPoseSnapshot = {
      position: [1, 1, 1], target: [0, 0, 0], fov: 45, projection: 'perspective',
    };
    const eye = new AgentEye({ getViewportState: () => viewport, modelKey: null });
    eye.ensure();
    eye.attached = true;

    eye.reset();
    expect(eye.exists).toBe(false);
    expect(eye.attached).toBe(false);

    viewport = { position: [4, 5, 6], target: [1, 1, 1], fov: 30, projection: 'orthographic' };
    const s = eye.ensure();
    expect([s.pose.px, s.pose.py, s.pose.pz]).toEqual([4, 5, 6]);
    expect(s.pose.projection).toBe('orthographic');
  });

  it('notifies subscribers on pose and attach changes, and survives a throwing listener', () => {
    const eye = makeEye();
    const seen: number[] = [];
    eye.onChange(() => { throw new Error('bad listener'); });
    const off = eye.onChange((s) => seen.push(s.pose.px));

    eye.ensure();
    eye.setPose({ px: 42 });
    expect(seen).toContain(42);

    off();
    eye.setPose({ px: 43 });
    expect(seen).not.toContain(43);
  });

  it('survives a degenerate pose (eye on its own target) without a NaN matrix', () => {
    const eye = makeEye({ position: [1, 1, 1], target: [1, 1, 1] });
    eye.ensure();
    const cam = eye.camera();
    for (const n of cam.matrixWorld.elements) expect(Number.isFinite(n)).toBe(true);
  });

  it('core module imports no .tsx — the embed bundle stays React-free', () => {
    const src = agentEyeSource as unknown as string;
    expect(src).not.toMatch(/from\s+'[^']*\.tsx'/);
    expect(src).not.toMatch(/camera-startpos-plugin/);
    expect(src).not.toMatch(/from\s+'[^']*core\/hmi\//);
  });
});
