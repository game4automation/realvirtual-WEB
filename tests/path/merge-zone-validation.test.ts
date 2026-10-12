// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.12 — load-time validation: two paths merging into the same
 * successor WITHOUT a shared zone are reported in the Problems panel (the
 * moving block only sees vehicles on its own route; a merge needs a zone).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { findUnzonedMerges } from '../../src/core/engine/rv-movement-authority';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { makeHost, makeAgvRoot, bindDes, clearShared } from '../helpers/agv-harness';

beforeEach(() => { clearShared(); clearAllProblems(); });

function registerMerge(zoned: boolean): void {
  const net = getDefaultPathNetwork();
  const z = (): Record<string, unknown> => (zoned ? { zone: 'M' } : {});
  const add = (raw: Record<string, unknown>): void => {
    net.register(parsePathExtras({ type: 'Path', version: 1, ...raw }, raw.id as string)!);
  };
  add({ id: 'A', segments: [{ kind: 'line', from: [-5, 0, -2], to: [0, 0, 0] }], successors: ['Out'], ...z() });
  add({ id: 'B', segments: [{ kind: 'line', from: [-5, 0, 2], to: [0, 0, 0] }], successors: ['Out'], ...z() });
  add({ id: 'Out', segments: [{ kind: 'line', from: [0, 0, 0], to: [5, 0, 0] }], ...z() });
  net.resolveGraph();
}

describe('merge validation (plan-558 §9.12)', () => {
  it('findUnzonedMerges: a merge without a common zone is found, with the zone it is not', () => {
    registerMerge(false);
    expect(findUnzonedMerges(getDefaultPathNetwork().all())).toEqual([{ pathId: 'Out', incoming: ['A', 'B'] }]);
    clearShared();
    registerMerge(true);
    expect(findUnzonedMerges(getDefaultPathNetwork().all())).toEqual([]);
  });

  it('binding an Agv reports the unzoned merge in the Problems panel; a zoned layout reports nothing', () => {
    registerMerge(false);
    // setup runs at runner.start — bind + start a minimal runner.
    const runner = new DESRunner({ subMode: 'animated' });
    bindDes(runner, makeAgvRoot('W', { PathId: 'A' }), makeHost());
    runner.start([], { root: new Object3D() });
    const hits = getProblems().filter((p) => p.code === 'agv-merge-without-zone');
    expect(hits.length).toBe(1);
    expect(hits[0].severity).toBe('warning');
    expect(hits[0].detail).toContain("'A'");
    expect(hits[0].detail).toContain("'B'");
    runner.dispose();

    clearShared();
    clearAllProblems();
    registerMerge(true);
    const runner2 = new DESRunner({ subMode: 'animated' });
    bindDes(runner2, makeAgvRoot('W', { PathId: 'A' }), makeHost());
    runner2.start([], { root: new Object3D() });
    expect(getProblems().filter((p) => p.code === 'agv-merge-without-zone').length).toBe(0);
    runner2.dispose();
  });
});
