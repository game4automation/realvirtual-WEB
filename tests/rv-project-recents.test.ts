// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-478 §9.1 — the recent-documents RING, as a value.
 *
 * No storage and no clock here on purpose: every function under test is total
 * and pure, so the interesting cases (a hand-edited envelope, a future schema
 * version, the same document id in two projects) can simply be stated.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_RECENT_DOCUMENTS,
  parseRecents,
  pushRecent,
  removeRecent,
  removeRecentsOfProject,
  RECENTS_SCHEMA_VERSION,
  retagDocumentPath,
  retagHeadMode,
  serialiseRecents,
  type RecentDocumentEntry,
} from '../src/core/project/rv-project-recents';

function e(over: Partial<RecentDocumentEntry> = {}): RecentDocumentEntry {
  return {
    projectId: 'P',
    backend: 'folder',
    documentId: 'doc_a',
    documentName: 'A',
    documentPath: 'models/a.glb',
    projectName: 'P',
    mode: 'hmi',
    openedAt: '2026-09-12T10:00:00.000Z',
    ...over,
  };
}

describe('pushRecent — dedup and move-to-front', () => {
  it('puts a new entry at the front', () => {
    const items = pushRecent(pushRecent([], e({ documentId: 'a' })), e({ documentId: 'b' }));
    expect(items.map(i => i.documentId)).toEqual(['b', 'a']);
  });

  it('a re-open MOVES the row rather than adding a second one', () => {
    let items = pushRecent([], e({ documentId: 'a', mode: 'hmi' }));
    items = pushRecent(items, e({ documentId: 'b' }));
    items = pushRecent(items, e({ documentId: 'a', mode: 'planner', openedAt: 'Z' }));
    expect(items.map(i => i.documentId)).toEqual(['a', 'b']);
    // The fresh entry wins every field — the newer mode and time are the whole
    // reason for re-recording it.
    expect(items[0]).toMatchObject({ mode: 'planner', openedAt: 'Z' });
  });

  it('caps at ten, dropping the oldest', () => {
    let items: RecentDocumentEntry[] = [];
    for (let i = 0; i < 14; i++) items = pushRecent(items, e({ documentId: `d${i}` }));
    expect(items).toHaveLength(MAX_RECENT_DOCUMENTS);
    expect(items[0].documentId).toBe('d13');
    expect(items.at(-1)!.documentId).toBe('d4');
  });

  it('the SAME document id in two projects is two rows', () => {
    let items = pushRecent([], e({ projectId: 'P1', documentId: 'shared' }));
    items = pushRecent(items, e({ projectId: 'P2', documentId: 'shared' }));
    expect(items).toHaveLength(2);
    expect(items.map(i => i.projectId)).toEqual(['P2', 'P1']);
  });
});

describe('retagHeadMode — only the head, only on a match', () => {
  it('re-stamps the head', () => {
    const items = retagHeadMode([e({ documentId: 'a', mode: 'hmi' })], 'P', 'a', 'planner');
    expect(items[0].mode).toBe('planner');
  });

  it('leaves a NON-head entry alone', () => {
    const start = [e({ documentId: 'b', mode: 'hmi' }), e({ documentId: 'a', mode: 'hmi' })];
    const items = retagHeadMode(start, 'P', 'a', 'planner');
    expect(items.map(i => i.mode)).toEqual(['hmi', 'hmi']);
  });

  it('matches on the PAIR, not the document id alone', () => {
    const items = retagHeadMode([e({ projectId: 'P1', documentId: 'a' })], 'P2', 'a', 'planner');
    expect(items[0].mode).toBe('hmi');
  });

  it('an empty ring is a no-op, not a crash', () => {
    expect(retagHeadMode([], 'P', 'a', 'planner')).toEqual([]);
  });
});

describe('removal', () => {
  it('removeRecent drops exactly one pair', () => {
    const start = [e({ documentId: 'a' }), e({ projectId: 'Q', documentId: 'a' })];
    expect(removeRecent(start, 'P', 'a').map(i => i.projectId)).toEqual(['Q']);
  });

  it('removeRecentsOfProject drops every row of one project (F10)', () => {
    const start = [
      e({ projectId: 'P', documentId: 'a' }),
      e({ projectId: 'Q', documentId: 'b' }),
      e({ projectId: 'P', documentId: 'c' }),
    ];
    expect(removeRecentsOfProject(start, 'P').map(i => i.documentId)).toEqual(['b']);
  });
});

describe('parseRecents — tolerant of everything', () => {
  it('null and garbage read as "nothing remembered"', () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents('')).toEqual([]);
    expect(parseRecents('{not json')).toEqual([]);
    expect(parseRecents('42')).toEqual([]);
    expect(parseRecents('[]')).toEqual([]);
  });

  // T2 (plan-482, R9). The version this test used to call "foreign" was 2 —
  // which IS the current version since the schema bump, so the assertion would
  // have quietly stopped testing what it names. Both halves are now stated:
  // the retired v1 ring, and a version nobody has ever written.
  it('discards the plan-478 v1 ring rather than half-reading it', () => {
    expect(parseRecents(JSON.stringify({ version: 1, items: [e()] }))).toEqual([]);
  });

  it('still discards a genuinely foreign version', () => {
    expect(parseRecents(JSON.stringify({ version: 99, items: [e()] }))).toEqual([]);
  });

  it('malformed rows are skipped, sound ones survive', () => {
    const raw = JSON.stringify({
      version: RECENTS_SCHEMA_VERSION,
      items: [
        null,
        { projectId: 'P' },                                   // no documentId
        { projectId: 'P', documentId: 'x', backend: 'ftp' },  // unknown backend
        e({ documentId: 'ok' }),
      ],
    });
    expect(parseRecents(raw).map(i => i.documentId)).toEqual(['ok']);
  });

  it('fills the display fields it can derive and drops an unusable mode', () => {
    const raw = JSON.stringify({
      version: RECENTS_SCHEMA_VERSION,
      items: [{
        projectId: 'P', documentId: 'd', backend: 'browser',
        documentPath: 'models/d.glb', mode: 7,
      }],
    });
    expect(parseRecents(raw)[0]).toMatchObject({
      documentName: 'd', projectName: 'P', mode: undefined,
    });
  });

  it('never returns more than the cap, however long the stored list is', () => {
    const items = Array.from({ length: 30 }, (_, i) => e({ documentId: `d${i}` }));
    expect(parseRecents(JSON.stringify({ version: RECENTS_SCHEMA_VERSION, items })))
      .toHaveLength(MAX_RECENT_DOCUMENTS);
  });

  it('round-trips through serialiseRecents', () => {
    const items = [e({ documentId: 'a' }), e({ documentId: 'b', backend: 'bundled' })];
    expect(parseRecents(serialiseRecents(items))).toEqual(items);
  });

  // T1 (plan-482) — the whole point of the schema bump is that the path is
  // there on the way back out, not just on the way in.
  it('carries the document path through push and parse', () => {
    const entry = e({ documentPath: 'models/line3.glb' });
    const raw = JSON.stringify({ version: RECENTS_SCHEMA_VERSION, items: [entry] });
    expect(parseRecents(raw)[0].documentPath).toBe('models/line3.glb');
  });

  // T2 (plan-482 F2) — mandatory means mandatory, hand-written localStorage
  // included. A row whose path is anything but a non-empty string is dropped
  // exactly like a row without a documentId.
  it.each([
    ['empty', ''],
    ['missing', undefined],
    ['null', null],
    ['numeric', 7],
  ])('drops a row whose document path is %s', (_label, value) => {
    const bad = { ...e(), documentPath: value };
    const raw = JSON.stringify({ version: RECENTS_SCHEMA_VERSION, items: [bad] });
    expect(parseRecents(raw)).toEqual([]);
  });

  it('keeps the good rows of a mixed batch', () => {
    const raw = JSON.stringify({
      version: RECENTS_SCHEMA_VERSION,
      items: [{ ...e({ documentId: 'bad' }), documentPath: '' }, e({ documentId: 'ok' })],
    });
    expect(parseRecents(raw).map(r => r.documentId)).toEqual(['ok']);
  });
});

/**
 * T4 (plan-482 §2.7) — the recorded path is a COPY, and copies go stale. A
 * rename or a move inside the open project has to re-point the ring, and it
 * has to do so without touching anything else: a rename is not an open.
 */
describe('retagDocumentPath — re-point one row, disturb nothing else', () => {
  it('re-points an entry that is NOT at the head', () => {
    const start = [
      e({ documentId: 'b', documentPath: 'models/b.glb' }),
      e({ documentId: 'a', documentPath: 'models/a.glb' }),
    ];
    const items = retagDocumentPath(start, 'P', 'a', 'models/neu/x.glb');
    expect(items.map(i => i.documentPath)).toEqual(['models/b.glb', 'models/neu/x.glb']);
  });

  it('leaves order, mode and openedAt untouched', () => {
    const start = [
      e({ documentId: 'b', openedAt: '2026-01-02T00:00:00.000Z', mode: 'planner' }),
      e({ documentId: 'a', openedAt: '2026-01-01T00:00:00.000Z', mode: 'hmi' }),
    ];
    const items = retagDocumentPath(start, 'P', 'a', 'models/neu/x.glb');
    expect(items.map(i => i.documentId)).toEqual(['b', 'a']);
    expect(items[1].mode).toBe('hmi');
    expect(items[1].openedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('matches on the PAIR — another project with the same documentId is untouched', () => {
    const start = [
      e({ projectId: 'P1', documentId: 'shared', documentPath: 'models/one.glb' }),
      e({ projectId: 'P2', documentId: 'shared', documentPath: 'models/two.glb' }),
    ];
    const items = retagDocumentPath(start, 'P1', 'shared', 'models/renamed.glb');
    expect(items.map(i => i.documentPath)).toEqual(['models/renamed.glb', 'models/two.glb']);
  });

  it('a folder move re-points every ring row below it, opened or not', () => {
    // A directory move reports one new path per document; the ring never had
    // to be "open" on those rows for them to be wrong afterwards.
    let items = [
      e({ documentId: 'a', documentPath: 'old/a.glb' }),
      e({ documentId: 'b', documentPath: 'old/b.glb' }),
      e({ documentId: 'c', documentPath: 'other/c.glb' }),
    ];
    items = retagDocumentPath(items, 'P', 'a', 'new/a.glb');
    items = retagDocumentPath(items, 'P', 'b', 'new/b.glb');
    expect(items.map(i => i.documentPath)).toEqual(['new/a.glb', 'new/b.glb', 'other/c.glb']);
  });

  it('an empty ring and an unknown pair are no-ops, not crashes', () => {
    expect(retagDocumentPath([], 'P', 'a', 'x.glb')).toEqual([]);
    const start = [e({ documentId: 'a' })];
    expect(retagDocumentPath(start, 'P', 'zzz', 'x.glb')).toEqual(start);
  });
});
