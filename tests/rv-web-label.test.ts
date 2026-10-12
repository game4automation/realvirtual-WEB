// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-529 §9.1 — the `WebLabel` component: builds Billboard and Plate from
 * defaults and from full extras, multi-line canvases, colour parsing with a
 * separate alpha (and the fade on top), dispose without leaks, the STATIC
 * `pick:'none'` capability, and bake survival of a node that carries nothing
 * but a `WebLabel`.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Sprite, type Material } from 'three';
import '../src/core/engine/rv-scene-loader';
import {
  RVWebLabel,
  WEB_LABEL_TYPE,
  readLabelColor,
  splitLabelLines,
  DEFAULT_TEXT_COLOR,
  DEFAULT_BACKGROUND_COLOR,
  WEB_LABEL_MAX_TEXT,
} from '../src/core/engine/rv-web-label';
import { WebLabelManager } from '../src/core/engine/rv-web-label-manager';
import {
  applySchema,
  getCapabilities,
  getSchemaDefaults,
  pickModeOf,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { getOverlaySnapshot, resetOverlayProducers } from '../src/core/overlay-visibility-store';
import { LABEL_SUPERSAMPLE, labelContractViolations } from '../src/core/engine/rv-label-sprite';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import { objectToGlb, sceneMirroringLoad } from '../src/core/import/rv-import-object';
import { prepareAndBake } from '../src/core/engine/rv-prepare-and-bake';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { inlinePickPort } from './fixtures/bake-fixture';

function build(extras: Record<string, unknown>, mgr: WebLabelManager | null = new WebLabelManager()): RVWebLabel {
  const node = new Object3D();
  node.name = 'LabelNode';
  node.userData.realvirtual = { WebLabel: extras };
  const label = new RVWebLabel(node);
  applySchema(label as unknown as Record<string, unknown>, RVWebLabel.schema, extras);
  label.init({ webLabelManager: mgr ?? undefined } as unknown as ComponentContext);
  return label;
}

function canvasOf(label: RVWebLabel): HTMLCanvasElement {
  const mat = label.visual!.material as Material & { map: { image: HTMLCanvasElement } };
  return mat.map.image;
}

/** Alpha (0..1) of the background at the left padding, vertically centred. */
function backgroundAlpha(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d')!;
  const px = ctx.getImageData(4 * LABEL_SUPERSAMPLE, Math.floor(canvas.height / 2), 1, 1).data;
  return px[3] / 255;
}

afterEach(() => resetOverlayProducers());

describe('build from extras', () => {
  it('schema defaults: Billboard, empty text → no visual; defaults are complete for authoring', () => {
    const defaults = getSchemaDefaults(WEB_LABEL_TYPE);
    expect(defaults).toMatchObject({
      Mode: 'Billboard', Text: '', Url: '', FontSize: 0, PlateWidth: 0, PlateHeight: 0, MaxDistance: 0,
      TextColor: DEFAULT_TEXT_COLOR, BackgroundColor: DEFAULT_BACKGROUND_COLOR, Offset: { x: 0, y: 0, z: 0 },
    });
    const empty = build({});
    expect(empty.visual).toBeNull();
    expect(empty.node.children.length).toBe(0);
    empty.dispose();
  });

  it('Billboard from defaults + text is a contract sprite under the node', () => {
    const l = build({ Text: 'Hello' });
    expect(l.visual!.kind).toBe('Billboard');
    expect(l.visual!.object).toBeInstanceOf(Sprite);
    expect(l.visual!.object.parent).toBe(l.node);
    expect(l.visual!.object.userData._rvWebLabel).toBe(true);
    expect(labelContractViolations(l.node)).toEqual([]);
    l.dispose();
  });

  it('Plate from full extras', () => {
    const l = build({
      Mode: 'Plate', Text: 'Line 1\nLine 2', Url: 'https://example.com', FontSize: 30,
      TextColor: { r: 0, g: 0, b: 0, a: 1 }, BackgroundColor: { r: 1, g: 1, b: 0.8, a: 1 },
      PlateWidth: 400, PlateHeight: 150, Offset: { x: 0, y: 100, z: 0 }, MaxDistance: 25,
    });
    const v = l.visual!;
    expect(v.kind).toBe('Plate');
    expect(v.object).toBeInstanceOf(Mesh);
    expect(v.linkUrl).toBe('https://example.com');
    expect(v.maxDistanceM).toBe(25);
    const geo = (v.object as Mesh).geometry;
    geo.computeBoundingBox();
    expect(geo.boundingBox!.max.x - geo.boundingBox!.min.x).toBeCloseTo(0.4, 6);
    expect(geo.boundingBox!.max.y - geo.boundingBox!.min.y).toBeCloseTo(0.15, 6);
    expect(v.object.position.y).toBeCloseTo(0.1, 9);
    l.dispose();
  });

  it('multi-line text makes one taller canvas', () => {
    const one = build({ Text: 'A' });
    const three = build({ Text: 'A\nB\nC' });
    expect(canvasOf(three).height).toBeGreaterThan(canvasOf(one).height * 2);
    expect(splitLabelLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
    expect(splitLabelLines('x'.repeat(WEB_LABEL_MAX_TEXT + 50))[0].length).toBe(WEB_LABEL_MAX_TEXT);
    expect(splitLabelLines('   ')).toEqual([]);
    one.dispose(); three.dispose();
  });
});

describe('colours', () => {
  it('missing / malformed → defaults; valid RGB without alpha → alpha 1', () => {
    expect(readLabelColor(undefined, DEFAULT_TEXT_COLOR)).toEqual(DEFAULT_TEXT_COLOR);
    expect(readLabelColor('red', DEFAULT_TEXT_COLOR)).toEqual(DEFAULT_TEXT_COLOR);
    expect(readLabelColor({ r: 'x', g: 0, b: 0 }, DEFAULT_BACKGROUND_COLOR)).toEqual(DEFAULT_BACKGROUND_COLOR);
    expect(readLabelColor({ r: 1, g: 0, b: 0 }, DEFAULT_TEXT_COLOR)).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(readLabelColor({ r: 0, g: 1, b: 0, a: 7 }, DEFAULT_TEXT_COLOR).a).toBe(1);
  });

  it('background alpha 0, 0.5 and 1 reach the canvas fill; the fade multiplies on top', () => {
    const mgr = new WebLabelManager();
    const alphas = [0, 0.5, 1].map((a) => {
      const l = build({ Text: 'Alpha', BackgroundColor: { r: 0.2, g: 0.3, b: 0.4, a } }, mgr);
      const got = backgroundAlpha(canvasOf(l));
      return { l, got };
    });
    expect(alphas[0].got).toBeCloseTo(0, 2);
    expect(alphas[1].got).toBeCloseTo(0.5, 1);
    expect(alphas[2].got).toBeCloseTo(1, 2);

    // Fade on top: material opacity, the canvas alpha is untouched.
    const l = build({ Text: 'Far', MaxDistance: 10, BackgroundColor: { r: 0, g: 0, b: 0, a: 0.5 } }, mgr);
    const cam = new PerspectiveCamera(50, 1, 0.01, 100);
    cam.position.set(0, 0, 9); cam.lookAt(0, 0, 0);
    l.node.updateMatrixWorld(true);
    mgr.update(cam, 600);
    expect((l.visual!.material as Material).opacity).toBeCloseTo(0.5, 6);
    expect(backgroundAlpha(canvasOf(l))).toBeCloseTo(0.5, 1);
    for (const { l: x } of alphas) x.dispose();
    l.dispose();
  });
});

describe('dispose', () => {
  it('removes the object, disposes texture/material/geometry, unregisters manager + overlay producer', () => {
    const mgr = new WebLabelManager();
    for (const mode of ['Billboard', 'Plate'] as const) {
      const l = build({ Mode: mode, Text: 'Bye' }, mgr);
      expect(mgr.has(l)).toBe(true);
      expect(getOverlaySnapshot().present.map((c) => c.id)).toContain('labels');
      const v = l.visual!;
      const mat = v.material as Material & { map: { dispose(): void; addEventListener(t: string, f: () => void): void } };
      const disposed: string[] = [];
      mat.addEventListener('dispose', () => disposed.push('material'));
      mat.map.addEventListener('dispose', () => disposed.push('texture'));
      if (v.object instanceof Mesh) v.object.geometry.addEventListener('dispose', () => disposed.push('geometry'));
      l.dispose();
      expect(v.object.parent).toBeNull();
      expect(l.node.children.length).toBe(0);
      expect(disposed).toEqual(expect.arrayContaining(mode === 'Plate' ? ['material', 'texture', 'geometry'] : ['material', 'texture']));
      expect(mgr.has(l)).toBe(false);
      expect(getOverlaySnapshot().present.map((c) => c.id)).not.toContain('labels');
      // Idempotent.
      expect(() => l.dispose()).not.toThrow();
    }
  });
});

describe('capabilities', () => {
  it("the type is pick:'select' for every instance (a label names a hoverable object), with and without URL; authorable; bake default merge", () => {
    const caps = getCapabilities(WEB_LABEL_TYPE);
    expect(caps.pick).toBe('select');
    expect(caps.authorable).toBe(true);
    expect(caps.bake).toBe('merge');
    expect(caps.claimsNode).toBe(true);
    const linked = build({ Text: 'L', Url: 'https://example.com' });
    const plain = build({ Text: 'P' });
    expect(pickModeOf(linked.node)).toBe('select');
    expect(pickModeOf(plain.node)).toBe('select');
    linked.dispose(); plain.dispose();
  });

  it('an unsafe Url is ignored with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = build({ Text: 'x', Url: 'javascript:alert(1)' });
    const b = build({ Text: 'y', Url: 'javascript:alert(1)' });
    expect(a.visual!.linkUrl).toBeNull();
    expect(b.visual!.linkUrl).toBeNull();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[WebLabel]')).length).toBe(1);
    warn.mockRestore();
    a.dispose(); b.dispose();
  });
});

describe('bake survival (F9)', () => {
  it('a node with only a WebLabel survives prepareAndBake and is addressable by path', async () => {
    const root = new Group();
    root.name = 'Station';
    const frame = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x777777 }));
    frame.name = 'Frame';
    root.add(frame);
    const credit = new Object3D();
    credit.name = 'WebLabel_Credit';
    credit.position.set(0, 0.5, 0.6);
    credit.userData.realvirtual = { WebLabel: { Mode: 'Plate', Text: 'Model courtesy of X' } };
    root.add(credit);
    const bytes = await objectToGlb(sceneMirroringLoad(root));
    const tmp = (await gltfLoader.parseAsync(bytes.slice(0), '')).scene;
    const baked = await prepareAndBake(tmp, {
      assetId: 'weblabel-bake', renamedNodes: new Map<Object3D, string>(), signatureState: 'none',
      uber: new RVUberMaterial(false), isWebGPU: false, pickPort: inlinePickPort(),
    });
    let survivor: Object3D | null = null;
    baked.template.traverse((n) => { if (n.name === 'WebLabel_Credit') survivor = n; });
    expect(survivor).not.toBeNull();
    const s = survivor as unknown as Object3D;
    expect((s.userData.realvirtual as Record<string, unknown>).WebLabel).toBeTruthy();
    const path = NodeRegistry.computeNodePath(s);
    expect(path.endsWith('WebLabel_Credit')).toBe(true);
  });
});
