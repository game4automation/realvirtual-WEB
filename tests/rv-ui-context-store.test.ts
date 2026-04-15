// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  activateContext,
  deactivateContext,
  isContextActive,
  getActiveContexts,
  setContext,
  resetDynamicContexts,
  registerUIElement,
  isUIElementVisible,
  _subscribe,
  _resetStore,
} from '../src/core/hmi/ui-context-store';

// ─── 9.1 TestContextStoreActivation ─────────────────────────────────────

describe('ui-context-store: context management', () => {
  beforeEach(() => _resetStore());

  it('activates and deactivates contexts', () => {
    activateContext('fpv');
    expect(isContextActive('fpv')).toBe(true);
    deactivateContext('fpv');
    expect(isContextActive('fpv')).toBe(false);
  });

  it('supports multiple simultaneous contexts', () => {
    activateContext('fpv');
    activateContext('maintenance');
    expect(getActiveContexts().size).toBe(2);
    expect(isContextActive('fpv')).toBe(true);
    expect(isContextActive('maintenance')).toBe(true);
  });

  it('setContext convenience works both ways', () => {
    setContext('planner', true);
    expect(isContextActive('planner')).toBe(true);
    setContext('planner', false);
    expect(isContextActive('planner')).toBe(false);
  });

  it('duplicate activate is idempotent', () => {
    activateContext('fpv');
    activateContext('fpv');
    expect(getActiveContexts().size).toBe(1);
  });

  it('deactivate non-active context is no-op', () => {
    deactivateContext('fpv'); // should not throw
    expect(isContextActive('fpv')).toBe(false);
  });

  it('getActiveContexts returns immutable snapshot', () => {
    activateContext('fpv');
    const snap1 = getActiveContexts();
    activateContext('xr');
    const snap2 = getActiveContexts();
    expect(snap1).not.toBe(snap2);
    expect(snap1.size).toBe(1);
    expect(snap2.size).toBe(2);
  });

  it('resetDynamicContexts clears all except initial contexts', () => {
    // Simulate: kiosk was set as initialContext, fpv+planner are dynamic
    activateContext('kiosk');
    activateContext('fpv');
    activateContext('planner');
    expect(getActiveContexts().size).toBe(3);

    resetDynamicContexts(['kiosk']); // preserve kiosk
    expect(isContextActive('kiosk')).toBe(true);
    expect(isContextActive('fpv')).toBe(false);
    expect(isContextActive('planner')).toBe(false);
    expect(getActiveContexts().size).toBe(1);
  });
});

// ─── 9.2 TestVisibilityRuleEvaluation ───────────────────────────────────

describe('ui-context-store: visibility rules', () => {
  beforeEach(() => _resetStore());

  it('unknown element defaults to visible', () => {
    expect(isUIElementVisible('nonexistent', new Set())).toBe(true);
  });

  it('hiddenIn hides when any matching context active', () => {
    registerUIElement('kpi-bar', { hiddenIn: ['fpv', 'planner'] });
    expect(isUIElementVisible('kpi-bar', new Set(['fpv']))).toBe(false);
    expect(isUIElementVisible('kpi-bar', new Set(['planner']))).toBe(false);
    expect(isUIElementVisible('kpi-bar', new Set(['maintenance']))).toBe(true);
    expect(isUIElementVisible('kpi-bar', new Set([]))).toBe(true);
  });

  it('shownOnlyIn requires ALL listed contexts to be active', () => {
    registerUIElement('maint-timer', { shownOnlyIn: ['maintenance'] });
    expect(isUIElementVisible('maint-timer', new Set([]))).toBe(false);
    expect(isUIElementVisible('maint-timer', new Set(['maintenance']))).toBe(true);
    expect(isUIElementVisible('maint-timer', new Set(['fpv']))).toBe(false);
  });

  it('shownOnlyIn with multiple contexts requires ALL present', () => {
    registerUIElement('special-widget', { shownOnlyIn: ['maintenance', 'fpv'] });
    expect(isUIElementVisible('special-widget', new Set(['maintenance']))).toBe(false);
    expect(isUIElementVisible('special-widget', new Set(['fpv']))).toBe(false);
    expect(isUIElementVisible('special-widget', new Set(['maintenance', 'fpv']))).toBe(true);
    expect(isUIElementVisible('special-widget', new Set(['maintenance', 'fpv', 'xr']))).toBe(true);
  });

  it('hiddenIn wins over shownOnlyIn when both match', () => {
    registerUIElement('special', {
      shownOnlyIn: ['maintenance'],
      hiddenIn: ['xr'],
    });
    expect(isUIElementVisible('special', new Set(['maintenance']))).toBe(true);
    expect(isUIElementVisible('special', new Set(['maintenance', 'xr']))).toBe(false);
  });

  it('shownOnlyIn hides before hiddenIn is even checked', () => {
    registerUIElement('special', {
      shownOnlyIn: ['maintenance'],
      hiddenIn: ['xr'],
    });
    // shownOnlyIn not met -> hidden regardless of hiddenIn
    expect(isUIElementVisible('special', new Set(['fpv']))).toBe(false);
    expect(isUIElementVisible('special', new Set([]))).toBe(false);
  });

  it('empty hiddenIn array means never hidden by context', () => {
    registerUIElement('bottom-bar', { hiddenIn: [] });
    expect(isUIElementVisible('bottom-bar', new Set(['fpv', 'planner', 'xr']))).toBe(true);
  });

  it('element with no rule (undefined) is always visible', () => {
    // Simulates a UISlotEntry without visibilityRule
    expect(isUIElementVisible('unregistered-plugin-widget', new Set(['fpv', 'planner']))).toBe(true);
  });
});

// ─── 9.3 TestConfigOverrides ────────────────────────────────────────────

describe('ui-context-store: config overrides', () => {
  beforeEach(() => _resetStore());

  it('later registerUIElement call overrides previous rule', () => {
    registerUIElement('kpi-bar', { hiddenIn: ['fpv'] });
    expect(isUIElementVisible('kpi-bar', new Set(['planner']))).toBe(true);

    registerUIElement('kpi-bar', { hiddenIn: ['fpv', 'planner', 'kiosk'] });
    expect(isUIElementVisible('kpi-bar', new Set(['planner']))).toBe(false);
    expect(isUIElementVisible('kpi-bar', new Set(['kiosk']))).toBe(false);
  });

  it('override with empty hiddenIn removes hiding rule', () => {
    registerUIElement('kpi-bar', { hiddenIn: ['fpv', 'planner'] });
    expect(isUIElementVisible('kpi-bar', new Set(['fpv']))).toBe(false);

    registerUIElement('kpi-bar', { hiddenIn: [] });
    expect(isUIElementVisible('kpi-bar', new Set(['fpv']))).toBe(true);
  });

  it('other elements are unaffected by override', () => {
    registerUIElement('kpi-bar', { hiddenIn: ['fpv'] });
    registerUIElement('message-panel', { hiddenIn: ['fpv'] });

    registerUIElement('kpi-bar', { hiddenIn: [] }); // override only kpi-bar
    expect(isUIElementVisible('kpi-bar', new Set(['fpv']))).toBe(true);
    expect(isUIElementVisible('message-panel', new Set(['fpv']))).toBe(false);
  });
});

// ─── 9.4 TestSubscriberNotification ─────────────────────────────────────

describe('ui-context-store: subscriber notifications', () => {
  beforeEach(() => _resetStore());

  it('notifies subscribers on context change', () => {
    const listener = vi.fn();
    const unsub = _subscribe(listener);

    activateContext('fpv');
    expect(listener).toHaveBeenCalledTimes(1);

    deactivateContext('fpv');
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    activateContext('xr');
    expect(listener).toHaveBeenCalledTimes(2); // no more calls after unsub
  });

  it('does not notify on duplicate activate', () => {
    const listener = vi.fn();
    const unsub = _subscribe(listener);

    activateContext('fpv');
    activateContext('fpv'); // duplicate — no change to Set
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
  });

  it('notifies on registerUIElement for late-mounted components', () => {
    const listener = vi.fn();
    const unsub = _subscribe(listener);

    // Simulate: plugin registers rule after component already subscribed
    registerUIElement('late-widget', { hiddenIn: ['fpv'] });
    expect(listener).toHaveBeenCalledTimes(1); // must trigger re-evaluation

    unsub();
  });
});

// ─── 9.5 TestSlotRendererFiltering ──────────────────────────────────────

describe('ui-context-store: SlotRenderer integration', () => {
  beforeEach(() => _resetStore());

  it('entry without visibilityRule is always visible regardless of context', () => {
    activateContext('fpv');
    activateContext('planner');
    activateContext('xr');
    // No rule registered for this ID
    expect(isUIElementVisible('plugin-without-rule', getActiveContexts())).toBe(true);
  });

  it('entry with visibilityRule is hidden when context matches', () => {
    registerUIElement('oee-chart', { hiddenIn: ['planner'] });
    activateContext('planner');
    expect(isUIElementVisible('oee-chart', getActiveContexts())).toBe(false);
  });

  it('entry becomes visible again when context deactivates', () => {
    registerUIElement('oee-chart', { hiddenIn: ['planner'] });
    activateContext('planner');
    expect(isUIElementVisible('oee-chart', getActiveContexts())).toBe(false);

    deactivateContext('planner');
    expect(isUIElementVisible('oee-chart', getActiveContexts())).toBe(true);
  });
});

// ─── 9.6 TestConfigParsing ──────────────────────────────────────────────

describe('ui-context-store: config parsing', () => {
  it('handles missing ui field gracefully', () => {
    const config: Record<string, unknown> = {}; // no ui key
    const contexts = (config.ui as { initialContexts?: string[] })?.initialContexts ?? [];
    const overrides = (config.ui as { visibilityOverrides?: Record<string, unknown> })?.visibilityOverrides ?? {};
    expect(contexts).toEqual([]);
    expect(overrides).toEqual({});
  });

  it('handles null initialContexts gracefully', () => {
    const config = { ui: { initialContexts: null } } as Record<string, unknown>;
    const ui = config.ui as { initialContexts: unknown } | undefined;
    const contexts = Array.isArray(ui?.initialContexts) ? ui!.initialContexts : [];
    expect(contexts).toEqual([]);
  });

  it('handles non-object visibilityOverrides gracefully', () => {
    const config = { ui: { visibilityOverrides: 'invalid' } } as Record<string, unknown>;
    const ui = config.ui as { visibilityOverrides: unknown } | undefined;
    const overrides = (typeof ui?.visibilityOverrides === 'object' && ui?.visibilityOverrides !== null)
      ? ui!.visibilityOverrides
      : {};
    expect(overrides).toEqual({});
  });
});
