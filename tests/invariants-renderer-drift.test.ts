// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.7 — I5 over a return cycle A -> B -> A.
 *
 * The positive proof needs an ARTIFICIAL leak: over `hmi -> commissioning ->
 * hmi` the pilot document measured 114 / 44 / 42 unchanged at all 21 sample
 * points, so a mode switch alone is a NULL test (plan 2.6). The leak is
 * therefore made on purpose — and with a REAL renderer, so the measurement
 * source itself is proven to react rather than assumed to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import {
  armInvariantBaseline,
  checkInvariants,
  invariantsOnRenderedFrame,
  resetInvariants,
} from '../src/core/engine/rv-invariants';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { makeStubViewer, type StubViewer } from './helpers/invariant-stub-viewer';

function takeBaseline(v: StubViewer): void {
  armInvariantBaseline(v);
  invariantsOnRenderedFrame();
}

function returnCycle(v: StubViewer): void {
  checkInvariants(v, 'mode-changing');
  v.activeMode = 'commissioning';
  checkInvariants(v, 'mode-changed');
  invariantsOnRenderedFrame();
  checkInvariants(v, 'mode-changing');
  v.activeMode = 'hmi';
  checkInvariants(v, 'mode-changed');
  invariantsOnRenderedFrame();
}

describe('I5 — renderer resource drift', () => {
  let errors: string[];

  beforeEach(() => {
    clearAllProblems();
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  });

  it('stays silent when geometries and textures come back unchanged', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    takeBaseline(v);
    returnCycle(v);
    expect(errors.filter((e) => e.includes('I5'))).toEqual([]);
  });

  it('fires with both numbers on a geometry that was not disposed', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    takeBaseline(v);
    v.memory.geometries = 115; // rendered, then deliberately not disposed
    returnCycle(v);
    expect(errors.some((e) => e.includes('I5 geometries: 114 -> 115'))).toBe(true);
  });

  it('fires on a texture leak with the same message shape', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    takeBaseline(v);
    v.memory.textures = 46;
    returnCycle(v);
    expect(errors.some((e) => e.includes('I5 textures: 44 -> 46'))).toBe(true);
  });

  it('treats `programs` as an observation, never as a violation', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    takeBaseline(v);
    v.programs = 99;
    returnCycle(v);
    expect(errors.filter((e) => e.includes('I5'))).toEqual([]);
  });

  it('resets its baseline on model-loaded — a new model brings other numbers', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    takeBaseline(v);
    v.memory.geometries = 500;
    checkInvariants(v, 'model-loaded'); // drops baseline and reservation
    returnCycle(v);
    expect(errors.filter((e) => e.includes('I5'))).toEqual([]);
  });
});

describe('I5 — the measurement source reacts (real WebGLRenderer)', () => {
  let renderer: WebGLRenderer | null = null;

  afterEach(() => { renderer?.dispose(); renderer = null; });

  it('counts a rendered, undisposed geometry in renderer.info.memory', () => {
    renderer = new WebGLRenderer({ antialias: false });
    renderer.setSize(64, 64);
    const scene = new Scene();
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 5;

    renderer.render(scene, camera);
    const before = renderer.info.memory.geometries;

    // ACTUALLY rendered — a geometry only reaches renderer.info once it was
    // uploaded, which is why the contract says "rendered", not "created".
    const material = new MeshBasicMaterial();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
    scene.add(mesh);
    renderer.render(scene, camera);

    const leaked = renderer.info.memory.geometries;
    expect(leaked).toBe(before + 1);

    // Feed the REAL numbers through the invariant: this is the positive proof.
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    try {
      const v = makeStubViewer();
      resetInvariants(v);
      v.memory.geometries = before;
      takeBaseline(v);
      v.memory.geometries = leaked; // the undisposed geometry, really measured
      returnCycle(v);
      expect(errors.some((e) => e.includes(`I5 geometries: ${before} -> ${leaked}`))).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // And disposing brings it back — so the counter is a real signal.
    scene.remove(mesh);
    mesh.geometry.dispose();
    material.dispose();
    renderer.render(scene, camera);
    expect(renderer.info.memory.geometries).toBe(before);
  });
});
