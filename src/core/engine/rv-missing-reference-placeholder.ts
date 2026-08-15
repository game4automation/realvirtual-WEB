// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-missing-reference-placeholder — what stands where an asset should have been
 * (plan-703 Phase 8, §2.8, F16).
 *
 * Until now an unresolvable `AssetReference` was a **silent empty node**:
 * `ComposeResult.missing` was filled and nobody read it, so a plant that
 * referenced six machines and could reach five looked, in the viewport, exactly
 * like a plant that referenced five. This module is the first half of the answer
 * — the thing you can see. `problems-store.ts` is the second half — the reason
 * you can read.
 *
 * ## A wireframe box, not a substitute
 *
 * The placeholder must be unmistakably *not* the asset. So: no faces, no
 * material colour that could pass for a part, no shadows, no picking weight —
 * an edges-only box in the reference node's own local space, named after what
 * was looked for. It is drawn where the asset would have been, at the size the
 * asset had, and that size is the whole reason `AssetReference.bounds` exists:
 * a two-metre hole in a layout reads as a missing conveyor, while a fixed marker
 * reads as a bug in the viewer.
 *
 * Without bounds — every file written before the field existed — it falls back
 * to {@link FALLBACK_PLACEHOLDER_SIZE}, a cube big enough to notice and small
 * enough not to swamp a small assembly.
 *
 * ## It is never part of the file
 *
 * The placeholder is a live-scene object only. Both bake paths build their
 * output from the SOURCE bytes (the fast path rewrites the JSON chunk, the full
 * path re-parses the intermediate GLB into a fresh tree), so nothing that
 * composition grafts into the running scene can reach a written file. That is
 * what makes §2.8's "saving keeps the reference node byte-identical" a property
 * of the architecture rather than a rule someone has to remember — and
 * `compose-missing-references.test.ts` pins it anyway.
 *
 * ## Why it is built here and grafted by `compose`
 *
 * Because `compose` already owns the undo of grafting: every child it adds goes
 * on its `grafted` list and comes off again in `dispose()`. A placeholder added
 * anywhere else would be the one grafted node that composition does not know how
 * to remove.
 */

import { BoxGeometry, EdgesGeometry, LineBasicMaterial, LineSegments, Object3D } from 'three';
import type { RvReferenceBounds } from './rv-asset-reference';

/** rv_extras key marking a node as a placeholder. Never written to a file. */
export const RV_MISSING_PLACEHOLDER_KEY = 'MissingAssetPlaceholder';

/**
 * Edge length (metres) of the marker used when the reference carries no bounds.
 *
 * Half a metre: visible at plant scale without hiding the part next to it, and
 * at component scale it is bigger than what is missing — which is the right way
 * round, since a placeholder that disappears is a placeholder that failed.
 */
export const FALLBACK_PLACEHOLDER_SIZE = 0.5;

/** Amber. Reads as "attention" next to the cyan of selection and the red of alarms. */
const PLACEHOLDER_COLOR = 0xffa726;

/** What a placeholder needs to know about the reference it stands in for. */
export interface MissingPlaceholderSpec {
  /** Text shown as the node name in the hierarchy. */
  label: string;
  /** Authored extents; omit for the fixed marker. */
  bounds?: RvReferenceBounds | null | undefined;
  assetId?: string;
  path?: string;
}

/**
 * The name to show for a reference that could not be resolved.
 *
 * The file stem first, because that is the word the user typed when they saved
 * the asset; the `assetId` only when there is no path, because an id is a hash
 * and a hash in a hierarchy row tells nobody anything. `<missing asset>` is the
 * last resort and is deliberately a sentence rather than an empty string — a
 * blank row is indistinguishable from a rendering bug.
 */
export function missingReferenceLabel(ref: { assetId?: string; path?: string }): string {
  // `?? path` would be wrong here: a path of "///" has no segments at all, and
  // falling back to the raw string would print the separators as a name.
  const stem = (ref.path ?? '').trim().split(/[\\/]/).map(s => s.trim()).filter(Boolean).pop();
  if (stem) return stem;
  const id = (ref.assetId ?? '').trim();
  return id !== '' ? id : '<missing asset>';
}

/**
 * Local-space extents of `subtree` as seen from `referenceNode` — the authoring
 * measurement that later feeds a placeholder.
 *
 * Walks the geometry rather than calling `Box3.setFromObject`, because that
 * needs up-to-date world matrices and a caller who forgot `updateMatrixWorld`
 * would silently record the bounds of an un-posed tree. Here the reference
 * node's own transform is by definition the identity of the frame we want, so
 * the measurement is the subtree's local extents and nothing else.
 *
 * Returns null for a subtree with no positioned geometry at all: an empty box is
 * not a measurement, and writing `min === max` would produce a zero-size
 * placeholder that is invisible — the exact failure this feature exists to
 * prevent.
 */
export function referenceBoundsFromSubtree(
  referenceNode: Object3D,
  subtree: Object3D,
): RvReferenceBounds | null {
  void referenceNode;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let found = false;

  subtree.updateMatrixWorld(true);
  const inverse = subtree.matrixWorld.clone().invert();

  subtree.traverse((node) => {
    const geometry = (node as unknown as { geometry?: { boundingBox?: unknown; computeBoundingBox?: () => void } }).geometry;
    if (!geometry || typeof geometry.computeBoundingBox !== 'function') return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox as
      | { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
      | null;
    if (!box) return;
    // Eight corners through the node's world matrix and back into the subtree's
    // frame — a rotated child's AABB is not its parent's AABB, and taking the
    // shortcut here is how a rotated conveyor gets a placeholder half its length.
    const local = node.matrixWorld.clone().premultiply(inverse);
    for (let i = 0; i < 8; i++) {
      const corner = {
        x: (i & 1) ? box.max.x : box.min.x,
        y: (i & 2) ? box.max.y : box.min.y,
        z: (i & 4) ? box.max.z : box.min.z,
      };
      const e = local.elements;
      const x = e[0] * corner.x + e[4] * corner.y + e[8] * corner.z + e[12];
      const y = e[1] * corner.x + e[5] * corner.y + e[9] * corner.z + e[13];
      const z = e[2] * corner.x + e[6] * corner.y + e[10] * corner.z + e[14];
      min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
      min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
      min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
      found = true;
    }
  });

  if (!found) return null;
  if (min.every((v, i) => v === max[i])) return null;
  return { min, max };
}

/** Size and centre of the box to draw, bounds or fallback. */
function boxOf(bounds: RvReferenceBounds | null | undefined): {
  size: [number, number, number];
  centre: [number, number, number];
  fromBounds: boolean;
} {
  if (bounds) {
    const size: [number, number, number] = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    // A flat asset (a plate, a floor marking) has a zero extent on one axis and
    // would draw as a rectangle with no depth — legal, but it disappears edge-on.
    // The minimum keeps it a box without changing the two axes that carry meaning.
    const floor = FALLBACK_PLACEHOLDER_SIZE * 0.02;
    return {
      size: [Math.max(size[0], floor), Math.max(size[1], floor), Math.max(size[2], floor)],
      centre: [
        (bounds.min[0] + bounds.max[0]) / 2,
        (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2,
      ],
      fromBounds: true,
    };
  }
  const s = FALLBACK_PLACEHOLDER_SIZE;
  return { size: [s, s, s], centre: [0, s / 2, 0], fromBounds: false };
}

/**
 * The object that stands in for an asset that could not be loaded.
 *
 * Marked in three independent ways on purpose, because three different readers
 * ask three different questions: the **name** is what the hierarchy shows, the
 * **rv_extras key** is what a component/registry scan sees, and
 * `userData.__rvMissingPlaceholder` is the cheap boolean a hot loop can test
 * without touching the extras object.
 */
export function buildMissingReferencePlaceholder(spec: MissingPlaceholderSpec): Object3D {
  const { size, centre, fromBounds } = boxOf(spec.bounds);

  const geometry = new EdgesGeometry(new BoxGeometry(size[0], size[1], size[2]));
  const placeholder = new LineSegments(
    geometry,
    new LineBasicMaterial({ color: PLACEHOLDER_COLOR, transparent: true, opacity: 0.9 }),
  );
  placeholder.name = spec.label;
  placeholder.position.set(centre[0], centre[1], centre[2]);
  placeholder.castShadow = false;
  placeholder.receiveShadow = false;
  // Out of the picking BVH and out of the batcher: a placeholder is scenery for
  // the eye, and letting it become selectable would mean the user could open an
  // inspector on a node whose data is precisely what we could not load.
  placeholder.raycast = () => {};
  placeholder.userData.__rvMissingPlaceholder = true;
  placeholder.userData.realvirtual = {
    [RV_MISSING_PLACEHOLDER_KEY]: {
      label: spec.label,
      ...(spec.assetId ? { assetId: spec.assetId } : {}),
      ...(spec.path ? { path: spec.path } : {}),
      sized: fromBounds ? 'bounds' : 'fallback',
    },
  };
  return placeholder;
}

/** True for a node built by {@link buildMissingReferencePlaceholder}. */
export function isMissingReferencePlaceholder(node: Object3D): boolean {
  return (node.userData as Record<string, unknown> | undefined)?.__rvMissingPlaceholder === true;
}
