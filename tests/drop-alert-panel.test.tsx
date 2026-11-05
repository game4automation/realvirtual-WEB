// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-alert-panel.test.tsx — plan-2022 Phase 4: the card, the latch, OK,
 * Ignore, the reset edge and the optional delete.
 *
 * The panel is driven by the REAL manager over the real store — only the
 * highlight host, the probe host and the transport facts are fakes, because
 * those are the seams the production viewer fills too.
 */

import { setDropDetectionEnabled } from '../src/core/drop-detection-settings-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { Object3D, Vector3 } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVDropManager, type DropMU } from '../src/core/engine/rv-drop-manager';
import type { DropDetectionConfig } from '../src/core/engine/rv-drop-detection';
import { DropAlertPanel } from '../src/plugins/drop-alert-plugin';
import { __resetDropAlertStore } from '../src/core/hmi/drop-alert-store';
import { RVViewerProvider } from '../src/hooks/use-viewer';

const DT = 1 / 60;

const CONFIG: DropDetectionConfig = {
  Enabled: true,
  GraceTime: 0.1,
  SupportProbeDistance: 50,
  SupportMode: 'StateOnly',   // no rays needed for the panel behaviour
  SupportRecheckInterval: 0.5,
  DeleteUnsupported: false,
  DeleteDelay: 1,
};

function part(name: string, source: string): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(1.24, 0.86, 0.3);
  node.updateMatrixWorld(true);
  const mu = new RVMovingUnit(node, source, new Vector3(0.05, 0.05, 0.05));
  mu.wasCarried = true; // E7: only a part that was carried can lose its support
  mu.updateAABB();
  return mu;
}

function makeWorld(config: Partial<DropDetectionConfig> = {}) {
  const mgr = new RVDropManager();
  const shown: Object3D[][] = [];
  let hidden = 0;
  mgr.setTransportHost({ surfaceVerticalReach: 0.1, gripTargets: [] });
  mgr.setHighlightHost({
    showDrops: (roots) => { shown.push([...roots]); },
    hideDrops: () => { hidden++; },
  });
  mgr.register(new Object3D(), { ...CONFIG, ...config },
    { dropActive: null, dropCount: null, resetDrops: null });
  const run = (seconds: number, mus: DropMU[]) => {
    const ticks = Math.round(seconds / DT);
    for (let i = 0; i < ticks; i++) {
      mgr.beginTick();
      for (const mu of mus) mgr.evaluate(mu, DT);
      mgr.endTick(DT);
    }
  };
  const viewer = { dropManager: mgr } as unknown as RVViewer;
  return { mgr, viewer, run, shown, get hidden() { return hidden; } };
}

beforeEach(() => { __resetDropAlertStore(); });
afterEach(() => { setDropDetectionEnabled(true); cleanup(); __resetDropAlertStore(); });

describe('DropAlertPanel (plan-2022)', () => {
  it('shows nothing while there is no report', () => {
    const w = makeWorld();
    render(<RVViewerProvider value={w.viewer}><DropAlertPanel viewer={w.viewer} /></RVViewerProvider>);
    expect(screen.queryByTestId('drop-alert-panel')).toBeNull();
  });

  it('detects without a component and keeps the card latched when Options is turned off', async () => {
    const w = makeWorld();
    // Restore schema defaults by removing the optional component.
    w.mgr.clear();
    w.mgr.setProbeHost({ raycastSurfaceAlong: () => false });
    const mu = part('Default_Box', 'Source_Infeed');
    render(<RVViewerProvider value={w.viewer}><DropAlertPanel viewer={w.viewer} /></RVViewerProvider>);
    w.run(0.7, [mu]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card')).toHaveLength(1));
    setDropDetectionEnabled(false);
    w.run(2, [mu, part('Other_Box', 'Source_Infeed')]);
    expect(screen.getAllByTestId('drop-card')).toHaveLength(1);
    expect(screen.getByTestId('drop-card').textContent).toContain('Default_Box');
  });

  it('shows one card per report, with part name, source and position', async () => {
    const w = makeWorld();
    const mu = part('Box_7', 'Source_Infeed');
    render(<RVViewerProvider value={w.viewer}><DropAlertPanel viewer={w.viewer} /></RVViewerProvider>);
    w.run(0.2, [mu]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(1));
    const card = screen.getByTestId('drop-card');
    expect(card.textContent).toContain('Unsupported part: Box_7');
    expect(card.textContent).toContain('from Source_Infeed');
    expect(card.textContent).toContain('mm');
  });

  it('a pre-placed part says so and offers no Ignore button', async () => {
    const w = makeWorld();
    const mu = part('Jig_1', '');     // no source spawned it
    render(<RVViewerProvider value={w.viewer}><DropAlertPanel viewer={w.viewer} /></RVViewerProvider>);
    w.run(0.2, [mu]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(1));
    expect(screen.getByTestId('drop-card').textContent).toContain('pre-placed');
    expect(screen.queryByTestId('drop-ignore-source')).toBeNull();
  });

  it('the card STAYS after the part is supported again (it latches)', async () => {
    const w = makeWorld();
    const mu = part('Box_7', 'Source_Infeed');
    render(<RVViewerProvider value={w.viewer}><DropAlertPanel viewer={w.viewer} /></RVViewerProvider>);
    w.run(0.2, [mu]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(1));
    mu.heldBy = 'grip';              // somebody caught it
    w.run(2.0, [mu]);
    expect(screen.getAllByTestId('drop-card').length).toBe(1);
  });

  it('OK removes exactly this card and deletes its part (Thomas 2026-11-04)', async () => {
    const w = makeWorld();
    const a = part('Box_A', 'Source_A');
    const b = part('Box_B', 'Source_B');
    render(<RVViewerProvider value={w.viewer}><DropAlertPanel viewer={w.viewer} /></RVViewerProvider>);
    w.run(0.2, [a, b]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(2));

    await userEvent.click(screen.getAllByTestId('drop-ok')[0]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(1));
    const removed = [a, b].filter((m) => m.markedForRemoval);
    expect(removed.length).toBe(1);

    // The acknowledged part is on its way out of the scene: it is never reported again.
    w.run(0.2, [a, b]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(1));
  });

  it('Ignore <Source> mutes every part of that source for the rest of the run', async () => {
    const w = makeWorld();
    const a1 = part('Box_A1', 'Source_A');
    const a2 = part('Box_A2', 'Source_A');
    const b = part('Box_B', 'Source_B');
    render(<RVViewerProvider value={w.viewer}><DropAlertPanel viewer={w.viewer} /></RVViewerProvider>);
    w.run(0.2, [a1, a2, b]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(3));

    await userEvent.click(screen.getAllByTestId('drop-ignore-source')[0]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(1));
    expect(screen.getByTestId('drop-card').textContent).toContain('Box_B');

    // And it stays muted — a new part of that source raises no card either.
    const a3 = part('Box_A3', 'Source_A');
    w.run(0.5, [a1, a2, a3, b]);
    expect(screen.getAllByTestId('drop-card').length).toBe(1);
    expect(w.mgr.ignoredSources.has('Source_A')).toBe(true);
  });

  it('reset() clears every card and the outline', async () => {
    const w = makeWorld();
    const mu = part('Box_7', 'Source_Infeed');
    render(<RVViewerProvider value={w.viewer}><DropAlertPanel viewer={w.viewer} /></RVViewerProvider>);
    w.run(0.2, [mu]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(1));
    const hiddenBefore = w.hidden;
    w.mgr.reset();
    await waitFor(() => expect(screen.queryByTestId('drop-alert-panel')).toBeNull());
    expect(w.hidden).toBe(hiddenBefore + 1);
  });

  it('the outline claim carries the reported part\'s node', async () => {
    const w = makeWorld();
    const mu = part('Box_7', 'Source_Infeed');
    w.run(0.2, [mu]);
    expect(w.shown.at(-1)).toEqual([mu.node]);
  });

  it('DeleteUnsupported: the part goes after DeleteDelay, the CARD stays', async () => {
    const w = makeWorld({ DeleteUnsupported: true, DeleteDelay: 0.5 });
    const mu = part('Box_7', 'Source_Infeed');
    render(<RVViewerProvider value={w.viewer}><DropAlertPanel viewer={w.viewer} /></RVViewerProvider>);
    w.run(0.2, [mu]);
    await waitFor(() => expect(screen.getAllByTestId('drop-card').length).toBe(1));
    expect(mu.markedForRemoval).toBe(false);

    w.run(0.6, [mu]);
    // The manager MARKS it; step 7 of the transport tick does the disposal.
    expect(mu.markedForRemoval).toBe(true);
    await waitFor(() => expect(screen.getByTestId('drop-card').textContent).toContain('removed'));
    expect(screen.getAllByTestId('drop-card').length).toBe(1);
    expect(w.mgr.activeDrops[0].deleted).toBe(true);
    // The deleted part keeps its reported position — that IS the finding.
    expect(w.mgr.activeDrops[0].atMm[0]).toBeCloseTo(1240, 0);
  });

  it('DeleteUnsupported off (the default) never marks a part', async () => {
    const w = makeWorld();
    const mu = part('Box_7', 'Source_Infeed');
    w.run(3.0, [mu]);
    expect(mu.markedForRemoval).toBe(false);
  });
});
