// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-debug.ts — Structured debug logging for the WebViewer.
 *
 * Categories can be toggled individually via URL parameter or localStorage.
 * Enable all:  ?debug=all  or  localStorage.setItem('rv-debug', 'all')
 * Specific:    ?debug=playback,loader  or  localStorage.setItem('rv-debug', 'playback,loader')
 * Disable:     ?debug=none  or  localStorage.removeItem('rv-debug')
 *
 * In dev mode (Vite), 'loader' category is enabled by default.
 *
 * All log entries are always buffered in a ring buffer (500 entries) regardless
 * of active categories. Console output is still gated by active categories.
 * The buffer is queryable via getLogBuffer(), getLastLogs(), and queryLogs().
 */

import { RingBuffer } from './rv-ring-buffer';

// ── Types ──

export type DebugCategory =
  | 'loader'     // GLB loading, node registration
  | 'playback'   // DrivesPlayback, ReplayRecording
  | 'drive'      // Drive updates, positionOverwrite
  | 'transport'  // TransportSurface, MU movement
  | 'sensor'     // Sensor collision, occupancy
  | 'logic'      // LogicStep execution
  | 'signal'     // Signal store changes
  | 'erratic'    // ErraticDriver
  | 'grip'       // Grip pick/place
  | 'parity'     // GLB extras parity validation
  | 'physics'    // Rapier physics plugin
  | 'config'     // App config loading
  | 'multiuser'  // Multiuser synchronization
  | 'interface'  // Industrial interface connections
  | 'render'     // Render loop, performance metrics
  | 'plugins';   // Model plugin loading/unloading

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  category: DebugCategory | 'system';
  message: string;
  timestamp: number;      // Date.now()
  elapsed: number;        // seconds since page load
  data?: unknown;
  stack?: string;         // captured for warn/error level
}

// ── Constants ──

const ALL_CATEGORIES: DebugCategory[] = [
  'loader', 'playback', 'drive', 'transport', 'sensor', 'logic', 'signal', 'erratic', 'grip', 'parity',
  'physics', 'config', 'multiuser', 'interface', 'render',
];

const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

const LOG_BUFFER_SIZE = 500;

// ── State ──

/** Active debug categories (gate console output only, buffer always records) */
const activeCategories = new Set<DebugCategory>();

/** Ring buffer for structured log entries */
const logBuffer = new RingBuffer<LogEntry>(LOG_BUFFER_SIZE);

/** Page load time for elapsed calculation */
const startTime = performance.now();

// ── Initialization ──

/** Initialize from URL params and localStorage */
function init(): void {
  // Guard for test/SSR environments where window may not exist
  if (typeof window === 'undefined') return;

  const params = new URLSearchParams(window.location.search);
  const debugParam = params.get('debug') ?? localStorage.getItem('rv-debug') ?? '';

  if (debugParam === 'all') {
    ALL_CATEGORIES.forEach((c) => activeCategories.add(c));
  } else if (debugParam && debugParam !== 'none') {
    for (const cat of debugParam.split(',')) {
      const trimmed = cat.trim() as DebugCategory;
      if (ALL_CATEGORIES.includes(trimmed)) {
        activeCategories.add(trimmed);
      }
    }
  }

  // Dev mode defaults: enable loader
  if (import.meta.env.DEV && activeCategories.size === 0) {
    activeCategories.add('loader');
  }

  if (activeCategories.size > 0) {
    console.log(`[rv-debug] Active categories: ${[...activeCategories].join(', ')}`);
  }
}

init();

// ── Helpers ──

function elapsed(): number {
  return +((performance.now() - startTime) / 1000).toFixed(3);
}

function captureStack(): string | undefined {
  const err = new Error();
  // Skip Error + captureStack + caller frames
  return err.stack?.split('\n').slice(3, 6).join('\n');
}

// ── Category-based logging (primary API — backward compatible) ──

/** Check if a category is enabled */
export function isDebugEnabled(category: DebugCategory): boolean {
  return activeCategories.has(category);
}

/** Enable a category at runtime */
export function enableDebug(category: DebugCategory): void {
  activeCategories.add(category);
}

/** Disable a category at runtime */
export function disableDebug(category: DebugCategory): void {
  activeCategories.delete(category);
}

/** Structured debug log — always buffers, only prints to console if category is active */
export function debug(category: DebugCategory, message: string, ...args: unknown[]): void {
  logBuffer.push({
    level: 'debug',
    category,
    message,
    timestamp: Date.now(),
    elapsed: elapsed(),
    data: args.length === 1 ? args[0] : args.length > 0 ? args : undefined,
  });
  if (!activeCategories.has(category)) return;
  console.log(`[${category}] ${message}`, ...args);
}

/** Structured debug warning — always buffers, only prints to console if category is active */
export function debugWarn(category: DebugCategory, message: string, ...args: unknown[]): void {
  logBuffer.push({
    level: 'warn',
    category,
    message,
    timestamp: Date.now(),
    elapsed: elapsed(),
    data: args.length === 1 ? args[0] : args.length > 0 ? args : undefined,
    stack: captureStack(),
  });
  if (!activeCategories.has(category)) return;
  console.warn(`[${category}] ${message}`, ...args);
}

/** Structured debug error — always buffers, only prints to console if category is active */
export function debugError(category: DebugCategory, message: string, ...args: unknown[]): void {
  logBuffer.push({
    level: 'error',
    category,
    message,
    timestamp: Date.now(),
    elapsed: elapsed(),
    data: args.length === 1 ? args[0] : args.length > 0 ? args : undefined,
    stack: captureStack(),
  });
  if (!activeCategories.has(category)) return;
  console.error(`[${category}] ${message}`, ...args);
}

// ── Non-categorized logging (always prints to console) ──

/** Log at info level (category 'system') — always buffers and prints */
export function logInfo(message: string, data?: unknown): void {
  logBuffer.push({
    level: 'info',
    category: 'system',
    message,
    timestamp: Date.now(),
    elapsed: elapsed(),
    data,
  });
  console.log(`[system] ${message}`, ...(data !== undefined ? [data] : []));
}

/** Log at warn level (category 'system') — always buffers and prints */
export function logWarn(message: string, data?: unknown): void {
  logBuffer.push({
    level: 'warn',
    category: 'system',
    message,
    timestamp: Date.now(),
    elapsed: elapsed(),
    data,
    stack: captureStack(),
  });
  console.warn(`[system] ${message}`, ...(data !== undefined ? [data] : []));
}

/** Log at error level (category 'system') — always buffers and prints */
export function logError(message: string, data?: unknown): void {
  logBuffer.push({
    level: 'error',
    category: 'system',
    message,
    timestamp: Date.now(),
    elapsed: elapsed(),
    data,
    stack: captureStack(),
  });
  console.error(`[system] ${message}`, ...(data !== undefined ? [data] : []));
}

// ── Buffer query API ──

/** Get all buffered log entries (oldest first). */
export function getLogBuffer(): LogEntry[] {
  return logBuffer.toArray();
}

/** Get the last N log entries. */
export function getLastLogs(n: number): LogEntry[] {
  return logBuffer.lastN(n);
}

/** Query logs with optional filters. */
export function queryLogs(opts: {
  level?: LogLevel;
  category?: DebugCategory | 'system';
  since?: number;       // timestamp (Date.now())
  limit?: number;
}): LogEntry[] {
  let entries = logBuffer.toArray();
  if (opts.level) {
    const minIdx = LOG_LEVELS.indexOf(opts.level);
    entries = entries.filter(e => LOG_LEVELS.indexOf(e.level) >= minIdx);
  }
  if (opts.category) entries = entries.filter(e => e.category === opts.category);
  if (opts.since !== undefined) entries = entries.filter(e => e.timestamp >= opts.since!);
  if (opts.limit) entries = entries.slice(-opts.limit);
  return entries;
}

/** Clear the log buffer. */
export function clearLogBuffer(): void {
  logBuffer.clear();
}

/** Get the number of buffered entries. */
export function getLogBufferSize(): number {
  return logBuffer.count;
}
