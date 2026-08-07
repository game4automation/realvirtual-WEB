// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVHighlightManager — mode-driven strategy resolution.
 *
 * The visual is decided by the active HighlightProfile (overlay for HMI/DES,
 * outline for planner/editor) plus a per-root capability fallback matrix
 * (resolveStrategy). Key rules under test:
 *   - overlay profile NEVER takes the OutlinePass path, even for rendered meshes;
 *   - outline profile falls back per root when the subtree is fully batched
 *     (mask 0) or the OutlinePass is unavailable;
 *   - the bbox budget cap still applies on the overlay family;
 *   - per-call `visual` overrides the profile.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { RVHighlightManager, resolveStrategy } from '../src/core/engine/rv-highlight-manager';
import { MODE_HIGHLIGHT_PROFILES } from '../src/core/engine/rv-highlight-profiles';

/** Minimal stand-in for RVOutlineManager that reports available + records calls. */
function makeMockOutline() {
  return {
    available: true,
    hoverOutlined: [] as Object3D[],
    selectionOutlined: [] as Object3D[],
    setStyle() {},
    setHoverStyle() {},
    setHoverOutlined(objs: readonly Object3D[]) { this.hoverOutlined = [...objs]; },
    clearHover() { this.hoverOutlined = []; },
    setOutlined(objs: readonly Object3D[]) { this.selectionOutlined = [...objs]; },
    clear() { this.selectionOutlined = []; },
    get hoverPass() { return { selectedObjects: this.hoverOutlined }; },
    get pass() { return { selectedObjects: this.selectionOutlined }; },
  };
}

function makeMesh(rendered: boolean): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  if (!rendered) m.layers.mask = 0; // batched-source contract: visible=true, mask=0
  return m;
}

/** Count overlay meshes the manager added to the scene. */
function overlayCount(scene: Scene): number {
  let n = 0;
  scene.traverse(o => { if (o.userData?._highlightOverlay && o.parent) n++; });
  return n;
}

describe('resolveStrategy — fallback matrix', () => {
  const base = {
    outlineAvailable: true,
    hasRenderedMesh: true,
    proxyAvailable: false,
    meshCount: 5,
    maxMeshes: 200,
  };

  it('overlay profile never resolves to outline, even with rendered meshes', () => {
    expect(resolveStrategy({ ...base, desired: 'overlay' }))
      .toEqual({ strategy: 'overlay', fallback: false });
  });

  it('overlay profile takes fill-proxy when the proxy is available', () => {
    expect(resolveStrategy({ ...base, desired: 'overlay', proxyAvailable: true }))
      .toEqual({ strategy: 'fill-proxy', fallback: false });
  });

  it('overlay profile caps at bbox above the mesh budget (fallback)', () => {
    expect(resolveStrategy({ ...base, desired: 'overlay', meshCount: 500 }))
      .toEqual({ strategy: 'bbox', fallback: true });
  });

  it('outline profile uses outline when available and rendered', () => {
    expect(resolveStrategy({ ...base, desired: 'outline' }))
      .toEqual({ strategy: 'outline', fallback: false });
  });

  it('outline profile falls back to overlay for a fully batched root', () => {
    expect(resolveStrategy({ ...base, desired: 'outline', hasRenderedMesh: false }))
      .toEqual({ strategy: 'overlay', fallback: true });
  });

  it('outline profile falls back to overlay when OutlinePass is unavailable (WebGPU)', () => {
    expect(resolveStrategy({ ...base, desired: 'outline', outlineAvailable: false }))
      .toEqual({ strategy: 'overlay', fallback: true });
  });

  it('outline fallback still honors the proxy and the bbox cap', () => {
    expect(resolveStrategy({ ...base, desired: 'outline', hasRenderedMesh: false, proxyAvailable: true }))
      .toEqual({ strategy: 'fill-proxy', fallback: true });
    expect(resolveStrategy({ ...base, desired: 'outline', outlineAvailable: false, meshCount: 500 }))
      .toEqual({ strategy: 'bbox', fallback: true });
  });
});

describe('RVHighlightManager — profile-driven routing', () => {
  let scene: Scene;
  let mgr: RVHighlightManager;
  let outline: ReturnType<typeof makeMockOutline>;

  beforeEach(() => {
    scene = new Scene();
    mgr = new RVHighlightManager(scene);
    outline = makeMockOutline();
    mgr.setOutlineManager(outline as never);
  });

  it('overlay profile (HMI default): rendered mesh gets overlay pairs, NOT OutlinePass', () => {
    const root = new Object3D();
    root.add(makeMesh(true));
    scene.add(root);

    mgr.highlight(root);

    expect(outline.hoverOutlined).toEqual([]);      // outline branch never taken
    expect(overlayCount(scene)).toBeGreaterThan(0); // fill+edges built
  });

  it('overlay profile: batched-only root gets the identical overlay look', () => {
    const root = new Object3D();
    root.add(makeMesh(false));
    scene.add(root);

    mgr.highlight(root);

    expect(outline.hoverOutlined).toEqual([]);
    expect(overlayCount(scene)).toBeGreaterThan(0);
  });

  it('outline profile (planner): rendered mesh gets OutlinePass, no overlays', () => {
    mgr.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    const root = new Object3D();
    root.add(makeMesh(true));
    scene.add(root);

    mgr.highlight(root);

    expect(outline.hoverOutlined).toEqual([root]);
    expect(overlayCount(scene)).toBe(0);
  });

  it('outline profile: fully batched root falls back to overlay pairs per root', () => {
    mgr.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    const root = new Object3D();
    root.add(makeMesh(false));
    scene.add(root);

    mgr.highlight(root);

    expect(outline.hoverOutlined).toEqual([]);
    expect(overlayCount(scene)).toBeGreaterThan(0);
  });

  it('per-call visual override forces overlay in an outline mode', () => {
    // Planner is the outline-visual profile (editor is overlay by default).
    mgr.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    const root = new Object3D();
    root.add(makeMesh(true));
    scene.add(root);

    mgr.highlightMultiple([root], { visual: 'overlay' });

    expect(outline.hoverOutlined).toEqual([]);
    expect(overlayCount(scene)).toBeGreaterThan(0);
  });

  it('selection: outline profile pushes roots to the selection channel; clearing restores', () => {
    mgr.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    const root = new Object3D();
    root.add(makeMesh(true));
    scene.add(root);

    mgr.highlightSelection([root]);
    expect(outline.selectionOutlined).toEqual([root]);
    expect(mgr.isSelectionActive).toBe(true);

    mgr.clearSelection();
    expect(outline.selectionOutlined).toEqual([]);
    expect(mgr.isSelectionActive).toBe(false);
  });

  it('clearing hover removes the overlay meshes (pooled wrappers leave the scene)', () => {
    const root = new Object3D();
    root.add(makeMesh(false));
    scene.add(root);

    mgr.highlight(root);
    expect(overlayCount(scene)).toBeGreaterThan(0);
    mgr.clear();
    expect(overlayCount(scene)).toBe(0);
  });

  it('pooling: re-highlighting reuses wrapper objects instead of allocating', () => {
    const root = new Object3D();
    root.add(makeMesh(false));
    scene.add(root);

    mgr.highlight(root);
    const first = scene.children.filter(o => o.userData?._highlightOverlay);
    mgr.clear();
    mgr.highlight(root);
    const second = scene.children.filter(o => o.userData?._highlightOverlay);
    expect(second.length).toBe(first.length);
    // Same wrapper instances came back from the pool.
    for (const o of second) expect(first).toContain(o);
  });
});
