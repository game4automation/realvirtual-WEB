// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { bindSceneToRunner } from '../../src/plugins/des/des-scene-binding';

// Same headless bind host as des-kernel-contracts.test.ts.
function makeHost(): BindContextHost {
  const values = new Map<string, boolean | number>();
  return {
    signalStore: {
      get: (name: string) => values.get(name),
      set: (name: string, value: boolean | number) => values.set(name, value),
      subscribe: () => () => {},
    } as never,
    on: () => () => {},
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
    getPlugin: () => undefined,
  };
}

describe('legacy DES component problems (plan 2006, 9.16)', () => {
  let runner: DESRunner;
  let host: BindContextHost;
  let scene: Object3D;
  let station: Object3D;

  beforeEach(() => {
    clearAllProblems();
    runner = new DESRunner();
    host = makeHost();
    scene = new Object3D();
    const line = new Object3D();
    line.name = 'Line';
    station = new Object3D();
    station.name = 'Workcell';
    scene.add(line);
    line.add(station);
  });

  afterEach(() => {
    runner.dispose();
    clearAllProblems();
  });

  const legacyProblems = () => getProblems().filter(problem => problem.code === 'des-legacy-component');

  it('reports a DESStation without a LayoutObject marker, with its path and replacement', () => {
    station.userData.realvirtual = { DESStation: {} };
    bindSceneToRunner(runner, scene, host);

    expect(legacyProblems()).toHaveLength(1);
    expect(legacyProblems()[0]).toMatchObject({ nodePath: 'Line/Workcell' });
    expect(legacyProblems()[0].detail).toContain('Line/Workcell');
    expect(legacyProblems()[0].detail).toContain('DESStation → Station');
  });

  it('reports once per node even with several native types or repeated binds', () => {
    station.userData.realvirtual = { DESStation: {}, DESStorage: {} };
    bindSceneToRunner(runner, scene, host);
    bindSceneToRunner(runner, scene, host);

    expect(legacyProblems()).toHaveLength(1);
    expect(legacyProblems()[0].detail).toContain('DESStation → Station');
    expect(legacyProblems()[0].detail).toContain('DESStorage → Storage');
  });

  it('reports none for a scene without legacy types and clears repaired nodes on rebind', () => {
    bindSceneToRunner(runner, scene, host);
    expect(legacyProblems()).toEqual([]);

    station.userData.realvirtual = { DESStation: {} };
    bindSceneToRunner(runner, scene, host);
    expect(legacyProblems()).toHaveLength(1);
    delete station.userData.realvirtual.DESStation;
    bindSceneToRunner(runner, scene, host);
    expect(legacyProblems()).toEqual([]);
  });
});
