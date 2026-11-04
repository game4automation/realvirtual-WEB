// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AAS links come only from authored data — no name rule attaches one (the SEW
 * demo shell auto-attach was removed) — plus the documentation-mode gating of
 * the registered 'aas' tooltip data resolver.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial, Vector3, Scene, Group } from 'three';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import { buildInitContext } from '../src/core/engine/rv-init-context';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
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

describe('no name-based AAS attach (authored data only)', () => {
  function load(node: Object3D): void {
    const scene = new Scene();
    const root = new Group();
    root.add(node);
    scene.add(root);
    const transportManager = new RVTransportManager();
    transportManager.scene = scene;
    processExtras(root, buildInitContext({
      registry: new NodeRegistry(), signalStore: new SignalStore(), transportManager, scene,
    }));
  }

  it('a node named "Motor_X" gets NO AAS link without authored data', () => {
    for (const name of ['Motor_X', 'Antrieb', 'DriveMesh', 'DriveRolls']) {
      const node = new Object3D();
      node.name = name;
      node.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
      load(node);
      expect(node.userData._rvAasLink, name).toBeUndefined();
      expect((node.userData.realvirtual as Record<string, unknown> | undefined)?.AASLink, name).toBeUndefined();
      expect(node.userData[AAS_RESOLUTION_KEY], name).toBeUndefined();
    }
  });

  it('an authored AASLink on "Motor_X" is kept as authored (not gated)', () => {
    const node = new Object3D();
    node.name = 'Motor_X';
    node.userData.realvirtual = { AASLink: { AASId: 'urn:festo:motor', Description: 'Festo' } };
    load(node);
    expect(node.userData._rvAasLink).toMatchObject({ aasId: 'urn:festo:motor', description: 'Festo' });
    expect((node.userData._rvAasLink as { gated?: boolean }).gated).toBeUndefined();
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
