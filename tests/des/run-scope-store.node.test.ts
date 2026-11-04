// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Nullable run scope resets must disable archiving and discard old pins. */
import { afterEach, expect, it } from 'vitest';
import { runScopeStore } from '../../src/core/material-flow/rv-run-history-store';

afterEach(() => runScopeStore.set(() => null));

it('keeps an empty scope null when cleared directly', () => {
  runScopeStore.set(() => null);
  runScopeStore.set(null);
  expect(runScopeStore.getSnapshot()).toBeNull();
});

it('clears the destination and optional configuration before a late scope arrives', () => {
  runScopeStore.set(() => ({ model: 'Old', exp: 'Pinned', projectId: 'p',
    rngVersion: 2, crn: false, baseKey: 'old-base' }));
  runScopeStore.set(null);
  expect(runScopeStore.getSnapshot()).toBeNull();
  runScopeStore.set({ model: 'AgvGuard', exp: 'F07', projectId: null });
  expect(runScopeStore.getSnapshot()).toEqual({ model: 'AgvGuard', exp: 'F07', projectId: null });
});
