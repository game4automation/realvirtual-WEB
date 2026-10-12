// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 §9.9a / F6 — the runtime state behind the PLUGIN chip.
 *
 * Two things are being pinned, and the second is the one a later refactor
 * breaks by accident.
 *
 * 1. The four `reason` values. Each corresponds to a place where the plugin
 *    manager already emitted a diagnosis into the console and nowhere else, so
 *    the set is closed by construction: `unresolved`, `import-failed`,
 *    `no-exports`, `register-threw`. Anything a fifth value described would be
 *    a diagnosis the manager does not make.
 *
 * 2. The IDENTITY contract. `useSyncExternalStore` re-renders whenever the
 *    snapshot is a different object, so a store that rebuilt its answer per
 *    read would spin the chip forever. The getter must hand back the same
 *    object until something really changed — including across a re-report of
 *    an identical state, which is what a second model load of the same
 *    document produces.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearPluginBindingState,
  getPluginBindingState,
  reportPluginBinding,
  reportPluginFailed,
  reportPluginLoaded,
  resetPluginBindingStateForTests,
  subscribePluginBindingState,
  type PluginBindingFailure,
} from '../src/core/rv-plugin-binding-state';

const REF = 'plugins/ribbon-tension-controls-plugin.tsx';

beforeEach(() => { resetPluginBindingStateForTests(); });

describe('plan-479 F6 — the four reasons the manager can give', () => {
  const cases: Array<[PluginBindingFailure, string]> = [
    ['unresolved', 'matches no module in this build'],
    ['import-failed', 'importing it threw'],
    ['no-exports', 'exports no registerModelPlugins pair'],
    ['register-threw', 'registerModelPlugins threw'],
  ];

  for (const [reason, detail] of cases) {
    it(`carries "${reason}" through with its detail intact`, () => {
      reportPluginBinding(REF);
      reportPluginFailed(REF, reason, detail);

      const state = getPluginBindingState();
      expect(state.kind).toBe('failed');
      if (state.kind !== 'failed') return;
      expect(state.reason).toBe(reason);
      expect(state.scriptRef).toBe(REF);
      // The detail is what the chip's tooltip shows; a reason word alone would
      // tell the user no more than the colour already did.
      expect(state.detail).toBe(detail);
    });
  }

  it('never publishes an empty detail — the tooltip must say something', () => {
    reportPluginFailed(REF, 'unresolved', '');
    const state = getPluginBindingState();
    expect(state.kind === 'failed' && state.detail).toBe('unresolved');
  });
});

describe('plan-479 F6 — the transitions', () => {
  it('starts at none', () => {
    expect(getPluginBindingState()).toEqual({ kind: 'none' });
  });

  it('bound → loaded, remembering where the code came from', () => {
    reportPluginBinding(REF);
    expect(getPluginBindingState()).toEqual({ kind: 'bound', scriptRef: REF });

    reportPluginLoaded(REF, 'bundle');
    expect(getPluginBindingState()).toEqual({ kind: 'loaded', scriptRef: REF, from: 'bundle' });

    // The runtime path is a different answer to the same question and the chip
    // words it differently ("loaded from the project", not "from this build").
    reportPluginLoaded(REF, 'runtime');
    expect(getPluginBindingState()).toEqual({ kind: 'loaded', scriptRef: REF, from: 'runtime' });
  });

  it('bound → failed → bound again when the binding is re-made', () => {
    reportPluginBinding(REF);
    reportPluginFailed(REF, 'unresolved', 'nothing matches');
    expect(getPluginBindingState().kind).toBe('failed');

    // The next model load re-reports the binding first — a failure of the
    // PREVIOUS load must not survive into the new one's "still resolving".
    reportPluginBinding(REF);
    expect(getPluginBindingState()).toEqual({ kind: 'bound', scriptRef: REF });
  });

  it('falls back to none when the binding is cleared', () => {
    reportPluginLoaded(REF, 'bundle');
    clearPluginBindingState();
    expect(getPluginBindingState()).toEqual({ kind: 'none' });
  });

  it('reads an empty reference as no binding at all', () => {
    reportPluginLoaded(REF, 'bundle');
    // What a document WITHOUT a scriptRef reports. Without this the next
    // document would inherit the previous one's verdict.
    reportPluginBinding(null);
    expect(getPluginBindingState()).toEqual({ kind: 'none' });
    reportPluginBinding('   ');
    expect(getPluginBindingState()).toEqual({ kind: 'none' });
  });

  it('ignores a verdict with no reference to attach it to', () => {
    reportPluginBinding(REF);
    reportPluginLoaded('', 'bundle');
    reportPluginFailed('', 'unresolved', 'orphan');
    expect(getPluginBindingState()).toEqual({ kind: 'bound', scriptRef: REF });
  });
});

describe('plan-479 F6 — the snapshot identity contract', () => {
  it('hands back the SAME object until something changes', () => {
    reportPluginLoaded(REF, 'bundle');
    const first = getPluginBindingState();
    expect(getPluginBindingState()).toBe(first);

    // A second model load of the same document reports the identical state.
    reportPluginLoaded(REF, 'bundle');
    expect(getPluginBindingState()).toBe(first);

    reportPluginLoaded(REF, 'runtime');
    expect(getPluginBindingState()).not.toBe(first);
  });

  it('notifies subscribers only for real changes', () => {
    let notifications = 0;
    subscribePluginBindingState(() => { notifications += 1; });

    reportPluginBinding(REF);
    expect(notifications).toBe(1);
    reportPluginBinding(REF);           // identical — silence
    expect(notifications).toBe(1);

    reportPluginFailed(REF, 'unresolved', 'a');
    expect(notifications).toBe(2);
    reportPluginFailed(REF, 'unresolved', 'a');
    expect(notifications).toBe(2);
    // Same reason, different detail: still a change the tooltip must show.
    reportPluginFailed(REF, 'unresolved', 'b');
    expect(notifications).toBe(3);

    clearPluginBindingState();
    expect(notifications).toBe(4);
    clearPluginBindingState();
    expect(notifications).toBe(4);
  });

  it('lets a subscriber unsubscribe', () => {
    let notifications = 0;
    const off = subscribePluginBindingState(() => { notifications += 1; });
    reportPluginBinding(REF);
    off();
    reportPluginLoaded(REF, 'bundle');
    expect(notifications).toBe(1);
  });

  it('distinguishes two documents that name different scripts', () => {
    reportPluginLoaded(REF, 'bundle');
    reportPluginBinding('plugins/index.ts');
    expect(getPluginBindingState()).toEqual({ kind: 'bound', scriptRef: 'plugins/index.ts' });
  });
});
