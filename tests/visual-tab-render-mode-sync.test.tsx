// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-761 §9.4 — F5: the Visual tab dropdown stays in sync with the pill and
 * MCP, and a later slider persist keeps the NEW mode.
 *
 * Deliberately through the REAL command path (`commandRegistry.execute(
 * 'view.renderMode', …)`), never `viewer.renderMode = …`: only the real path
 * runs `setRenderMode`, whose persist-before-setter order is what the tab's
 * `render-mode-changed` listener relies on (review S1). A test that set the
 * viewer directly would keep the stale-revert bug invisible.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { loadVisualSettings } from '../src/core/hmi/visual-settings-store';
import { setAppConfig } from '../src/core/rv-app-config';
import { VisualTab } from '../src/core/hmi/settings/VisualTab';
import { visualTabCapableFake, type FakeRenderViewer } from './helpers/fake-render-viewer';

const mount = (viewer: FakeRenderViewer) =>
  render(<RVViewerProvider value={viewer as never}><VisualTab /></RVViewerProvider>);

/** The MUI Select root carries the test id; its hidden native input fires `onChange`. */
const select = () => screen.getByTestId('visual-render-mode-select');
const selectInput = () => select().querySelector('input') as HTMLInputElement;
const lightIntensityInput = () =>
  screen.getByTestId('visual-light-intensity').querySelector('input[type="range"]') as HTMLInputElement;

beforeEach(() => {
  localStorage.clear();
  setAppConfig({});
  ensureViewCommandsRegistered();
  ensureSessionOverlayCommandsRegistered();
  ensureComponentCommandsRegistered();
  ensureQueryCommandsRegistered();
  ensureDocumentCommandsRegistered();
  ensureSignalAutomapCommandsRegistered();
  ensureDesPlcCommandsRegistered();
});

afterEach(() => {
  cleanup();
  commandRegistry.attachViewer(undefined);
  setAppConfig({});
  localStorage.clear();
});

describe('VisualTab ↔ view.renderMode', () => {
  it('pill/MCP switch via view.renderMode updates the dropdown and a later slider persist keeps the new mode', async () => {
    const viewer = visualTabCapableFake({ renderMode: 'default' });
    commandRegistry.attachViewer(viewer as never);
    mount(viewer);
    expect(select()).toHaveTextContent('Shaded');

    // Like the pill or web_view_render_mode: the command, no viewer override.
    await act(async () => {
      const r = await commandRegistry.execute('view.renderMode', { mode: 'toon' }, { origin: 'mcp' });
      expect(r.ok).toBe(true);
    });
    expect(viewer.renderMode).toBe('toon');
    await waitFor(() => expect(select()).toHaveTextContent('Toon'));
    expect(loadVisualSettings().renderMode).toBe('toon');

    // A later slider change persists through the tab's settingsRef — which must
    // carry the NEW mode, not the one it was mounted with.
    fireEvent.change(lightIntensityInput(), { target: { value: '2' } });
    await waitFor(() => expect(loadVisualSettings().modeSettings.toon.lightIntensity).toBe(2));
    expect(loadVisualSettings().renderMode).toBe('toon');
    expect(viewer.calls).toContain('lightIntensity=2');
  });

  it('the dropdown itself goes through the command: persisted, viewer set, pre-pushes before the setter', async () => {
    const viewer = visualTabCapableFake({ renderMode: 'default' });
    commandRegistry.attachViewer(viewer as never);
    mount(viewer);
    fireEvent.change(selectInput(), { target: { value: 'simple' } });
    await waitFor(() => expect(viewer.renderMode).toBe('simple'));
    await waitFor(() => expect(select()).toHaveTextContent('Unlit'));
    expect(loadVisualSettings().renderMode).toBe('simple');
    const i = (s: string) => viewer.calls.findIndex((c) => c.startsWith(s));
    expect(i('shadowEnabled=')).toBeGreaterThan(-1);
    expect(i('shadowEnabled=')).toBeLessThan(i('renderMode=simple'));
  });

  it('a refused command resets the dropdown to the viewer state', async () => {
    // The tab would be hidden by SettingsPanel under this lock; here only the
    // fallback of updateMode is under test.
    setAppConfig({ lockedTabs: ['visual'] });
    const viewer = visualTabCapableFake({ renderMode: 'default' });
    commandRegistry.attachViewer(viewer as never);
    mount(viewer);
    fireEvent.change(selectInput(), { target: { value: 'toon' } });
    // MUI shows the picked item at once; the refusal snaps it back.
    await waitFor(() => expect(select()).toHaveTextContent('Shaded'));
    expect(viewer.renderMode).toBe('default');
    expect(viewer.calls).not.toContain('renderMode=toon');
    expect(loadVisualSettings().renderMode).toBe('default');
  });
});
