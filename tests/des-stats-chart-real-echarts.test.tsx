// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2030 F4 — REAL echarts (no mock): an open axis tooltip must survive the 500 ms refresh
 * ticks of the stats chart (a notMerge setOption on a tick used to wipe it).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { makeRunner, makeViewer } from './helpers/des-stats-chart-fixture';
import { echarts } from '../src/core/hmi/echarts-setup';
import { DESUtilizationBody } from '../src/plugins/des/hmi/DESStatsChart';

afterEach(() => cleanup());

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function findChart(): any {
  for (const d of Array.from(document.querySelectorAll('div'))) {
    const inst = echarts.getInstanceByDom(d as HTMLElement);
    if (inst) return inst;
  }
  return null;
}

function visibleTooltip(): HTMLElement | null {
  // The echarts tooltip is an absolutely positioned div holding the formatter HTML.
  return (Array.from(document.querySelectorAll('div')) as HTMLElement[]).find((el) =>
    el.style.position === 'absolute' && /Output:/.test(el.textContent ?? '')
    && el.style.display !== 'none' && el.style.visibility !== 'hidden' && el.style.opacity !== '0') ?? null;
}

describe('DESUtilizationBody with real echarts', () => {
  it('an open axis tooltip is still visible after two refresh ticks', async () => {
    const viewer = makeViewer(makeRunner(['A', 'B']));
    render(<div style={{ display: 'flex', flexDirection: 'column', width: 600, height: 400 }}>
      <DESUtilizationBody viewer={viewer} active={true} />
    </div>);
    let chart: any = null;
    for (let i = 0; i < 30 && !chart; i++) { await wait(100); chart = findChart(); }
    expect(chart).toBeTruthy();
    await wait(700); // first tick has built the static options

    const w = chart.getWidth(), h = chart.getHeight();
    expect(w).toBeGreaterThan(50);
    act(() => { chart.dispatchAction({ type: 'showTip', x: w / 3, y: h / 2 }); });
    await wait(100);
    expect(visibleTooltip()).not.toBeNull();

    await wait(1250); // at least two REFRESH_MS ticks
    expect(visibleTooltip()).not.toBeNull();
  });
});
