// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-710 §9.6 / F7 — `hasUnpersistedWork` becomes a capability of the
 * document layer, and the PAGE guard asks it in every mode.
 *
 * The asymmetry this closes: "would a reload lose work" is a stricter question
 * than "is it dirty", and only the scene lineage could answer it. A scene knew
 * that an armed autosave timer is work that exists nowhere but in memory; an
 * asset document had the identical hazard — `RvDraftAutosave` debounces for two
 * seconds — and nothing asked. The unload guard is page-wide since plan-709, so
 * an asset left mid-write behind the planner or the HMI went unguarded in every
 * mode, editor included.
 *
 * The mechanism is a callback, not an intrinsic (R2-F1): `RvDocument` knows no
 * storage and no timers, so it cannot answer this itself — the layer that
 * scheduled the write does, through
 * {@link RvDocumentOptions.hasUnpersistedWork}. These tests drive that seam with
 * the REAL `RvDraftAutosave`, so the wiring is asserted rather than a mock of it.
 *
 * ## The other half of §9.6 lives elsewhere, on purpose
 *
 * The `canApply` base-swap gate (an op issued while a CAD re-import swaps the
 * document's base is dropped — not applied, not recorded) is asserted in
 * `mcp-editor-doc-mutations.test.ts` → "the asset canApply gate", where it can
 * be driven through the REAL MCP tools as an agent would issue it. Duplicating
 * it here with a weaker double would add a second, less honest witness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RvDocument } from '../src/core/ops/rv-document';
import { RvDraftAutosave, rootFrame, clearDocumentDraft } from '../src/core/ops/rv-document-drafts';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import type { RvOp } from '../src/core/ops/rv-unified-ops';

// ─── Doubles ──────────────────────────────────────────────────────────────

const noopExecutor = {
  async applyForward(): Promise<void> {},
  async applyInverse(): Promise<void> {},
};

let docSeq = 0;

/**
 * A document wired to the ONE draft writer, exactly as `AssetDocument` wires it.
 *
 * The short debounce is the only difference from production: the seam under
 * test is "an armed timer is unpersisted work", and 2000 ms of real time would
 * assert nothing extra.
 */
function makeAssetLikeDocument(delayMs = 40) {
  const frame = rootFrame('prj_guards', `doc_${++docSeq}`);
  const autosave = new RvDraftAutosave({
    frame,
    shell: () => ({
      id: frame.rootDocumentId,
      name: 'Gripper',
      base: { kind: 'empty' },
      createdAt: Date.now(),
    }),
    delayMs,
  });
  const doc = new RvDocument({
    id: frame.rootDocumentId,
    name: 'Gripper',
    mode: 'asset',
    executor: noopExecutor,
    onChanged: (d) => { autosave.onChanged(d); },
    hasUnpersistedWork: () => autosave.hasPendingWrite,
  });
  return { doc, autosave, frame };
}

function edit(n: number): RvOp {
  return {
    id: `op_${n}`, ts: Date.now(), schemaV: 1, kind: 'renameNode',
    nodePath: 'Box', name: `Box${n}`, prevName: 'Box',
  } as unknown as RvOp;
}

const open: { autosave: RvDraftAutosave; frame: ReturnType<typeof rootFrame> }[] = [];

function makeDocument(delayMs?: number) {
  const made = makeAssetLikeDocument(delayMs);
  open.push({ autosave: made.autosave, frame: made.frame });
  return made;
}

beforeEach(() => { resetProjectStore(); });

afterEach(async () => {
  for (const { autosave, frame } of open.splice(0)) {
    autosave.dispose();
    await clearDocumentDraft(frame).catch(() => {});
  }
});

// ─── The document layer ───────────────────────────────────────────────────

describe('RvDocument.hasUnpersistedWork — the callback seam (R2-F1)', () => {
  it('is false with no callback: no storage behind it, nothing to lose', () => {
    const doc = new RvDocument({
      id: 'bare', name: 'Bare', mode: 'asset', executor: noopExecutor,
    });
    // "Absent" means nothing is outstanding, not "unknown". A guard that asks
    // on a headless boot is the guard people learn to dismiss.
    expect(doc.hasUnpersistedWork()).toBe(false);
    expect(doc.dirty).toBe(false);
  });

  it('an armed draft timer IS unpersisted work — and stops being one on flush', async () => {
    const { doc, autosave } = makeDocument();

    expect(doc.hasUnpersistedWork()).toBe(false);

    await doc.applyOp(edit(1));
    // The edit is in memory and on the debounce; nothing has reached storage.
    expect(doc.dirty).toBe(true);
    expect(doc.hasUnpersistedWork()).toBe(true);

    await autosave.flush();
    // Written. The document is still DIRTY — it differs from its last save —
    // but a reload no longer loses it, which is the distinction this question
    // exists to draw.
    expect(doc.dirty).toBe(true);
    expect(doc.hasUnpersistedWork()).toBe(false);
  });

  it('the debounce firing on its own clears it too', async () => {
    const { doc } = makeDocument(30);
    await doc.applyOp(edit(2));
    expect(doc.hasUnpersistedWork()).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 120));

    expect(doc.hasUnpersistedWork()).toBe(false);
  });
});

// ─── The page guard (R2-N6) ───────────────────────────────────────────────

describe('ProjectStore.hasUnpersistedWork — the page guard, in every mode', () => {
  it('is silent with nothing open', () => {
    expect(getProjectStore().hasUnpersistedWork()).toBe(false);
  });

  it('CROSS-MODE: an asset mid-write is guarded while the user stands in the planner', async () => {
    const store = getProjectStore();
    const { doc } = makeDocument();

    // The probe the editor plugin installs for the whole app lifetime — not per
    // mode. That lifetime is the point: the question is asked from surfaces
    // where the editor plugin is inactive.
    store.setUnpersistedWorkProbe(() => doc.hasUnpersistedWork());

    // No scene store attached, no dirty-documents probe: the active mode here
    // is emphatically NOT the editor. Before F7 this answered false and the
    // reload took the edit with it.
    expect(store.hasUnpersistedWork()).toBe(false);

    await doc.applyOp(edit(3));
    expect(store.hasUnpersistedWork()).toBe(true);
  });

  it('goes quiet again once the write lands', async () => {
    const store = getProjectStore();
    const { doc, autosave } = makeDocument();
    store.setUnpersistedWorkProbe(() => doc.hasUnpersistedWork());

    await doc.applyOp(edit(4));
    expect(store.hasUnpersistedWork()).toBe(true);

    await autosave.flush();
    expect(store.hasUnpersistedWork()).toBe(false);
  });

  it('a removed probe stops answering', async () => {
    const store = getProjectStore();
    const { doc } = makeDocument();
    store.setUnpersistedWorkProbe(() => doc.hasUnpersistedWork());
    await doc.applyOp(edit(5));
    expect(store.hasUnpersistedWork()).toBe(true);

    store.setUnpersistedWorkProbe(null);
    expect(store.hasUnpersistedWork()).toBe(false);
  });

  it('a throwing probe must not wedge the page behind a dialog nobody can explain', () => {
    const store = getProjectStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.setUnpersistedWorkProbe(() => { throw new Error('probe broke'); });

    expect(store.hasUnpersistedWork()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── The pin against side effects (R2-N6) ─────────────────────────────────

describe('hasUnsavedWork is NOT affected by F7', () => {
  it('an armed timer alone does not make the project switch ask', async () => {
    const store = getProjectStore();
    const { doc } = makeDocument();
    store.setUnpersistedWorkProbe(() => doc.hasUnpersistedWork());

    await doc.applyOp(edit(6));

    // The page guard's question — "would a reload destroy work" — is now true.
    expect(store.hasUnpersistedWork()).toBe(true);
    // The project switch/close guard asks a DIFFERENT question through a
    // different probe, and this change must not have widened it. Verified
    // deliberately: routing F7 through `ProjectDirtyDocument` instead would
    // have altered the switch dialog as a side effect of fixing the unload
    // guard, and nothing in the plan asked for that.
    expect(store.hasUnsavedWork()).toBe(false);
  });

  it('and the dirty-documents probe still drives it, untouched', () => {
    const store = getProjectStore();
    store.setDirtyDocumentsProbe(() => [{ name: 'Filler', depth: 0 }]);

    expect(store.hasUnsavedWork()).toBe(true);
    // …while the unload guard, with no unpersisted-work probe installed, has
    // nothing to say about it. Two questions, two answers.
    expect(store.hasUnpersistedWork()).toBe(true);   // dirty documents count here too
  });
});
