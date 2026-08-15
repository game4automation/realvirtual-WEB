// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Contact-shadow bake for thumbnails (plan-712 §9.3).
 *
 * The optics (silhouette fidelity, blur quality) are a deliberate manual
 * acceptance step — the repo has no pixel-snapshot infrastructure. What is
 * tested here is everything that would break something else in the pipeline:
 * the plane's material flags, the epsilon offset that keeps flat assets out of
 * Z-fighting, the empty-bounds guard that would otherwise produce NaN
 * transforms, and the promise that baking leaves the subject's hierarchy and
 * camera-fit bounds exactly as they were.
 */

import { describe, it, expect } from 'vitest';
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { bakeContactShadow } from '../src/core/thumbnails/thumbnail-contact-shadow';

function makeRenderer(): WebGLRenderer {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const renderer = new WebGLRenderer({ canvas, alpha: true });
  renderer.setSize(64, 64, /* updateStyle */ false);
  return renderer;
}

/** A 2-unit cube in a scene, plus its world bounds — the caller's situation. */
function makeSubject(): { scene: Scene; subject: Mesh; bounds: Box3 } {
  const scene = new Scene();
  const subject = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
  scene.add(subject);
  return { scene, subject, bounds: new Box3().setFromObject(subject) };
}

describe('bakeContactShadow', () => {
  it('creates a transparent, non-depth-writing plane just below bounds.min.y', () => {
    const renderer = makeRenderer();
    const { subject, bounds } = makeSubject();
    try {
      const bake = bakeContactShadow(renderer, subject, bounds)!;
      expect(bake).not.toBeNull();
      const material = bake.plane.material as MeshBasicMaterial;
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.map).toBeTruthy();

      // Lower bound stays relative to maxDim so it agrees with the epsilon
      // formula (max(maxDim * 0.002, 1e-4)) for large assets too.
      const maxDim = Math.max(...bounds.getSize(new Vector3()).toArray());
      expect(bake.plane.position.y).toBeLessThan(bounds.min.y);
      expect(bake.plane.position.y).toBeGreaterThan(bounds.min.y - Math.max(maxDim * 0.004, 0.01));
      bake.dispose();
    } finally {
      renderer.dispose();
    }
  });

  it('returns null for empty bounds instead of producing NaN transforms', () => {
    const renderer = makeRenderer();
    try {
      expect(bakeContactShadow(renderer, new Group(), new Box3())).toBeNull();
    } finally {
      renderer.dispose();
    }
  });

  it('does not change the camera-fit bounds of the subject', () => {
    const renderer = makeRenderer();
    const { subject } = makeSubject();
    try {
      const before = new Box3().setFromObject(subject);
      const bake = bakeContactShadow(renderer, subject, before); // plane is a sibling, not a child
      expect(new Box3().setFromObject(subject).equals(before)).toBe(true);
      bake?.dispose();
    } finally {
      renderer.dispose();
    }
  });

  it('puts the subject back into its original parent after the bake', () => {
    const renderer = makeRenderer();
    const { scene, subject, bounds } = makeSubject();
    try {
      const bake = bakeContactShadow(renderer, subject, bounds);
      expect(subject.parent).toBe(scene);
      bake?.dispose();
    } finally {
      renderer.dispose();
    }
  });

  it('bakes a flat asset without collapsing the plane or the depth range', () => {
    const renderer = makeRenderer();
    const scene = new Scene();
    // Sheet metal: zero height, the co-planar Z-fighting case.
    const flat = new Mesh(new BoxGeometry(4, 0, 4), new MeshStandardMaterial());
    scene.add(flat);
    const bounds = new Box3().setFromObject(flat);
    try {
      const bake = bakeContactShadow(renderer, flat, bounds)!;
      expect(bake).not.toBeNull();
      expect(Number.isFinite(bake.plane.position.y)).toBe(true);
      expect(bake.plane.position.y).toBeLessThan(bounds.min.y);
      bake.dispose();
    } finally {
      renderer.dispose();
    }
  });

  it('bakes a meshless subject silently instead of failing', () => {
    const renderer = makeRenderer();
    const group = new Group();
    // Non-empty bounds without any mesh: an accepted "no shadow" outcome.
    const bounds = new Box3(new Vector3(-1, 0, -1), new Vector3(1, 2, 1));
    try {
      const bake = bakeContactShadow(renderer, group, bounds);
      expect(bake).not.toBeNull();
      bake?.dispose();
    } finally {
      renderer.dispose();
    }
  });
});
