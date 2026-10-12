// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP records UI actions, reports failures, finalizes and produces playable video', { timeout: 90_000 }, async () => {
  let videoPath;
  const fixture = createServer((req, res) => {
    if (req.url === '/video' && videoPath) {
      res.writeHead(200, { 'Content-Type': 'video/webm' });
      createReadStream(videoPath).pipe(res);
    } else if (req.url === '/missing') { res.writeHead(404); res.end('Missing'); }
    else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Recording fixture</h1><button onclick="document.querySelector(\'aside\').hidden=false">Properties</button><aside hidden>Drive properties</aside><button>Duplicate</button><button>Duplicate</button><canvas width="500" height="400"></canvas><script>let n=0;setInterval(()=>{const c=document.querySelector("canvas").getContext("2d");c.fillStyle=`hsl(${n++%360} 80% 50%)`;c.fillRect(0,0,500,400)},40)</script>');
    }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixture.address().port}`;
  const client = new Client({ name: 'recording-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], stderr: 'inherit' }));
  const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const payload = result => { assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  try {
    assert.equal((await client.listTools()).tools.length, 5);
    assert.equal((await call('recording_start', { url, width: -1 })).isError, true);
    assert.equal((await call('recording_start', { url: `${url}/missing` })).isError, true);
    payload(await call('recording_start', { url, width: 960, height: 540 }));
    assert.equal((await call('recording_start', { url })).isError, true);
    assert.equal((await call('recording_run', { steps: [{ type: 'click', selector: 'text=Duplicate' }] })).isError, true);
    const run = payload(await call('recording_run', { steps: [
      { type: 'click', selector: 'button:has-text("Properties")' },
      { type: 'waitFor', selector: 'aside' },
      { type: 'wait', ms: 1500 },
    ] }));
    assert.equal(run.completed, 3);
    const snapshot = await call('recording_snapshot');
    assert.match(snapshot.content[0].text, /Drive properties/);
    assert.equal(snapshot.content[1].mimeType, 'image/png');
    const saved = payload(await call('recording_stop'));
    assert.equal(saved.state, 'saved');
    assert.ok(saved.bytes > 1000);
    videoPath = saved.videoPath;
    assert.equal(payload(await call('recording_stop')).videoPath, videoPath);
    assert.equal((await call('recording_run', { steps: [{ type: 'wait', ms: 1 }] })).isError, true);
    const manifest = JSON.parse(await readFile(join(saved.directory, 'session.json'), 'utf8'));
    assert.ok(manifest.steps.some(s => s.outcome === 'error'));
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url);
      const metadata = await page.evaluate(async url => {
        const video = document.createElement('video');
        video.src = `${url}/video`;
        await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('Video decode failed')); });
        return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      }, url);
      assert.equal(metadata.width, 960);
      assert.equal(metadata.height, 540);
      assert.ok(metadata.duration >= 1.5);
    } finally { await browser.close(); }
    payload(await call('recording_start', { url, width: 960, height: 540, maxDurationSec: 10 }));
    assert.equal((await call('recording_run', { steps: [{ type: 'wait', ms: 20_000 }] })).isError, true);
    assert.equal(payload(await call('recording_stop')).state, 'saved');
  } finally {
    await call('recording_stop').catch(() => {});
    await client.close();
    await new Promise(resolve => fixture.close(resolve));
  }
});
