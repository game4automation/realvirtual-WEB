// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-gltf-unwrap — strip the non-content wrapper nodes a glTF scene carries.
 *
 * Hoisted out of `plugins/layout-planner/model-cache.ts` so the three GLB entry
 * points share ONE definition of "what is the content root of this file":
 * `ModelCache.getOrLoad` (planner placement), `parseGlbSubtree`
 * (rv-glb-parse.ts — editor imports), and any future consumer.
 *
 * Pure three.js — no viewer, no plugin, no DOM.
 */

import { Group, Mesh } from 'three';
import type { Object3D, Camera, Light } from 'three';

/**
 * Names of synthetic scene-container nodes (lowercase — compared case-folded).
 *
 * - `__root__`  — UnityGLTF's wrapper.
 * - `auxscene`  — three.js `GLTFExporter`'s wrapper. When `parse()` is handed an
 *   Object3D rather than a Scene (which is what `objectToGlb` always does), it
 *   invents `new Scene()` named `AuxScene` to satisfy the glTF format. Every
 *   browser-authored GLB — STEP/USD conversions, editor asset saves — therefore
 *   carries one. Missing it here would leave an extra level in every imported
 *   hierarchy AND, worse, strand the content root's transform one level down:
 *   `importCad` would record the wrapper's identity transform, and
 *   `reimportCad` would copy the old placement onto the wrapper.
 */
const WRAPPER_NAMES = new Set(['__root__', 'auxscene']);
const STRIP_NAMES = new Set(['default camera', 'hdrskybox', 'hdrSkyBox']);

/**
 * Wrapper names as `GLTFLoader` hands them back, INCLUDING the `_N` dedup
 * suffixes it appends on name collisions (`AuxScene_1`, `AuxScene_1_1`, …).
 *
 * Assets saved before the export fix carry a CHAIN of nested `AuxScene*` nodes
 * — one extra level per editor↔planner round trip. The cause: the editor's
 * load path (`loadGLB`) keeps `gltf.scene` as the asset root, so the exporter's
 * synthetic wrapper became a real content node on the next save, and the loader
 * had to dedup the repeated name. `exportAssetGlb` no longer produces them, but
 * matching the suffixed forms here is what lets ALREADY-saved files heal: the
 * planner peels the whole chain instead of stopping at the first `_N`.
 */
const WRAPPER_SUFFIXED = /^(?:__root__|auxscene)(?:_\d+)*$/i;

/** True for glTF scene-container names, incl. loader `_N` dedup suffixes. */
export function isGltfWrapperName(name: string): boolean {
  return WRAPPER_SUFFIXED.test(name);
}

/**
 * Detects names that are scene-container metadata rather than content.
 * Matches the synthetic wrappers above plus any name that ends in `.glb`
 * (or `glb` after Three.js sanitization) — UnityGLTF sets `scenes[0].name`
 * to the export filename, so the gltf.scene Three.js Group ends up with a
 * filename-based wrapper name like `EuropalletEmpty.glb` / `EuropalletEmptyglb`.
 * Those wrappers exist only because gltf-format requires a scene, but they
 * carry no semantic meaning and should be peeled off before the content
 * node is registered as a library/layout object.
 */
function isWrapperName(name: string): boolean {
  if (!name) return true;
  if (WRAPPER_NAMES.has(name.toLowerCase())) return true;
  if (isGltfWrapperName(name)) return true;
  return /\.?glb$/i.test(name);
}

function isContentNode(obj: Object3D): boolean {
  const name = obj.name.toLowerCase();
  if (STRIP_NAMES.has(name) || STRIP_NAMES.has(obj.name)) return false;
  if ((obj as unknown as Camera).isCamera) return false;
  if ((obj as unknown as Light).isLight) return false;
  return true;
}

function hasContentChildren(group: Group): boolean {
  return group.children.some(c => isContentNode(c) && ((c as Mesh).isMesh || c.children.length > 0));
}

function stripNonContent(group: Group): void {
  const toRemove = group.children.filter(c => !isContentNode(c));
  for (const child of toRemove) {
    group.remove(child);
  }
}

/**
 * Unwrap the `__root__` wrapper node created by UnityGLTF and strip
 * non-content children (default camera, hdrSkyBox, lights, cameras).
 * Returns the actual content node as the new root Group.
 *
 * Also peels off the gltf.scene wrapper that Three.js gives the filename-
 * based name (e.g. `EuropalletEmpty.glb`) when there's exactly one
 * content child — otherwise the library asset would appear inside a
 * filename-shaped LayoutObject instead of being one itself.
 */
export function unwrapGltfRoot(root: Group): Group {
  let node: Group = root;

  // Walk through single-child wrappers
  while (
    isWrapperName(node.name) ||
    (node.children.length <= 3 && !hasContentChildren(node))
  ) {
    const contentChildren = node.children.filter(c => isContentNode(c));
    // Descend into a single non-mesh content child. Three.js GLTFLoader
    // creates plain Object3D (not Group) for empty container nodes, so we
    // can't gate this on `instanceof Group` — we just need a node that
    // could carry children (anything that isn't a leaf Mesh).
    if (contentChildren.length === 1 && !(contentChildren[0] as Mesh).isMesh) {
      node = contentChildren[0] as Group;
    } else if (contentChildren.length > 0) {
      // Multiple content children — keep this node but strip non-content
      stripNonContent(node);
      return node;
    } else {
      break;
    }
  }

  stripNonContent(node);
  return node;
}
