// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { test, expect } from 'playwright/test';

/**
 * Debug API endpoint tests — verifies the debug HTTP API works correctly.
 *
 * These tests validate the structured logging endpoints and command queue
 * that Claude Code uses for observability.
 */
test.describe('Debug API endpoints', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Wait for model to load and debug snapshot to populate
    await page.waitForSelector('canvas', { timeout: 30_000 });
    await page.waitForTimeout(5_000);
  });

  test('GET /__api/debug returns valid JSON snapshot', async ({ page }) => {
    const response = await page.request.get('/__api/debug');
    expect(response.ok()).toBeTruthy();
    expect(response.headers()['content-type']).toContain('application/json');

    const data = await response.json();
    expect(data).toBeDefined();
    expect(typeof data).toBe('object');
    expect(data).not.toEqual({ status: 'no data yet' });
  });

  test('GET /__api/debug/logs returns array of log entries', async ({ page }) => {
    const response = await page.request.get('/__api/debug/logs');
    expect(response.ok()).toBeTruthy();

    const logs = await response.json();
    expect(Array.isArray(logs)).toBeTruthy();

    // After model load, there should be at least a few log entries
    if (logs.length > 0) {
      const entry = logs[0];
      // Verify LogEntry structure
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('category');
      expect(entry).toHaveProperty('message');
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('elapsed');
      expect(['trace', 'debug', 'info', 'warn', 'error']).toContain(entry.level);
      expect(typeof entry.message).toBe('string');
      expect(typeof entry.timestamp).toBe('number');
      expect(typeof entry.elapsed).toBe('number');
    }
  });

  test('GET /__api/debug/logs?level=warn filters by severity', async ({ page }) => {
    const allResponse = await page.request.get('/__api/debug/logs');
    const allLogs = await allResponse.json() as { level: string }[];

    const warnResponse = await page.request.get('/__api/debug/logs?level=warn');
    expect(warnResponse.ok()).toBeTruthy();

    const warnLogs = await warnResponse.json() as { level: string }[];
    expect(Array.isArray(warnLogs)).toBeTruthy();

    // All entries should be warn or error level
    for (const entry of warnLogs) {
      expect(['warn', 'error']).toContain(entry.level);
    }

    // Warn-filtered should be <= total logs
    expect(warnLogs.length).toBeLessThanOrEqual(allLogs.length);
  });

  test('GET /__api/debug/logs?category=signal filters by category', async ({ page }) => {
    const response = await page.request.get('/__api/debug/logs?category=signal');
    expect(response.ok()).toBeTruthy();

    const logs = await response.json() as { category: string }[];
    expect(Array.isArray(logs)).toBeTruthy();

    // All entries should be 'signal' category
    for (const entry of logs) {
      expect(entry.category).toBe('signal');
    }
  });

  test('GET /__api/debug/logs?limit=5 limits results', async ({ page }) => {
    const response = await page.request.get('/__api/debug/logs?limit=5');
    expect(response.ok()).toBeTruthy();

    const logs = await response.json();
    expect(Array.isArray(logs)).toBeTruthy();
    expect(logs.length).toBeLessThanOrEqual(5);
  });

  test('POST /__api/debug/cmd queues a command', async ({ page }) => {
    // Send a setSignal command
    const cmdResponse = await page.request.post('/__api/debug/cmd', {
      data: { cmd: 'setSignal', name: 'TestSignal', value: true },
    });
    expect(cmdResponse.ok()).toBeTruthy();

    const cmdResult = await cmdResponse.json();
    expect(cmdResult.queued).toBe(true);
    expect(typeof cmdResult.id).toBe('number');
  });

  test('GET /__api/debug/signals returns signal map', async ({ page }) => {
    const response = await page.request.get('/__api/debug/signals');
    expect(response.ok()).toBeTruthy();

    const signals = await response.json();
    expect(typeof signals).toBe('object');
  });

  test('GET /__api/debug with sub-routes returns correct data', async ({ page }) => {
    // Test drives sub-route
    const drivesResponse = await page.request.get('/__api/debug/drives');
    expect(drivesResponse.ok()).toBeTruthy();
    const drives = await drivesResponse.json();
    expect(drives).toBeDefined();

    // Test sensors sub-route
    const sensorsResponse = await page.request.get('/__api/debug/sensors');
    expect(sensorsResponse.ok()).toBeTruthy();
    const sensors = await sensorsResponse.json();
    expect(sensors).toBeDefined();
  });

  test('GET /__api/debug/unknown returns 404', async ({ page }) => {
    const response = await page.request.get('/__api/debug/nonexistent_route_xyz');
    // Should return 404 for unknown routes
    const data = await response.json();
    // Either HTTP 404 or JSON error response
    expect(response.status() === 404 || data.error !== undefined).toBeTruthy();
  });
});
