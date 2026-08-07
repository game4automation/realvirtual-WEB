// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useSyncExternalStore, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { App } from '../src/core/hmi/App';
import appSource from '../src/core/hmi/App.tsx?raw';
import connectEmbedActionsSource from '../src/plugins/connect-embed/connect-embed-actions.ts?raw';
import { ActivityBar } from '../src/core/hmi/ActivityBar';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { setAppConfig } from '../src/core/rv-app-config';
import {
  ALL_RV_STORAGE_KEYS,
  CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY,
} from '../src/core/hmi/rv-storage-keys';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import {
  ConnectEmbedDemoControls,
  ConnectEmbedGate,
} from '../src/plugins/connect-embed/ConnectEmbedGate';
import { closeConnectEmbedDemo } from '../src/plugins/connect-embed/connect-embed-actions';
import {
  beginConnectEmbedDemoLoad,
  completeConnectEmbedDemoLoad,
  failConnectEmbedDemoLoad,
  getConnectEmbedSnapshot,
  initializeConnectEmbedStore,
  isConnectEmbedMinimalShell,
  resetConnectEmbedDemo,
  subscribeConnectEmbedStore,
} from '../src/plugins/connect-embed/connect-embed-store';

/**
 * Functional-enough SceneStore stand-in. The embed branch of `SceneWindow` only
 * reads the snapshot (it renders exactly one hard-coded row), but the hooks above
 * the branch still run, and `openBuiltin` is spied on to prove the row does NOT
 * take the persisted path.
 */
const sceneStoreMock = vi.hoisted(() => {
  const snapshot = {
    saved: null, draft: null, isDraft: true, dirty: false,
    scenes: [], builtins: [{ url: '/models/DemoRealvirtualWeb.glb', label: 'DemoRealvirtualWeb' }],
    published: [], activePublishedName: null, busy: false,
  };
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    openBuiltin: vi.fn(async () => undefined),
    openScene: vi.fn(async () => undefined),
    newEmpty: vi.fn(async () => undefined),
    ensureSceneHydrated: vi.fn(async () => true),
  };
});

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => sceneStoreMock,
}));

vi.mock('../src/core/hmi/ButtonPanel', () => ({
  ButtonPanel: () => <div data-testid="full-hmi-button-panel" />,
  LogoBadge: () => <button type="button" title="About" aria-label="About">realvirtual</button>,
}));

vi.mock('../src/core/hmi/HMIShell', () => ({
  HMIShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="hmi-shell">{children}</div>
  ),
  SlotRenderer: () => <div data-testid="full-hmi-slot" />,
  getFloatingPanelRoot: () => null,
}));

vi.mock('../src/core/hmi/ViewportFrame', () => ({
  ViewportFrame: () => <div data-testid="full-hmi-viewport" />,
}));

vi.mock('../src/core/hmi/TopBar', () => ({ TopBar: () => <div data-testid="full-hmi-top-bar" /> }));
vi.mock('../src/core/hmi/TitleBar', () => ({ TitleBar: () => <div /> }));
vi.mock('../src/core/hmi/KpiBar', () => ({ KpiBar: () => <div /> }));
vi.mock('../src/core/hmi/MessagePanel', () => ({ MessagePanel: () => <div /> }));
vi.mock('../src/core/hmi/BottomBar', () => ({ BottomBar: () => <div /> }));
vi.mock('../src/core/hmi/ConnectPanel', () => ({
  ConnectPanel: () => <div data-testid="connect-panel" />,
  // ActivityBar reaches ConnectPanel through AiBridgeGate for the reusable
  // download affordance; a mock without it fails the whole module import.
  ConnectDownloadLinks: () => <div data-testid="connect-download-links" />,
}));
vi.mock('../src/core/hmi/tooltip/TooltipLayer', () => ({ TooltipLayer: () => <div /> }));
vi.mock('../src/core/hmi/AnchoredPopover', () => ({ AnchoredPopover: () => <div /> }));
vi.mock('../src/core/hmi/MobileSelectionSheet', () => ({ MobileSelectionSheet: () => <div /> }));
vi.mock('../src/core/hmi/SignalDragGhost', () => ({ SignalDragGhost: () => <div /> }));
vi.mock('../src/core/hmi/ContextMenuLayer', () => ({ ContextMenuLayer: () => <div /> }));
vi.mock('../src/core/hmi/SetPositionDialog', () => ({
  SetPositionDialog: () => <div />,
  openSetPositionDialog: vi.fn(),
  closeSetPositionDialog: vi.fn(),
}));
vi.mock('../src/core/hmi/InstructionLayer', () => ({ InstructionLayer: () => <div /> }));
vi.mock('../src/core/hmi/AnnotationPanel', () => ({ AnnotationPanel: () => <div /> }));
vi.mock('../src/core/hmi/SharedViewBanner', () => ({ SharedViewBanner: () => <div /> }));
vi.mock('../src/core/hmi/GPUWarningBanner', () => ({ GPUWarningBanner: () => <div /> }));
vi.mock('../src/core/hmi/AutoQualityDialog', () => ({ AutoQualityDialog: () => <div /> }));
vi.mock('../src/core/hmi/OmniverseStatusOverlay', () => ({ OmniverseStatusOverlay: () => <div /> }));
vi.mock('../src/core/hmi/AiActivityOverlay', () => ({ AiActivityOverlay: () => <div /> }));
vi.mock('../src/core/hmi/AnnotationEditModal', () => ({ AnnotationEditModal: () => <div /> }));
vi.mock('../src/core/hmi/MeasurementPanel', () => ({ MeasurementPanel: () => <div /> }));
vi.mock('../src/core/hmi/ClippingPanel', () => ({ ClippingPanel: () => <div /> }));
vi.mock('../src/core/hmi/SensorHistoryPanel', () => ({ SensorHistoryPanel: () => <div /> }));
vi.mock('../src/plugins/order-manager-plugin', () => ({ OrderPanel: () => <div /> }));
vi.mock('../src/core/hmi/tooltip/tooltip-store', () => ({
  tooltipStore: { connectViewer: vi.fn() },
}));
vi.mock('../src/core/hmi/tooltip/tooltip-registry', () => ({
  tooltipRegistry: {
    register: vi.fn(),
    registerController: vi.fn(),
    registerDataResolver: vi.fn(),
    registerSearchResolver: vi.fn(),
    registerSearchDisplayResolver: vi.fn(),
    getControllers: () => [],
  },
}));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

const GATE_ACTIVITY_BAR_ALLOWLIST = ['about', 'models', 'plugin:connect', 'help'] as const;
const DEMO_URL = '/models/DemoRealvirtualWeb.glb';

function ConnectTestButton() {
  return <button type="button" aria-label="CONNECT">CONNECT</button>;
}

function PluginTestButton() {
  return <button type="button" aria-label="Plugin Extra">Plugin Extra</button>;
}

function createActivityBarViewer() {
  const leftPanelManager = new LeftPanelManager();
  const uiRegistry = new UIPluginRegistry();
  uiRegistry.register({
    id: 'connect',
    slots: [{ slot: 'activity-bar', component: ConnectTestButton }],
  });
  uiRegistry.register({
    id: 'plugin-extra',
    slots: [{ slot: 'activity-bar', component: PluginTestButton }],
  });
  const editorSnapshot = { panelOpen: false, settingsOpen: false };
  const editorPlugin = {
    subscribe: () => () => undefined,
    getSnapshot: () => editorSnapshot,
    togglePanel: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
  return {
    leftPanelManager,
    uiRegistry,
    applyVisualSettings: vi.fn(),
    clearModel: vi.fn(),
    currentModelUrl: null as string | null,
    loadModelWithProgress: vi.fn(async () => ({ ok: true as const })),
    renderBackend: 'three',
    hasRenderBackend: () => false,
    onRenderBackendChange: () => () => undefined,
    setRenderBackend: vi.fn(),
    getPlugin: (id: string) => id === 'rv-extras-editor' ? editorPlugin : null,
    on: () => () => undefined,
  };
}

function GateActivityBarHarness() {
  const snap = useSyncExternalStore(
    subscribeConnectEmbedStore,
    getConnectEmbedSnapshot,
    getConnectEmbedSnapshot,
  );
  return (
    <ActivityBar
      entryAllowlist={isConnectEmbedMinimalShell(snap) ? GATE_ACTIVITY_BAR_ALLOWLIST : undefined}
    />
  );
}

function renderGate(
  loader: (url: string) => Promise<{ ok: true } | { ok: false; error: string }> =
    vi.fn(async () => ({ ok: true as const })),
) {
  const leftPanelManager = new LeftPanelManager();
  leftPanelManager.open('connect', 360);
  const viewer = { leftPanelManager, loadModelWithProgress: loader };
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer as never}>
        <ConnectEmbedGate />
      </RVViewerProvider>
    </ThemeProvider>,
  );
}

function renderDemoControls() {
  const leftPanelManager = new LeftPanelManager();
  const viewer = { clearModel: vi.fn(), leftPanelManager, getPlugin: () => null };
  const result = render(
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewer as never}>
        <ConnectEmbedDemoControls />
      </RVViewerProvider>
    </ThemeProvider>,
  );
  return { ...result, viewer };
}

describe('CONNECT embedded minimal shell', () => {
  beforeEach(() => {
    localStorage.setItem('rv-welcome-dismissed', '1');
    localStorage.removeItem(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY);
    const config = { ui: { initialContexts: ['connect-embed'] }, sourceUrl: 'https://example.invalid/source' };
    setAppConfig(config);
    initializeConnectEmbedStore(config);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the CTA without normal HMI chrome in the structural App branch', () => {
    renderGate();
    expect(screen.getByText('Want to check your signals and experience a digital twin with realvirtual CONNECT?')).toBeVisible();
    const minimalStart = appSource.indexOf('function ConnectEmbedMinimalShell()');
    const minimalEnd = appSource.indexOf('interface FullHmiShellProps', minimalStart);
    const minimalBranch = appSource.slice(minimalStart, minimalEnd);
    expect(minimalBranch).toContain('<ConnectPanel />');
    expect(minimalBranch).toContain('<ConnectEmbedGate />');
    expect(minimalBranch).toContain('<ActivityBar entryAllowlist={CONNECT_EMBED_ACTIVITY_BAR_ALLOWLIST} />');
    for (const chrome of ['<TopBar', '<KpiBar', '<BottomBar', '<SharedViewBanner']) {
      expect(minimalBranch).not.toContain(chrome);
    }
  });

  it('shows only About, Models and CONNECT in every gate state, then restores the full activity bar', () => {
    const viewer = createActivityBarViewer();
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={viewer as never}>
          <GateActivityBarHarness />
        </RVViewerProvider>
      </ThemeProvider>,
    );

    const expectGatedEntries = () => {
      expect(screen.getByTitle('About').closest('[data-ui-panel]')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'CONNECT' })).toBeInTheDocument();
      // Models IS reachable in the gated shell since plan-373 — that panel is
      // where the demo is started and closed.
      expect(screen.getByTestId('FolderOpenIcon')).toBeInTheDocument();
      for (const hiddenIcon of ['AccountTreeIcon', 'PushPinIcon', 'SettingsIcon']) {
        expect(screen.queryByTestId(hiddenIcon)).not.toBeInTheDocument();
      }
      expect(screen.queryByRole('button', { name: 'Plugin Extra' })).not.toBeInTheDocument();
    };

    expectGatedEntries();
    act(() => { beginConnectEmbedDemoLoad(); });
    expectGatedEntries();
    act(() => { failConnectEmbedDemoLoad('load failed'); });
    expectGatedEntries();

    act(() => {
      beginConnectEmbedDemoLoad();
      completeConnectEmbedDemoLoad();
    });
    for (const visible of ['CONNECT', 'Plugin Extra']) {
      expect(screen.getByRole('button', { name: visible })).toBeInTheDocument();
    }
    for (const visibleIcon of ['FolderOpenIcon', 'AccountTreeIcon', 'PushPinIcon', 'SettingsIcon']) {
      expect(screen.getByTestId(visibleIcon)).toBeInTheDocument();
    }
  });

  it('keeps one App render tree hook-safe across gate, demo, and gate transitions', () => {
    const viewer = createActivityBarViewer();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <RVViewerProvider value={viewer as never}>
        <App />
      </RVViewerProvider>,
    );

    expect(screen.getByTestId('connect-embed-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('full-hmi-viewport')).not.toBeInTheDocument();

    act(() => {
      beginConnectEmbedDemoLoad();
      completeConnectEmbedDemoLoad();
    });
    expect(screen.getByTestId('full-hmi-viewport')).toBeInTheDocument();

    act(() => { resetConnectEmbedDemo(); });
    expect(screen.getByTestId('connect-embed-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('full-hmi-viewport')).not.toBeInTheDocument();
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(
      /change in the order of Hooks|Rendered (?:more|fewer) hooks/i,
    );
  });

  // plan-370 R8 — the embed allowlist is a POSITIVE list, so a forgotten entry
  // removes the button silently. Proving it through the real App (which uses the
  // non-exported CONNECT_EMBED_ACTIVITY_BAR_ALLOWLIST) is the only proof that
  // means anything; a test passing its own literal list would stay green forever.
  it('offers help inside the CONNECT embed shell', () => {
    render(
      <RVViewerProvider value={createActivityBarViewer() as never}>
        <App />
      </RVViewerProvider>,
    );

    expect(screen.getByTestId('connect-embed-gate')).toBeInTheDocument();
    const help = screen.getByRole('button', { name: /help/i });
    expect(help).toBeInTheDocument();

    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    fireEvent.click(help);
    expect(opened).toHaveBeenCalledWith(
      expect.stringContaining('https://realvirtual.io/doc/web/'), '_blank', 'noopener,noreferrer',
    );
  });

  it('shows loading and typed load-error states inside the gate', () => {
    const never = new Promise<never>(() => undefined);
    renderGate(vi.fn(() => never));
    fireEvent.click(screen.getByTestId('connect-embed-start'));
    expect(screen.getByTestId('connect-embed-loading')).toBeVisible();
    act(() => failConnectEmbedDemoLoad('404 Not Found'));
    expect(screen.getByTestId('connect-embed-error')).toHaveTextContent('404 Not Found');
  });

  it('can render a load failure without invoking the global overlay contract', () => {
    beginConnectEmbedDemoLoad();
    failConnectEmbedDemoLoad('parse failed');
    renderGate();
    expect(screen.getByRole('alert')).toHaveTextContent('parse failed');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('shows and persists the signal hint on the first successful demo start', () => {
    act(() => {
      beginConnectEmbedDemoLoad();
      completeConnectEmbedDemoLoad();
    });
    renderDemoControls();

    expect(screen.getByTestId('connect-embed-signal-hint')).toHaveTextContent(
      'Hold Shift and drag a signal from the CONNECT panel',
    );
    expect(localStorage.getItem(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY)).toBe('1');
    expect(ALL_RV_STORAGE_KEYS).toContain(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY);
  });

  it('persists dismissal and does not show the hint after restarting the demo', () => {
    act(() => {
      beginConnectEmbedDemoLoad();
      completeConnectEmbedDemoLoad();
    });
    const { viewer } = renderDemoControls();

    expect(screen.getByTestId('connect-embed-signal-hint')).toBeVisible();
    localStorage.removeItem(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss signal connection hint' }));
    expect(screen.queryByTestId('connect-embed-signal-hint')).not.toBeInTheDocument();
    expect(localStorage.getItem(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY)).toBe('1');

    // Closing now happens on the model row; the overlay owns only the hint.
    act(() => { closeConnectEmbedDemo(viewer as never); });
    expect(viewer.clearModel).toHaveBeenCalledOnce();
    act(() => {
      beginConnectEmbedDemoLoad();
      completeConnectEmbedDemoLoad();
    });
    expect(screen.queryByTestId('connect-embed-signal-hint')).not.toBeInTheDocument();
  });

  it('does not show the signal hint when the seen key already exists', () => {
    localStorage.setItem(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY, '1');
    act(() => {
      beginConnectEmbedDemoLoad();
      completeConnectEmbedDemoLoad();
    });
    renderDemoControls();

    expect(screen.queryByTestId('connect-embed-signal-hint')).not.toBeInTheDocument();
  });

  it('does not persist or render the signal hint while loading or after a load error', () => {
    act(() => { beginConnectEmbedDemoLoad(); });
    renderDemoControls();

    expect(screen.queryByTestId('connect-embed-signal-hint')).not.toBeInTheDocument();
    expect(localStorage.getItem(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY)).toBeNull();

    act(() => { failConnectEmbedDemoLoad('load failed'); });
    expect(screen.queryByTestId('connect-embed-signal-hint')).not.toBeInTheDocument();
    expect(localStorage.getItem(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY)).toBeNull();
  });

  it('falls back to showing the signal hint when localStorage throws', async () => {
    act(() => {
      beginConnectEmbedDemoLoad();
      completeConnectEmbedDemoLoad();
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled');
    });

    renderDemoControls();

    expect(await screen.findByTestId('connect-embed-signal-hint')).toBeVisible();
  });

  it('keeps the integrated demo model as the only gate loading path', async () => {
    const loader = vi.fn(async (_url: string) => ({ ok: true as const }));
    renderGate(loader);

    fireEvent.click(screen.getByTestId('connect-embed-start'));
    await waitFor(() => expect(loader).toHaveBeenCalledOnce());

    expect(loader.mock.calls[0]?.[0]).toMatch(/models\/DemoRealvirtualWeb\.glb$/);
    // ONE entry point, shared by the start button and the model row: the state
    // machine may only ever be entered from here.
    expect(connectEmbedActionsSource.match(/\bbeginConnectEmbedDemoLoad\s*\(/g)).toHaveLength(1);
    expect(connectEmbedActionsSource).toContain('CONNECT_EMBED_DEMO_MODEL');
    expect(connectEmbedActionsSource).toContain('completeConnectEmbedDemoLoad');
  });

  // ── plan-373: the demo controls overlay is reduced to the hint ──

  it('shows no demo chip and no top-right close button', () => {
    act(() => {
      beginConnectEmbedDemoLoad();
      completeConnectEmbedDemoLoad();
    });
    renderDemoControls();

    expect(screen.queryByText('DEMO · Standalone')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close scene' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('connect-embed-demo-controls')).not.toBeInTheDocument();
  });

  it('keeps the signal hint after the demo starts', () => {
    act(() => {
      beginConnectEmbedDemoLoad();
      completeConnectEmbedDemoLoad();
    });
    renderDemoControls();
    expect(screen.getByTestId('connect-embed-signal-hint')).toBeVisible();
  });

  it('exposes the models button in the gated-empty shell', () => {
    render(
      <RVViewerProvider value={createActivityBarViewer() as never}>
        <App />
      </RVViewerProvider>,
    );
    expect(screen.getByTestId('connect-embed-gate')).toBeInTheDocument();
    // Proven through the real App, which uses the non-exported allowlist — a test
    // asserting its own literal list would stay green after a regression.
    expect(screen.getByTestId('FolderOpenIcon')).toBeInTheDocument();
  });

  it('does not render the signal hint outside connect-embed sessions', () => {
    initializeConnectEmbedStore({ ui: { initialContexts: [] } });
    expect(beginConnectEmbedDemoLoad()).toBe(false);
    completeConnectEmbedDemoLoad();
    renderDemoControls();

    expect(screen.queryByTestId('connect-embed-signal-hint')).not.toBeInTheDocument();
    expect(screen.queryByTestId('connect-embed-demo-controls')).not.toBeInTheDocument();
  });
});
