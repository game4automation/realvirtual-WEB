// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

const MATERIAL_FLOW_TYPES = [
  'Station',
  'Storage',
  'Downtime',
  'Processing',
  'PalletSource',
  'IndexingConveyor',
  'RobotHandling',
  'PathTransport',
] as const;

function makeHost(): BindContextHost {
  const values = new Map<string, boolean | number>();
  return {
    signalStore: {
      get: (name: string) => values.get(name),
      set: (name: string, value: boolean | number) => values.set(name, value),
      subscribe: () => () => {},
    } as never,
    on: () => () => {},
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
    getPlugin: () => undefined,
  } as BindContextHost;
}

describe('DES registration and planner authoring', () => {
  it('registers every DES material-flow definition when DESPlugin loads', async () => {
    vi.resetModules();
    const registry = await import('../../src/core/material-flow/registry');
    registry._resetMaterialFlowRegistry();

    await import('@rv-private/plugins/des/des-plugin');

    for (const type of MATERIAL_FLOW_TYPES) {
      expect(registry.getMaterialFlow(type), `${type} is registered`).toBeDefined();
    }
  });

  it('round-trips virtual catalog nodes and binds the authored DES components', async () => {
    vi.resetModules();
    await import('@rv-private/plugins/des/des-plugin');
    const { DESHMIPlugin } = await import('@rv-private/plugins/des/hmi/des-hmi-plugin');
    const { LayoutStore, normalizeCatalogEntry } = await import(
      '../../src/plugins/layout-planner/rv-layout-store'
    );
    const { buildVirtualNode } = await import('../../src/plugins/layout-planner/ghost-manager');
    const { pathFromNode } = await import('../../src/core/engine/rv-path');
    const { DESRunner } = await import('@rv-private/plugins/des/des-runner');
    const { bindSceneToRunner } = await import('@rv-private/plugins/des/des-scene-binding');

    const store = new LayoutStore();
    // The catalog registers only while the DES mode is ACTIVE — it no longer
    // auto-loads into every session — so the host has to say the mode is on.
    new DESHMIPlugin().ensureViewer({
      getPlugin: (id: string) => id === 'layout-planner' ? { store } : null,
      modes: { activeMode: 'des' },
    } as never);
    const catalog = store.getSnapshot().catalogs.get('des-components');
    expect(catalog).toBeDefined();

    const legacyVirtual = normalizeCatalogEntry({
      id: 'legacy', name: 'Legacy', category: 'des', virtual: true,
      desType: 'DESSink', desConfig: {}, gizmoSize: [500, 500, 500],
    }, 'virtual:des/');
    expect('virtualPorts' in legacyVirtual).toBe(false);
    expect('virtualChildren' in legacyVirtual).toBe(false);

    const authoredTypes = ['PalletSource', 'IndexingConveyor', 'RobotHandling', 'PathTransport'];
    const authoredEntries = catalog!.entries.filter((entry) => authoredTypes.includes(entry.desType ?? ''));
    expect(authoredEntries.map((entry) => entry.desType)).toEqual(authoredTypes);

    const scene = new Object3D();
    for (const entry of authoredEntries) {
      const reloaded = normalizeCatalogEntry(JSON.parse(JSON.stringify(entry)), 'virtual:des/');
      expect(reloaded.virtualPorts).toEqual(entry.virtualPorts);
      expect(reloaded.virtualChildren).toEqual(entry.virtualChildren);

      const node = await buildVirtualNode(reloaded);
      node.userData.realvirtual.LayoutObject = { catalogId: reloaded.id };
      scene.add(node);

      for (const port of reloaded.virtualPorts ?? []) {
        expect(node.getObjectByName(`Snap-${port.name}`), `${entry.name}: ${port.name}`).toBeDefined();
      }
      for (const child of reloaded.virtualChildren ?? []) {
        expect(node.getObjectByName(child.name), `${entry.name}: ${child.name}`).toBeDefined();
      }
    }

    const indexing = scene.getObjectByName('Indexing Conveyor')!;
    expect(indexing.children.filter((child) => /^Carrier-\d+$/.test(child.name))).toHaveLength(4);
    expect(scene.getObjectByName('Robot Handling')!.getObjectByName('Snap-ZP-des-empty')).toBeDefined();

    const pathNode = scene.getObjectByName('Path Transport')!.getObjectByName('Path-1')!;
    const path = pathFromNode(pathNode);
    expect(path).not.toBeNull();
    expect(path!.length).toBeCloseTo(2);

    const runner = new DESRunner({ subMode: 'animated' });
    expect(bindSceneToRunner(runner, scene, makeHost())).toBe(4);
    expect(runner.liveInstances.map((instance) => instance.def.type)).toEqual(authoredTypes);
  });
});
