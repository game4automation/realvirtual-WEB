// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-644 § 9.8 — the DES-HMI extension point (D8) and the tooltip colors (D3):
// `getStatePercent` / `desStatePercent` equal `getStatistics()`, registered
// states reach chart, tooltip and badge in one color, KPI row providers reach
// badge and tooltip, duplicates are first-wins, the imperative badge path
// resizes / rebuilds / stops listening after dispose, and the tooltip state
// colors are the stack colors. Every looked-up value is asserted to exist first.
import { afterEach, describe, expect, it, vi } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, type Sprite } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { DESComponent } from '@rv/plugins/des/rv-des-component';
import {
  DES_SOC_USERDATA_KEY,
  DES_STATE_STACK,
  desStateColor,
  desStateNames,
  desStatePercent,
  registerDesState,
} from '@rv/plugins/des/hmi/des-stat-colors';
import { buildStackSeries, type DESStatsRow } from '@rv/plugins/des/hmi/DESStatsChart';
import { DESComponentTooltipContent } from '@rv/plugins/des/hmi/DESComponentTooltip';
import { hmiRunner, runnerOf } from './des-hmi-runner-fixture';
import {
  disposeDesStatsGizmos,
  drawStateStackBar,
  getDesStatsGizmos,
  registerDesKpiRowProvider,
  type DesKpiRowProvider,
} from '@rv/plugins/des/hmi/des-stats-gizmos';

const BADGE_H = 0.4;      // default badge world height (80 px canvas)
const ROW = 22 / 80;      // one KPI row as a fraction of the default canvas height

function component(name: string): { comp: DESComponent; clock: { currentTime: number } } {
  const scene = new Object3D();
  const node = new Object3D();
  node.name = name;
  scene.add(node);
  const { comps: [comp], clock } = hmiRunner(scene, [node]);
  return { comp, clock };
}

/** A viewer with one badge-able component (a node with a box). */
function badgeFixture() {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Station';
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  node.add(m);
  scene.add(node);
  scene.updateMatrixWorld(true);
  const { comps: [comp], clock } = hmiRunner(scene, [node]);
  const viewer = {
    scene,
    registry: { getNode: (p: string) => scene.getObjectByName(p) ?? null },
    on: () => () => {},
  } as unknown as RVViewer;
  const source = runnerOf(comp);
  Object.assign(viewer, { simulationKernel: { mode: 'des', activeExecutor: source } });
  return { viewer, comp, clock, node };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});
const reg = <T extends () => void>(off: T): T => { cleanups.push(off); return off; };

// ── values ──────────────────────────────────────────────────────────────────

describe('getStatePercent / desStatePercent === getStatistics()', () => {
  it('every built-in state, including the running state and after resetStatistics()', () => {
    const { comp, clock } = component('Stapler');
    const seq: [string, number][] = [['Working', 10], ['Charging', 25], ['Transport', 31], ['Slowed', 40],
      ['Stopped', 47], ['Setup', 55], ['Blocked', 70], ['Failure', 72], ['Empty', 90], ['Working', 101.5]];
    const check = (label: string): void => {
      const s = comp.getStatistics();
      for (const st of DES_STATE_STACK) {
        const expected = (s as unknown as Record<string, number>)[st.key] ?? 0;
        expect(comp.getStatePercent(st.label), `${label} ${st.label}`).toBeCloseTo(expected, 12);
        expect(desStatePercent(comp, st.label), `${label} ${st.label} (desStatePercent)`).toBeCloseTo(expected, 12);
      }
    };
    for (const [state, t] of seq) { comp.setState(state); clock.currentTime = t; check(`@${t}`); }
    comp.resetStatistics();
    clock.currentTime = 120;
    check('after reset');
    comp.setState('Charging');
    clock.currentTime = 130;
    check('after reset + new state');
  });

  it('an unknown or never booked state is 0, never undefined', () => {
    const { comp, clock } = component('X');
    comp.setState('Working');
    clock.currentTime = 5;
    expect(desStatePercent(comp, 'Nope')).toBe(0);
    expect(comp.getStatePercent('Setup')).toBe(0);
    // A structural source without getStatePercent reads getStatistics().states.
    expect(desStatePercent({ getStatistics: () => ({ states: { Foo: { percent: 12 } } }) }, 'Foo')).toBe(12);
    expect(desStatePercent({ getStatistics: () => ({}) }, 'Foo')).toBe(0);
  });
});

// ── state registry ─────────────────────────────────────────────────────────

describe('registerDesState', () => {
  it('appends after the stack; a duplicate name is first-wins with a warning; unregister removes it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = desStateNames();
    const off = reg(registerDesState({ name: 'Refill', color: '#123456', label: 'Refilling' }));
    expect(desStateNames()).toEqual([...DES_STATE_STACK.map((s) => s.label), 'Refill']);
    expect(desStateColor('Refill')).toBe('#123456');
    const dup = registerDesState({ name: 'Refill', color: '#ffffff' });
    const dupStack = registerDesState({ name: 'Working', color: '#ffffff' });
    expect(desStateColor('Refill')).toBe('#123456');
    expect(desStateColor('Working')).toBe(DES_STATE_STACK[0].color);
    expect(warn).toHaveBeenCalled();
    dup(); dupStack(); // no-ops
    expect(desStateNames()).toContain('Refill');
    off();
    expect(desStateNames()).toEqual(before);
    expect(desStateColor('Refill')).toBeUndefined();
  });
});

// ── badges (imperative path) ─────────────────────────────────────────────────

describe('badges: KPI rows, rebuild, dispose, custom renderer', () => {
  let fx: ReturnType<typeof badgeFixture> | null = null;
  afterEach(() => {
    if (fx) { disposeDesStatsGizmos(fx.viewer); Object.assign(fx.viewer, { simulationKernel: null }); }
    fx = null;
  });

  const twoProviders = (): [DesKpiRowProvider, DesKpiRowProvider] => [
    { id: 'test.a', rows: () => [{ label: 'A', value: '1' }, { label: 'B', value: '2' }] },
    { id: 'test.c', rows: () => [{ label: 'C', value: '3', color: '#abcdef' }] },
  ];

  it('two providers with three rows make the badge three rows taller; unregister shrinks it back; the old badge is disposed', () => {
    fx = badgeFixture();
    const g = getDesStatsGizmos(fx.viewer);
    g.setEnabled(true);
    const s0 = g.spriteOf('Station');
    expect(s0).not.toBeNull();
    expect(s0!.scale.y).toBeCloseTo(BADGE_H, 9);
    const matDispose = vi.spyOn(s0!.material, 'dispose');
    const texDispose = vi.spyOn((s0!.material as unknown as { map: { dispose(): void } }).map, 'dispose');

    const [p1, p2] = twoProviders();
    const off1 = reg(registerDesKpiRowProvider(p1));
    const off2 = reg(registerDesKpiRowProvider(p2));
    const s1 = g.spriteOf('Station');
    expect(s1).not.toBeNull();
    expect(s1).not.toBe(s0);
    expect(s1!.scale.y).toBeCloseTo(BADGE_H * (1 + 3 * ROW), 9);
    expect(matDispose).toHaveBeenCalled();
    expect(texDispose).toHaveBeenCalled();
    expect(fx.viewer.scene.children).not.toContain(s0 as Sprite);

    off1(); off2();
    const s2 = g.spriteOf('Station');
    expect(s2).not.toBeNull();
    expect(s2!.scale.y).toBeCloseTo(BADGE_H, 9);
  });

  it('the SOC row is the first provider: a SOC on the node adds one row, as before', () => {
    fx = badgeFixture();
    fx.node.userData[DES_SOC_USERDATA_KEY] = 55;
    const g = getDesStatsGizmos(fx.viewer);
    g.setEnabled(true);
    const s = g.spriteOf('Station');
    expect(s).not.toBeNull();
    expect(s!.scale.y).toBeCloseTo(BADGE_H * (1 + ROW), 9);
  });

  it('with a custom badge renderer the KPI rows stay out', () => {
    fx = badgeFixture();
    const g = getDesStatsGizmos(fx.viewer);
    g.setBadgeRenderer({ canvasWidth: 200, canvasHeight: 80, worldHeightM: 0.5, offsetM: 0.2, draw: () => {} });
    g.setEnabled(true);
    const [p1, p2] = twoProviders();
    reg(registerDesKpiRowProvider(p1));
    reg(registerDesKpiRowProvider(p2));
    const s = g.spriteOf('Station');
    expect(s).not.toBeNull();
    expect(s!.scale.y).toBeCloseTo(0.5, 9);
  });

  it('after dispose() a registration triggers no refresh', () => {
    fx = badgeFixture();
    const g = getDesStatsGizmos(fx.viewer);
    g.setEnabled(true);
    const refresh = vi.spyOn(g as unknown as { refresh(): void }, 'refresh');
    reg(registerDesKpiRowProvider({ id: 'test.live', rows: () => [] }));
    expect(refresh).toHaveBeenCalledTimes(1);
    disposeDesStatsGizmos(fx.viewer);
    reg(registerDesKpiRowProvider({ id: 'test.after', rows: () => [] }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a duplicate provider id is first-wins with a warning; unregister removes its rows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fx = badgeFixture();
    const g = getDesStatsGizmos(fx.viewer);
    g.setEnabled(true);
    const off = reg(registerDesKpiRowProvider({ id: 'test.dup', rows: () => [{ label: 'K', value: '1' }] }));
    const dup = registerDesKpiRowProvider({ id: 'test.dup', rows: () => [{ label: 'K', value: '1' }, { label: 'L', value: '2' }] });
    expect(warn).toHaveBeenCalled();
    expect(g.spriteOf('Station')!.scale.y).toBeCloseTo(BADGE_H * (1 + ROW), 9);
    dup();
    expect(g.spriteOf('Station')!.scale.y).toBeCloseTo(BADGE_H * (1 + ROW), 9);
    off();
    expect(g.spriteOf('Station')!.scale.y).toBeCloseTo(BADGE_H, 9);
  });
});

// ── tooltip + chart + badge bar: one color per registered state ─────────────

describe('a state registered after the mount shows in chart, tooltip and badge in one color', () => {
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
  const captions = (el: HTMLElement): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>('.MuiTypography-caption'));
  const labels = (el: HTMLElement): string[] => captions(el).map((n) => n.textContent ?? '');
  const valueEl = (el: HTMLElement, label: string): HTMLElement => {
    const all = captions(el);
    const i = all.findIndex((n) => n.textContent === label);
    expect(i, `row '${label}'`).toBeGreaterThanOrEqual(0);
    return all[i + 1];
  };
  const rgb = (hex: string): string => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  };

  it('tooltip row, chart series and badge bar segment share the registered color', () => {
    const { comp, clock } = component('Agv_1');
    comp.setState('Working');
    clock.currentTime = 10;
    comp.setState('Refill');      // booked BEFORE the state is registered — fine, it is a string
    clock.currentTime = 20;
    const el = renderFor(comp);
    expect(labels(el)).not.toContain('Refilling');

    act(() => { reg(registerDesState({ name: 'Refill', color: '#3355aa', label: 'Refilling' })); });
    expect(labels(el)).toContain('Refilling');
    expect(valueEl(el, 'Refilling').textContent).toBe('50.0%');
    expect(getComputedStyle(valueEl(el, 'Refilling')).color).toBe(rgb('#3355aa'));

    const row: DESStatsRow = {
      path: 'Agv_1', name: 'Agv_1', kind: 'agv', workingPercent: 50, chargingPercent: 0, transportPercent: 0,
      slowedPercent: 0, stoppedPercent: 0, setupPercent: 0, blockedPercent: 0, emptyPercent: 0, failurePercent: 0,
      outputPerHour: 0, totalProcessed: 0, currentState: 'Refill', states: { Refill: desStatePercent(comp, 'Refill') },
    };
    const series = buildStackSeries([row]);
    const s = series.find((x) => x.name === 'Refilling');
    expect(s, 'chart series').toBeDefined();
    expect(s!.itemStyle.color).toBe('#3355aa');
    expect(s!.data).toEqual([50]);
    expect(series.map((x) => x.name).slice(0, DES_STATE_STACK.length)).toEqual(DES_STATE_STACK.map((x) => x.label));

    const fills: string[] = [];
    const fake = { fillStyle: '', strokeStyle: '', lineWidth: 1, fillRect: () => {}, strokeRect: () => {} };
    fake.fillRect = () => { fills.push(String(fake.fillStyle)); };
    const ctx = fake as unknown as CanvasRenderingContext2D;
    drawStateStackBar(ctx, comp.getStatistics(), 0, 0, 100, 10, comp);
    expect(fills).toContain('#3355aa');
  });

  it('a KPI provider row appears in the tooltip with its color; unregistering removes it', () => {
    const { comp, clock } = component('Station_1');
    comp.setState('Working');
    clock.currentTime = 4;
    const el = renderFor(comp);
    let off: () => void = () => {};
    act(() => { off = reg(registerDesKpiRowProvider({ id: 'test.temp', rows: () => [{ label: 'Temp', value: '71 °C', color: '#ff8800' }] })); });
    expect(labels(el)).toContain('Temp');
    expect(valueEl(el, 'Temp').textContent).toBe('71 °C');
    expect(getComputedStyle(valueEl(el, 'Temp')).color).toBe(rgb('#ff8800'));
    act(() => off());
    expect(labels(el)).not.toContain('Temp');
  });

  it('the tooltip state colors are the DES_STATE_STACK colors (plan-644 D3)', () => {
    for (const st of DES_STATE_STACK) {
      const { comp, clock } = component(`C_${st.label}`);
      comp.setState(st.label);
      clock.currentTime = 1;
      const el = renderFor(comp);
      expect(getComputedStyle(valueEl(el, 'State')).color, st.label).toBe(rgb(st.color));
      act(() => root?.unmount());
      host?.remove();
      host = null; root = null;
    }
  });
});
