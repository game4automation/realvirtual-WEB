// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-637 — wire format v1 of the USD live link: session field, byte
 * lengths, and the golden bytes shared with the Python extension
 * (`integrations/omniverse-kit/tests/golden_v1.json`, test_protocol.py).
 */

import { describe, it, expect } from 'vitest';
import golden from '../integrations/omniverse-kit/tests/golden_v1.json';
import {
  FRAME_ENTRY_BYTES,
  FrameWriter,
  LIVESYNC_MSG,
  decodeMessage,
  encodeHello,
  encodeMountBegin,
  encodeMountChunk,
  encodeMuDelete,
  encodeMuSpawn,
  encodeReset,
  parseAck,
  type MountMeta,
} from '../src/plugins/usd-live-link/livesync-protocol';
import { MIN_EXTENSION_VERSION, checkExtension, compareVersions } from '../src/plugins/usd-live-link/livesync-extension';

type GoldenCase = { name: string; input: Record<string, unknown>; hex: string };
const cases = new Map<string, GoldenCase>((golden.cases as GoldenCase[]).map((c) => [c.name, c]));

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function input<T>(name: string): T {
  return cases.get(name)!.input as T;
}

describe('usd-live-link protocol v1', () => {
  it('mountBegin matches the golden bytes', () => {
    const i = input<{ session: number; compressedBytes: number; rawBytes: number; chunkCount: number; meta: MountMeta }>('mountBegin');
    const bytes = encodeMountBegin(i.session, i.compressedBytes, i.rawBytes, i.chunkCount, i.meta);
    expect(hex(bytes)).toBe(cases.get('mountBegin')!.hex);
    expect(bytes[0]).toBe(LIVESYNC_MSG.MOUNT_BEGIN);
  });

  it('frame / muSpawn / muDelete / reset / mountChunk match the golden bytes', () => {
    const f = input<{ session: number; seq: number; nodes: Array<{ index: number; m: number[] }>; mus: Array<{ muId: number; m: number[] }> }>('frame');
    const w = new FrameWriter(1);
    w.begin(f.session, f.seq);
    for (const n of f.nodes) w.writeNode(n.index, n.m);
    for (const m of f.mus) w.writeMu(m.muId, m.m);
    expect(hex(w.finish())).toBe(cases.get('frame')!.hex);

    const e = input<{ session: number; seq: number; nodes: Array<{ index: number; m: number[] }> }>('frameEmptyMus');
    w.begin(e.session, e.seq);
    for (const n of e.nodes) w.writeNode(n.index, n.m);
    expect(hex(w.finish())).toBe(cases.get('frameEmptyMus')!.hex);

    const s = input<{ session: number; muId: number; templateIndex: number; m: number[] }>('muSpawn');
    expect(hex(encodeMuSpawn(s.session, s.muId, s.templateIndex, s.m))).toBe(cases.get('muSpawn')!.hex);
    const d = input<{ session: number; muId: number }>('muDelete');
    expect(hex(encodeMuDelete(d.session, d.muId))).toBe(cases.get('muDelete')!.hex);
    expect(hex(encodeReset(input<{ session: number }>('reset').session))).toBe(cases.get('reset')!.hex);
    const c = input<{ session: number; index: number; payloadHex: string }>('mountChunk');
    expect(hex(encodeMountChunk(c.session, c.index, fromHex(c.payloadHex)))).toBe(cases.get('mountChunk')!.hex);
  });

  it('every binary message carries type + u32 session (little endian) and the documented length', () => {
    const m16 = new Array(16).fill(0);
    const session = 0x01020304;
    const msgs: Array<[Uint8Array, number]> = [
      [encodeMuSpawn(session, 1, 2, m16), 5 + 8 + 64],
      [encodeMuDelete(session, 1), 5 + 4],
      [encodeReset(session), 5],
      [encodeMountChunk(session, 0, new Uint8Array(10)), 5 + 4 + 10],
    ];
    for (const [bytes, len] of msgs) {
      expect(bytes.byteLength).toBe(len);
      expect(Array.from(bytes.subarray(1, 5))).toEqual([4, 3, 2, 1]);
    }
    const w = new FrameWriter(1);
    w.begin(session, 9);
    w.writeNode(3, m16);
    w.writeNode(4, m16);
    w.writeMu(5, m16);
    const frame = w.finish();
    expect(frame.byteLength).toBe(13 + 2 * FRAME_ENTRY_BYTES + 4 + FRAME_ENTRY_BYTES);
    const decoded = decodeMessage(frame);
    expect(decoded).toMatchObject({ type: 'frame', session, seq: 9 });
    if (decoded.type !== 'frame') throw new Error('unreachable');
    expect(decoded.nodes.map((n) => n.index)).toEqual([3, 4]);
    expect(decoded.mus.map((m) => m.muId)).toEqual([5]);
  });

  it('decodes every golden case back to its input', () => {
    for (const c of cases.values()) {
      const d = decodeMessage(fromHex(c.hex));
      expect(d.session).toBe(c.input.session);
    }
  });

  it('FrameWriter refuses nodes after MUs and grows its buffer', () => {
    const w = new FrameWriter(1);
    w.begin(1, 0);
    for (let i = 0; i < 50; i++) w.writeNode(i, new Array(16).fill(i));
    w.writeMu(1, new Array(16).fill(0));
    expect(() => w.writeNode(99, new Array(16).fill(0))).toThrow();
    const d = decodeMessage(w.finish());
    if (d.type !== 'frame') throw new Error('unreachable');
    expect(d.nodes).toHaveLength(50);
    expect(d.nodes[49].m[0]).toBe(49);
  });

  it('hello is JSON with version and token; acks parse, junk does not', () => {
    expect(JSON.parse(encodeHello('tok', 30))).toEqual({ v: 1, token: 'tok', client: 'realvirtual-web', rateHz: 30 });
    expect(parseAck('{"type":"mounted","session":3}')).toEqual({ type: 'mounted', session: 3 });
    expect(parseAck('{"type":"error","message":"x"}')).toEqual({ type: 'error', message: 'x' });
    expect(parseAck('{"type":"other"}')).toBeNull();
    expect(parseAck('nope')).toBeNull();
  });
});

describe('livesync version handshake (plan-637 Phase 6)', () => {
  const download = { version: '0.2.0', url: './downloads/realvirtual-livesync-0.2.0.zip' };

  it('the golden ready ack parses with extVersion and protocol', () => {
    const ack = parseAck(golden.readyAck.text);
    expect(ack).toEqual({ type: 'ready', extVersion: '0.2.0', protocol: 1 });
    expect(checkExtension(ack!, download)).toEqual({ kind: 'ok', version: '0.2.0' });
  });

  it('compares versions numerically, suffixes ignored, unparsable lowest', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('v1.0.0-beta', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.9', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('junk', '0.0.1')).toBeLessThan(0);
    expect(compareVersions('junk', 'junk')).toBe(0);
  });

  it('an old extension (no extVersion / lower) is outdated but keeps syncing; newer is ok', () => {
    expect(checkExtension({ type: 'ready' }, download)).toEqual({
      kind: 'outdated', version: null,
      notice: 'Isaac Sim extension outdated (version unknown) — download v0.2.0',
    });
    expect(checkExtension({ type: 'ready', extVersion: '0.1.0', protocol: 1 }, download)).toEqual({
      kind: 'outdated', version: '0.1.0',
      notice: 'Isaac Sim extension outdated (v0.1.0) — download v0.2.0',
    });
    expect(checkExtension({ type: 'ready', extVersion: '0.3.1', protocol: 1 }, download).kind).toBe('ok');
    // Without a download in the build the hint names the minimum.
    expect(checkExtension({ type: 'ready', extVersion: '0.1.0' }, null)).toMatchObject({
      notice: `Isaac Sim extension outdated (v0.1.0) — download v${MIN_EXTENSION_VERSION}`,
    });
  });

  it('another protocol is incompatible, whatever the version', () => {
    const r = checkExtension({ type: 'ready', extVersion: '9.0.0', protocol: 2 }, download);
    expect(r.kind).toBe('incompatible');
    expect(r.kind === 'incompatible' && r.message).toContain('protocol 2');
  });
});
