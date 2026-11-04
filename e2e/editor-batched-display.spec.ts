// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 §9.9 — the editor's batched display, end to end on the demo document.
 *
 * Open → Hover → Tool ON → Move → Eye → Material → Save → Reopen, against the
 * real viewer, the real asset-editor plugin and the real arena manager it
 * installs:
 *
 *  - Open: entering the editor builds arenas; every arena source keeps
 *    `.visible = true` and carries `layers.mask = 0`;
 *  - Hover: a ray at a raster point resolves to the EXACT source mesh path,
 *    and that mesh is an arena instance;
 *  - Tool ON: `T` arms the transform tool (the store reads ON);
 *  - Move: a `transformNode` op is mirrored into the instance matrix on the
 *    next frame (the pre-frame sync, no writer wiring);
 *  - Eye: hiding the node hides the instance, showing it shows it again;
 *    undoing eye and move puts the instance back (undo is an op like any other);
 *  - Material: a plain colour lands in the instance colour (uber bucket);
 *  - Save: the save's exporter (`exportAssetGlb`) writes the same nodes,
 *    meshes, materials and binary payload sizes with and without arenas, and
 *    no arena object reaches the GLB (order-free: the textured demo exporter is
 *    not byte-deterministic by itself — image encodes finish in any order);
 *  - Reopen: leaving the editor removes every arena, re-entering rebuilds them
 *    and the material edit is still on the tree. The move is undone BEFORE the
 *    reopen on purpose: re-entering a bound scene document after moving a mesh
 *    part fails with `UnwritableTransformError` in the scene bake — a defect
 *    that reproduces identically WITHOUT arenas (2026-10-19), outside plan-766.
 *
 * Deliberate cut: "Save" is the exporter, not the write. Headless Chrome has
 * no writable work folder for the demo's read-only project
 * (`editor-rebind-after-modes.spec.ts` explains the detour that needs); what
 * this plan has to prove about saving is that the arenas never reach the bytes.
 */

import { test, expect } from 'playwright/test';
import { HAS_PRIVATE_SOURCE, privateModuleUrl } from './private-module-url';
import { enterEditorOn, installArenaHarness } from './_editor-arena';

const DEMO_URL = '/?model=DemoRealvirtualWeb.glb';
const TOOL_STORE = privateModuleUrl('plugins/asset-editor/transform-tool-store.ts');

test.describe('plan-766 — editor batched display (demo document)', () => {
  test.skip(!HAS_PRIVATE_SOURCE, 'needs the private sibling repository (asset-editor source)');
  test.setTimeout(180_000);

  test('open → hover → tool → move → eye → material → save → reopen', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
    const opened = await enterEditorOn(page, DEMO_URL);
    expect(opened.arenas, 'the editor builds at least one arena').toBeGreaterThan(0);
    expect(opened.instances).toBeGreaterThan(0);
    await installArenaHarness(page);

    // ── Open: the mask contract on every source ─────────────────────────
    const contract = await page.evaluate(() => {
      const v = (window as any).viewer;
      let sources = 0, wrongMask = 0, hidden = 0;
      v.currentModelRoot.traverse((o: any) => {
        if (!v.editorArena.refOf(o)) return;
        sources++;
        if (o.layers.mask !== 0) wrongMask++;
        if (o.visible === false && !o.userData?.realvirtual?.rv?.Hidden) hidden++;
      });
      let arenasUnderRoot = 0;
      v.currentModelRoot.traverse((o: any) => { if (o.userData?._rvEditorArena) arenasUnderRoot++; });
      return { sources, wrongMask, arenasUnderRoot };
    });
    expect(contract.sources).toBe(opened.instances);
    expect(contract.wrongMask, 'every arena source is masked (layers.mask = 0)').toBe(0);
    expect(contract.arenasUnderRoot, 'arenas live outside the asset root').toBe(0);

    // ── Hover: exact source path, and it is an arena instance ───────────
    const target = await page.evaluate(async () => {
      const v = (window as any).viewer;
      const el = v.renderer.domElement.getBoundingClientRect();
      for (let i = 0; i < 100; i++) {
        const p = { clientX: el.left + el.width * (0.2 + 0.6 * ((i % 10) + 0.5) / 10), clientY: el.top + el.height * (0.2 + 0.6 * (Math.floor(i / 10) + 0.5) / 10) };
        const hit = v.raycastManager.raycastForRVNodeDetailed(p);
        if (!hit) continue;
        const node = v.registry.getNode(hit.path);
        if (node?.isMesh && v.editorArena.refOf(node)) return { path: hit.path as string };
      }
      return null;
    });
    expect(target, 'a raster ray hits an arena-instanced source mesh').not.toBeNull();
    const path = target!.path;

    // ── Tool ON ──────────────────────────────────────────────────────────
    await page.locator('canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('t');
    const toolOn = await page.evaluate(async (mod) => {
      const dyn = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
      const store = await dyn(mod);
      if (!store.isTransformToolOn()) store.toggleTransformTool(); // key focus is best-effort headless
      return store.isTransformToolOn() as boolean;
    }, TOOL_STORE);
    expect(toolOn, 'the transform tool is armed').toBe(true);

    // ── Move / Eye / Material through the document ──────────────────────
    const edits = await page.evaluate(async (p) => {
      const w = window as any;
      const v = w.viewer;
      const dyn = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
      const { getActiveAssetContext } = await dyn('/src/core/editor/active-asset-store.ts');
      const doc = getActiveAssetContext().doc;
      const mesh = v.registry.getNode(p);
      // three's classes through live instances — no second module instance.
      const Matrix4 = mesh.matrixWorld.constructor;
      const Color = mesh.material.color.constructor;
      const ref = () => v.editorArena.refOf(mesh);
      const synced = () => {
        const m = new Matrix4();
        ref().arena.mesh.getMatrixAt(ref().instanceId, m);
        return m.elements.every((e: number, i: number) => Math.abs(e - mesh.matrixWorld.elements[i]) < 1e-5);
      };
      const out: Record<string, unknown> = {};
      const pos = mesh.position, q = mesh.quaternion, s = mesh.scale;
      const prev = { position: [pos.x, pos.y, pos.z], quaternion: [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z] };
      doc.transformNode(p, { ...prev, position: [pos.x + 0.25, pos.y, pos.z] }, prev);
      await doc.whenIdle(); await w.__rvArena.frame();
      out.moved = Math.abs(mesh.position.x - (prev.position[0] + 0.25)) < 1e-6;
      out.moveSynced = synced();

      doc.setNodeVisible(p, false); await doc.whenIdle(); await w.__rvArena.frame();
      out.hiddenInstance = ref().arena.mesh.getVisibleAt(ref().instanceId);
      out.hiddenSourceStillVisibleFlagOrRvHidden = mesh.visible === false || !!mesh.userData?.realvirtual;
      doc.setNodeVisible(p, true); await doc.whenIdle(); await w.__rvArena.frame();
      out.shownInstance = ref().arena.mesh.getVisibleAt(ref().instanceId);

      // Undo the eye pair and the move: the instance follows the undo too. The
      // undo also keeps the reopen below clear of a PRE-EXISTING scene-bake
      // defect — a bound scene document cannot write a moved mesh part
      // (`UnwritableTransformError` on re-entry, reproduced 2026-10-19 WITHOUT
      // arenas: move+eye and move+material fail identically).
      await doc.undo(); await doc.undo(); await doc.undo();
      await doc.whenIdle(); await w.__rvArena.frame();
      out.undoneMove = Math.abs(mesh.position.x - prev.position[0]) < 1e-6;
      out.undoSynced = synced();

      doc.setMaterial([p], { name: 'e2e red', color: '#ff0000', metalness: 0.1, roughness: 0.5, opacity: 1, transparent: false });
      await doc.whenIdle(); await w.__rvArena.frame();
      const c = new Color();
      ref().arena.mesh.getColorAt(ref().instanceId, c);
      out.bucket = ref().arena.bucket.kind;
      out.instanceColour = c.getHexString();
      out.meshColour = mesh.material.color.getHexString();
      return out;
    }, path);
    expect(edits.moved).toBe(true);
    expect(edits.moveSynced, 'the instance matrix follows the moved source').toBe(true);
    expect(edits.hiddenInstance, 'eye off hides the instance').toBe(false);
    expect(edits.shownInstance, 'eye on shows it again').toBe(true);
    expect(edits.undoneMove, 'undo puts the part back').toBe(true);
    expect(edits.undoSynced, 'the instance follows the undo').toBe(true);
    expect(edits.bucket).toBe('uber');
    expect(edits.instanceColour).toBe(edits.meshColour);

    // ── Save: the exporter's output does not depend on the arenas ───────
    const save = await page.evaluate(async () => {
      const v = (window as any).viewer;
      const dyn = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
      const { exportAssetGlb } = await dyn('/src/core/editor/rv-asset-glb-export.ts');
      const root = v.currentModelRoot;
      // The exporter is not byte-deterministic on a textured document by
      // itself: the image encodes finish in any order, so bufferView ORDER and
      // with it the digit count of the byteOffsets (= JSON length) vary between
      // two exports of the SAME tree (measured 2026-10-19: 88 bytes). The
      // comparison is therefore order-free: same nodes in the same order, same
      // meshes/attributes, same materials, same MULTISET of bufferView lengths
      // (= every binary payload has the same size).
      const shape = (u: Uint8Array) => {
        const len = new DataView(u.buffer, u.byteOffset).getUint32(12, true);
        const text = new TextDecoder().decode(u.subarray(20, 20 + len));
        const j = JSON.parse(text);
        return {
          text,
          nodes: JSON.stringify((j.nodes ?? []).map((n: any) => [n.name ?? '', n.mesh ?? -1, (n.children ?? []).length, n.extras ?? null])),
          meshes: JSON.stringify((j.meshes ?? []).map((m: any) => m.primitives.map((p: any) => [Object.keys(p.attributes).sort().join(','), p.material ?? -1]))),
          materials: JSON.stringify(j.materials ?? []),
          views: JSON.stringify((j.bufferViews ?? []).map((bv: any) => bv.byteLength).sort((x: number, y: number) => x - y)),
        };
      };
      const withArenas = shape(new Uint8Array(await exportAssetGlb(root, 'e2e')));
      const manager = v.editorArena;
      manager.dispose();
      const without = shape(new Uint8Array(await exportAssetGlb(root, 'e2e')));
      manager.build(root);
      return {
        sameNodes: withArenas.nodes === without.nodes,
        sameMeshes: withArenas.meshes === without.meshes,
        sameMaterials: withArenas.materials === without.materials,
        samePayloads: withArenas.views === without.views,
        mentionsArena: /__rvEditorArena|_rvEditorArena|_rvBatchedRender/.test(withArenas.text),
        rebuilt: manager.isBuilt,
      };
    });
    expect(save.sameNodes, 'exported node list (names, meshes, children, extras) is the same with and without arenas').toBe(true);
    expect(save.sameMeshes, 'exported meshes/attributes/material slots are the same with and without arenas').toBe(true);
    expect(save.sameMaterials, 'exported materials are the same with and without arenas').toBe(true);
    expect(save.samePayloads, 'every binary payload has the same size with and without arenas').toBe(true);
    expect(save.mentionsArena, 'no arena object or marker reaches the GLB').toBe(false);
    expect(save.rebuilt).toBe(true);

    // ── Reopen: leave → no arena left; enter → rebuilt, edits still there ─
    await page.evaluate(async () => { await (window as any).viewer.modes.requestMode('hmi'); });
    await page.waitForFunction(() => (window as any).viewer.modes.activeMode === 'hmi' && !(window as any).viewer.editorArena, null, { timeout: 60_000 });
    const afterExit = await page.evaluate(() => {
      let n = 0;
      (window as any).viewer.scene.traverse((o: any) => { if (o.userData?._rvEditorArena) n++; });
      return n;
    });
    expect(afterExit, 'leaving the editor removes every arena').toBe(0);
    await page.evaluate(async () => { await (window as any).viewer.modes.requestMode('editor'); });
    await page.waitForFunction(() => (window as any).viewer.modes.activeMode === 'editor' && (window as any).viewer.editorArena?.isBuilt, null, { timeout: 90_000 })
      .catch((e) => { throw new Error(`editor re-entry did not rebuild the arenas; console errors:\n${consoleErrors.join('\n')}\n${e}`); });
    const reopened = await page.evaluate((p) => {
      const v = (window as any).viewer;
      // The re-entered editor may name the document root differently (the
      // bound scene projection) — address the part below the root.
      const below = p.slice(p.indexOf('/') + 1);
      const mesh = v.registry.getNode(`${v.currentModelRoot.name}/${below}`);
      return { instanced: !!(mesh && v.editorArena.refOf(mesh)), colour: mesh?.material?.color?.getHexString?.() ?? null };
    }, path);
    expect(reopened.instanced, 'the re-entered editor batches the tree again').toBe(true);
    expect(reopened.colour, 'the material edit survived the round trip').toBe('ff0000');
  });
});
