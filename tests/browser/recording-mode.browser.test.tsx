// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2240 — the viewer's recording mode (`?recording=1`), in real Chromium.
 *
 * With the flag: no toolbar tooltip (hover, controlled trigger, dropdown trigger, menu row, native
 * `title`), the accessible name stays; the Problems panel neither opens by itself nor writes acks;
 * the auto-only startup dialogs (news, opener, demo-welcome, autoquality) and the automatic
 * welcome/projects openings stay shut; the manual openings still work; `recordingWelcome=1` lets
 * the welcome dialog open itself; domain tooltips (the tooltip store behind the 3D hover cards,
 * the real ECharts stats tooltip) stay. Without the flag everything behaves as before.
 *
 * The flag is switched through this page's URL (`history.replaceState`), which the module reads
 * on every call. The MUI theme
 * reads it once at boot, so the theme half is applied the way the app does it at boot: a theme
 * built with `recordingTooltipDefaults(true)`.
 *
 * The boot's own openings of the Projects dashboard (missing document, hosted start in
 * `main.ts`, the auto-open effect of `ProjectsDashboardHost.tsx`) need the whole viewer boot; they
 * are pinned here over the source text instead: every one of them goes through the recording gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });
// Without a registered KioskPlugin `useKioskHasTour()` hands useSyncExternalStore a fresh object on
// every read and React loops; the welcome dialog only needs "no tour" here.
vi.mock('../../src/plugins/kiosk-plugin', () => ({ useKioskHasTour: () => false, startKioskFromWelcome: () => {} }));
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { CssBaseline } from '@mui/material';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { rvDarkTheme, recordingTooltipDefaults } from '../../src/core/hmi/theme';
import {
  ActionDropdownSegment, ActionMenuRow, ActionSegment,
} from '../../src/core/hmi/action-group';
import { LogoBadge } from '../../src/core/hmi/ButtonPanel';
import { isRecordingMode, isWelcomeAutoOpenSuppressed } from '../../src/core/recording-mode';
import {
  acknowledgeProblems, getProblemsPanelOpenForTests, setProblemsPanelOpen, showProblems,
} from '../../src/core/hmi/ProblemsPanel';
import { clearAllProblems, reportProblem } from '../../src/core/hmi/problems-store';
import {
  _resetStartupModalCoordinatorForTests, mayShowStartupModal, useMayShowStartupModal,
  type StartupModalId,
} from '../../src/core/hmi/startup-modal-coordinator';
import { _resetWelcomeModalForTests, isWelcomeModalOpen } from '../../src/core/hmi/welcome-modal-store';
import { tooltipStore } from '../../src/core/hmi/tooltip/tooltip-store';
import { echarts } from '../../src/core/hmi/echarts-setup';
import { DESUtilizationBody } from '../../src/plugins/des/hmi/DESStatsChart';
import { makeRunner, makeViewer } from '../helpers/des-stats-chart-fixture';
import { DirtyDot } from '../../src/core/hmi/rv-dirty-dot';
import { SimClockSegment } from '../../src/plugins/sim-controller/SimControllerToolbar';
import { DESControllerToolbar } from '../../src/plugins/sim-controller/DESControllerToolbar';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { SimDesControl } from '../../src/core/material-flow/simulation-kernel';
import MAIN_SOURCE from '../../src/main.ts?raw';
import HOST_SOURCE from '../../src/core/hmi/projects/ProjectsDashboardHost.tsx?raw';

const ACKED_KEY = 'rv-problems-acked';
const WELCOME_DISMISSED_KEY = 'rv-welcome-dismissed';
const AUTO_ONLY: StartupModalId[] = ['news', 'opener', 'demo-welcome', 'autoquality'];

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function themeFor(recording: boolean) {
  return createTheme(rvDarkTheme, { components: { MuiTooltip: { defaultProps: recordingTooltipDefaults(recording) } } });
}

function mount(ui: ReactNode, recording: boolean) {
  setRecordingModeForTests(recording);
  return render(
    <ThemeProvider theme={themeFor(recording)}>
      <CssBaseline />
      <div style={{ padding: 80 }}>{ui}</div>
    </ThemeProvider>,
  );
}

function tooltipTexts(): string[] {
  return [...document.querySelectorAll('[role="tooltip"]')].map((el) => el.textContent ?? '');
}

const originalSearch = location.search;

/** Switches the recording mode the way the recorder does: through the page URL. */
function setRecordingModeForTests(on: boolean | undefined, extra = ''): void {
  history.replaceState(null, '', `${location.pathname}${on ? `?recording=1${extra}` : originalSearch}`);
}

beforeEach(() => {
  localStorage.removeItem(ACKED_KEY);
  localStorage.removeItem(WELCOME_DISMISSED_KEY);
  clearAllProblems();
  _resetStartupModalCoordinatorForTests();
  _resetWelcomeModalForTests();
});

afterEach(() => {
  cleanup();
  setProblemsPanelOpen(false);
  clearAllProblems();
  localStorage.removeItem(ACKED_KEY);
  localStorage.removeItem(WELCOME_DISMISSED_KEY);
  history.replaceState(null, '', `${location.pathname}${originalSearch}`);
  setRecordingModeForTests(undefined);
  tooltipStore.hideAll();
});

describe('recording mode flag', () => {
  it('defaults to off and follows the test seam', () => {
    expect(isRecordingMode('')).toBe(false);
    setRecordingModeForTests(true);
    expect(isRecordingMode()).toBe(true);
    setRecordingModeForTests(false);
    expect(isRecordingMode()).toBe(false);
  });
});

describe('toolbar tooltips', () => {
  it('hover tooltip of an action segment: shown without the flag', async () => {
    mount(<ActionSegment title="Fast Forward" label="FF" onClick={() => {}} buttonProps={{ 'data-testid': 'seg' }} />, false);
    await userEvent.hover(screen.getByTestId('seg'));
    await wait(400);
    expect(tooltipTexts().some((t) => t.includes('Fast Forward'))).toBe(true);
  });

  it('hover tooltip of an action segment: absent with the flag, the aria-label stays', async () => {
    mount(<ActionSegment title="Fast Forward" label="FF" onClick={() => {}} buttonProps={{ 'data-testid': 'seg' }} />, true);
    const seg = screen.getByTestId('seg');
    await userEvent.hover(seg);
    fireEvent.focus(seg);
    await wait(400);
    expect(tooltipTexts()).toEqual([]);
    expect(seg.getAttribute('aria-label')).toBe('Fast Forward');
  });

  function Dropdown() {
    return (
      <ActionDropdownSegment
        title="Render mode"
        icon={<span>R</span>}
        menuLabel="Render mode"
        items={[{ key: 'a', label: 'Shaded', description: 'Shaded view', onClick: () => {} }]}
        extraRows={<ActionMenuRow label="Record video" kind="action" testId="extra-row" onClick={() => {}} />}
        buttonProps={{ 'data-testid': 'dropdown-trigger' }}
      />
    );
  }

  it('dropdown trigger and menu row: tooltips shown without the flag', async () => {
    mount(<Dropdown />, false);
    const trigger = screen.getByTestId('dropdown-trigger');
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    fireEvent.mouseEnter(trigger);
    await wait(50);
    // Either the trigger tooltip (menu still closed) or the menu opened by hover.
    if (!document.querySelector('[data-testid="extra-row"]')) {
      expect(tooltipTexts().some((t) => t.includes('Render mode'))).toBe(true);
      fireEvent.click(trigger);
    }
    await wait(300);
    const row = document.querySelector('[data-testid="extra-row"]') as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row);
    await wait(300);
    expect(tooltipTexts().some((t) => t.includes('Record video'))).toBe(true);
  });

  it('dropdown trigger and menu row: no tooltip with the flag', async () => {
    mount(<Dropdown />, true);
    const trigger = screen.getByTestId('dropdown-trigger');
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    fireEvent.mouseEnter(trigger);
    await wait(50);
    expect(tooltipTexts()).toEqual([]);
    if (!document.querySelector('[data-testid="extra-row"]')) fireEvent.click(trigger);
    await wait(300);
    const row = document.querySelector('[data-testid="extra-row"]') as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.mouseEnter(row);
    await wait(300);
    expect(tooltipTexts()).toEqual([]);
    expect(row.getAttribute('aria-label')).toBe('Record video');
  });

  it('native title of the logo badge: present without the flag, absent with it, aria-label stays', () => {
    localStorage.setItem(WELCOME_DISMISSED_KEY, '1');
    mount(<LogoBadge />, false);
    expect(screen.getByTestId('rv-logo-badge').getAttribute('title')).toBe('About');
    cleanup();
    mount(<LogoBadge />, true);
    const badge = screen.getByTestId('rv-logo-badge');
    expect(badge.hasAttribute('title')).toBe(false);
    expect(badge.getAttribute('aria-label')).toBe('About');
  });
});

describe('native titles of the toolbars (Codex review)', () => {
  function desViewer(): RVViewer {
    const stats = { currentTime: 10, processed: 10, pending: 1, nextEventTime: 20 };
    const control = {
      subMode: 'animated' as const, multiplier: 1, simTime: 10, endTime: 86400, lifecycleGeneration: 1,
      runComplete: null as SimDesControl['runComplete'], eventStats: () => stats,
      setSubMode: () => {}, setMultiplier: () => {}, step: () => false,
    } satisfies SimDesControl;
    return {
      simulationKernel: { mode: 'des', isSwitching: false, hasDesRunner: () => true, desControl: () => control },
      isSimulationPaused: false, simulationPauseReasons: [], simTime: 10,
      registry: null, signalStore: null, on: () => () => {}, emit: () => {}, getPlugin: () => undefined,
    } as unknown as RVViewer;
  }

  function Toolbars() {
    const viewer = desViewer();
    return (
      <RVViewerProvider value={viewer}>
        <SimClockSegment viewer={viewer} />
        <DESControllerToolbar viewer={viewer} />
        <DirtyDot title="Unsaved changes" />
      </RVViewerProvider>
    );
  }

  const LABELS: Record<string, string> = {
    'sim-clock': 'Elapsed simulation time',
    'des-clock': 'Simulation end + statistics reset (toggle)',
    'dirty-dot': 'Unsaved changes',
  };

  it('sim clock, DES clock and dirty dot: native title without the flag', async () => {
    mount(<Toolbars />, false);
    for (const [id, label] of Object.entries(LABELS)) {
      const el = await screen.findByTestId(id);
      expect(el.getAttribute('title'), id).toBe(label);
    }
  });

  it('sim clock, DES clock and dirty dot: no native title with the flag, aria-label stays', async () => {
    mount(<Toolbars />, true);
    for (const [id, label] of Object.entries(LABELS)) {
      const el = await screen.findByTestId(id);
      expect(el.hasAttribute('title'), id).toBe(false);
      expect(el.getAttribute('aria-label'), id).toBe(label);
    }
  });
});

describe('Problems panel', () => {
  it('without the flag: a new problem opens the panel and closing writes acks', () => {
    setRecordingModeForTests(false);
    reportProblem({ id: 'rec-test-a', severity: 'warning', code: 'rec-test', title: 'A', detail: 'a' });
    expect(getProblemsPanelOpenForTests()).toBe(true);
    setProblemsPanelOpen(false);
    expect(localStorage.getItem(ACKED_KEY)).toContain('rec-test-a');
  });

  it('with the flag: a new problem does not open the panel and nothing is persisted', () => {
    setRecordingModeForTests(true);
    reportProblem({ id: 'rec-test-b', severity: 'warning', code: 'rec-test', title: 'B', detail: 'b' });
    expect(getProblemsPanelOpenForTests()).toBe(false);
    acknowledgeProblems();
    expect(localStorage.getItem(ACKED_KEY)).toBeNull();
  });

  it('with the flag: opening by hand still works', () => {
    setRecordingModeForTests(true);
    reportProblem({ id: 'rec-test-c', severity: 'error', code: 'rec-test', title: 'C', detail: 'c' });
    showProblems();
    expect(getProblemsPanelOpenForTests()).toBe(true);
    setProblemsPanelOpen(false);
    expect(getProblemsPanelOpenForTests()).toBe(false);
    expect(localStorage.getItem(ACKED_KEY)).toBeNull();
  });
});

describe('startup dialogs', () => {
  function Probe({ id }: { id: StartupModalId }) {
    const may = useMayShowStartupModal(id);
    return <span data-testid={`may-${id}`}>{may ? 'yes' : 'no'}</span>;
  }

  it('auto-only dialogs (news, opener, demo-welcome, autoquality) may show without the flag', () => {
    setRecordingModeForTests(false);
    for (const id of AUTO_ONLY) expect(mayShowStartupModal(id), id).toBe(true);
  });

  it('auto-only dialogs stay shut with the flag; welcome and projects are not gated here', () => {
    setRecordingModeForTests(true);
    for (const id of AUTO_ONLY) expect(mayShowStartupModal(id), id).toBe(false);
    expect(mayShowStartupModal('welcome')).toBe(true);
    expect(mayShowStartupModal('projects')).toBe(true);
    render(<>{AUTO_ONLY.map((id) => <Probe key={id} id={id} />)}</>);
    for (const id of AUTO_ONLY) expect(screen.getByTestId(`may-${id}`).textContent).toBe('no');
  });

  it('cold start without the flag: the welcome dialog opens itself', async () => {
    mount(<LogoBadge />, false);
    await wait(50);
    expect(isWelcomeModalOpen()).toBe(true);
  });

  it('cold start with the flag: no welcome dialog; a click on the logo opens it', async () => {
    mount(<LogoBadge />, true);
    await wait(50);
    expect(isWelcomeModalOpen()).toBe(false);
    fireEvent.click(screen.getByTestId('rv-logo-badge'));
    await wait(50);
    expect(isWelcomeModalOpen()).toBe(true);
  });

  it('recordingWelcome=1: the welcome dialog opens itself in recording mode', async () => {
    mount(<LogoBadge />, true);
    cleanup();
    setRecordingModeForTests(true, '&recordingWelcome=1');
    expect(isWelcomeAutoOpenSuppressed()).toBe(false);
    _resetWelcomeModalForTests();
    render(<ThemeProvider theme={themeFor(true)}><LogoBadge /></ThemeProvider>);
    await wait(50);
    expect(isWelcomeModalOpen()).toBe(true);
  });

  it('every automatic Projects opening of the boot goes through the recording gate', () => {
    // main.ts: the only direct call is inside the gated helper.
    const direct = MAIN_SOURCE.split('\n').filter((line) => /(^|[^A-Za-z])openProjectsDashboard\(\)/.test(line));
    expect(direct).toHaveLength(1);
    expect(MAIN_SOURCE).toMatch(/function autoOpenProjectsDashboard\(\): void \{\s*if \(!isRecordingMode\(\)\) openProjectsDashboard\(\);/);
    // missing document (alias + ?doc=) and hosted/deep-link start: four boot paths.
    expect(MAIN_SOURCE.match(/autoOpenProjectsDashboard\(\);/g)?.length).toBe(4);
    // The host's once-per-session auto-open asks the flag; its restore message stays outside the gate.
    expect(HOST_SOURCE).toMatch(/&& !isRecordingMode\(\)\) \{\s*openProjectsDashboard\(\);/);
    expect(HOST_SOURCE.indexOf('setMessage(failure.reason')).toBeLessThan(HOST_SOURCE.indexOf('!isRecordingMode()'));
  });
});

describe('domain tooltips stay in recording mode', () => {
  it('the 3D hover tooltip store still shows an entry', () => {
    setRecordingModeForTests(true);
    tooltipStore.show({ id: 'rec-hover', data: { type: 'drive' }, mode: 'fixed', fixedPos: { x: 10, y: 10 } });
    expect(tooltipStore.getSnapshot().visible.some((v) => v.primary.id === 'rec-hover')).toBe(true);
  });

  it('the real ECharts stats tooltip still opens', async () => {
    setRecordingModeForTests(true);
    const viewer = makeViewer(makeRunner(['A', 'B']));
    render(
      <ThemeProvider theme={themeFor(true)}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 600, height: 400 }}>
          <DESUtilizationBody viewer={viewer} active={true} />
        </div>
      </ThemeProvider>,
    );
    let chart: ReturnType<typeof echarts.getInstanceByDom> | null = null;
    for (let i = 0; i < 30 && !chart; i++) {
      await wait(100);
      for (const d of Array.from(document.querySelectorAll('div'))) {
        const inst = echarts.getInstanceByDom(d as HTMLElement);
        if (inst) { chart = inst; break; }
      }
    }
    expect(chart).toBeTruthy();
    await wait(700);
    const w = chart!.getWidth(), h = chart!.getHeight();
    act(() => { chart!.dispatchAction({ type: 'showTip', x: w / 3, y: h / 2 }); });
    await wait(100);
    const tip = (Array.from(document.querySelectorAll('div')) as HTMLElement[]).find((el) =>
      el.style.position === 'absolute' && /Output:/.test(el.textContent ?? '')
      && el.style.display !== 'none' && el.style.visibility !== 'hidden' && el.style.opacity !== '0');
    expect(tip).toBeTruthy();
  });
});
