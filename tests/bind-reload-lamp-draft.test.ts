// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * bind-reload-lamp-draft.test.ts — the FULL user chain for a CONNECT binding
 * on a lamp / push-button `lightSignal` slot, end to end (plan-422 diagnosis):
 *
 *   1. real GLB  → `loadGLB()` (the shipping loader, not a hand-wired fixture)
 *   2. bind      → `upsertMappingForRow()` + `SignalBindingManager.applyMappings()`
 *                  + `createSignalBindingPersistence().write()` — the exact calls
 *                  `SignalBindPopover` / `InlineSignalSlots` make on a drop
 *   3. persist   → the REAL `SceneStore` debounced autosave bakes a draft GLB body
 *   4. reload    → the draft body is loaded through `loadGLB()` again and the
 *                  `SignalBindPlugin.onModelLoaded()` replay is re-run
 *
 * The question it answers: does the mapping survive a browser reload?
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { findSignalBindTarget, signalBindTargetId } from '../src/plugins/signal-bind/signal-bind-target';
import { buildSlotRowModels, upsertMappingForRow } from '../src/plugins/signal-bind/slot-row-models';
import { createSignalBindingPersistence } from '../src/plugins/signal-bind/signal-binding-persistence';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { baseKeyOf, type RvScene, type SceneBase } from '../src/core/hmi/scene/rv-scene-types';
import { readSceneGlb } from '../src/core/storage/rv-scene-glb-store';
import { setActiveEditTarget } from '../src/core/hmi/rv-edit-target';
import { freshOpId } from '../src/core/ops/rv-op-utils';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';
import type { RVViewer } from '../src/core/rv-viewer';
import type { PickerSignal } from '../src/core/hmi/rv-signal-slot-row';
import '../src/core/engine/rv-lamp';
import '../src/core/engine/rv-push-button3d';

// ── The source model ─────────────────────────────────────────────────────

/** A Unity-exported component reference, exactly as `scene-button-fixture` writes it. */
function ref(path: string, componentType: string): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType, componentIndex: 0 };
}

function node(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const obj = new Object3D();
  obj.name = name;
  parent.add(obj);
  if (extras) obj.userData.realvirtual = extras;
  return obj;
}

/**
 * Root 'DemoCell' with a PLC signal node and a `Lamp` whose `SignalLampOn`
 * points at it — the minimum shape that makes the lamp a bind target under the
 * schema-derived discovery of 0f44fbe.
 */
async function buildSourceGlb(): Promise<ArrayBuffer> {
  const root = new Object3D();
  root.name = 'DemoCell';
  const plc = node(root, 'PLCInterface');
  node(plc, 'AutomaticLight', { PLCOutputBool: { Name: 'AutomaticLight', Status: { Value: false } } });
  node(root, 'SignalLamp', {
    Lamp: {
      _fullTypeName: 'realvirtual.Lamp',
      SignalLampOn: ref('DemoCell/PLCInterface/AutomaticLight', 'realvirtual.PLCOutputBool'),
      OnColor: { r: 1, g: 0.7, b: 0, a: 1 },
      Intensity: 2,
      Period: 1,
      Flashing: false,
    },
  });
  return objectToGlb(root);
}

function blobUrl(bytes: ArrayBuffer | Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' }));
}

// ── The viewer surface the bind path touches ─────────────────────────────

interface FakeViewer {
  registry: LoadResult['registry'];
  signalStore: LoadResult['signalStore'];
  signalBindingManager: SignalBindingManager;
  behaviors: { getActiveBinds: () => unknown[] };
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  lastLoadResult: LoadResult | null;
  markRenderDirty: () => void;
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
}

function makeViewer(result: LoadResult, modelUrl: string): FakeViewer {
  const v: FakeViewer = {
    registry: result.registry,
    signalStore: result.signalStore,
    signalBindingManager: new SignalBindingManager(result.signalStore, result.registry),
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
    availableModels: [{ url: modelUrl, label: 'Demo' }],
    currentScene: null,
    currentModelUrl: modelUrl,
    lastLoadResult: result,
    markRenderDirty: () => {},
    loadScene: async (s) => { v.currentScene = s; },
    loadEmptyScene: async () => { v.currentScene = null; },
  };
  return v;
}

/** Find the lamp node in a freshly loaded tree. */
function lampNodeOf(result: LoadResult): Object3D {
  let found: Object3D | null = null;
  result.root.traverse((n) => { if (!found && n.name === 'SignalLamp') found = n; });
  if (!found) throw new Error('SignalLamp not found in the loaded tree');
  return found;
}

/** The `SignalLinks.Mappings` a node carries in its rv_extras (what a reload sees). */
function signalLinksOf(n: Object3D): SignalMapping[] | undefined {
  const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
  const links = rv?.SignalLinks as { Mappings?: unknown } | undefined;
  return Array.isArray(links?.Mappings) ? links!.Mappings as SignalMapping[] : undefined;
}

/** Wait for the debounced GLB autosave to land a body in `slot`. */
async function waitForDraftBody(slot: string, timeoutMs = 8000): Promise<Uint8Array | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await readSceneGlb(slot);
    if (body) return body;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The `SignalBindPlugin.onModelLoaded()` restore traverse, verbatim
 * (SignalBindPlugin.ts:104-115). Copied rather than driving the plugin because
 * the plugin also constructs the drag/overlay/badge controllers, which need a
 * real renderer; the restore loop itself is what this test is about.
 */
function replayNodeMappings(viewer: FakeViewer, result: LoadResult): number {
  let restored = 0;
  result.root.traverse((n) => {
    const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
    const raw = (rv?.SignalLinks as { Mappings?: unknown } | undefined)?.Mappings;
    if (!Array.isArray(raw)) return;
    const target = findSignalBindTarget(viewer as unknown as RVViewer, n);
    if (!target || target.kind !== 'node') return;
    const mappings = (raw as SignalMapping[]).map((m) => ({ ...m }));
    const applied = viewer.signalBindingManager.applyMappings(
      signalBindTargetId(target), target.node, mappings);
    restored += applied.length;
  });
  return restored;
}

// ── The chain ────────────────────────────────────────────────────────────

/**
 * Run the whole chain once.
 *
 * `topic` is the ONE difference between the two cases: a CONNECT signal that
 * lives under an MQTT topic carries a string, an interface-level one carries
 * nothing — and `rv-signal-slot-row.tsx:390-398` / `SignalBindPopover.tsx:254`
 * copy the key through either way, so the mapping ends up with
 * `topic: undefined` in the second case.
 */
async function runChain(
  topic: string | undefined,
  opts: { forcePresentUndefined?: boolean } = {},
): Promise<void> {
  {
    const sourceGlb = await buildSourceGlb();
    const modelUrl = blobUrl(sourceGlb);
    const base: SceneBase = { kind: 'builtin', url: modelUrl, label: 'Demo' };

    // ── 1. First session: load through the REAL loader ──────────────
    const scene1 = new Scene();
    const load1 = await loadGLB(modelUrl, scene1, { loadKinematicsSidecar: false });
    const viewer1 = makeViewer(load1, modelUrl);
    const lamp1 = lampNodeOf(load1);

    // The lamp must be a bind target at all (0f44fbe made it one).
    const target = findSignalBindTarget(viewer1 as unknown as RVViewer, lamp1);
    expect(target, 'lamp must resolve as a bind target').not.toBeNull();
    expect(target!.kind).toBe('node');

    const targetId = signalBindTargetId(target!);
    const rows = buildSlotRowModels(
      viewer1 as unknown as RVViewer, viewer1.signalBindingManager, targetId, target!.node, []);
    const row = rows.find((r) => r.kind !== 'unavailable');
    expect(row, `no bindable row on the lamp (rows: ${JSON.stringify(rows)})`).toBeTruthy();

    // ── 2. SceneStore + edit target, as production wires them ───────
    const store = new SceneStore(viewer1 as unknown as ConstructorParameters<typeof SceneStore>[0]);
    // The op emission is byte-identical to `rv-edit-target.ts`'s sceneStoreTarget;
    // only the singleton lookup is replaced (the test owns the store directly).
    const pendingOps: Promise<void>[] = [];
    setActiveEditTarget({
      available: true,
      setField: (nodePath, componentType, fieldName, value, prev) => {
        pendingOps.push(store.applyOp({
          id: freshOpId(), ts: Date.now(), schemaV: 1,
          kind: 'setField', nodePath, componentType, fieldName, value, prev,
        }));
      },
      unsetField: () => {},
      withTransaction: async (label, fn) => store.withTransaction(label, fn),
    });
    await store.openBuiltin(modelUrl, 'Demo');

    // ── 3. Drop a CONNECT signal onto the slot (popover persist path) ─
    const source: PickerSignal = {
      name: 'PLC.LampOn',
      interfaceId: 'mqtt',
      topic,
      direction: 'output',
      dataType: 'PLCOutputBool',
      origin: 'connect',
    };
    const next = upsertMappingForRow([], row!, source);
    expect(next, 'upsertMappingForRow rejected the pick').not.toBeNull();

    if (opts.forcePresentUndefined) {
      // Re-introduce the shape the fix removes at the source, to prove the bake
      // hardening carries it on its own: a PRESENT key holding `undefined`.
      expect('topic' in next![0], 'upsertMappingForRow still writes an empty topic key')
        .toBe(false);
      (next![0] as unknown as Record<string, unknown>).topic = undefined;
      expect('topic' in next![0]).toBe(true);
    }

    const persistence = createSignalBindingPersistence(viewer1 as unknown as RVViewer, target!);
    const applied = viewer1.signalBindingManager.applyMappings(targetId, target!.node, next!);
    expect(applied.length, 'applyMappings dropped the mapping').toBe(1);
    persistence.write(applied);

    // The op reached the store.
    await Promise.all(pendingOps);
    expect(store.getSnapshot().draft?.edits.ops.length, 'no setField op recorded')
      .toBeGreaterThan(0);

    // ── 4. Wait for the debounced GLB autosave ──────────────────────
    const slot = `draft/${baseKeyOf(base)}`;
    const body = await waitForDraftBody(slot);
    expect(body, `no draft GLB body written to ${slot}`).not.toBeNull();

    // ── 5. Reload: load the draft body like a fresh browser session ──
    const scene2 = new Scene();
    const draftUrl = blobUrl(body!);
    const load2 = await loadGLB(draftUrl, scene2, { loadKinematicsSidecar: false });
    const viewer2 = makeViewer(load2, draftUrl);
    const lamp2 = lampNodeOf(load2);

    // (a) the mapping is IN the draft GLB
    expect(signalLinksOf(lamp2), 'SignalLinks.Mappings missing from the draft GLB')
      .toEqual(applied);

    // (b) the replay turns it back into a live binding
    const restored = replayNodeMappings(viewer2, load2);
    expect(restored, 'onModelLoaded replay restored no binding').toBe(1);

    // (c) without a provider the binding is pending (plan-421 late resolution)
    const restoredTarget = findSignalBindTarget(viewer2 as unknown as RVViewer, lamp2)!;
    viewer2.signalBindingManager.tick(0.02);
    const liveness = viewer2.signalBindingManager.getBindingLiveness(
      signalBindTargetId(restoredTarget), applied[0].slot, applied[0].componentPath);
    expect(liveness, 'restored binding has no liveness').toBeTruthy();

    store.dispose();
    setActiveEditTarget(null);
  }
}

describe('CONNECT binding on a lamp lightSignal survives a reload', () => {
  // Control case: an MQTT topic signal. Everything in the mapping is JSON-
  // representable, so the bake succeeds and the whole chain closes.
  it('round-trips a topic-scoped CONNECT signal', async () => {
    localStorage.clear();
    await runChain('rv/processimage');
  }, 60_000);

  /**
   * THE REPORTED DEFECT — diagnosed 2026-08-10, FIXED in plan-422 phase 1.
   *
   * A CONNECT signal with no MQTT topic used to travel with the KEY anyway: the
   * badge drag set `topic: explicitInterfaceId ? … : undefined`
   * (`rv-signal-badge.tsx`), the drop handler copied it
   * (`rv-signal-slot-row.tsx`), the pickers copied it
   * (`SignalBindPopover.tsx` / `InlineSignalSlots.tsx`), and
   * `upsertMappingForRow()` wrote it into the mapping. `unrepresentableReason()`
   * rejected it ("undefined would be dropped"), `bakeIntoGlb()` threw
   * `UnrepresentableValueError` for the WHOLE file, and `_autosaveBody()`
   * swallowed that into a `console.error`. Net effect: no draft body was
   * written at all — the binding AND every other unsaved edit gone on reload,
   * with nothing said.
   *
   * Two changes make this pass, and the test is worth keeping because it needs
   * BOTH: the payload sites now omit an absent optional instead of carrying it
   * empty (`omitUndefined`), and the bake drops an `undefined` object property
   * with a warning rather than refusing the file.
   *
   * Was `it.fails` while the defect stood. Now a plain `it`.
   */
  it('round-trips a CONNECT signal WITHOUT a topic', async () => {
    localStorage.clear();
    await runChain(undefined);
  }, 60_000);

  /**
   * F1's second half, isolated: even when a mapping DOES reach the bake with a
   * present `undefined` — a payload built somewhere this plan did not touch —
   * the draft body must still be written, and nothing else in the mapping may
   * go missing with it.
   */
  it('writes the draft body even when a mapping carries a present undefined', async () => {
    localStorage.clear();
    await runChain(undefined, { forcePresentUndefined: true });
  }, 60_000);
});
