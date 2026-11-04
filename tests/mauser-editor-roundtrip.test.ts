// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 3a acceptance — Mauser Cageline30 through the EDITOR export (LOCAL only):
 * load as the asset editor does → `exportAssetGlb` (in memory — the customer file is
 * never written) → reload. Ids identical, no path in a reference position, `idVersion: 1`,
 * the 46 references the file cannot resolve kept as `unresolvedPath`, and the bake's
 * survival of the runtime load unchanged.
 *
 *   MSYS_NO_PATHCONV=1 VITE_RV_MAUSER_GLB=/private-models/mauser3dhmi/MauserCageline30.glb \
 *     npx vitest run tests/mauser-editor-roundtrip.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { exportAssetGlb, type ExportIdentityReport } from '../src/core/editor/rv-asset-glb-export';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { bakeRemovalReport, _resetBakeRemovalReportForTesting } from '../src/core/engine/rv-bake-survival';
import { auditReferences } from '../src/core/engine/rv-reference-audit';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { expectNoPathInReferences, storedPositionsOf, type WrittenGltfJson } from './helpers/stored-ref-walker';
import baseline from './fixtures/reference-baseline.json';

const MAUSER_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_RV_MAUSER_GLB;
const MAUSER_KEY = 'private:projects/mauser3dhmi/models/MauserCageline30.glb';

function idsOf(root: Object3D, pathOf: (n: Object3D) => string | null): Map<string, string> {
  const m = new Map<string, string>();
  root.traverse((n) => { const p = pathOf(n); const id = identityIdOf(n); if (p !== null && id) m.set(p, id); });
  return m;
}

async function runtimeNumbers(bytes: ArrayBuffer, name: string): Promise<Record<string, number>> {
  _resetBakeRemovalReportForTesting();
  resetProblemsForTests();
  const h: TestViewerHandle = await createTestViewer('webgl');
  try {
    await h.viewer.loadModel(name, { data: bytes.slice(0) });
    const report = bakeRemovalReport[bakeRemovalReport.length - 1]!;
    const audit = auditReferences(h.viewer.registry!);
    return {
      ...(report.counts as unknown as Record<string, number>),
      auditUnresolved: audit.counts.unresolved,
      auditRescued: audit.counts.rescued,
    };
  } finally {
    h.dispose();
  }
}

describe.skipIf(!MAUSER_URL)('plan-769 Phase 3a — Mauser editor round trip (LOCAL, VITE_RV_MAUSER_GLB)', () => {
  afterEach(() => { resetProblemsForTests(); vi.restoreAllMocks(); });

  it('load → editor export → reload: ids identical, addresses only, idVersion 1, 46 kept, survival unchanged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await fetch(MAUSER_URL!);
    expect(res.ok).toBe(true);
    const original = await res.arrayBuffer();

    const t0 = performance.now();
    const editor = await loadGLB('MauserCageline30.glb', new Scene(), { data: original.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false });
    const tLoad = performance.now();
    let report: ExportIdentityReport | null = null;
    const saved = await exportAssetGlb(editor.root, 'MauserCageline30', undefined, undefined, {
      registry: editor.registry, onIdentityReport: (r) => { report = r; },
    });
    const tExport = performance.now();
    const json = readGlbJson(saved) as WrittenGltfJson;
    expectNoPathInReferences(json);
    const positions = storedPositionsOf(json);
    const kept = positions.filter((p) => p.form === 'unresolved').length;
    const snap = (baseline as { glbs: Record<string, { refs: { unresolved: { missing: number; ambiguous: number } } }> }).glbs[MAUSER_KEY]!;
    const snapUnresolved = snap.refs.unresolved.missing + snap.refs.unresolved.ambiguous;
    expect(json.scenes![0]!.extras!.realvirtual!.idVersion).toBe(1);
    const fileIds = (json.nodes ?? []).map((n) => n.extras?.realvirtual?.NodeId);
    expect(fileIds.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(fileIds).size).toBe(fileIds.length);

    const reload = await loadGLB('MauserCageline30-saved.glb', new Scene(), { data: saved.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false });
    const tReload = performance.now();
    const identity = reload.registry.identityOfOccurrence('')!;
    const before = idsOf(editor.root, (n) => editor.registry.getPathForNode(n));
    const after = idsOf(reload.root, (n) => reload.registry.getPathForNode(n));
    let differing = 0;
    for (const [p, id] of before) if (after.get(p) !== id) differing++;

    const runOriginal = await runtimeNumbers(original, 'MauserCageline30.glb');
    const runSaved = await runtimeNumbers(saved, 'MauserCageline30-saved.glb');
    const numbers = {
      nodes: json.nodes?.length, references: positions.length,
      addresses: positions.filter((p) => p.form === 'address').length, kept, snapUnresolved,
      promoted: report!.ids.promoted, minted: report!.ids.minted, reminted: report!.ids.reminted.length,
      guessed: report!.references.guessed.length,
      idsCompared: before.size, idsDiffering: differing, reloadMigrated: identity.migrated, reloadSeeded: identity.counts.seeded,
      loadMs: Math.round(tLoad - t0), exportMs: Math.round(tExport - tLoad), reloadMs: Math.round(tReload - tExport),
      savedMB: +(saved.byteLength / 1e6).toFixed(1), originalMB: +(original.byteLength / 1e6).toFixed(1),
      runtimeOriginal: runOriginal, runtimeSaved: runSaved,
    };
    console.log(`[3a Mauser round trip] ${JSON.stringify(numbers)}`);

    expect(kept).toBe(snapUnresolved);
    expect(identity.idVersion).toBe(1);
    expect(identity.migrated).toBe(false);
    expect(differing).toBe(0);
    expect(after.size).toBe(before.size);
    // The survival of the runtime load is unchanged — every count, not only the unresolved.
    expect(runSaved).toEqual(runOriginal);
    expect(runSaved.auditRescued).toBe(0);
  }, 1_200_000);
});
