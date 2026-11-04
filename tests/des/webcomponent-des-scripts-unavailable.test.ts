// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 Phase 3 (orchestrator item) — `des-scripts-unavailable` is
 * document-scoped: the `web-component` plugin retires it when the model goes
 * (clear), when the next model arrives (load) and when a wiring succeeds, not
 * only the DES runner on its next script bind. Classified `owner-teardown` in
 * `tests/helpers/problem-code-classification.ts`.
 */

import { describe, it, expect } from 'vitest';
import type { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { getProblem, clearProblem } from '../../src/core/hmi/problems-store';
import { DES_SCRIPTS_UNAVAILABLE_CODE } from '@rv/plugins/des/des-runner';
import { borrowed, deferred, makeWorld, warmHost } from './webcomponent-des-fixture';

const TICK = `
function setup(self) {
  self.every(1, 'beat');
  return { des: { on() {} } };
}`;

/** A world whose first QuickJS host load fails; later loads succeed. */
async function failedRun() {
  clearProblem(DES_SCRIPTS_UNAVAILABLE_CODE);
  const first = deferred<RVScriptHost>();
  let calls = 0;
  const w = await makeWorld({ scripts: [{ name: 'Tick', code: TICK }], flow: true, awaitWiring: false,
    createHost: async () => (++calls === 1 ? first.promise : borrowed(await warmHost())) });
  w.start();
  w.manager.duration = 5;
  const ff = w.runner.runFastForward();
  first.reject(new Error('wasm blocked'));
  expect(await ff).toBe(true);
  expect(getProblem(DES_SCRIPTS_UNAVAILABLE_CODE)?.detail).toContain('wasm blocked');
  return w;
}

describe('plan-2212 — des-scripts-unavailable is retired with its document', () => {
  it('model clear retires it', async () => {
    const w = await failedRun();
    w.plugin.onModelCleared();
    expect(getProblem(DES_SCRIPTS_UNAVAILABLE_CODE)).toBeUndefined();
  });

  it('the next model load retires it, and its successful wiring does not bring it back', async () => {
    const w = await failedRun();
    const load = { root: w.scene, registry: new NodeRegistry(), signalStore: w.host.signalStore };
    w.plugin.onModelLoaded(load as never, w.viewer as never);
    expect(getProblem(DES_SCRIPTS_UNAVAILABLE_CODE)).toBeUndefined();
    await w.plugin.whenWired();
    expect(w.plugin.instances).toHaveLength(1);
    expect(getProblem(DES_SCRIPTS_UNAVAILABLE_CODE)).toBeUndefined();
  });

  it('a successful re-wiring of the same model retires it (trust gate re-opened)', async () => {
    const w = await failedRun();
    w.plugin.setAllowScripts(false);
    expect(getProblem(DES_SCRIPTS_UNAVAILABLE_CODE)).toBeDefined();   // nothing resolved yet
    w.plugin.setAllowScripts(true);
    await w.plugin.whenWired();
    expect(w.plugin.instances).toHaveLength(1);
    expect(getProblem(DES_SCRIPTS_UNAVAILABLE_CODE)).toBeUndefined();
  });
});
