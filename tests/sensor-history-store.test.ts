// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  sensorHistoryStore,
  __resetSensorHistoryStore,
  SENSOR_HISTORY_STORAGE_KEY,
  type SensorHistoryRef,
} from '../src/core/hmi/sensor-history-store';

const refA: SensorHistoryRef = { path: 'Cell/B-IGC01', label: 'B-IGC01', isInt: false };
const refB: SensorHistoryRef = { path: 'Cell/B-IGC02', label: 'B-IGC02', isInt: false };

describe('sensorHistoryStore', () => {
  beforeEach(() => {
    __resetSensorHistoryStore();
  });

  it('starts closed', () => {
    expect(sensorHistoryStore.getSnapshot().activeSensor).toBeNull();
  });

  it('open() sets active sensor', () => {
    sensorHistoryStore.open(refA);
    expect(sensorHistoryStore.getSnapshot().activeSensor).toEqual(refA);
  });

  it('open() is single-instance (replaces, not stacks)', () => {
    sensorHistoryStore.open(refA);
    sensorHistoryStore.open(refB);
    expect(sensorHistoryStore.getSnapshot().activeSensor).toEqual(refB);
  });

  it('close() clears active sensor', () => {
    sensorHistoryStore.open(refA);
    sensorHistoryStore.close();
    expect(sensorHistoryStore.getSnapshot().activeSensor).toBeNull();
  });

  it('setMode persists mode', () => {
    sensorHistoryStore.open(refA);
    sensorHistoryStore.setMode('all');
    expect(sensorHistoryStore.getSnapshot().mode).toBe('all');
  });

  it('setWindow persists window', () => {
    sensorHistoryStore.open(refA);
    sensorHistoryStore.setWindow('15m');
    expect(sensorHistoryStore.getSnapshot().window).toBe('15m');
  });

  it('subscribe fires on state changes', () => {
    let fires = 0;
    const unsub = sensorHistoryStore.subscribe(() => fires++);
    sensorHistoryStore.open(refA);
    sensorHistoryStore.setMode('all');
    sensorHistoryStore.close();
    unsub();
    expect(fires).toBeGreaterThanOrEqual(3);
  });

  it('snapshot is referentially stable when nothing changed', () => {
    sensorHistoryStore.open(refA);
    const a = sensorHistoryStore.getSnapshot();
    const b = sensorHistoryStore.getSnapshot();
    expect(a).toBe(b);
  });

  it('setLayout merges partial layout', () => {
    sensorHistoryStore.open(refA);
    sensorHistoryStore.setLayout({ x: 100, y: 200 });
    const s = sensorHistoryStore.getSnapshot();
    expect(s.layout.x).toBe(100);
    expect(s.layout.y).toBe(200);
    expect(s.layout.w).toBeGreaterThan(0);
    expect(s.layout.h).toBeGreaterThan(0);
  });

  it('setLayout produces a NEW snapshot reference after mutation', () => {
    sensorHistoryStore.open(refA);
    const before = sensorHistoryStore.getSnapshot();
    sensorHistoryStore.setLayout({ x: before.layout.x + 25 });
    const after = sensorHistoryStore.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.layout.x).toBe(before.layout.x + 25);
  });

  it('setLayout is a no-op when values are unchanged (snapshot stable)', () => {
    sensorHistoryStore.open(refA);
    const before = sensorHistoryStore.getSnapshot();
    sensorHistoryStore.setLayout({
      x: before.layout.x,
      y: before.layout.y,
      w: before.layout.w,
      h: before.layout.h,
    });
    const after = sensorHistoryStore.getSnapshot();
    expect(after).toBe(before);
  });

  it('setMode is a no-op when value is unchanged (snapshot stable)', () => {
    sensorHistoryStore.open(refA);
    const before = sensorHistoryStore.getSnapshot();
    sensorHistoryStore.setMode(before.mode);
    const after = sensorHistoryStore.getSnapshot();
    expect(after).toBe(before);
  });

  it('storage round-trips layout (sessionStorage)', () => {
    sensorHistoryStore.open(refA);
    sensorHistoryStore.setLayout({ x: 333, y: 222, w: 500, h: 300 });
    const raw = sessionStorage.getItem(SENSOR_HISTORY_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.x).toBe(333);
    expect(parsed.y).toBe(222);
    expect(parsed.w).toBe(500);
    expect(parsed.h).toBe(300);
  });

  it('open() with same sensor twice keeps snapshot stable', () => {
    sensorHistoryStore.open(refA);
    const before = sensorHistoryStore.getSnapshot();
    sensorHistoryStore.open(refA);
    const after = sensorHistoryStore.getSnapshot();
    expect(after).toBe(before);
  });
});
