// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * collider-authoring.test.ts — plan-525 T1: `BoxCollider` is authorable.
 *
 *  - listed as authorable (`web_component_schema` / Add Component / Quick Edit);
 *  - a bare add persists a box the ONE physics parser accepts (explicit
 *    defaults — the rv-ODT `$def` has none) and builds the live instance + gizmo;
 *  - on a mesh node the box lands on a new empty child `Collider`, in ONE undo step;
 *  - a second box on the same node is refused (rule path AND the
 *    `editor.addComponent` command behind `web_editor_add_component`), with no
 *    partial change;
 *  - the Quick Edit rows show mm and write metres; undo / redo.
 *
 * PRIVATE-DEPENDENT (the add rules live with the asset editor, plan-434):
 * listed in `tests/private-dependent-tests.json`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { createElement, type ComponentType } from 'react';
import { Object3D } from 'three';
import { makeAuthoringRig, rvOf, type AuthoringRig } from './helpers/collider-authoring-rig';
import { listComponentTypes } from '../src/core/engine/rv-component-schema-info';
import { getCapabilities } from '../src/core/engine/rv-component-registry';
import { getColliderExtrasFrom } from '../src/core/engine/rv-collider-extras';
import { RVBoxCollider } from '../src/core/engine/rv-box-collider';
import { fieldRendererRegistry, type FieldRendererProps } from '../src/core/hmi/rv-field-renderer-registry';
import {
  isThinBoxMm, metresToMm, mmToMetres,
} from '../src/core/hmi/rv-box-collider-field-renderer';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import type { CommandContext } from '../src/core/hmi/rv-command-registry';
import {
  addColliderAwareComponent, colliderAddRefusal, ERR_HAS_BOX_COLLIDER,
} from '@rv-private/plugins/asset-editor/collider-add-rules';
import { impls } from '@rv-private/plugins/asset-editor/editor-commands';

interface AddImpl {
  enabled(ctx: CommandContext, args: { path: string; type: string; propsJson?: string | null }): unknown;
}

const rigs: AuthoringRig[] = [];
function rig(): AuthoringRig {
  const r = makeAuthoringRig();
  rigs.push(r);
  return r;
}
afterEach(() => {
  cleanup();
  setActiveEditTarget(null);
  for (const r of rigs.splice(0)) r.dispose();
});

function commandCtx(r: AuthoringRig): CommandContext {
  return { doc: r.doc, viewer: r.viewer, selection: [] } as unknown as CommandContext;
}

describe('BoxCollider authoring (plan-525 T1)', () => {
  it('is listed as authorable, and so is WebPhysicsZone', () => {
    const types = listComponentTypes().map((s) => s.type);
    expect(types).toContain('BoxCollider');
    expect(types).toContain('WebPhysicsZone');
    expect(getCapabilities('BoxCollider').authorable).toBe(true);
    expect(getCapabilities('WebPhysicsZone').authorable).toBe(true);
    // Still a pure annotation for the destructive bake (no Bake change).
    expect(getCapabilities('BoxCollider').claimsNode).toBe(false);
  });

  it('a bare add persists valid extras the physics parser accepts, and builds the live instance', async () => {
    const r = rig();
    const plate = r.addNode('Plate');
    const res = await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Plate', 'BoxCollider');
    expect(res.path).toBe('Asset/Plate');
    expect(rvOf(plate).BoxCollider).toEqual({ center: { x: 0, y: 0, z: 0 }, size: { x: 0.1, y: 0.1, z: 0.1 } });
    const boxes = getColliderExtrasFrom(rvOf(plate));
    expect(boxes).toHaveLength(1);
    expect(boxes[0].kind).toBe('box');
    const live = r.registry.getByPath<RVBoxCollider>('BoxCollider', 'Asset/Plate');
    expect(live).toBeInstanceOf(RVBoxCollider);
    expect(live!.size.x).toBeCloseTo(0.1, 9);
    // Editor add path (runtime construction) → gizmo under the node, never pickable.
    expect(live!.gizmo.edges).not.toBeNull();
    expect(plate.children.some((c) => c.userData._rvGizmo === true)).toBe(true);
    expect(r.doc.document.opCount).toBe(1);
  });

  it('on a mesh node creates a child "Collider" node in ONE undo step', async () => {
    const r = rig();
    const housing = r.addNode('Housing', { mesh: true });
    const res = await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Housing', 'BoxCollider');
    expect(res.path).toBe('Asset/Housing/Collider');
    const child = r.registry.getNode('Asset/Housing/Collider');
    expect(child).not.toBeNull();
    expect((child as Object3D & { isMesh?: boolean }).isMesh).not.toBe(true);
    expect(child!.position.lengthSq()).toBe(0); // identity transform
    expect(rvOf(child).BoxCollider).toBeTruthy();
    expect(rvOf(housing).BoxCollider).toBeUndefined();
    expect(r.primaryPath).toBe('Asset/Housing/Collider');
    expect(r.doc.document.opCount).toBe(1); // node + component = ONE unit

    await r.doc.undo();
    expect(housing.children.some((c) => c.name === 'Collider')).toBe(false);
    expect(r.doc.document.opCount).toBe(0);
  });

  it('refuses a second BoxCollider on the same node (rule path + editor.addComponent), no partial change', async () => {
    const r = rig();
    const plate = r.addNode('Plate');
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Plate', 'BoxCollider');
    expect(r.doc.document.opCount).toBe(1);
    const before = JSON.stringify(rvOf(plate));

    expect(colliderAddRefusal(plate, 'BoxCollider')).toBe(ERR_HAS_BOX_COLLIDER);
    await expect(addColliderAwareComponent(r.viewer, r.doc, 'Asset/Plate', 'BoxCollider'))
      .rejects.toThrow(ERR_HAS_BOX_COLLIDER);
    // web_editor_add_component runs editor.addComponent — the same refusal.
    const add = impls['editor.addComponent'] as unknown as AddImpl;
    expect(add.enabled(commandCtx(r), { path: 'Asset/Plate', type: 'BoxCollider' }))
      .toEqual({ reason: ERR_HAS_BOX_COLLIDER });
    expect(JSON.stringify(rvOf(plate))).toBe(before);
    expect(r.doc.document.opCount).toBe(1);

    // A Unity `colliders[]` box counts as the node's one box, too.
    const unity = r.addNode('UnityWall', {
      extras: { colliders: [{ type: 'BoxCollider', center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }] },
    });
    expect(colliderAddRefusal(unity, 'BoxCollider')).toBe(ERR_HAS_BOX_COLLIDER);
  });

  it('Quick Edit rows show mm and write metres; setField undo / redo reach the live instance', async () => {
    const r = rig();
    r.addNode('Wall');
    await addColliderAwareComponent(r.viewer, r.doc, 'Asset/Wall', 'BoxCollider');

    // Pure conversions (no float noise in either direction).
    expect(metresToMm({ x: 0.18, y: 0.004, z: 0.075 })).toEqual({ x: 180, y: 4, z: 75 });
    expect(mmToMetres({ x: 180, y: 4, z: 75 })).toEqual({ x: 0.18, y: 0.004, z: 0.075 });
    expect(isThinBoxMm({ x: 180, y: 4, z: 75 })).toBe(false);
    expect(isThinBoxMm({ x: 180, y: 2.5, z: 75 })).toBe(true);

    // The registered size row, writing through the active edit target (the
    // asset document, exactly like the editor installs it).
    const recorded: unknown[] = [];
    const target: EditTarget = {
      available: true,
      setField: (p, c, f, v, prev) => { recorded.push(v); r.doc.setField(p, c, f, v, prev); },
      unsetField: () => {},
      withTransaction: (l, fn) => r.doc.withTransaction(l, fn),
    };
    setActiveEditTarget(target);
    const Row = fieldRendererRegistry.getRenderer('BoxCollider', 'size') as ComponentType<FieldRendererProps>;
    expect(Row).toBeTruthy();
    const node = r.registry.getNode('Asset/Wall')!;
    const props = (): FieldRendererProps => ({
      value: rvOf(node).BoxCollider.size, fieldName: 'size', componentType: 'BoxCollider',
      nodePath: 'Asset/Wall', viewer: null, signalStore: null,
    });
    render(createElement(Row, props()));
    const y = screen.getByLabelText('y value') as HTMLInputElement;
    expect(y.value).toBe('100'); // 0.1 m shown as mm
    fireEvent.change(y, { target: { value: '2' } });
    fireEvent.blur(y);
    await r.doc.whenIdle();
    expect(recorded).toEqual([{ x: 0.1, y: 0.002, z: 0.1 }]);
    expect(rvOf(node).BoxCollider.size).toEqual({ x: 0.1, y: 0.002, z: 0.1 });
    const live = r.registry.getByPath<RVBoxCollider>('BoxCollider', 'Asset/Wall')!;
    expect(live.size.y).toBeCloseTo(0.002, 9);
    expect(live.isThin).toBe(true);
    // The thin-wall warning is shown for the stored value.
    cleanup();
    render(createElement(Row, props()));
    expect(screen.getByTestId('box-collider-thin-warning')).toBeTruthy();

    await r.doc.undo();
    expect(rvOf(node).BoxCollider.size).toEqual({ x: 0.1, y: 0.1, z: 0.1 });
    expect(live.size.y).toBeCloseTo(0.1, 9);
    await r.doc.redo();
    expect(rvOf(node).BoxCollider.size).toEqual({ x: 0.1, y: 0.002, z: 0.1 });
    expect(live.size.y).toBeCloseTo(0.002, 9);
  });
});
