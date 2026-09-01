// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-reference-guard — F8: a STRUCTURAL op never reaches into a reference
 * (plan-703 Phase 7, §2.3 / §2.4).
 *
 * ## Why this is a data-model rule, not a policy
 *
 * `AssetOverrides` is an RFC-7396 merge patch over component VALUES
 * (`rv-asset-reference.ts:78-92`): componentType → fieldName → value. It has no
 * vocabulary at all for "and also add a node here", "and delete that subtree",
 * "and reparent this one". So a structural edit inside a referenced subtree
 * cannot be *written down* — it would live only in the running scene and vanish
 * on the next save, or (worse) be saved into the CHILD file and appear in every
 * other instance. The plan's Entscheidungs-Log settles it outside the grill:
 * structural overrides do not exist, and §8's research (Unity, Godot, Figma,
 * Blender) is four independent confirmations that the alternative is a trap.
 *
 * Refusing at the op is therefore the honest place: earlier and the UI cannot
 * explain itself, later and the user has already made an edit that will be lost.
 *
 * ## What IS allowed, and where it lands
 *
 * `setField` / `unsetField` on the very same node are ACCEPTED. They are the
 * Override op class of §2.3, legal in every mode except `viewer` (decision 9),
 * and at the persistence step they route into `AssetOverrides.byNodeId` of the
 * enclosing reference node — the routing `rv-scene-glb-bake.ts` already performs
 * (`makeRegistryBakeResolver` → `kind: 'referenced'`). {@link readOverride} and
 * {@link writeOverride} here are the live-tree half of the same addressing, which
 * is what the inspector's badge and its Revert read and write.
 *
 * ## `transformNode` is structural HERE and writable in the SCENE bake
 *
 * The asymmetry is deliberate (plan-444) and reading it as a bug would undo the
 * feature. Two different documents are being guarded:
 *
 *  - **The scene bake** writes the file the reference node lives in. Since
 *    plan-444 that file has a vocabulary for a foreign node's transform —
 *    `AssetOverrides.trsByNodeId`, a sibling of `byNodeId` — so a part moved
 *    after a CAD import is saved as an override instead of refused. That is F3,
 *    and it is the whole point of the plan.
 *  - **This guard** protects the ASSET EDITOR's op log, which edits one asset
 *    document at a time. There the reference in question is an INNER one, so
 *    the patch would have to be written into a file that is itself referenced —
 *    the case `ReferencedFileWriteError` refuses and plan-444 explicitly left
 *    refused (F5). `transformNode` therefore stays in the structural set.
 *
 * The general sentence above ("structural overrides do not exist") still holds
 * for every other kind in the list: none of them has a vocabulary in the
 * override schema, and `transformNode` now has one only at the outermost level.
 *
 * Pure module: no Three.js beyond the `Object3D` type, no registry, no storage.
 */

import type { Object3D } from 'three';
import type { RvOp, RvOpKind } from './rv-unified-ops';
import {
  getAssetOverrides,
  setAssetOverrides,
  type ComponentPatch,
} from '../engine/rv-asset-reference';
import { outermostReference } from '../engine/rv-reference-scope';
import { getNodeId } from '../engine/rv-node-id';

// ─── Structural vs. value ───────────────────────────────────────────────

/**
 * The op kinds that change the SHAPE of the tree or a node's identity.
 *
 * `renameNode` is in the list and it is worth saying why: a rename changes the
 * path every sibling document resolves against, so it is structural even though
 * it moves no geometry. `setNodeVisible` is also in it — an authored visibility
 * flag is written into the node's extras in the child file, not into the
 * override patch, so hiding a part "in this instance only" is not expressible
 * either.
 *
 * `setMaterial` is structural for the same reason: it rewrites the mesh's
 * material assignment in the file, and `AssetOverrides` patches components, not
 * materials.
 *
 * `transformNode` stays here even though the SCENE bake can now write a
 * transform override — see the module doc's "asymmetry" section for why the two
 * verdicts are about two different documents.
 */
export const RV_STRUCTURAL_OP_KINDS: ReadonlySet<RvOpKind> = new Set<RvOpKind>([
  'addNode',
  'removeNode',
  'createNode',
  'deleteNode',
  'reparentNode',
  'renameNode',
  'addComponent',
  'removeComponent',
  'setNodeVisible',
  'setMaterial',
  'separateMesh',
  'mergeMesh',
  'importCad',
  'transformNode',
]);

/**
 * Ops that patch a component VALUE, which is exactly what an override can carry.
 *
 * Deliberately a closed list of two rather than "everything not structural":
 * a kind added later must be classified on purpose, and the default for an
 * unclassified kind is "refuse near a reference" (see {@link guardReferenceOp}),
 * which fails safe.
 */
export const RV_OVERRIDABLE_OP_KINDS: ReadonlySet<RvOpKind> = new Set<RvOpKind>([
  'setField',
  'unsetField',
]);

export function isStructuralOpKind(kind: RvOpKind): boolean {
  return RV_STRUCTURAL_OP_KINDS.has(kind);
}

/**
 * Every scene path an op targets.
 *
 * A composite reports the union of its children's, so a batch cannot smuggle a
 * structural edit past the guard behind one legal op.
 */
export function opTargetPaths(op: RvOp): string[] {
  switch (op.kind) {
    case 'composite':
      return op.ops.flatMap(opTargetPaths);
    case 'setMaterial':
      return [...op.nodePaths];
    case 'mergeMesh':
      return [op.rootPath, ...op.sourcePaths];
    case 'separateMesh':
      return [op.sourcePath];
    case 'importCad':
      return [op.rootPath];
    case 'reparentNode':
      return [op.nodePath, op.newParentPath, op.prevParentPath];
    default: {
      const path = (op as { nodePath?: unknown }).nodePath;
      return typeof path === 'string' ? [path] : [];
    }
  }
}

// ─── The verdict ────────────────────────────────────────────────────────

export type ReferenceGuardVerdict =
  /** Nothing the op touches lies inside a reference — ordinary content edit. */
  | { ok: true; scope: 'own-content' }
  /** Inside a reference, and the op is one an override can express. */
  | { ok: true; scope: 'override'; referenceNode: Object3D; nodePath: string }
  | {
      ok: false;
      reason: 'structural-in-reference' | 'unclassified-in-reference';
      /** The reference the op would have reached into. */
      referenceNode: Object3D;
      nodePath: string;
      message: string;
    };

/**
 * May `op` be applied?
 *
 * `locate` maps a scene path to `{ node, reference }`, where `reference` is the
 * outermost enclosing reference node or null. It is injected rather than taken
 * from a registry so this stays pure — and so the test can build the situation
 * out of three plain `Object3D`s.
 *
 * The FIRST refusal wins and is reported with its own path, because a composite
 * that half-applies is worse than one that does not apply at all.
 */
export function guardReferenceOp(
  op: RvOp,
  locate: (nodePath: string) => { reference: Object3D | null } | null,
): ReferenceGuardVerdict {
  // A composite is judged per child: its own kind says nothing about what it
  // carries, and its `kind` is in neither list.
  const children: RvOp[] = op.kind === 'composite' ? op.ops : [op];

  let override: { referenceNode: Object3D; nodePath: string } | null = null;

  for (const child of children) {
    for (const nodePath of opTargetPaths(child)) {
      const reference = locate(nodePath)?.reference ?? null;
      if (!reference) continue;

      if (RV_OVERRIDABLE_OP_KINDS.has(child.kind)) {
        override ??= { referenceNode: reference, nodePath };
        continue;
      }
      const structural = isStructuralOpKind(child.kind);
      return {
        ok: false,
        reason: structural ? 'structural-in-reference' : 'unclassified-in-reference',
        referenceNode: reference,
        nodePath,
        message: structural
          ? `"${describeKind(child.kind)}" changes the structure of a referenced asset. `
            + 'Open that asset (double-click the reference) and change it there — the edit '
            + 'then applies to every instance.'
          : `"${describeKind(child.kind)}" cannot be expressed as an instance override.`,
      };
    }
  }

  return override
    ? { ok: true, scope: 'override', ...override }
    : { ok: true, scope: 'own-content' };
}

function describeKind(kind: RvOpKind): string {
  return kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

// ─── The override patch on a reference node ─────────────────────────────

/** Where an instance override for one node has to be written. */
export interface OverrideTarget {
  /** The reference node that OWNS the patch — always in the open file. */
  referenceNode: Object3D;
  /** The node's id WITHIN the referenced file — `AssetOverrides.byNodeId`'s key. */
  nodeId: string;
}

/**
 * The reference node and node id an override for `node` belongs to, or null
 * when `node` is the open file's own content.
 *
 * **Outermost**, not nearest, and that is a correctness point rather than a
 * style one: the patch is stored ON the reference node, so it has to sit in a
 * file this document can write. Only the outermost reference does — an inner
 * one lives inside the referenced asset, and writing there would change every
 * instance instead of this one. It also keeps the badge honest with the
 * selection rule (§2.4.1), which resolves to the same node.
 */
export function overrideTargetOf(
  node: Object3D,
  boundary?: Object3D | null,
): OverrideTarget | null {
  const referenceNode = outermostReference(node, boundary);
  if (!referenceNode || referenceNode === node) return null;
  const nodeId = getNodeId(node);
  return nodeId ? { referenceNode, nodeId } : null;
}

/** The patch a reference node holds for one node id, or null. */
export function readOverride(referenceNode: Object3D, nodeId: string): ComponentPatch | null {
  return getAssetOverrides(referenceNode)?.byNodeId?.[nodeId] ?? null;
}

/** Field names of `componentType` this reference node overrides for `nodeId`. */
export function overriddenFieldsOf(
  referenceNode: Object3D,
  nodeId: string,
  componentType: string,
): string[] {
  const patch = readOverride(referenceNode, nodeId)?.[componentType];
  return patch ? Object.keys(patch) : [];
}

/**
 * Write one field into `AssetOverrides.byNodeId[nodeId][componentType]`.
 *
 * `value === undefined` REMOVES the entry (a Revert); `value === null` writes a
 * literal null, which under RFC 7396 deletes the field in the referenced asset.
 * The two are different intents and must stay distinguishable — §5.4 names this
 * as the merge-patch limitation, and collapsing them here would be the first
 * place it bites.
 *
 * Empty containers are pruned on the way out so a revert leaves no husk behind:
 * an `AssetOverrides` with an empty patch would keep the badge lit at zero.
 *
 * `byPath` and `trsByNodeId` are carried through untouched. This is a
 * read-modify-write over the WHOLE component, so a block this function does not
 * know about is a block it deletes: before plan-444 added the carry for
 * `trsByNodeId`, editing any field on any node of a referenced asset would have
 * silently thrown away every part the user had moved in it.
 */
export function writeOverride(
  referenceNode: Object3D,
  nodeId: string,
  componentType: string,
  fieldName: string,
  value: unknown,
): void {
  const current = getAssetOverrides(referenceNode);
  const byNodeId: Record<string, ComponentPatch> = { ...(current?.byNodeId ?? {}) };
  const patch: ComponentPatch = { ...(byNodeId[nodeId] ?? {}) };
  const fields: Record<string, unknown> = { ...(patch[componentType] ?? {}) };

  if (value === undefined) delete fields[fieldName];
  else fields[fieldName] = value;

  if (Object.keys(fields).length === 0) delete patch[componentType];
  else patch[componentType] = fields;

  if (Object.keys(patch).length === 0) delete byNodeId[nodeId];
  else byNodeId[nodeId] = patch;

  const next = {
    byNodeId,
    ...(current?.byPath ? { byPath: current.byPath } : {}),
    ...(current?.trsByNodeId ? { trsByNodeId: current.trsByNodeId } : {}),
  };
  // `setAssetOverrides` removes the key entirely when nothing is left.
  setAssetOverrides(referenceNode, next);
}

/** Drop every override this reference holds for one component of one node. */
export function revertComponentOverride(
  referenceNode: Object3D,
  nodeId: string,
  componentType: string,
): void {
  for (const field of overriddenFieldsOf(referenceNode, nodeId, componentType)) {
    writeOverride(referenceNode, nodeId, componentType, field, undefined);
  }
}
