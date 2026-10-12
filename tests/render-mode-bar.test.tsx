// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-761 §9.3, rewritten for plan-578 §9.1 — the render-mode segment
 * (`RenderModeGroup`).
 *
 * The pill is ONE trigger now instead of three/four flat segments, so the modes
 * are addressed inside the OPEN menu. Every one of the six original assertions
 * is kept, only re-aimed at the DOM that actually changed:
 *
 *  - three rows in viewer mode, four in the editor; the active one follows the
 *    three events (`render-mode-changed`, `wireframe-changed`, `mode-changed`);
 *    leaving the editor drops the wireframe row and the shading row is active
 *    again (F1, F2)
 *  - a shading click executes `view.renderMode` with the per-mode button key,
 *    also while wireframe is applied (F3, F10)
 *  - the wireframe click executes `editor.wireframe {on:true}` (F4)
 *  - labels follow the toolbar-labels flag; aria-label / title are always
 *    there (F8) — the group's accessible name ("Render mode") moved from the
 *    pill's `radiogroup` to the menu's `role="menu"`, since a one-child
 *    radiogroup would be a lie
 *  - a locked deployment (both spellings) renders nothing (F7)
 *
 * plan-578 adds: the trigger icon follows the folded VALUE (so `ICONS` must
 * cover `wireframe`), the collapsed trigger proxies all four button keys, and a
 * refusing row shows its reason and does not execute.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { setAppConfig } from '../src/core/rv-app-config';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import { RenderModeGroup } from '../src/core/hmi/RenderModeBar';
import { setToolbarShowLabels } from '../src/core/hmi/visual-settings-store';
import { fakeRenderViewer, type FakeRenderViewer } from './helpers/fake-render-viewer';

const mount = (viewer: FakeRenderViewer) =>
  render(<RVViewerProvider value={viewer as never}><RenderModeGroup /></RVViewerProvider>);

/** `editor.wireframe` is editor-scoped: its view needs an active asset document. */
const withDocument = (viewer: FakeRenderViewer) =>
  setActiveAssetContext({
    viewer,
    doc: { id: 'doc-1', whenIdle: async () => {}, lockOwner: null } as unknown as ActiveAssetContext['doc'],
  });

const trigger = () => screen.getByTestId('render-mode-trigger');
const menu = () => screen.getByRole('menu');
/** Open the collapsed trigger and wait for the menu to be mounted. */
const openMenu = async () => {
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeNull());
};

afterEach(() => {
  cleanup();
  setAppConfig({});
  setActiveAssetContext(null);
  setToolbarShowLabels(false);
  vi.restoreAllMocks();
});

describe('RenderModeGroup', () => {
  it('3 rows in viewer mode, 4 in editor; active follows events; leaving the editor drops wireframe again', async () => {
    const viewer = fakeRenderViewer({ renderMode: 'default', mode: 'viewer' });
    mount(viewer);
    // The collapsed trigger names the active mode (F1).
    expect(trigger()).toHaveAttribute('aria-label', 'Render mode: Shaded');
    await openMenu();
    expect(within(menu()).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(screen.queryByTestId('render-mode-wireframe')).toBeNull();
    expect(screen.getByTestId('render-mode-default')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('render-mode-toon')).toHaveAttribute('aria-checked', 'false');

    act(() => viewer.setMode('editor'));                                   // 'mode-changed'
    expect(within(menu()).getAllByRole('menuitemradio')).toHaveLength(4);
    expect(screen.getByTestId('render-mode-wireframe')).toBeInTheDocument();
    expect(screen.getByTestId('render-mode-wireframe')).toHaveAttribute('aria-checked', 'false');

    act(() => { viewer.wireframe = true; });                               // 'wireframe-changed'
    expect(screen.getByTestId('render-mode-wireframe')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('render-mode-default')).toHaveAttribute('aria-checked', 'false');

    act(() => { viewer.renderMode = 'toon'; });                            // 'render-mode-changed' (wireframe still applied)
    expect(screen.getByTestId('render-mode-wireframe')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('render-mode-toon')).toHaveAttribute('aria-checked', 'false');

    act(() => viewer.setMode('viewer'));                                   // _wireframeOn stays, applied drops
    expect(viewer.wireframe).toBe(true);
    expect(screen.queryByTestId('render-mode-wireframe')).toBeNull();
    expect(screen.getByTestId('render-mode-toon')).toHaveAttribute('aria-checked', 'true');
  });

  it('shading row executes view.renderMode with per-mode buttonKey (also while wireframe is applied)', async () => {
    const viewer = fakeRenderViewer({ renderMode: 'default', wireframe: true, mode: 'editor' });
    const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: {} });
    mount(viewer);
    await openMenu();
    const toon = screen.getByTestId('render-mode-toon');
    await waitFor(() => expect(toon).not.toHaveAttribute('aria-disabled', 'true'));
    expect(toon.getAttribute('data-rv-button-id')).toBe('view.renderMode:toon');
    fireEvent.click(toon);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'view.renderMode',
      { mode: 'toon' },
      expect.objectContaining({ origin: 'ui', buttonKey: 'view.renderMode:toon', viewer }),
    );
    // Picking a mode closes the menu (the dropdown closes before executing).
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('wireframe row executes editor.wireframe {on:true}', async () => {
    const viewer = fakeRenderViewer({ mode: 'editor' });
    withDocument(viewer);
    const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: {} });
    mount(viewer);
    await openMenu();
    const wire = screen.getByTestId('render-mode-wireframe');
    await waitFor(() => expect(wire).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(wire);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('editor.wireframe', { on: true }, expect.objectContaining({ origin: 'ui', buttonKey: 'editor.wireframe' }));
  });

  it('labels follow the toolbar-labels flag; aria-label/title are always present', async () => {
    // The persisted store caches its value: go through its setter (the
    // Visual tab's switch does the same), not through localStorage.
    setToolbarShowLabels(false);
    const { unmount } = mount(fakeRenderViewer());
    // Collapsed and label-less, the trigger still names the active mode.
    expect(trigger()).toHaveAttribute('aria-label', 'Render mode: Shaded');
    expect(screen.queryByText('Shaded')).toBeNull();
    await openMenu();
    expect(screen.getByTestId('render-mode-default')).toHaveAttribute('aria-label', 'Shaded');
    expect(screen.getByTestId('render-mode-simple')).toHaveAttribute('aria-label', 'Unlit');
    expect(screen.getByTestId('render-mode-toon')).toHaveAttribute('aria-label', 'Toon');
    // The group's accessible name — formerly the pill's radiogroup label.
    expect(menu()).toHaveAttribute('aria-label', 'Render mode');
    unmount();
    setToolbarShowLabels(true);
    mount(fakeRenderViewer());
    // With labels on, the ACTIVE mode is written next to the trigger icon.
    expect(within(trigger()).getByText('Shaded')).toBeInTheDocument();
    await openMenu();
    // The open menu is an icon tower either way: rows are named by aria-label
    // and their tooltip, never by text in the row.
    expect(within(menu()).queryByText('Unlit')).toBeNull();
    expect(screen.getByTestId('render-mode-simple')).toHaveAttribute('aria-label', 'Unlit');
    fireEvent.mouseEnter(screen.getByTestId('render-mode-toon'));
    await waitFor(() => expect(document.querySelector('.MuiTooltip-popper')?.textContent).toBe('Toon'));
  });

  it.each([{ lockedTabs: ['visual'] }, { lockSettings: true }])('renders nothing when locked via %o', (cfg) => {
    setAppConfig(cfg as never);
    const { container } = mount(fakeRenderViewer());
    expect(container).toBeEmptyDOMElement();
  });

  it('the trigger icon follows wireframe and the editor exit, not just renderMode', () => {
    // The folded value can be 'wireframe', which the three-entry RenderMode map
    // could not answer — `ICONS[current]` was `undefined` there.
    const viewer = fakeRenderViewer({ renderMode: 'default', mode: 'editor' });
    mount(viewer);
    expect(within(trigger()).getByTestId('LensIcon')).toBeInTheDocument();
    act(() => { viewer.wireframe = true; });
    expect(within(trigger()).getByTestId('Grid4x4Icon')).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-label', 'Render mode: Wireframe');
    act(() => { viewer.renderMode = 'toon'; });                 // wireframe still applied
    expect(within(trigger()).getByTestId('Grid4x4Icon')).toBeInTheDocument();
    act(() => viewer.setMode('viewer'));                        // applied wireframe drops
    expect(within(trigger()).getByTestId('BrushIcon')).toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-label', 'Render mode: Toon');
  });

  it('the collapsed trigger proxies all six button keys', () => {
    // Fixed length in EVERY workspace — the wireframe key is simply never
    // touched outside the editor (plan-578 §2.5).
    // plan-591 appended the two quality keys, bringing the list to exactly
    // `PROXY_KEY_SLOTS` (6): a seventh would be silently dropped by the
    // trigger's fixed hook list, so that constant must grow with this string.
    mount(fakeRenderViewer({ mode: 'viewer' }));
    expect(trigger().getAttribute('data-rv-button-proxy')).toBe(
      'view.renderMode:simple view.renderMode:default view.renderMode:toon editor.wireframe'
      + ' view.visualPreset:Default view.visualPreset:Fast',
    );
  });

  it('a refusing command shows its reason on the row and does not execute', async () => {
    // Editor mode WITHOUT an active asset document: `editor.wireframe` refuses
    // with exactly the reason the MCP tool would give.
    const viewer = fakeRenderViewer({ mode: 'editor' });
    const spy = vi.spyOn(commandRegistry, 'execute');
    mount(viewer);
    await openMenu();
    const wire = screen.getByTestId('render-mode-wireframe');
    await waitFor(() => expect(wire).toHaveAttribute('aria-disabled', 'true'));
    const en = commandRegistry.enabled('editor.wireframe', { on: true }, viewer as never);
    const reason = en === true ? null : en.reason;
    expect(reason).toBeTruthy();
    // An icon row: the reason is announced (aria-description) and shown in the
    // row's tooltip — never a native `title=` that keyboard users never see. The
    // row keeps its hover although it refuses, or that tooltip could not appear.
    expect(wire).not.toHaveAttribute('title');
    expect(wire).toHaveAttribute('aria-description', reason!);
    fireEvent.mouseEnter(wire);
    await waitFor(() => expect(
      [...document.querySelectorAll('.MuiTooltip-popper')].some((t) => t.textContent?.includes(reason!)),
    ).toBe(true));
    fireEvent.click(wire);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeNull();
  });
});
