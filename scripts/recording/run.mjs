// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Runs the same MCP protocol an assistant uses, including start/run/snapshot/stop.
const [url, recipePath] = process.argv.slice(2);
if (!url || !recipePath) throw new Error('Usage: node scripts/recording/run.mjs <application-url> <recipe.json>');
const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
const client = new Client({ name: 'realvirtual-recording-recipe', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], stderr: 'inherit' });
let failure;
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  if (result.isError) throw new Error(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
  return result;
}
await client.connect(transport);
try {
  const start = await call('recording_start', { url, ...recipe.recording });
  const directory = JSON.parse(start.content[0].text).directory;
  console.log(`Recording: ${directory}`);
  // Submit short batches so MCP requests stay within normal client timeouts.
  for (const steps of recipe.batches) {
    console.log((await call('recording_run', { steps })).content[0].text);
  }
  const snapshot = await call('recording_snapshot');
  await writeFile(join(directory, 'accessibility.txt'), snapshot.content.find(c => c.type === 'text').text);
} catch (error) { failure = error; }
finally {
  try { console.log((await call('recording_stop')).content[0].text); }
  finally { await client.close(); }
}
if (failure) throw failure;
