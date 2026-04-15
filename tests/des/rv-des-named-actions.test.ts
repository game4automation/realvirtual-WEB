// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESNamedActions -- Named Action registry tests.
 *
 * Validates registration, O(1) dispatch, duplicate detection,
 * and reverse lookup for snapshot serialization.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerAction,
  getActionIndex,
  getActionName,
  ACTION_BY_INDEX,
  ACTION_INDEX,
  ACTION_NAME,
} from '@rv-private/plugins/des/rv-des-named-actions';
import type { ActionContext } from '@rv-private/plugins/des/rv-des-event';

/**
 * Helper: clear all registered actions between tests.
 * This is needed because the registry is module-level (global).
 */
function clearActionRegistry(): void {
  ACTION_BY_INDEX.length = 0;
  ACTION_INDEX.clear();
  ACTION_NAME.clear();
}

describe('DES Named Actions', () => {
  beforeEach(() => {
    clearActionRegistry();
  });

  it('registerAction stores and retrieves by name', () => {
    let called = false;
    const idx = registerAction('Test.Action', (_ctx) => { called = true; });

    expect(ACTION_BY_INDEX[idx]).toBeDefined();
    expect(typeof ACTION_BY_INDEX[idx]).toBe('function');
    expect(ACTION_INDEX.get('Test.Action')).toBe(idx);

    // Actually call it
    const ctx: ActionContext = {
      simTime: 0,
      componentPath: '',
      muId: -1,
      data: null,
      manager: null as unknown as ActionContext['manager'],
    };
    ACTION_BY_INDEX[idx](ctx);
    expect(called).toBe(true);
  });

  it('dispatch calls correct handler via ACTION_BY_INDEX', () => {
    const results: string[] = [];
    const idx1 = registerAction('Action.A', () => { results.push('A'); });
    const idx2 = registerAction('Action.B', () => { results.push('B'); });
    const idx3 = registerAction('Action.C', () => { results.push('C'); });

    const ctx: ActionContext = {
      simTime: 0,
      componentPath: '',
      muId: -1,
      data: null,
      manager: null as unknown as ActionContext['manager'],
    };

    ACTION_BY_INDEX[idx2](ctx);
    ACTION_BY_INDEX[idx1](ctx);
    ACTION_BY_INDEX[idx3](ctx);

    expect(results).toEqual(['B', 'A', 'C']);
  });

  it('duplicate registration throws descriptive error', () => {
    registerAction('Test.Dup', () => {});
    expect(() => registerAction('Test.Dup', () => {})).toThrow('duplicate');
  });

  it('getActionIndex throws for unknown action', () => {
    expect(() => getActionIndex('NonExistent.Action')).toThrow('unknown action');
  });

  it('ACTION_NAME reverse lookup returns correct string', () => {
    const idx = registerAction('Snapshot.TestAction', () => {});
    expect(ACTION_NAME.get(idx)).toBe('Snapshot.TestAction');
    expect(getActionName(idx)).toBe('Snapshot.TestAction');
  });
});
