// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-three.mjs — read a GLB into a plain three.js tree, OUTSIDE the browser
 * (plan-673 Phase 4b).
 *
 * Why this exists: authoring physics parameters onto a library part needs the
 * part's GEOMETRY, not only its extras. The collider boxes and the mass
 * integration are both measurements on the vertices, and the vertices of a
 * shipped library asset are Draco-compressed, so `readGlb` (JSON chunk only)
 * cannot see them. `GLTFLoader` needs a browser-ish environment and a Draco
 * worker; glTF-Transform decodes Draco in Node without either.
 *
 * What it promises, and what it does NOT:
 *   - every reachable glTF node becomes one `Object3D` with the node's name,
 *     its local TRS and its `extras` under `userData` (`extras.realvirtual`
 *     under `userData.realvirtual`, the shape every component reader expects);
 *   - a node with a mesh gets ONE child `Mesh` per primitive, carrying a
 *     `BufferGeometry` with `position` and (where present) the index. That is
 *     enough for `collectOwnedMeshes` / `computeLinkMassProperties` and for an
 *     AABB; it is NOT a render-faithful load (no materials, no normals, no UVs,
 *     no morph targets, no skinning).
 *   - names are the glTF names verbatim. The viewer's file-wide de-duplication
 *     (`nodeNames` in rv-glb-nodes.mjs) is NOT applied, so a file with two
 *     identically named nodes addresses ambiguously here. Callers that need
 *     addressing use the returned path map.
 */

import { readFile } from 'node:fs/promises';
import { BufferAttribute, BufferGeometry, Mesh, Object3D } from 'three';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

/** A reader that can decode (and re-encode) Draco, like `compress-glb.mjs` builds one. */
export async function dracoIO() {
  const [decoder, encoder] = await Promise.all([
    draco3d.createDecoderModule(),
    draco3d.createEncoderModule(),
  ]);
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': decoder, 'draco3d.encoder': encoder });
}

function geometryOf(prim) {
  const geo = new BufferGeometry();
  const pos = prim.getAttribute('POSITION');
  if (!pos) return null;
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos.getArray()), pos.getElementSize()));
  const idx = prim.getIndices();
  if (idx) geo.setIndex(new BufferAttribute(new Uint32Array(idx.getArray()), 1));
  return geo;
}

/**
 * Read `file` (a GLB path) into a three.js tree.
 *
 * @returns `{ root, byPath, nodes }` — `root` is the scene's single root when it
 * has exactly one (a library asset always does), otherwise a synthetic
 * `Object3D` holding every scene root. `byPath` maps the ASSET-RELATIVE path
 * (root segment included, `/`-joined, the spelling `nodePaths` of
 * rv-glb-nodes.mjs produces) to the `Object3D`; `nodes` is the same set in
 * depth-first scene order.
 */
export async function loadGlbAsThree(file) {
  const io = await dracoIO();
  const doc = await io.readBinary(new Uint8Array(await readFile(file)));
  const scene = doc.getRoot().listScenes()[0];
  if (!scene) throw new Error(`${file}: no scene`);

  const byPath = new Map();
  const nodes = [];

  const build = (gltfNode, parent, parentPath) => {
    const obj = new Object3D();
    obj.name = gltfNode.getName() ?? '';
    const t = gltfNode.getTranslation();
    const r = gltfNode.getRotation();
    const s = gltfNode.getScale();
    obj.position.set(t[0], t[1], t[2]);
    obj.quaternion.set(r[0], r[1], r[2], r[3]);
    obj.scale.set(s[0], s[1], s[2]);
    const extras = gltfNode.getExtras() ?? {};
    obj.userData = { ...extras };
    parent.add(obj);
    obj.updateMatrix();
    const path = parentPath ? `${parentPath}/${obj.name}` : obj.name;
    byPath.set(path, obj);
    nodes.push(obj);

    const mesh = gltfNode.getMesh();
    if (mesh) {
      for (const [i, prim] of mesh.listPrimitives().entries()) {
        const geo = geometryOf(prim);
        if (!geo) continue;
        const m = new Mesh(geo);
        m.name = `${obj.name}_prim${i}`;
        obj.add(m);
        m.updateMatrix();
      }
    }
    for (const child of gltfNode.listChildren()) build(child, obj, path);
    return obj;
  };

  const roots = scene.listChildren();
  let root;
  if (roots.length === 1) {
    const holder = new Object3D();
    holder.name = '';
    root = build(roots[0], holder, '');
    holder.remove(root);
    root.parent = null;
  } else {
    root = new Object3D();
    root.name = scene.getName() ?? '';
    for (const r of roots) build(r, root, '');
  }
  root.updateMatrixWorld(true);
  return { root, byPath, nodes, document: doc, io };
}
