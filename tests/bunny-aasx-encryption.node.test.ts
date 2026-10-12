// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-596 Phase 5 — project AASX in a password-protected hosted deploy.
 *
 *  - `aasx/*.aasx` and `aasx/index.json` are encrypted like the GLBs, and the
 *    envelope really DECRYPTS back to the original bytes (round trip, not just
 *    the RVE1 header);
 *  - signing stays on `.glb` (SOL #2): with signing + encryption the GLB is
 *    signed, the AASX / index are encrypted but never signed;
 *  - every encrypted file is uploaded on every publish, also at the identical
 *    size (fresh salt, SOL #1) — the p/-relative report paths reach the upload
 *    selection staging-relative, united with the catalog diff;
 *  - `aasx/index.json` is always uploaded, also unencrypted.
 *
 * Runner: `npm run test:node`. No network: the upload selection is the pure
 * `selectFilesToUpload` the deploy calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectLocalFiles,
  encryptablePathsBelow,
  hostedForcedUploadRels,
  isAlwaysUploadFile,
  isEncryptablePath,
  selectFilesToUpload,
  stageHostedProject,
  HOSTED_PROJECT_PREFIX,
} from '../scripts/_bunny-lib.mjs';
import { loadSigningConfig, verifyGlbBytes } from '../scripts/rv-sign-glb.mjs';
// @ts-expect-error Node deploy modules intentionally have no declaration files.
import { decryptGlb, generateFragmentSecret, isEncryptedEnvelope } from '../scripts/lib/rv-crypto.mjs';

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-aasx-deploy-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function makeGlb(): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [] }), 'utf8');
  const jsonLength = (json.length + 3) & ~3;
  const glb = Buffer.alloc(20 + jsonLength, 0x20);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);
  return glb;
}

/** A ZIP-looking AASX stand-in: the deploy never parses it, it only encrypts it. */
const AASX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fake-aasx-payload-'.repeat(50))]);
const INDEX_TEXT = JSON.stringify({ version: 1, generator: 'realvirtual-web', entries: { 'urn:a': { file: 'a.aasx', idShort: 'A' } }, files: {} });

function rawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');
}
function privateKeyEnv(key: KeyObject): string {
  return Buffer.from(key.export({ format: 'pem', type: 'pkcs8' }) as string).toString('base64');
}

function makeProject(): { distDir: string; projectDir: string } {
  const distDir = join(work, 'dist');
  const projectDir = join(work, 'projects', 'festo');
  mkdirSync(distDir, { recursive: true });
  mkdirSync(join(projectDir, 'models'), { recursive: true });
  mkdirSync(join(projectDir, 'aasx', 'old'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<html></html>');
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ name: 'Festo', code: 'festo-code' }));
  writeFileSync(join(projectDir, 'models', 'line.glb'), makeGlb());
  writeFileSync(join(projectDir, 'aasx', 'a.aasx'), AASX_BYTES);
  writeFileSync(join(projectDir, 'aasx', 'index.json'), INDEX_TEXT);
  // Not part of the flat aasx/ folder — stays as it is.
  writeFileSync(join(projectDir, 'aasx', 'old', 'nested.aasx'), AASX_BYTES);
  return { distDir, projectDir };
}

describe('encryptable paths', () => {
  it('are .glb at any depth plus aasx/*.aasx and aasx/index.json (flat)', () => {
    const { projectDir } = makeProject();
    expect(encryptablePathsBelow(projectDir)).toEqual(['aasx/a.aasx', 'aasx/index.json', 'models/line.glb']);
    expect(isEncryptablePath('aasx/old/nested.aasx')).toBe(false);
    expect(isEncryptablePath('docs/index.json')).toBe(false);
  });
});

describe('stageHostedProject with a password', () => {
  it('encrypts AASX and the index; the envelopes decrypt back to the original bytes', async () => {
    const { distDir, projectDir } = makeProject();
    const fragmentSecret = generateFragmentSecret();
    let encrypted: string[] = [];
    const staging = await stageHostedProject({
      distDir, projectDir,
      encryption: { password: 'festo-2027', fragmentSecret, iterations: 1000 },
      onReport: (r: { encrypted: string[] }) => { encrypted = r.encrypted; },
    });
    try {
      expect(encrypted).toEqual(['aasx/a.aasx', 'aasx/index.json', 'models/line.glb']);
      const p = (rel: string) => join(staging, HOSTED_PROJECT_PREFIX, ...rel.split('/'));
      const encAasx = readFileSync(p('aasx/a.aasx'));
      const encIndex = readFileSync(p('aasx/index.json'));
      expect(isEncryptedEnvelope(encAasx)).toBe(true);
      expect(encAasx.subarray(0, 4).toString('latin1')).toBe('RVE1');
      expect(isEncryptedEnvelope(encIndex)).toBe(true);
      expect(Buffer.from(await decryptGlb(encAasx, 'festo-2027', fragmentSecret)).equals(AASX_BYTES)).toBe(true);
      expect(Buffer.from(await decryptGlb(encIndex, 'festo-2027', fragmentSecret)).toString('utf8')).toBe(INDEX_TEXT);
      await expect(decryptGlb(encAasx, 'wrong', fragmentSecret)).rejects.toThrow();
      // The nested file is not a project AASX — copied verbatim, not encrypted.
      expect(readFileSync(p('aasx/old/nested.aasx')).equals(AASX_BYTES)).toBe(true);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('signs the GLB but never the AASX or the index (signing + encryption)', async () => {
    const root = generateKeyPairSync('ed25519');
    const signing = loadSigningConfig({ RV_SIGN_PRIVATE_KEY: privateKeyEnv(root.privateKey) }, rawPublicKey(root.publicKey));
    if (!signing) throw new Error('test signing configuration was not created');
    const { distDir, projectDir } = makeProject();
    const fragmentSecret = generateFragmentSecret();
    const staging = await stageHostedProject({
      distDir, projectDir, signing,
      encryption: { password: 'pw', fragmentSecret, iterations: 1000 },
    });
    try {
      const p = (rel: string) => join(staging, HOSTED_PROJECT_PREFIX, ...rel.split('/'));
      const glb = Buffer.from(await decryptGlb(readFileSync(p('models/line.glb')), 'pw', fragmentSecret));
      expect(verifyGlbBytes(glb, rawPublicKey(root.publicKey))).toBe('valid');
      expect(Buffer.from(await decryptGlb(readFileSync(p('aasx/a.aasx')), 'pw', fragmentSecret)).equals(AASX_BYTES)).toBe(true);
      expect(Buffer.from(await decryptGlb(readFileSync(p('aasx/index.json')), 'pw', fragmentSecret)).toString('utf8')).toBe(INDEX_TEXT);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('signing alone leaves AASX and index untouched', async () => {
    const root = generateKeyPairSync('ed25519');
    const signing = loadSigningConfig({ RV_SIGN_PRIVATE_KEY: privateKeyEnv(root.privateKey) }, rawPublicKey(root.publicKey));
    const { distDir, projectDir } = makeProject();
    const staging = await stageHostedProject({ distDir, projectDir, signing });
    try {
      const p = (rel: string) => join(staging, HOSTED_PROJECT_PREFIX, ...rel.split('/'));
      expect(readFileSync(p('aasx/a.aasx')).equals(AASX_BYTES)).toBe(true);
      expect(readFileSync(p('aasx/index.json'), 'utf8')).toBe(INDEX_TEXT);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

describe('upload selection', () => {
  it('re-uploads every encrypted file at identical size; report paths become staging-relative', async () => {
    const { distDir, projectDir } = makeProject();
    const fragmentSecret = generateFragmentSecret();
    let encrypted: string[] = [];
    const staging = await stageHostedProject({
      distDir, projectDir,
      encryption: { password: 'pw', fragmentSecret, iterations: 1000 },
      onReport: (r: { encrypted: string[] }) => { encrypted = r.encrypted; },
    });
    try {
      const forced = hostedForcedUploadRels(encrypted, ['library/catalog-changed.glb']);
      expect(forced).toEqual(['library/catalog-changed.glb', 'p/aasx/a.aasx', 'p/aasx/index.json', 'p/models/line.glb']);

      // The second publish: the remote holds files of EXACTLY the same size
      // (same plaintext, new salt) — the size diff alone would skip them.
      const local = collectLocalFiles(staging) as Array<{ rel: string; size: number }>;
      const remote = new Map(local.map((f) => [f.rel.toLowerCase(), f.size]));
      const withoutForce = selectFilesToUpload(local, remote, {}).map((f: { rel: string }) => f.rel);
      expect(withoutForce).not.toContain('p/aasx/a.aasx');
      const selected = selectFilesToUpload(local, remote, { alwaysUploadRel: forced }).map((f: { rel: string }) => f.rel);
      expect(selected).toEqual(expect.arrayContaining(['p/aasx/a.aasx', 'p/aasx/index.json', 'p/models/line.glb']));
      expect(statSync(join(staging, 'p', 'aasx', 'a.aasx')).size).toBe(remote.get('p/aasx/a.aasx'));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('accepts the Set catalogHashDiff returns, arrays and undefined (deploy:private regression)', () => {
    // bunny-deploy passes `await catalogHashDiff(...)` straight through — a Set.
    const diff = new Set(['library/catalog-changed.glb', 'library\\win.glb']);
    expect(hostedForcedUploadRels(['aasx/a.aasx', 'models/line.glb'], diff)).toEqual([
      'library/catalog-changed.glb', 'library/win.glb', 'p/aasx/a.aasx', 'p/models/line.glb',
    ]);
    expect(hostedForcedUploadRels(new Set(['aasx/a.aasx']), ['library/x.glb'])).toEqual(['library/x.glb', 'p/aasx/a.aasx']);
    expect(hostedForcedUploadRels(['aasx/a.aasx'], undefined)).toEqual(['p/aasx/a.aasx']);
    expect(hostedForcedUploadRels(undefined, new Set<string>())).toEqual([]);
    expect(hostedForcedUploadRels(null, null)).toEqual([]);
  });

  it('a password change re-uploads the AASX although its size is unchanged', async () => {
    const { distDir, projectDir } = makeProject();
    const fragmentSecret = generateFragmentSecret();
    const sizes: number[] = [];
    let encrypted: string[] = [];
    for (const password of ['old-pw', 'new-pw']) {
      const staging = await stageHostedProject({
        distDir, projectDir,
        encryption: { password, fragmentSecret, iterations: 1000 },
        onReport: (r: { encrypted: string[] }) => { encrypted = r.encrypted; },
      });
      try {
        sizes.push(statSync(join(staging, 'p', 'aasx', 'a.aasx')).size);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    expect(sizes[0]).toBe(sizes[1]);
    const local = [{ rel: 'p/aasx/a.aasx', size: sizes[1] }];
    const remote = new Map([['p/aasx/a.aasx', sizes[0]]]);
    expect(selectFilesToUpload(local, remote, { alwaysUploadRel: hostedForcedUploadRels(encrypted, []) })).toHaveLength(1);
  });

  it('aasx/index.json is always uploaded, also unencrypted; other index.json files keep the size diff', () => {
    expect(isAlwaysUploadFile('p/aasx/index.json')).toBe(true);
    expect(isAlwaysUploadFile('aasx/index.json')).toBe(true);
    expect(isAlwaysUploadFile('p/docs/index.json')).toBe(false);
    const local = [{ rel: 'p/aasx/index.json', size: 42 }, { rel: 'p/docs/index.json', size: 42 }];
    const remote = new Map([['p/aasx/index.json', 42], ['p/docs/index.json', 42]]);
    expect(selectFilesToUpload(local, remote, {}).map((f: { rel: string }) => f.rel)).toEqual(['p/aasx/index.json']);
  });
});
