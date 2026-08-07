// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The selection algebra behind multi-select in the CONNECT signal list.
 *
 * Selection is keyed by topic + name, because a signal name is only unique inside its container:
 * the same name may appear in several ProcessImage topics of one interface, and keying by name
 * alone would make unrelated rows select — and delete — together.
 */

import { describe, it, expect } from 'vitest';
import {
  applySelection,
  groupKeysByTopic,
  parseSelectionKey,
  pruneSelection,
  rangeBetween,
  selectableKeys,
  selectionIntent,
  selectionKey,
  type SelectableRow,
} from '../src/core/hmi/signal-selection';

/** Flat signal key (no topic). */
const f = (name: string) => selectionKey(undefined, name);
/** Topic-nested signal key. */
const t = (topic: string, name: string) => selectionKey(topic, name);

/** A rendered list: a ProcessImage group with two nested signals, then four flat signals. */
const rows: SelectableRow[] = [
  { kind: 'group' },
  { kind: 'signal', sig: { name: 'Shared' }, topic: 'Data_Q_1' },
  { kind: 'signal', sig: { name: 'Nested' }, topic: 'Data_Q_1' },
  { kind: 'treeNode' },
  { kind: 'signal', sig: { name: 'a' }, flat: true },
  { kind: 'signal', sig: { name: 'b' }, flat: true },
  { kind: 'signal', sig: { name: 'c' }, flat: true },
  { kind: 'signal', sig: { name: 'Shared' }, flat: true },
];

const mouse = (mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
  ({ shiftKey: false, ctrlKey: false, metaKey: false, ...mods });

describe('selection keys', () => {
  it('round-trips a flat key', () => {
    expect(parseSelectionKey(f('a'))).toEqual({ topic: undefined, name: 'a' });
  });

  it('round-trips a topic key', () => {
    expect(parseSelectionKey(t('Data_Q_1', 'Nested'))).toEqual({ topic: 'Data_Q_1', name: 'Nested' });
  });

  it('keeps a name that exists in two containers apart', () => {
    expect(f('Shared')).not.toBe(t('Data_Q_1', 'Shared'));
  });

  it('survives a name containing the separator character', () => {
    expect(parseSelectionKey(t('Data_Q_1', 'Motor 1 Run'))).toEqual({ topic: 'Data_Q_1', name: 'Motor 1 Run' });
  });
});

describe('selectableKeys', () => {
  it('lists every signal row — nested ones too — in rendered order', () => {
    expect(selectableKeys(rows)).toEqual([
      t('Data_Q_1', 'Shared'), t('Data_Q_1', 'Nested'), f('a'), f('b'), f('c'), f('Shared'),
    ]);
  });

  it('ignores group and tree-node rows', () => {
    expect(selectableKeys([{ kind: 'group' }, { kind: 'treeNode' }])).toEqual([]);
  });
});

describe('selectionIntent', () => {
  it('maps a plain click to replace', () => {
    expect(selectionIntent(mouse())).toBe('replace');
  });

  it('maps Ctrl and Meta to toggle', () => {
    expect(selectionIntent(mouse({ ctrlKey: true }))).toBe('toggle');
    expect(selectionIntent(mouse({ metaKey: true }))).toBe('toggle');
  });

  it('lets Shift win over Ctrl, like every file manager', () => {
    expect(selectionIntent(mouse({ shiftKey: true, ctrlKey: true }))).toBe('range');
  });
});

describe('rangeBetween', () => {
  it('spans downwards inclusively', () => {
    expect(rangeBetween(rows, f('a'), f('c'))).toEqual([f('a'), f('b'), f('c')]);
  });

  it('spans upwards identically — direction must not matter', () => {
    expect(rangeBetween(rows, f('c'), f('a'))).toEqual([f('a'), f('b'), f('c')]);
  });

  it('spans across the group boundary, from a nested row into the flat ones', () => {
    expect(rangeBetween(rows, t('Data_Q_1', 'Nested'), f('b')))
      .toEqual([t('Data_Q_1', 'Nested'), f('a'), f('b')]);
  });

  it('falls back to the target alone when the anchor scrolled out of the list', () => {
    expect(rangeBetween(rows, f('gone'), f('c'))).toEqual([f('c')]);
  });

  it('returns nothing when the target is not a signal row', () => {
    expect(rangeBetween(rows, f('a'), f('missing'))).toEqual([]);
  });
});

describe('applySelection', () => {
  it('replace collapses to the clicked signal and re-anchors', () => {
    const r = applySelection(rows, new Set([f('a'), f('b')]), f('a'), f('c'), 'replace');
    expect([...r.selected]).toEqual([f('c')]);
    expect(r.anchor).toBe(f('c'));
  });

  it('toggle adds an unselected signal', () => {
    const r = applySelection(rows, new Set([f('a')]), f('a'), f('c'), 'toggle');
    expect([...r.selected].sort()).toEqual([f('a'), f('c')].sort());
  });

  it('toggle removes an already selected signal', () => {
    const r = applySelection(rows, new Set([f('a'), f('c')]), f('a'), f('c'), 'toggle');
    expect([...r.selected]).toEqual([f('a')]);
  });

  it('toggling one name leaves its namesake in another topic alone', () => {
    const r = applySelection(rows, new Set([f('Shared')]), null, t('Data_Q_1', 'Shared'), 'toggle');
    expect([...r.selected].sort()).toEqual([f('Shared'), t('Data_Q_1', 'Shared')].sort());
  });

  it('range selects the span and KEEPS the anchor, so it can be widened and narrowed', () => {
    const first = applySelection(rows, new Set([f('a')]), f('a'), f('c'), 'range');
    expect([...first.selected]).toEqual([f('a'), f('b'), f('c')]);
    expect(first.anchor).toBe(f('a'));

    const second = applySelection(rows, first.selected, first.anchor, f('b'), 'range');
    expect([...second.selected]).toEqual([f('a'), f('b')]);
    expect(second.anchor).toBe(f('a'));
  });

  it('range without a usable anchor degenerates to a pick that becomes the new anchor', () => {
    const r = applySelection(rows, new Set(), null, f('c'), 'range');
    expect([...r.selected]).toEqual([f('c')]);
    expect(r.anchor).toBe(f('c'));
  });
});

describe('pruneSelection', () => {
  it('drops keys the interface no longer offers', () => {
    expect([...pruneSelection(new Set([f('a'), f('ghost')]), [f('a'), f('b')])]).toEqual([f('a')]);
  });

  it('returns the same instance when nothing changed, so React state stays a no-op', () => {
    const sel = new Set([f('a'), f('b')]);
    expect(pruneSelection(sel, [f('a'), f('b'), f('c')])).toBe(sel);
  });

  it('short-circuits on an empty selection', () => {
    const empty = new Set<string>();
    expect(pruneSelection(empty, [])).toBe(empty);
  });
});

describe('groupKeysByTopic', () => {
  it('splits a mixed selection into the two config containers', () => {
    const { flat, byTopic } = groupKeysByTopic(new Set([
      f('a'), f('Shared'), t('Data_Q_1', 'Nested'), t('Data_Q_2', 'Other'),
    ]));
    expect([...flat].sort()).toEqual(['Shared', 'a']);
    expect([...byTopic.get('Data_Q_1')!]).toEqual(['Nested']);
    expect([...byTopic.get('Data_Q_2')!]).toEqual(['Other']);
  });

  it('keeps a name that exists both flat and nested in its own bucket', () => {
    const { flat, byTopic } = groupKeysByTopic(new Set([f('Shared'), t('Data_Q_1', 'Shared')]));
    expect([...flat]).toEqual(['Shared']);
    expect([...byTopic.get('Data_Q_1')!]).toEqual(['Shared']);
  });

  it('produces no topic buckets for a purely flat selection', () => {
    const { flat, byTopic } = groupKeysByTopic(new Set([f('a'), f('b')]));
    expect(byTopic.size).toBe(0);
    expect(flat.size).toBe(2);
  });
});
