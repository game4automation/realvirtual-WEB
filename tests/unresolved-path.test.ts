// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.3 — references the migration cannot turn into an address (F4).
 *
 *  - `ambiguous` — the written path names two nodes of the file (same-named
 *    siblings): kept, never guessed, `reference-ambiguous`;
 *  - `synthetic-target` — the written path names a node the BAKE made (a group
 *    partition object): no identity, `reference-target-synthetic`;
 *  - `legacy-spelling` — the path exists only in the loader's renamed spelling
 *    (`Sep_1`): it binds (exact legacy Three step), `reference-legacy-spelling`;
 *  - `missing` — nothing answers: the path audit's `reference-unresolved` (1a: the
 *    migration adds no second entry for it); a later load of a repaired file heals.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { box, node, sceneToGlb } from './helpers/migrate-769-fixtures';

const DRIVE = { Direction: 'LinearX', TargetSpeed: 100 };

async function buildFile(opts: { withGone: boolean }): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const a = node('A');
  a.add(box('Pin', 0.1), box('Pin', 0.2)); // same-named siblings → "A/Pin" is ambiguous
  const twin = node('Twin');
  twin.add(node('Sep', { Drive: { ...DRIVE, TargetSpeed: 1 } }));
  const other = node('Other');
  other.add(node('Sep', { Drive: { ...DRIVE, TargetSpeed: 2 } })); // loads as "Sep_1"
  const coverA = box('CoverA', 0.3);
  coverA.userData.realvirtual = { Group: { GroupName: 'Covers' } };
  const coverB = box('CoverB', 0.4);
  coverB.userData.realvirtual = { Group: { GroupName: 'Covers' } };
  const panel = node('Panel', {
    CustomRuntimeInstruction: {
      steps: [{
        instruction: 'look',
        targetObjects: ['A/Pin', 'Other/Sep_1', 'Covers', 'Gone/Part'],
      }],
    },
  });
  scene.add(a, twin, other, coverA, coverB, panel);
  if (opts.withGone) {
    const gone = node('Gone');
    gone.add(node('Part', { Drive: { ...DRIVE, TargetSpeed: 3 } }));
    scene.add(gone);
  }
  return sceneToGlb(scene);
}

describe('plan-769 9.3 — unresolved paths', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; resetProblemsForTests(); });

  async function load(withGone: boolean): Promise<TestViewerHandle> {
    if (!h) h = await createTestViewer('webgl');
    await h.viewer.loadModel(withGone ? 'healed.glb' : 'broken.glb', { data: await buildFile({ withGone }) });
    h.viewer.auditReferences();
    return h;
  }

  const codes = () => getProblems().map((p) => `${p.code}|${p.title}`);

  it('ambiguous / legacy spelling / generated target → own Problems codes; resolveRef agrees', async () => {
    resetProblemsForTests();
    const { viewer } = await load(false);
    const reg = viewer.registry!;
    const panel = reg.getNode('Cell/Panel')!;
    expect(codes()).toContain('reference-ambiguous|Reference is ambiguous (kept): A/Pin');
    expect(codes()).toContain('reference-legacy-spelling|Reference uses a renamed spelling: Other/Sep_1');
    expect(codes()).toContain('reference-target-synthetic|Reference targets a generated node: Covers');
    const amb = reg.resolveRef(panel, 'A/Pin');
    expect(amb.status === 'unresolved' && amb.reason).toBe('ambiguous');
    const legacy = reg.resolveRef(panel, 'Other/Sep_1');
    expect(legacy.status).toBe('resolved');
    expect(legacy.status === 'resolved' && reg.getAuthoredPath(legacy.node)).toBe('Other/Sep');
    expect(reg.identityOfOccurrence('')!.migratePath('Other/Sep_1').via).toBe('legacy-three');
    const synthetic = reg.resolveRef(panel, 'Covers');
    expect(synthetic.status === 'unresolved' && synthetic.reason).toBe('missing');
    // The partition object exists, but it is the bake's, not the file's.
    expect(reg.getNode('Cell/Covers')?.userData._rvSynthetic).toBe(true);
    // Every finding names the referrer.
    for (const p of getProblems().filter((x) => x.code.startsWith('reference-') && x.code !== 'reference-unresolved' && x.code !== 'reference-rescued')) {
      expect(p.nodePath).toBe('Cell/Panel');
    }
  });

  it('missing → the audit\'s reference-unresolved (one entry); a repaired file heals on the next load', async () => {
    resetProblemsForTests();
    const { viewer } = await load(false);
    const panel = viewer.registry!.getNode('Cell/Panel')!;
    const gone = viewer.registry!.resolveRef(panel, 'Gone/Part');
    expect(gone.status === 'unresolved' && gone.reason).toBe('missing');
    const missing = getProblems().filter((p) => p.code === 'reference-unresolved' && p.title.includes('Gone/Part'));
    expect(missing).toHaveLength(1);
    // Next load, the node is there: no unresolved entry, the reference has an address.
    await load(true);
    expect(getProblems().filter((p) => p.title.includes('Gone/Part'))).toEqual([]);
    const healed = h!.viewer.registry!.resolveRef(h!.viewer.registry!.getNode('Cell/Panel')!, 'Gone/Part');
    expect(healed.status).toBe('resolved');
    // The migration findings were per document: the second load re-reported its own.
    expect(codes().filter((c) => c.startsWith('reference-ambiguous'))).toHaveLength(1);
  });

  it('clearModel drops every migration finding', async () => {
    resetProblemsForTests();
    const { viewer } = await load(false);
    expect(getProblems().some((p) => p.code === 'reference-ambiguous')).toBe(true);
    viewer.clearModel();
    expect(getProblems().filter((p) => ['reference-ambiguous', 'reference-legacy-spelling', 'reference-target-synthetic'].includes(p.code))).toEqual([]);
  });
});
