// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { CoreSubsystems, type CoreSubsystemsHost } from '../../src/core/engine/rv-core-subsystems';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { RVDrive } from '../../src/core/engine/rv-drive';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { DesSnapshotBlockers } from '../../src/core/material-flow/des-snapshot-blockers';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { testAddressRegistry } from '../helpers/test-address-registry';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(off => off()); });

export function cycleRunnerFixture(options: { core?: boolean; cycleTime?: number; end?: number;
  host?: Partial<Omit<CoreSubsystemsHost, 'drives'>> & { drives?: RVDrive[] } } = {}) {
  const scene = new Scene(); scene.name = 'Root';
  if (options.cycleTime !== undefined) {
    const node = new Object3D(); node.name = 'Simulation';
    node.userData.realvirtual = { DESManager: { CycleTime: options.cycleTime, EndTime: options.end ?? 0 } };
    scene.add(node);
  }
  const signalStore = new SignalStore();
  const host = {
    isConnected: false, playback: null, logicEngine: null, ikPaths: [], replayRecordings: [], drives: [] as RVDrive[],
    transportManager: null, tankFillManager: null, pipeFlowManager: null, lampManager: null,
    energyChainManager: null, collisionManager: null, gizmoManager: { tick: () => false },
    markRenderDirty: () => {}, markShadowsDirty: () => {},
    snapshotBlockers: new DesSnapshotBlockers(), signalStore, registry: null,
    desAddresses: testAddressRegistry(scene), on: () => () => {}, getPlugin: () => undefined,
    contextMenu: new ContextMenuStore(),
    ...options.host,
  };
  const core = options.core === false ? undefined : new CoreSubsystems(host);
  const runner = new DESRunner({ core, subMode: 'step', durationSeconds: options.end ?? Infinity });
  const topology = { root: scene, host };
  cleanup.push(() => { runner.dispose(); core?.dispose(); });
  return { runner, manager: runner.getManager(), scene, host, core, signalStore,
    start: () => runner.start([], topology),
    pending: (action = 'Core.Cycle') => runner.getManager().getEventQueueSnapshot()
      .filter(e => !e.cancelled && e.actionName === action),
  };
}
