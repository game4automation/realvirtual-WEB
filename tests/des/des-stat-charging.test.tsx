// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.8 — DES statistics: the vehicle state `Charging` (own color in the
// stack, `chargingPercent` in getStatistics) and the optional SOC tooltip row.
import { afterEach, describe, expect, it } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Object3D } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { DESComponent } from '@rv/plugins/des/rv-des-component';
import { DES_SOC_USERDATA_KEY, DES_STATE_STACK, desStateColor } from '@rv/plugins/des/hmi/des-stat-colors';
import { buildStackSeries, type DESStatsRow } from '@rv/plugins/des/hmi/DESStatsChart';
import { DESComponentTooltipContent, socOf } from '@rv/plugins/des/hmi/DESComponentTooltip';
import { hmiRunner, runnerOf } from './des-hmi-runner-fixture';

/** A DESComponent on a fake manager whose clock the test sets. */
function component(name: string): { comp: DESComponent; clock: { currentTime: number } } {
  const scene = new Object3D();
  const node = new Object3D();
  node.name = name;
  scene.add(node);
  const { comps: [comp], clock } = hmiRunner(scene, [node]);
  return { comp, clock };
}

describe('DES state stack with Charging', () => {
  it('Charging has its own color; the existing states keep order and colors', () => {
    expect(DES_STATE_STACK.map((s) => s.label)).toEqual(
      ['Working', 'Charging', 'Transport', 'Slowed', 'Setup', 'Blocked', 'Stopped', 'Empty', 'Failure']);
    expect(DES_STATE_STACK.filter((s) => s.label !== 'Charging').map((s) => [s.key, s.color])).toEqual([
      ['workingPercent', '#00c853'], ['transportPercent', '#00b8d4'], ['slowedPercent', '#ff9100'],
      ['setupPercent', '#2979ff'], ['blockedPercent', '#ffab00'], ['stoppedPercent', '#ff1744'],
      ['emptyPercent', '#90a4ae'], ['failurePercent', '#f44336'],
    ]);
    const charging = DES_STATE_STACK.find((s) => s.label === 'Charging')!;
    expect(charging.key).toBe('chargingPercent');
    const others = DES_STATE_STACK.filter((s) => s !== charging).map((s) => s.color);
    expect(others).not.toContain(charging.color);
    expect(desStateColor('Charging')).toBe(charging.color);
  });

  it('getStatistics books Charging time as chargingPercent', () => {
    const { comp, clock } = component('Stapler_1');
    comp.setState('Working');
    clock.currentTime = 30;
    comp.setState('Charging');
    clock.currentTime = 100;
    const s = comp.getStatistics();
    expect(s.workingPercent).toBeCloseTo(30, 9);
    expect(s.chargingPercent).toBeCloseTo(70, 9);
    expect(s.currentState).toBe('Charging');
  });

  it('the chart stacks a Charging series in the stack color', () => {
    const row: DESStatsRow = {
      path: 'Stapler_1', name: 'Stapler_1', kind: 'agv', workingPercent: 61, chargingPercent: 14, transportPercent: 20,
      slowedPercent: 0, stoppedPercent: 0, setupPercent: 0, blockedPercent: 0, emptyPercent: 5, failurePercent: 0,
      outputPerHour: 30, totalProcessed: 12, currentState: 'Working',
    };
    const series = buildStackSeries([row]);
    expect(series.map((s) => s.name)).toEqual(DES_STATE_STACK.map((s) => s.label));
    const charging = series.find((s) => s.name === 'Charging')!;
    expect(charging.data).toEqual([14]);
    expect(charging.itemStyle.color).toBe(desStateColor('Charging'));
    expect(charging.stack).toBe('util');
  });
});

describe('DES tooltip SOC row', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  const viewer = {} as RVViewer;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null; root = null;
    Object.assign(viewer, { simulationKernel: null });
  });

  function renderFor(comp: DESComponent): HTMLElement {
    const source = runnerOf(comp);
    Object.assign(viewer, { simulationKernel: { mode: 'des', activeExecutor: source } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
      <DESComponentTooltipContent data={{ type: 'des-component', componentPath: comp.path }} viewer={viewer} />,
    ));
    return host;
  }
  const rowLabels = (el: HTMLElement): string[] => Array.from(el.querySelectorAll('.MuiTypography-caption')).map((n) => n.textContent ?? '');

  it('socOf reads only a finite number', () => {
    expect(socOf({ userData: {} })).toBeNull();
    expect(socOf({ userData: { [DES_SOC_USERDATA_KEY]: '47' } })).toBeNull();
    expect(socOf({ userData: { [DES_SOC_USERDATA_KEY]: Number.NaN } })).toBeNull();
    expect(socOf({ userData: { [DES_SOC_USERDATA_KEY]: 47.4 } })).toBe(47.4);
  });

  it('no SOC value → no SOC row (and no Charging row without charging time)', () => {
    const { comp, clock } = component('Conveyor_A1');
    comp.setState('Working');
    clock.currentTime = 10;
    const el = renderFor(comp);
    const labels = rowLabels(el);
    expect(labels).toContain('Working');
    expect(labels).not.toContain('SOC');
    expect(labels).not.toContain('Charging');
  });

  it('a SOC value on the node → SOC row; charging time → Charging row', () => {
    const { comp, clock } = component('Stapler_2');
    comp.node.userData[DES_SOC_USERDATA_KEY] = 47.4;
    comp.setState('Charging');
    clock.currentTime = 20;
    const el = renderFor(comp);
    const labels = rowLabels(el);
    expect(labels).toContain('SOC');
    expect(labels[labels.indexOf('SOC') + 1]).toBe('47%');
    expect(labels).toContain('Charging');
  });
});
