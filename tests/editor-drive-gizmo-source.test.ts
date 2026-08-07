// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-drive-gizmo-source — the authoring adapter that lets the drive-axis
 * gizmo render in editor mode from rv_extras Drive config (no live RVDrive).
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Quaternion, Euler } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { MM_TO_METERS } from '../src/core/engine/rv-constants';
import { resolveEditorDriveGizmoSource } from '../src/plugins/asset-editor/editor-drive-gizmo-source';

function viewerWith(nodes: Record<string, Object3D>): RVViewer {
  return { registry: { getNode: (p: string) => nodes[p] ?? null } } as unknown as RVViewer;
}

function nodeWithDrive(cfg: Record<string, unknown> | null): Object3D {
  const node = new Object3D();
  node.name = 'Axis';
  if (cfg) node.userData['realvirtual'] = { Drive: cfg };
  return node;
}

describe('resolveEditorDriveGizmoSource', () => {
  it('returns null when the node has no Drive component', () => {
    const node = nodeWithDrive(null);
    expect(resolveEditorDriveGizmoSource(viewerWith({ 'A': node }), 'A')).toBeNull();
    expect(resolveEditorDriveGizmoSource(viewerWith({ 'A': node }), 'Missing')).toBeNull();
  });

  it('derives a LINEAR axis / limits / offset from the config', () => {
    const node = nodeWithDrive({ Direction: 'LinearZ', UseLimits: true, LowerLimit: -50, UpperLimit: 120, Offset: 7 });
    const src = resolveEditorDriveGizmoSource(viewerWith({ 'A': node }), 'A')!;
    expect(src).not.toBeNull();
    expect(src.isRotary).toBe(false);
    expect(src.getAxis(new Vector3()).toArray()).toEqual([0, 0, 1]);
    expect(src.UseLimits).toBe(true);
    expect(src.LowerLimit).toBe(-50);
    expect(src.UpperLimit).toBe(120);
    expect(src.Offset).toBe(7);
    expect(src.positionToLocalOffset(1000)).toBeCloseTo(1000 / MM_TO_METERS, 6);
    // No motion in the editor.
    expect(src.isRunning).toBe(false);
    expect(src.jogForward).toBe(false);
  });

  it('applies ReverseDirection to the axis', () => {
    const node = nodeWithDrive({ Direction: 'LinearZ', ReverseDirection: true });
    const src = resolveEditorDriveGizmoSource(viewerWith({ 'A': node }), 'A')!;
    expect(src.getAxis(new Vector3()).toArray().map(v => v + 0)).toEqual([0, 0, -1]);
  });

  it('reports ROTARY drives and the rotary glТF axis', () => {
    const node = nodeWithDrive({ Direction: 'RotationY' });
    const src = resolveEditorDriveGizmoSource(viewerWith({ 'A': node }), 'A')!;
    expect(src.isRotary).toBe(true);
    expect(src.getAxis(new Vector3()).toArray()).toEqual([0, -1, 0]);
  });

  it('home orientation follows the authored node quaternion', () => {
    const node = nodeWithDrive({ Direction: 'RotationZ' });
    node.quaternion.setFromEuler(new Euler(0, Math.PI / 2, 0));
    const src = resolveEditorDriveGizmoSource(viewerWith({ 'A': node }), 'A')!;
    const q = src.getHomeLocalQuaternion(new Quaternion());
    expect(Math.abs(q.dot(node.quaternion))).toBeCloseTo(1, 6);
  });

  it('reads config LIVE — Direction edits change the axis without rebuilding the source', () => {
    const node = nodeWithDrive({ Direction: 'LinearX' });
    const src = resolveEditorDriveGizmoSource(viewerWith({ 'A': node }), 'A')!;
    expect(src.getAxis(new Vector3()).toArray()).toEqual([-1, 0, 0]);
    // Live edit the authored config.
    (node.userData['realvirtual'] as Record<string, unknown>)['Drive'] = { Direction: 'LinearY' };
    expect(src.getAxis(new Vector3()).toArray()).toEqual([0, 1, 0]);
    expect(src.isRotary).toBe(false);
  });

  it('returns a zero axis (gizmo hides) for Virtual drives and when the Drive is removed', () => {
    const node = nodeWithDrive({ Direction: 'Virtual' });
    const src = resolveEditorDriveGizmoSource(viewerWith({ 'A': node }), 'A')!;
    expect(src.getAxis(new Vector3()).lengthSq()).toBe(0);
    // Remove the Drive after the source was created.
    node.userData['realvirtual'] = {};
    expect(src.getAxis(new Vector3()).lengthSq()).toBe(0);
  });

  it('matches a Drive_1 (deduped) component key', () => {
    const node = new Object3D();
    node.userData['realvirtual'] = { Group: { GroupName: 'x' }, Drive_1: { Direction: 'LinearY' } };
    const src = resolveEditorDriveGizmoSource(viewerWith({ 'A': node }), 'A')!;
    expect(src).not.toBeNull();
    expect(src.getAxis(new Vector3()).toArray()).toEqual([0, 1, 0]);
  });
});
