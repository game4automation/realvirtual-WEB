// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-2059 (Thomas, 2026-11-01): a GLB that differs only in the DESManager run fields
// (EndTime / StatisticsResetTime / MasterSeed) is the same model; any other change is not.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearModelContentLedger, documentHashOf, recordDocumentBytes, recordDocumentStream, whenDocumentHashesSettled,
} from '../../src/core/engine/rv-model-content-ledger';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { compareFullSnapshots } from '../helpers/des-continuation-harness';
import { lineFixture } from './runner-fixture';

afterEach(() => { clearModelContentLedger(); });

function glb(json: object | string, bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), jsonPad = 0): Uint8Array {
  let text = (typeof json === 'string' ? json : JSON.stringify(json)) + ' '.repeat(jsonPad);
  while (new TextEncoder().encode(text).length % 4) text += ' ';
  const j = new TextEncoder().encode(text);
  const out = new Uint8Array(12 + 8 + j.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(j, 20);
  dv.setUint32(20 + j.length, bin.length, true); dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}
const doc = (manager: Record<string, number>, speed = 500) => ({
  asset: { version: '2.0' },
  nodes: [
    { name: 'Simulation', extras: { realvirtual: { DESManager: manager } } },
    { name: 'Conveyor', extras: { realvirtual: { Conveyor: { Speed: speed } } } },
  ],
});
const RUN = { EndTime: 100, StatisticsResetTime: 20, MasterSeed: 7 };

async function hashOfBytes(key: string, bytes: Uint8Array): Promise<string> {
  await recordDocumentBytes(key, bytes);
  const h = documentHashOf(key);
  if (h.state !== 'ready') throw new Error('not ready');
  return h.sha256;
}
async function hashOfStream(key: string, bytes: Uint8Array, piece: number): Promise<string> {
  const chunks = (function* () { for (let o = 0; o < bytes.length; o += piece) yield bytes.slice(o, o + piece); })();
  await recordDocumentStream(key, chunks);
  const h = documentHashOf(key);
  if (h.state !== 'ready') throw new Error('not ready');
  return h.sha256;
}

describe('document hash ignores the DESManager run fields', () => {
  it('other EndTime / warm-up / seed (and JSON padding) -> same hash; bytes and stream agree', async () => {
    const a = glb(doc(RUN));
    const b = glb(doc({ EndTime: 900, StatisticsResetTime: 0, MasterSeed: 99 }), undefined, 40);
    const c = glb(doc({}));
    const ha = await hashOfBytes('a', a);
    expect(await hashOfBytes('b', b)).toBe(ha);
    expect(await hashOfBytes('c', c)).toBe(ha);
    for (const piece of [1, 7, 64, 100000]) {
      expect(await hashOfStream('sa', a, piece)).toBe(ha);
      expect(await hashOfStream('sb', b, piece)).toBe(ha);
    }
  });

  it('any other change still changes the hash: another node field, another DESManager field, the binary part', async () => {
    const base = await hashOfBytes('a', glb(doc(RUN)));
    expect(await hashOfBytes('b', glb(doc(RUN, 501)))).not.toBe(base);
    expect(await hashOfBytes('c', glb(doc({ ...RUN, Other: 1 })))).not.toBe(base);
    expect(await hashOfBytes('d', glb(doc(RUN), new Uint8Array([9, 2, 3, 4, 5, 6, 7, 8])))).not.toBe(base);
  });

  it('a file without DESManager keeps the plain byte hash (bytes and stream)', async () => {
    const plain = glb({ asset: { version: '2.0' }, nodes: [{ name: 'x', extras: { realvirtual: { Conveyor: {} } } }] });
    const expected = createHash('sha256').update(plain).digest('hex');
    expect(await hashOfBytes('p', plain)).toBe(expected);
    expect(await hashOfStream('ps', plain, 13)).toBe(expected);
    const raw = new Uint8Array([5, 4, 3]);
    expect(await hashOfBytes('r', raw)).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(await hashOfStream('rs', raw, 1)).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('cost: a large binary part is hashed like before, only the JSON chunk is parsed', async () => {
    const bin = new Uint8Array(200 * 1024 * 1024);
    for (let i = 0; i < bin.length; i += 4099) bin[i] = i & 255;
    const withManager = glb(doc(RUN), bin), without = glb({ asset: { version: '2.0' }, nodes: [] }, bin);
    const t0 = performance.now();
    await hashOfBytes('plain', without);
    const tPlain = performance.now() - t0;
    const t1 = performance.now();
    await hashOfBytes('norm', withManager);
    const tNorm = performance.now() - t1;
    console.info(`LEDGER_COST plain=${tPlain.toFixed(0)}ms normalized=${tNorm.toFixed(0)}ms size=${(withManager.length / 1048576).toFixed(0)}MiB`);
    expect(tNorm).toBeLessThan(tPlain * 1.5 + 200);
  }, 60000);
});

describe('detection and header review fixes', () => {
  it('a node merely NAMED DESManager is no component: plain byte hash', async () => {
    const plain = glb({ asset: { version: '2.0' }, nodes: [{ name: 'DESManager' }] });
    expect(await hashOfBytes('n', plain)).toBe(createHash('sha256').update(plain).digest('hex'));
    expect(await hashOfStream('ns', plain, 9)).toBe(createHash('sha256').update(plain).digest('hex'));
  });
  it('an escaped component key is still detected', async () => {
    const text = JSON.stringify(doc(RUN)).replace('"DESManager"', '"DES\u004danager"');
    const a = glb(text), b = glb(doc({ EndTime: 5, StatisticsResetTime: 1, MasterSeed: 2 }));
    expect(await hashOfBytes('a', a)).toBe(await hashOfBytes('b', b));
    expect(await hashOfStream('sa', a, 5)).toBe(await hashOfBytes('a2', a));
  });
  it('a header that promises another length hashes differently', async () => {
    const a = glb(doc(RUN)), b = glb(doc(RUN));
    new DataView(b.buffer).setUint32(8, b.length + 64, true);
    expect(await hashOfBytes('a', a)).not.toBe(await hashOfBytes('b', b));
    expect(await hashOfStream('sb', b, 11)).toBe(await hashOfBytes('b2', b));
  });
  it('a truncated stream or file never throws and agrees between paths', async () => {
    const a = glb(doc(RUN));
    for (const cut of [3, 19, 20, 40, a.length - 3]) {
      const t = a.slice(0, cut);
      expect(await hashOfStream('s' + cut, t, 6)).toBe(await hashOfBytes('b' + cut, t));
    }
  });
});

describe('transfer after recording', () => {
  it('transferring the buffer right after recording does not change the normalized hash', async () => {
    const a = glb(doc(RUN));
    const expected = await hashOfBytes('ref', a.slice());
    const copy = a.slice();
    const done = recordDocumentBytes('t', copy.buffer);
    structuredClone(copy.buffer, { transfer: [copy.buffer] });
    await done;
    const h = documentHashOf('t');
    expect(h.state === 'ready' && h.sha256).toBe(expected);
  });
});

describe('save, reload, restore', () => {
  const manager = (EndTime: number) => ({ EndTime, StatisticsResetTime: 20, MasterSeed: 7 });
  async function world(endTime: number, speed = 500, key = `doc-${endTime}-${speed}`) {
    await hashOfBytes(key, glb(doc(manager(endTime), speed)));
    resetDESMUCounter();
    const f = lineFixture({ statResetTime: 20, mainDocumentKey: key, desManager: manager(endTime) });
    f.manager.duration = endTime;
    return f;
  }
  it('GLB saved with another EndTime and reloaded: restore succeeds and continues bit-exact', async () => {
    const a = await world(100);
    a.runUntil(30);
    const saved = JSON.parse(JSON.stringify(a.snapshot()));
    const b = await world(500);
    b.restore(saved);
    b.runUntil(120);
    const ref = await world(500, 500, 'ref'); ref.runUntil(30); ref.runUntil(120);
    compareFullSnapshots(ref.snapshot(), b.snapshot());
  });
  it('another real model change in the same save is still rejected', async () => {
    const a = await world(100);
    a.runUntil(30);
    const saved = JSON.parse(JSON.stringify(a.snapshot()));
    const b = await world(500, 501);
    expect(() => b.restore(saved)).toThrow(/fingerprint|Modell|model/i);
  });
});

void whenDocumentHashesSettled;
