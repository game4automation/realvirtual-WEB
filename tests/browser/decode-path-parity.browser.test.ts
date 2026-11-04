// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 test 9.20 — browser variant (the decode-site / Node-twin part is
 * `tests/decode-path-parity.test.ts`).
 *
 * A shipped Unity export (`DemoRealvirtualWeb.glb`, path-form references, no ids) is
 * loaded in a real viewer, addressed the way a person or an MCP call does it
 * (`findNodeForUser`), saved through the scene save and loaded again:
 *
 *  - `findNodeForUser` answers the runtime path AND the authored path with the same node;
 *  - the save stores ids and addresses only (`idVersion: 1`), and every stored reference is
 *    exactly the address the load migrated its path to (or the same unresolved path);
 *  - the reload reads the file without migrating it: every node has the id it had in the
 *    first load, every stored address resolves to the node carrying that id, and the
 *    reference audit and the drive/sensor/signal inventory are identical.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { identityIdOf } from '../../src/core/engine/rv-decode-identity';
import { auditReferences } from '../../src/core/engine/rv-reference-audit';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import { parseGlbChunks } from '../../src/core/persistence/rv-glb-chunks';
import { expectNoPathInReferences, storedPositionsOf, type WrittenGltfJson } from '../helpers/stored-ref-walker';
import { resetProblemsForTests } from '../../src/core/hmi/problems-store';

const FIXTURE = '/demo-realvirtual/DemoRealvirtualWeb.glb';

interface Facts {
  idsByAuthored: Map<string, string>;
  audit: { unresolved: number; rescued: number };
  inventory: { drives: number; sensors: number; signals: number };
}

let handles: TestViewerHandle[] = [];
afterEach(() => { for (const h of handles) h.dispose(); handles = []; resetProblemsForTests(); });

async function open(bytes: ArrayBuffer, name: string): Promise<TestViewerHandle> {
  const h = await createTestViewer('webgl');
  handles.push(h);
  await h.viewer.loadModel(name, { data: bytes.slice(0) });
  await h.viewer.whenSceneReady();
  return h;
}

function factsOf(h: TestViewerHandle): Facts {
  const reg = h.viewer.registry!;
  const idsByAuthored = new Map<string, string>();
  reg.forEachNode((_path, node) => {
    const authored = reg.getAuthoredPath(node);
    const id = identityIdOf(node);
    if (authored !== null && id) idsByAuthored.set(authored, id);
  });
  const audit = auditReferences(reg);
  return {
    idsByAuthored,
    audit: { unresolved: audit.counts.unresolved, rescued: audit.counts.rescued },
    inventory: {
      drives: h.viewer.drives.length,
      sensors: (h.viewer as unknown as { sensors?: unknown[] }).sensors?.length ?? 0,
      signals: h.viewer.signalStore?.size ?? 0,
    },
  };
}

describe('plan-769 9.20 — browser: load → findNodeForUser → save → reload with identical ids and addresses', () => {
  it(`${FIXTURE}`, async () => {
    const res = await fetch(FIXTURE);
    expect(res.ok).toBe(true);
    const original = await res.arrayBuffer();
    const originalJson = parseGlbChunks(original.slice(0)).json as WrittenGltfJson;
    expect(originalJson.scenes?.[0]?.extras?.realvirtual?.idVersion, 'a path-era Unity export').toBeUndefined();
    const originalPositions = storedPositionsOf(originalJson).filter((p) => p.form === 'path' && p.path.trim() !== '');
    expect(originalPositions.length, 'the fixture stores path references').toBeGreaterThan(0);

    // ── 1. Load + findNodeForUser ──
    const first = await open(original, 'DemoRealvirtualWeb.glb');
    const reg = first.viewer.registry!;
    const before = factsOf(first);
    expect(before.idsByAuthored.size).toBeGreaterThan(50);
    let checked = 0;
    reg.forEachNode((path, node) => {
      if (checked >= 60 || !identityIdOf(node)) return;
      const authored = reg.getAuthoredPath(node);
      const viaRuntime = reg.findNodeForUser(path);
      expect(viaRuntime?.node, `runtime path ${path}`).toBe(node);
      if (authored) expect(reg.findNodeForUser(authored)?.node, `authored path ${authored}`).toBe(node);
      checked++;
    });
    expect(checked).toBeGreaterThan(20);

    // The load-time migration of every stored path (what the save must write).
    const identity = reg.identityOfOccurrence('')!;
    expect(identity).toBeTruthy();
    // Keyed by position + its ordinal under that key (array elements share a key).
    const keyed = <T extends { where: string }>(list: T[]): Map<string, T> => {
      const seen = new Map<string, number>();
      return new Map(list.map((x) => { const k = seen.get(x.where) ?? 0; seen.set(x.where, k + 1); return [`${x.where}#${k}`, x]; }));
    };
    const expectedByWhere = new Map<string, unknown>();
    for (const [key, p] of keyed(originalPositions)) {
      const m = identity.migratePath(p.path);
      expectedByWhere.set(key, m.address !== undefined ? { address: m.address } : { unresolvedPath: p.path });
    }

    // ── 2. Save (the scene save) ──
    let floorPath: string | null = null;
    for (const n of first.viewer.currentModelRoot!.children) {
      const p = reg.getPathForNode(n as Object3D);
      if (p && reg.getGltfLocation(p)) { floorPath = p; break; }
    }
    expect(floorPath, 'a root-level node of the file to move').toBeTruthy();
    const move = {
      id: 'op-920', ts: Date.now(), schemaV: 1, kind: 'transformNode', nodePath: floorPath,
      transform: { position: [0, 0, 0.001], quaternion: [0, 0, 0, 1] },
      prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    } as unknown as RvOp;
    const baked = await bakeIntoGlb(original.slice(0), materialise([move]), makeRegistryBakeResolver(reg, []), {
      expectedNames: reg.getGltfNodeNames(),
    });
    const savedJson = parseGlbChunks(baked.glb).json as WrittenGltfJson;
    expect(savedJson.scenes?.[0]?.extras?.realvirtual?.idVersion).toBe(1);
    expectNoPathInReferences(savedJson);
    const savedByWhere = keyed(storedPositionsOf(savedJson).filter((p) => p.form !== 'path' || p.path.trim() !== ''));
    let compared = 0;
    for (const [where, expected] of expectedByWhere) {
      const saved = savedByWhere.get(where);
      expect(saved, `saved position ${where}`).toBeTruthy();
      if ('address' in (expected as object)) {
        expect(saved!.form, where).toBe('address');
        expect((saved!.value as { address?: string }).address ?? saved!.path, where).toBe((expected as { address: string }).address);
      } else {
        expect(saved!.form, where).toBe('unresolved');
      }
      compared++;
    }
    expect(compared).toBe(expectedByWhere.size);
    const addressed = [...expectedByWhere.values()].filter((e) => 'address' in (e as object)).length;
    console.log(`[9.20 browser] ${JSON.stringify({ nodes: before.idsByAuthored.size, findChecked: checked, pathRefs: originalPositions.length, addressed, unresolved: compared - addressed, path: baked.path, audit: before.audit, inventory: before.inventory })}`);
    // Every node of the file is written with the id it had at load.
    (savedJson.nodes ?? []).forEach((n) => { expect(typeof n.extras?.realvirtual?.NodeId, n.name).toBe('string'); });

    // ── 3. Reload ──
    const bytes = baked.glb.buffer.slice(baked.glb.byteOffset, baked.glb.byteOffset + baked.glb.byteLength) as ArrayBuffer;
    const second = await open(bytes, 'DemoRealvirtualWeb-saved.glb');
    const reg2 = second.viewer.registry!;
    expect(reg2.identityOfOccurrence('')?.migrated, 'an idVersion-1 file is not migrated again').toBe(false);
    const after = factsOf(second);
    const lost: string[] = [];
    for (const [authored, id] of before.idsByAuthored) if (after.idsByAuthored.get(authored) !== id) lost.push(authored);
    expect(lost.slice(0, 10), 'every node keeps its id across save + reload').toEqual([]);
    expect(after.audit).toEqual(before.audit);
    expect(after.inventory).toEqual(before.inventory);
    // Every stored address of the saved file resolves to the node that carries that id.
    const root2 = second.viewer.currentModelRoot!;
    for (const p of storedPositionsOf(savedJson)) {
      if (p.form !== 'address') continue;
      const address = (p.value as { address?: string }).address ?? p.path;
      const node = reg2.resolveAddressIn(root2, address);
      expect(node, `address ${address} (${p.where})`).toBeTruthy();
      expect(`#${identityIdOf(node!)}`, p.where).toBe(address.slice(address.lastIndexOf('#')));
    }
  }, 300_000);
});
