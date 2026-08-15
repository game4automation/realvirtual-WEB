// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The draft READER — one writer, one keyspace (plan-710 Phase 2).
 *
 * This file used to pin the two-keyspace precedence rule (newest wins, ties to
 * the frame slot). That rule is gone with the legacy slot it arbitrated. What is
 * pinned now is what survives it: which stack is offered back, which records the
 * editor refuses outright, and that nothing in a recovered stack disappears
 * without the offer saying so.
 *
 * Pure over the record shape; no IndexedDB, no renderer.
 */

import { describe, it, expect } from 'vitest';
import {
  assetDraftOfFrame,
  chooseEditorDraft,
  chooseRecoveryRoot,
  describeDraftRecovery,
  describeStackRecovery,
} from '../src/core/editor/rv-editor-draft-recovery';
import type {
  RvDocumentDraft,
  RvStackRecoveryPlan,
} from '../src/core/ops/rv-document-drafts';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import {
  libraryDocumentBase,
} from '../src/core/editor/active-asset-store';

function frameRecord(over: Partial<RvDocumentDraft> = {}): RvDocumentDraft {
  return {
    key: 'p1:doc_root:',
    frame: { projectId: 'p1', rootDocumentId: 'doc_root', occurrence: '' },
    depth: 0,
    shell: {
      id: 'doc_root',
      name: 'Filler',
      base: libraryDocumentBase('Custom/Filler.glb'),
      createdAt: 1000,
    },
    ops: [],
    savedAt: 5000,
    ...over,
  };
}


function plan(frames: RvDocumentDraft[], cleanAncestors: string[] = []): RvStackRecoveryPlan {
  return {
    frames,
    savedAt: frames.reduce((m, f) => Math.max(m, f.savedAt), 0),
    cleanAncestors,
  };
}

describe('assetDraftOfFrame', () => {
  it('converts a frame record into the shape the open path speaks', () => {
    const draft = assetDraftOfFrame(frameRecord());
    expect(draft).not.toBeNull();
    expect(draft!.shell.id).toBe('doc_root');
    expect(draft!.shell.name).toBe('Filler');
    expect(draft!.shell.base).toEqual(libraryDocumentBase('Custom/Filler.glb'));
    expect(draft!.savedAt).toBe(5000);
  });

  it('refuses a scene-lineage baked-bytes record — the editor cannot open one', () => {
    const scene = frameRecord({
      shell: {
        id: 's1',
        name: 'Plant',
        base: { kind: 'sceneGlbSlot', slot: 'draft/plant', label: 'Plant' },
        createdAt: 1,
      },
    });
    expect(assetDraftOfFrame(scene)).toBeNull();
  });

  it('carries the ops through VERBATIM — there is one vocabulary, so nothing converts', () => {
    // Before plan-710 this path lowered each op into a second vocabulary and
    // DROPPED whatever would not lower. Both halves of that are gone: the frame
    // record and the editor's draft are the same records, and a scene-lineage op
    // is routed by the executor at replay time rather than censored here — which
    // is also the only way it can ever come back if the frame is reopened
    // elsewhere.
    const assetOp = {
      id: 'op1', kind: 'renameNode', nodePath: 'A', name: 'B', prev: 'A',
    } as unknown as RvOp;
    const sceneOnly = {
      id: 'op2', kind: 'addPlacement', placement: {},
    } as unknown as RvOp;
    const draft = assetDraftOfFrame(frameRecord({ ops: [assetOp, sceneOnly] }));
    expect(draft!.ops).toHaveLength(2);
    expect(draft!.ops.map((o) => o.kind)).toEqual(['renameNode', 'addPlacement']);
  });
});

describe('chooseRecoveryRoot', () => {
  it('returns null when nothing was left behind', () => {
    expect(chooseRecoveryRoot([], 'p1')).toBeNull();
  });

  it('ignores leftovers belonging to another project', () => {
    const other = frameRecord({
      frame: { projectId: 'p2', rootDocumentId: 'doc_other', occurrence: '' },
    });
    expect(chooseRecoveryRoot([other], 'p1')).toBeNull();
    expect(chooseRecoveryRoot([other], 'p2'))
      .toEqual({ projectId: 'p2', rootDocumentId: 'doc_other' });
  });

  it('treats "no project" as its own namespace, not as a wildcard', () => {
    const bare = frameRecord({
      frame: { projectId: null, rootDocumentId: 'doc_bare', occurrence: '' },
    });
    expect(chooseRecoveryRoot([bare], 'p1')).toBeNull();
    expect(chooseRecoveryRoot([bare], null))
      .toEqual({ projectId: null, rootDocumentId: 'doc_bare' });
  });

  it('picks the most recently written stack, not the deepest', () => {
    const oldDeep = frameRecord({
      frame: { projectId: 'p1', rootDocumentId: 'doc_old', occurrence: 'a/b/c' },
      depth: 3,
      savedAt: 100,
    });
    const newShallow = frameRecord({
      frame: { projectId: 'p1', rootDocumentId: 'doc_new', occurrence: '' },
      depth: 0,
      savedAt: 900,
    });
    expect(chooseRecoveryRoot([oldDeep, newShallow], 'p1'))
      .toEqual({ projectId: 'p1', rootDocumentId: 'doc_new' });
  });
});

describe('chooseEditorDraft — ONE keyspace since plan-710 Phase 2', () => {
  it('offers nothing when there is no plan, and nothing when the plan is empty', () => {
    expect(chooseEditorDraft(null)).toBeNull();
    expect(chooseEditorDraft(plan([]))).toBeNull();
  });

  it('offers the root frame of the recovered stack', () => {
    const choice = chooseEditorDraft(plan([frameRecord()]))!;
    expect(choice.source).toBe('frame');
    expect(choice.draft.shell.id).toBe('doc_root');
  });

  it('offers NOTHING when the root frame is a scene draft — there is no second slot to fall back to', () => {
    // Before Phase 2 this fell back to the legacy slot. That slot is gone, so a
    // scene-lineage record is simply not an editor draft: the editor opens its
    // normal fallback chain instead of the wrong document.
    const scene = frameRecord({
      savedAt: 9999,
      shell: {
        id: 's1', name: 'Plant', createdAt: 1,
        base: { kind: 'sceneGlbSlot', slot: 'draft/plant', label: 'Plant' },
      },
    });
    expect(chooseEditorDraft(plan([scene]))).toBeNull();
  });

  it('carries the whole stack along, not just the frame it opens', () => {
    const root = frameRecord({ savedAt: 100 });
    const child = frameRecord({
      key: 'p1:doc_root:ref1',
      frame: { projectId: 'p1', rootDocumentId: 'doc_root', occurrence: 'ref1' },
      depth: 1,
      shell: { ...frameRecord().shell, id: 'doc_child', name: 'Gripper' },
      savedAt: 200,
    });
    const choice = chooseEditorDraft(plan([root, child], ['']))!;
    expect(choice.draft.shell.id).toBe('doc_root');   // the bottom frame opens
    expect(choice.stack).toHaveLength(2);              // the child is not dropped
    expect(choice.cleanAncestors).toEqual(['']);
  });
});

describe('describeStackRecovery — nothing vanishes unmentioned', () => {
  it('says nothing about a plain single-document draft', () => {
    expect(describeStackRecovery(chooseEditorDraft(plan([frameRecord()]))!)).toBeNull();
  });

  it('names the deeper frames the editor cannot reinstate yet', () => {
    const root = frameRecord();
    const child = frameRecord({
      frame: { projectId: 'p1', rootDocumentId: 'doc_root', occurrence: 'ref1' },
      depth: 1,
      shell: { ...root.shell, id: 'doc_child' },
    });
    const text = describeStackRecovery(chooseEditorDraft(plan([root, child]))!);
    expect(text).toContain('1 further document below it');
  });

  it('names the clean intermediates a per-level restore would skip', () => {
    const deep = frameRecord({
      frame: { projectId: 'p1', rootDocumentId: 'doc_root', occurrence: 'a/b' },
      depth: 2,
    });
    const text = describeStackRecovery(chooseEditorDraft(plan([deep], ['', 'a']))!);
    expect(text).toContain('2 levels were descended through');
  });
});

describe('describeDraftRecovery — what the offer dialog has to say', () => {
  it('reports the root document, its op count and the newest timestamp in the stack', () => {
    const root = frameRecord({ ops: [{} as RvOp, {} as RvOp], savedAt: 5000 });
    const child = frameRecord({
      frame: { projectId: 'p1', rootDocumentId: 'doc_root', occurrence: 'ref1' },
      depth: 1,
      shell: { ...root.shell, id: 'doc_child', name: 'Gripper' },
      ops: [{} as RvOp],
      savedAt: 9000,
    });
    const info = describeDraftRecovery(chooseEditorDraft(plan([root, child]))!);

    expect(info.name).toBe('Filler');
    expect(info.opCount).toBe(2);
    // NEWEST in the stack, not the root's: after a crash the user recognises
    // the session by the last thing they touched, three levels down or not.
    expect(info.savedAt).toBe(9000);
  });

  it('names every deeper frame, so a Discard cannot swallow one unmentioned', () => {
    const root = frameRecord();
    const child = frameRecord({
      frame: { projectId: 'p1', rootDocumentId: 'doc_root', occurrence: 'ref1' },
      depth: 1,
      shell: { ...root.shell, id: 'doc_child', name: 'Gripper' },
      ops: [{} as RvOp, {} as RvOp, {} as RvOp],
    });
    const info = describeDraftRecovery(chooseEditorDraft(plan([root, child]))!);

    expect(info.deeperFrames).toEqual([{ name: 'Gripper', depth: 1, opCount: 3 }]);
  });

  it('counts the levels that were only descended through', () => {
    const deep = frameRecord({
      frame: { projectId: 'p1', rootDocumentId: 'doc_root', occurrence: 'a/b' },
      depth: 2,
    });
    const info = describeDraftRecovery(chooseEditorDraft(plan([deep], ['', 'a']))!);
    expect(info.cleanAncestors).toBe(2);
  });

  it('a lone root frame carries no stack and no note', () => {
    const solo = frameRecord({
      savedAt: 1234,
      shell: { ...frameRecord().shell, id: 'doc_solo', name: 'Solo' },
    });
    const info = describeDraftRecovery(chooseEditorDraft(plan([solo]))!);
    expect(info.name).toBe('Solo');
    expect(info.savedAt).toBe(1234);
    expect(info.deeperFrames).toEqual([]);
    expect(info.cleanAncestors).toBe(0);
    expect(info.note).toBeNull();
  });
});
