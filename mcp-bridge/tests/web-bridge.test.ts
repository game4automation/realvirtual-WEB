// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { WebBridge } from '../src/web-bridge.js';
import { Logger } from '../src/log.js';
import type { ControlAction } from '../src/protocol.js';
import { MockBrowserClient, waitFor } from './mock-browser-client.js';

// Silence the stderr logger during tests.
beforeAll(() => {
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

const open: WebBridge[] = [];
const clients: MockBrowserClient[] = [];

function makeBridge(callTimeoutMs?: number): WebBridge {
  const logger = new Logger();
  const bridge = new WebBridge({ port: 0, logger, callTimeoutMs });
  logger.setSink((lines) => bridge.sendLog(lines));
  open.push(bridge);
  return bridge;
}

async function connectBrowser(bridge: WebBridge): Promise<MockBrowserClient> {
  const c = await MockBrowserClient.connect(bridge.port);
  clients.push(c);
  await waitFor(() => bridge.connected);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const b of open.splice(0)) await b.close().catch(() => {});
});

const DISCOVER = {
  type: 'discover',
  schema_version: '1.0.0',
  instructions: '# webviewer instructions',
  tools: [{ name: 'web_status', description: 'status', inputSchema: { type: 'object', properties: {}, required: [] } }],
};

describe('WebBridge', () => {
  it('emits discover with tools + instructions', async () => {
    const bridge = makeBridge();
    await bridge.start();
    const got = new Promise<{ count: number; instr: string }>((resolve) => {
      bridge.on('discover', (tools, instr) => resolve({ count: tools.length, instr }));
    });
    const browser = await connectBrowser(bridge);
    browser.send(DISCOVER);
    const { count, instr } = await got;
    expect(count).toBe(1);
    expect(instr).toContain('webviewer instructions');
  });

  it('routes a call to the browser and returns its result', async () => {
    const bridge = makeBridge();
    await bridge.start();
    const browser = await connectBrowser(bridge);
    const callP = bridge.callBrowser('web_drive_list', {});
    const call = await browser.nextOfType('call');
    expect(call.tool).toBe('web_drive_list');
    expect(typeof call.id).toBe('number');
    browser.send({ type: 'result', id: call.id, result: '[{"name":"D1"}]' });
    await expect(callP).resolves.toContain('D1');
  });

  it('rejects a call after the timeout when no result arrives', async () => {
    const bridge = makeBridge();
    await bridge.start();
    await connectBrowser(bridge);
    await expect(bridge.callBrowser('web_status', {}, 50)).rejects.toThrow(/timed out/i);
  });

  it('rejects when no browser is connected', async () => {
    const bridge = makeBridge();
    await bridge.start();
    await expect(bridge.callBrowser('web_status', {})).rejects.toThrow(/not connected/i);
  });

  it('propagates a browser-reported error', async () => {
    const bridge = makeBridge();
    await bridge.start();
    const browser = await connectBrowser(bridge);
    const callP = bridge.callBrowser('web_drive_jog', { name: 'X' });
    const call = await browser.nextOfType('call');
    browser.send({ type: 'result', id: call.id, error: 'Drive "X" not found' });
    await expect(callP).rejects.toThrow(/not found/i);
  });

  it('closes the previous browser with 1008 and rejects its pending calls', async () => {
    const bridge = makeBridge();
    await bridge.start();
    const a = await connectBrowser(bridge);
    const pendingP = bridge.callBrowser('web_status', {}, 2000);
    const settled = expect(pendingP).rejects.toThrow(/another tab/i); // attach handler first
    const b = await connectBrowser(bridge);
    await settled;
    const close = await a.nextClose();
    expect(close.code).toBe(1008);
    expect(b.readyState).toBe(1); // OPEN
  });

  it('rejects pending calls on browser disconnect', async () => {
    const bridge = makeBridge();
    await bridge.start();
    const browser = await connectBrowser(bridge);
    const pendingP = bridge.callBrowser('web_status', {}, 2000);
    const settled = expect(pendingP).rejects.toThrow(/disconnect/i); // attach handler first
    await browser.close();
    await settled;
  });

  it('ignores malformed messages and stays functional', async () => {
    const bridge = makeBridge();
    await bridge.start();
    const browser = await connectBrowser(bridge);
    browser.sendRaw('this is not json {');
    browser.send({ foo: 'no type field' });
    // still works afterwards
    const callP = bridge.callBrowser('web_status', {});
    const call = await browser.nextOfType('call');
    browser.send({ type: 'result', id: call.id, result: 'ok' });
    await expect(callP).resolves.toBe('ok');
  });

  it('emits control actions', async () => {
    const bridge = makeBridge();
    await bridge.start();
    const browser = await connectBrowser(bridge);
    const action = await new Promise<ControlAction>((resolve) => {
      bridge.on('control', resolve);
      browser.send({ type: 'control', action: 'pause' });
    });
    expect(action).toBe('pause');
  });

  it('rejects new connections while paused (close 1013)', async () => {
    const bridge = makeBridge();
    await bridge.start();
    bridge.setPaused(true);
    const c = await MockBrowserClient.connect(bridge.port);
    clients.push(c);
    const close = await c.nextClose();
    expect(close.code).toBe(1013);
    expect(bridge.connected).toBe(false);
  });

  it('drifts to the next free port when the canonical port is held by a live bridge', async () => {
    // Bridge A grabs an ephemeral port; that becomes the "canonical" port B wants.
    const a = makeBridge();
    await a.start();
    const canonical = a.port;
    expect(a.bindFailed).toBe(false);

    // Bridge B requests the SAME port. A is alive, so retries never free it →
    // B must drift upward to the next free port instead of degrading to 0 tools.
    const logger = new Logger();
    const b = new WebBridge({ port: canonical, logger, bindRetries: 1, bindRetryDelayMs: 1, maxPortDrift: 20 });
    logger.setSink((lines) => b.sendLog(lines));
    open.push(b);
    await b.start();

    expect(b.bindFailed).toBe(false);
    expect(b.port).not.toBe(canonical);
    expect(b.port).toBeGreaterThan(canonical);
    expect(b.port).toBeLessThanOrEqual(canonical + 20);

    // The drifted bridge is fully functional — a browser can connect to its port.
    const browser = await MockBrowserClient.connect(b.port);
    clients.push(browser);
    await waitFor(() => b.connected);
    expect(b.connected).toBe(true);
  });

  it('mirrors server log lines to the browser', async () => {
    const logger = new Logger();
    const bridge = new WebBridge({ port: 0, logger });
    logger.setSink((lines) => bridge.sendLog(lines));
    open.push(bridge);
    await bridge.start();
    const browser = await connectBrowser(bridge);
    logger.info('hello-from-server-xyz');
    // The connect backlog arrives as earlier 'log' frames — drain until the marker.
    let dump = '';
    for (let i = 0; i < 6 && !dump.includes('hello-from-server-xyz'); i++) {
      const log = await browser.nextOfType('log', 1000);
      dump += JSON.stringify(log.lines);
    }
    expect(dump).toContain('hello-from-server-xyz');
  });
});
