// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { testAddressRegistry } from '../helpers/test-address-registry';

import { afterEach } from 'vitest';
import { Scene } from 'three';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';
import { runScopeStore } from '../../src/core/material-flow/rv-run-history-store';

const runners: DESRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.dispose(); });

/** Retains the discovery host so rebindScene takes its real rediscovery path. */
export function sceneFixture(scene = new Scene()) {
  __resetDesRunSettingsForTest();
  runScopeStore.set(null);
  const signalStore = new SignalStore();
  const host: BindContextHost = { signalStore, registry: null, desAddresses: testAddressRegistry(), drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(), getPlugin: () => undefined };
  const runner = new DESRunner({ subMode: 'animated' });
  runners.push(runner);
  scene.updateMatrixWorld(true);
  runner.start([], { root: scene, host });
  return { scene, runner, manager: runner.getManager(), signalStore, host };
}
