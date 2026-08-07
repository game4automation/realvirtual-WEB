// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVHighlightManager — aux emphasis + flash channel.
 *
 * Aux: named sets unioned into the selection visual (outline union in outline
 * modes, selection-style overlay pairs in overlay modes).
 * Flash: fill+edges+outline alarm pulse, independent of hover/selection —
 * regression coverage for the old clobber bug where an alarm pulse replaced
 * the active selection outline style.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { RVHighlightManager } from '../src/core/engine/rv-highlight-manager';
import { MODE_HIGHLIGHT_PROFILES } from '../src/core/engine/rv-highlight-profiles';

function makeMockOutline() {
  return {
    available: true,
    hoverOutlined: [] as Object3D[],
    selectionOutlined: [] as Object3D[],
    flashOutlined: [] as Object3D[],
    flashStyle: null as Record<string, number> | null,
    setStyle() {},
    setHoverStyle() {},
    setHoverOutlined(objs: readonly Object3D[]) { this.hoverOutlined = [...objs]; },
    clearHover() { this.hoverOutlined = []; },
    setOutlined(objs: readonly Object3D[]) { this.selectionOutlined = [...objs]; },
    clear() { this.selectionOutlined = []; },
    setFlashOutlined(objs: readonly Object3D[]) { this.flashOutlined = [...objs]; },
    clearFlash() { this.flashOutlined = []; },
    setFlashStyle(s: Record<string, number>) { this.flashStyle = s; },
    get hoverPass() { return { selectedObjects: this.hoverOutlined }; },
    get pass() { return { selectedObjects: this.selectionOutlined }; },
  };
}

function renderedRoot(scene: Scene): Object3D {
  const root = new Object3D();
  root.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  scene.add(root);
  return root;
}

function overlayCount(scene: Scene): number {
  let n = 0;
  scene.traverse(o => { if (o.userData?._highlightOverlay && o.parent) n++; });
  return n;
}

describe('RVHighlightManager - aux emphasis', () => {
  let scene: Scene;
  let mgr: RVHighlightManager;
  let outline: ReturnType<typeof makeMockOutline>;

  beforeEach(() => {
    scene = new Scene();
    mgr = new RVHighlightManager(scene);
    outline = makeMockOutline();
    mgr.setOutlineManager(outline as never);
  });

  it('outline mode: aux roots union into the selection outline channel', () => {
    mgr.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    const sel = renderedRoot(scene);
    const ghost = renderedRoot(scene);

    mgr.highlightSelection([sel]);
    mgr.setAuxEmphasis('planner-ghost', [ghost]);
    expect(outline.selectionOutlined).toEqual([sel, ghost]);

    // Replacing the set replaces the union member.
    const ghost2 = renderedRoot(scene);
    mgr.setAuxEmphasis('planner-ghost', [ghost2]);
    expect(outline.selectionOutlined).toEqual([sel, ghost2]);

    // Clearing the aux set keeps the selection outline.
    mgr.setAuxEmphasis('planner-ghost', null);
    expect(outline.selectionOutlined).toEqual([sel]);
    expect(mgr.isAuxActive).toBe(false);
  });

  it('outline mode: clearing the selection keeps the aux outline', () => {
    mgr.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    const sel = renderedRoot(scene);
    const ghost = renderedRoot(scene);
    mgr.highlightSelection([sel]);
    mgr.setAuxEmphasis('planner-ghost', [ghost]);

    mgr.clearSelection();
    expect(outline.selectionOutlined).toEqual([ghost]);
    expect(mgr.isAuxActive).toBe(true);
  });

  it('overlay mode: aux roots render as selection-style overlay pairs', () => {
    const ghost = renderedRoot(scene); // HMI default profile = overlay
    mgr.setAuxEmphasis('planner-ghost', [ghost]);
    expect(outline.selectionOutlined).toEqual([]);
    expect(overlayCount(scene)).toBeGreaterThan(0);
    expect(mgr.isAuxActive).toBe(true);

    mgr.setAuxEmphasis('planner-ghost', null);
    expect(overlayCount(scene)).toBe(0);
  });
});

describe('RVHighlightManager - flash channel', () => {
  let scene: Scene;
  let mgr: RVHighlightManager;
  let outline: ReturnType<typeof makeMockOutline>;

  beforeEach(() => {
    scene = new Scene();
    mgr = new RVHighlightManager(scene);
    outline = makeMockOutline();
    mgr.setOutlineManager(outline as never);
  });

  it('flash combines overlay pairs AND the flash outline channel in one color', () => {
    const root = renderedRoot(scene);
    mgr.flash([root], { color: 0xff3030 });

    expect(mgr.isFlashActive).toBe(true);
    expect(overlayCount(scene)).toBeGreaterThan(0);
    expect(outline.flashOutlined).toEqual([root]);
    expect(outline.flashStyle?.visibleEdgeColor).toBe(0xff3030);
    expect(outline.flashStyle?.pulsePeriod).toBeGreaterThan(0);
  });

  it('flash leaves an active selection outline intact (clobber-bug regression)', () => {
    mgr.setProfile(MODE_HIGHLIGHT_PROFILES.planner);
    const sel = renderedRoot(scene);
    const alarm = renderedRoot(scene);
    mgr.highlightSelection([sel]);
    expect(outline.selectionOutlined).toEqual([sel]);

    mgr.flash([alarm], { color: 0xff3030 });
    // Selection channel untouched by the flash.
    expect(outline.selectionOutlined).toEqual([sel]);
    expect(outline.flashOutlined).toEqual([alarm]);

    mgr.clearFlash();
    expect(outline.selectionOutlined).toEqual([sel]);
    expect(outline.flashOutlined).toEqual([]);
  });

  it('a new flash replaces the previous one', () => {
    const a = renderedRoot(scene);
    const b = renderedRoot(scene);
    mgr.flash([a], { color: 0xff0000 });
    const countA = overlayCount(scene);
    mgr.flash([b], { color: 0x00ff00 });
    expect(outline.flashOutlined).toEqual([b]);
    expect(overlayCount(scene)).toBe(countA); // same pair count, not doubled
  });

  it('flash auto-clears after its duration (via update())', () => {
    const root = renderedRoot(scene);
    mgr.flash([root], { color: 0xff3030, durationMs: 1 });
    expect(mgr.isFlashActive).toBe(true);
    const t0 = performance.now();
    while (performance.now() - t0 < 5) { /* spin past the duration */ }
    mgr.update();
    expect(mgr.isFlashActive).toBe(false);
    expect(overlayCount(scene)).toBe(0);
    expect(outline.flashOutlined).toEqual([]);
  });

  it('fill/edges opacity stays constant — only the outline channel pulses', () => {
    const root = renderedRoot(scene);
    mgr.flash([root], { color: 0xff3030 });
    // Outline channel is the pulsing part.
    expect(outline.flashStyle?.pulsePeriod).toBeGreaterThan(0);
    // Overlay materials never change opacity across updates.
    const opacities = new Set<number>();
    for (let i = 0; i < 6; i++) {
      mgr.update();
      const fills = scene.children.filter(o => o.userData?._highlightOverlay && (o as Mesh).isMesh);
      const mat = (fills[0] as Mesh)?.material as MeshBasicMaterial | undefined;
      if (mat) opacities.add(mat.opacity);
      const t0 = performance.now();
      while (performance.now() - t0 < 15) { /* spin */ }
    }
    expect(opacities.size).toBe(1); // steady fill — no blink
    mgr.clearFlash();
  });
});
