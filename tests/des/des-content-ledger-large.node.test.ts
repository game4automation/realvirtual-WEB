// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, expect, it } from 'vitest';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Sha256, sha256Hex } from '../../src/core/engine/rv-sha256';
import {
  clearModelContentLedger, documentHashOf, recordDocumentBytes,
  recordDocumentStream, whenDocumentHashesSettled,
} from '../../src/core/engine/rv-model-content-ledger';

const MiB = 1024 * 1024;
afterEach(clearModelContentLedger);

it('incremental SHA-256 matches node:crypto across padding and chunk boundaries', () => {
  const sizes = [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129,
    4095, 4096, 4097, 8 * MiB - 1, 8 * MiB, 8 * MiB + 1, 16 * MiB + 1, ...Array.from({ length: 12 }, () => randomInt(256 * 1024))];
  for (const size of sizes) {
    const bytes = randomBytes(size);
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(sha256Hex(bytes)).toBe(expected);
    const hash = new Sha256();
    let off = 0;
    // Uneven updates exercise partial-block carry as well as full blocks.
    while (off < size) {
      const end = Math.min(size, off + (off % 131071) + 1);
      hash.update(bytes.subarray(off, end));
      off = end;
    }
    hash.update(new Uint8Array(0));
    expect(hash.digestHex()).toBe(expected);
    expect(hash.digestHex()).toBe(expected);
    expect(() => hash.update(bytes)).toThrow(/finalized/);
  }
}, 60_000);

it('streams 600 MiB with bounded extra array-buffer memory', async () => {
  const baseline = process.memoryUsage().arrayBuffers;
  let peak = baseline;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); };
  // Reuse one pattern buffer. Never construct the 600 MiB document in memory.
  const pattern = new Uint8Array(16 * MiB);
  for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 31 + (i >>> 8)) & 255;
  function* chunks() {
    for (let remaining = 600 * MiB; remaining > 0; remaining -= pattern.length) {
      sample();
      yield pattern.subarray(0, Math.min(pattern.length, remaining));
    }
  }
  const reference = createHash('sha256');
  for (const chunk of chunks()) reference.update(chunk);
  const expected = reference.digest('hex');
  const monitor = setInterval(sample, 1);
  try {
    const done = recordDocumentStream('large', chunks());
    expect(documentHashOf('large')).toEqual({ state: 'pending' });
    await whenDocumentHashesSettled();
    await done;
    expect(documentHashOf('large')).toEqual({ state: 'ready', sha256: expected });
    sample();
    expect(peak - baseline).toBeLessThan(128 * MiB);
  } finally {
    clearInterval(monitor);
  }
}, 180_000);

it('yields while hashing bytes and completes before the loader transfers the buffer', async () => {
  const bytes = randomBytes(8 * MiB + 65);
  const expected = createHash('sha256').update(bytes).digest('hex');
  const input = new Uint8Array(bytes.length);
  input.set(bytes);
  const buffer = input.buffer;
  let hostRan = false;
  setTimeout(() => { hostRan = true; }, 0);
  const done = recordDocumentBytes('transfer', buffer);
  expect(documentHashOf('transfer')).toEqual({ state: 'pending' });
  // Same ordering as both production loaders: hash, await, then transfer.
  await done;
  structuredClone(buffer, { transfer: [buffer] });
  expect(buffer.byteLength).toBe(0);
  expect(hostRan).toBe(true);
  expect(documentHashOf('transfer')).toEqual({ state: 'ready', sha256: expected });
});

it('uses view offsets and publishes stream errors as unavailable', async () => {
  const bytes = randomBytes(200);
  await recordDocumentBytes('view', new DataView(bytes.buffer, bytes.byteOffset + 7, 130));
  expect(documentHashOf('view')).toEqual({ state: 'ready',
    sha256: createHash('sha256').update(bytes.subarray(7, 137)).digest('hex') });
  async function* failing() { yield bytes; throw new Error('read failed'); }
  await recordDocumentStream('broken', failing());
  expect(documentHashOf('broken')).toEqual({ state: 'unavailable', reason: 'digest failed: Error: read failed' });
});

it('does not publish an abandoned or superseded stream', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  async function* old() { await gate; yield new Uint8Array([1]); }
  let current = true;
  const abandoned = recordDocumentStream('abandoned', old(), { isCurrent: () => current });
  const superseded = recordDocumentStream('replaced', old());
  current = false;
  await recordDocumentBytes('replaced', new Uint8Array([2]));
  release();
  await Promise.all([abandoned, superseded, whenDocumentHashesSettled()]);
  expect(documentHashOf('abandoned').state).toBe('unavailable');
  expect(documentHashOf('replaced')).toEqual({ state: 'ready',
    sha256: createHash('sha256').update(new Uint8Array([2])).digest('hex') });
});
