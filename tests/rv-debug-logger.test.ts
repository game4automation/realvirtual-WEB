// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  debug, debugWarn, debugError,
  logInfo, logWarn, logError,
  getLogBuffer, getLastLogs, queryLogs, clearLogBuffer, getLogBufferSize,
  enableDebug, disableDebug,
  type LogEntry, type LogLevel,
} from '../src/core/engine/rv-debug';

describe('rv-debug structured logger', () => {
  beforeEach(() => {
    clearLogBuffer();
  });

  describe('buffering', () => {
    it('buffers debug() entries even when category is disabled', () => {
      disableDebug('signal');
      debug('signal', 'test message');
      const entries = getLogBuffer();
      expect(entries.length).toBe(1);
      expect(entries[0].category).toBe('signal');
      expect(entries[0].level).toBe('debug');
      expect(entries[0].message).toBe('test message');
    });

    it('buffers debug() entries when category is enabled', () => {
      enableDebug('loader');
      debug('loader', 'loading model');
      const entries = getLogBuffer();
      expect(entries.length).toBe(1);
      expect(entries[0].category).toBe('loader');
    });

    it('buffers debugWarn() with stack trace', () => {
      debugWarn('drive', 'speed exceeded');
      const entries = getLogBuffer();
      expect(entries.length).toBe(1);
      expect(entries[0].level).toBe('warn');
      expect(entries[0].stack).toBeDefined();
    });

    it('buffers debugError() with stack trace', () => {
      debugError('sensor', 'collision error');
      const entries = getLogBuffer();
      expect(entries.length).toBe(1);
      expect(entries[0].level).toBe('error');
      expect(entries[0].stack).toBeDefined();
    });

    it('buffers logInfo() with system category', () => {
      logInfo('system started');
      const entries = getLogBuffer();
      expect(entries.length).toBe(1);
      expect(entries[0].category).toBe('system');
      expect(entries[0].level).toBe('info');
    });

    it('buffers logWarn() with stack trace', () => {
      logWarn('low memory');
      const entries = getLogBuffer();
      expect(entries[0].level).toBe('warn');
      expect(entries[0].stack).toBeDefined();
    });

    it('buffers logError() with stack trace', () => {
      logError('fatal error');
      const entries = getLogBuffer();
      expect(entries[0].level).toBe('error');
      expect(entries[0].stack).toBeDefined();
    });

    it('stores optional data payload', () => {
      debug('signal', 'value changed', { from: false, to: true });
      const entries = getLogBuffer();
      expect(entries[0].data).toEqual({ from: false, to: true });
    });

    it('stores multiple args as array in data', () => {
      debug('loader', 'loaded', 'file.glb', 42);
      const entries = getLogBuffer();
      expect(entries[0].data).toEqual(['file.glb', 42]);
    });

    it('omits data when no extra args', () => {
      debug('loader', 'no args');
      const entries = getLogBuffer();
      expect(entries[0].data).toBeUndefined();
    });
  });

  describe('timestamps', () => {
    it('has valid timestamps', () => {
      const before = Date.now();
      debug('loader', 'test');
      const after = Date.now();
      const entry = getLogBuffer()[0];
      expect(entry.timestamp).toBeGreaterThanOrEqual(before);
      expect(entry.timestamp).toBeLessThanOrEqual(after);
    });

    it('has positive elapsed time', () => {
      debug('loader', 'test');
      const entry = getLogBuffer()[0];
      expect(entry.elapsed).toBeGreaterThan(0);
    });

    it('timestamps are monotonically increasing', () => {
      for (let i = 0; i < 10; i++) {
        debug('loader', `msg ${i}`);
      }
      const entries = getLogBuffer();
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].timestamp).toBeGreaterThanOrEqual(entries[i - 1].timestamp);
      }
    });
  });

  describe('buffer overflow', () => {
    it('keeps only the last 500 entries on overflow', () => {
      for (let i = 0; i < 600; i++) {
        debug('loader', `msg ${i}`);
      }
      expect(getLogBufferSize()).toBe(500);
      const entries = getLogBuffer();
      expect(entries.length).toBe(500);
      // Oldest should be msg 100 (0-99 evicted)
      expect(entries[0].message).toBe('msg 100');
      expect(entries[499].message).toBe('msg 599');
    });
  });

  describe('getLastLogs()', () => {
    it('returns the last N entries', () => {
      debug('loader', 'a');
      debug('loader', 'b');
      debug('loader', 'c');
      const last2 = getLastLogs(2);
      expect(last2.length).toBe(2);
      expect(last2[0].message).toBe('b');
      expect(last2[1].message).toBe('c');
    });

    it('returns all if N > buffer size', () => {
      debug('loader', 'only one');
      const result = getLastLogs(100);
      expect(result.length).toBe(1);
    });
  });

  describe('queryLogs()', () => {
    beforeEach(() => {
      debug('signal', 'signal debug');
      debugWarn('signal', 'signal warn');
      debugError('signal', 'signal error');
      debug('loader', 'loader debug');
      logInfo('system info');
      logWarn('system warn');
    });

    it('filters by level (warn and above)', () => {
      const result = queryLogs({ level: 'warn' });
      expect(result.length).toBe(3); // signal warn, signal error, system warn
      expect(result.every(e => e.level === 'warn' || e.level === 'error')).toBe(true);
    });

    it('filters by level (error only)', () => {
      const result = queryLogs({ level: 'error' });
      expect(result.length).toBe(1);
      expect(result[0].message).toBe('signal error');
    });

    it('filters by category', () => {
      const result = queryLogs({ category: 'signal' });
      expect(result.length).toBe(3);
      expect(result.every(e => e.category === 'signal')).toBe(true);
    });

    it('filters by category system', () => {
      const result = queryLogs({ category: 'system' });
      expect(result.length).toBe(2);
    });

    it('combines level and category filters', () => {
      const result = queryLogs({ level: 'warn', category: 'signal' });
      expect(result.length).toBe(2); // signal warn + signal error
    });

    it('limits results', () => {
      const result = queryLogs({ limit: 2 });
      expect(result.length).toBe(2);
      // Should be last 2 entries
      expect(result[0].message).toBe('system info');
      expect(result[1].message).toBe('system warn');
    });

    it('filters by timestamp', () => {
      const midTime = getLogBuffer()[3].timestamp; // loader debug
      const result = queryLogs({ since: midTime });
      expect(result.length).toBeGreaterThanOrEqual(3); // loader debug, system info, system warn
    });
  });

  describe('clearLogBuffer()', () => {
    it('clears all entries', () => {
      debug('loader', 'a');
      debug('loader', 'b');
      expect(getLogBufferSize()).toBe(2);
      clearLogBuffer();
      expect(getLogBufferSize()).toBe(0);
      expect(getLogBuffer()).toEqual([]);
    });
  });

  describe('LogEntry structure', () => {
    it('has all required fields', () => {
      debug('signal', 'test');
      const entry = getLogBuffer()[0];
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('category');
      expect(entry).toHaveProperty('message');
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('elapsed');
    });

    it('level values are valid LogLevel', () => {
      const validLevels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
      debug('loader', 'test');
      logInfo('test');
      logWarn('test');
      logError('test');
      for (const entry of getLogBuffer()) {
        expect(validLevels).toContain(entry.level);
      }
    });
  });
});
