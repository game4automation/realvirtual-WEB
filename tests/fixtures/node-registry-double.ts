// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The `viewer.registry` slice any fake viewer needs — the second incident of
 * the stale-double class, after `mode-manager-double.ts`.
 *
 * `RVViewer.registry` is a `NodeRegistry` constructed with the viewer, so a
 * double without it is not a smaller viewer — it is an impossible one. Four
 * suites (`rv-scene-store`, `rv-scene-transient`, `workspace-default-boot`,
 * `open-paths-characterization`) each carried the SAME two-member literal
 * inline:
 *
 *     registry: { getGltfNodeNames: () => [], getGltfNodeIndex: () => -1 }
 *
 * copied from one to the next. That literal was complete while only the bake
 * reached the registry. It stopped being complete when `SceneStore` grew an op
 * guard that resolves a path before it will accept a structural op:
 *
 *     const locate = (path: string) => viewer.registry?.getNode(path) ?? …
 *
 * The `?.` there guards a MISSING registry, not an incomplete one, so all four
 * suites went red at once with `viewer.registry?.getNode is not a function` —
 * far from any test that was about node lookup. Exactly the failure mode the
 * ModeManager double was built to end, in a second place.
 *
 * ## Why most members throw
 *
 * The measured surface is every `viewer.registry?.<member>` hit in this `src`
 * and the sibling private checkout's `src` — 29 members today, all of which
 * really are declared on `NodeRegistry`
 * (`tests/node-registry-double-surface.node.test.ts` enforces both halves).
 *
 * Only the three members the four suites' paths actually take are modelled. A
 * neutral stub for the rest is not protection: it would let a future test walk
 * a path the real registry never would — `registerNode`, `unregisterSubtree`
 * and `recomputePathsForSubtrees` all mutate real state and real path strings —
 * and stay green on an answer nobody authored. A throwing stub makes that path
 * loudly red and forces the behaviour to be modelled deliberately. The surface
 * invariant checks PRESENCE only and never invokes a member, so throwing stubs
 * satisfy it.
 */
import type { Object3D } from 'three';

function notModelled(member: string): never {
  throw new Error(
    `node-registry-double: ${member} is not modelled — model it deliberately (plan-900 A2)`,
  );
}

export interface NodeRegistryDoubleOptions {
  /**
   * Paths the double resolves. Everything else answers `null`, which is what
   * the real `getNode()` does for an unknown path — so the op guard that
   * triggered this fixture takes its "no such node" branch rather than
   * throwing, and a test that wants a hit can seed one.
   */
  nodes?: Map<string, Object3D> | Record<string, Object3D>;
  /** What the bake resolves authored names against. Empty = resolve nothing. */
  gltfNodeNames?: string[];
}

export function nodeRegistryDouble(options: NodeRegistryDoubleOptions = {}) {
  const nodes = options.nodes instanceof Map
    ? options.nodes
    : new Map<string, Object3D>(Object.entries(options.nodes ?? {}));
  const gltfNodeNames = options.gltfNodeNames ?? [];

  return {
    // ── Modelled: the three members the suites' paths really take ──
    getNode: (path: string): Object3D | null => nodes.get(path) ?? null,
    // The bake needs names to resolve against; `_bakeCurrent` returns null
    // without a registry at all, so the empty list is the "resolve nothing"
    // answer rather than a missing one.
    getGltfNodeNames: (): string[] => [...gltfNodeNames],
    getGltfNodeIndex: (path: string): number => gltfNodeNames.indexOf(path),

    // ── Not modelled: present so the gap is loud, never silently undefined ──
    getPathForNode: (_node: Object3D): string | null => notModelled('getPathForNode'),
    getByPath: (_path: string): never => notModelled('getByPath'),
    getAll: (): never => notModelled('getAll'),
    findInParent: (): never => notModelled('findInParent'),
    findInChildren: (): never => notModelled('findInChildren'),
    findAllInChildren: (): never => notModelled('findAllInChildren'),
    findNodeForUser: (): never => notModelled('findNodeForUser'),
    forEachNode: (): never => notModelled('forEachNode'),
    size: (): never => notModelled('size'),
    scopeFor: (): never => notModelled('scopeFor'),
    enclosingScope: (): never => notModelled('enclosingScope'),
    registerNode: (): never => notModelled('registerNode'),
    registerOccurrence: (): never => notModelled('registerOccurrence'),
    registerSubtreeIds: (): never => notModelled('registerSubtreeIds'),
    registerNodeIdInParentDocument: (): never => notModelled('registerNodeIdInParentDocument'),
    unregisterSubtree: (): never => notModelled('unregisterSubtree'),
    unregisterComponent: (): never => notModelled('unregisterComponent'),
    recomputePathsForSubtrees: (): never => notModelled('recomputePathsForSubtrees'),
    getComponentTypes: (): never => notModelled('getComponentTypes'),
    getComponentsAt: (): never => notModelled('getComponentsAt'),
    getComponentsForSignal: (): never => notModelled('getComponentsForSignal'),
    getAddressForNode: (): never => notModelled('getAddressForNode'),
    resolveAddressIn: (): never => notModelled('resolveAddressIn'),
    getReferencesTo: (): never => notModelled('getReferencesTo'),
    identityProblemsOf: (): never => notModelled('identityProblemsOf'),
    dropPendingRefs: (): never => notModelled('dropPendingRefs'),
    captureGltfProvenance: (): never => notModelled('captureGltfProvenance'),
    restoreGltfProvenance: (): never => notModelled('restoreGltfProvenance'),
  };
}
