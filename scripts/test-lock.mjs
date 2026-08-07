// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const lockDir = process.env.RV_TEST_LOCK_DIR;
if (!lockDir) process.exit(0);

const action = process.argv[2];
if (action !== 'acquire' && action !== 'release') {
  process.stderr.write('Usage: node scripts/test-lock.mjs <acquire|release>\n');
  process.exit(2);
}

const lockPath = join(lockDir, 'webviewer-tests.lock');
const timeoutSeconds = parsePositiveNumber(process.env.RV_TEST_LOCK_TIMEOUT_SECONDS, 600);
const pollSeconds = parsePositiveNumber(process.env.RV_TEST_LOCK_POLL_SECONDS, 2);

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getParentPid(pid) {
  try {
    if (process.platform === 'win32') {
      const command = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`;
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      const parentPid = Number(output);
      return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null;
    }

    const stat = execFileSync('sh', ['-c', `cat /proc/${pid}/stat 2>/dev/null`], {
      encoding: 'utf8',
    }).trim();
    const closingParen = stat.lastIndexOf(')');
    const fields = stat.slice(closingParen + 2).split(/\s+/);
    const parentPid = Number(fields[1]);
    return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null;
  } catch {
    return null;
  }
}

function getLockOwnerPid() {
  // npm lifecycle scripts run through a short-lived command shell. Its parent is
  // the long-lived npm process shared by pre*, the main script, and post*.
  return getParentPid(process.ppid) ?? process.ppid;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLock() {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

async function removeLockIfUnchanged(expected) {
  const current = await readLock();
  if (!current || current.token !== expected?.token) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

async function acquire() {
  await mkdir(lockDir, { recursive: true });
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1000;
  const ownerPid = getLockOwnerPid();
  const token = `${ownerPid}-${startedAt}-${Math.random().toString(16).slice(2)}`;
  const payload = JSON.stringify({ pid: ownerPid, token, acquiredAt: new Date().toISOString() });

  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(payload, 'utf8');
      } finally {
        await handle.close();
      }
      process.stdout.write(`Acquired WebViewer test lock: ${lockPath}\n`);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const existing = await readLock();
    if (!existing || !isProcessAlive(Number(existing.pid))) {
      if (await removeLockIfUnchanged(existing)) {
        process.stderr.write(`Recovered stale WebViewer test lock: ${lockPath}\n`);
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutSeconds}s waiting for WebViewer test lock ${lockPath} ` +
          `(owner PID ${existing.pid}).`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

async function release() {
  const existing = await readLock();
  if (!existing) return;
  try {
    await unlink(lockPath);
    process.stdout.write(`Released WebViewer test lock: ${lockPath}\n`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

try {
  if (action === 'acquire') await acquire();
  else await release();
} catch (error) {
  process.stderr.write(`[test-lock] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
