// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-478 §9.2 — the persisted half of the ring.
 *
 * Four things only this layer can get wrong: a `setItem` that throws (Safari
 * private mode), a write made by ANOTHER tab, a read-modify-write that loses
 * the other tab's row, and the key colliding with the boot cleanup that
 * deletes its almost-namesake.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LS_KEY_RECENT_DOCUMENTS,
  clearRecents,
  currentOpenIntentMode,
  forgetRecent,
  forgetRecentsOfProject,
  handleRecentsStorageEvent,
  isOpenIntentActive,
  readRecents,
  recordRecentForOpen,
  retagOpenDocumentMode,
  retagRecentDocumentPath,
  subscribeRecents,
  withOpenIntentMode,
  __resetRecentsSnapshot,
} from '../src/core/project/rv-project-recents-store';
import {
  RECENTS_SCHEMA_VERSION,
  serialiseRecents,
  type RecentDocumentEntry,
} from '../src/core/project/rv-project-recents';
import { runLegacyCleanup } from '../src/core/project/rv-project-legacy-cleanup';

function facts(over: Partial<Parameters<typeof recordRecentForOpen>[0]> = {}) {
  return {
    projectId: 'P',
    backend: 'folder' as const,
    documentId: 'doc_a',
    documentName: 'A',
    documentPath: 'models/a.glb',
    projectName: 'Project',
    activeMode: 'hmi',
    ...over,
  };
}

function stored(): RecentDocumentEntry[] {
  const raw = localStorage.getItem(LS_KEY_RECENT_DOCUMENTS);
  return raw ? JSON.parse(raw).items : [];
}

beforeEach(() => {
  localStorage.removeItem(LS_KEY_RECENT_DOCUMENTS);
  __resetRecentsSnapshot();
  vi.restoreAllMocks();
});

describe('recording', () => {
  it('writes one entry and publishes it', () => {
    let notified = 0;
    const off = subscribeRecents(() => { notified++; });
    recordRecentForOpen(facts());
    expect(readRecents()).toHaveLength(1);
    expect(readRecents()[0]).toMatchObject({ documentId: 'doc_a', mode: 'hmi' });
    expect(notified).toBe(1);
    off();
  });

  it('a kiosk lock records NOTHING at all (F5)', () => {
    recordRecentForOpen(facts({ lockedMode: 'hmi' }));
    expect(readRecents()).toEqual([]);
    expect(localStorage.getItem(LS_KEY_RECENT_DOCUMENTS)).toBeNull();
  });

  it('an open without a project or a backend is not a ring entry', () => {
    recordRecentForOpen(facts({ projectId: null }));
    recordRecentForOpen(facts({ backend: null }));
    expect(readRecents()).toEqual([]);
  });

  it('a throwing setItem keeps the in-memory snapshot standing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => recordRecentForOpen(facts())).not.toThrow();
    expect(readRecents()).toHaveLength(1);
  });
});

describe('the open-intent scope', () => {
  it('the intended mode wins over the live one, and retagging is inert inside', async () => {
    await withOpenIntentMode('editor', async () => {
      expect(currentOpenIntentMode()).toBe('editor');
      expect(isOpenIntentActive()).toBe(true);
      recordRecentForOpen(facts({ activeMode: 'viewer' }));
      retagOpenDocumentMode('P', 'doc_a', 'viewer');
    });
    expect(readRecents()[0].mode).toBe('editor');
    expect(isOpenIntentActive()).toBe(false);
  });

  it('a null scope still suppresses retagging without forcing a mode', async () => {
    await withOpenIntentMode(null, async () => {
      recordRecentForOpen(facts({ activeMode: 'planner' }));
      retagOpenDocumentMode('P', 'doc_a', 'viewer');
    });
    expect(readRecents()[0].mode).toBe('planner');
  });

  it('two scopes finishing in REVERSE order leave no scope standing (R3-2)', async () => {
    let releaseInner!: () => void;
    const innerGate = new Promise<void>(r => { releaseInner = r; });
    let releaseOuter!: () => void;
    const outerGate = new Promise<void>(r => { releaseOuter = r; });

    const outer = withOpenIntentMode('editor', async () => { await outerGate; });
    const inner = withOpenIntentMode('planner', async () => { await innerGate; });

    // The one that STARTED second finishes FIRST — a depth counter would
    // decrement the wrong scope here and strand the other one forever.
    releaseInner();
    await inner;
    expect(currentOpenIntentMode()).toBe('editor');

    releaseOuter();
    await outer;
    expect(isOpenIntentActive()).toBe(false);
    expect(currentOpenIntentMode()).toBeNull();
  });
});

describe('retagging outside a scope', () => {
  it('stamps the head, and only the head', () => {
    recordRecentForOpen(facts({ documentId: 'a' }));
    recordRecentForOpen(facts({ documentId: 'b' }));
    retagOpenDocumentMode('P', 'b', 'planner');
    expect(readRecents().map(e => [e.documentId, e.mode]))
      .toEqual([['b', 'planner'], ['a', 'hmi']]);
  });

  it('is inert under a kiosk lock', () => {
    recordRecentForOpen(facts());
    retagOpenDocumentMode('P', 'doc_a', 'planner', 'hmi');
    expect(readRecents()[0].mode).toBe('hmi');
  });

  it('an incomplete answer from whatIsOpen() does nothing', () => {
    recordRecentForOpen(facts());
    retagOpenDocumentMode(null, 'doc_a', 'planner');
    retagOpenDocumentMode('P', null, 'planner');
    retagOpenDocumentMode('P', 'doc_a', null);
    expect(readRecents()[0].mode).toBe('hmi');
  });
});

describe('removal verbs', () => {
  it('forgetRecent, forgetRecentsOfProject and clearRecents write through', () => {
    recordRecentForOpen(facts({ documentId: 'a' }));
    recordRecentForOpen(facts({ projectId: 'Q', documentId: 'b' }));
    recordRecentForOpen(facts({ documentId: 'c' }));

    forgetRecent('P', 'c');
    expect(stored().map(e => e.documentId)).toEqual(['b', 'a']);

    forgetRecentsOfProject('P');
    expect(stored().map(e => e.documentId)).toEqual(['b']);

    clearRecents();
    expect(stored()).toEqual([]);
    expect(readRecents()).toEqual([]);
  });
});

describe('two tabs', () => {
  it('a write reads storage FIRST, so the other tab\'s row survives', () => {
    recordRecentForOpen(facts({ documentId: 'mine' }));
    // The other tab wrote between our last read and our next write.
    const theirs: RecentDocumentEntry = {
      projectId: 'Q', backend: 'browser', documentId: 'theirs',
      documentName: 'T', documentPath: 'models/theirs.glb',
      projectName: 'Q', openedAt: '2026-09-12T09:00:00.000Z',
    };
    localStorage.setItem(LS_KEY_RECENT_DOCUMENTS, serialiseRecents([theirs]));

    recordRecentForOpen(facts({ documentId: 'newer' }));
    expect(stored().map(e => e.documentId)).toEqual(['newer', 'theirs']);
  });

  it('a storage event for OUR key rehydrates and notifies', () => {
    recordRecentForOpen(facts({ documentId: 'a' }));
    let notified = 0;
    const off = subscribeRecents(() => { notified++; });

    const theirs: RecentDocumentEntry = {
      projectId: 'Q', backend: 'bundled', documentId: 'theirs',
      documentName: 'T', documentPath: 'models/theirs.glb',
      projectName: 'Q', openedAt: '2026-09-12T09:00:00.000Z',
    };
    localStorage.setItem(LS_KEY_RECENT_DOCUMENTS, serialiseRecents([theirs]));
    handleRecentsStorageEvent({ key: LS_KEY_RECENT_DOCUMENTS });

    expect(readRecents().map(e => e.documentId)).toEqual(['theirs']);
    expect(notified).toBe(1);
    off();
  });

  it('a storage event for a FOREIGN key changes nothing and notifies nobody', () => {
    recordRecentForOpen(facts({ documentId: 'a' }));
    let notified = 0;
    const off = subscribeRecents(() => { notified++; });
    handleRecentsStorageEvent({ key: 'rv-active-mode' });
    expect(notified).toBe(0);
    expect(readRecents().map(e => e.documentId)).toEqual(['a']);
    off();
  });

  it('a null key (localStorage.clear elsewhere) empties the snapshot', () => {
    recordRecentForOpen(facts({ documentId: 'a' }));
    localStorage.removeItem(LS_KEY_RECENT_DOCUMENTS);
    handleRecentsStorageEvent({ key: null });
    expect(readRecents()).toEqual([]);
  });
});

describe('retagRecentDocumentPath — the rename half (plan-482 Phase 1b)', () => {
  it('re-points a NON-head row and writes it through, leaving the order alone', () => {
    recordRecentForOpen(facts({ documentId: 'a', documentPath: 'models/a.glb' }));
    recordRecentForOpen(facts({ documentId: 'b', documentPath: 'models/b.glb' }));

    retagRecentDocumentPath('P', 'a', 'models/renamed/a.glb');

    // Order untouched: a rename is not an open (§2.7).
    expect(readRecents().map(e => [e.documentId, e.documentPath])).toEqual([
      ['b', 'models/b.glb'],
      ['a', 'models/renamed/a.glb'],
    ]);
    expect(stored().map(e => e.documentPath))
      .toEqual(['models/b.glb', 'models/renamed/a.glb']);
  });

  it('leaves the same documentId in ANOTHER project untouched', () => {
    recordRecentForOpen(facts({ documentId: 'shared', documentPath: 'models/one.glb' }));
    recordRecentForOpen(
      facts({ projectId: 'Q', documentId: 'shared', documentPath: 'models/two.glb' }));

    retagRecentDocumentPath('P', 'shared', 'models/renamed.glb');

    expect(readRecents().map(e => [e.projectId, e.documentPath])).toEqual([
      ['Q', 'models/two.glb'],
      ['P', 'models/renamed.glb'],
    ]);
  });

  it('an incomplete answer does nothing rather than corrupting a row', () => {
    recordRecentForOpen(facts({ documentPath: 'models/a.glb' }));
    retagRecentDocumentPath(null, 'doc_a', 'x.glb');
    retagRecentDocumentPath('P', null, 'x.glb');
    retagRecentDocumentPath('P', 'doc_a', '');
    expect(readRecents()[0].documentPath).toBe('models/a.glb');
  });
});

describe('T5 — a v1 writer beside a loaded v2 snapshot (R1)', () => {
  it('empties the list, and the next v2 recording fills it again', () => {
    recordRecentForOpen(facts({ documentId: 'mine' }));
    expect(readRecents()).toHaveLength(1);

    // The old tab writes its v1 envelope. Order matters: the handler re-reads
    // localStorage and ignores the event payload
    // (`rv-project-recents-store.ts` handleRecentsStorageEvent), so the value
    // has to be in place BEFORE the event fires.
    localStorage.setItem(LS_KEY_RECENT_DOCUMENTS, JSON.stringify({
      version: 1,
      items: [{
        projectId: 'P', backend: 'folder', documentId: 'old',
        documentName: 'Old', projectName: 'Project',
        openedAt: '2026-09-12T09:00:00.000Z',
      }],
    }));
    handleRecentsStorageEvent({ key: LS_KEY_RECENT_DOCUMENTS });

    // The accepted loss of R1/R3, written down rather than merely described:
    // parseRecents rejects the foreign version wholesale.
    expect(readRecents()).toEqual([]);

    recordRecentForOpen(facts({ documentId: 'again', documentPath: 'models/again.glb' }));
    expect(readRecents().map(e => e.documentId)).toEqual(['again']);
    expect(JSON.parse(localStorage.getItem(LS_KEY_RECENT_DOCUMENTS)!).version)
      .toBe(RECENTS_SCHEMA_VERSION);
  });
});

describe('the key', () => {
  it('is NOT the legacy one — it survives runLegacyCleanup()', async () => {
    expect(LS_KEY_RECENT_DOCUMENTS).toBe('rv-project/recent-documents');
    recordRecentForOpen(facts());
    localStorage.setItem('rv-project/recent', '["legacy"]');

    await runLegacyCleanup();

    expect(localStorage.getItem('rv-project/recent')).toBeNull();
    expect(localStorage.getItem(LS_KEY_RECENT_DOCUMENTS)).not.toBeNull();
    __resetRecentsSnapshot();
    expect(readRecents()).toHaveLength(1);
  });
});
