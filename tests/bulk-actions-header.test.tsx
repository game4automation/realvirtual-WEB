// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.8 — bulk actions as component-section actions (F5):
 *  - registered via componentActionRegistry for slot-bearing types.
 *  - Auto-assign: confident matches only (exact / token >= 0.75), armed on the
 *    first click (confirm gate), applied on the second.
 *  - Unbind all: two-click confirm (label flips to "Confirm unbind all").
 *  - The old inspector SignalBindSection is gone from the codebase.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  registerSignalBulkActions,
  _resetBulkActionStateForTesting,
} from '../src/plugins/signal-bind/component-bulk-actions';
import { componentActionRegistry, type ComponentActionContext } from '../src/core/hmi/rv-component-action-registry';
import { makeInlineSlotFixture } from './_inline-slot-fixture';
import { getConnectSnapshot } from '../src/core/hmi/connect-store';

vi.mock('../src/core/hmi/connect-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/connect-store')>();
  return {
    ...actual,
    getConnectSnapshot: vi.fn(() => actual.getConnectSnapshot()),
  };
});

function withConnectSignals(names: string[]): void {
  vi.mocked(getConnectSnapshot).mockReturnValue({
    interfaces: [{
      id: 'plc',
      signals: names.map((name) => ({ name, type: 'PLCOutputBool' })),
    }],
  } as unknown as ReturnType<typeof getConnectSnapshot>);
}

function ctxFor(f: ReturnType<typeof makeInlineSlotFixture>): ComponentActionContext {
  return {
    node: f.node,
    nodePath: f.nodePath,
    viewer: f.viewer,
    componentData: f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>,
    componentType: 'Drive_Simple',
  };
}

describe('bulk header actions (plan-325 9.8)', () => {
  beforeEach(() => {
    _resetBulkActionStateForTesting();
    registerSignalBulkActions();
  });

  it('registers Auto-assign and Unbind-all for slot-bearing component types', () => {
    const actions = componentActionRegistry.get('Drive_Simple');
    const ids = actions.map((a) => a.id);
    expect(ids).toContain('signal-auto-assign');
    expect(ids).toContain('signal-unbind-all');
    // Types without signal slots get no bulk actions.
    expect(componentActionRegistry.get('LayoutObject').map((a) => a.id))
      .not.toContain('signal-auto-assign');
  });

  it('Auto-assign arms with confident matches on the first click and applies on the second', () => {
    withConnectSignals(['Forward', 'TotallyUnrelatedXyz']);
    const f = makeInlineSlotFixture();
    const ctx = ctxFor(f);
    const auto = componentActionRegistry.get('Drive_Simple').find((a) => a.id === 'signal-auto-assign')!;

    expect(auto.visible?.(ctx)).toBe(true);
    expect(typeof auto.label === 'function' ? auto.label(ctx) : auto.label).toBe('Auto-assign');

    // First click: confirm gate — computes suggestions, binds NOTHING yet.
    auto.onClick(ctx);
    expect(auto.isActive?.(ctx)).toBe(true);
    const armedLabel = typeof auto.label === 'function' ? auto.label(ctx) : auto.label;
    expect(armedLabel).toMatch(/^Apply \d+$/);
    expect(f.mgr.getBindingLiveness(f.nodePath, 'Forward', '.')).toBeUndefined();

    // Second click: applies the exact 'Forward' match (weak matches dropped).
    auto.onClick(ctx);
    expect(auto.isActive?.(ctx)).toBe(false);
    f.mgr.tick(0.02);
    expect(f.mgr.getBindingLiveness(f.nodePath, 'Forward', '.')).toBeDefined();
    const links = f.mgr.getLinkedSourceNames();
    expect(links.has('Forward')).toBe(true);
    expect(links.has('TotallyUnrelatedXyz')).toBe(false);
  });

  it('Unbind all requires the two-click confirm and then clears the section mappings', () => {
    withConnectSignals([]);
    const f = makeInlineSlotFixture();
    const applied = f.mgr.applyMappings(f.nodePath, f.node, [{
      kind: 'mapped-signal', componentPath: '.', slot: 'Forward',
      sourceKind: 'internal', signal: 'ModelSig', direction: 'plcOutput', enabled: true,
    }]);
    // Persisted state the section reads (node path = SignalLinks.Mappings).
    (f.node.userData.realvirtual as Record<string, unknown>).SignalLinks = { Mappings: applied };
    const ctx = ctxFor(f);
    const unbind = componentActionRegistry.get('Drive_Simple').find((a) => a.id === 'signal-unbind-all')!;

    expect(unbind.visible?.(ctx)).toBe(true);
    expect(typeof unbind.label === 'function' ? unbind.label(ctx) : unbind.label).toBe('Unbind all');

    // First click only ARMS (nothing unbound yet).
    unbind.onClick(ctx);
    expect(typeof unbind.label === 'function' ? unbind.label(ctx) : unbind.label).toBe('Confirm unbind all');
    expect(f.mgr.getLinkedSourceNames().size).toBe(1);

    // Second click executes.
    unbind.onClick(ctx);
    expect(f.mgr.getLinkedSourceNames().size).toBe(0);
  });

  it('the old inspector SignalBindSection no longer exists in the codebase', () => {
    const modules = import.meta.glob('../src/plugins/signal-bind/SignalBindSection.tsx');
    expect(Object.keys(modules)).toHaveLength(0);
  });
});
