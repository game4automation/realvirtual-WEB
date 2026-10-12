// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RecordingSession } from './session.mjs';

const session = new RecordingSession();
const server = new McpServer({ name: 'realvirtual-browser-recording', version: '1.0.0' });
const selector = z.string().min(1).describe('Unique Playwright selector; ambiguous matches fail.');
const coordinate = z.number().min(0).max(3840);
const step = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(30_000) }),
  z.object({ type: z.literal('waitFor'), selector, state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(), timeoutMs: z.number().int().min(1).max(60_000).optional() }),
  z.object({ type: z.literal('click'), selector }),
  z.object({ type: z.literal('doubleClick'), selector }),
  z.object({ type: z.literal('fill'), selector, value: z.string() }),
  z.object({ type: z.literal('press'), key: z.string().min(1) }),
  z.object({ type: z.literal('wheel'), x: coordinate, y: coordinate, deltaY: z.number().min(-2000).max(2000) }),
  z.object({ type: z.literal('drag'), fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate,
    durationMs: z.number().int().min(0).max(10_000).optional(), button: z.enum(['left', 'middle', 'right']).optional() }),
]);

const wrap = fn => async args => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await fn(args)) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
};
let starting = false;
let startup;
server.registerTool('recording_start', {
  description: 'Record the entire application viewport in a dedicated headless Chromium page. Loading is included. Returns session directory; video is finalized by recording_stop. No browser chrome or audio.',
  inputSchema: { url: z.string().url(), width: z.number().int().min(320).max(3840).optional(),
    height: z.number().int().min(240).max(2160).optional(), maxDurationSec: z.number().int().min(10).max(1800).optional(), outputDir: z.string().optional() },
}, wrap(async args => {
  if (starting) throw new Error('Recording startup is already in progress.');
  starting = true;
  startup = session.start(args);
  try { return await startup; } finally { starting = false; startup = null; }
}));
server.registerTool('recording_status', { description: 'Get recording state and saved artifact paths.', inputSchema: {} }, wrap(() => session.status()));
server.registerTool('recording_run', {
  description: 'Execute an ordered sequence on the recorded page. Waits provide demo pacing without AI round trips. Stops at the first failed step. Coordinates are viewport pixels. Does not route or replace CONNECT web_* tools.',
  inputSchema: { steps: z.array(step).min(1).max(100) },
}, wrap(({ steps }) => session.run(steps)));
server.registerTool('recording_snapshot', { description: 'Inspect the recorded page: full UI screenshot and accessibility tree.', inputSchema: {} }, async () => {
  try {
    const { screenshot, tree } = await session.snapshot();
    return { content: [{ type: 'text', text: tree }, { type: 'image', data: screenshot.toString('base64'), mimeType: 'image/png' }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
server.registerTool('recording_stop', { description: 'Close the recording page, finalize WebM, and return its path. Also writes final.png and session.json. Safe to repeat.', inputSchema: {} }, wrap(async () => {
  if (starting) throw new Error('Wait for recording_start to finish.');
  return session.stop();
}));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await startup?.catch(() => {});
  try { await session.stop(); } catch (error) { process.stderr.write(`${error.message}\n`); }
  await server.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.stdin.on('end', () => { void shutdown(); });
await server.connect(new StdioServerTransport());
