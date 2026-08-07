// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for attachAasLink (runtime drive-datasheet attach) and the documentation-
 * mode gating of the registered 'aas' tooltip data resolver.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';
import { attachAasLink, SEW_DRIVE_AAS, isDriveDatasheetNode } from '../src/behaviors/_shared/aas-link';
// Side-effect import registers the real 'aas' data resolver; also pull the
// documentation-mode motor-bbox hover resolver for direct testing.
import { findGatedAasAtPoint } from '../src/plugins/aas-link-plugin';
import { AAS_RESOLUTION_KEY, type AasResolution } from '../src/plugins/aas-resolution';
import { tooltipRegistry } from '../src/core/hmi/tooltip/tooltip-registry';

/** Since plan-373 an AAS surface only shows for a node the index could resolve. */
function withResolution(node: Object3D, resolution: AasResolution = 'resolved'): Object3D {
  node.userData[AAS_RESOLUTION_KEY] = resolution;
  return node;
}

describe('attachAasLink', () => {
  it('writes the standard AAS representation + gated flag', () => {
    const node = new Object3D();
    attachAasLink(node, SEW_DRIVE_AAS.aasId, SEW_DRIVE_AAS.description);

    const rv = node.userData.realvirtual as Record<string, unknown>;
    expect(rv.AASLink).toEqual({ AASId: SEW_DRIVE_AAS.aasId, Description: SEW_DRIVE_AAS.description });
    expect(node.userData._rvAasLink).toEqual({
      aasId: SEW_DRIVE_AAS.aasId,
      description: SEW_DRIVE_AAS.description,
      serverUrl: '',
      gated: true,
    });
  });

  it('marks the node pending so no AAS surface shows before the index answered', () => {
    const node = new Object3D();
    attachAasLink(node, SEW_DRIVE_AAS.aasId, SEW_DRIVE_AAS.description);
    expect(node.userData[AAS_RESOLUTION_KEY]).toBe('pending');
  });

  it('is a no-op for a null node', () => {
    expect(() => attachAasLink(null, 'x', 'y')).not.toThrow();
  });

  it('does not overwrite an existing / authored AAS link', () => {
    const node = new Object3D();
    node.userData._rvAasLink = { aasId: 'authored', description: 'Authored' };
    attachAasLink(node, SEW_DRIVE_AAS.aasId, SEW_DRIVE_AAS.description);
    expect((node.userData._rvAasLink as { aasId: string }).aasId).toBe('authored');
  });

  it('does not overwrite an existing realvirtual.AASLink marker', () => {
    const node = new Object3D();
    node.userData.realvirtual = { AASLink: { AASId: 'authored', Description: 'A' } };
    attachAasLink(node, SEW_DRIVE_AAS.aasId, SEW_DRIVE_AAS.description);
    expect((node.userData.realvirtual.AASLink as { AASId: string }).AASId).toBe('authored');
    expect(node.userData._rvAasLink).toBeUndefined();
  });

  it('preserves existing realvirtual keys and _rvType', () => {
    const node = new Object3D();
    node.userData.realvirtual = { LayoutObject: { id: 1 } };
    node.userData._rvType = 'Drive';
    attachAasLink(node, SEW_DRIVE_AAS.aasId, SEW_DRIVE_AAS.description);
    expect(node.userData.realvirtual.LayoutObject).toEqual({ id: 1 });
    expect(node.userData.realvirtual.AASLink).toBeDefined();
    expect(node.userData._rvType).toBe('Drive'); // not clobbered to 'AASLink'
  });
});

describe('aas resolver documentation-mode gating', () => {
  const resolver = tooltipRegistry.getDataResolver('aas');

  function nodeWith(aas: Record<string, unknown>, resolution: AasResolution = 'resolved'): Object3D {
    const n = new Object3D();
    n.userData._rvAasLink = aas;
    return withResolution(n, resolution);
  }
  function viewerWith(hideDriveDocs: boolean | undefined): any {
    return { getPlugin: (id: string) => (id === 'layout-planner' && hideDriveDocs !== undefined ? { hideDriveDocs } : undefined) };
  }

  it('is registered', () => {
    expect(resolver).toBeTruthy();
  });

  it('hides a gated link when the planner suppresses drive docs', () => {
    const node = nodeWith({ aasId: 'urn:sew', description: 'SEW', gated: true });
    expect(resolver!(node, viewerWith(true))).toBeNull();
  });

  it('shows a gated link when the planner allows drive docs (doc mode on)', () => {
    const node = nodeWith({ aasId: 'urn:sew', description: 'SEW', gated: true });
    expect(resolver!(node, viewerWith(false))).toMatchObject({ type: 'aas', aasId: 'urn:sew' });
  });

  it('shows a gated link when no planner is active (other viewing modes)', () => {
    const node = nodeWith({ aasId: 'urn:sew', description: 'SEW', gated: true });
    expect(resolver!(node, viewerWith(undefined))).toMatchObject({ type: 'aas', aasId: 'urn:sew' });
  });

  it('always shows an authored (non-gated) link, even when the planner suppresses', () => {
    const node = nodeWith({ aasId: 'urn:festo', description: 'Festo' });
    expect(resolver!(node, viewerWith(true))).toMatchObject({ type: 'aas', aasId: 'urn:festo' });
  });
});

describe('isDriveDatasheetNode (GLB-First name contract)', () => {
  it('matches motor/antrieb and library drive meshes', () => {
    for (const n of ['Motor', 'Motor_2', 'Antrieb', 'DriveMesh', 'DriveRotate', 'DriveRolls']) {
      expect(isDriveDatasheetNode(n), n).toBe(true);
    }
  });

  it('does NOT match the Drive-Lin/Rot logic nodes (they contain the belt) or plain parts', () => {
    for (const n of ['Drive-Rot-Y', 'Drive-Lin-Y', 'Drive-Rot-X', 'Transport-Z', 'Belt', 'BeltSurfaceTop', 'ConveyorEntry1', 'Base', 'Sensor', 'Roll']) {
      expect(isDriveDatasheetNode(n), n).toBe(false);
    }
  });
});

describe('findGatedAasAtPoint (planner doc-mode motor bbox)', () => {
  function gatedDriveAt(x: number): Object3D {
    const node = new Object3D();
    node.userData._rvAasLink = { aasId: 'urn:sew', description: 'SEW', gated: true };
    node.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
    node.position.set(x, 0, 0);
    return withResolution(node);
  }

  function buildScene(): { root: Object3D; drive: Object3D } {
    const root = new Object3D();
    const drive = gatedDriveAt(10);            // gated motor box spans x ∈ [9,11]
    const frame = new Object3D();              // non-gated geometry elsewhere
    frame.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
    frame.position.set(-10, 0, 0);             // spans x ∈ [-11,-9]
    root.add(drive, frame);
    root.updateMatrixWorld(true);
    return { root, drive };
  }

  it('returns the gated drive when the hit point is inside its world bbox (motor)', () => {
    const { root, drive } = buildScene();
    expect(findGatedAasAtPoint(root, new Vector3(10, 0, 0))).toBe(drive);
  });

  it('returns null when the hit point is on non-gated geometry (e.g. the frame)', () => {
    const { root } = buildScene();
    expect(findGatedAasAtPoint(root, new Vector3(-10, 0, 0))).toBeNull();
  });

  it('returns null when the hit point is outside every gated bbox', () => {
    const { root } = buildScene();
    expect(findGatedAasAtPoint(root, new Vector3(50, 0, 0))).toBeNull();
  });
});
