// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pre-bake.ts — the `prepare` step of the unified pipeline (plan-754 D3b/D18).
 *
 *   load → **prepare** → bake → drop → place → init
 *
 * `prepare` runs on the temporary graph `tmp`, driven by rv extras ALONE: no
 * registry, no signal store, no component instance exists yet. Its structural
 * work is expressed as {@link PreBakeHook}s declared by the component TYPE
 * (`capabilities.onPreBake`), which is what lets the bake be a pure function of
 * (GLB, capability table, plugin claims) instead of a phase that has to run
 * after component construction.
 *
 * Hard rule for a hook (R2b): extras in, extras-or-tree out. It may re-parent
 * nodes and write plain numbers into `userData.realvirtual`; it may NOT resolve
 * other components, read signals, touch the viewer or keep a reference to
 * anything it saw. `tests/bake-pre-bake-hooks.test.ts` lints the hook modules
 * for runtime-instance imports.
 *
 * Hook ORDER is the declaration order of {@link PRE_BAKE_TYPE_ORDER} followed by
 * every other type in traversal order, so the two structural hooks that depend
 * on each other run in the order the loader used to run their phases: the drive
 * HOME pose (old Phase 8a) before the kinematic re-parenting (old Phase 8b).
 */

import { Box3, Matrix4, type Material, type Mesh, type Object3D } from 'three';
import { preBakeHookOf, type PreBakeContext, type PreBakeHook } from './rv-component-registry';
import { NodeRegistry, isSignalComponentTypeKey } from './rv-node-registry';
import { registerNodeAliasesInRegistry } from './rv-node-aliases';
import { resolveReferencePath, scopeOf, type ReferenceScope } from './rv-reference-resolver';

/**
 * Types whose hook must run before the rest, in this order. Everything not
 * listed runs afterwards in traversal order. The two entries mirror the loader
 * phases they replace: 8a (`Drive.applyBasePose`) then 8b (kinematic re-parent).
 */
export const PRE_BAKE_TYPE_ORDER: readonly string[] = Object.freeze([
  'Drive',
  'Group',
  'Kinematic',
]);

/** One re-parenting a hook performed — the loader turns it into a path alias. */
export interface PreBakeReparent {
  node: Object3D;
  /** The node's path BEFORE the hook moved it. */
  previousPath: string;
}

export interface PreBakeResult {
  /** Hook invocations (diagnostics + tests). */
  hooks: number;
  /** Distinct component types whose hook ran. */
  types: string[];
  /** Materials the hooks asked the template to carry, by id. */
  materials: ReadonlyMap<string, Material>;
  /** Subtrees a hook re-parented, in the order they moved. */
  reparented: PreBakeReparent[];
}

/**
 * A path resolver over a raw graph: a `NodeRegistry` whose nodes are registered
 * under {@link NodeRegistry.computeNodePath}, so `getNode()` offers the SAME
 * multi-stage fallback (exact → suffix → sanitized) the runtime registry offers.
 * Components keep their own resolvers; this only tells `prepare` where a path
 * points.
 *
 * It must resolve what the RUNTIME registry resolves, or the survival model
 * (`computeSurvival`) reports references as unresolved that are perfectly fine
 * at runtime — on the Mauser that was 2422 "unresolved" against 46, purely
 * because this registry lacked the layers below (plan-754 Phase 1c). Two of
 * them matter, and both only for models whose references are ROOT-RELATIVE and
 * therefore resolve through the registry's SUFFIX stage:
 *
 *  1. **Aliases.** `renamedNodes` is the glTF-dedup map of the load
 *     (`detectRenamedNodes`). Without the pre-dedup spellings, a path THROUGH a
 *     deduped middle segment matches nothing — the suffix stage keys on the
 *     LEAF and cannot repair a broken middle. Same walk, same spellings as the
 *     runtime pass: {@link registerNodeAliasesInRegistry}.
 *  2. **Signal nodes as typed components.** The registry half of
 *     `registerSignal` — deliberately NOT the SignalStore half, which
 *     CONSTRUCTS signals and has no consumer during `prepare`. This is what
 *     makes `getComponentTypes()` / `getByPath()` truthful for signal nodes
 *     here — the shape of evidence the in-place path's G1 `isNeeded` probe
 *     reads, so the two registries can be compared at all. Bounded by the
 *     signal count, not by the node count.
 *
 * `renamedNodes` is optional: a caller that never ran the glTF name
 * reconciliation (the model cache's own decode) has no renames to publish.
 */
export function buildPreBakeRegistry(
  root: Object3D,
  renamedNodes?: ReadonlyMap<Object3D, string>,
): NodeRegistry {
  const registry = new NodeRegistry();
  root.traverse((node) => {
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key in rv) {
      if (!isSignalComponentTypeKey(key)) continue;
      const sigData = rv[key] as Record<string, unknown> | undefined;
      if (!sigData || typeof sigData !== 'object') continue;
      // Same shape `registerSignal` puts in the registry: address + name, no
      // instance. The name falls back to the node name exactly as there.
      registry.register(key, path, {
        address: path,
        signalName: (sigData['Name'] as string) || node.name,
      });
    }
  });
  if (renamedNodes && renamedNodes.size > 0) registerNodeAliasesInRegistry(renamedNodes, registry);
  return registry;
}

/**
 * Re-register the CURRENT paths of everything a pre-bake hook moved.
 *
 * The registry was built before {@link runPreBakeHooks} ran, so a re-parented
 * subtree is still indexed under its authored path. Registering the new path
 * leaves the old one in place — `registerNode` only repoints the reverse map —
 * so a reference serialized against the authoring hierarchy and one against the
 * post-hook hierarchy both resolve. The moves are also reported on the
 * `BakedAsset` alias table (plan-757 D4), which the place step registers for
 * every instance — that is the reason `prepare` may re-parent at all, and
 * since plan-757 Phase 3 commit B it is the ONLY place anything re-parents
 * (the runtime init's own pass and its Phase 8c alias registration are gone).
 */
export function registerReparentedPaths(
  registry: NodeRegistry,
  reparented: ReadonlyArray<PreBakeReparent>,
): void {
  for (const { node } of reparented) {
    node.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  }
}

const _invWorld = new Matrix4();
const _local = new Matrix4();
const _tmpBox = new Box3();

/**
 * Bounds of `node`'s own and descendant source meshes, expressed in `node`'s
 * LOCAL frame. `null` when nothing below it draws. The one geometry read a hook
 * is allowed (see {@link PreBakeContext.localBounds}).
 */
export function localSourceBounds(node: Object3D): Box3 | null {
  node.updateWorldMatrix(true, true);
  _invWorld.copy(node.matrixWorld).invert();
  const box = new Box3();
  let found = false;
  node.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const gb = mesh.geometry.boundingBox;
    if (!gb) return;
    _local.multiplyMatrices(_invWorld, mesh.matrixWorld);
    _tmpBox.copy(gb).applyMatrix4(_local);
    box.union(_tmpBox);
    found = true;
  });
  return found ? box : null;
}

/** The mutable bookkeeping a {@link PreBakeContext} collects while hooks run. */
export interface PreBakeSession {
  ctx: PreBakeContext;
  materials: Map<string, Material>;
  reparented: PreBakeReparent[];
  /** The asset scope every hook path is read in (plan-757 F7) — the survival model uses the same one. */
  scope: ReferenceScope;
}

/**
 * The reference scope of a tree under `prepare` (plan-757 F7): the tree root,
 * its own path in the index (`Machine` under the loader's staging parent, `''`
 * for a parentless decode) and every name it is or was known by. The ONE
 * resolver reads a hook path, a reference field and a plugin claim relative
 * to it — exactly as the runtime registry will after the bake.
 */
export function prepareScopeOf(root: Object3D, rootNames?: Iterable<string | undefined | null>): ReferenceScope {
  return scopeOf(root, NodeRegistry.computeNodePath(root), rootNames);
}

/**
 * Build the context the hooks receive. `resolver` defaults to a fresh index
 * over `root`; `rootNames` are the root's historical names (the glTF-dedup
 * original) for step 2 of the tolerant read.
 */
export function createPreBakeContext(
  root: Object3D,
  resolver?: { getNode(path: string): Object3D | null },
  rootNames?: Iterable<string | undefined | null>,
): PreBakeSession {
  const index = resolver ?? buildPreBakeRegistry(root);
  const scope = prepareScopeOf(root, rootNames);
  const materials = new Map<string, Material>();
  const reparented: PreBakeReparent[] = [];
  const ctx: PreBakeContext = {
    root,
    // THE resolver (rv-reference-resolver.ts): as written inside the asset,
    // then root-stripped, else null — same rule the runtime applies.
    resolvePath: (path) => resolveReferencePath(index, path, scope).node,
    localBounds: (node) => localSourceBounds(node),
    keepMaterial: (id, material) => {
      if (!materials.has(id)) materials.set(id, material);
    },
    notifyReparented: (node, previousPath) => {
      reparented.push({ node, previousPath });
    },
  };
  return { ctx, materials, reparented, scope };
}

/**
 * Run every registered {@link PreBakeHook} over `root`. One traversal collects
 * the (node, type, extras) triples; the hooks then run grouped by type in
 * {@link PRE_BAKE_TYPE_ORDER} so the structural passes keep their old relative
 * order. A hook that throws is logged and skipped — `prepare` must never fail a
 * load on its own.
 */
export function runPreBakeHooks(root: Object3D, session?: PreBakeSession): PreBakeResult {
  const s = session ?? createPreBakeContext(root);
  const byType = new Map<string, Array<{ node: Object3D; extras: Record<string, unknown> }>>();
  root.traverse((node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    // plan-755 B2: extras keys follow the `_N` dedup convention (`Group`,
    // `Group_1`, …) — a second block of a type is the SAME type, so a key
    // without a hook of its own falls back to its base (`/_\d+$/` stripped, the
    // rule `claimsNodeOf` and `buildGroups` use). Exact key first, so a type
    // that really is called `Foo_1` keeps its own hook. A hook receives the
    // node's FULL extras and iterates its own blocks, so it runs exactly ONCE
    // per (node, base type) — never once per block.
    let seen: Set<string> | null = null;
    for (const key in rv) {
      if (!rv[key]) continue;
      let type = key;
      if (!preBakeHookOf(type)) {
        type = key.replace(/_\d+$/, '');
        if (type === key || !preBakeHookOf(type)) continue;
      }
      if (seen?.has(type)) continue;
      (seen ??= new Set()).add(type);
      let list = byType.get(type);
      if (!list) byType.set(type, (list = []));
      list.push({ node, extras: rv });
    }
  });

  const ordered: string[] = [];
  for (const type of PRE_BAKE_TYPE_ORDER) if (byType.has(type)) ordered.push(type);
  for (const type of byType.keys()) if (!ordered.includes(type)) ordered.push(type);

  let hooks = 0;
  for (const type of ordered) {
    const hook = preBakeHookOf(type) as PreBakeHook;
    for (const { node, extras } of byType.get(type)!) {
      try {
        hook(node, extras, s.ctx);
        hooks++;
      } catch (e) {
        console.warn(`[rv-pre-bake] onPreBake hook of "${type}" failed on "${node.name}":`, e);
      }
    }
  }
  root.updateMatrixWorld(true);
  return { hooks, types: ordered, materials: s.materials, reparented: s.reparented };
}

// ─── Document material index (plan-496) ──────────────────────────────

/**
 * Every material of the LOADED document, by name — the table
 * {@link findMaterialByName} answers from.
 *
 * It has to be taken BEFORE the material optimisation of the bake: the dedup
 * pass replaces equal materials with one shared instance and the uber pass
 * renames the survivor `__rvUberMaterial`, so after the bake a name like
 * `Paper` is simply not on any mesh any more. The index holds the ORIGINAL
 * materials and keeps their names; ownership stays with the index, so nothing
 * here is ever disposed by the bake.
 *
 * First occurrence wins, exactly like three.js' `GLTFLoader` when a glTF
 * carries two materials of one name.
 */
export function collectMaterialsByName(root: Object3D): Map<string, Material> {
  const byName = new Map<string, Material>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of mats) {
      const name = material?.name;
      if (!name || byName.has(name)) continue;
      byName.set(name, material);
    }
  });
  return byName;
}

/** Root (template or placement root) → the document material index of its asset. */
const _materialIndex = new WeakMap<Object3D, ReadonlyMap<string, Material>>();

/** Attach `index` to `root`; {@link findMaterialByName} finds it from any descendant. */
export function registerMaterialIndex(root: Object3D, index: ReadonlyMap<string, Material> | undefined): void {
  if (index && index.size > 0) _materialIndex.set(root, index);
}

/**
 * The material called `name` in the document `from` belongs to — exact first,
 * then ignoring case, first match wins. EXACTLY the rule
 * `RibbonMaterialLibrary.TryGet` applies in Unity, so a name resolves to the
 * same material on both sides.
 *
 * `from` may be any node of the document: the registered index is looked up on
 * it and on its ancestors (a placement registers its own root). When no index
 * is registered — a hand-written scene, a test graph, an unbaked load — the
 * whole tree `from` hangs in is scanned instead, which is the same answer at a
 * higher cost. Scanning only `from`'s own subtree would be wrong: a donor mesh
 * is a SIBLING of the component node, not a child of it.
 */
export function findMaterialByName(from: Object3D | null | undefined, name: string): Material | null {
  if (!from || !name) return null;
  let index: ReadonlyMap<string, Material> | undefined;
  let top: Object3D = from;
  for (let node: Object3D | null = from; node; node = node.parent) {
    index = _materialIndex.get(node);
    if (index) break;
    top = node;
  }
  if (!index) index = collectMaterialsByName(top);

  const exact = index.get(name);
  if (exact) return exact;
  const wanted = name.toLowerCase();
  for (const [key, material] of index) {
    if (key.toLowerCase() === wanted) return material;
  }
  return null;
}
