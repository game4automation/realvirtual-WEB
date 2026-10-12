// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-509 §9.1 — the storage-free half of the model index: snapshot shape,
 * the write signature, and tolerant parsing.
 */

import { describe, it, expect } from 'vitest';
import {
  MODEL_INDEX_SCHEMA_VERSION, modelIndexKey, parseSnapshot, signatureOf, snapshotFromDocuments,
} from '../src/core/project/rv-model-index';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';

const AT = '2026-09-27T10:00:00.000Z';

function row(id: string, name: string, path: string, extra: Partial<RvDocumentEntry> = {}): RvDocumentEntry {
  return { id, name, path, ...extra } as RvDocumentEntry;
}

const PROJECT = { id: 'prj_a', name: 'Alpha' };

describe('snapshotFromDocuments', () => {
  it('takes id, name, path, tags and the declared mode', () => {
    const s = snapshotFromDocuments(PROJECT, 'folder', [
      row('d1', 'Conveyor', 'models/lines/conveyor.glb',
        { classification: { tags: ['line', 'belt'] } as never, mode: 'planner' }),
    ], AT);
    expect(s).toMatchObject({
      version: MODEL_INDEX_SCHEMA_VERSION, projectId: 'prj_a', projectName: 'Alpha',
      backend: 'folder', updatedAt: AT, source: 'open',
    });
    expect(s.docs).toEqual([
      { id: 'd1', name: 'Conveyor', path: 'models/lines/conveyor.glb', tags: ['line', 'belt'], mode: 'planner' },
    ]);
  });

  it('a missing classification is `tags: []`, a missing mode is absent', () => {
    const s = snapshotFromDocuments(PROJECT, 'folder', [row('d1', 'A', 'a.glb')], AT);
    expect(s.docs[0]).toEqual({ id: 'd1', name: 'A', path: 'a.glb', tags: [] });
  });

  it('keys by the backend/id PAIR', () => {
    expect(modelIndexKey('bundled', 'prj_sample')).toBe('bundled:prj_sample');
    expect(modelIndexKey('folder', 'prj_sample')).toBe('folder:prj_sample');
  });
});

describe('signatureOf', () => {
  const base = [
    row('d1', 'A', 'models/a.glb', { classification: { tags: ['x'] } as never }),
    row('d2', 'B', 'models/b.glb'),
  ];
  const sig = (docs: RvDocumentEntry[], name = 'Alpha') =>
    signatureOf(snapshotFromDocuments({ id: 'prj_a', name }, 'folder', docs, AT));

  it('does not depend on the document order or the timestamp', () => {
    expect(sig([...base].reverse())).toBe(sig(base));
    expect(signatureOf(snapshotFromDocuments(PROJECT, 'folder', base, 'other')))
      .toBe(sig(base));
  });

  it('changes on rename, move, tag edit, mode edit and project rename', () => {
    const s0 = sig(base);
    expect(sig([row('d1', 'A2', 'models/a.glb', { classification: { tags: ['x'] } as never }), base[1]])).not.toBe(s0);
    expect(sig([row('d1', 'A', 'models/sub/a.glb', { classification: { tags: ['x'] } as never }), base[1]])).not.toBe(s0);
    expect(sig([row('d1', 'A', 'models/a.glb', { classification: { tags: ['y'] } as never }), base[1]])).not.toBe(s0);
    expect(sig([row('d1', 'A', 'models/a.glb', { classification: { tags: ['x'] } as never, mode: 'des' }), base[1]])).not.toBe(s0);
    expect(sig(base, 'Alpha renamed')).not.toBe(s0);
  });
});

describe('parseSnapshot', () => {
  const good = snapshotFromDocuments(PROJECT, 'folder', [row('d1', 'A', 'a.glb')], AT);

  it('round-trips a valid snapshot', () => {
    expect(parseSnapshot(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it('discards a wrong version, a bad backend and non-objects without throwing', () => {
    expect(parseSnapshot({ ...good, version: 99 })).toBeNull();
    expect(parseSnapshot({ ...good, backend: 'cloud' })).toBeNull();
    expect(parseSnapshot({ ...good, projectId: '' })).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot('x')).toBeNull();
    expect(parseSnapshot([])).toBeNull();
    expect(parseSnapshot({ ...good, docs: 'nope' })).toBeNull();
  });

  it('drops broken documents one by one and keeps the rest', () => {
    const s = parseSnapshot({
      ...good,
      docs: [
        { id: 'ok', name: 'Ok', path: 'ok.glb', tags: ['t', 3] },
        { id: '', name: 'x', path: 'x.glb' },
        { id: 'noname', path: 'n.glb' },
        null,
        'str',
      ],
    });
    expect(s?.docs).toEqual([{ id: 'ok', name: 'Ok', path: 'ok.glb', tags: ['t'] }]);
  });
});
