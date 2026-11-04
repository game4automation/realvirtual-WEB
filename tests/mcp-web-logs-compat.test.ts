// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it } from 'vitest';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { clearLogBuffer, debugVerbose } from '../src/core/engine/rv-debug';
import { diagnosticsCollector } from '../src/core/diagnostics/rv-diagnostics-collector';

beforeEach(() => { clearLogBuffer(); diagnosticsCollector.clear(); });

describe('web_logs compatibility', () => {
  it('keeps trace, category, since, limit and the existing entry shape', async () => {
    const plugin = new McpBridgePlugin();
    debugVerbose('loader', 'trace-line');
    diagnosticsCollector.add({ lvl: 'error', cat: 'react', msg: 'old', t: new Date(Date.now() - 10_000).toISOString() });
    diagnosticsCollector.add({ lvl: 'warn', cat: 'console', msg: 'console-line' });
    diagnosticsCollector.add({ lvl: 'error', cat: 'chunk', msg: 'chunk-line', stack: 'stack' });

    const trace = JSON.parse(await plugin.webLogs('trace', 10, 'loader'));
    expect(trace).toEqual([expect.objectContaining({
      level: 'trace', category: 'loader', message: 'trace-line',
      timestamp: expect.any(Number), elapsed: expect.any(Number),
    })]);

    const recent = JSON.parse(await plugin.webLogs('trace', 1, 'console,window,react,chunk', 1));
    expect(recent).toHaveLength(1);
    expect(recent[0]).toEqual({
      level: 'error', category: 'chunk', message: 'chunk-line',
      timestamp: expect.any(Number), elapsed: 0, stack: 'stack',
    });
  });
});
