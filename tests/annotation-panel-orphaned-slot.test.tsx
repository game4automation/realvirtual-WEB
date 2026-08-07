// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression tests for the "empty grey strip on the left" bug — the third case.
 *
 * `orphanedLeftSlot` (tests/topbar-orphaned-panel.test.ts) covers the two cases
 * TopBar reconciles: a slot whose renderer flag says closed, and a slot whose
 * workspace gate is shut. Neither sees the third: the panel is mounted and its
 * gate is open, but the PLUGIN that backs it was never loaded for this model, so
 * the panel renders `null` while its lpm slot goes on reserving 280px of canvas
 * inset. `AnnotationPlugin` is registered per model (only by the
 * DemoRealvirtualWeb bundle today), the slot persists in localStorage — so any
 * other model inherits exactly that strip.
 *
 * The fix is the shared `useDropOrphanedPanelSlot`, already used by
 * MachineControlPanel and the order-manager panel.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { AnnotationPanel } from '../src/core/hmi/AnnotationPanel';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { ANNOTATION_PANEL_WIDTH } from '../src/core/hmi/layout-constants';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import activityBarSource from '../src/core/hmi/ActivityBar.tsx?raw';
import annotationPanelSource from '../src/core/hmi/AnnotationPanel.tsx?raw';

/** Minimal viewer: the panel reads `leftPanelManager` and `getPlugin` only. */
function mockViewer(lpm: LeftPanelManager, plugins: Record<string, object>): RVViewer {
  return {
    leftPanelManager: lpm,
    getPlugin: (id: string) => plugins[id],
  } as unknown as RVViewer;
}

function renderPanel(lpm: LeftPanelManager, plugins: Record<string, object>) {
  return render(
    <RVViewerProvider value={mockViewer(lpm, plugins)}>
      <AnnotationPanel />
    </RVViewerProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.removeItem('rv-left-panel-active');
});

describe('AnnotationPanel — orphaned lpm slot when the plugin is absent', () => {
  it('closes the annotations slot when no annotation plugin is loaded', async () => {
    const lpm = new LeftPanelManager();
    lpm.open('annotations', ANNOTATION_PANEL_WIDTH);

    const { container } = renderPanel(lpm, {});

    // Nothing rendered — and, the point of the fix, nothing reserved either.
    await waitFor(() => expect(lpm.getSnapshot().activePanel).toBeNull());
    expect(lpm.getSnapshot().activePanelWidth).toBe(0);
    expect(container.textContent).toBe('');
  });

  it('leaves the slot open while the plugin IS loaded', async () => {
    const lpm = new LeftPanelManager();
    lpm.open('annotations', ANNOTATION_PANEL_WIDTH);

    renderPanel(lpm, { annotations: {} });

    await waitFor(() => expect(lpm.getSnapshot().activePanel).toBe('annotations'));
    expect(lpm.getSnapshot().activePanelWidth).toBe(ANNOTATION_PANEL_WIDTH);
  });

  it('never touches a slot it does not own', async () => {
    // Missing plugin + some OTHER left window open: closing indiscriminately
    // would make the panel steal a foreign slot.
    const lpm = new LeftPanelManager();
    lpm.open('settings', 540);

    renderPanel(lpm, {});

    await waitFor(() => expect(lpm.getSnapshot().activePanel).toBe('settings'));
    expect(lpm.getSnapshot().activePanelWidth).toBe(540);
  });
});

describe('AnnotationPanel — reserved width matches rendered width', () => {
  it('the slot registration and the panel share ONE constant', () => {
    // Pinned as source text because the duplication is what breaks: the slot
    // width the ActivityBar registers and the width the panel renders with are
    // set in two files, and a literal in either one drifts silently.
    expect(activityBarSource).toContain("lpm.toggle('annotations', ANNOTATION_PANEL_WIDTH)");
    expect(activityBarSource).not.toMatch(/lpm\.(open|toggle)\('annotations',\s*\d/);
    expect(annotationPanelSource).toContain('width: ANNOTATION_PANEL_WIDTH,');
    expect(annotationPanelSource).not.toMatch(/const PANEL_WIDTH\s*=/);
  });
});
