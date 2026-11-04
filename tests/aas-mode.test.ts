// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-682 §9.2 — the AAS mode (Weg C: emphasis + badges + pick restriction,
 * no dimming — see the plan's `## Spike-Ergebnis`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Sprite, type CanvasTexture } from 'three';
import { AasModeController, AAS_MODE_AUX_ID, aasBadgeText } from '../src/plugins/aas-mode';
import { AAS_BADGE_CAP } from '../src/plugins/aas-mode-badges';
import { AAS_RESOLUTION_KEY, resetAasResolution } from '../src/plugins/aas-resolution';
import { HIGHLIGHT_OVERLAY_LAYER } from '../src/core/engine/rv-group-registry';

function aasPart(name: string, resolution = 'resolved', x = 0): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(x, 0, 0);
  n.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  n.userData._rvAasLink = { aasId: `urn:${name}`, description: `TYPE-${name}` };
  n.userData[AAS_RESOLUTION_KEY] = resolution;
  return n;
}

function fakeViewer(parts: Object3D[]) {
  const scene = new Object3D();
  for (const p of parts) scene.add(p);
  scene.updateMatrixWorld(true);
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  let allow: ((n: Object3D) => boolean) | null = null;
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const viewer = {
    scene,
    camera,
    renderer: { domElement: canvas },
    modes: { activeMode: 'hmi' as string },
    highlighter: { setAuxEmphasis: vi.fn() },
    raycastManager: { getAllowFilter: () => allow, setAllowFilter: (f: typeof allow) => { allow = f; } },
    selectionManager: { select: vi.fn() },
    markRenderDirty: vi.fn(),
    on: (ev: string, fn: (p: unknown) => void) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(fn);
      return () => { handlers.get(ev)?.delete(fn); };
    },
    emit: (ev: string, p?: unknown) => { for (const fn of [...(handlers.get(ev) ?? [])]) fn(p); },
    getAllow: () => allow,
  };
  return viewer;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetAasResolution();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
});
afterEach(() => { fetchSpy.mockRestore(); vi.restoreAllMocks(); });

describe('plan-682 AAS mode', () => {
  it('should apply aux emphasis to exactly the resolvable AAS nodes when switched on', () => {
    const a = aasPart('A'), b = aasPart('B'), hidden = aasPart('C', 'unknown-id');
    const v = fakeViewer([a, b, hidden]);
    const mode = new AasModeController(v as never);
    expect(mode.getSnapshot()).toEqual({ on: false, count: 2 });
    mode.setOn(true);
    expect(mode.getSnapshot().on).toBe(true);
    const [id, roots, opts] = v.highlighter.setAuxEmphasis.mock.calls.at(-1)!;
    expect(id).toBe(AAS_MODE_AUX_ID);
    expect(new Set(roots)).toEqual(new Set([a, b]));
    expect(opts).toEqual({ color: 0x4fc3f7 });
    mode.dispose();
  });

  it('should clear emphasis, badges and the pick filter on switch-off, model clear and dispose', () => {
    const v = fakeViewer([aasPart('A')]);
    const mode = new AasModeController(v as never);
    for (const stop of ['off', 'reset', 'dispose'] as const) {
      mode.setOn(true);
      expect(mode.badges!.size).toBe(1);
      expect(v.getAllow()).not.toBeNull();
      if (stop === 'off') mode.setOn(false);
      else if (stop === 'reset') { mode.reset(); mode.setOn(false); }
      else mode.dispose();
      expect(v.highlighter.setAuxEmphasis).toHaveBeenLastCalledWith(AAS_MODE_AUX_ID, null);
      expect(mode.badges).toBeNull();
      expect(v.getAllow()).toBeNull();
      expect(v.scene.children.some(c => c.name === '__rv_aas_mode_badges')).toBe(false);
      if (stop === 'reset') { v.scene.updateMatrixWorld(true); v.emit('layout-content-added', {}); }
    }
  });

  it('should rebuild on layout-content-added and layout-content-removed; switch off when the last AAS part is removed', () => {
    const a = aasPart('A');
    const v = fakeViewer([a]);
    const mode = new AasModeController(v as never);
    mode.setOn(true);
    const b = aasPart('B', 'resolved', 3);
    v.scene.add(b); v.scene.updateMatrixWorld(true);
    v.emit('layout-content-added', { root: b });
    expect(mode.getSnapshot().count).toBe(2);
    expect(mode.badges!.size).toBe(2);
    v.scene.remove(b);
    v.emit('layout-content-removed', {});
    expect(mode.getSnapshot()).toEqual({ on: true, count: 1 });
    v.scene.remove(a);
    v.emit('layout-content-removed', {});
    expect(mode.getSnapshot()).toEqual({ on: false, count: 0 });
    mode.dispose();
  });

  it('should restrict picking to AAS parts while on and keep a prior allow filter stacked', () => {
    const a = aasPart('A');
    const other = new Object3D();
    const v = fakeViewer([a, other]);
    const prior = vi.fn(() => true);
    v.raycastManager.setAllowFilter(prior);
    const mode = new AasModeController(v as never);
    mode.setOn(true);
    const f = v.getAllow()!;
    expect(f(a.children[0])).toBe(true);
    expect(f(other)).toBe(false);
    expect(prior).toHaveBeenCalled();
    mode.setOn(false);
    expect(v.getAllow()).toBe(prior);
  });

  it('should switch off when the editor mode is entered and refuse to switch on there', () => {
    const v = fakeViewer([aasPart('A')]);
    const mode = new AasModeController(v as never);
    mode.setOn(true);
    v.emit('mode-changed', { from: 'hmi', to: 'editor' });
    expect(mode.isOn).toBe(false);
    v.modes.activeMode = 'editor';
    mode.setOn(true);
    expect(mode.isOn).toBe(false);
  });

  it('should put badges on the overlay layer next to the part and show the type code', () => {
    const a = aasPart('A');
    const v = fakeViewer([a]);
    const mode = new AasModeController(v as never);
    mode.setOn(true);
    const sprite = mode.badges!.group.children[0] as Sprite;
    expect(sprite.layers.isEnabled(0)).toBe(false);
    expect(sprite.layers.isEnabled(HIGHLIGHT_OVERLAY_LAYER)).toBe(true);
    // Anchored on the top corner of the part's bounds, not inside it.
    expect(sprite.position.x).toBeCloseTo(0.5);
    expect(sprite.position.y).toBeCloseTo(0.5);
    expect(aasBadgeText(a, null)).toBe('TYPE-A');
    expect(aasBadgeText(a, { 'urn:A': { file: 'a.aasx', idShort: 'AAS_Type_X-1', productName: 'X-1 Gripper' } })).toBe('X-1 Gripper');
    const bare = aasPart('B'); bare.userData._rvAasLink = { aasId: 'urn:B' };
    expect(aasBadgeText(bare, { 'urn:B': { file: 'b.aasx', idShort: 'AAS_Type_DGC-25' } })).toBe('DGC-25');
    mode.dispose();
  });

  it('should not create badges beyond the cap and log once', () => {
    const parts = Array.from({ length: AAS_BADGE_CAP + 5 }, (_, i) => aasPart(`P${i}`));
    const v = fakeViewer(parts);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const mode = new AasModeController(v as never);
    mode.setOn(true);
    expect(mode.badges!.size).toBe(AAS_BADGE_CAP);
    v.emit('layout-content-added', {});
    expect(info).toHaveBeenCalledTimes(1);
    mode.dispose();
  });

  it('should pin the node tooltip when its badge is clicked', async () => {
    const a = aasPart('A');
    const v = fakeViewer([a]);
    const mode = new AasModeController(v as never);
    mode.setOn(true);
    mode.update();
    const sprite = mode.badges!.group.children[0] as Sprite;
    const ndc = sprite.position.clone().project(v.camera);
    const x = (ndc.x + 1) / 2 * 800 + 5;
    const y = (1 - ndc.y) / 2 * 600 - 3;
    expect(mode.badges!.hitTest(x, y, v.camera, v.renderer.domElement.getBoundingClientRect())).toBe(a);
    v.renderer.domElement.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y }));
    v.renderer.domElement.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y }));
    await new Promise(r => setTimeout(r, 5));
    expect(v.selectionManager.select).toHaveBeenCalledWith('A', expect.any(Array));
    mode.dispose();
  });

  it('should dispose every badge texture/material after 10 on/off/clear cycles', () => {
    const v = fakeViewer([aasPart('A'), aasPart('B', 'resolved', 2)]);
    const mode = new AasModeController(v as never);
    const created: CanvasTexture[] = [];
    let disposed = 0;
    for (let i = 0; i < 10; i++) {
      mode.setOn(true);
      for (const c of mode.badges!.group.children) {
        const tex = ((c as Sprite).material.map as CanvasTexture);
        created.push(tex);
        tex.addEventListener('dispose', () => { disposed++; });
      }
      if (i % 2) mode.setOn(false); else mode.reset();
    }
    expect(created.length).toBe(20);
    expect(disposed).toBe(20);
    mode.dispose();
  });
});
