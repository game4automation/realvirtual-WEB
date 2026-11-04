// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-606 test fixture — a lock holder / contender process for tests/test-lock.node.test.ts.
 *
 *   node holder.mjs <mode> <port> <dir> [host] [tag]
 *
 * Modes:
 *   lock     acquire() the real lock on <port>; write <dir>/ready.json; hold until
 *            <dir>/release exists; release; write <dir>/released; exit 0.
 *   raw      bind a plain net server (NO HTTP answer — an unresponsive holder) on
 *            [host] (default 127.0.0.1); ready / release / released as above.
 *   contend  wait for <dir>/go, then acquire() with a short timeout; write
 *            <dir>/result-<pid> = WON or LOST; a winner holds until <dir>/release.
 *   contend-raw  same, but a plain bind on [host] instead of the lock — the BROKEN
 *            variant (different literal addresses coexist on Windows).
 *
 * Ordering is by barrier files only; the 25 ms file polls are not timing assumptions.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { acquire, holderInfo } from '../../../scripts/test-lock.mjs';

const [mode, portArg, dir, host = '127.0.0.1', tag = 'holder-fixture'] = process.argv.slice(2);
const port = Number(portArg);
const file = (name) => path.join(dir, name);
const waitFile = async (name) => {
  while (!fs.existsSync(file(name))) await new Promise((r) => setTimeout(r, 25));
};

function rawBind(bindHost) {
  return new Promise((resolve) => {
    const server = net.createServer(() => { /* accept and never answer */ });
    server.once('error', (error) => resolve({ ok: false, code: error.code }));
    server.listen({ port, host: bindHost, ipv6Only: false }, () => resolve({ ok: true, server }));
  });
}

async function main() {
  if (mode === 'lock') {
    const lock = await acquire({ info: holderInfo([tag, `port=${port}`]), port, timeoutSeconds: 30, pollSeconds: 0.2 });
    fs.writeFileSync(file('ready.json'), JSON.stringify({ pid: process.pid, address: lock.server.address() }));
    await waitFile('release');
    await lock.release();
    fs.writeFileSync(file('released'), String(process.pid));
    return 0;
  }
  if (mode === 'raw') {
    const bound = await rawBind(host);
    if (!bound.ok) {
      fs.writeFileSync(file('ready.json'), JSON.stringify({ pid: process.pid, error: bound.code }));
      return 1;
    }
    fs.writeFileSync(file('ready.json'), JSON.stringify({ pid: process.pid, address: bound.server.address() }));
    await waitFile('release');
    await new Promise((r) => bound.server.close(() => r()));
    fs.writeFileSync(file('released'), String(process.pid));
    return 0;
  }
  if (mode === 'contend' || mode === 'contend-raw') {
    fs.writeFileSync(file(`armed-${process.pid}`), '');
    await waitFile('go');
    let won = false;
    let release = async () => {};
    if (mode === 'contend') {
      try {
        const lock = await acquire({ info: holderInfo([tag]), port, timeoutSeconds: 1.5, pollSeconds: 0.2, log: () => {} });
        won = true;
        release = () => lock.release();
      } catch {
        won = false;
      }
    } else {
      const bound = await rawBind(host);
      won = bound.ok;
      if (bound.ok) release = () => new Promise((r) => bound.server.close(() => r()));
    }
    fs.writeFileSync(file(`result-${process.pid}`), won ? 'WON' : 'LOST');
    if (won) {
      await waitFile('release');
      await release();
    }
    return 0;
  }
  process.stderr.write(`holder.mjs: unknown mode ${mode}\n`);
  return 2;
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`holder.mjs: ${error?.stack ?? error}\n`);
  process.exit(1);
});
