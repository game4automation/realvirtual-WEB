// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-719 §2.9 — a draft written before this plan must not become data loss.
 *
 * Records persisted by an older build can carry `shell.base = {kind:'empty'}`.
 * After the union collapse nothing in the editor's `_loadBase` matches that
 * kind any more, so the recovery path would replay the op log against an empty
 * scene and silently lose the user's work. The migration turns the stale record
 * into a REAL document before the replay — and it has to do so exactly once,
 * because a create that runs again on the next load leaves a trail of empty
 * documents behind every reopened draft.
 *
 * The three statements below are the whole contract:
 *  (a) a stale draft becomes a document, and the ops then replay onto it;
 *  (b) loading the same stale draft twice creates ONE document;
 *  (c) without a writable project nothing is created, nothing is discarded,
 *      and the caller is told — never a silent no-load.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  migrateLegacyEmptyDraft,
  type LegacyEmptyDraftIo,
} from '../src/core/editor/rv-asset-draft-storage';
import type { AssetDraftBase } from '../src/core/editor/rv-asset-draft-storage';

/**
 * A draft slot with the persistence the real one has: `rebase` writes the
 * converted identity BACK, which is what makes a second load a pass-through
 * rather than a second create.
 */
function makeSlot(base: unknown, name = 'Untitled') {
  const slot = { shell: { name, base } };
  const created: string[] = [];
  const io: LegacyEmptyDraftIo = {
    isWritable: () => true,
    createDocument: async (n: string) => {
      created.push(n);
      return { documentId: `doc_${created.length}`, path: `Untitled_${created.length}.glb`, name: n };
    },
    rebase: async (next) => { slot.shell.base = next; },
  };
  return { slot, created, io };
}

describe('migrateLegacyEmptyDraft (plan-719 §2.9)', () => {
  it('turns a stale empty draft into a real document', async () => {
    const { slot, created, io } = makeSlot({ kind: 'empty' });

    const base = await migrateLegacyEmptyDraft(slot as never, io);

    expect(base).toMatchObject({ kind: 'document', documentId: 'doc_1' });
    expect(created).toEqual(['Untitled']);
    // The slot now carries the document — the idempotency marker.
    expect((slot.shell.base as { kind: string }).kind).toBe('document');
  });

  it('creates exactly ONE document when the same stale draft is loaded twice', async () => {
    const { slot, created, io } = makeSlot({ kind: 'empty' });

    const first = await migrateLegacyEmptyDraft(slot as never, io);
    const second = await migrateLegacyEmptyDraft(slot as never, io);

    expect(created).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('leaves a draft alone — and says so — when nothing is writable', async () => {
    const { slot, created, io } = makeSlot({ kind: 'empty' });
    const readOnly: LegacyEmptyDraftIo = { ...io, isWritable: () => false };

    const base = await migrateLegacyEmptyDraft(slot as never, readOnly);

    // `null` is the "tell the user" signal — never a silent discard.
    expect(base).toBeNull();
    expect(created).toHaveLength(0);
    // The record is untouched, so a later load in a writable project recovers it.
    expect((slot.shell.base as { kind: string }).kind).toBe('empty');
  });

  it('does no I/O at all for a draft that already names a document', async () => {
    const already: AssetDraftBase = {
      kind: 'document', documentId: 'doc_x', path: 'models/Cell.glb', name: 'Cell',
    };
    const { slot, created, io } = makeSlot(already, 'Cell');
    const spy = vi.spyOn(io, 'createDocument');

    const base = await migrateLegacyEmptyDraft(slot as never, io);

    expect(base).toEqual(already);
    expect(spy).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('propagates a failed create rather than pretending the draft is gone', async () => {
    const { slot, io } = makeSlot({ kind: 'empty' });
    const failing: LegacyEmptyDraftIo = {
      ...io,
      createDocument: async () => { throw new Error('This project cannot be written to.'); },
    };

    await expect(migrateLegacyEmptyDraft(slot as never, failing)).rejects.toThrow(/cannot be written/);
    // Nothing was rebased, so a retry still sees the stale record.
    expect((slot.shell.base as { kind: string }).kind).toBe('empty');
  });
});
