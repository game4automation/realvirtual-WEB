// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SensorMonitorPlugin pattern tests.
 *
 * Tests the event-based sensor monitoring approach (onChanged callback wrapping)
 * and the RingBuffer event history.
 */
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../src/core/engine/rv-ring-buffer';

// Simplified sensor mock matching RVSensor's onChanged signature
class MockSensor {
  occupied = false;
  onChanged?: (occupied: boolean, sensor: MockSensor) => void;
  node = { userData: { rv: { path: 'TestSensor' } }, name: 'TestSensor' };
}

describe('SensorMonitorPlugin pattern', () => {
  it('emits event on sensor state change via onChanged callback', () => {
    const sensor = new MockSensor();
    const events: { sensorPath: string; occupied: boolean }[] = [];

    // Simulate plugin wrapping onChanged
    const originalOnChanged = sensor.onChanged;
    sensor.onChanged = (occupied, s) => {
      originalOnChanged?.(occupied, s);
      events.push({ sensorPath: 'TestSensor', occupied });
    };

    // Simulate sensor triggering
    sensor.occupied = true;
    sensor.onChanged(true, sensor);

    expect(events).toEqual([{ sensorPath: 'TestSensor', occupied: true }]);
  });

  it('preserves original onChanged callback', () => {
    const sensor = new MockSensor();
    const originalCalls: boolean[] = [];
    const pluginCalls: boolean[] = [];

    // Set original callback
    sensor.onChanged = (occupied) => originalCalls.push(occupied);

    // Plugin wraps it
    const originalOnChanged = sensor.onChanged;
    sensor.onChanged = (occupied, s) => {
      originalOnChanged?.(occupied, s);
      pluginCalls.push(occupied);
    };

    sensor.onChanged(true, sensor);
    expect(originalCalls).toEqual([true]);
    expect(pluginCalls).toEqual([true]);
  });

  it('cleanup restores original callback', () => {
    const sensor = new MockSensor();
    const original = (occupied: boolean, _s: MockSensor) => { /* noop */ };
    sensor.onChanged = original;

    // Plugin wraps
    const saved = sensor.onChanged;
    sensor.onChanged = (occupied, s) => {
      saved?.(occupied, s);
    };

    // Cleanup
    sensor.onChanged = saved;
    expect(sensor.onChanged).toBe(original);
  });

  it('event history in RingBuffer does not exceed capacity', () => {
    const buffer = new RingBuffer<{ time: number }>(5);
    for (let i = 0; i < 10; i++) buffer.push({ time: i });
    expect(buffer.length).toBe(5);
    expect(buffer.last()?.time).toBe(9);
  });

  it('RingBuffer.last() returns undefined when empty', () => {
    const buffer = new RingBuffer<number>(10);
    expect(buffer.last()).toBeUndefined();
  });

  it('RingBuffer.last() returns most recent value', () => {
    const buffer = new RingBuffer<string>(10);
    buffer.push('a');
    buffer.push('b');
    buffer.push('c');
    expect(buffer.last()).toBe('c');
  });
});
