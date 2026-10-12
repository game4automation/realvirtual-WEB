// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Wireframe view — the asset editor's Blender-style "show the document as
 * lines" toggle.
 *
 * The swap is PER FRAME: {@link RVWireframeView.swapIn} puts one shared unlit
 * line material on every document mesh right before the frame's render passes,
 * {@link RVWireframeView.swapOut} puts the real materials back right after.
 * Between frames `mesh.material` is therefore always the authored (or toon)
 * material, which is what makes the rest of the editor indifferent to the
 * toggle: save exports real materials, a material assigned while the view is on
 * lands on the mesh, imports / undo / a test-run reload need no hook, and toon
 * can be switched on or off underneath in any order.
 *
 * Cost is one walk over the visible document tree per RENDERED frame (the
 * viewer renders on demand), no allocation after the first frame.
 */

import { MeshBasicMaterial } from 'three';
import type { Material, Mesh, Object3D, Plane } from 'three';

/** The one line colour: a neutral ink, deliberately not the accent blue the
 *  selection / hover highlight uses. */
export const WIREFRAME_COLOR = 0x39424c;
export const WIREFRAME_OPACITY = 0.15;

export class RVWireframeView {
  readonly material = new MeshBasicMaterial({
    color: WIREFRAME_COLOR,
    wireframe: true,
    // Slightly see-through: 1 px is the thinnest line WebGL draws, so opacity is
    // what makes the lines read finer, and overlapping lines add up, which keeps
    // some structure in densely tessellated parts. No depth write — the lines
    // must not occlude each other.
    transparent: true,
    opacity: WIREFRAME_OPACITY,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });

  private readonly _meshes: Mesh[] = [];
  private readonly _originals: (Material | Material[])[] = [];
  private _isFixture: (node: Object3D) => boolean = () => false;

  /** Number of meshes currently holding the line material (0 between frames). */
  get swappedCount(): number { return this._meshes.length; }

  /**
   * Put the line material on every visible layer-0 mesh under `root`.
   * `isFixture` prunes viewer-owned subtrees (floor, reflector, lights).
   * Must be paired with {@link swapOut}; a second call without it is a no-op.
   */
  swapIn(root: Object3D | null, isFixture: (node: Object3D) => boolean): void {
    if (!root || this._meshes.length > 0) return;
    this._isFixture = isFixture;
    this._walk(root);
  }

  /** Restore every mesh swapped by the last {@link swapIn}. */
  swapOut(): void {
    const meshes = this._meshes;
    const originals = this._originals;
    for (let i = 0; i < meshes.length; i++) meshes[i].material = originals[i];
    meshes.length = 0;
    originals.length = 0;
  }

  /** Section planes — the beauty pass clips per material, so the line material
   *  needs them too or a section would not cut the wireframe. */
  setClippingPlanes(planes: Plane[] | null): void {
    this.material.clippingPlanes = planes;
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.swapOut();
    this.material.dispose();
  }

  private _walk(node: Object3D): void {
    // Invisible subtrees are not drawn — nothing to swap, and the largest saving
    // on a document with hidden assemblies.
    if (!node.visible || this._isFixture(node)) return;
    const u = node.userData;
    if (u && (u._isSourceGhost || u._isSourcePreview || u._isGhostOverlay
      || u._rvGroundPlane || u._rvGroundReflector || u._rvToonOutline)) return;
    const mesh = node as Mesh;
    // Layer 0 only: gizmos, highlight proxies and labels live on overlay layers.
    if (mesh.isMesh && (mesh.layers.mask & 1) !== 0) {
      this._meshes.push(mesh);
      this._originals.push(mesh.material);
      mesh.material = this.material;
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) this._walk(children[i]);
  }
}
