// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 0a (F16, test 9.12, behaviour half) — document-scoped Problems
 * leave the panel when the model changes.
 *
 * Every load starts with `RVViewer.clearModel()`, so an entry of a `clear-model`
 * code that survives it would be shown next to the NEXT model (Mauser
 * 2026-10-20: three `unresolved-instruction-target` entries of the previous
 * document). The static half (`problems-clear-per-load.node.test.ts`) makes sure
 * every code is classified; this half proves the `clear-model` class, plus a
 * real model switch for the instruction-target code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { getProblems, reportProblem, resetProblemsForTests, UNRESOLVED_INSTRUCTION_TARGET_CODE } from '../src/core/hmi/problems-store';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { codesOf } from './helpers/problem-code-classification';

async function glbOf(scene: Scene): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}

function urlOf(buf: ArrayBuffer): string {
  return URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
}

describe('plan-769 9.12 — document-scoped problems are gone after a model change', () => {
  let handle: TestViewerHandle | null = null;
  beforeEach(() => { resetProblemsForTests(); });
  afterEach(() => { handle?.dispose(); handle = null; resetProblemsForTests(); });

  it('clearModel() drops every `clear-model` code and keeps `not-document` codes', async () => {
    handle = await createTestViewer('webgl');
    const clearCodes = codesOf('clear-model');
    const keepCodes = ['save-reference-loss', 'duplicate-asset-id'];
    for (const code of [...clearCodes, ...keepCodes]) {
      reportProblem({ id: `${code}:plan-769-probe`, severity: 'warning', code, title: `probe ${code}`, detail: 'plan-769 9.12 probe' });
    }
    handle.viewer.blockageWatch.setOn(true);
    handle.viewer.clearModel();
    expect(handle.viewer.blockageWatch.status().on).toBe(false);
    expect(handle.viewer.blockageWatch.lastReport).toBeNull();
    const left = new Set(getProblems().map((p) => p.code));
    expect(clearCodes.filter((c) => left.has(c)), 'document-scoped codes left after clearModel()').toEqual([]);
    for (const c of keepCodes) expect(left.has(c), c).toBe(true);
  });

  it('a CustomRuntimeInstruction miss of model A is gone once model B is loaded', async () => {
    handle = await createTestViewer('webgl');
    const a = new Scene();
    a.name = 'ModelA';
    const holder = new Object3D();
    holder.name = 'Instr';
    holder.userData.realvirtual = {
      CustomRuntimeInstruction: { steps: [{ instruction: 'look', targetObjects: ['Gone/Part'] }] },
    };
    a.add(holder);
    const b = new Scene();
    b.name = 'ModelB';
    const plain = new Object3D();
    plain.name = 'Plain';
    b.add(plain);

    await handle.viewer.loadModel(urlOf(await glbOf(a)));
    expect(getProblems().filter((p) => p.code === UNRESOLVED_INSTRUCTION_TARGET_CODE).length,
      'model A reports its missing instruction target').toBe(1);
    await handle.viewer.loadModel(urlOf(await glbOf(b)));
    expect(getProblems().filter((p) => p.code === UNRESOLVED_INSTRUCTION_TARGET_CODE)).toEqual([]);
  });
});
