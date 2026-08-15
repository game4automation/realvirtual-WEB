// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The end-to-end claim behind the GLB bake: a signal binding baked into the
 * file comes back on load with NO scene op log and NO localStorage.
 *
 * The chain is bake → glTF `node.extras` → three.js `userData.realvirtual` →
 * `SignalBindPlugin.onModelLoaded` → a live binding. Each link is covered
 * elsewhere; this test is the seam where they meet, which is exactly where a
 * regression would otherwise go unnoticed until a delivered file misbehaves.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { writeSettingsIntoModel } from '../src/core/hmi/scene/rv-scene-settings-into-model';
import type { RVExtrasOverlay } from '../src/core/engine/rv-extras-overlay-store';
import { gltfLoader, collectGltfNodeIndices, type GltfParserLike } from '../src/core/engine/rv-glb-parse';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { signalBindStore } from '../src/plugins/signal-bind/signal-bind-store';
import { _resetSignalLinkModeStoreForTests } from '../src/plugins/signal-bind/signal-link-mode-store';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

/** A JSON-only GLB — valid per spec, and enough for a node that carries extras. */
function makeJsonGlb(json: unknown): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const padded = (jsonBytes.byteLength + 3) & ~3;
  const out = new Uint8Array(20 + padded);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.fill(0x20, 20, 20 + padded);
  out.set(jsonBytes, 20);
  return out;
}

const SOURCE_GLB = makeJsonGlb({
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: 'Machine', children: [1], extras: { realvirtual: { Conveyor: {} } } },
    { name: 'Inner' },
  ],
});

const MAPPINGS = [{
  kind: 'mapped-signal',
  slot: 'Flow.Run',
  sourceKind: 'connect',
  signal: 'External.Run',
  interfaceId: 'mqtt-main',
  direction: 'plcInput',
  enabled: true,
}];

function overlayOf(nodes: RVExtrasOverlay['nodes']): RVExtrasOverlay {
  return { $schema: 'rv-extras-overlay/1.0', $source: 'test', nodes };
}

/** Minimal viewer harness — mirrors tests/signal-bind-plugin-lifecycle.ts. */
function makeHarness(root: Object3D, machine: Object3D) {
  const registry = new NodeRegistry();
  registry.registerNode('Machine', machine);
  const store = new SignalStore();
  store.register('Flow.Run', 'Machine/Signals/Flow.Run', false, 'PLCInputBool');
  store.register('External.Run', 'Connect/External.Run', true, 'PLCInputBool');
  const manager = new SignalBindingManager(store, registry);
  const viewer = {
    registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    gizmoManager: {
      create: () => ({
        id: 'signal-badge', root: new Object3D(),
        update: () => {}, setVisible: () => {}, dispose: () => {},
      }),
    },
    markRenderDirty: () => {},
    getPlugin: () => undefined,
    // Real viewers always own one (rv-viewer.ts) — the plugin registers its
    // "Link signal…" tree item against it in init() (plan-418).
    contextMenu: new ContextMenuStore(),
    on: () => () => {},
  } as unknown as RVViewer;
  return { viewer, manager, result: { root } as unknown as LoadResult };
}

describe('baked signal bindings survive a reload without an op log', () => {
  beforeEach(() => {
    signalBindStore.clear();
    localStorage.clear();
    _resetSignalLinkModeStoreForTests();
  });

  it('bakes a binding, reloads the bytes, and the plugin brings it live', async () => {
    const baked = writeSettingsIntoModel(
      SOURCE_GLB,
      overlayOf({ Machine: { SignalLinks: { Mappings: MAPPINGS } } }),
      (path) => (path === 'Machine' ? 0 : null),
    );

    // Load the BAKED bytes — nothing else carries the binding from here on.
    const gltf = await gltfLoader.parseAsync(
      baked.glb.buffer.slice(baked.glb.byteOffset, baked.glb.byteOffset + baked.glb.byteLength) as ArrayBuffer,
      '',
    );
    const machine = gltf.scene.getObjectByName('Machine');
    expect(machine).toBeDefined();

    // glTF extras → three.js userData, with the pre-existing component intact.
    const rv = machine!.userData.realvirtual as Record<string, unknown>;
    expect(rv.SignalLinks).toEqual({ Mappings: MAPPINGS });
    expect(rv.Conveyor).toEqual({});

    const h = makeHarness(gltf.scene, machine!);
    const plugin = new SignalBindPlugin();
    plugin.init(h.viewer);
    // No SceneStore, no ops, no localStorage — the GLB is the only source.
    plugin.onModelLoaded(h.result, h.viewer);
    h.manager.tick(0.02);

    expect(h.manager.getElementState('Machine')).toBe('live');
    plugin.onModelCleared();
  });

  it('maps loaded nodes back to their glTF indices for the next bake', async () => {
    const gltf = await gltfLoader.parseAsync(
      SOURCE_GLB.buffer.slice(SOURCE_GLB.byteOffset, SOURCE_GLB.byteOffset + SOURCE_GLB.byteLength) as ArrayBuffer,
      '',
    );
    const parser = (gltf as unknown as { parser?: GltfParserLike }).parser;
    const indices = collectGltfNodeIndices(parser);

    expect(indices.get(gltf.scene.getObjectByName('Machine')!)).toBe(0);
    expect(indices.get(gltf.scene.getObjectByName('Inner')!)).toBe(1);
    // Round trip: bake again through the collected indices and the override
    // must land on the same node it was read from.
    const again = writeSettingsIntoModel(
      SOURCE_GLB,
      overlayOf({ Inner: { Drive: { TargetSpeed: 42 } } }),
      (path) => indices.get(gltf.scene.getObjectByName(path)!) ?? null,
    );
    const json = JSON.parse(
      new TextDecoder().decode(again.glb.subarray(20, 20 + new DataView(again.glb.buffer).getUint32(12, true))),
    ) as { nodes: { name: string; extras?: { realvirtual?: Record<string, unknown> } }[] };
    expect(json.nodes[1].name).toBe('Inner');
    expect(json.nodes[1].extras!.realvirtual!.Drive).toEqual({ TargetSpeed: 42 });
  });
});
