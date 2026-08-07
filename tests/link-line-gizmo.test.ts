// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * link-line-gizmo.test.ts — plan-259 §9.7.
 *
 * 'link-line' gizmo shape: cable between two nodes, per-frame endpoint update
 * WITHOUT geometry rebuild (same BufferAttribute array instance), overlay
 * category 'connections' toggle, dispose idempotence (_disposeEntry guard).
 * Template: tests/gizmo-manager-category.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene, Object3D, Line, BufferAttribute } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import {
  setOverlayVisible, showAllOverlays, resetOverlayProducers, getOverlaySnapshot,
} from '../src/core/overlay-visibility-store';

describe('link-line gizmo (plan-259 cables)', () => {
  let scene: Scene;
  let mgr: GizmoOverlayManager;
  let from: Object3D;
  let to: Object3D;

  beforeEach(() => {
    localStorage.clear();
    resetOverlayProducers();
    showAllOverlays();
    scene = new Scene();
    mgr = new GizmoOverlayManager(scene);
    from = new Object3D();
    from.position.set(1, 0, 0);
    to = new Object3D();
    to.position.set(4, 2, 0);
    scene.add(from, to);
  });

  afterEach(() => {
    mgr.destroy();
    resetOverlayProducers();
    showAllOverlays();
  });

  function makeCable() {
    return mgr.create(from, {
      shape: 'link-line',
      color: 0x29b6f6,
      opacity: 0.9,
      linkTo: to,
      category: 'connections',
    });
  }

  it('creates a 2-point Line between the endpoint world positions', () => {
    const h = makeCable();
    const line = h.root as Line;
    expect(line.isLine).toBe(true);
    const attr = line.geometry.getAttribute('position') as BufferAttribute;
    expect(attr.count).toBe(2);
    expect([attr.getX(0), attr.getY(0), attr.getZ(0)]).toEqual([1, 0, 0]);
    expect([attr.getX(1), attr.getY(1), attr.getZ(1)]).toEqual([4, 2, 0]);
  });

  it('endpoint update writes positions WITHOUT rebuilding the geometry', () => {
    const h = makeCable();
    const line = h.root as Line;
    const geoBefore = line.geometry;
    const attrBefore = line.geometry.getAttribute('position') as BufferAttribute;
    const arrayBefore = attrBefore.array;

    to.position.set(10, 5, -3);
    mgr.updateLinkLine(h.id);

    const attrAfter = line.geometry.getAttribute('position') as BufferAttribute;
    expect(line.geometry).toBe(geoBefore);        // no rebuild
    expect(attrAfter).toBe(attrBefore);           // same attribute
    expect(attrAfter.array).toBe(arrayBefore);    // same backing array (no GC)
    expect([attrAfter.getX(1), attrAfter.getY(1), attrAfter.getZ(1)]).toEqual([10, 5, -3]);
  });

  it("registers + toggles through the 'connections' overlay category", () => {
    const h = makeCable();
    expect(getOverlaySnapshot().present.map((c) => c.id)).toContain('connections');
    expect(h.root.visible).toBe(true);
    setOverlayVisible('connections', false);
    expect(h.root.visible).toBe(false);
    setOverlayVisible('connections', true);
    expect(h.root.visible).toBe(true);
  });

  it('dispose is idempotent and frees the dedicated geometry + presence', () => {
    const h = makeCable();
    const line = h.root as Line;
    let disposed = 0;
    line.geometry.addEventListener('dispose', () => disposed++);
    h.dispose();
    h.dispose(); // idempotent — no double producer-unregister, no double dispose
    expect(disposed).toBe(1);
    expect(getOverlaySnapshot().present.map((c) => c.id)).not.toContain('connections');
    expect(scene.children).not.toContain(line);
  });
});
