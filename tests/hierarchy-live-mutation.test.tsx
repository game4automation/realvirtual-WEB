// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.11 — the hierarchy follows a LIVE scene graph (R8).
 *
 * Three.js dispatches `childadded` / `childremoved` on the DIRECT parent and
 * does not bubble (Object3D.js:773-777; issue #27563 is still open), so the
 * panel subscribes per EXPANDED object. That is not an optimisation, it is the
 * only thing that works — and it is also what keeps the subscription count tied
 * to the UI state instead of to a 70k-node model.
 *
 * The churn case that motivated it: hover overlays are added and removed under
 * an expanded row EVERY frame, so the notification must be coalesced by the
 * consumer, not amplified.
 */

import { describe, it, expect, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import {
  flattenSceneRows,
  structuralListenTargets,
  subscribeStructure,
  type SceneRowContext,
} from '../src/core/hmi/hierarchy-rows';

function makeScene() {
  const scene = new Scene();
  const open = new Group(); open.name = 'Open';
  const closed = new Group(); closed.name = 'Closed';
  const closedChild = new Group(); closedChild.name = 'ClosedChild';
  closed.add(closedChild);
  scene.add(open, closed);

  const paths = new Map<Object3D, string>([
    [open, 'Open'], [closed, 'Closed'], [closed.children[0], 'Closed/ClosedChild'],
  ]);
  const ctx: SceneRowContext = {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: null,
    hideRuntime: false,
  };
  return { scene, open, closed, closedChild, ctx, paths };
}

describe('live scene mutation (§9.11)', () => {
  it('a child added under an EXPANDED row becomes a row on the next flatten', () => {
    const s = makeScene();
    const expanded = new Set([s.scene.uuid, s.open.uuid]);
    expect(flattenSceneRows(s.scene, expanded, s.ctx).map((r) => r.node.name))
      .toEqual(['Scene', 'Open', 'Closed']);

    const late = new Group(); late.name = 'Late';
    s.open.add(late);

    expect(flattenSceneRows(s.scene, expanded, s.ctx).map((r) => r.node.name))
      .toEqual(['Scene', 'Open', 'Late', 'Closed']);
  });

  it('a child removed under an EXPANDED row stops being a row', () => {
    const s = makeScene();
    const expanded = new Set([s.scene.uuid, s.closed.uuid]);
    expect(flattenSceneRows(s.scene, expanded, s.ctx).map((r) => r.node.name))
      .toContain('ClosedChild');

    s.closed.remove(s.closedChild);

    expect(flattenSceneRows(s.scene, expanded, s.ctx).map((r) => r.node.name))
      .not.toContain('ClosedChild');
  });

  it('subscribes only to the objects that are on screen, never the whole graph', () => {
    const s = makeScene();
    // Deep content nobody has opened.
    for (let i = 0; i < 100; i++) s.closedChild.add(new Group());

    const expanded = new Set([s.scene.uuid, s.open.uuid]);
    const rows = flattenSceneRows(s.scene, expanded, s.ctx);
    const targets = structuralListenTargets(rows);

    // Scene + Open + Closed — the three RENDERED rows, not the 103 objects.
    expect(targets).toEqual([s.scene, s.open, s.closed]);
    expect(targets).not.toContain(s.closedChild);
  });

  it('fires on add and remove under a listened object, and stops after unsubscribe', () => {
    const s = makeScene();
    const onChange = vi.fn();
    const unsubscribe = subscribeStructure([s.open], onChange);

    const child = new Group();
    s.open.add(child);
    expect(onChange).toHaveBeenCalledTimes(1);
    s.open.remove(child);
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    s.open.add(new Group());
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('no listener is attached under a COLLAPSED row', () => {
    const s = makeScene();
    const onChange = vi.fn();
    const expanded = new Set([s.scene.uuid]);   // nothing below the scene is open
    const rows = flattenSceneRows(s.scene, expanded, s.ctx);
    const unsubscribe = subscribeStructure(structuralListenTargets(rows), onChange);

    // Mutating INSIDE the collapsed branch changes nothing that is rendered.
    s.closedChild.add(new Group());
    expect(onChange).not.toHaveBeenCalled();

    // …while its parent row IS listened, because its caret may have to appear.
    s.closed.add(new Group());
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('per-frame overlay churn is one notification per event, for the consumer to coalesce', () => {
    // The R8 shape: an overlay added and removed under an open row 60×/s. The
    // subscription must not amplify it (one listener, two events per cycle);
    // collapsing those into one re-flatten per frame is the panel's job.
    const s = makeScene();
    const onChange = vi.fn();
    const unsubscribe = subscribeStructure([s.open], onChange);
    const overlay = new Object3D();
    for (let frame = 0; frame < 10; frame++) {
      s.open.add(overlay);
      s.open.remove(overlay);
    }
    expect(onChange).toHaveBeenCalledTimes(20);
    unsubscribe();
  });
});
