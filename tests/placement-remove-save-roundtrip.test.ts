// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * placement-remove-save-roundtrip.test.ts — plan-753 Phase 3 live-acceptance
 * finding: three `RollConveyor 2m` placed via `web_layout_place`, one removed via
 * `web_layout_remove` (`removed:true`, `web_layout_list` → 2, `web_status.bake
 * .instances` 3→2), then `web_document_save` — and the saved GLB still carried
 * THREE `AssetReference` nodes, including the removed `NodeId`.
 *
 * What the document save actually persists is NOT the layout store and NOT the
 * scene graph: `SceneStore._writeBodyInner` (scene-store.ts:3263) bakes
 * `materialise(this._ops)` — the op log. A placement is in the file iff its
 * `addPlacement` op is not cancelled by a `removePlacement` op
 * (`rv-scene-edits.ts:427-433`).
 *
 * The two removal entry points differ exactly there:
 *
 *  - UI (Delete key / hierarchy menu) → `removeByPaths` → `_removeByPlacementIds`
 *    (index.ts:2866) — tears the scene down AND applies a `removePlacement` op.
 *  - MCP `web_layout_remove` (rv-mcp-scene-tools.ts:562) → `removePlacementById`
 *    (index.ts:3405) — the executor PRIMITIVE ("op forward / undo of add"): scene
 *    + layout store only, no op. The op log keeps the `addPlacement`, so the
 *    next save re-materialises the placement.
 *
 * Both lines predate plan-753 (`git blame`: the MCP tool is 6becdc2d, plan-713,
 * 2026-08-17; the primitive is 9d1f9a07, 2026-07-27), so the failing case below
 * is pinned as `it.fails` — a pre-existing gap, NOT a Phase 3 regression, and
 * not fixed here by design (task rule: pre-existing causes are documented, not
 * patched under plan-753). The green case proves the identical scenario is
 * saved correctly through the op-recording UI path, which is what isolates the
 * cause to the MCP verb's missing op.
 *
 * `getSceneStore()` is replaced by an op RECORDER: the production store's only
 * role in this scenario is to collect ops and hand `materialise(ops)` to the
 * bake — recording them here and driving the very same `materialise` +
 * `bakeIntoGlb` pair keeps the test on the production save path without
 * standing up a workspace, IndexedDB and a project backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Group } from 'three';

import {
  setupPlanner,
  internals,
  flush,
  TINY_PNG,
  type PlannerHarness,
} from './_layout-planner-async-harness';
import type { LibraryCatalogEntry } from '../src/plugins/layout-planner/rv-layout-store';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import { RV_ASSET_REFERENCE_KEY } from '../src/core/engine/rv-asset-reference';
import { RV_NODE_ID_KEY } from '../src/core/engine/rv-node-id';

// ─── Op recorder in place of the SceneStore singleton ───────────────────

const h = vi.hoisted(() => ({
  ops: [] as unknown[],
}));

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => ({
    applyOp: async (op: unknown) => { h.ops.push(op); },
    withTransaction: async (_label: string, fn: () => Promise<void>) => { await fn(); },
    // `onModelLoaded` installs the splat re-apply listener; nothing to observe here.
    subscribe: () => () => {},
  }),
}));

// ─── Fixture ────────────────────────────────────────────────────────────

const STABLE_URL = 'https://rv-test.invalid/plan753-rollconveyor-2m.glb';
const CATALOG_URL = 'test://plan753-remove-save';
const AUTOSAVE_KEY = 'rv-layout-autosave';

const ROLL_CONVEYOR: LibraryCatalogEntry = {
  id: 'cat:plan753-rollconveyor-2m',
  name: 'RollConveyor 2m',
  category: 'conveyor',
  glbUrl: STABLE_URL,
  thumbnailUrl: TINY_PNG,
  footprintMm: [2000, 600],
};

async function bootPlanner(): Promise<PlannerHarness> {
  const harness = setupPlanner();
  harness.plugin.store.addCatalogDirect(CATALOG_URL, {
    version: '1.0',
    name: 'plan753-remove-save',
    entries: [ROLL_CONVEYOR],
  });
  await internals(harness.plugin)._catalogsLoaded;
  await flush();
  return harness;
}

/** Three placements the way `web_layout_place` makes them (`placeComponent`). */
async function placeThree(harness: PlannerHarness): Promise<string[]> {
  const ids: string[] = [];
  for (const x of [0, 2.2, 4.4]) {
    ids.push(await harness.plugin.placeComponent(ROLL_CONVEYOR, [x, 0, 0]));
  }
  await flush();
  return ids;
}

interface GltfNode { name?: string; extras?: { realvirtual?: Record<string, unknown> } }

/**
 * The document save, as `SceneStore._writeBodyInner` performs it: the op log is
 * materialised and baked into the base bytes. The base is an empty document —
 * the `sandbox.glb` of the live session before its first placement.
 */
async function saveLikeDocumentSave(harness: PlannerHarness): Promise<GltfNode[]> {
  const sandbox = new Group();
  sandbox.name = 'sandbox';
  const base = await objectToGlb(sandbox);
  const edits = materialise(h.ops as RvOp[]);
  const result = await bakeIntoGlb(
    base,
    edits,
    makeRegistryBakeResolver(harness.viewer.registry, []),
    { clearCameraWhenUnset: true },
  );
  const json = parseGlbChunks(result.glb).json as { nodes?: GltfNode[] };
  return json.nodes ?? [];
}

function assetReferenceNodeIds(nodes: GltfNode[]): string[] {
  return nodes
    .filter((n) => n.extras?.realvirtual?.[RV_ASSET_REFERENCE_KEY] !== undefined)
    .map((n) => String(n.extras?.realvirtual?.[RV_NODE_ID_KEY]));
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('plan-753 — remove a placement, save the document', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.ops.length = 0;
    localStorage.removeItem(AUTOSAVE_KEY);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]) /* a bare `glTF` header — the blob cache refuses anything else */]), {
        status: 200,
        headers: { 'Content-Type': 'model/gltf-binary' },
      }),
    ) as ReturnType<typeof vi.spyOn>;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    localStorage.removeItem(AUTOSAVE_KEY);
  });

  it('places three: three addPlacement ops, three AssetReference nodes in the file', async () => {
    const harness = await bootPlanner();
    const ids = await placeThree(harness);

    expect(harness.store.getSnapshot().placed.map((p) => p.id)).toEqual(ids);
    expect(h.ops.filter((op) => (op as RvOp).kind === 'addPlacement')).toHaveLength(3);

    const refs = assetReferenceNodeIds(await saveLikeDocumentSave(harness));
    expect(refs.sort()).toEqual([...ids].sort());
  });

  it('UI path (removeByPaths → removePlacement op): the removed placement is NOT in the saved file', async () => {
    const harness = await bootPlanner();
    const ids = await placeThree(harness);
    const removed = ids[2];

    const root = harness.plugin.getPlacedRootById(removed);
    expect(root).not.toBeNull();
    const path = harness.viewer.registry.getPathForNode(root!);
    expect(path).toBeTruthy();

    await harness.plugin.removeByPaths([path!]);
    await flush();

    // Scene + layout store agree with the live observation (list → 2).
    expect(harness.plugin.getPlacedRootById(removed)).toBeNull();
    expect(harness.store.getSnapshot().placed).toHaveLength(2);
    // …and the op log cancels the addPlacement.
    expect(h.ops.filter((op) => (op as RvOp).kind === 'removePlacement')).toHaveLength(1);

    const refs = assetReferenceNodeIds(await saveLikeDocumentSave(harness));
    expect(refs).toHaveLength(2);
    expect(refs).not.toContain(removed);
  });

  /**
   * Characterisation of the CURRENT behaviour — the live finding, reproduced
   * (three refs, the removed id among them, no `removePlacement` op). This
   * plain `it` exists so the `it.fails` below cannot pass for the wrong
   * reason (a harness error is also "a failure"): it goes red the moment the
   * gap is closed, which is when both cases flip together.
   */
  it('MCP path today: removePlacementById records no op, so the save still holds the removed placement (BEHAVIOUR PIN)', async () => {
    const harness = await bootPlanner();
    const ids = await placeThree(harness);
    const removed = ids[2];

    harness.plugin.removePlacementById(removed);
    await flush();

    expect(harness.plugin.getPlacedRootById(removed)).toBeNull();
    expect(harness.store.getSnapshot().placed).toHaveLength(2);
    expect(h.ops.filter((op) => (op as RvOp).kind === 'removePlacement')).toHaveLength(0);

    const refs = assetReferenceNodeIds(await saveLikeDocumentSave(harness));
    expect(refs).toHaveLength(3);
    expect(refs).toContain(removed);
  });

  /**
   * The fix (2026-09-17). `web_layout_remove` now goes through
   * `planner.removeByIds` — the id-keyed twin of `removeByPaths` — which
   * records the `removePlacement` op. `removePlacementById` stays the bare op
   * EXECUTOR (the BEHAVIOUR PIN above still describes it, correctly).
   */
  it('MCP path (web_layout_remove → removeByIds): the removed placement is NOT in the saved file', async () => {
    const harness = await bootPlanner();
    const ids = await placeThree(harness);
    const removed = ids[2];

    expect(await harness.plugin.removeByIds([removed, 'no-such-id'])).toEqual([removed]);
    await flush();

    expect(harness.plugin.getPlacedRootById(removed)).toBeNull();
    expect(harness.store.getSnapshot().placed).toHaveLength(2);
    expect(h.ops.filter((op) => (op as RvOp).kind === 'removePlacement')).toHaveLength(1);

    const refs = assetReferenceNodeIds(await saveLikeDocumentSave(harness));
    expect(refs).toHaveLength(2);
    expect(refs).not.toContain(removed);
  });

  /**
   * Same gap, same fix, for `web_layout_move`: `applyTransformById` is the op
   * executor and recorded nothing, so a pallet lifted onto a conveyor was back
   * on the ground after a reload. `moveById` records the `transformPlacement` op.
   */
  it('MCP path (web_layout_move → moveById): the move is recorded as a transformPlacement op', async () => {
    const harness = await bootPlanner();
    const ids = await placeThree(harness);

    expect(await harness.plugin.moveById(ids[1], [2.2, 0.5, 1], [0, 90, 0])).toBe(true);
    expect(await harness.plugin.moveById('no-such-id', [0, 0, 0], [0, 0, 0])).toBe(false);
    await flush();

    const moves = h.ops.filter((op) => (op as RvOp).kind === 'transformPlacement') as Array<{
      placementId: string; position: number[]; rotation: number[]; prev: { position: number[] };
    }>;
    expect(moves).toHaveLength(1);
    expect(moves[0].placementId).toBe(ids[1]);
    expect(moves[0].position).toEqual([2.2, 0.5, 1]);
    expect(moves[0].rotation).toEqual([0, 90, 0]);
    expect(moves[0].prev.position[1]).toBe(0);
  });
});
