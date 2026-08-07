// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * OpenerMessagePlugin — per-model welcome/opener dialog.
 *
 * Covers the lifecycle contract (open on every onModelLoaded, close on
 * onModelCleared, once-per-session opt-out), the two suppression seams
 * (runtime setOpenerMessagesEnabled + settings.json disableOpenerMessages),
 * and that the overlay slot component renders the configured content and
 * closes via the button.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import {
  OpenerMessagePlugin,
  setOpenerMessagesEnabled,
  areOpenerMessagesEnabled,
  type OpenerMessageConfig,
} from '../src/plugins/opener-message-plugin';
import { setWelcomeModalOpen, _resetWelcomeModalForTests } from '../src/core/hmi/welcome-modal-store';
import { setAppConfig } from '../src/core/rv-app-config';
import type { UISlotProps } from '../src/core/rv-ui-plugin';

afterEach(() => {
  cleanup();
  _resetWelcomeModalForTests();
  setOpenerMessagesEnabled(true);
  setAppConfig({});
});

const CONFIG: OpenerMessageConfig = {
  title: 'Welcome to the Test Line',
  subtitle: 'Prototype Demo',
  paragraphs: ['First paragraph.'],
  highlights: [{ label: 'OEE badges', description: 'click a badge' }],
  footnote: 'All values are simulated.',
  buttonLabel: 'Start exploring',
};

const slotProps = { viewer: {} as never } as UISlotProps;

function renderHost(plugin: OpenerMessagePlugin) {
  const Host = plugin.slots[0].component;
  return render(<Host {...slotProps} />);
}

describe('OpenerMessagePlugin lifecycle', () => {
  it('opens on every model load and closes on model clear', () => {
    const plugin = new OpenerMessagePlugin(CONFIG);
    expect(plugin.openStore.getSnapshot()).toBe(false);

    plugin.onModelLoaded();
    expect(plugin.openStore.getSnapshot()).toBe(true);

    plugin.onModelCleared();
    expect(plugin.openStore.getSnapshot()).toBe(false);

    // Default: re-opens on the next load (showOnEveryLoad !== false).
    plugin.onModelLoaded();
    expect(plugin.openStore.getSnapshot()).toBe(true);
  });

  it('shows only once per session when showOnEveryLoad is false', () => {
    const plugin = new OpenerMessagePlugin({ ...CONFIG, showOnEveryLoad: false });

    plugin.onModelLoaded();
    expect(plugin.openStore.getSnapshot()).toBe(true);
    plugin.openStore.set(() => false); // user dismissed

    plugin.onModelLoaded();
    expect(plugin.openStore.getSnapshot()).toBe(false);
  });
});

describe('OpenerMessagePlugin suppression seams', () => {
  it('setOpenerMessagesEnabled(false) blocks onModelLoaded and hides a visible opener', async () => {
    const plugin = new OpenerMessagePlugin(CONFIG);
    renderHost(plugin);

    // Disabled before load: pending state is never set.
    setOpenerMessagesEnabled(false);
    expect(areOpenerMessagesEnabled()).toBe(false);
    plugin.onModelLoaded();
    expect(plugin.openStore.getSnapshot()).toBe(false);
    expect(screen.queryByText('Welcome to the Test Line')).toBeNull();

    // Disabled while visible: hides immediately (reactive).
    setOpenerMessagesEnabled(true);
    plugin.onModelLoaded();
    expect(await screen.findByText('Welcome to the Test Line')).toBeTruthy();
    setOpenerMessagesEnabled(false);
    await waitFor(() => expect(screen.queryByText('Welcome to the Test Line')).toBeNull());
  });

  it('settings.json disableOpenerMessages suppresses the opener', () => {
    setAppConfig({ disableOpenerMessages: true });
    const plugin = new OpenerMessagePlugin(CONFIG);
    renderHost(plugin);

    plugin.onModelLoaded();
    expect(plugin.openStore.getSnapshot()).toBe(false);
    expect(screen.queryByText('Welcome to the Test Line')).toBeNull();
  });
});

describe('OpenerMessagePlugin dialog rendering', () => {
  it('renders nothing while closed, full content when open', async () => {
    const plugin = new OpenerMessagePlugin(CONFIG);
    renderHost(plugin);

    expect(screen.queryByText('Welcome to the Test Line')).toBeNull();

    plugin.onModelLoaded();

    expect(await screen.findByText('Welcome to the Test Line')).toBeTruthy();
    expect(screen.getByText('Prototype Demo')).toBeTruthy();
    expect(screen.getByText('First paragraph.')).toBeTruthy();
    expect(screen.getByText('OEE badges')).toBeTruthy();
    expect(screen.getByText('All values are simulated.')).toBeTruthy();
  });

  it('closes via the confirm button', async () => {
    const plugin = new OpenerMessagePlugin(CONFIG);
    renderHost(plugin);
    plugin.onModelLoaded();

    const button = await screen.findByTestId('opener-message-close');
    expect(button.textContent).toBe('Start exploring');
    fireEvent.click(button);

    expect(plugin.openStore.getSnapshot()).toBe(false);
    expect(screen.queryByText('Welcome to the Test Line')).toBeNull();
  });

  it('defers behind the global WelcomeModal and appears once it closes', async () => {
    setWelcomeModalOpen(true);
    const plugin = new OpenerMessagePlugin(CONFIG);
    renderHost(plugin);
    plugin.onModelLoaded();

    // Opener is pending but must not render while the product welcome is up.
    expect(plugin.openStore.getSnapshot()).toBe(true);
    expect(screen.queryByText('Welcome to the Test Line')).toBeNull();

    setWelcomeModalOpen(false);
    expect(await screen.findByText('Welcome to the Test Line')).toBeTruthy();
  });
});
