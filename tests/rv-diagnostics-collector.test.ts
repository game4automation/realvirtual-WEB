// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  diagnosticsCollector, getDiagnosticsEntries, installDiagnosticsCollector,
} from '../src/core/diagnostics/rv-diagnostics-collector';

// The underlying console methods are replaced BEFORE the collector wraps them, so the tests see
// both sides: the collector's entry and the call that still reaches the original method.
const originalWarn = vi.fn();
const originalError = vi.fn();
beforeAll(() => {
  console.warn = originalWarn;
  console.error = originalError;
  installDiagnosticsCollector();
});
beforeEach(() => {
  diagnosticsCollector.clear();
  vi.useRealTimers();
  originalWarn.mockClear();
  originalError.mockClear();
});

describe('DiagnosticsCollector', () => {
  it('captures console warnings/errors and always calls the original', () => {
    console.warn('warning', { code: 7 });
    expect(originalWarn).toHaveBeenCalledWith('warning', { code: 7 });
    expect(getDiagnosticsEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ lvl: 'warn', cat: 'console', msg: 'warning {"code":7}' }),
    ]));
  });

  it('captures window errors and unhandled rejections', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'window boom', error: new Error('window boom') }));
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('promise boom') });
    window.dispatchEvent(rejection);
    expect(getDiagnosticsEntries().filter(e => e.cat === 'window').map(e => e.msg).join('\n'))
      .toContain('window boom');
    expect(getDiagnosticsEntries().filter(e => e.cat === 'window').map(e => e.msg).join('\n'))
      .toContain('promise boom');
  });

  it('keeps only 15 minutes and at most 5000 entries', () => {
    const now = Date.now();
    diagnosticsCollector.add({ t: new Date(now - 15 * 60_000 - 1).toISOString(), lvl: 'info', cat: 'window', msg: 'old' });
    for (let i = 0; i < 5001; i++) diagnosticsCollector.add({ lvl: 'info', cat: 'window', msg: `entry-${i}` });
    const entries = getDiagnosticsEntries();
    expect(entries).toHaveLength(5000);
    expect(entries.some(e => e.msg === 'old')).toBe(false);
    expect(entries[0].msg).toBe('entry-1');
  });

  it('collapses identical messages after 50 per second', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 55; i++) diagnosticsCollector.add({ lvl: 'warn', cat: 'window', msg: 'flood' });
    const entries = getDiagnosticsEntries();
    expect(entries).toHaveLength(51);
    expect(entries.at(-1)).toMatchObject({ msg: 'flood', rep: 5 });
  });

  it('does not recurse when a subscriber logs', () => {
    const off = diagnosticsCollector.subscribe(() => console.error('subscriber log'));
    diagnosticsCollector.add({ lvl: 'info', cat: 'window', msg: 'once' });
    off();
    expect(getDiagnosticsEntries()).toHaveLength(1);
    expect(originalError).toHaveBeenCalledOnce();
  });

  it('classifies dynamic-import rejection and resource errors as chunks', () => {
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new TypeError('Failed to fetch dynamically imported module') });
    window.dispatchEvent(rejection);
    const script = document.createElement('script');
    script.src = '/missing-chunk.js';
    document.head.appendChild(script);
    script.dispatchEvent(new Event('error'));
    script.remove();
    expect(getDiagnosticsEntries().filter(e => e.cat === 'chunk')).toHaveLength(2);
  });
});
