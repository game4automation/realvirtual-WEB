// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.13 — the Mauser reference baseline (Phase-1 acceptance).
 *
 * CI: a REDUCED Mauser-like file built here (checked in as code — deterministic
 * bytes), with the two shapes that made Mauser fail:
 *  - the "46": references into `UsedWhenOperatingTwinWithoutPLC_Connection/Logic
 *    Steps Module 3/*`, a subtree the export does not contain (Grip.SignalPick,
 *    LogicStep_SetSignalBool.Signal, LogicStep_WaitForSignalBool.Signal, CRI.signal);
 *  - the rename + move core: instruction targets under a part the loader renames
 *    (`Sub` → `Sub_1`) AND the Kinematic hook re-parents;
 *  - plus `Source.ThisObjectAsMU` holding a PATH in the name field (the 47th — healed).
 * Acceptance: `reference-rescued` 0, `unresolved-instruction-target` 0, and the
 * unresolved stored references are exactly the missing-subtree ones.
 *
 * LOCAL (skipped in CI): the real `MauserCageline30.glb` against the checked-in
 * snapshot (`tests/fixtures/reference-baseline.json`). Browser tests cannot read
 * the process environment, only `VITE_*` — run with
 *   VITE_RV_MAUSER_GLB=/private-models/mauser3dhmi/MauserCageline30.glb npx vitest run tests/mauser-reference-baseline.test.ts
 * (the URL is served by the dev server's private-models route).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { getProblems, resetProblemsForTests, UNRESOLVED_INSTRUCTION_TARGET_CODE } from '../src/core/hmi/problems-store';
import { auditReferences } from '../src/core/engine/rv-reference-audit';
import { CR, box, node, sceneToGlb } from './helpers/migrate-769-fixtures';
import baseline from './fixtures/reference-baseline.json';

const MODULE3 = 'UsedWhenOperatingTwinWithoutPLC_Connection/Logic Steps Module 3';
const DRIVE = { Direction: 'LinearX', TargetSpeed: 100 };

async function buildReducedMauserGlb(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'MauserLike';
  const cad = node('CAD_Objects');
  const asmA = node('AsmA');
  const subA = node('Sub', { Drive: { ...DRIVE, TargetSpeed: 111 } });
  subA.add(box('Part', 0.1));
  asmA.add(subA);
  const asmB = node('AsmB');
  const subB = node('Sub', {
    Kinematic: { KinematicParentEnable: true, Parent: 'Kinematics/Table' },
    Drive: { ...DRIVE, TargetSpeed: 222 },
  });
  const partB = box('Part', 0.2);
  partB.add(box('Screw', 0.05));
  subB.add(partB);
  asmB.add(subB);
  cad.add(asmA, asmB);
  const kin = node('Kinematics');
  const table = node('Table', { Drive: { ...DRIVE, TargetSpeed: 333 } });
  table.add(node('Gripper', { Grip: { SignalPick: CR(`${MODULE3}/Table_Arrestor_Closed`, 'realvirtual.PLCOutputBool') } }));
  kin.add(table);
  const used = node('UsedWhenOperatingTwinWithoutPLC_Connection');
  const module2 = node('Logic Steps Module 2');
  module2.add(
    node('Set', { LogicStep_SetSignalBool: { Signal: CR(`${MODULE3}/StartPutDownSteps_rv1`, 'realvirtual.PLCInputBool'), SetToTrue: true } }),
    node('Wait', { LogicStep_WaitForSignalBool: { Signal: CR(`${MODULE3}/PutDownDone`, 'realvirtual.PLCOutputBool'), WaitForTrue: true } }),
  );
  used.add(module2);
  const tube = node('Tube');
  tube.add(box('TubeMU', 0.15));
  const src = node('TubeSource', { Source: { ThisObjectAsMU: 'Tube/TubeMU', Interval: 0, AutomaticGeneration: false } });
  const panel = node('Panel', {
    CustomRuntimeInstruction: {
      signal: CR(`${MODULE3}/Alarm`, 'realvirtual.PLCOutputBool'),
      steps: [
        { instruction: 'part', targetObjects: ['CAD_Objects/AsmB/Sub/Part'] },
        { instruction: 'screw', targetObjects: ['CAD_Objects/AsmB/Sub/Part/Screw'] },
        { instruction: 'axis', targetObjects: ['CAD_Objects/AsmB/Sub'] },
      ],
    },
  });
  scene.add(cad, kin, used, tube, src, panel);
  return sceneToGlb(scene);
}

interface MauserNumbers {
  rescued: number;
  auditUnresolved: number;
  instructionTargets: number;
  unresolvedPath: number;
  migrationAmbiguous: number;
  problemsRescued: number;
}

function numbersOf(h: TestViewerHandle): MauserNumbers {
  const reg = h.viewer.registry!;
  const audit = auditReferences(reg);
  const identity = reg.identityOfOccurrence('')!;
  return {
    rescued: audit.counts.rescued,
    auditUnresolved: audit.counts.unresolved,
    instructionTargets: getProblems().filter((p) => p.code === UNRESOLVED_INSTRUCTION_TARGET_CODE).length,
    unresolvedPath: identity.counts.missing + identity.counts.ambiguous,
    migrationAmbiguous: identity.counts.ambiguous,
    problemsRescued: getProblems().filter((p) => p.code === 'reference-rescued').length,
  };
}

describe('plan-769 9.13 — Mauser reference baseline (CI: reduced fixture)', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; resetProblemsForTests(); });

  it('rescued 0, unresolved-instruction-target 0; unresolved = exactly the missing Module-3 subtree', async () => {
    resetProblemsForTests();
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('mauser-reduced.glb', { data: await buildReducedMauserGlb() });
    const reg = h.viewer.registry!;
    const n = numbersOf(h);
    expect(n.rescued).toBe(0);
    expect(n.problemsRescued).toBe(0);
    expect(n.instructionTargets).toBe(0);
    const identity = reg.identityOfOccurrence('')!;
    const missing = identity.findings.filter((f) => f.outcome === 'missing').map((f) => `${f.componentType}.${f.field}`).sort();
    expect(missing).toEqual([
      'CustomRuntimeInstruction.signal', 'Grip.SignalPick',
      'LogicStep_SetSignalBool.Signal', 'LogicStep_WaitForSignalBool.Signal',
    ]);
    expect(identity.findings.filter((f) => f.outcome === 'missing').every((f) => f.writtenPath.startsWith(`${MODULE3}/`))).toBe(true);
    expect(n.unresolvedPath).toBe(4);
    expect(n.auditUnresolved).toBe(4);
    // The rename + move core: every instruction target resolves to its AUTHORED node.
    const panel = reg.getNode('MauserLike/Panel')!;
    for (const target of ['CAD_Objects/AsmB/Sub/Part', 'CAD_Objects/AsmB/Sub/Part/Screw', 'CAD_Objects/AsmB/Sub']) {
      const r = reg.resolveRef(panel, target);
      expect(r.status, target).toBe('resolved');
      expect(r.status === 'resolved' && reg.getAuthoredPath(r.node)).toBe(target);
    }
    // The 47th: a path in the NAME field heals (name-as-path).
    const srcNode = reg.getNode('MauserLike/TubeSource')!;
    const template = reg.componentOn<{ muTemplate: { name: string } | null }>(srcNode, 'Source')?.muTemplate;
    expect(template && reg.getAuthoredPath(template as never)).toBe('Tube/TubeMU');
  });
});

const MAUSER_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_RV_MAUSER_GLB;
const MAUSER_KEY = 'private:projects/mauser3dhmi/models/MauserCageline30.glb';

describe.skipIf(!MAUSER_URL)('plan-769 9.13 — Mauser Cageline30 (LOCAL, VITE_RV_MAUSER_GLB)', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; resetProblemsForTests(); });

  it('reference-rescued 0, unresolved-instruction-target 0, unresolvedPath = the snapshot', async () => {
    resetProblemsForTests();
    // Fetch BEFORE the test viewer exists (it guards network access).
    const res = await fetch(MAUSER_URL!);
    expect(res.ok).toBe(true);
    const bytes = await res.arrayBuffer();
    h = await createTestViewer('webgl');
    const t0 = performance.now();
    await h.viewer.loadModel('MauserCageline30.glb', { data: bytes });
    const loadMs = Math.round(performance.now() - t0);
    const n = numbersOf(h);
    const snap = (baseline as { glbs: Record<string, { refs: { unresolved: { missing: number; ambiguous: number } } }> }).glbs[MAUSER_KEY]!;
    const snapUnresolved = snap.refs.unresolved.missing + snap.refs.unresolved.ambiguous;
    console.log(`[9.13 Mauser] ${JSON.stringify({ ...n, snapshotUnresolvedPath: snapUnresolved, loadMs })}`);
    expect(n.rescued).toBe(0);
    expect(n.problemsRescued).toBe(0);
    expect(n.instructionTargets).toBe(0);
    expect(n.unresolvedPath).toBe(snapUnresolved);
  }, 600_000);
});
