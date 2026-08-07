// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-370 §9.2 — the derivation itself: ranking (F3), fallback (F4), two
 * windows open at once (F10) and a real model-switch lifecycle (F11).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deriveHelpTopic, readHelpContextInput, readPanelFromSnapshot, HELP_PRIORITY,
} from '../src/core/hmi/help-context';
import { HELP_FALLBACK } from '../src/core/hmi/help-topics';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { registerHelpTopic, _resetHelpTopicRegistryForTests } from '../src/core/hmi/help-topic-registry';
import { activateContext, deactivateContext } from '../src/core/hmi/ui-context-store';

/**
 * Minimal viewer double. `clearModel()` deliberately leaves mode AND panels
 * alone — that is what rv-viewer really does (the active workspace mode is
 * preserved, and leftPanelManager lives on the viewer for its whole lifetime).
 */
function makeViewerStub() {
  let active: string | null = null;
  return {
    leftPanelManager: new LeftPanelManager(),
    modes: {
      get activeMode() { return active; },
      activate(id: string) { active = id; },
      deactivate(id: string) { if (active === id) active = null; },
      subscribe: () => () => undefined,
      getSnapshot: () => 0,
    },
    clearModel() { /* preserves mode and panels — see rv-viewer */ },
  };
}

beforeEach(() => {
  _resetHelpTopicRegistryForTests();
  localStorage.removeItem('rv-left-panel-active');
});

afterEach(() => {
  _resetHelpTopicRegistryForTests();
  deactivateContext('planner');
  localStorage.removeItem('rv-left-panel-active');
});

describe('deriveHelpTopic', () => {
  it('ranks plugin above panel above mode', () => {
    expect(HELP_PRIORITY.plugin).toBeGreaterThan(HELP_PRIORITY.panel);
    expect(HELP_PRIORITY.panel).toBeGreaterThan(HELP_PRIORITY.mode);
  });

  it('falls back when nothing is active', () => {
    expect(deriveHelpTopic({ panel: null, mode: null, pluginTopic: null }))
      .toEqual(HELP_FALLBACK);
  });

  it('prefers the panel over the mode', () => {
    expect(deriveHelpTopic({ panel: 'connect', mode: 'des', pluginTopic: null }).slug)
      .toBe('connect/overview');
  });

  it('lets a plugin contribution win over everything', () => {
    expect(deriveHelpTopic({
      panel: 'connect', mode: 'des', pluginTopic: { slug: 'odt' },
    }).slug).toBe('odt');
  });

  it('uses the mode when the open panel has no topic', () => {
    expect(deriveHelpTopic({ panel: 'other', mode: 'planner', pluginTopic: null }).slug)
      .toBe('planner/overview');
  });

  it('keeps an anchor from a plugin contribution', () => {
    const topic = deriveHelpTopic({
      panel: null, mode: null, pluginTopic: { slug: 'des/overview', anchor: 'setup' },
    });
    expect(topic).toEqual({ slug: 'des/overview', anchor: 'setup' });
  });
});

describe('panel resolution across both sides (F10)', () => {
  it('resolves the panel from lastOpenedSide when both sides are open', () => {
    const lpm = new LeftPanelManager();
    lpm.open('layout-planner', 300, 'left');
    lpm.open('connect', 280, 'right');
    expect(readPanelFromSnapshot(lpm.getSnapshot())).toBe('connect');
    // Re-opening the SAME left window must move the focus back — the manager's
    // early exit used to swallow exactly this.
    lpm.open('layout-planner', 300, 'left');
    expect(readPanelFromSnapshot(lpm.getSnapshot())).toBe('layout-planner');
  });

  it('falls back to the remaining side when the last opened one closes', () => {
    const lpm = new LeftPanelManager();
    lpm.open('layout-planner', 300, 'left');
    lpm.open('connect', 280, 'right');
    lpm.close('connect');
    expect(readPanelFromSnapshot(lpm.getSnapshot())).toBe('layout-planner');
  });

  it('reports no panel when nothing is open', () => {
    expect(readPanelFromSnapshot(new LeftPanelManager().getSnapshot())).toBeNull();
    expect(readPanelFromSnapshot(null)).toBeNull();
  });
});

describe('readHelpContextInput lifecycle (F11)', () => {
  it('reads fresh manager state after a model clear', () => {
    const viewer = makeViewerStub();
    viewer.leftPanelManager.open('layout-planner', 300, 'left');
    viewer.modes.activate('planner');
    expect(deriveHelpTopic(readHelpContextInput(viewer)).slug).toBe('planner/overview');

    viewer.clearModel(); // preserves the active mode
    expect(deriveHelpTopic(readHelpContextInput(viewer)).slug).toBe('planner/overview');

    viewer.leftPanelManager.close('layout-planner');
    expect(deriveHelpTopic(readHelpContextInput(viewer)).slug).toBe('planner/overview');
    viewer.modes.deactivate('planner');
    expect(deriveHelpTopic(readHelpContextInput(viewer))).toEqual(HELP_FALLBACK);
  });

  it('picks up a plugin contribution and drops it again', () => {
    const viewer = makeViewerStub();
    const off = registerHelpTopic('plugin:test', { slug: 'odt' });
    expect(deriveHelpTopic(readHelpContextInput(viewer)).slug).toBe('odt');
    off();
    expect(deriveHelpTopic(readHelpContextInput(viewer))).toEqual(HELP_FALLBACK);
  });

  it('degrades to the fallback for a viewer without managers', () => {
    expect(readHelpContextInput({})).toEqual({ panel: null, mode: null, pluginTopic: null });
    expect(readHelpContextInput(null)).toEqual({ panel: null, mode: null, pluginTopic: null });
  });
});

// Assumption 3 — `mode:planner` is the leading planner signal; the legacy
// ui-context `'planner'` is deliberately NOT a source.
describe('legacy planner context', () => {
  it('is ignored as a source', () => {
    activateContext('planner');
    expect(deriveHelpTopic({ panel: null, mode: null, pluginTopic: null }))
      .toEqual(HELP_FALLBACK);
    const viewer = makeViewerStub();
    expect(deriveHelpTopic(readHelpContextInput(viewer))).toEqual(HELP_FALLBACK);
  });
});
