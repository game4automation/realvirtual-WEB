import { describe, expect, it, vi } from 'vitest';
import { Mesh, Object3D } from 'three';
import { RVRibbonPath } from '../src/core/engine/rv-ribbon-path';
import { RVRibbonRoller } from '../src/core/engine/rv-ribbon-roller';
import { RibbonEditorPreview } from '../src/core/engine/rv-ribbon-editor-preview';
import { NO_AO_LAYER } from '../src/core/engine/rv-constants';
import { ribbonHarness } from './ribbon-fixture';

function setup() {
  const h = ribbonHarness([]);
  const context = { ...h.deps, root: h.root, authoring: true };
  const rollers = [0, 2, 4].map((x) => {
    const node = new Object3D(); node.position.x = x; h.root.add(node);
    const roller = new RVRibbonRoller(node);
    roller.RadiusMm = 100; roller.Axis = 'Z'; roller.init(context);
    return roller;
  });
  const path = new RVRibbonPath(h.path);
  path.Rollers = rollers;
  path.RibbonWidthMm = 500;
  path.init(context);
  const preview = new RibbonEditorPreview({ ribbonManager: h.ribbonManager,
    activeMode: 'editor', markRenderDirty() {}, markShadowsDirty() {} });
  preview.onRender(0);
  const band = () => h.scene.getObjectByName('__rvRibbonPreview') as Mesh | undefined;
  return { h, path, preview, rollers, band };
}

describe('stopped editor ribbon band', () => {
  it('renders a band outside the document and outside thumbnail layer 0', () => {
    const { h, path, band } = setup();
    expect(path.band).toBeNull();
    expect(band()?.parent).toBe(h.scene);
    expect(h.root.getObjectByName('__rvRibbonPreview')).toBeUndefined();
    expect(band()!.geometry.drawRange.count).toBeGreaterThan(0);
    expect(band()!.layers.isEnabled(0)).toBe(false);
    expect(band()!.layers.mask).toBe(1 << NO_AO_LAYER);
    expect(band()!.layers.isEnabled(3)).toBe(false);
  });

  it('follows parent transforms and roller edits without stepping simulation', () => {
    const { h, path, preview, rollers, band } = setup();
    const before = path.lengthMm;
    rollers[1].node.position.y += 0.5;
    h.root.position.set(3, 1, 2); h.root.rotation.y = 0.5;
    preview.onRender(0); h.scene.updateMatrixWorld(true);
    expect(path.lengthMm).not.toBeCloseTo(before);
    expect(band()!.matrixWorld.elements).toEqual(h.path.matrixWorld.elements);
  });

  it('disposes the preview on export, restores it afterward, and cleans up on exit', () => {
    const { preview, band } = setup();
    const dispose = vi.spyOn(band()!.geometry, 'dispose');
    preview.beginExportPass(); preview.beginExportPass();
    expect(band()).toBeUndefined(); expect(dispose).toHaveBeenCalledOnce();
    preview.endExportPass(); expect(band()).toBeUndefined();
    preview.endExportPass(); expect(band()).toBeDefined();
    preview.onModelCleared(); expect(band()).toBeUndefined();
  });
});
