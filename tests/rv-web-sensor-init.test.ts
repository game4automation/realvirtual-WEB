// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WebSensorConfig,
  initWebSensor,
  resetWebSensorConfig,
} from '../src/core/engine/rv-web-sensor';

describe('initWebSensor', () => {
  beforeEach(() => resetWebSensorConfig());

  it('partial-merges single state-style field', () => {
    initWebSensor({ stateStyles: { high: { color: 0x00a030 } } });
    expect(WebSensorConfig.stateStyles.high.color).toBe(0x00a030);
    expect(WebSensorConfig.stateStyles.high.opacity).toBe(0.95);
    expect(WebSensorConfig.stateStyles.high.blinkHz).toBe(0);
    expect(WebSensorConfig.stateStyles.error.color).toBe(0xff2020);
  });

  it('overrides default int state map (Map input)', () => {
    initWebSensor({ defaultIntStateMap: new Map<number, 'low' | 'high' | 'warning' | 'error'>([
      [10, 'high'],
      [20, 'error'],
    ]) });
    expect(WebSensorConfig.defaultIntStateMap.get(10)).toBe('high');
    expect(WebSensorConfig.defaultIntStateMap.get(20)).toBe('error');
    expect(WebSensorConfig.defaultIntStateMap.get(0)).toBeUndefined();
  });

  it('overrides default int state map (record input)', () => {
    initWebSensor({ defaultIntStateMap: { 5: 'warning', 99: 'error' } });
    expect(WebSensorConfig.defaultIntStateMap.get(5)).toBe('warning');
    expect(WebSensorConfig.defaultIntStateMap.get(99)).toBe('error');
  });

  it('overrides default shape and size', () => {
    initWebSensor({ defaultShape: 'mesh-overlay', defaultSize: 2.5 });
    expect(WebSensorConfig.defaultShape).toBe('mesh-overlay');
    expect(WebSensorConfig.defaultSize).toBe(2.5);
  });

  it('handles defaultSize: 0', () => {
    initWebSensor({ defaultSize: 0 });
    expect(WebSensorConfig.defaultSize).toBe(0);
  });

  it('is additive across multiple calls', () => {
    initWebSensor({ stateStyles: { high: { color: 0x00a030 } } });
    initWebSensor({ stateStyles: { warning: { blinkHz: 0.5 } } });
    expect(WebSensorConfig.stateStyles.high.color).toBe(0x00a030);
    expect(WebSensorConfig.stateStyles.warning.blinkHz).toBe(0.5);
  });

  it('resetWebSensorConfig restores baked-in defaults', () => {
    initWebSensor({ stateStyles: { high: { color: 0x00a030 } }, defaultSize: 99 });
    resetWebSensorConfig();
    expect(WebSensorConfig.stateStyles.high.color).toBe(0x22cc44);
    expect(WebSensorConfig.defaultSize).toBe(1.0);
  });
});
