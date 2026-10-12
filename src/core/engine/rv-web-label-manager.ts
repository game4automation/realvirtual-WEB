// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-web-label-manager.ts — viewer-owned registry of `WebLabel` components
 * (plan-529).
 *
 * Components are not ticked themselves (the `LampManager` pattern). This
 * manager does the per-frame work for ALL registered labels:
 *
 *   - **Effective visibility** = overlay category `labels` on ∧ owner chain
 *     visible ∧ within `MaxDistance` (0 = unlimited). Every registered label is
 *     walked each frame — not only the visible ones — so a label that faded out
 *     comes back when the camera returns (SOL #8).
 *   - **Distance fade**: opacity 1 up to 80 % of `MaxDistance`, linear to 0 at
 *     100 %, `visible = false` below {@link FADE_HIDE_BELOW}.
 *   - **Billboard screen size** (SOL #7): the sprite keeps a constant height in
 *     CSS pixels. Uses the label's VIEW-SPACE depth (not the Euclidean
 *     distance), the camera's actual projection (perspective FOV or orthographic
 *     frustum), `camera.zoom` and the viewport height, and divides by the
 *     parent's world scale so a scaled parent does not change the size.
 *
 * `update()` runs in the RENDER path (after the camera update, before the
 * render-dirty evaluation — SOL R2-1), every frame regardless of simulation
 * state, and returns `true` when anything changed. It allocates nothing.
 *
 * **Link clicks** (SOL #1/#2/#3/G) never go through the component pick /
 * action dispatch: `WebLabel` is `pick:'none'`. The viewer's canvas `pointerup`
 * handler asks {@link WebLabelManager.tryOpenLink} FIRST, after its own
 * click-vs-drag threshold. Only effectively visible labels with a safe URL are
 * hit-tested. A Billboard hit wins unconditionally (it is drawn on top); a
 * Plate hit wins only when no opaque surface is closer — answered by the
 * injected, stateless occlusion query (the viewer passes
 * `RaycastManager.raycastSurface`). The URL opens synchronously
 * (popup blockers) through `openExternal` (`noopener,noreferrer`).
 *
 * **Hover and select** (2026-10-12): every label visual is registered as an
 * aux raycast target of its node (`WebLabelHost.pick`), so hovering a label is
 * hovering the object it names — highlight and tooltip through the ordinary
 * pick path — and a click selects the object; the viewer then also frames it
 * (`labelAt`). A hidden or faded-out label is `visible=false` and therefore
 * never catches the pointer (the aux branch gates on the target's own
 * visibility).
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Intersection,
  type Material,
  type Object3D,
  type OrthographicCamera,
  type PerspectiveCamera,
} from 'three';
import { isOverlayVisible } from '../overlay-visibility-store';
import { openExternal } from '../hmi/help-url';
import { HIGHLIGHT_OVERLAY_LAYER } from './rv-group-registry';

/** Fade starts at this fraction of `MaxDistance`. */
export const FADE_START_FRACTION = 0.8;
/** Below this opacity a label is hidden (and not clickable). */
export const FADE_HIDE_BELOW = 0.02;

/** The rendered part of one label, as the component exposes it. */
export interface WebLabelVisual {
  readonly kind: 'Billboard' | 'Plate';
  /** Sprite (Billboard) or Mesh (Plate), a child of the component's node. */
  readonly object: Object3D;
  readonly material: Material;
  /** Billboard only: target height on screen in CSS pixels. */
  readonly screenHeightPx: number;
  /** Billboard only: width / height of the canvas. */
  readonly aspect: number;
  /** Metres, 0 = unlimited. */
  readonly maxDistanceM: number;
  /** A SAFE (http/https) URL, or null when the label is not linked. */
  readonly linkUrl: string | null;
}

/** What the manager needs from a `WebLabel` component. */
export interface ManagedWebLabel {
  readonly node: Object3D;
  /** Current visual, or null while none is built. */
  readonly visual: WebLabelVisual | null;
  /** Border in `color` (hovered / selected node), `null` = plain. Optional for
   *  minimal test doubles. */
  setEmphasis?(color: number | null): void;
  /** Full teardown (used by {@link WebLabelManager.clear}). */
  dispose(): void;
}

/** The hover / selection side of the viewer a label reflects (see file doc). */
export interface LabelEmphasisHost {
  /** The node under the pointer (the RaycastManager's hovered node). */
  getHoveredNode(): Object3D | null;
  /** Is `node` in the current selection? */
  isSelected(node: Object3D): boolean;
  /** Edge colours of the hover / selection highlight (`0xRRGGBB`). */
  colors(): { hover: number; selection: number };
  /**
   * Cast straight DOWN from `origin` and report whether ANY hit along the ray
   * belongs to `node` (self or descendant) — the first such hit, looking past
   * other objects and owner-less geometry in between; its point goes to `out`.
   * The pin line of an emphasised label ends there.
   */
  castDown(origin: Vector3, node: Object3D, out: Vector3): boolean;
  /** Where the pin lines live. */
  getScene(): Object3D;
}

/** Stateless query: distance to the first opaque surface under a client point, or `Infinity`. */
export type OcclusionQuery = (clientX: number, clientY: number) => number;

/** The pick registration a label visual takes part in (RaycastManager's aux targets). */
export interface LabelPickHost {
  /** `onTop`: a Billboard is drawn over the scene, so its hit must win over
   *  geometry in front of it; a Plate is a surface in the scene. */
  addAuxRaycastTarget(mesh: Object3D, owner: Object3D, opts?: { onTop?: boolean }): void;
  removeAuxRaycastTarget(mesh: Object3D): void;
}

/** Viewer glue — bound once by `RVViewer`. */
export interface WebLabelHost {
  getCamera(): Camera;
  getCanvas(): HTMLCanvasElement;
  occlusion?: OcclusionQuery;
  /** Opens a URL. Default `openExternal`. Tests inject a spy. */
  open?: (url: string) => void;
  /** Registers every label visual as an aux raycast target whose hit resolves
   *  to the label's node — hovering a label hovers its object (highlight,
   *  tooltip), clicking it selects the object through the normal pick path.
   *  Absent (embed facade, tests): labels are not pickable. */
  pick?: LabelPickHost;
  /** Hover / selection feedback on the label (border + pin). Absent: none. */
  emphasis?: LabelEmphasisHost;
}

interface LabelState {
  readonly label: ManagedWebLabel;
  visible: boolean;
  opacity: number;
  sx: number;
  sy: number;
  /** The visual object currently registered as an aux pick target, if any. */
  pickObject: Object3D | null;
  /** Current emphasis colour (`0xRRGGBB`), null = plain. */
  emphasis: number | null;
  /** The pin line while emphasised AND the downward cast hits the node. */
  pin: Line | null;
  /** Label world position the pin's hit point was cast from (re-cast on move). */
  pinFrom: Vector3 | null;
  /** Cached hit point of the downward cast (null = no hit on the node). */
  pinHit: Vector3 | null;
}

/** Opacity for a distance `d` against `maxDistance` (0 = unlimited). Pure. */
export function fadeForDistance(d: number, maxDistance: number): number {
  if (!(maxDistance > 0)) return 1;
  const start = maxDistance * FADE_START_FRACTION;
  if (d <= start) return 1;
  if (d >= maxDistance) return 0;
  return 1 - (d - start) / (maxDistance - start);
}

/** True when `node` and every ancestor are visible. */
function chainVisible(node: Object3D): boolean {
  for (let o: Object3D | null = node; o; o = o.parent) {
    if (!o.visible) return false;
  }
  return true;
}

/** Half the world height of a Plate mesh (its geometry's y extent × world scale). */
function plateHalfHeightWorld(object: Object3D): number {
  const geom = (object as { geometry?: BufferGeometry }).geometry;
  if (!geom) return 0;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return 0;
  _parentScale.setFromMatrixScale(object.matrixWorld);
  return ((bb.max.y - bb.min.y) * (_parentScale.y || 1)) / 2;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

// Pre-allocated scratch — update() allocates nothing.
const _pos = new Vector3();
const _view = new Vector3();
const _camPos = new Vector3();
const _parentScale = new Vector3();
const _ndc = new Vector2();
const _up = new Vector3();
const _start = new Vector3();
const _castFrom = new Vector3();
const _hit = new Vector3();

export class WebLabelManager {
  /** Lookup by component. */
  private readonly _labels = new Map<ManagedWebLabel, LabelState>();
  /** Same states as a dense array — the per-frame walk indexes it (no iterator garbage). */
  private readonly _list: LabelState[] = [];
  private _host: WebLabelHost | null = null;
  private readonly _raycaster = new Raycaster();
  private readonly _hits: Intersection<Object3D>[] = [];
  /** True while THIS manager set the canvas cursor (hover over a linked label). */
  hoveringLink = false;

  get size(): number {
    return this._labels.size;
  }

  /** Bind the viewer glue (camera, canvas, occlusion, opener). */
  bindHost(host: WebLabelHost | null): void {
    this._host = host;
  }

  register(label: ManagedWebLabel): void {
    if (this._labels.has(label)) return;
    // Hidden until the first update() decides — never a one-frame flash at a
    // wrong size or beyond MaxDistance.
    const st: LabelState = {
      label, visible: false, opacity: -1, sx: -1, sy: -1, pickObject: null,
      emphasis: null, pin: null, pinFrom: null, pinHit: null,
    };
    this._labels.set(label, st);
    this._list.push(st);
    const v = label.visual;
    if (v) v.object.visible = false;
    this._syncPick(st);
  }

  unregister(label: ManagedWebLabel): void {
    const st = this._labels.get(label);
    if (!st) return;
    this._labels.delete(label);
    const i = this._list.indexOf(st);
    if (i >= 0) this._list.splice(i, 1);
    if (st.pickObject) {
      this._host?.pick?.removeAuxRaycastTarget(st.pickObject);
      st.pickObject = null;
    }
    this._setEmphasis(st, null);
  }

  // ─── Hover / selection feedback: border + pin ──────────────────────────

  /** Is `node` `root` itself or below it? */
  private static _within(node: Object3D | null, root: Object3D): boolean {
    for (let o = node; o; o = o.parent) if (o === root) return true;
    return false;
  }

  /** The emphasis colour a label should show right now, or null. */
  private _emphasisFor(st: LabelState, host: LabelEmphasisHost): number | null {
    const node = st.label.node;
    if (host.isSelected(node)) return host.colors().selection;
    if (WebLabelManager._within(host.getHoveredNode(), node)) return host.colors().hover;
    return null;
  }

  /** Apply (or clear) the emphasis colour: border redraw + pin line. True when it changed. */
  private _setEmphasis(st: LabelState, color: number | null): boolean {
    if (st.emphasis === color) return false;
    st.emphasis = color;
    st.label.setEmphasis?.(color);
    st.pinFrom = null;
    st.pinHit = null;
    if (color === null) {
      this._removePin(st);
    } else if (st.pin) {
      (st.pin.material as LineBasicMaterial).color.setHex(color);
    }
    return true;
  }

  private _removePin(st: LabelState): void {
    if (!st.pin) return;
    st.pin.removeFromParent();
    st.pin.geometry.dispose();
    (st.pin.material as LineBasicMaterial).dispose();
    st.pin = null;
  }

  /**
   * Pin of an emphasised label: a line in the emphasis colour from the label's
   * bottom edge straight down to the node, when a downward cast from the label
   * hits the node (else no pin — border only). The cast is cached per label
   * position; the start point follows the camera (billboard bottom edge).
   */
  private _updatePin(st: LabelState, host: LabelEmphasisHost, camera: Camera, labelPos: Vector3, halfHeightWorld: number, billboard: boolean): boolean {
    const v = st.label.visual;
    if (!v || st.emphasis === null) return false;
    let changed = false;
    // Bottom edge of the label in world space: camera-up for a billboard,
    // world-up for a plate.
    if (billboard) _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    else _up.set(0, 1, 0);
    _start.copy(labelPos).addScaledVector(_up, -halfHeightWorld);
    if (!st.pinFrom || !st.pinFrom.equals(labelPos)) {
      st.pinFrom = (st.pinFrom ?? new Vector3()).copy(labelPos);
      // Cast from just below the box so neither the label nor its plate is hit.
      _castFrom.copy(_start).addScaledVector(_up, -1e-3);
      st.pinHit = host.castDown(_castFrom, st.label.node, _hit) ? (st.pinHit ?? new Vector3()).copy(_hit) : null;
      changed = true;
    }
    if (!st.pinHit) {
      if (st.pin) { this._removePin(st); changed = true; }
      return changed;
    }
    if (!st.pin) {
      const geom = new BufferGeometry();
      geom.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
      const mat = new LineBasicMaterial({ color: st.emphasis, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
      const line = new Line(geom, mat);
      line.name = '__rvWebLabelPin';
      line.userData._highlightOverlay = true;
      line.raycast = () => {};
      line.frustumCulled = false;
      line.renderOrder = 998;
      line.layers.set(HIGHLIGHT_OVERLAY_LAYER);
      host.getScene().add(line);
      st.pin = line;
      changed = true;
    }
    const pos = st.pin.geometry.getAttribute('position') as Float32BufferAttribute;
    const a = pos.array as Float32Array;
    if (a[0] !== _start.x || a[1] !== _start.y || a[2] !== _start.z || a[3] !== st.pinHit.x || a[4] !== st.pinHit.y || a[5] !== st.pinHit.z) {
      a[0] = _start.x; a[1] = _start.y; a[2] = _start.z;
      a[3] = st.pinHit.x; a[4] = st.pinHit.y; a[5] = st.pinHit.z;
      pos.needsUpdate = true;
      changed = true;
    }
    return changed;
  }

  /**
   * Keep the aux pick registration in step with the label's CURRENT visual
   * (a Mode switch or redraw builds a new object). Idempotent and cheap; the
   * per-frame walk calls it so a host bound after registration catches up too.
   */
  private _syncPick(st: LabelState): void {
    const pick = this._host?.pick;
    if (!pick) return;
    const obj = st.label.visual?.object ?? null;
    if (obj === st.pickObject) return;
    if (st.pickObject) pick.removeAuxRaycastTarget(st.pickObject);
    if (obj) pick.addAuxRaycastTarget(obj, st.label.node, { onTop: st.label.visual?.kind === 'Billboard' });
    st.pickObject = obj;
  }

  /**
   * Re-register every label visual as a pick target. The viewer calls it after
   * it created the raycast manager of a load (the labels registered during that
   * load went to the previous manager, or to none — the same reason
   * `GizmoOverlayManager.refreshAuxRaycastTargets` exists). Idempotent.
   */
  refreshPickTargets(): void {
    const pick = this._host?.pick;
    if (!pick) return;
    for (let i = 0; i < this._list.length; i++) {
      const st = this._list[i];
      const obj = st.label.visual?.object ?? null;
      if (!obj) continue;
      pick.addAuxRaycastTarget(obj, st.label.node, { onTop: st.label.visual?.kind === 'Billboard' });
      st.pickObject = obj;
    }
  }

  has(label: ManagedWebLabel): boolean {
    return this._labels.has(label);
  }

  /**
   * Forget the cached state of a label whose visual was rebuilt (Mode switch,
   * new plate) so the next update re-applies visibility, opacity and scale.
   */
  invalidate(label: ManagedWebLabel): void {
    const st = this._labels.get(label);
    if (!st) return;
    st.visible = false;
    st.opacity = -1;
    st.sx = -1;
    st.sy = -1;
    const v = label.visual;
    if (v) v.object.visible = false;
  }

  /** Is the label currently effectively visible (toggle ∧ owner ∧ distance)? */
  isEffectivelyVisible(label: ManagedWebLabel): boolean {
    return this._labels.get(label)?.visible === true;
  }

  /** Number of registered labels that currently carry a safe link. */
  get linkedCount(): number {
    let n = 0;
    for (let i = 0; i < this._list.length; i++) if (this._list[i].label.visual?.linkUrl) n++;
    return n;
  }

  /** Render-path tick through the bound host. Returns true when anything changed. */
  tick(): boolean {
    const host = this._host;
    if (!host || this._labels.size === 0) return false;
    const canvas = host.getCanvas();
    return this.update(host.getCamera(), canvas.clientHeight || canvas.height || 1);
  }

  /**
   * Per-frame work over ALL registered labels (see file doc). `viewportHeightPx`
   * is the canvas height in CSS pixels. Returns true when any label changed
   * visibility, opacity or scale.
   */
  update(camera: Camera, viewportHeightPx: number): boolean {
    if (this._labels.size === 0) return false;
    camera.updateMatrixWorld();
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    const toggle = isOverlayVisible('labels');
    const vh = viewportHeightPx > 0 ? viewportHeightPx : 1;
    let changed = false;

    for (let i = 0; i < this._list.length; i++) {
      const st = this._list[i];
      this._syncPick(st);
      const v = st.label.visual;
      if (!v) continue;
      const node = st.label.node;
      let visible = toggle && chainVisible(node);
      let fade = 1;
      _pos.copy(v.object.position).applyMatrix4(node.matrixWorld);
      if (visible && v.maxDistanceM > 0) {
        fade = fadeForDistance(_pos.distanceTo(_camPos), v.maxDistanceM);
        if (fade < FADE_HIDE_BELOW) visible = false;
      }

      if (visible !== st.visible) {
        st.visible = visible;
        v.object.visible = visible;
        changed = true;
      }
      if (!visible) {
        if (this._setEmphasis(st, null)) changed = true;
        continue;
      }

      if (!nearlyEqual(fade, st.opacity)) {
        st.opacity = fade;
        (v.material as Material & { opacity: number }).opacity = fade;
        changed = true;
      }

      if (v.kind === 'Billboard') {
        _view.copy(_pos).applyMatrix4(camera.matrixWorldInverse);
        const depth = Math.max(1e-6, -_view.z);
        let worldPerPx: number;
        const persp = camera as PerspectiveCamera;
        if (persp.isPerspectiveCamera) {
          worldPerPx = (2 * Math.tan((persp.fov * Math.PI) / 360) * depth) / ((persp.zoom || 1) * vh);
        } else {
          const ortho = camera as OrthographicCamera;
          worldPerPx = (ortho.top - ortho.bottom) / ((ortho.zoom || 1) * vh);
        }
        const hWorld = v.screenHeightPx * worldPerPx;
        _parentScale.setFromMatrixScale(node.matrixWorld);
        const sx = (hWorld * v.aspect) / (_parentScale.x || 1);
        const sy = hWorld / (_parentScale.y || 1);
        if (!nearlyEqual(sx, st.sx) || !nearlyEqual(sy, st.sy)) {
          st.sx = sx;
          st.sy = sy;
          v.object.scale.set(sx, sy, 1);
          // The owner node is usually STATIC (the loader / bake freeze the
          // model tree with `matrixAutoUpdate = false`, and the sweep catches
          // the sprite too because it is already a child by then). The
          // renderer's traversal stops at a frozen parent, so nothing would
          // ever turn this scale into a world matrix — the sprite rendered as
          // a 1 × 1 m square with the wide texture squeezed into it. Keep the
          // sprite live and rebuild its world matrix from the parent's valid
          // one right here.
          v.object.matrixAutoUpdate = true;
          v.object.matrixWorldAutoUpdate = true;
          v.object.updateWorldMatrix(false, false);
          changed = true;
        }
      }

      // Hover / selection feedback: border in the channel colour + pin line.
      const em = this._host?.emphasis;
      if (em) {
        if (this._setEmphasis(st, this._emphasisFor(st, em))) changed = true;
        if (st.emphasis !== null) {
          let half: number;
          if (v.kind === 'Billboard') {
            _parentScale.setFromMatrixScale(node.matrixWorld);
            half = (v.object.scale.y * (_parentScale.y || 1)) / 2;
          } else {
            half = plateHalfHeightWorld(v.object);
          }
          if (this._updatePin(st, em, camera, _pos, half, v.kind === 'Billboard')) changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * The linked, effectively visible label under a client point, or null.
   * Billboards win unconditionally; a Plate wins only when `occlusion` reports
   * no opaque surface closer than the plate.
   */
  hitTest(
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
    camera: Camera,
    occlusion?: OcclusionQuery,
    linkedOnly = true,
  ): ManagedWebLabel | null {
    if (this._labels.size === 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    this._raycaster.setFromCamera(_ndc, camera);
    // Labels live on overlay layers (Billboard) or layer 0 (Plate).
    this._raycaster.layers.enableAll();

    let billboard: ManagedWebLabel | null = null;
    let billboardDist = Infinity;
    let plate: ManagedWebLabel | null = null;
    let plateDist = Infinity;
    for (let i = 0; i < this._list.length; i++) {
      const st = this._list[i];
      const label = st.label;
      const v = label.visual;
      if (!v || !st.visible || (linkedOnly && !v.linkUrl)) continue;
      v.object.updateWorldMatrix(true, false);
      this._hits.length = 0;
      v.object.raycast(this._raycaster, this._hits);
      if (this._hits.length === 0) continue;
      let d = Infinity;
      for (const h of this._hits) if (h.distance < d) d = h.distance;
      if (v.kind === 'Billboard') {
        if (d < billboardDist) { billboardDist = d; billboard = label; }
      } else if (d < plateDist) {
        plateDist = d;
        plate = label;
      }
    }
    this._hits.length = 0;
    if (billboard) return billboard;
    if (!plate) return null;
    if (occlusion) {
      const blocker = occlusion(clientX, clientY);
      // 1 mm tolerance: the plate sits 2 mm in front of its own surface.
      if (blocker < plateDist - 0.001) return null;
    }
    return plate;
  }

  /**
   * Click entry point for the viewer's canvas `pointerup` (after the drag
   * threshold). Opens the hit label's URL SYNCHRONOUSLY and returns true (the
   * gesture is consumed); returns false when no linked label is under the point.
   */
  tryOpenLink(clientX: number, clientY: number): boolean {
    const host = this._host;
    if (!host || this._labels.size === 0) return false;
    const hit = this.hitTest(clientX, clientY, host.getCanvas(), host.getCamera(), host.occlusion);
    const url = hit?.visual?.linkUrl;
    if (!url) return false;
    (host.open ?? openExternal)(url);
    return true;
  }

  /**
   * ANY effectively visible label under a client point (linked or not), or
   * null. The viewer's click handler uses it AFTER the normal selection to
   * decide that a click on a label also frames the selected object.
   */
  labelAt(clientX: number, clientY: number): ManagedWebLabel | null {
    const host = this._host;
    if (!host || this._labels.size === 0) return null;
    return this.hitTest(clientX, clientY, host.getCanvas(), host.getCamera(), host.occlusion, false);
  }

  /** Hover entry point: true when a linked label is under the point. */
  isLinkAt(clientX: number, clientY: number): boolean {
    const host = this._host;
    if (!host || this.linkedCount === 0) return false;
    return this.hitTest(clientX, clientY, host.getCanvas(), host.getCamera(), host.occlusion) !== null;
  }

  /** Dispose every registered label (clearModel, before geometry teardown). */
  clear(): void {
    while (this._list.length > 0) {
      const label = this._list[this._list.length - 1].label;
      this.unregister(label);
      try {
        label.dispose();
      } catch (e) {
        console.warn('[WebLabelManager] dispose failed:', e);
      }
    }
    this.hoveringLink = false;
  }
}
