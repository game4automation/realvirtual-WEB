// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Issue an RV-KEY-V1 customer certificate. The customer supplies only its raw
 * 32-byte public key; the customer private key never leaves their environment.
 */

import { createPrivateKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function privateKeyFromEnv() {
  const value = process.env.RV_SIGN_PRIVATE_KEY?.trim();
  if (!value) throw new Error('RV_SIGN_PRIVATE_KEY is required');
  const pem = value.includes('BEGIN PRIVATE KEY') ? value : Buffer.from(value, 'base64').toString('utf8');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('RV_SIGN_PRIVATE_KEY must be Ed25519');
  return key;
}

function customerKeyMessage(publicKey, organization) {
  const prefix = Buffer.from('RV-KEY-V1', 'ascii');
  const org = Buffer.from(organization.normalize('NFC'), 'utf8');
  const out = Buffer.alloc(prefix.length + publicKey.length + 4 + org.length);
  prefix.copy(out, 0);
  publicKey.copy(out, prefix.length);
  out.writeUInt32LE(org.length, prefix.length + publicKey.length);
  org.copy(out, prefix.length + publicKey.length + 4);
  return out;
}

try {
  const pubText = arg('pub');
  const org = arg('org')?.normalize('NFC');
  const output = arg('out');
  if (!pubText || !org) {
    throw new Error('Usage: node scripts/rv-issue-customer-key.mjs --pub <base64> --org <name> [--out cert.json]');
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(pubText)) throw new Error('--pub must be a padded 32-byte standard-Base64 key');
  const pub = Buffer.from(pubText, 'base64');
  if (pub.length !== 32 || pub.toString('base64') !== pubText) throw new Error('--pub is not canonical Base64');
  const cert = {
    pub: pubText,
    org,
    sig: sign(null, customerKeyMessage(pub, org), privateKeyFromEnv()).toString('base64'),
  };
  const json = `${JSON.stringify(cert, null, 2)}\n`;
  if (output) writeFileSync(output, json, { flag: 'wx' });
  else process.stdout.write(json);
} catch (error) {
  console.error(`[rv-issue-customer-key] ${error?.message ?? error}`);
  process.exitCode = 1;
}

