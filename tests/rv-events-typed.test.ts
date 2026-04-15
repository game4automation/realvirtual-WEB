// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * EventEmitter<TEvents> — Typed event emitter tests.
 *
 * Validates generic on/emit roundtrip, unsubscribe, void events,
 * custom (untyped) events, and removeAllListeners.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from '../src/core/rv-events';

interface TestEvents {
  'test-event': { value: number };
  'void-event': undefined;
}

describe('EventEmitter<TEvents>', () => {
  it('typed on/emit roundtrip', () => {
    const emitter = new EventEmitter<TestEvents>();
    let received: { value: number } | null = null;
    emitter.on('test-event', (data) => { received = data; });
    emitter.emit('test-event', { value: 42 });
    expect(received).toEqual({ value: 42 });
  });

  it('unsubscribe via returned function', () => {
    const emitter = new EventEmitter<TestEvents>();
    let count = 0;
    const off = emitter.on('test-event', () => { count++; });
    emitter.emit('test-event', { value: 1 });
    off();
    emitter.emit('test-event', { value: 2 });
    expect(count).toBe(1);
  });

  it('emit with undefined data for void events', () => {
    const emitter = new EventEmitter<TestEvents>();
    let called = false;
    emitter.on('void-event', () => { called = true; });
    emitter.emit('void-event', undefined);
    expect(called).toBe(true);
  });

  it('untyped overload for custom events', () => {
    const emitter = new EventEmitter<TestEvents>();
    let data: unknown = null;
    emitter.on('custom:event', (d: unknown) => { data = d; });
    emitter.emit('custom:event', { foo: 'bar' });
    expect(data).toEqual({ foo: 'bar' });
  });

  it('removeAllListeners clears everything', () => {
    const emitter = new EventEmitter<TestEvents>();
    let count = 0;
    emitter.on('test-event', () => { count++; });
    emitter.removeAllListeners();
    emitter.emit('test-event', { value: 1 });
    expect(count).toBe(0);
  });

  it('multiple listeners for same event', () => {
    const emitter = new EventEmitter<TestEvents>();
    const calls: number[] = [];
    emitter.on('test-event', (d) => calls.push(d.value));
    emitter.on('test-event', (d) => calls.push(d.value * 10));
    emitter.emit('test-event', { value: 5 });
    expect(calls).toEqual([5, 50]);
  });

  it('off removes specific listener only', () => {
    const emitter = new EventEmitter<TestEvents>();
    const calls: string[] = [];
    const cbA = () => calls.push('a');
    const cbB = () => calls.push('b');
    emitter.on('test-event', cbA);
    emitter.on('test-event', cbB);
    emitter.off('test-event', cbA);
    emitter.emit('test-event', { value: 1 });
    expect(calls).toEqual(['b']);
  });
});
