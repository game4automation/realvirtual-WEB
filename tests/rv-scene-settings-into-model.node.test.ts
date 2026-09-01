// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Writing a scene's overlay into the model GLB. It must agree with
 * `applyOverlayToNode` field for field — a written file that behaves differently
 * from the scene the user was just looking at is the failure worth preventing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Object3D } from 'three';
import {
  writeSettingsIntoModel, NodeNotFoundError, ModelSourceChangedError, UnrepresentableValueError,
} from '../src/core/hmi/scene/rv-scene-settings-into-model';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import { applyOverlayToNode, type RVExtrasOverlay } from '../src/core/engine/rv-extras-overlay-store';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function makeGlb(json: unknown, bin = new Uint8Array([9, 8, 7, 6])): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (jsonBytes.byteLength + 3) & ~3;
  const binPadded = (bin.byteLength + 3) & ~3;
  const out = new Uint8Array(12 + 8 + jsonPadded + 8 + binPadded);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.fill(0x20, 20, 20 + jsonPadded);
  out.set(jsonBytes, 20);
  view.setUint32(20 + jsonPadded, binPadded, true);
  view.setUint32(24 + jsonPadded, BIN_CHUNK, true);
  out.set(bin, 28 + jsonPadded);
  return out;
}

function overlayOf(nodes: RVExtrasOverlay['nodes']): RVExtrasOverlay {
  return { $schema: 'rv-extras-overlay/1.0', $source: 'test', nodes };
}

/** Write into a one-node GLB; the single node is always index 0. */
function writeSingleNode(nodeExtras: unknown, overlay: RVExtrasOverlay, sceneExtras?: unknown) {
  const source = makeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0], ...(sceneExtras ? { extras: sceneExtras } : {}) }],
    nodes: [{ name: 'Machine', ...(nodeExtras ? { extras: nodeExtras } : {}) }],
  });
  const result = writeSettingsIntoModel(source, overlay, (path) => (path === 'Machine' ? 0 : null));
  const json = parseGlbChunks(result.glb).json as {
    nodes: { extras?: { realvirtual?: Record<string, Record<string, unknown>> } }[];
    scenes: { extras?: Record<string, unknown> }[];
  };
  return { result, json, source };
}

describe('writeSettingsIntoModel', () => {
  it('writes an override into nodes[i].extras.realvirtual', () => {
    const { result, json } = writeSingleNode(
      { realvirtual: { Drive: { TargetSpeed: 100 } } },
      overlayOf({ Machine: { Drive: { TargetSpeed: 250 } } }),
    );
    expect(json.nodes[0].extras!.realvirtual!.Drive).toEqual({ TargetSpeed: 250 });
    expect(result).toMatchObject({ nodes: 1, fields: 1, signatureDropped: false });
  });

  it('creates extras, the realvirtual block and the component when the node has none', () => {
    const { json } = writeSingleNode(
      undefined,
      overlayOf({ Machine: { SignalLinks: { Mappings: [{ slot: 'Flow.Run', signal: 'External.Run' }] } } }),
    );
    expect(json.nodes[0].extras!.realvirtual!.SignalLinks).toEqual({
      Mappings: [{ slot: 'Flow.Run', signal: 'External.Run' }],
    });
  });

  it('treats null as a delete (RFC 7396) and leaves siblings alone', () => {
    const { result, json } = writeSingleNode(
      { realvirtual: { Drive: { TargetSpeed: 100, Acceleration: 50 } } },
      overlayOf({ Machine: { Drive: { TargetSpeed: null } } }),
    );
    expect(json.nodes[0].extras!.realvirtual!.Drive).toEqual({ Acceleration: 50 });
    expect(result.fields).toBe(1);
  });

  it('replaces a nested value wholesale rather than deep-merging it', () => {
    // applyOverlayToNode assigns per field. A deep merge here would leave a
    // stale `z` behind and the baked file would drift from the live scene.
    const { json } = writeSingleNode(
      { realvirtual: { Drive: { Direction: { x: 1, y: 2, z: 3 } } } },
      overlayOf({ Machine: { Drive: { Direction: { x: 9 } } } }),
    );
    expect(json.nodes[0].extras!.realvirtual!.Drive).toEqual({ Direction: { x: 9 } });
  });

  it('agrees field for field with applyOverlayToNode', () => {
    const overlay = overlayOf({
      Machine: {
        Drive: { TargetSpeed: 250, Acceleration: null },
        SignalLinks: { Mappings: [{ slot: 'Flow.Run', signal: 'External.Run', enabled: true }] },
      },
    });
    const startingExtras = { Drive: { TargetSpeed: 100, Acceleration: 50 }, Conveyor: { Width: 400 } };

    const node = new Object3D();
    node.name = 'Machine';
    node.userData.realvirtual = structuredClone(startingExtras);
    applyOverlayToNode(node, 'Machine', overlay);

    const { json } = writeSingleNode({ realvirtual: structuredClone(startingExtras) }, overlay);
    expect(json.nodes[0].extras!.realvirtual).toEqual(node.userData.realvirtual);
  });

  it('keeps a component object that the overlay emptied, exactly as the live path does', () => {
    const { json } = writeSingleNode(
      { realvirtual: { Drive: { TargetSpeed: 100 } } },
      overlayOf({ Machine: { Drive: { TargetSpeed: null } } }),
    );
    expect(json.nodes[0].extras!.realvirtual!.Drive).toEqual({});
  });

  it('drops a now-invalid rv_sig and reports it', () => {
    const { result, json } = writeSingleNode(
      undefined,
      overlayOf({ Machine: { Drive: { TargetSpeed: 1 } } }),
      { rv_sig: 'A'.repeat(86) + '==', other: 'kept' },
    );
    expect(result.signatureDropped).toBe(true);
    expect(json.scenes[0].extras).toEqual({ other: 'kept' });
  });

  describe('refuses when the fetched file is not the one the indices came from', () => {
    // The indices are captured at LOAD time; the bytes patched here are fetched
    // again later. If the URL served something else in between, index N means a
    // different node and a PLC link would land on the wrong machine part.
    const twoNodes = (names: [string, string]) => makeGlb({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
      nodes: [{ name: names[0], children: [1] }, { name: names[1] }],
    });
    const overlay = overlayOf({ Machine: { Drive: { TargetSpeed: 1 } } });

    it('accepts a file whose node names still match', () => {
      expect(() => writeSettingsIntoModel(
        twoNodes(['Machine', 'Inner']), overlay, () => 0,
        { expectedNames: ['Machine', 'Inner'] },
      )).not.toThrow();
    });

    it('rejects a renamed node at the same index', () => {
      expect(() => writeSettingsIntoModel(
        twoNodes(['Gantry', 'Inner']), overlay, () => 0,
        { expectedNames: ['Machine', 'Inner'] },
      )).toThrow(ModelSourceChangedError);
    });

    it('rejects a file with a different node count, before resolving anything', () => {
      expect(() => writeSettingsIntoModel(
        twoNodes(['Machine', 'Inner']), overlay, () => 0,
        { expectedNames: ['Machine', 'Inner', 'Extra'] },
      )).toThrow(/now has 2 nodes instead of 3/);
    });

    it('skips the check when no names were captured', () => {
      expect(() => writeSettingsIntoModel(twoNodes(['Gantry', 'Inner']), overlay, () => 0))
        .not.toThrow();
    });

    it('treats an EMPTY name list as "not captured", not as "zero nodes"', () => {
      // An empty array is truthy. Reading it as an expected node count made
      // every model without captured names fail with a bogus "the file changed".
      expect(() => writeSettingsIntoModel(
        twoNodes(['Machine', 'Inner']), overlay, () => 0, { expectedNames: [] },
      )).not.toThrow();
    });
  });

  it('refuses values JSON.stringify would silently change', () => {
    // NaN and Infinity become null; undefined disappears. Reporting success and
    // then loading a different value is worse than refusing.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(() => writeSingleNode(
        undefined, overlayOf({ Machine: { Drive: { TargetSpeed: bad } } }),
      )).toThrow(UnrepresentableValueError);
    }
    // Nested, too — and the message must point at the exact field.
    let error: unknown;
    try {
      writeSingleNode(undefined, overlayOf({ Machine: { Drive: { Direction: { x: 1, y: Number.NaN } } } }));
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(UnrepresentableValueError);
    expect((error as UnrepresentableValueError).locations[0]).toContain('Drive.Direction');
    expect((error as UnrepresentableValueError).locations[0]).toContain('.y');
  });

  it('still accepts null, which is a delete rather than an unrepresentable value', () => {
    expect(() => writeSingleNode(
      { realvirtual: { Drive: { TargetSpeed: 1 } } },
      overlayOf({ Machine: { Drive: { TargetSpeed: null } } }),
    )).not.toThrow();
  });

  it('throws with every unresolved path rather than writing a partial file', () => {
    const source = makeGlb({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Machine' }],
    });
    let error: unknown;
    try {
      writeSettingsIntoModel(
        source,
        overlayOf({ Machine: { Drive: { A: 1 } }, Ghost: { Drive: { A: 1 } }, Phantom: { Drive: { A: 1 } } }),
        (path) => (path === 'Machine' ? 0 : null),
      );
    } catch (e) { error = e; }

    expect(error).toBeInstanceOf(NodeNotFoundError);
    expect((error as NodeNotFoundError).paths).toEqual(['Ghost', 'Phantom']);
  });

  it('bakes into the real demo GLB without touching its geometry', () => {
    const path = resolve(__dirname, '../public/DemoRealvirtualWeb.glb');
    const source = new Uint8Array(readFileSync(path));
    const json = parseGlbChunks(source).json as {
      nodes: { name?: string; children?: number[] }[];
      scenes: { nodes?: number[] }[];
      scene?: number;
    };

    // Same node-index → path walk the CONNECT embed test uses.
    const paths = new Map<string, number>();
    const visit = (index: number, parent = ''): void => {
      const node = json.nodes[index];
      const nodePath = parent ? `${parent}/${node.name}` : (node.name ?? '');
      paths.set(nodePath, index);
      for (const child of node.children ?? []) visit(child, nodePath);
    };
    for (const root of json.scenes[json.scene ?? 0].nodes ?? []) visit(root);

    const target = 'DemoCell/Conveyors/ConveyorEntry1';
    expect(paths.has(target)).toBe(true);

    const mappings = [{
      kind: 'mapped-signal', slot: 'Forward', sourceKind: 'connect',
      signal: 'ConveyorMotor.Run', interfaceId: 'connect-main',
      direction: 'plcOutput', enabled: true,
    }];
    const result = writeSettingsIntoModel(
      source,
      overlayOf({ [target]: { SignalLinks: { Mappings: mappings } } }),
      (p) => paths.get(p) ?? null,
    );

    const baked = parseGlbChunks(result.glb).json as {
      nodes: { extras?: { realvirtual?: Record<string, unknown> } }[];
    };
    const rv = baked.nodes[paths.get(target)!].extras!.realvirtual!;
    expect(rv.SignalLinks).toEqual({ Mappings: mappings });
    // The node's existing components must survive the merge untouched.
    expect(rv.Drive_Simple).toBeDefined();

    const tail = (b: Uint8Array) => b.subarray(20 + new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(12, true));
    expect(Buffer.from(tail(result.glb)).equals(Buffer.from(tail(source)))).toBe(true);
  });
});
