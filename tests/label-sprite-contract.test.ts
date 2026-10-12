// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Text-label contract (rv-label-sprite.ts)
 *
 * Every canvas-drawn text sprite in the 3D scene must sit on an overlay layer
 * (never layer 0), have `toneMapped: false` and write/test no depth. A sprite
 * that breaks this goes THROUGH the post-processing composer and gets dimmed
 * by GTAO, smeared by bloom and washed out by tone mapping — the "smeared
 * label" regression that kept returning during development.
 *
 * This test builds every label producer the public package has and asserts
 * `labelContractViolations()` is empty for each. A new label built with a
 * bare `new Sprite(new SpriteMaterial({ map }))` fails here, not on screen.
 */

import { describe, it, expect } from 'vitest';
import { Scene, Sprite, SpriteMaterial, CanvasTexture, Object3D, Vector3, Mesh, BoxGeometry } from 'three';
import {
  createLabelSprite,
  labelContractViolations,
  makeLabelCanvas,
  drawBoxedLabel,
  LABEL_SUPERSAMPLE,
} from '../src/core/engine/rv-label-sprite';
import { HIGHLIGHT_OVERLAY_LAYER } from '../src/core/engine/rv-group-registry';
import { MEASUREMENT_LAYER, NO_AO_LAYER } from '../src/core/engine/rv-constants';
import { buildSourceMarker } from '../src/core/engine/rv-source-marker';
import { MeasurementRenderer } from '../src/plugins/rv-measurement-renderer';
import { AnnotationRenderer } from '../src/plugins/rv-annotation-renderer';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import type { Measurement, Annotation } from '../src/core/types/plugin-types';
import { RVWebLabel } from '../src/core/engine/rv-web-label';
import { WebLabelManager } from '../src/core/engine/rv-web-label-manager';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';

function pill(text = 'Label'): HTMLCanvasElement {
  return makeLabelCanvas(128, 32, (ctx, w, h) => drawBoxedLabel(ctx, w, h, text, '#ff00ff'));
}

describe('label sprite factory', () => {
  it('supersamples the canvas and keeps draw code logical', () => {
    const c = pill();
    expect(c.width).toBe(128 * LABEL_SUPERSAMPLE);
    expect(c.height).toBe(32 * LABEL_SUPERSAMPLE);
  });

  it('produces a sprite that satisfies the contract by default', () => {
    const { sprite, material, aspect } = createLabelSprite(pill());
    expect(sprite.layers.mask & 1).toBe(0);
    expect(sprite.layers.isEnabled(HIGHLIGHT_OVERLAY_LAYER)).toBe(true);
    expect(material.toneMapped).toBe(false);
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
    expect(aspect).toBe(4);
    expect(labelContractViolations(sprite)).toEqual([]);
  });

  it('honours a subsystem layer', () => {
    const { sprite } = createLabelSprite(pill(), { layer: MEASUREMENT_LAYER });
    expect(sprite.layers.isEnabled(MEASUREMENT_LAYER)).toBe(true);
    expect(sprite.layers.mask & 1).toBe(0);
  });
});

describe('labelContractViolations', () => {
  it('reports a bare canvas sprite on layer 0 with every broken rule', () => {
    const scene = new Scene();
    const holder = new Object3D(); holder.name = 'Holder';
    const bare = new Sprite(new SpriteMaterial({ map: new CanvasTexture(pill()), transparent: true }));
    bare.name = 'BareLabel';
    holder.add(bare); scene.add(holder);
    const v = labelContractViolations(scene);
    expect(v).toHaveLength(1);
    expect(v[0].name).toBe('BareLabel');
    expect(v[0].path.endsWith('Holder/BareLabel')).toBe(true);
    expect(v[0].reasons).toEqual(expect.arrayContaining(['layer-0', 'toneMapped', 'depthWrite', 'depthTest']));
  });

  it('ignores sprites without a canvas map', () => {
    const scene = new Scene();
    scene.add(new Sprite(new SpriteMaterial({ color: 0xff0000 })));
    expect(labelContractViolations(scene)).toEqual([]);
  });

  it('accepts a NO_AO_LAYER label (kept in the composer on purpose, AO-excluded)', () => {
    const { sprite } = createLabelSprite(pill(), { layer: NO_AO_LAYER });
    expect(labelContractViolations(sprite)).toEqual([]);
  });
});

describe('every label producer honours the contract', () => {
  it('source marker label', () => {
    const scene = new Scene();
    const m = buildSourceMarker({ templateHalfSize: new Vector3(0.3, 0.2, 0.3), name: 'Source_L0' });
    scene.add(m.root);
    expect(labelContractViolations(scene)).toEqual([]);
    expect(m.label.layers.isEnabled(HIGHLIGHT_OVERLAY_LAYER)).toBe(true);
    expect((m.label.material as SpriteMaterial).toneMapped).toBe(false);
    // The pill is supersampled, so text stays crisp when minified.
    expect(m.labelTexture.image.width).toBe(256 * LABEL_SUPERSAMPLE);
    m.dispose();
  });

  it('measurement distance label', () => {
    const scene = new Scene();
    const r = new MeasurementRenderer();
    r.attach(scene);
    const m: Measurement = {
      id: 'm1', name: 'M', pointA: [0, 0, 0], pointB: [1, 0, 0], normalA: null, normalB: null,
      distance: 1, visible: true, color: '#00ff00', timestamp: 0,
    };
    r.addMeasurement(m);
    expect(labelContractViolations(scene)).toEqual([]);
  });

  it('annotation label', () => {
    const scene = new Scene();
    const r = new AnnotationRenderer();
    r.attach(scene);
    const a: Annotation = {
      id: 'a1', position: [0, 0, 0], normal: [0, 1, 0], text: 'Check this', color: '#ff8800', author: 't', timestamp: 0,
    };
    r.addAnnotation(a);
    expect(labelContractViolations(scene)).toEqual([]);
    r.updateAnnotation({ ...a, text: 'Changed' });
    expect(labelContractViolations(scene)).toEqual([]);
  });

  it('gizmo text shape (overlay and keepInComposer variants)', () => {
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const n = new Mesh(new BoxGeometry(1, 1, 1)); n.name = 'Part'; scene.add(n);
    const n2 = new Mesh(new BoxGeometry(1, 1, 1)); n2.name = 'Part2'; scene.add(n2);
    mgr.create(n, { shape: 'text', text: 'S1', color: 0xffffff, opacity: 1 });
    mgr.create(n2, { shape: 'text', text: 'S2', color: 0xffffff, opacity: 1, keepInComposer: true });
    expect(labelContractViolations(scene)).toEqual([]);
  });

  it('WebLabel Billboard passes the contract (built through createLabelSprite)', () => {
    const scene = new Scene();
    const node = new Object3D(); node.name = 'Tag'; scene.add(node);
    const label = new RVWebLabel(node);
    applySchema(label as unknown as Record<string, unknown>, RVWebLabel.schema, { Text: 'Tag\nline 2' });
    label.init({ webLabelManager: new WebLabelManager() } as unknown as ComponentContext);
    expect(label.visual!.object).toBeInstanceOf(Sprite);
    expect(labelContractViolations(scene)).toEqual([]);
    label.dispose();
  });
});

// plan-529 — THE documented exemption. A WebLabel Plate is a sign ON the
// machine: depth-tested, depth-writing, layer 0, occluded by geometry. It is a
// Mesh, never a Sprite, and `labelContractViolations` only inspects canvas
// SPRITES — this test pins both halves so the exemption cannot quietly widen
// (a Plate built as a Sprite would be reported) or vanish.
describe('WebLabel Plate exemption (plan-529)', () => {
  it('a Plate is a depth-tested Mesh on layer 0 and is NOT reported', () => {
    const scene = new Scene();
    const node = new Object3D(); node.name = 'Sign'; scene.add(node);
    const label = new RVWebLabel(node);
    applySchema(label as unknown as Record<string, unknown>, RVWebLabel.schema, { Mode: 'Plate', Text: 'Sign' });
    label.init({ webLabelManager: new WebLabelManager() } as unknown as ComponentContext);
    const plate = label.visual!.object as Mesh;
    expect(plate).toBeInstanceOf(Mesh);
    expect(plate).not.toBeInstanceOf(Sprite);
    expect(plate.layers.mask & 1).toBe(1);
    expect((plate.material as { depthTest: boolean }).depthTest).toBe(true);
    expect(plate.userData._rvLabelPlate).toBe(true);
    expect(labelContractViolations(scene)).toEqual([]);
    label.dispose();
  });
});
