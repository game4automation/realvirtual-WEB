// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-370 §9.4 — plugin lifecycle of the help registry (F12, F11, R1, R2).
 *
 * The no-op protection is checked by ACTUALLY subscribing to the store; an
 * earlier draft asserted it without a subscriber, which would have stayed green
 * with no protection at all.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerHelpTopic, readPluginTopic, subscribeHelpTopics, getHelpTopicsSnapshot,
  _resetHelpTopicRegistryForTests,
} from '../src/core/hmi/help-topic-registry';
import { deriveHelpTopic, readHelpContextInput } from '../src/core/hmi/help-context';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';

beforeEach(() => { _resetHelpTopicRegistryForTests(); });

const viewer = () => ({ leftPanelManager: new LeftPanelManager(), modes: { activeMode: null } });

describe('help topic registry', () => {
  it('removes the contribution on unregister', () => {
    const off = registerHelpTopic('p', { slug: 'odt' });
    expect(readPluginTopic()?.slug).toBe('odt');
    off();
    expect(readPluginTopic()).toBeNull();
  });

  it('is idempotent when the same disposer runs twice', () => {
    const off = registerHelpTopic('p', { slug: 'odt' });
    off();
    off();
    expect(readPluginTopic()).toBeNull();
  });

  it('ignores a stale disposer from a superseded registration', () => {
    const first = registerHelpTopic('p', { slug: 'odt' });
    registerHelpTopic('p', { slug: 'des/overview' });
    first(); // must not remove the newer registration
    expect(readPluginTopic()?.slug).toBe('des/overview');
  });

  it('does not notify subscribers when the topic is unchanged in content', () => {
    const listener = vi.fn();
    const unsub = subscribeHelpTopics(listener);
    registerHelpTopic('p', { slug: 'odt' });
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    const versionBefore = getHelpTopicsSnapshot();
    registerHelpTopic('p', { slug: 'odt' }); // fresh object, same content
    expect(listener).not.toHaveBeenCalled();
    expect(getHelpTopicsSnapshot()).toBe(versionBefore);
    unsub();
  });

  it('notifies when the anchor changes', () => {
    const listener = vi.fn();
    const unsub = subscribeHelpTopics(listener);
    registerHelpTopic('p', { slug: 'odt' });
    listener.mockClear();
    registerHelpTopic('p', { slug: 'odt', anchor: 'x' });
    expect(listener).toHaveBeenCalled();
    expect(readPluginTopic()).toEqual({ slug: 'odt', anchor: 'x' });
    unsub();
  });

  it('keeps the first registration order for two equal-rank sources', () => {
    registerHelpTopic('a', { slug: 'odt' });
    registerHelpTopic('b', { slug: 'des/overview' });
    expect(readPluginTopic()?.slug).toBe('odt');
  });

  it('keeps its position when the same sourceId re-registers', () => {
    registerHelpTopic('a', { slug: 'odt' });
    registerHelpTopic('b', { slug: 'des/overview' });
    registerHelpTopic('a', { slug: 'connect/overview' }); // Map.set does not move 'a'
    expect(readPluginTopic()?.slug).toBe('connect/overview');
  });

  it('hands over to the next source after dispose and re-sorts behind it on return', () => {
    const offA = registerHelpTopic('a', { slug: 'odt' });
    registerHelpTopic('b', { slug: 'des/overview' });
    offA();
    expect(readPluginTopic()?.slug).toBe('des/overview');
    registerHelpTopic('a', { slug: 'odt' }); // now sorted BEHIND b
    expect(readPluginTopic()?.slug).toBe('des/overview');
  });

  // F11 for plugin contributions — the only thing that can go stale at all.
  it('drops a plugin topic when the plugin is disposed', () => {
    class FakePlugin {
      private unregisterHelp: (() => void) | null = null;
      init() {
        this.unregisterHelp = registerHelpTopic('plugin:fake', { slug: 'des/overview' });
      }
      dispose() { this.unregisterHelp?.(); this.unregisterHelp = null; }
    }
    const v = viewer();
    const plugin = new FakePlugin();
    plugin.init();
    expect(deriveHelpTopic(readHelpContextInput(v)).slug).toBe('des/overview');
    plugin.dispose();
    expect(deriveHelpTopic(readHelpContextInput(v)).slug).not.toBe('des/overview');
  });

  it('stores a defensive copy so a mutated caller object cannot change the registry', () => {
    const topic = { slug: 'odt', anchor: 'a' };
    registerHelpTopic('p', topic);
    (topic as { slug: string }).slug = 'des/overview';
    expect(readPluginTopic()?.slug).toBe('odt');
  });
});
