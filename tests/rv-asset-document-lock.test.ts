// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-462 B3 — the document refuses every mutation while something owns it.
 *
 * Before this, three of roughly forty MCP tools asked whether a test run was in
 * progress; every other way into the document accepted the edit, reported ok,
 * verified ok against the live TEST scene, and had it thrown away minutes later
 * when the run stopped. The silent-loss shape is the thing under test here, so
 * these tests are written per ENTRY POINT rather than per feature: what matters
 * is that there is no door left open, including the ones that are "not an op"
 * (`renameDocument`, `flushDraft`, `markSaved`, `restoreFromSnapshot`).
 *
 * The token half is tested separately: a lock that the wrong caller can release
 * is not a lock, and the case that actually happens is a timeout armed for one
 * run firing during the next.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  AssetDocument,
  DocumentLockedError,
  ERR_DOCUMENT_LOCKED,
  type DocumentLockToken,
} from '../src/core/editor/rv-asset-document';
import {
  __clearDraftStoresForTests,
  listAllDocumentDrafts,
} from '../src/core/ops/rv-document-drafts';
import { scratchAssetDocument } from './helpers/scratch-asset-document';

function makeViewer(): RVViewer {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const box = new Object3D();
  box.name = 'Box';
  box.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
  model.add(box);

  const registry = new NodeRegistry();
  model.traverse(n => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  return {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
  } as unknown as RVViewer;
}

/** Assert that `run` was refused with the machine-readable code, not some other error. */
async function expectLocked(run: () => unknown | Promise<unknown>): Promise<void> {
  let caught: unknown = null;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(DocumentLockedError);
  expect((caught as DocumentLockedError).code).toBe(ERR_DOCUMENT_LOCKED);
}

describe('plan-462 B3 — the asset document lock', () => {
  let viewer: RVViewer;
  let doc: AssetDocument;

  beforeEach(() => {
    viewer = makeViewer();
    doc = scratchAssetDocument(viewer, 'Locked');
  });

  // ── acquisition ──

  it('is free until it is taken, and reports who took it', () => {
    expect(doc.lockOwner).toBeNull();

    const token = doc.tryLock('test-run');

    expect(token).not.toBeNull();
    expect(doc.lockOwner).toEqual({ kind: 'test-run', startedAt: expect.any(Number) });
  });

  it('fails fast for a second holder rather than waiting', () => {
    doc.tryLock('test-run');

    expect(doc.tryLock('test-run')).toBeNull();
    // The second test run learns WHAT holds the document, which is the whole
    // reason the refusal is useful rather than merely correct.
    expect(doc.lockOwner?.kind).toBe('test-run');
  });

  it('refuses a save while a test run holds it, and a test start while a save does', () => {
    const test = doc.tryLock('test-run');
    expect(doc.tryLock('save')).toBeNull();
    doc.unlock(test);

    const save = doc.tryLock('save');
    expect(save).not.toBeNull();
    expect(doc.tryLock('test-run')).toBeNull();
  });

  it('suspends autosave for exactly as long as it is held', () => {
    expect(doc.isAutosaveSuspended).toBe(false);

    const token = doc.tryLock('test-run');
    expect(doc.isAutosaveSuspended).toBe(true);

    doc.unlock(token);
    expect(doc.isAutosaveSuspended).toBe(false);
  });

  // ── every mutation entry of Tabelle 1 ──

  describe('refuses every mutation entry while a test run holds the document', () => {
    let token: DocumentLockToken;

    beforeEach(() => {
      token = doc.tryLock('test-run')!;
      expect(token).not.toBeNull();
    });

    it('applyOp', async () => {
      await expectLocked(() => doc.applyOp({
        kind: 'setField', id: 'op1', at: 0, path: 'Asset/Box',
        component: 'Drive', field: 'TargetSpeed', value: 99, prev: 50,
      } as never));
    });

    it('withTransaction', async () => {
      await expectLocked(() => doc.withTransaction('Group edit', async () => {}));
    });

    it('undo', async () => { await expectLocked(() => doc.undo()); });

    it('redo', async () => { await expectLocked(() => doc.redo()); });

    it('importCad', async () => {
      await expectLocked(() => doc.importCad({
        cadlink: { Sha256: 'abc', Quality: 'medium', File: 'x.step' },
        glb: new ArrayBuffer(8),
      } as never));
    });

    it('replayOps', async () => { await expectLocked(() => doc.replayOps([])); });

    // "Not an op", and every one of them was a way past the old guard.
    it('renameDocument (metadata, not an op)', async () => {
      await expectLocked(() => doc.renameDocument('Renamed'));
    });

    it('flushDraft (writes the slot, and ignored the suspend flag outright)', async () => {
      await expectLocked(() => doc.flushDraft());
    });

    it('markSaved (clears the draft slot)', async () => {
      await expectLocked(() => doc.markSaved(doc.base, 'Saved'));
    });

    it('beginBaseSwap', async () => {
      await expectLocked(() => doc.beginBaseSwap());
    });

    it('discardBoundEdits', async () => {
      await expectLocked(() => doc.discardBoundEdits());
    });

    it('restoreFromSnapshot, for anyone who is not the token holder', async () => {
      const snapshot = doc.captureSessionState();
      await expectLocked(() => doc.restoreFromSnapshot(snapshot));
      await expectLocked(() => doc.restoreFromSnapshot(snapshot, doc.tryLock('save')));
    });

    it('but NOT restoreFromSnapshot for the token holder — that is how a run ends', () => {
      const snapshot = doc.captureSessionState();

      expect(() => doc.restoreFromSnapshot(snapshot, token)).not.toThrow();
      // Still held: putting the history back does not release the document.
      expect(doc.lockOwner?.kind).toBe('test-run');
    });

    it('and the refusal names the owner, so a client can say what to do', async () => {
      let caught: DocumentLockedError | null = null;
      try {
        await doc.applyOp({ kind: 'setField' } as never);
      } catch (e) { caught = e as DocumentLockedError; }

      expect(caught?.owner.kind).toBe('test-run');
      expect(caught?.message).toContain('test run');
      expect(caught?.message).toContain('Stop the test run first');
    });
  });

  it('lets everything through again once the lock is released', async () => {
    const token = doc.tryLock('test-run')!;
    await expectLocked(() => doc.renameDocument('Nope'));

    doc.unlock(token);

    expect(() => doc.renameDocument('Yes')).not.toThrow();
    expect(doc.name).toBe('Yes');
  });

  it('does not refuse the document its own methods while a SAVE holds it', () => {
    // A save legitimately re-bases the log from inside its own lock; making the
    // save owner block `markSaved` would make the save block itself. Saves are
    // excluded from each other at acquisition instead.
    doc.tryLock('save');

    expect(() => doc.renameDocument('Renamed during save')).not.toThrow();
  });

  // ── the token half ──

  it('is not released by a foreign token', () => {
    const held = doc.tryLock('test-run')!;
    const foreign: DocumentLockToken = {
      kind: 'test-run', token: Symbol('someone else'), generation: held.generation,
    };

    doc.unlock(foreign);

    expect(doc.lockOwner).not.toBeNull();
    doc.unlock(held);
    expect(doc.lockOwner).toBeNull();
  });

  it('is not released by an OLD token — the timeout-of-the-previous-run case', () => {
    // Run 1 takes the document, arms a timeout, and finishes normally.
    const first = doc.tryLock('test-run')!;
    doc.unlock(first);

    // Run 2 takes it. Only now does run 1's timeout fire.
    const second = doc.tryLock('test-run')!;
    expect(second.generation).toBeGreaterThan(first.generation);

    doc.unlock(first);

    expect(doc.lockOwner?.kind).toBe('test-run');
    expect(doc.holdsLock(second)).toBe(true);
  });

  it('treats releasing an unheld lock as a no-op, not an error', () => {
    const token = doc.tryLock('test-run')!;
    doc.unlock(token);

    expect(() => doc.unlock(token)).not.toThrow();
    expect(() => doc.unlock(null)).not.toThrow();
    expect(doc.lockOwner).toBeNull();
  });

  it('holdsLock answers only for the token that is actually holding it', () => {
    const token = doc.tryLock('test-run')!;

    expect(doc.holdsLock(token)).toBe(true);
    expect(doc.holdsLock(null)).toBe(false);
    expect(doc.holdsLock({ ...token, generation: token.generation + 1 })).toBe(false);
  });

  // ── lifecycle ──

  it('gives the document back on dispose, and invalidates the generation', () => {
    const token = doc.tryLock('test-run')!;

    doc.dispose();

    expect(doc.lockOwner).toBeNull();
    expect(doc.holdsLock(token)).toBe(false);
  });

  it('releases the lock when the holder fails, so the document is not stranded', async () => {
    // The shape of every error path in the test session: whatever went wrong,
    // the token is handed back — which is why `unlock` is a no-op rather than a
    // throw for a token that no longer holds anything.
    const token = doc.tryLock('test-run')!;
    try {
      await doc.applyOp({ kind: 'setField' } as never);
    } catch {
      doc.unlock(token);
    }

    expect(doc.lockOwner).toBeNull();
    expect(() => doc.renameDocument('Recovered')).not.toThrow();
  });
});

/**
 * plan-462 B3 follow-up — the cancelled write the lock owes back.
 *
 * `tryLock` cancels the armed draft write so the slot keeps describing the
 * state as it was when the lock was taken. Nothing rescheduled it, so the
 * sequence "edit → Save As → cancel the name prompt" left the crash-recovery
 * draft one edit behind for as long as the user did not touch the document
 * again. These pin both halves of the loan: a cancelled save gives the write
 * back, a completed one does not.
 */
describe('plan-462 B3 — unlock re-arms the draft write it cancelled', () => {
  let viewer: RVViewer;
  let boxPath: string;
  let doc: AssetDocument;

  beforeEach(async () => {
    await __clearDraftStoresForTests();
    vi.useFakeTimers();
    viewer = makeViewer();
    boxPath = NodeRegistry.computeNodePath(
      viewer.scene.getObjectByName('Box')!,
    );
    doc = scratchAssetDocument(viewer, 'Loaned');
  });

  afterEach(() => {
    doc.dispose();
    vi.useRealTimers();
  });

  /** Edit, then stop short of the 2000 ms debounce — a write is armed, nothing is stored. */
  async function editWithWriteStillArmed(): Promise<void> {
    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await vi.advanceTimersByTimeAsync(0);
    await doc.whenIdle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await listAllDocumentDrafts()).toHaveLength(0);
    expect(doc.hasUnpersistedWork()).toBe(true);
  }

  it('gives the write back when the save is cancelled', async () => {
    await editWithWriteStillArmed();

    // Save As opens, the prompt is cancelled, the lock goes back untouched.
    const token = doc.tryLock('save')!;
    expect(doc.hasUnpersistedWork()).toBe(false);
    doc.unlock(token);

    expect(doc.hasUnpersistedWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);

    const all = await listAllDocumentDrafts();
    expect(all).toHaveLength(1);
    expect(all[0].ops).toHaveLength(1);
  });

  it('does NOT give it back after a save that actually happened', async () => {
    await editWithWriteStillArmed();

    const token = doc.tryLock('save')!;
    await doc.markSaved(doc.base, 'Loaned');
    doc.unlock(token);

    expect(doc.dirty).toBe(false);
    expect(doc.hasUnpersistedWork()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);

    // The slot `markSaved` cleared stays cleared — re-arming here would have
    // written the pre-save log straight back over it.
    expect(await listAllDocumentDrafts()).toHaveLength(0);
  });

  it('does not re-arm when there was nothing armed to begin with', async () => {
    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await vi.advanceTimersByTimeAsync(0);
    await doc.whenIdle();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.hasUnpersistedWork()).toBe(false);

    const token = doc.tryLock('test-run')!;
    doc.unlock(token);

    expect(doc.hasUnpersistedWork()).toBe(false);
  });

  it('leaves a SUSPENDED autosave suspended', async () => {
    await editWithWriteStillArmed();
    // `suspendAutosave` cancels too, so the lock finds nothing armed and owes
    // nothing back — the point is that releasing does not resurrect it.
    doc.suspendAutosave();

    const token = doc.tryLock('test-run')!;
    doc.unlock(token);

    expect(doc.hasUnpersistedWork()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(await listAllDocumentDrafts()).toHaveLength(0);
  });
});
