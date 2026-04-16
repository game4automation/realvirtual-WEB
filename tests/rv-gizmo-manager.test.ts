// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Mesh, BoxGeometry, Group } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';

describe('GizmoOverlayManager', () => {
  let scene: Scene;
  let mgr: GizmoOverlayManager;
  beforeEach(() => {
    scene = new Scene();
    mgr = new GizmoOverlayManager(scene);
  });

  it('shares material across same color+opacity+blinkHz', () => {
    const n1 = new Mesh(new BoxGeometry());
    const n2 = new Mesh(new BoxGeometry());
    scene.add(n1, n2);
    mgr.create(n1, { shape: 'transparent-shell', color: 0xff0000, opacity: 0.5, blinkHz: 0 });
    mgr.create(n2, { shape: 'transparent-shell', color: 0xff0000, opacity: 0.5, blinkHz: 0 });
    expect((mgr as any)._materialCache.size).toBe(1);
  });

  it('creates distinct materials for different blinkHz (KEY FIX)', () => {
    const n1 = new Mesh(new BoxGeometry());
    const n2 = new Mesh(new BoxGeometry());
    scene.add(n1, n2);
    mgr.create(n1, { shape: 'transparent-shell', color: 0xff0000, opacity: 0.5, blinkHz: 1 });
    mgr.create(n2, { shape: 'transparent-shell', color: 0xff0000, opacity: 0.5, blinkHz: 2 });
    expect((mgr as any)._materialCache.size).toBe(2);
  });

  it('setGlobalVisibility toggles all gizmos', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    const h = mgr.create(n, { shape: 'box', color: 0xffffff, opacity: 1 });
    mgr.setGlobalVisibility(false);
    const entry = (mgr as any)._entries.get(h.id);
    expect(entry.root.visible).toBe(false);
    mgr.setGlobalVisibility(true);
    expect(entry.root.visible).toBe(true);
  });

  it('setGlobalShapeOverride swaps shape', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    const h = mgr.create(n, { shape: 'box', color: 0xffffff, opacity: 1 });
    mgr.setGlobalShapeOverride('sphere');
    const entry = (mgr as any)._entries.get(h.id);
    expect(entry.shape).toBe('sphere');
  });

  it('tick early-returns when no entries', () => {
    // No entries → tick should be a no-op (no throw, no state change)
    expect(() => mgr.tick(1000)).not.toThrow();
    expect((mgr as any)._entries.size).toBe(0);
  });

  it('blink modulates opacity via tick over time', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    mgr.create(n, { shape: 'transparent-shell', color: 0xff0000, opacity: 1.0, blinkHz: 1 });
    const matList = Array.from((mgr as any)._materialCache.values()) as any[];
    const meta = matList[0];

    // Spin tick across enough frames to trigger both phases
    const opacities: number[] = [];
    for (let i = 0; i < 80; i++) {
      mgr.tick(16);
      opacities.push((meta.material as any).opacity);
      // Busy-wait ~15ms (pushes performance.now forward)
      const t0 = performance.now();
      while (performance.now() - t0 < 15) { /* spin */ }
    }
    const maxOp = Math.max(...opacities);
    const minOp = Math.min(...opacities);
    expect(maxOp).toBeGreaterThan(minOp);
    expect(minOp).toBeGreaterThan(0);
  });

  it('mesh-overlay covers all mesh descendants', () => {
    const parent = new Group();
    parent.add(new Mesh(new BoxGeometry()), new Mesh(new BoxGeometry()));
    scene.add(parent);
    const h = mgr.create(parent, { shape: 'mesh-overlay', color: 0xff0000, opacity: 0.5 });
    const entry = (mgr as any)._entries.get(h.id);
    expect(entry.overlayMeshes.length).toBe(2);
  });

  it('mesh-overlay filters non-Mesh children', () => {
    const parent = new Group();
    parent.add(new Mesh(new BoxGeometry())); // keep
    parent.add(new Group()); // skip
    scene.add(parent);
    const h = mgr.create(parent, { shape: 'mesh-overlay', color: 0xff0000, opacity: 0.5 });
    const entry = (mgr as any)._entries.get(h.id);
    expect(entry.overlayMeshes.length).toBe(1);
  });

  it('dispose removes all gizmos from scene', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    mgr.create(n, { shape: 'sphere', color: 0xff0000, opacity: 0.5 });
    mgr.dispose();
    let found = 0;
    scene.traverse((c: any) => {
      if (c.userData?._rvGizmo) found++;
    });
    expect(found).toBe(0);
    expect((mgr as any)._entries.size).toBe(0);
  });

  it('setTagFilter hides non-matching tags', () => {
    const n1 = new Mesh(new BoxGeometry());
    n1.userData._rvTag = 'sensor';
    scene.add(n1);
    const n2 = new Mesh(new BoxGeometry());
    n2.userData._rvTag = 'drive';
    scene.add(n2);
    const h1 = mgr.create(n1, { shape: 'box', color: 0xff0000, opacity: 1 });
    const h2 = mgr.create(n2, { shape: 'box', color: 0xff0000, opacity: 1 });
    mgr.setTagFilter('sensor');
    const e1 = (mgr as any)._entries.get(h1.id);
    const e2 = (mgr as any)._entries.get(h2.id);
    expect(e1.root.visible).toBe(true);
    expect(e2.root.visible).toBe(false);
  });

  it('clearNode removes gizmos for node', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    mgr.create(n, { shape: 'box', color: 0xff0000, opacity: 1 });
    mgr.clearNode(n);
    expect((mgr as any)._entries.size).toBe(0);
  });

  it('handle.dispose() removes entry', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    const h = mgr.create(n, { shape: 'box', color: 0xff0000, opacity: 1 });
    expect((mgr as any)._entries.size).toBe(1);
    h.dispose();
    expect((mgr as any)._entries.size).toBe(0);
  });

  it('handle.update({ color, opacity, blinkHz }) rewires material via cache', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    const h = mgr.create(n, { shape: 'transparent-shell', color: 0xff0000, opacity: 0.5, blinkHz: 0 });
    h.update({ color: 0x00ff00, opacity: 0.8, blinkHz: 2 });
    const entry = (mgr as any)._entries.get(h.id);
    expect(entry.color).toBe(0x00ff00);
    expect(entry.baseOpacity).toBeCloseTo(0.8);
    expect(entry.blinkHz).toBe(2);
  });
});
