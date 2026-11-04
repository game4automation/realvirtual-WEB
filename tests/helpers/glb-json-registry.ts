// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * A `NodeRegistry` over the node tree of a glTF JSON, registered like the
 * loader does (plan-610): the model root named after the scene (the first
 * segment of every registry path, doc-node-paths.md § 1a) under a parent-less
 * world, registered as the reference scope; node names from
 * `scripts/lib/rv-glb-nodes.mjs` `nodeNames` — the replay of GLTFLoader's
 * FILE-WIDE name de-duplication plus the viewer's raw-name restore, the ONE
 * naming model the Node GLB scripts and these tests share (plan-610 Phase 5b).
 *
 * With `opts.loaderPrepare` the registry is what the viewer's runtime registry
 * holds after `prepareAndBake` (rv-prepare-and-bake.ts), as far as node PATHS
 * are concerned:
 *  - the REAL `Kinematic` pre-bake hook (rv-pre-bake-hooks.ts, Phase 8b) runs
 *    over the tree — group members and `KinematicParentEnable` axes move under
 *    their kinematic node, exactly as in `prepare`;
 *  - canonical paths are registered on the FINAL tree, then the aliases the
 *    loader publishes, in the order `initSubtree` registers them: the
 *    historical spellings of every node GLTFLoader renamed (`forEachNodeAlias`,
 *    raw + sanitized, for the renamed node and its whole subtree), then the
 *    AUTHORED path of every re-parented node (the asset alias table, D4): an
 *    alias of the moved node AND a prefix alias for its subtree (plan-610
 *    Phase 5c, `NodeRegistry.registerPrefixAlias`), exactly as `initSubtree`
 *    registers a `BakedAlias` with `subtree: true`.
 * The bake itself is not replayed: it keeps every referenced node and its
 * ancestors, so it changes no path a reference can name.
 *
 * Used by the demo-model reference audit and by the editor-parity check of the
 * Node lib (`rv-glb-nodes.node.test.ts`).
 */

import { Object3D } from 'three';
import { nodeNames } from '../../scripts/lib/rv-glb-nodes.mjs';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { forEachNodeAlias } from '../../src/core/engine/rv-node-aliases';
import { preBakeHookOf } from '../../src/core/engine/rv-component-registry';
import { registerBuiltInPreBakeHooks } from '../../src/core/engine/rv-pre-bake-hooks';
import { buildPreBakeRegistry, createPreBakeContext } from '../../src/core/engine/rv-pre-bake';
import { decodeIdentity } from '../../src/core/engine/rv-decode-identity';

export interface GltfNode { name?: string; children?: number[]; extras?: { realvirtual?: Record<string, unknown> } }
export interface GltfJson {
  nodes?: GltfNode[];
  scenes?: { name?: string; nodes?: number[]; extras?: { realvirtual?: Record<string, unknown> } }[];
  scene?: number;
}

export interface GlbJsonRegistry {
  registry: NodeRegistry;
  root: Object3D;
  /** glTF node index → the built node. */
  byIndex: Map<number, Object3D>;
  /** `loaderPrepare` only: authored (pre-move) registry path → re-parented node. */
  reparented: Array<{ node: Object3D; previousPath: string }>;
  /** Nodes GLTFLoader loads under a collision name → their raw glTF name. */
  renamed: Map<Object3D, string>;
}

export interface RegistryFromGlbJsonOptions {
  /** Create the `<node>/Signals/<variable>` (+ `Restart`) leaves an embedded `Fmu` creates in its init. */
  mirrorFmuSignals?: boolean;
  /** Replay the loader's `prepare` re-parenting and its alias registration (see the file header). */
  loaderPrepare?: boolean;
  /**
   * With `loaderPrepare`: register the re-parent entries as prefix aliases too
   * (default `true`, what the loader does since plan-610 Phase 5c). `false`
   * replays the pre-5c alias table — for before/after measurements only.
   */
  prefixAliases?: boolean;
  /**
   * Stamp the node identities (`decodeIdentity`, as `loadGLB` does) and register the
   * tree as the main document (`registerDocument`, occurrence `''`), so ADDRESS-form
   * references (`#id`, `<p>#id`, plan-769) are read by address as in the viewer — an
   * address into a placement whose content is not loaded here reads `pending`.
   * Without it a registry from raw JSON has no document and every address reads as
   * unresolved. The document is registered WITHOUT its identity record, so legacy
   * PATH references keep the node-level path chain this helper always judged them by
   * (the file's migration would call e.g. FMU signal leaves, created only at init,
   * missing).
   */
  identity?: boolean;
}

/**
 * @param fallbackRootName root name when the scene has none (the demo audit passes the file name).
 */
export function registryFromGlbJson(
  json: GltfJson,
  fallbackRootName: string,
  opts: RegistryFromGlbJsonOptions = {},
): GlbJsonRegistry {
  const registry = new NodeRegistry();
  const world = new Object3D();
  const scene = json.scenes?.[json.scene ?? 0];
  const root = new Object3D();
  root.name = scene?.name ?? fallbackRootName;
  const sceneRv = scene?.extras?.realvirtual;
  if (sceneRv && typeof sceneRv === 'object') root.userData.realvirtual = sceneRv;
  world.add(root);
  const names = nodeNames(json);
  const nodes = json.nodes ?? [];
  const byIndex = new Map<number, Object3D>();
  const renamed = new Map<Object3D, string>();
  const build = (index: number, parent: Object3D): void => {
    const g = nodes[index];
    if (!g) return;
    const o = new Object3D();
    o.name = names.get(index) ?? g.name ?? '';
    // Viewer rule (rv-glb-parse.ts `detectRenamedNodes`): a node whose loader
    // name is not its raw glTF name was renamed by the file-wide dedup.
    if (typeof g.name === 'string' && g.name !== '' && o.name !== g.name) renamed.set(o, g.name);
    const rv = g.extras?.realvirtual;
    if (rv && typeof rv === 'object') o.userData.realvirtual = rv;
    parent.add(o);
    byIndex.set(index, o);
    for (const c of g.children ?? []) build(c, o);
    if (!opts.mirrorFmuSignals) return;
    const fmu = rv?.Fmu as { FmuEmbed?: unknown; FmuVariables?: { name?: string; type?: string }[] } | undefined;
    if (fmu && fmu.FmuEmbed) {
      let signals = o.children.find((c) => c.name === 'Signals');
      if (!signals) { signals = new Object3D(); signals.name = 'Signals'; o.add(signals); }
      const leaves = (fmu.FmuVariables ?? []).filter((v) => v.name && v.type !== 'String').map((v) => v.name!);
      for (const leafName of [...leaves, 'Restart']) {
        if (signals.children.some((c) => c.name === leafName)) continue;
        const leaf = new Object3D();
        leaf.name = leafName;
        signals.add(leaf);
      }
    }
  };
  for (const i of scene?.nodes ?? []) build(i, root);

  // The decode identity runs on the DECODED tree, before `prepare` moves anything
  // (loadGLB): the seeded ids are stamped onto the objects.
  if (opts.identity) {
    const associations = new Map<Object3D, { nodes?: number }>();
    byIndex.forEach((o, i) => associations.set(o, { nodes: i }));
    decodeIdentity({ scene: root, parser: { json, associations } }, { fileKey: fallbackRootName });
  }

  const reparented: Array<{ node: Object3D; previousPath: string }> = [];
  if (opts.loaderPrepare) {
    // The real Phase-8b hook, on the tree `prepare` sees (rv-prepare-and-bake.ts step 2).
    registerBuiltInPreBakeHooks();
    const kinematic = preBakeHookOf('Kinematic');
    let first: Object3D | null = null;
    root.traverse((n) => {
      if (!first && (n.userData.realvirtual as Record<string, unknown> | undefined)?.['Kinematic']) first = n;
    });
    if (kinematic && first) {
      const prepareRegistry = buildPreBakeRegistry(root, renamed);
      const session = createPreBakeContext(root, prepareRegistry, [root.name, renamed.get(root)]);
      const node = first as Object3D;
      kinematic(node, node.userData.realvirtual as Record<string, unknown>, session.ctx);
      reparented.push(...session.reparented);
    }
  }

  root.traverse((n) => { registry.registerNode(NodeRegistry.computeNodePath(n), n); });
  if (opts.loaderPrepare) {
    // `initSubtree` step 2: the dedup aliases (computed on the final tree) …
    forEachNodeAlias(renamed, (node, _current, aliasPaths) => {
      for (const p of aliasPaths) registry.registerAlias(p, node);
    });
    // … step 2b: the asset alias table's re-parent entries (`subtree: true`): the moved
    // node's authored path as an alias, and as a prefix alias for the moved subtree.
    for (const { node, previousPath } of reparented) {
      if (previousPath === '') continue;
      registry.registerAlias(previousPath, node);
      if (opts.prefixAliases !== false) registry.registerPrefixAlias(previousPath, node);
    }
  }
  registry.registerScopeNames(root, []);
  // `loadGLB` Phase 4: the main model's own nodes under occurrence '' — stopping at
  // reference nodes, whose content is another occurrence (pending until placed).
  if (opts.identity) registry.registerDocument(root, '', null);
  return { registry, root, byIndex, reparented, renamed };
}
