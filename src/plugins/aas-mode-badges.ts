// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aas-mode-badges.ts — the small type-code badges of the AAS mode (plan-682 F8).
 *
 * One label sprite per AAS part, built through `rv-label-sprite.ts` and so on
 * the overlay layer (never layer 0 — no AO boxes, no bloom smear, drawn crisp
 * after the composer). Screen-size constant (`sizeAttenuation: false`), anchored
 * at its bottom-left corner on the top corner of the part's world bounds, so it
 * sits NEXT TO the part, not inside it. The anchor is stored in the part's local
 * space and re-projected every frame (`update()`), so badges follow moving parts
 * without any allocation.
 *
 * Badges live in their own group on the scene root — never as children of model
 * nodes, which every traversal (search, save, AAS collection) would otherwise
 * see. Click/tap hit-testing is done in screen space (`hitTest`), because the
 * overlay layer is not part of the pick structure.
 */

import { Box3, Group, Vector3, type Camera, type Object3D, type Sprite, type SpriteMaterial, type CanvasTexture } from 'three';
import { computeSubtreeAABB } from '../core/engine/rv-traverse-utils';
import { createLabelSprite, drawBoxedLabel, makeLabelCanvas } from '../core/engine/rv-label-sprite';

/** Upper bound of badges; beyond it the AAS mode only highlights (plan-682 §3.2). */
export const AAS_BADGE_CAP = 300;

/** Badge height as a fraction of the viewport height (sizeAttenuation off). */
const BADGE_SCREEN_HEIGHT = 0.026;
/** Logical canvas size of one badge. */
const BADGE_W = 300;
const BADGE_H = 40;

interface Badge {
  node: Object3D;
  local: Vector3;
  sprite: Sprite;
  texture: CanvasTexture;
  material: SpriteMaterial;
}

const _box = new Box3();
const _v = new Vector3();

/** Owns the badge sprites of one AAS-mode activation. */
export class AasModeBadges {
  readonly group = new Group();
  private _badges: Badge[] = [];
  private _capWarned = false;

  constructor(private readonly _color: string) {
    this.group.name = '__rv_aas_mode_badges';
    this.group.userData._rvSynthetic = true;
  }

  /** Number of live badges. */
  get size(): number { return this._badges.length; }

  /**
   * Replace all badges: one per node, text from `textOf`. Caps at
   * {@link AAS_BADGE_CAP} and logs that once per instance.
   */
  build(nodes: readonly Object3D[], textOf: (node: Object3D) => string): void {
    this.clear();
    const n = Math.min(nodes.length, AAS_BADGE_CAP);
    if (nodes.length > AAS_BADGE_CAP && !this._capWarned) {
      this._capWarned = true;
      console.info(`[aas-mode] ${nodes.length} AAS parts — badges capped at ${AAS_BADGE_CAP}, the rest is highlighted only`);
    }
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      const text = textOf(node);
      if (!text) continue;
      const canvas = makeLabelCanvas(BADGE_W, BADGE_H, (ctx, w, h) =>
        drawBoxedLabel(ctx, w, h, text, this._color, { font: 'bold 20px sans-serif', border: 2, radius: 8, interior: 'rgba(16, 22, 37, 0.88)', maxChars: 28 }));
      const handles = createLabelSprite(canvas, { name: `aas-badge:${node.name}`, filtering: 'linear' });
      handles.material.sizeAttenuation = false;
      handles.sprite.center.set(0, 0);
      handles.sprite.scale.set(BADGE_SCREEN_HEIGHT * handles.aspect, BADGE_SCREEN_HEIGHT, 1);
      handles.sprite.userData._aasBadgeNode = node;
      // Anchor: the top corner of the part's world bounds (baked parts answer
      // with their segment boxes), kept in the part's local space.
      computeSubtreeAABB(node, _box);
      node.updateWorldMatrix(true, false);
      const local = node.worldToLocal(_v.set(_box.max.x, _box.max.y, _box.max.z)).clone();
      this._badges.push({ node, local, sprite: handles.sprite, texture: handles.texture, material: handles.material });
      this.group.add(handles.sprite);
    }
    this.update();
  }

  /** Re-project every anchor through its part's current world matrix (per frame, no allocation). */
  update(): void {
    for (const b of this._badges) {
      b.sprite.position.copy(b.local).applyMatrix4(b.node.matrixWorld);
      b.sprite.visible = b.node.visible;
    }
  }

  /**
   * The part whose badge contains the client point, or null. Screen-space test
   * against each badge's projected rectangle (badges are few and on the overlay
   * layer, outside the pick structure).
   */
  hitTest(clientX: number, clientY: number, camera: Camera, rect: DOMRect): Object3D | null {
    // sizeAttenuation off: the sprite's NDC size is scale × projection diagonal
    // (three's sprite shader multiplies the scale by -z before projecting).
    const p = camera.projectionMatrix.elements;
    for (let i = this._badges.length - 1; i >= 0; i--) {
      const b = this._badges[i];
      if (!b.sprite.visible) continue;
      _v.copy(b.sprite.position).project(camera);
      if (_v.z < -1 || _v.z > 1) continue;
      const x0 = rect.left + (_v.x + 1) / 2 * rect.width;
      const y0 = rect.top + (1 - _v.y) / 2 * rect.height;
      const hPx = b.sprite.scale.y * Math.abs(p[5]) / 2 * rect.height;
      const wPx = b.sprite.scale.x * Math.abs(p[0]) / 2 * rect.width;
      if (clientX >= x0 && clientX <= x0 + wPx && clientY <= y0 && clientY >= y0 - hPx) return b.node;
    }
    return null;
  }

  /** World position of the badge of `node` (its anchor), or null. */
  anchorOf(node: Object3D): [number, number, number] | null {
    const b = this._badges.find(x => x.node === node);
    return b ? [b.sprite.position.x, b.sprite.position.y, b.sprite.position.z] : null;
  }

  /** Remove and dispose every badge (texture + material). */
  clear(): void {
    for (const b of this._badges) {
      this.group.remove(b.sprite);
      b.texture.dispose();
      b.material.dispose();
    }
    this._badges = [];
  }

  /** Clear and detach the group. */
  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
