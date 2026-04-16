// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scene, Mesh, BoxGeometry, Sprite } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';

describe('GizmoOverlayManager — text shape', () => {
  let scene: Scene;
  let mgr: GizmoOverlayManager;
  beforeEach(() => {
    scene = new Scene();
    mgr = new GizmoOverlayManager(scene);
  });

  it('creates a Sprite for text shape', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    const h = mgr.create(n, { shape: 'text', color: 0xffffff, opacity: 1, text: 'Hello' });
    const entry = (mgr as any)._entries.get(h.id);
    expect(entry.root).toBeInstanceOf(Sprite);
  });

  it('text shape bypasses material cache', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    mgr.create(n, { shape: 'text', color: 0xffffff, opacity: 1, text: 'A' });
    mgr.create(n, { shape: 'text', color: 0xffffff, opacity: 1, text: 'B' });
    // Each text gizmo gets its own CanvasTexture → not shared via cache
    // Material cache should remain empty for text-shape only usage
    expect((mgr as any)._materialCache.size).toBe(0);
  });

  it('update({ text }) re-renders canvas texture AND disposes old one (no VRAM leak)', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    const h = mgr.create(n, { shape: 'text', color: 0xffffff, opacity: 1, text: 'Before' });
    const entry = (mgr as any)._entries.get(h.id);
    const tex1 = entry.texture;
    const disposeSpy = vi.spyOn(tex1, 'dispose');
    h.update({ text: 'After' });
    const tex2 = entry.texture;
    expect(tex2).not.toBe(tex1); // new texture
    expect(disposeSpy).toHaveBeenCalled(); // old texture was disposed
  });

  it('text shape disposes texture on dispose()', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    const h = mgr.create(n, { shape: 'text', color: 0xffffff, opacity: 1, text: 'Hi' });
    const entry = (mgr as any)._entries.get(h.id);
    const tex = entry.texture;
    const disposeSpy = vi.spyOn(tex, 'dispose');
    h.dispose();
    expect(disposeSpy).toHaveBeenCalled();
  });

  it('text shape uses depthTest=false and renderOrder=11', () => {
    const n = new Mesh(new BoxGeometry());
    scene.add(n);
    const h = mgr.create(n, { shape: 'text', color: 0xffffff, opacity: 1, text: 'X' });
    const entry = (mgr as any)._entries.get(h.id);
    const sprite = entry.root as Sprite;
    expect(sprite.material.depthTest).toBe(false);
    expect(sprite.renderOrder).toBe(11);
  });
});
