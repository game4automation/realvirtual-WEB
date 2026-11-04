// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { bindDes, clearShared, makeAgvRoot, makeHost } from '../helpers/agv-harness';

const runners: DESRunner[] = [];
afterEach(() => { for (const r of runners.splice(0)) r.dispose(); clearShared(); });

export function serviceFixture() {
  clearShared();
  const net = getDefaultPathNetwork();
  for (const [id, from, to, successors] of [
    ['A', 0, 3, ['B']], ['B', 3, 6, []],
  ] as const) {
    net.register(parsePathExtras({ type: 'Path', id,
      segments: [{ kind: 'line', from: [0, 0, from], to: [0, 0, to] }], successors: [...successors],
    }, id)!);
  }
  net.resolveGraph();
  const runner = new DESRunner({ subMode: 'animated' }); runners.push(runner);
  const root = makeAgvRoot('V', { PathId: 'A', StartPosition: 0, VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false });
  const self = bindDes(runner, root, makeHost());
  runner.start([], { root: new Object3D() });
  const tick = () => { runner.tick(0.1); runner.lateTick(0.1); };
  return { runner, self, handle: getDefaultAgvFleet().get('V')!,
    until(pred: () => boolean) {
      for (let i = 0; i < 2000 && !pred(); i++) tick();
      expect(pred(), 'vehicle reaches the requested service stay').toBe(true);
    },
    advance(seconds: number) { for (let i = 0; i < seconds * 10; i++) tick(); },
  };
}
