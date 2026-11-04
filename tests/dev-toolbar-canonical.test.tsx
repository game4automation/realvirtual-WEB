// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-615 §9.1 / §9.2 — the dev toolbar button that replaced the
 * ENTWICKLUNGSSERVER banner.
 *
 * 9.1 The button exists when serve info is present and its tooltip names
 *     label, port, machine, path and branch.
 * 9.2 Canonical checkout: red button + warning dot + `[⚠ CANONICAL]` in the
 *     tab title. Worktree session: discreet button, `[Plan N]` title.
 *
 * Plus the placement (fix round 1: the button is the LAST entry of the
 * activity bar / mobile pill, in the dev AND the delivered view), the fallback
 * handle (only while no bar button is mounted) and the popover wiring (view
 * switch calls the host, snapshot save posts to the dev endpoint).
 */

import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActivityBar } from '../src/core/hmi/ActivityBar';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { setAppConfig } from '../src/core/rv-app-config';
import { modeManagerDouble } from './fixtures/mode-manager-double';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import {
  CANONICAL_TITLE_PREFIX, DevSessionHost, DevToolbarButton, getMountedDevBarButtonCount, serveSessionTitlePrefix,
} from '../src/core/hmi/DevToolbarButton';
import {
  DEV_GOLDEN_ENDPOINT, describeViewConfig, saveSnapshotGolden, serveSessionLines,
} from '../src/core/hmi/DevToolbarPopover';
import { setViewProfileHost, type ViewProfile, type ViewProfileHost } from '../src/core/rv-view-profile';
import type { RVServeInfo } from '../src/core/rv-serve-info';

// The ActivityBar gates the button on the module constant, which is `null`
// under vitest — serve a worktree session to the bar (explicit `info` props in
// the other tests are unaffected).
vi.mock('../src/core/rv-serve-info', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/rv-serve-info')>(),
  RV_SERVE_INFO: {
    host: 'DEVBOX',
    root: 'E:/rv-worktrees/615-webviewer-dev-toolbar/realvirtual-WebViewer~',
    branch: 'feature/plan-615-webviewer-dev-toolbar',
    plans: [615],
    slug: 'webviewer-dev-toolbar',
    vitePort: 5615,
  },
}));

const layout = vi.hoisted(() => ({ mobile: false }));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => layout.mobile,
}));

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => ({}),
}));

vi.mock('../src/core/hmi/ButtonPanel', () => ({
  ButtonPanel: () => <div />,
  LogoBadge: () => <button type="button" title="About" aria-label="About">realvirtual</button>,
}));

const WORKTREE: RVServeInfo = {
  host: 'DEVBOX',
  root: 'E:/rv-worktrees/615-webviewer-dev-toolbar/realvirtual-WebViewer~',
  branch: 'feature/plan-615-webviewer-dev-toolbar',
  plans: [615],
  slug: 'webviewer-dev-toolbar',
  vitePort: 5615,
};

const CANONICAL: RVServeInfo = {
  host: 'DEVBOX',
  root: 'E:/realvirtual6/game4automation/realvirtual/Assets/realvirtual-WebViewer~',
  branch: 'main',
  plans: null,
  slug: null,
  vitePort: null,
};

const snapshot = { drives: { A: 1 } };
const editorSnapshot = { panelOpen: false, settingsOpen: false };
const viewer = {
  collectStateSnapshot: vi.fn(() => snapshot),
  // ActivityBar harness (same shape as tests/help-activity-bar.test.tsx).
  leftPanelManager: new LeftPanelManager(),
  uiRegistry: new UIPluginRegistry(),
  modes: modeManagerDouble(),
  applyVisualSettings: vi.fn(),
  clearModel: vi.fn(),
  renderBackend: 'three',
  hasRenderBackend: () => false,
  onRenderBackendChange: () => () => undefined,
  setRenderBackend: vi.fn(),
  getPlugin: (id: string) => (id === 'rv-extras-editor'
    ? { subscribe: () => () => undefined, getSnapshot: () => editorSnapshot, togglePanel: vi.fn(), setSettingsOpen: vi.fn() }
    : null),
  on: () => () => undefined,
};

function wrap(node: ReactNode) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer as never}>{node}</RVViewerProvider>
    </ThemeProvider>,
  );
}

function hostDouble(profile: ViewProfile): ViewProfileHost & { apply: ReturnType<typeof vi.fn> } {
  return {
    current: () => profile,
    deliveredConfig: () => ({ mode: { lock: 'hmi' }, lockSettings: true }),
    apply: vi.fn(async () => undefined),
  };
}

let originalTitle: string;

beforeEach(() => {
  originalTitle = document.title;
  document.title = 'realvirtual WEB';
  layout.mobile = false;
  setAppConfig({});
  setViewProfileHost(null);
});

afterEach(() => {
  cleanup();
  setAppConfig({});
  setViewProfileHost(null);
  vi.unstubAllGlobals();
  document.title = originalTitle;
});

describe('9.1 dev toolbar button + tooltip', () => {
  it('Test_DevToolbarButton_ServeInfoPresent_RendersButton', () => {
    wrap(<DevToolbarButton info={WORKTREE} />);
    expect(screen.getByTestId('dev-toolbar-button')).toBeTruthy();
  });

  it('Test_DevToolbarButton_NoServeInfo_RendersNothing', () => {
    wrap(<DevToolbarButton info={null} />);
    expect(screen.queryByTestId('dev-toolbar-button')).toBeNull();
  });

  it('Test_DevToolbarButton_Tooltip_NamesLabelPortMachinePathBranch', async () => {
    wrap(<DevToolbarButton info={WORKTREE} />);
    fireEvent.mouseOver(screen.getByTestId('dev-toolbar-button'));
    const tip = await screen.findByRole('tooltip');
    const text = tip.textContent ?? '';
    expect(text).toContain('Plan 615');
    expect(text).toContain(':5615');
    expect(text).toContain('DEVBOX');
    expect(text).toContain('E:\\rv-worktrees\\615-webviewer-dev-toolbar\\realvirtual-WebViewer~');
    expect(text).toContain('feature/plan-615-webviewer-dev-toolbar');
  });

  it('Test_ServeSessionLines_CanonicalWithoutSessionPort_FallsBackToPagePort', () => {
    const lines = serveSessionLines(CANONICAL, '5173');
    expect(lines[0]).toContain('CANONICAL');
    expect(lines).toContain('Port: :5173');
    expect(lines).toContain('Branch: main');
  });
});

describe('9.2 canonical checkout vs worktree', () => {
  it('Test_DevToolbarButton_Canonical_RedWithWarningDot', () => {
    wrap(<DevToolbarButton info={CANONICAL} />);
    const button = screen.getByTestId('dev-toolbar-button');
    expect(button.getAttribute('data-canonical')).toBe('true');
    expect(getComputedStyle(button).color).toBe('rgb(239, 83, 80)'); // shared-sx ERROR
    const dot = screen.getByTestId('dev-toolbar-badge').querySelector('.MuiBadge-badge');
    expect(dot).toBeTruthy();
    expect(dot!.classList.contains('MuiBadge-invisible')).toBe(false);
  });

  it('Test_DevToolbarButton_Worktree_DiscreetWithoutDot', () => {
    wrap(<DevToolbarButton info={WORKTREE} />);
    const button = screen.getByTestId('dev-toolbar-button');
    expect(button.getAttribute('data-canonical')).toBe('false');
    expect(getComputedStyle(button).color).not.toBe('rgb(239, 83, 80)');
    const dot = screen.getByTestId('dev-toolbar-badge').querySelector('.MuiBadge-badge');
    expect(dot?.classList.contains('MuiBadge-invisible')).toBe(true);
  });

  it('Test_TitlePrefix_Canonical_IsCanonicalMarker', () => {
    expect(serveSessionTitlePrefix(CANONICAL)).toBe(CANONICAL_TITLE_PREFIX);
    expect(CANONICAL_TITLE_PREFIX).toBe('[⚠ CANONICAL]');
    expect(serveSessionTitlePrefix(WORKTREE)).toBe('[Plan 615]');
    expect(serveSessionTitlePrefix(null)).toBe('');
  });

  it('Test_DevSessionHost_Canonical_PrefixesTabTitleAndRestoresOnUnmount', () => {
    const { unmount } = wrap(<DevSessionHost info={CANONICAL} />);
    expect(document.title).toBe('[⚠ CANONICAL] realvirtual WEB');
    unmount();
    expect(document.title).toBe('realvirtual WEB');
  });

  it('Test_DevSessionHost_Worktree_PrefixesSessionLabel', () => {
    wrap(<DevSessionHost info={WORKTREE} />);
    expect(document.title).toBe('[Plan 615] realvirtual WEB');
  });
});

/** All buttons of the rendered activity bar / mobile pill, in DOM order. */
function barButtons(): HTMLElement[] {
  const bar = screen.getByTestId('dev-toolbar-button').closest('[data-ui-panel]');
  expect(bar).toBeTruthy();
  return Array.from(bar!.querySelectorAll<HTMLElement>('button'));
}

describe('placement: last entry of the bar, in both views', () => {
  for (const profile of ['dev', 'delivered'] as const) {
    it(`Test_ActivityBar_${profile}View_DevButtonIsLastBelowSettingsAndHelp`, () => {
      setViewProfileHost(hostDouble(profile));
      wrap(<ActivityBar />);
      const buttons = barButtons();
      const dev = screen.getByTestId('dev-toolbar-button');
      expect(buttons[buttons.length - 1]).toBe(dev);
      // Settings and Help are rendered — and above it.
      const settings = screen.getByRole('button', { name: /settings/i });
      const help = screen.getByRole('button', { name: /help/i });
      expect(buttons.indexOf(settings)).toBeGreaterThanOrEqual(0);
      expect(buttons.indexOf(settings)).toBeLessThan(buttons.indexOf(dev));
      expect(buttons.indexOf(help)).toBeLessThan(buttons.indexOf(dev));
    });

    it(`Test_MobilePill_${profile}View_DevButtonIsLast`, () => {
      layout.mobile = true;
      setViewProfileHost(hostDouble(profile));
      wrap(<ActivityBar />);
      const buttons = barButtons();
      expect(buttons[buttons.length - 1]).toBe(screen.getByTestId('dev-toolbar-button'));
      expect(buttons.indexOf(screen.getByRole('button', { name: 'Menu' }))).toBe(buttons.length - 2);
    });
  }

  it('Test_ActivityBar_EmbedAllowlist_StillCarriesDevButtonLast', () => {
    wrap(<ActivityBar entryAllowlist={['help']} />);
    const buttons = barButtons();
    expect(buttons[buttons.length - 1]).toBe(screen.getByTestId('dev-toolbar-button'));
  });
});

describe('fallback handle: only while no bar button is mounted', () => {
  it('Test_DeliveredView_BarMounted_ButtonShownNoHandle', () => {
    setViewProfileHost(hostDouble('delivered'));
    wrap(<><ActivityBar /><DevSessionHost info={WORKTREE} /></>);
    expect(screen.getByTestId('dev-toolbar-button')).toBeTruthy();
    expect(screen.queryByTestId('dev-handle')).toBeNull();
  });

  it('Test_DevView_BarMounted_NoHandle', () => {
    setViewProfileHost(hostDouble('dev'));
    wrap(<><DevToolbarButton info={WORKTREE} /><DevSessionHost info={WORKTREE} /></>);
    expect(screen.queryByTestId('dev-handle')).toBeNull();
  });

  it('Test_NoBarMounted_HandleShown', () => {
    setViewProfileHost(hostDouble('delivered'));
    wrap(<DevSessionHost info={WORKTREE} />);
    expect(getMountedDevBarButtonCount()).toBe(0);
    expect(screen.getByTestId('dev-handle')).toBeTruthy();
  });

  it('Test_BarUnmounted_HandleReturns', () => {
    const { rerender } = wrap(<><DevToolbarButton info={WORKTREE} /><DevSessionHost info={WORKTREE} /></>);
    expect(screen.queryByTestId('dev-handle')).toBeNull();
    rerender(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer as never}><DevSessionHost info={WORKTREE} /></RVViewerProvider>
      </ThemeProvider>,
    );
    expect(screen.getByTestId('dev-handle')).toBeTruthy();
  });

  it('Test_NoServeInfo_ButtonDoesNotCount', () => {
    wrap(<DevToolbarButton info={null} />);
    expect(getMountedDevBarButtonCount()).toBe(0);
  });
});

describe('popover', () => {
  it('Test_Popover_ViewSwitch_CallsHostApply', async () => {
    const host = hostDouble('dev');
    setViewProfileHost(host);
    wrap(<DevToolbarButton info={WORKTREE} />);
    fireEvent.click(screen.getByTestId('dev-toolbar-button'));
    expect(await screen.findByTestId('dev-toolbar-popover')).toBeTruthy();
    expect(screen.getByText('mode hmi · settings locked')).toBeTruthy();
    // Full path and branch (wrapping, no ellipsis), title attribute kept.
    const path = screen.getByTitle(WORKTREE.root);
    expect(path.textContent).toBe('E:\\rv-worktrees\\615-webviewer-dev-toolbar\\realvirtual-WebViewer~');
    expect(getComputedStyle(path).textOverflow).not.toBe('ellipsis');
    expect(screen.getByTitle(WORKTREE.branch).textContent).toBe(WORKTREE.branch);
    await act(async () => { fireEvent.click(screen.getByTestId('dev-view-delivered')); });
    expect(host.apply).toHaveBeenCalledWith('delivered');
  });

  it('Test_Popover_HandleOpensSamePopover', async () => {
    const host = hostDouble('delivered');
    setViewProfileHost(host);
    wrap(<DevSessionHost info={WORKTREE} />);
    fireEvent.click(screen.getByTestId('dev-handle'));
    expect(await screen.findByTestId('dev-toolbar-popover')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('dev-view-dev')); });
    expect(host.apply).toHaveBeenCalledWith('dev');
  });

  it('Test_Popover_SaveSnapshot_PostsCollectedStateToEndpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, path: 'e2e/__goldens__/dev-snapshots/start.json' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    wrap(<DevToolbarButton info={WORKTREE} />);
    fireEvent.click(screen.getByTestId('dev-toolbar-button'));
    await screen.findByTestId('dev-toolbar-popover');
    fireEvent.change(screen.getByTestId('dev-snapshot-step'), { target: { value: 'start' } });
    await act(async () => { fireEvent.click(screen.getByTestId('dev-snapshot-save')); });
    await waitFor(() => expect(screen.getByText('e2e/__goldens__/dev-snapshots/start.json')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DEV_GOLDEN_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({ name: 'dev-snapshots/start', snapshot, overwrite: false });
  });

  it('Test_SaveSnapshotGolden_Conflict_ReturnsServerError', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'exists' }), { status: 409 }));
    const result = await saveSnapshotGolden('a/b', {}, false, fetchMock as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, error: 'exists' });
  });

  it('Test_DescribeViewConfig_SummarisesViewKeys', () => {
    expect(describeViewConfig({})).toBe('no view keys');
    expect(describeViewConfig({ lockedTabs: ['mouse', 'visual'], ui: { visibilityOverrides: { help: {} } } }))
      .toBe('2 tabs locked · 1 visibility overrides');
  });
});
