// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-509 §9.3 — the cross-project model search: ranking, name + tag
 * matching, group order and names, the orphan filter, the cap, and the
 * per-keystroke budget.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_SEARCH_RESULTS, buildModelSearchIndex, capModelSearch, crumbsOfPath, searchModelIndex,
  unindexedLinkedCount, visibleSnapshots, type ModelSearchProject,
} from '../src/core/project/rv-model-search';
import {
  MODEL_INDEX_SCHEMA_VERSION, type ModelIndexBackend, type ModelIndexDoc, type ModelIndexSnapshot,
} from '../src/core/project/rv-model-index';

function doc(id: string, name: string, tags: string[] = [], path = `models/${id}.glb`): ModelIndexDoc {
  return { id, name, path, tags };
}

function snap(
  projectId: string,
  docs: ModelIndexDoc[],
  backend: ModelIndexBackend = 'folder',
  projectName = projectId,
): ModelIndexSnapshot {
  return { version: MODEL_INDEX_SCHEMA_VERSION, projectId, projectName, backend, updatedAt: '', docs };
}

function order(...ids: string[]): ModelSearchProject[] {
  return ids.map(id => ({ key: `folder:${id}`, name: id }));
}

describe('model search — matching', () => {
  it('ranks a name hit above a tag hit', () => {
    const idx = buildModelSearchIndex([snap('p1', [doc('a', 'Conveyor'), doc('b', 'Robot', ['conveyor'])])], order('p1'));
    const r = searchModelIndex(idx, 'conveyor');
    expect(r.groups[0].hits.map(h => h.entry.doc.id)).toEqual(['a', 'b']);
  });

  it('a pure tag hit is found (the reject covers name AND tags)', () => {
    const idx = buildModelSearchIndex([snap('p1', [doc('b', 'Robot', ['conveyor'])])], order('p1'));
    expect(searchModelIndex(idx, 'conveyor').total).toBe(1);
  });

  it('tokens split across name and tags still match', () => {
    const idx = buildModelSearchIndex([snap('p1', [doc('b', 'Robot', ['conveyor'])])], order('p1'));
    expect(searchModelIndex(idx, 'robot conveyor').total).toBe(1);
    expect(searchModelIndex(idx, 'conveyor robot').total).toBe(1);
  });

  it('AND semantics: every token must occur somewhere', () => {
    const idx = buildModelSearchIndex([snap('p1', [doc('a', 'Conveyor Line'), doc('b', 'Conveyor')])], order('p1'));
    const r = searchModelIndex(idx, 'conveyor line');
    expect(r.groups[0].hits.map(h => h.entry.doc.id)).toEqual(['a']);
  });

  it('an empty term is no search', () => {
    const idx = buildModelSearchIndex([snap('p1', [doc('a', 'A')])], order('p1'));
    expect(searchModelIndex(idx, '   ')).toEqual({ groups: [], total: 0, truncated: false });
  });

  it('breadcrumbs are the folders of the path', () => {
    expect(crumbsOfPath('models/hall-b/conveyors/x.glb')).toEqual(['models', 'hall-b', 'conveyors']);
    expect(crumbsOfPath('x.glb')).toEqual([]);
  });
});

describe('model search — groups', () => {
  it('follows the project list, bundled first', () => {
    const snaps = [
      snap('p2', [doc('x', 'Line 2')]),
      snap('prj_sample', [doc('y', 'Line demo')], 'bundled'),
      snap('p1', [doc('z', 'Line 1')]),
    ];
    const projects: ModelSearchProject[] = [
      { key: 'bundled:prj_sample', name: 'DemoRealvirtual' },
      { key: 'folder:p1', name: 'P1' },
      { key: 'folder:p2', name: 'P2' },
    ];
    const r = searchModelIndex(buildModelSearchIndex(snaps, projects), 'line');
    expect(r.groups.map(g => g.projectName)).toEqual(['DemoRealvirtual', 'P1', 'P2']);
  });

  it('a term matching no project name keeps every group with hits', () => {
    const r = searchModelIndex(buildModelSearchIndex(
      [snap('p1', [doc('a', 'Gripper')]), snap('p2', [doc('b', 'Gripper small')])],
      [{ key: 'folder:p1', name: 'Mauser' }, { key: 'folder:p2', name: 'Festo' }]), 'gripper');
    expect(r.groups.map(g => g.projectName)).toEqual(['Mauser', 'Festo']);
  });

  it('takes the group name from the project list, not the snapshot', () => {
    const r = searchModelIndex(buildModelSearchIndex(
      [snap('p1', [doc('a', 'Robot')], 'folder', 'Alt')],
      [{ key: 'folder:p1', name: 'Neu' }]), 'robot');
    expect(r.groups[0].projectName).toBe('Neu');
    expect(r.groups[0].hits[0].entry.projectName).toBe('Neu');
  });

  it('a snapshot without a list row goes last, under its own name', () => {
    const r = searchModelIndex(buildModelSearchIndex(
      [snap('w', [doc('a', 'Robot')], 'browser', 'My workspace'), snap('p1', [doc('b', 'Robot')])],
      order('p1')), 'robot');
    expect(r.groups.map(g => g.projectName)).toEqual(['p1', 'My workspace']);
  });

  it('the same id on two backends is two groups', () => {
    const r = searchModelIndex(buildModelSearchIndex(
      [snap('prj_sample', [doc('a', 'Robot')], 'bundled'), snap('prj_sample', [doc('a', 'Robot')], 'folder')],
      [{ key: 'bundled:prj_sample', name: 'Demo' }, { key: 'folder:prj_sample', name: 'Demo folder' }]), 'robot');
    expect(r.groups.map(g => g.key)).toEqual(['bundled:prj_sample', 'folder:prj_sample']);
  });
});

describe('visibleSnapshots', () => {
  it('hides folder snapshots without a linked row and mutates nothing', () => {
    const input = [
      snap('linked', [doc('a', 'A')]),
      snap('gone', [doc('b', 'B')]),
      snap('prj_sample', [doc('c', 'C')], 'bundled'),
      snap('ws', [doc('d', 'D')], 'browser'),
    ];
    const copy = JSON.parse(JSON.stringify(input));
    const out = visibleSnapshots(input, ['linked']);
    expect(out.map(s => `${s.backend}:${s.projectId}`)).toEqual(['folder:linked', 'bundled:prj_sample', 'browser:ws']);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
  });

  it('counts linked projects without a snapshot (the F11 hint)', () => {
    expect(unindexedLinkedCount([snap('a', [])], ['a', 'b', 'c'])).toBe(2);
    expect(unindexedLinkedCount([snap('a', [], 'bundled')], ['a'])).toBe(1);
  });
});

describe('capModelSearch', () => {
  it(`caps at ${MAX_SEARCH_RESULTS} with the right total`, () => {
    const docs = Array.from({ length: 150 }, (_, i) => doc(`d${i}`, `Robot ${i}`));
    const idx = buildModelSearchIndex([snap('p1', docs), snap('p2', docs)], order('p1', 'p2'));
    const r = capModelSearch(searchModelIndex(idx, 'robot'));
    expect(MAX_SEARCH_RESULTS).toBe(200);
    expect(r.total).toBe(300);
    expect(r.truncated).toBe(true);
    expect(r.groups.reduce((n, g) => n + g.hits.length, 0)).toBe(200);
    expect(r.groups[1].hits).toHaveLength(50);
  });

  it('searching with `max` shows exactly what the uncapped search + cap shows', () => {
    const snaps = Array.from({ length: 6 }, (_, p) => snap(`p${p}`,
      Array.from({ length: 90 }, (_, i) => doc(`d${i}`, `${i % 3 ? 'Robot' : 'Gripper'} ${i}`, i % 5 ? [] : ['robot']))));
    const idx = buildModelSearchIndex(snaps, order(...snaps.map(s => s.projectId)));
    for (const term of ['robot', 'r', 'gripper 1', 'zzz', '1']) {
      const full = capModelSearch(searchModelIndex(idx, term));
      const fast = capModelSearch(searchModelIndex(idx, term, MAX_SEARCH_RESULTS));
      expect(fast.total).toBe(full.total);
      expect(fast.truncated).toBe(full.truncated);
      expect(fast.groups.map(g => [g.key, g.hits.map(h => h.entry.doc.id)]))
        .toEqual(full.groups.map(g => [g.key, g.hits.map(h => h.entry.doc.id)]));
    }
  });

  it('leaves a small result untouched', () => {
    const idx = buildModelSearchIndex([snap('p1', [doc('a', 'Robot')])], order('p1'));
    const r = searchModelIndex(idx, 'robot');
    expect(capModelSearch(r)).toBe(r);
  });
});

describe('model search — performance', () => {
  it('20 000 entries: median and maximum per keystroke under 16 ms', () => {
    const words = ['conveyor', 'robot', 'gripper', 'station', 'buffer', 'line', 'sensor', 'turntable'];
    const snaps: ModelIndexSnapshot[] = [];
    for (let p = 0; p < 50; p++) {
      const docs: ModelIndexDoc[] = [];
      for (let i = 0; i < 400; i++) {
        docs.push(doc(`d${i}`, `${words[(i + p) % words.length]} ${i} ${words[(i * 7) % words.length]}`,
          [words[(i * 3) % words.length], `hall-${p % 5}`], `models/hall-${p % 5}/sub-${i % 9}/d${i}.glb`));
      }
      snaps.push(snap(`p${p}`, docs));
    }
    const idx = buildModelSearchIndex(snaps, order(...snaps.map(s => s.projectId)));
    expect(idx.entries).toHaveLength(20000);
    const terms = ['c', 'co', 'con', 'conv', 'conveyor', 'r', 'ro', 'rob', 'robot 1', 'hall-3',
      'grip', 'station 12', 'x', 'line sensor', 'turn', 'buf', 'z', 'conveyor robot', '1', '99'];
    const times: number[] = [];
    // Warm-up, then measure 50 searches. Each is the best of three runs: the
    // full suite runs files in parallel, and a scheduler pause or a GC of a
    // NEIGHBOUR is not the search's cost — a slow search is slow every time.
    for (const t of terms) capModelSearch(searchModelIndex(idx, t, MAX_SEARCH_RESULTS));
    for (let i = 0; i < 50; i++) {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        capModelSearch(searchModelIndex(idx, terms[i % terms.length], MAX_SEARCH_RESULTS));
        best = Math.min(best, performance.now() - t0);
      }
      times.push(best);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const max = times[times.length - 1];
    expect(median).toBeLessThan(16);
    expect(max).toBeLessThan(16);
  });
});
