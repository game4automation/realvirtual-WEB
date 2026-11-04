// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-nodes.mjs — reference-safe structure edits on glTF JSON for the Node
 * GLB scripts (plan-610 Phase 4, F10).
 *
 * The scripts that build and patch the shipped GLBs used to move nodes by hand
 * and spell references by string concatenation; a rename or move silently broke
 * every stored path to the node or its subtree. This module edits the node tree
 * of a glTF JSON (as `readGlb` returns it) and rewrites the stored references
 * in the SAME call, through THE rewrite core the WEB editor uses
 * (`src/core/engine/rv-node-path-rewrite.mjs`, `planReferenceRewrite`).
 *
 * ## Paths
 *
 * Every path this API takes and returns is ASSET-RELATIVE: `PLC/FG01/X`, no root
 * segment — the spelling the editor writes and the demo GLBs carry. The root (the
 * glTF scene, json.scene ?? 0) itself has no path; `null` as a parent means "top
 * level". A node's path segment is the name the VIEWER gives it: GLTFLoader
 * de-duplicates names FILE-WIDE in load order (the scene name, then every node
 * depth-first with its camera and light; `<sanitized>_N` for every later claim
 * of a taken sanitized name), and the viewer restores the raw glTF name where the
 * loader only sanitized it (plan-610 Phase 5b, {@link simulateLoaderNames}). So a
 * path addresses the same node here as in the viewer's registry.
 *
 * Internally references are resolved in the viewer's REGISTRY space — the model
 * root named after the scene is the first segment (`<scene>/PLC/FG01/X`, doc-node-
 * paths.md § 1a) — with a replica of `NodeRegistry`'s node-level chain: the ONE
 * resolver inside the asset scope (as written, then with a leading root-name
 * segment stripped), then the registry-wide stages exact / space / suffix
 * (refuses ambiguity) / sanitized, then the name match inside the scope. That is
 * the chain `planDocumentReferenceRewrite` (rv-asset-document.ts) hands the core,
 * so the same written path heals onto the same node and keeps the same spelling.
 * Two differences, both because a GLB carries no constructed components and no
 * loader aliases: every reference is judged at NODE level (the rule of the
 * plan-610 Phase-3 demo audit), and there is no `alias` stage.
 *
 * ## Referrers
 *
 * Every reachable node's `extras.realvirtual` AND the scene's
 * `extras.realvirtual` — the asset writer lifts the ROOT node's components onto
 * the scene (`liftRootExtrasToScene`, rv-asset-glb-export.ts), so a Drive or an
 * FMU on the model root lives there and may hold references. `json.extras` and
 * `json.asset.extras` are file metadata (no component records) and are never
 * walked. A node inside a non-embedded `AssetReference` (foreign content) is not
 * a referrer and cannot be edited, like the editor's reference guard.
 *
 * ## Rules
 *
 *  - Errors instead of guesses: a name collision among siblings (raw OR
 *    de-duplicated name), a new or renamed name that is already used anywhere in
 *    the file (`name-taken-in-file` — the loader would silently load it as
 *    `_N`), `/` in a name, a cycle, a missing path, a move between
 *    parents whose world matrices differ, renaming a node whose PLC signal name
 *    follows its node name (plan-610 F6) — all throw {@link NodeOpError} and
 *    leave the JSON untouched (a batch is atomic).
 *  - World-preserving ONLY by construction: a move keeps the local transform and
 *    is allowed only when the old and the new parent have the same world matrix
 *    (top level ↔ identity group, sibling groups under one parent, …). No
 *    matrix is ever recomputed.
 *  - Idempotent: renaming to the current name, moving to the current parent
 *    (without `index`) and creating an existing empty group change nothing; a
 *    rewrite that already happened plans nothing. `skipIfDone` additionally
 *    turns "source missing, target already there" into a no-op.
 *  - Only the planned rewrite steps are written: `NodeId` and every other
 *    extras field stay byte-identical.
 *  - Every path that changes is rewritten — including a node whose
 *    de-duplicated name shifts because a same-named node elsewhere in the file
 *    left or now loads in a different order (`A_1` → `A`); such a shift is
 *    reported as a `dedup-shift` warning.
 *  - The name pots: a new or renamed name must be free in all five pots of the
 *    loader's ONE name table — node, named scene, named camera, light
 *    (`light_<i>`), mesh (`mesh_<i>`) — and must not be a `<base>_<n>` spelling
 *    the loader generates. Paths the loader names order-dependently (an unnamed
 *    node named after a mesh that shares its name with other meshes) are a best
 *    guess: a rewrite that reads or writes one carries an
 *    `ambiguous-loader-name` warning ({@link ambiguousLoaderNames}).
 *
 * Node built-ins only (none needed): plain JS, no three.js.
 */

import { planReferenceRewrite } from '../../src/core/engine/rv-node-path-rewrite.mjs';

/** Error of a refused node operation; `code` names the rule. The JSON is untouched. */
export class NodeOpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NodeOpError';
    this.code = code;
  }
}

/**
 * PLC signal component keys (`_N` dedup forms included) — mirror of `SIGNAL_TYPES`
 * in rv-signal-construction.ts (a TypeScript module this plain-JS file cannot
 * import; tests/rv-glb-nodes.node.test.ts pins the parity).
 */
export const SIGNAL_COMPONENT_TYPES = Object.freeze(['PLCOutputBool', 'PLCInputBool', 'PLCOutputFloat', 'PLCInputFloat', 'PLCOutputInt', 'PLCInputInt']);

/** Registry-space root segment of a scene without a name (never a valid authored name). */
const UNNAMED_ROOT = '\u0000root';

// ─── Tree ────────────────────────────────────────────────────────────

function fail(code, message) {
  throw new NodeOpError(code, message);
}

function sceneOf(json) {
  if (!json || typeof json !== 'object') fail('not-gltf', 'expected a glTF JSON object');
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  const scene = scenes[json.scene ?? 0];
  if (!scene || typeof scene !== 'object') fail('no-scene', `glTF JSON has no scene ${json.scene ?? 0}`);
  return scene;
}

/** The model root's name: the scene name (the loader names the model root after it). */
export function modelRootName(json) {
  const name = sceneOf(json).name;
  return typeof name === 'string' ? name : '';
}

function rawName(json, i, renamed) {
  if (renamed && renamed.has(i)) return renamed.get(i);
  const n = json.nodes?.[i]?.name;
  return typeof n === 'string' ? n : '';
}

/**
 * Working copy of the node tree: `roots` (scene.nodes), `children[i]`, `parent[i]`
 * (`-1` top level, `-2` unreachable). Mutations happen here and are committed at
 * the very end, so a refused batch leaves the JSON untouched.
 */
function buildTree(json) {
  const scene = sceneOf(json);
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const parent = new Array(nodes.length).fill(-2);
  const children = nodes.map((n) => (Array.isArray(n?.children) ? n.children.slice() : []));
  const roots = Array.isArray(scene.nodes) ? scene.nodes.slice() : [];
  const stack = [];
  for (const r of roots) stack.push([r, -1]);
  while (stack.length > 0) {
    const [i, p] = stack.pop();
    if (!Number.isInteger(i) || i < 0 || i >= nodes.length) fail('bad-index', `node index ${i} out of range`);
    if (parent[i] !== -2) fail('multi-parent', `node ${i} ("${rawName(json, i)}") is reachable twice — not a tree`);
    parent[i] = p;
    for (const c of children[i]) stack.push([c, i]);
  }
  return { scene, roots, children, parent };
}

function childrenOf(tree, p) {
  return p === -1 ? tree.roots : tree.children[p];
}

/** `sanitizeLikeThree` of rv-three-names.ts (`THREE.PropertyBinding.sanitizeNodeName`; parity pinned by tests/rv-glb-nodes.node.test.ts). */
export function sanitizeLikeThree(name) {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

/**
 * Replay of GLTFLoader's FILE-WIDE name de-duplication (three r185) over the
 * working tree, plus the viewer's restore step — the name every node really
 * gets in the viewer.
 *
 * GLTFLoader (`createUniqueName`, GLTFLoader.js:3703) keeps ONE `nodeNamesUsed`
 * table per parse: the sanitized name (`PropertyBinding.sanitizeNodeName`) is
 * handed out once, every later claim of the same sanitized name gets
 * `<sanitized>_<counter>` (counter per name, no check whether that spelling is
 * itself taken). It has exactly five callers (pinned by the call-site checklist
 * in tests/rv-glb-nodes.node.test.ts) — the five NAME POTS:
 *  - scene (:4437) — only a named scene;
 *  - node (:4292) — only a named node;
 *  - camera (:3972) — only a named camera;
 *  - light (:753, KHR_lights_punctual) — ALWAYS, `light_<i>` when unnamed;
 *  - mesh (:3895) — ALWAYS, once PER PRIMITIVE, `mesh_<i>` when unnamed.
 * The first four claim SYNCHRONOUSLY in this order, all inside the one
 * `getDependencies('scene')` / `getDependencies('camera')` call of `parse`:
 *  - `parse` loads ALL scenes in index order (`getDependencies('scene')`, :2661);
 *  - `loadScene` claims the scene name first (:4437), then loads its root nodes
 *    in order (:4449);
 *  - `loadNode` (:4192) → `_loadNodeShallow` claims the NODE name first (:4292),
 *    then its camera (`loadCamera`, :3972) and its light (`_loadLight`, :753),
 *    then the children are loaded depth-first (:4206), then the skin joints
 *    (`loadSkin` → `_loadNodeShallow`, :3995). Every node / camera / light / skin
 *    is claimed once (dependency cache);
 *  - then every camera no node referenced (`getDependencies('camera')`, :2663).
 * Mesh names are claimed in `loadMesh`'s promise callback, i.e. AFTER every
 * synchronous claim: a mesh never shifts a NAMED node. Among themselves the
 * mesh claims run in the order the geometry promises settle — not
 * deterministic. That matters only where a node takes the MESH's name: an
 * unnamed glTF node whose only object is a single-primitive mesh IS that mesh
 * (`_loadNodeShallow`, :4342), and the viewer keeps three's name for it
 * (`detectRenamedNodes` skips an unnamed node). When two or more mesh claims
 * share a sanitized base, which of them gets which `_N` depends on the settle
 * order, so such a node's name is AMBIGUOUS (best guess: trigger order). An
 * unnamed node that is a camera or a light takes that name likewise
 * (deterministic), a shared mesh / camera / light gets `_instance_<k>` (:2795).
 * The viewer then restores the raw glTF name when the loader only sanitized it
 * (`detectRenamedNodes`, rv-glb-parse.ts: `isPureSanitization`), and keeps the
 * `_N` name when a collision suffix was appended.
 *
 * @param skip node index that claims nothing (to ask "is this name free for it?")
 * @returns `{ names, deduped, claimed, ambiguous }`: per node index the effective
 *   name (`undefined` = not loaded), whether a collision suffix was appended, the
 *   set of every spelling that is not free for a node name — see
 *   {@link checkFreeInFile} — and per node index whether its name depends on the
 *   mesh settle order.
 */
function simulateLoaderNames(json, tree, renamed, skip = -2) {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const meshDefs = Array.isArray(json.meshes) ? json.meshes : [];
  const cameraDefs = Array.isArray(json.cameras) ? json.cameras : [];
  const lightDefs = json.extensions?.KHR_lights_punctual?.lights;
  const used = new Map();
  const claimed = new Set();
  const unique = (orig) => {
    const s = sanitizeLikeThree(orig);
    claimed.add(s);
    const seen = used.get(s);
    if (seen === undefined) { used.set(s, 0); return s; }
    used.set(s, seen + 1);
    const u = `${s}_${seen + 1}`;
    claimed.add(u);
    return u;
  };
  const names = new Array(nodes.length);
  const deduped = new Array(nodes.length).fill(false);
  const ambiguous = new Uint8Array(nodes.length);
  const shallowDone = new Uint8Array(nodes.length);
  const loaded = new Uint8Array(nodes.length);
  const cameraName = new Map();
  const lightName = new Map();
  const skins = new Set();
  const meshOrder = [];
  const meshSeen = new Set();
  const shallowOrder = [];
  const loadCamera = (ci) => {
    if (cameraName.has(ci)) return;
    const c = cameraDefs[ci];
    cameraName.set(ci, c && c[c.type] && c.name ? unique(c.name) : '');
  };
  const shallow = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= nodes.length || shallowDone[i]) return;
    shallowDone[i] = 1;
    shallowOrder.push(i);
    const raw = rawName(json, i, renamed);
    if (i === skip) names[i] = raw;
    else if (raw) {
      const u = unique(raw);
      const pure = u === sanitizeLikeThree(raw);
      names[i] = pure ? raw : u;
      deduped[i] = !pure;
    } else names[i] = '';
    const n = nodes[i] ?? {};
    if (n.mesh !== undefined && !meshSeen.has(n.mesh)) { meshSeen.add(n.mesh); meshOrder.push(n.mesh); }
    if (n.camera !== undefined) loadCamera(n.camera);
    const li = n.extensions?.KHR_lights_punctual?.light;
    if (li !== undefined && !lightName.has(li)) {
      const l = Array.isArray(lightDefs) ? lightDefs[li] : undefined;
      lightName.set(li, l ? unique(l.name || `light_${li}`) : '');
    }
  };
  const load = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= nodes.length || loaded[i]) return;
    loaded[i] = 1;
    shallow(i);
    for (const c of tree.children[i] ?? []) load(c);
    const sk = nodes[i]?.skin;
    if (sk !== undefined && !skins.has(sk)) {
      skins.add(sk);
      for (const j of json.skins?.[sk]?.joints ?? []) shallow(j);
    }
  };
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  const current = json.scene ?? 0;
  scenes.forEach((s, k) => {
    if (s && typeof s.name === 'string' && s.name) unique(s.name);
    const roots = k === current ? tree.roots : (Array.isArray(s?.nodes) ? s.nodes : []);
    for (const r of roots) load(r);
  });
  cameraDefs.forEach((_, ci) => loadCamera(ci)); // getDependencies('camera')

  // Mesh pot (asynchronous): one claim per primitive. Best guess for the order:
  // the order the meshes were triggered; a base with two or more mesh claims is
  // order-dependent.
  const meshClaims = new Map(); // sanitized base → number of mesh claims
  for (const m of meshOrder) {
    const base = sanitizeLikeThree(meshDefs[m]?.name || `mesh_${m}`);
    meshClaims.set(base, (meshClaims.get(base) ?? 0) + (meshDefs[m]?.primitives?.length ?? 0));
  }
  const meshName = new Map(); // mesh index → name of its single primitive
  const meshAmbiguous = new Set();
  for (const m of meshOrder) {
    const def = meshDefs[m];
    const base = def?.name || `mesh_${m}`;
    let first = '';
    for (let p = 0; p < (def?.primitives?.length ?? 0); p++) {
      const u = unique(base);
      if (p === 0) first = u;
    }
    if ((meshClaims.get(sanitizeLikeThree(base)) ?? 0) >= 2) meshAmbiguous.add(m);
    meshName.set(m, def?.primitives?.length === 1 ? first : '');
  }

  // Unnamed nodes take the name of their only object (`_loadNodeShallow`, :4330).
  const bones = new Set();
  for (const s of Array.isArray(json.skins) ? json.skins : []) for (const j of s?.joints ?? []) bones.add(j);
  const refs = (key) => {
    const count = new Map();
    for (const n of nodes) {
      const v = key(n);
      if (v !== undefined) count.set(v, (count.get(v) ?? 0) + 1);
    }
    return count;
  };
  const meshRefs = refs((n) => n?.mesh);
  const cameraRefs = refs((n) => n?.camera);
  const lightRefs = refs((n) => n?.extensions?.KHR_lights_punctual?.light);
  const uses = { mesh: new Map(), camera: new Map(), light: new Map() };
  const instance = (kind, count, index, name) => {
    if ((count.get(index) ?? 0) <= 1) return name;
    const k = uses[kind].get(index) ?? 0;
    uses[kind].set(index, k + 1);
    return `${name}_instance_${k}`;
  };
  // `_getNodeRef` runs for EVERY loaded node (named ones consume a use too), in
  // shallow-load order per resource (one promise, callbacks in order).
  for (const i of shallowOrder) {
    const n = nodes[i] ?? {};
    const li = n.extensions?.KHR_lights_punctual?.light;
    const mesh = n.mesh !== undefined ? instance('mesh', meshRefs, n.mesh, meshName.get(n.mesh) ?? '') : undefined;
    const camera = n.camera !== undefined ? instance('camera', cameraRefs, n.camera, cameraName.get(n.camera) ?? '') : undefined;
    const light = li !== undefined ? instance('light', lightRefs, li, lightName.get(li) ?? '') : undefined;
    if (i === skip || rawName(json, i, renamed) || bones.has(i)) continue;
    const objects = [mesh, camera, light].filter((o) => o !== undefined);
    if (objects.length !== 1) continue;
    names[i] = objects[0];
    if (mesh !== undefined && meshAmbiguous.has(n.mesh) && meshName.get(n.mesh)) ambiguous[i] = 1;
    if (names[i]) claimed.add(names[i]);
  }

  // Pots the load above did not claim but a node name must not take either:
  // every mesh / light / named camera of the file, loaded or not.
  meshDefs.forEach((m, k) => claimed.add(sanitizeLikeThree(m?.name || `mesh_${k}`)));
  if (Array.isArray(lightDefs)) lightDefs.forEach((l, k) => claimed.add(sanitizeLikeThree(l?.name || `light_${k}`)));
  for (const c of cameraDefs) if (c?.name) claimed.add(sanitizeLikeThree(c.name));
  return { names, deduped, claimed, ambiguous };
}

/**
 * Asset-relative path of every reachable node (`undefined` = unreachable); the
 * effective (viewer) node names ride along as `rel.names`, and `rel.ambiguous[i]`
 * is true when the path of `i` contains a segment whose name depends on the
 * loader's mesh settle order (the node or an ancestor).
 */
function computePaths(json, tree, renamed) {
  const rel = new Array(tree.children.length);
  const amb = new Array(tree.children.length).fill(false);
  const { names, ambiguous } = simulateLoaderNames(json, tree, renamed);
  const visit = (list, prefix, inherited) => {
    for (const i of list) {
      const n = names[i] ?? rawName(json, i, renamed);
      rel[i] = prefix === null ? n : `${prefix}/${n}`;
      amb[i] = inherited || ambiguous[i] === 1;
      visit(tree.children[i], rel[i], amb[i]);
    }
  };
  visit(tree.roots, null, false);
  rel.names = names;
  rel.ambiguous = amb;
  return rel;
}

/**
 * Throw `name-taken-in-file` when the loader would not give `name` to node
 * `self` (or a new node, `self = -1`) verbatim, or when taking it would shift a
 * name the loader hands out elsewhere. Refused: a name whose sanitized form, or
 * the spelling itself, is in one of the five name pots — another node name, a
 * named scene, a named camera, a light (`light_<i>` when unnamed), a mesh
 * (`mesh_<i>` when unnamed) — or is a `<base>_<n>` spelling the loader GENERATES
 * for a later claim (`createUniqueName` never checks whether `<base>_<n>` is
 * itself taken, so a node really named so would load under the same name as the
 * generated one), or the name an unnamed node takes from its mesh / camera /
 * light. A script never produces a silent `_N`, and no new name is itself
 * order-dependent.
 */
function checkFreeInFile(json, tree, name, self, renamed, what) {
  const { claimed } = simulateLoaderNames(json, tree, renamed, self);
  const s = sanitizeLikeThree(name);
  if (claimed.has(s) || claimed.has(name)) {
    fail('name-taken-in-file', `${what}: the name "${name}" is already used elsewhere in the file (a node, scene, camera, light or mesh name, or a name the loader generates) — the loader de-duplicates names file-wide and would load this node or another object as "${s}_N"; choose a name unique in the file`);
  }
}

function inSceneOrder(tree, fn) {
  const visit = (list) => { for (const i of list) { fn(i); visit(tree.children[i]); } };
  visit(tree.roots);
}

/** `Map<nodeIndex, assetRelativePath>` of every node reachable from the scene, loader naming, depth-first scene order. */
export function nodePaths(json) {
  const tree = buildTree(json);
  const rel = computePaths(json, tree, null);
  const out = new Map();
  inSceneOrder(tree, (i) => out.set(i, rel[i]));
  return out;
}

/**
 * `Map<nodeIndex, effectiveName>`: the node name the viewer gives each reachable
 * node (the glTF name, or `<sanitized>_N` when the name collides FILE-WIDE) —
 * the path segment of {@link nodePaths}.
 */
export function nodeNames(json) {
  const tree = buildTree(json);
  const rel = computePaths(json, tree, null);
  const out = new Map();
  inSceneOrder(tree, (i) => out.set(i, rel.names[i]));
  return out;
}

/**
 * Every reachable node the loader loads under a collision name (`<sanitized>_N`
 * instead of its glTF name), in scene order: `{ index, path, raw, name }`.
 */
export function fileNameCollisions(json) {
  const tree = buildTree(json);
  const { deduped } = simulateLoaderNames(json, tree, null);
  const rel = computePaths(json, tree, null);
  const out = [];
  inSceneOrder(tree, (i) => {
    if (deduped[i]) out.push({ index: i, path: rel[i], raw: rawName(json, i), name: rel.names[i] });
  });
  return out;
}

/**
 * Every reachable node whose path the loader does not hand out deterministically,
 * in scene order: `{ index, path, name, ancestor }`. A node is ambiguous when it
 * is an unnamed glTF node that takes its name from a single-primitive mesh whose
 * sanitized base two or more mesh claims share (the `_N` depends on the order the
 * geometry promises settle, see {@link simulateLoaderNames}); `ancestor` is
 * `true` when not the node itself but a node on its path is the ambiguous one.
 * `nodePaths` / `nodeNames` still report the best guess (trigger order).
 */
export function ambiguousLoaderNames(json) {
  const tree = buildTree(json);
  const { ambiguous } = simulateLoaderNames(json, tree, null);
  const rel = computePaths(json, tree, null);
  const out = [];
  inSceneOrder(tree, (i) => {
    if (rel.ambiguous[i]) out.push({ index: i, path: rel[i], name: rel.names[i], ancestor: ambiguous[i] !== 1 });
  });
  return out;
}

/** Node index of an asset-relative path, `null` when there is none (exact match only). */
export function findByPath(json, path) {
  if (typeof path !== 'string' || path === '') return null;
  for (const [i, p] of nodePaths(json)) if (p === path) return i;
  return null;
}

/**
 * Read-only view of TODAY's node-level resolution chain over an unchanged file
 * (plan-769 Phase 0, `scripts/rv-reference-baseline.mjs`): the same lookup the
 * rename / move pipeline resolves written paths with. `resolve(written)` →
 * `{ idx, stage, spelling, scopeRootPath } | null` with `idx -1` = model root and
 * `stage` ∈ exact / space / suffix / sanitized / name-in-scope; `resolveName(name,
 * ownerIdx)` is the NAME_FIELDS lookup; `rel[i]` the asset-relative loader path;
 * `isForeign(i)` = inside a non-embedded `AssetReference`.
 */
export function referenceLookup(json, opts = {}) {
  const tree = buildTree(json);
  const rel = computePaths(json, tree, null);
  const lookup = buildLookup(json, tree, rel, opts.rootNames);
  return {
    R: lookup.R,
    reg: lookup.reg,
    rel,
    resolve: lookup.resolve,
    resolveName: lookup.resolveName,
    parent: tree.parent,
    isForeign: (i) => i >= 0 && insideReference(json, tree, i),
  };
}

// ─── Transforms ──────────────────────────────────────────────────────

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Local matrix (column-major) of a glTF node: `matrix`, else T·R·S. */
function localMatrix(node) {
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) return node.matrix;
  const t = node?.translation ?? [0, 0, 0];
  const [x, y, z, w] = node?.rotation ?? [0, 0, 0, 1];
  const s = node?.scale ?? [1, 1, 1];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0,
    (2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0,
    (2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** World matrix of `i` in the working tree (`-1` = the root = identity). */
function worldMatrix(json, tree, i) {
  let m = IDENTITY;
  for (let cur = i; cur >= 0; cur = tree.parent[cur]) m = mul(localMatrix(json.nodes[cur]), m);
  return m;
}

function sameMatrix(a, b) {
  for (let k = 0; k < 16; k++) if (Math.abs(a[k] - b[k]) > 1e-9 * Math.max(1, Math.abs(a[k]), Math.abs(b[k]))) return false;
  return true;
}

function hasIdentityTransform(node) {
  return sameMatrix(localMatrix(node), IDENTITY);
}

// ─── Guards ──────────────────────────────────────────────────────────

function rvOf(holder) {
  const rv = holder?.extras?.realvirtual;
  return rv && typeof rv === 'object' && !Array.isArray(rv) ? rv : null;
}

/** A non-embedded `AssetReference` (foreign content behind it). */
function isReferenceNode(node) {
  const ref = rvOf(node)?.AssetReference;
  if (!ref || typeof ref !== 'object') return false;
  const named = (typeof ref.assetId === 'string' && ref.assetId) || (typeof ref.path === 'string' && ref.path);
  return !!named && ref.embedded !== true;
}

/** Is `i` (inclusive) inside a non-embedded reference? */
function insideReference(json, tree, i) {
  for (let cur = i; cur >= 0; cur = tree.parent[cur]) if (isReferenceNode(json.nodes[cur])) return true;
  return false;
}

/** Strictly below a reference node (the reference node itself may be renamed / moved). */
function belowReference(json, tree, i) {
  return i >= 0 && insideReference(json, tree, tree.parent[i]);
}

/** plan-610 F6: does the PLC signal name of node `i` follow its node name? */
function signalNameFollowsNodeName(node) {
  const rv = rvOf(node);
  if (!rv) return false;
  for (const key of Object.keys(rv)) {
    if (!SIGNAL_COMPONENT_TYPES.includes(key.replace(/_\d+$/, ''))) continue;
    const name = rv[key]?.Name;
    if (typeof name !== 'string' || name.length === 0) return true;
  }
  return false;
}

function checkName(name) {
  if (typeof name !== 'string' || name.trim() === '') fail('empty-name', 'a node name must not be empty');
  if (name.includes('/')) fail('slash-in-name', `node name "${name}" contains "/" — a path separator cannot be part of a name`);
}

/** Throw when `name` is taken among the children of `p` (raw or effective name), `self` excluded. */
function checkFree(json, tree, p, name, self, renamed, what, names) {
  const list = childrenOf(tree, p);
  for (let k = 0; k < list.length; k++) {
    if (list[k] === self) continue;
    if (rawName(json, list[k], renamed) === name || names?.[list[k]] === name) {
      fail('name-collision', `${what}: a sibling named "${name}" already exists under ${p === -1 ? 'the top level' : `node ${p}`} — rename one of them first`);
    }
  }
}

// ─── Resolution (pre-change state, registry space) ───────────────────

function lastSegment(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function normalizePath(path) {
  let p = path.trim();
  while (p.startsWith('/')) p = p.slice(1);
  return p.replace(/\/{2,}/g, '/');
}

/**
 * The pre-change lookup: a replica of `NodeRegistry`'s node chain over the
 * registry-space paths (`R` = the model root, `R/<asset-relative>` its nodes).
 */
function buildLookup(json, tree, rel, rootNames) {
  const R = modelRootName(json) || UNNAMED_ROOT;
  const reg = (i) => (i === -1 ? R : `${R}/${rel[i]}`);
  const byPath = new Map([[R, -1]]);
  const suffix = new Map();
  const addSuffix = (p) => {
    const s = lastSegment(p);
    let arr = suffix.get(s);
    if (!arr) suffix.set(s, (arr = []));
    arr.push(p);
  };
  addSuffix(R);
  for (let i = 0; i < rel.length; i++) {
    if (rel[i] === undefined) continue;
    const p = reg(i);
    byPath.set(p, i);
    addSuffix(p);
  }
  let sanitized = null;
  const sanitizedIndex = () => {
    if (sanitized) return sanitized;
    sanitized = new Map();
    for (const p of byPath.keys()) {
      const k = sanitizeLikeThree(p);
      const arr = sanitized.get(k);
      if (arr) arr.push(p); else sanitized.set(k, [p]);
    }
    return sanitized;
  };
  const names = new Set();
  if (modelRootName(json)) names.add(modelRootName(json));
  for (const n of rootNames ?? []) if (typeof n === 'string' && n) names.add(n);

  /** `_getNodeStaged`: exact → space → suffix (refuses ambiguity) → sanitized (refuses ambiguity). */
  const getStaged = (path) => {
    const direct = byPath.get(path);
    if (direct !== undefined) return { idx: direct, stage: 'exact' };
    const normalized = path.replace(/ /g, '_');
    if (normalized !== path) {
      const n = byPath.get(normalized);
      if (n !== undefined) return { idx: n, stage: 'space' };
    }
    const candidates = suffix.get(lastSegment(path));
    if (candidates) {
      const found = new Set();
      for (const p of candidates) {
        const ok = p === path || p.endsWith('/' + path)
          || (normalized !== path && (p === normalized || p.endsWith('/' + normalized)));
        if (ok) found.add(byPath.get(p));
      }
      if (found.size > 1) return null; // refusing to guess — a decision, not a miss
      if (found.size === 1) return { idx: [...found][0], stage: 'suffix' };
    }
    const hits = sanitizedIndex().get(sanitizeLikeThree(path));
    if (!hits) return null;
    const distinct = new Set(hits.map((p) => byPath.get(p)));
    return distinct.size === 1 ? { idx: [...distinct][0], stage: 'sanitized' } : null;
  };

  const nameMatches = (segment) => {
    if (names.has(segment)) return true;
    const s = sanitizeLikeThree(segment);
    for (const n of names) if (sanitizeLikeThree(n) === s) return true;
    return false;
  };

  /** `findNodeInScope` over the whole model (pre-order, root first, first hit wins). */
  const effName = (i) => (i === -1 ? R : rel.names[i]);
  const nameInScope = (path) => {
    const name = lastSegment(path);
    if (!name) return null;
    const stack = [-1];
    while (stack.length > 0) {
      const i = stack.pop();
      if (effName(i) === name) return i;
      const kids = childrenOf(tree, i);
      for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
    }
    return null;
  };

  /** Node-level `_resolveChain` (`plainNode(false)`): scoped, then registry-wide, then name in scope. */
  const resolve = (written) => {
    // The ONE resolver inside the asset scope (rv-reference-resolver.ts).
    const p = normalizePath(written);
    if (p !== '') {
      const asWritten = `${R}/${p}`;
      const hit = getStaged(asWritten);
      if (hit) return { idx: hit.idx, stage: hit.stage, spelling: 'relative', scopeRootPath: R };
      const slash = p.indexOf('/');
      const first = slash === -1 ? p : p.slice(0, slash);
      if (nameMatches(first)) {
        const rest = slash === -1 ? '' : p.slice(slash + 1);
        if (rest === '') return { idx: -1, stage: 'exact', spelling: 'root-prefixed', scopeRootPath: R };
        const h2 = getStaged(`${R}/${rest}`);
        if (h2) return { idx: h2.idx, stage: h2.stage, spelling: 'root-prefixed', scopeRootPath: R };
      }
    }
    // Registry-wide (raw written path); an exact hit is an absolute spelling.
    const r = getStaged(written);
    if (r) return r.stage === 'exact'
      ? { idx: r.idx, stage: 'exact', spelling: 'relative', scopeRootPath: '' }
      : { idx: r.idx, stage: r.stage, spelling: 'relative', scopeRootPath: R };
    const byName = nameInScope(written);
    return byName === null ? null : { idx: byName, stage: 'name-in-scope', spelling: 'relative', scopeRootPath: R };
  };

  /** Editor's `resolveName` for NAME_FIELDS: owner subtree, then the model, then the lookup chain. */
  const namedUnder = (root, name) => {
    const out = [];
    const stack = [root];
    while (stack.length > 0) {
      const i = stack.pop();
      if (effName(i) === name) out.push(i);
      const kids = childrenOf(tree, i);
      for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
    }
    return out;
  };
  const resolveName = (name, ownerIdx) => {
    const inOwner = namedUnder(ownerIdx, name);
    if (inOwner.length === 1) return { canonical: reg(inOwner[0]) };
    if (inOwner.length > 1) return { canonical: null, ambiguous: true };
    const inScope = namedUnder(-1, name);
    if (inScope.length > 1) return { canonical: null, ambiguous: true };
    if (inScope.length === 1) return { canonical: reg(inScope[0]) };
    const hit = getStaged(name);
    return hit ? { canonical: reg(hit.idx) } : null;
  };

  return { R, reg, byPath, resolve, resolveName };
}

// ─── The operation pipeline ──────────────────────────────────────────

function emptyResult() {
  return { referencesRewritten: 0, nameFieldsRewritten: 0, warnings: [] };
}

/**
 * Resolve, validate and apply `ops` (`{ kind: 'rename', idx, name }` |
 * `{ kind: 'move', idx, parent, index? }`, indices from the pre-change state) on
 * a working copy, plan the reference rewrite against the pre-change state, then
 * commit structure + rewrite together.
 */
function runOps(json, tree, pre, ops, opts) {
  const renamed = new Map();
  const touched = new Set();
  const validate = (op) => {
    const { idx } = op;
    if (belowReference(json, tree, idx)) fail('inside-reference', `"${pre[idx]}" lies inside a referenced asset — edit the asset itself`);
    if (op.kind === 'rename') {
      checkName(op.name);
      const p = tree.parent[idx];
      if (rawName(json, idx, renamed) === op.name) return false;
      if (signalNameFollowsNodeName(json.nodes[idx])) {
        fail('signal-name-follows-node', `"${pre[idx]}" is a PLC signal whose name is its node name — renaming the node renames the signal; set its Name field or use web_editor_signal_rename`);
      }
      checkFree(json, tree, p, op.name, idx, renamed, `rename "${pre[idx]}" → "${op.name}"`, simulateLoaderNames(json, tree, renamed).names);
      checkFreeInFile(json, tree, op.name, idx, renamed, `rename "${pre[idx]}" → "${op.name}"`);
      renamed.set(idx, op.name);
      touched.add(idx);
      return true;
    }
    // move
    const np = op.parent;
    const oldP = tree.parent[idx];
    if (np >= 0 && insideReference(json, tree, np)) fail('inside-reference', `cannot move into "${pre[np]}": it is (inside) a referenced asset`);
    for (let cur = np; cur >= 0; cur = tree.parent[cur]) {
      if (cur === idx) fail('cycle', `cannot move "${pre[idx]}" under itself or its own descendant "${pre[np]}"`);
    }
    if (np === oldP && op.index === undefined) return false;
    if (np !== oldP) {
      if (!sameMatrix(worldMatrix(json, tree, oldP), worldMatrix(json, tree, np))) {
        fail('world-mismatch', `moving "${pre[idx]}" from ${oldP === -1 ? 'the top level' : `"${pre[oldP]}"`} to ${np === -1 ? 'the top level' : `"${pre[np]}"`} would change its world pose — the two parents' world matrices differ (only moves between parents with the same world matrix, e.g. top level ↔ identity group, are allowed)`);
      }
      checkFree(json, tree, np, rawName(json, idx, renamed), idx, renamed, `move "${pre[idx]}"`, pre.names);
    }
    const from = childrenOf(tree, oldP);
    const at = from.indexOf(idx);
    from.splice(at, 1);
    const to = childrenOf(tree, np);
    const pos = op.index === undefined ? to.length : Math.max(0, Math.min(to.length, Math.trunc(op.index)));
    to.splice(pos, 0, idx);
    tree.parent[idx] = np;
    touched.add(idx);
    return true;
  };

  let changed = false;
  for (const op of ops) if (validate(op)) changed = true;
  if (!changed) return emptyResult();

  const post = computePaths(json, tree, renamed);
  const lookup = buildLookup(json, tree.preTree, pre, opts?.rootNames);
  const moves = new Map();
  const warnings = [];
  for (let i = 0; i < pre.length; i++) {
    if (pre[i] === undefined || pre[i] === post[i]) continue;
    moves.set(lookup.reg(i), `${lookup.R}/${post[i]}`);
    if (!touched.has(i) && pre.names[i] !== post.names[i]) {
      warnings.push({
        code: 'dedup-shift', nodePath: post[i], componentType: '', field: '', path: pre[i],
        message: `"${pre[i]}" is now "${post[i]}": a same-named node elsewhere in the file left, arrived or now loads in a different order, so the loader's file-wide de-duplicated name changed${signalNameFollowsNodeName(json.nodes[i]) ? ' — this node is a PLC signal named after its node, so its signal name changes too' : ''}.`,
      });
    }
    if (pre.ambiguous[i] || post.ambiguous[i]) {
      warnings.push({
        code: 'ambiguous-loader-name', nodePath: post[i], componentType: '', field: '', path: pre[i],
        message: `"${pre[i]}" → "${post[i]}": a segment of this path is the name of an unnamed node that the loader takes from a mesh whose name other meshes share — its "_N" depends on the order the geometry loads, so the path (and any reference rewritten onto it) is a best guess. Give the node a name.`,
      });
    }
  }

  // Referrers in the PRE state: the scene (= model root) and every reachable node.
  const referrers = [];
  const holderOf = new Map();
  const sceneRv = rvOf(tree.scene);
  if (sceneRv) { referrers.push({ nodePath: lookup.R, extras: sceneRv }); holderOf.set(lookup.R, tree.scene); }
  for (let i = 0; i < pre.length; i++) {
    if (pre[i] === undefined) continue;
    const rv = rvOf(json.nodes[i]);
    if (!rv) continue;
    const p = lookup.reg(i);
    referrers.push({ nodePath: p, extras: rv });
    holderOf.set(p, json.nodes[i]);
  }
  const foreign = new Map();
  const plan = planReferenceRewrite({
    referrers,
    moves,
    isForeign: (p) => {
      let v = foreign.get(p);
      if (v === undefined) {
        const i = lookup.byPath.get(p);
        v = i !== undefined && i >= 0 && insideReference(json, tree.preTree, i);
        foreign.set(p, v);
      }
      return v;
    },
    resolveOld: ({ path }) => {
      const hit = lookup.resolve(path);
      if (!hit) return null;
      return { canonical: lookup.reg(hit.idx), spelling: hit.spelling, stage: hit.stage, scopeRootPath: hit.scopeRootPath };
    },
    resolveName: ({ name, referrerPath }) => {
      const owner = lookup.byPath.get(referrerPath);
      return owner === undefined ? null : lookup.resolveName(name, owner);
    },
  });

  // Commit: structure, names, then the planned field writes.
  const nodes = json.nodes;
  for (let i = 0; i < nodes.length; i++) {
    if (tree.parent[i] === -2 && tree.children[i].length === 0) continue;
    const before = Array.isArray(nodes[i].children) ? nodes[i].children : [];
    const after = tree.children[i];
    if (before.length === after.length && before.every((c, k) => c === after[k])) continue;
    if (after.length > 0) nodes[i].children = after; else delete nodes[i].children;
  }
  tree.scene.nodes = tree.roots;
  for (const [i, name] of renamed) nodes[i].name = name;
  const relOf = (p) => (p === lookup.R ? '' : p.slice(lookup.R.length + 1));
  for (const s of [...plan.steps, ...plan.nameSteps]) {
    const holder = holderOf.get(s.oldNodePath);
    holder.extras.realvirtual[s.componentType][s.field] = s.value;
  }
  for (const w of plan.warnings) warnings.push({ ...w, nodePath: relOf(w.nodePath) });
  return {
    referencesRewritten: plan.counts.referencesRewritten,
    nameFieldsRewritten: plan.counts.nameFieldsRewritten,
    warnings,
    post,
  };
}

/** Pre-change working state: the tree (mutated by the ops) plus a frozen copy for lookups. */
function prepare(json) {
  const tree = buildTree(json);
  tree.preTree = { roots: tree.roots.slice(), children: tree.children.map((c) => c.slice()), parent: tree.parent.slice(), scene: tree.scene };
  const pre = computePaths(json, tree, null);
  const index = new Map();
  for (let i = 0; i < pre.length; i++) if (pre[i] !== undefined) index.set(pre[i], i);
  return { tree, pre, index };
}

function need(index, path, what) {
  if (typeof path !== 'string' || path === '') fail('bad-path', `${what}: expected a non-empty asset-relative path, got ${JSON.stringify(path)}`);
  const i = index.get(path);
  if (i === undefined) fail('not-found', `${what}: no node at "${path}"`);
  return i;
}

function parentArg(index, path, what) {
  if (path === null || path === undefined || path === '') return -1;
  return need(index, path, what);
}

/**
 * Rename the node at `path` to `newName` and rewrite every stored reference to
 * it or its subtree. See the module header for the rules.
 */
export function renameNode(json, path, newName, opts = {}) {
  checkName(newName);
  const { tree, pre, index } = prepare(json);
  if (!index.has(path) && opts.skipIfDone) {
    const slash = typeof path === 'string' ? path.lastIndexOf('/') : -1;
    const target = slash < 0 ? newName : `${path.slice(0, slash)}/${newName}`;
    if (index.has(target)) return { ...emptyResult(), path: target };
  }
  const idx = need(index, path, 'renameNode');
  const r = runOps(json, tree, pre, [{ kind: 'rename', idx, name: newName }], opts);
  return { referencesRewritten: r.referencesRewritten, nameFieldsRewritten: r.nameFieldsRewritten, warnings: r.warnings, path: r.post ? r.post[idx] : pre[idx] };
}

/**
 * Move the node at `path` under `newParentPath` (`null` = top level), at
 * `opts.index` among the new siblings (default: last), keeping its local
 * transform — allowed only between parents with the same world matrix.
 */
export function moveNode(json, path, newParentPath, opts = {}) {
  const r = moveNodes(json, [{ path, newParentPath, index: opts.index }], opts);
  return { referencesRewritten: r.referencesRewritten, nameFieldsRewritten: r.nameFieldsRewritten, warnings: r.warnings, path: r.paths[0] };
}

/**
 * Batch move: every `path` / `newParentPath` is resolved against the state
 * BEFORE the first move (one path map, one reference scan for the whole batch,
 * like the editor's `reparentNodesBatch`); the moves run in order; the batch is
 * atomic — one refused move leaves the JSON untouched.
 */
export function moveNodes(json, moves, opts = {}) {
  if (!Array.isArray(moves)) fail('bad-args', 'moveNodes: expected an array of { path, newParentPath }');
  const { tree, pre, index } = prepare(json);
  const ops = [];
  const skipped = new Map();
  moves.forEach((m, k) => {
    const parent = parentArg(index, m?.newParentPath, `moveNodes[${k}] newParentPath`);
    if (!index.has(m?.path) && opts.skipIfDone && typeof m?.path === 'string' && m.path !== '') {
      const leaf = lastSegment(m.path);
      const target = parent === -1 ? leaf : `${pre[parent]}/${leaf}`;
      if (index.has(target)) { skipped.set(k, target); return; }
    }
    const idx = need(index, m?.path, `moveNodes[${k}]`);
    if (ops.some((o) => o.idx === idx)) fail('duplicate-move', `moveNodes: "${m.path}" is moved twice in one batch`);
    ops.push({ kind: 'move', idx, parent, index: m?.index, k });
  });
  const r = runOps(json, tree, pre, ops, opts);
  const paths = moves.map((m, k) => {
    if (skipped.has(k)) return skipped.get(k);
    const op = ops.find((o) => o.k === k);
    return r.post ? r.post[op.idx] : pre[op.idx];
  });
  return { referencesRewritten: r.referencesRewritten, nameFieldsRewritten: r.nameFieldsRewritten, warnings: r.warnings, paths };
}

/**
 * Create an empty identity-transform group `name` under `parentPath` (`null` =
 * top level), appended last — so no existing path changes and nothing is
 * rewritten. Idempotent: an existing child of that name without content
 * (mesh, camera, skin, components, extensions) and with an identity transform is
 * reused (children are fine — a reused group may already hold moved nodes); one
 * with content is an error.
 */
export function createGroup(json, parentPath, name) {
  checkName(name);
  const { tree, index } = prepare(json);
  const p = parentArg(index, parentPath, 'createGroup parentPath');
  if (p >= 0 && insideReference(json, tree, p)) fail('inside-reference', `cannot create a group inside the referenced asset "${parentPath}"`);
  const list = childrenOf(tree, p);
  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    if (rawName(json, i) !== name) continue;
    const n = json.nodes[i];
    const content = ['mesh', 'camera', 'skin', 'weights'].filter((key) => n[key] !== undefined);
    if (n.extensions && Object.keys(n.extensions).length > 0) content.push('extensions');
    const rv = rvOf(n);
    if (rv && Object.keys(rv).length > 0) content.push(`components ${Object.keys(rv).join(', ')}`);
    if (!hasIdentityTransform(n)) content.push('a non-identity transform');
    if (content.length > 0) fail('group-name-taken', `createGroup: "${parentPath ? `${parentPath}/` : ''}${name}" already exists with ${content.join(', ')} — not reusing it as a group`);
    checkFreeInFile(json, tree, name, i, null, `createGroup "${parentPath ? `${parentPath}/` : ''}${name}"`);
    const path = p === -1 ? name : `${parentPath}/${name}`;
    return { ...emptyResult(), path, nodeIndex: i, created: false };
  }
  checkFreeInFile(json, tree, name, -1, null, `createGroup "${parentPath ? `${parentPath}/` : ''}${name}"`);
  if (!Array.isArray(json.nodes)) json.nodes = [];
  const i = json.nodes.length;
  json.nodes.push({ name });
  if (p === -1) {
    if (!Array.isArray(tree.scene.nodes)) tree.scene.nodes = [];
    tree.scene.nodes.push(i);
  } else {
    if (!Array.isArray(json.nodes[p].children)) json.nodes[p].children = [];
    json.nodes[p].children.push(i);
  }
  const path = p === -1 ? name : `${parentPath}/${name}`;
  return { ...emptyResult(), path, nodeIndex: i, created: true };
}
