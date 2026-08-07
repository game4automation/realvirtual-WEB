// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  loadSigningConfig,
  signGlbBytes,
  verifyGlbBytes,
} from '../scripts/rv-sign-glb.mjs';
import { selectFilesToUpload, stagePrivateProject } from '../scripts/_bunny-lib.mjs';
// @ts-expect-error Node deploy modules intentionally have no declaration files.
import { decryptGlb, generateFragmentSecret } from '../scripts/lib/rv-crypto.mjs';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'rv-sig-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  return Buffer.from(jwk.x!, 'base64url');
}

function privateKeyEnv(key: KeyObject): string {
  return Buffer.from(key.export({ format: 'pem', type: 'pkcs8' }) as string).toString('base64');
}

function customerMessage(publicKey: Buffer, organization: string): Buffer {
  const prefix = Buffer.from('RV-KEY-V1', 'ascii');
  const org = Buffer.from(organization.normalize('NFC'), 'utf8');
  const message = Buffer.alloc(prefix.length + publicKey.length + 4 + org.length);
  prefix.copy(message);
  publicKey.copy(message, prefix.length);
  message.writeUInt32LE(org.length, prefix.length + publicKey.length);
  org.copy(message, prefix.length + publicKey.length + 4);
  return message;
}

function makeGlb(): Buffer {
  return makeGlbFromJson(JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
  }));
}

function makeGlbFromJson(jsonText: string): Buffer {
  const json = Buffer.from(jsonText, 'utf8');
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

function makeCertificate(rootPrivate: KeyObject, customerPublic: KeyObject, organization: string) {
  const pub = rawPublicKey(customerPublic);
  return {
    pub: pub.toString('base64'),
    org: organization,
    sig: sign(null, customerMessage(pub, organization), rootPrivate).toString('base64'),
  };
}

describe('rv_sig Node signer', () => {
  it('signs and verifies root mode idempotently with fixed-width replacement', () => {
    const root = generateKeyPairSync('ed25519');
    const signing = loadSigningConfig(
      { RV_SIGN_PRIVATE_KEY: privateKeyEnv(root.privateKey) },
      rawPublicKey(root.publicKey),
    );
    if (!signing) throw new Error('test signing configuration was not created');
    const once = signGlbBytes(makeGlb(), signing);
    const twice = signGlbBytes(once, signing);
    expect(twice.length).toBe(once.length);
    expect(twice.equals(once)).toBe(true);
    expect(verifyGlbBytes(once, rawPublicKey(root.publicKey))).toBe('valid');

    const tampered = Buffer.from(once);
    tampered[tampered.length - 1] ^= 1;
    expect(verifyGlbBytes(tampered, rawPublicKey(root.publicKey))).toBe('invalid');
  });

  it('canonicalizes an existing non-compact rv_sig field before signing', () => {
    const root = generateKeyPairSync('ed25519');
    const signing = loadSigningConfig(
      { RV_SIGN_PRIVATE_KEY: privateKeyEnv(root.privateKey) },
      rawPublicKey(root.publicKey),
    );
    if (!signing) throw new Error('test signing configuration was not created');
    const nonCanonical = makeGlbFromJson(JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [], extras: { rv_sig: 'A'.repeat(86) + '==' } }],
      nodes: [],
    }).replace('"rv_sig":', '"rv_sig" : '));
    const signed = signGlbBytes(nonCanonical, signing);
    expect(verifyGlbBytes(signed, rawPublicKey(root.publicKey))).toBe('valid');
    expect(signGlbBytes(signed, signing).equals(signed)).toBe(true);
  });

  it('validates customer certificates and hard-fails a cert/private-key mismatch', () => {
    const root = generateKeyPairSync('ed25519');
    const customer = generateKeyPairSync('ed25519');
    const otherCustomer = generateKeyPairSync('ed25519');
    const certPath = join(work, 'customer-cert.json');
    writeFileSync(certPath, JSON.stringify(makeCertificate(root.privateKey, customer.publicKey, 'ACME GmbH')));

    const signing = loadSigningConfig({
      RV_SIGN_PRIVATE_KEY: privateKeyEnv(customer.privateKey),
      RV_SIGN_CUSTOMER_CERT: certPath,
    }, rawPublicKey(root.publicKey));
    if (!signing) throw new Error('test customer signing configuration was not created');
    const signed = signGlbBytes(makeGlb(), signing);
    expect(verifyGlbBytes(signed, rawPublicKey(root.publicKey))).toBe('valid');

    expect(() => loadSigningConfig({
      RV_SIGN_PRIVATE_KEY: privateKeyEnv(otherCustomer.privateKey),
      RV_SIGN_CUSTOMER_CERT: certPath,
    }, rawPublicKey(root.publicKey))).toThrow(/does not match/i);
  });

  it('issues an RV-KEY-V1 customer certificate without handling the customer private key', () => {
    const root = generateKeyPairSync('ed25519');
    const customer = generateKeyPairSync('ed25519');
    const certPath = join(work, 'issued.json');
    const run = spawnSync(process.execPath, [
      join(process.cwd(), 'scripts', 'rv-issue-customer-key.mjs'),
      '--pub',
      rawPublicKey(customer.publicKey).toString('base64'),
      '--org',
      'Customer AG',
      '--out',
      certPath,
    ], {
      env: { ...process.env, RV_SIGN_PRIVATE_KEY: privateKeyEnv(root.privateKey) },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    const signing = loadSigningConfig({
      RV_SIGN_PRIVATE_KEY: privateKeyEnv(customer.privateKey),
      RV_SIGN_CUSTOMER_CERT: certPath,
    }, rawPublicKey(root.publicKey));
    if (!signing) throw new Error('issued certificate was not accepted');
    expect(signing.customerCert?.org).toBe('Customer AG');
  });
});

describe('rv_sig deploy integration', () => {
  it('stages private GLBs as signed plaintext before encryption', async () => {
    const root = generateKeyPairSync('ed25519');
    const signing = loadSigningConfig(
      { RV_SIGN_PRIVATE_KEY: privateKeyEnv(root.privateKey) },
      rawPublicKey(root.publicKey),
    );
    if (!signing) throw new Error('test signing configuration was not created');
    const distDir = join(work, 'dist');
    const projectDir = join(work, 'projects', 'customer');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(join(projectDir, 'models'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<html></html>');
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
      name: 'Customer',
      code: 'customer',
      settings: { defaultModel: 'machine.glb' },
    }));
    writeFileSync(join(projectDir, 'models', 'machine.glb'), makeGlb());

    const fragmentSecret = generateFragmentSecret();
    const staging = await stagePrivateProject({
      distDir,
      projectDir,
      signing,
      encryption: {
        password: 'secret',
        fragmentSecret,
        iterations: 1000,
      },
    });
    try {
      const encrypted = readFileSync(join(staging, 'models', 'machine.glb'));
      const plaintext = Buffer.from(await decryptGlb(encrypted, 'secret', fragmentSecret));
      expect(verifyGlbBytes(plaintext, rawPublicKey(root.publicKey))).toBe('valid');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('always selects signed GLBs even when local and remote sizes match', () => {
    const local = [
      { rel: 'models/machine.glb', abs: 'machine.glb', size: 1234 },
      { rel: 'assets/app.js', abs: 'app.js', size: 42 },
    ];
    const remote = new Map([
      ['models/machine.glb', 1234],
      ['assets/app.js', 42],
    ]);
    expect(selectFilesToUpload(local, remote, { alwaysUploadGlbs: true }).map((file: { rel: string }) => file.rel))
      .toEqual(['models/machine.glb']);
  });

  it('keeps private-key environment names out of browser source configuration', () => {
    const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const sourceConfig = readFileSync(join(process.cwd(), 'src', 'vite-env.d.ts'), 'utf8');
    expect(packageJson).not.toContain('VITE_RV_SIGN_PRIVATE_KEY');
    expect(sourceConfig).not.toContain('RV_SIGN_PRIVATE_KEY');
  });
});
