// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-755 D7 / R13 — the FROZEN set of `claimsNode: false` component types.
 *
 * Until plan-755 the survival model guessed "this type is a pure Unity export
 * marker" from `ui.hidden && bake === 'merge'` (and no factory / schema). That
 * rule is gone; `claimsNode` says it explicitly. The set below was READ from
 * the live registry on 2026-09-21 (HEAD be6ffec8, after importing the scene
 * loader so every side-effect registration ran) and is pinned here so the
 * switch from implicit to explicit changed the fate of `Group` ONLY.
 */
import { describe, it, expect } from 'vitest';
// Pull in every core component registration (side effects).
import '../src/core/engine/rv-scene-loader';
import {
  getRegisteredFactories,
  getRegisteredSchemaTypes,
  getTypesWhere,
  registerCapabilities,
  registerPreBakeHook,
  getCapabilities,
} from '../src/core/engine/rv-component-registry';

/**
 * The types that satisfied the former implicit rule. None has a factory or a
 * schema — they are extras keys the Unity exporter writes and no web component
 * consumes as a node of its own.
 *
 * ADDING A TYPE HERE (or `claimsNode: false` to its registration) MEANS: a node
 * that carries nothing but this type DISAPPEARS from every baked model — its
 * path stops resolving, it leaves the hierarchy panel and `NodeRegistry` —
 * unless something else holds it (reference target, plugin `bakeClaims()`,
 * `Snap-*`, keep mesh, ancestor of a survivor). A new hidden/merge type does
 * NOT fall under this automatically any more (plan-755 risk R13, intended):
 * the default is `claimsNode: true`, i.e. the node survives.
 */
const FORMER_IMPLICIT_EXPORT_MARKERS = [
  'BoxCollider',
  'MeshCollider',
  'RuntimeInteractable',
  'RuntimeUIWindow',
  'colliders',
  'renderer',
  'rigidbody',
] as const;

describe('claimsNode — frozen set (plan-755 D7)', () => {
  it('the types with claimsNode === false are exactly the former export markers + Group + BlockageBudget', () => {
    const actual = getTypesWhere((c) => !c.claimsNode).sort();
    // BlockageBudget (plan-2038 § 2.7): a pure declaration like Group — it must never create a
    // chunk boundary; it sits on nodes another component already claims (conveyors, stations).
    expect(actual).toEqual([...FORMER_IMPLICIT_EXPORT_MARKERS, 'Group', 'BlockageBudget'].sort());
  });

  it('the former implicit rule still describes the markers, and none of them has behaviour', () => {
    const factories = getRegisteredFactories();
    const schemas = new Set(getRegisteredSchemaTypes());
    // plan-757 Phase 2 (F15): `AssetReference` is hidden + merge like the
    // markers but CLAIMS its node explicitly — a reference node is an empty
    // survivor the instancer turns into a placement. It is the one hidden
    // type that the former implicit rule would have dropped and must not.
    // plan-525: `BoxCollider` is authorable now — visible in the inspector and
    // backed by a factory + schema — but it KEEPS `claimsNode: false` (a box
    // alone never holds a mesh node through the bake; an authored collider
    // lives on an empty node, which survives by the authored-collider rule).
    const STILL_PURE_MARKERS = FORMER_IMPLICIT_EXPORT_MARKERS.filter((t) => t !== 'BoxCollider');
    const implicit = getTypesWhere((c) => c.ui.hidden && c.bake === 'merge' && !c.claimsNode).sort();
    expect(implicit).toEqual([...STILL_PURE_MARKERS].sort());
    expect(getCapabilities('AssetReference')).toMatchObject({ claimsNode: true, ui: { hidden: true } });
    expect(getCapabilities('BoxCollider')).toMatchObject({ claimsNode: false, authorable: true, ui: { hidden: false } });
    for (const type of STILL_PURE_MARKERS) {
      expect(factories.has(type), type).toBe(false);
      expect(schemas.has(type), type).toBe(false);
    }
  });

  it('attaching a pre-bake hook later does not reset claimsNode', () => {
    registerCapabilities('Plan755Annotation', { claimsNode: false });
    registerPreBakeHook('Plan755Annotation', () => {});
    expect(getCapabilities('Plan755Annotation').claimsNode).toBe(false);
    expect(getCapabilities('Plan755Annotation').onPreBake).not.toBeNull();
    // Leave the shared registry as the other tests of this file expect it.
    registerCapabilities('Plan755Annotation', {});
  });
});
