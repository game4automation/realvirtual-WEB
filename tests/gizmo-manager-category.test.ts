// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import {
  setOverlayVisible, showAllOverlays, resetOverlayProducers, getOverlaySnapshot,
} from '../src/core/overlay-visibility-store';

describe('GizmoOverlayManager overlay category (plan-250)', () => {
  let scene: Scene;
  let mgr: GizmoOverlayManager;

  beforeEach(() => {
    localStorage.clear();
    resetOverlayProducers();
    showAllOverlays();
    scene = new Scene();
    mgr = new GizmoOverlayManager(scene);
  });

  // Test hygiene: drop the store subscription so it does not accumulate across
  // the file's tests (plan-250 §9.2).
  afterEach(() => {
    mgr.destroy();
    resetOverlayProducers();
    showAllOverlays();
  });

  function makeGizmo(category: 'status' | 'gizmos') {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    return mgr.create(n, { shape: 'box', color: 0xffffff, opacity: 1, category });
  }

  it('registers the category as present on create', () => {
    makeGizmo('status');
    expect(getOverlaySnapshot().present.map(c => c.id)).toContain('status');
  });

  it('hides/shows the gizmo when the category is toggled', () => {
    const h = makeGizmo('status');
    const entry = (mgr as any)._entries.get(h.id);
    expect(entry.root.visible).toBe(true);
    setOverlayVisible('status', false);
    expect(entry.root.visible).toBe(false);
    setOverlayVisible('status', true);
    expect(entry.root.visible).toBe(true);
  });

  it('leaves an uncategorized gizmo untouched by category toggles', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    const h = mgr.create(n, { shape: 'box', color: 0xffffff, opacity: 1 }); // no category
    const entry = (mgr as any)._entries.get(h.id);
    setOverlayVisible('status', false);
    expect(entry.root.visible).toBe(true);
  });

  it('unregisters presence on dispose', () => {
    const h = makeGizmo('gizmos');
    expect(getOverlaySnapshot().present.map(c => c.id)).toContain('gizmos');
    h.dispose();
    expect(getOverlaySnapshot().present.map(c => c.id)).not.toContain('gizmos');
  });

  it('dispose is idempotent — double dispose does not corrupt the shared refcount', () => {
    const a = makeGizmo('status'); // producer 1
    const b = makeGizmo('status'); // producer 2 (shared 'status')
    a.dispose();
    a.dispose(); // second dispose must be a no-op
    // b still holds 'status' present
    expect(getOverlaySnapshot().present.map(c => c.id)).toContain('status');
    b.dispose();
    expect(getOverlaySnapshot().present.map(c => c.id)).not.toContain('status');
  });
});
