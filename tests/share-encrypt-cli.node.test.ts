// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-560 §9.5 — `npm run share:encrypt`: round trip, chunking, output
 * contract, secrets, size gate and the fileshare upload contract. No test
 * touches the network: the upload runs against an injected fake fetch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_EXPIRY_DAYS,
  ENVELOPE_CHUNK_OVERHEAD,
  ENVELOPE_HEADER_BYTES,
  MOBILE_WARN_BYTES,
  SHARE_BYTE_BUDGET,
  buildEncryptedShareLink,
  checkShareSize,
  envelopeSize,
  fileUrlOf,
  parseArgs,
  runShareEncrypt,
} from '../scripts/share-encrypt.mjs';
// @ts-expect-error Node deploy modules intentionally have no declaration files.
import { decryptGlb, parseEnvelopeHeader, base64UrlToBytes, DEFAULT_CHUNK_SIZE } from '../scripts/lib/rv-crypto.mjs';

const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'scripts', 'share-encrypt.mjs');
const PASSWORD = 'unit-test-share-password';

let work: string;

beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-share-enc-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function glb(len: number): Buffer {
  const b = Buffer.alloc(len, 0x5a);
  b.write('glTF', 0, 'latin1');
  return b;
}

async function run(argv: string[], env: Record<string, string | undefined>, fetchImpl?: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runShareEncrypt(argv, {
    env, stdout: (l) => out.push(l), stderr: (l) => err.push(l),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { code, out, err };
}

const lineValue = (lines: string[], tag: string) =>
  lines.find((l) => l.startsWith(`${tag} `))?.slice(tag.length + 1);

describe('share:encrypt CLI (plan-560)', () => {
  it('offline round trip through the real entry point: FRAGMENT/FILE, chunked RVE1, byte-identical', async () => {
    const input = join(work, 'big.glb');
    const plain = glb(DEFAULT_CHUNK_SIZE + 1000); // > 16 MiB → at least 2 chunks
    writeFileSync(input, plain);

    const r = spawnSync(process.execPath, [CLI, input], {
      encoding: 'utf8', env: { ...process.env, RV_SHARE_PASSWORD: PASSWORD },
    });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout.trim().split(/\r?\n/);
    expect(out.some((l) => l.startsWith('LINK '))).toBe(false);
    const fragment = lineValue(out, 'FRAGMENT')!;
    const file = lineValue(out, 'FILE')!;
    expect(file).toBe(join(work, 'big.rve.glb'));
    expect(r.stderr).toContain(`PASSWORD (send via a separate channel): ${PASSWORD}`);
    expect(r.stdout).not.toContain(PASSWORD);

    const envelope = readFileSync(file);
    expect(envelope.subarray(0, 4).toString('latin1')).toBe('RVE1');
    const header = await parseEnvelopeHeader(envelope);
    expect(header.chunkCount).toBeGreaterThan(1);
    expect(header.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(envelope.length).toBe(envelopeSize(plain.length));
    const back = await decryptGlb(envelope, PASSWORD, base64UrlToBytes(fragment));
    expect(Buffer.from(back).equals(plain)).toBe(true);
  });

  it('two-step: --link-only reuses the fragment, prints no PASSWORD and leaves the file alone', async () => {
    const input = join(work, 'm.glb');
    writeFileSync(input, glb(4096));
    const first = await run([input], { RV_SHARE_PASSWORD: PASSWORD });
    expect(first.code).toBe(0);
    const fragment = lineValue(first.out, 'FRAGMENT')!;
    const file = lineValue(first.out, 'FILE')!;
    const before = readFileSync(file);

    const second = await run(['--link-only', '--file-url', 'https://x/y.rve.glb'], { RV_SHARE_FRAGMENT: fragment });
    expect(second.code).toBe(0);
    expect(second.out).toEqual([
      `LINK https://web.realvirtual.io/demo/?glb=${encodeURIComponent('https://x/y.rve.glb')}#k=${fragment}`,
    ]);
    expect(second.err.some((l) => l.startsWith('PASSWORD'))).toBe(false);
    expect(readFileSync(file).equals(before)).toBe(true);
    const back = await decryptGlb(before, PASSWORD, base64UrlToBytes(fragment));
    expect(Buffer.from(back).equals(glb(4096))).toBe(true);

    const missing = await run(['--link-only', '--file-url', 'https://x/y.rve.glb'], {});
    expect(missing.code).toBe(1);
    expect(missing.out).toEqual([]);
  });

  it('--file-url prints exactly one LINK line on stdout', async () => {
    const input = join(work, 'm.glb');
    writeFileSync(input, glb(1024));
    const r = await run([input, '--file-url', 'https://host.example/m.rve.glb', '--base', 'https://web.realvirtual.io/dev/'], {
      RV_SHARE_PASSWORD: PASSWORD,
    });
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toMatch(/^LINK https:\/\/web\.realvirtual\.io\/dev\/\?glb=https%3A%2F%2Fhost\.example%2Fm\.rve\.glb#k=[A-Za-z0-9_-]{43}$/);
  });

  it('size gate: exactly the budget passes, one byte more fails; a large plaintext warns', () => {
    // Formula: 55-byte header + 33 bytes per chunk + plaintext.
    expect(envelopeSize(0)).toBe(ENVELOPE_HEADER_BYTES + ENVELOPE_CHUNK_OVERHEAD);
    expect(envelopeSize(DEFAULT_CHUNK_SIZE + 1)).toBe(55 + 33 * 2 + DEFAULT_CHUNK_SIZE + 1);
    expect(checkShareSize(SHARE_BYTE_BUDGET, 1000).error).toBeUndefined();
    expect(checkShareSize(SHARE_BYTE_BUDGET + 1, 1000).error).toMatch(/limit/);
    expect(checkShareSize(1000, MOBILE_WARN_BYTES + 1).warnings.join(' ')).toMatch(/large for mobile browsers/);
    expect(checkShareSize(1000, MOBILE_WARN_BYTES).warnings).toEqual([]);
  });

  it('the mirrored budget equals DEFAULT_SHARE_BYTE_BUDGET of rv-share-fetch.ts', () => {
    const src = readFileSync(join(ROOT, 'src/core/share/rv-share-fetch.ts'), 'utf8');
    const m = /export const DEFAULT_SHARE_BYTE_BUDGET = ([\d\s*_]+);/.exec(src);
    expect(m, 'constant not found').not.toBeNull();
    const value = m![1]!.split('*').map((p) => Number(p.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1);
    expect(value).toBe(SHARE_BYTE_BUDGET);
  });

  it('generates a password of >= 20 characters, on stderr only, never in the output file', async () => {
    const input = join(work, 'm.glb');
    writeFileSync(input, glb(2048));
    const r = await run([input], {});
    expect(r.code).toBe(0);
    const line = r.err.find((l) => l.startsWith('PASSWORD (send via a separate channel): '))!;
    const password = line.slice('PASSWORD (send via a separate channel): '.length);
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(r.out.join('\n')).not.toContain(password);
    const file = lineValue(r.out, 'FILE')!;
    expect(readFileSync(file).includes(Buffer.from(password))).toBe(false);
  });

  it('refuses an RV_SHARE_PASSWORD shorter than 12 characters', async () => {
    const input = join(work, 'm.glb');
    writeFileSync(input, glb(512));
    const r = await run([input], { RV_SHARE_PASSWORD: 'short-pw' });
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
  });

  it('upload: create-upload-url → PUT (no Bearer) → confirm-upload, expiry 30 by default, link on /file', async () => {
    const input = join(work, 'm.glb');
    writeFileSync(input, glb(3000));
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown; size?: number }> = [];
    const fakeFetch = (async (url: string, init: RequestInit & { duplex?: string }) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call = { url: String(url), method: String(init.method), headers, body: init.body as unknown, size: undefined as number | undefined };
      calls.push(call);
      if (call.url.endsWith('/create-upload-url')) {
        return new Response(JSON.stringify({ signedUrl: 'https://storage.example/upload?sig=1', token: 'tok123' }));
      }
      if (call.url.startsWith('https://storage.example/')) {
        expect(init.duplex).toBe('half');
        call.size = (await new Response(init.body as BodyInit).arrayBuffer()).byteLength;
        return new Response(null, { status: 200 });
      }
      if (call.url.endsWith('/confirm-upload')) {
        return new Response(JSON.stringify({ url: 'https://files.realvirtual.io/dl/tok123' }));
      }
      throw new Error(`unexpected ${call.url}`);
    }) as unknown as typeof fetch;

    const r = await run([input, '--upload'], { RV_SHARE_PASSWORD: PASSWORD, RV_FILESHARE_API_KEY: 'test-key' }, fakeFetch);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(calls.map((c) => c.url.split('?')[0]!.split('/').pop())).toEqual(['create-upload-url', 'upload', 'confirm-upload']);
    expect(calls[0]!.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ uploadType: 'share', expiryDays: DEFAULT_EXPIRY_DAYS, fileName: 'm.rve.glb' });
    expect(DEFAULT_EXPIRY_DAYS).toBe(30);
    expect(calls[1]!.method).toBe('PUT');
    expect(Object.keys(calls[1]!.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(calls[1]!.headers['Content-Length']).toBe(String(readFileSync(join(work, 'm.rve.glb')).length));
    expect(calls[1]!.size).toBe(readFileSync(join(work, 'm.rve.glb')).length);
    expect(JSON.parse(String(calls[2]!.body))).toEqual({ token: 'tok123', sendEmail: false });

    const link = lineValue(r.out, 'LINK')!;
    expect(link.startsWith(`https://web.realvirtual.io/demo/?glb=${encodeURIComponent('https://files.realvirtual.io/dl/tok123/file')}#k=`)).toBe(true);
    expect(r.out).toHaveLength(1);
  });

  it('upload: an HTTP error exits 1 and prints no link', async () => {
    const input = join(work, 'm.glb');
    writeFileSync(input, glb(512));
    const failing = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const r = await run([input, '--upload', '--expiry-days', '7'], { RV_SHARE_PASSWORD: PASSWORD, RV_FILESHARE_API_KEY: 'k' }, failing);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.join('\n')).toMatch(/HTTP 403/);
  });

  it('argument parsing and link helpers', () => {
    expect(parseArgs(['a.glb']).expiryDays).toBe(30);
    expect(parseArgs(['a.glb', '--expiry-days', '0']).expiryDays).toBe(0);
    expect(() => parseArgs(['a.glb', '--upload', '--file-url', 'https://x/y'])).toThrow();
    expect(() => parseArgs(['a.glb', '--file-url', 'ftp://x/y'])).toThrow();
    expect(() => parseArgs(['--link-only'])).toThrow();
    expect(() => parseArgs(['a.glb', '--password', 'x'])).toThrow(/unknown option/);
    expect(fileUrlOf('https://files.realvirtual.io/dl/t')).toBe('https://files.realvirtual.io/dl/t/file');
    expect(fileUrlOf('https://files.realvirtual.io/dl/t/file')).toBe('https://files.realvirtual.io/dl/t/file');
    expect(buildEncryptedShareLink('https://h/demo/?mode=viewer', 'https://f/x', 'AAA'))
      .toBe('https://h/demo/?mode=viewer&glb=https%3A%2F%2Ff%2Fx#k=AAA');
  });

  it('has no shebang: the file starts with the SPDX header', () => {
    expect(readFileSync(CLI, 'utf8').startsWith('// SPDX-License-Identifier: AGPL-3.0-only')).toBe(true);
  });

  it('is wired as the npm script share:encrypt', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['share:encrypt']).toBe('node scripts/share-encrypt.mjs');
  });
});
