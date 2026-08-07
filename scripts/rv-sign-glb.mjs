// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Sign finished GLB bytes with an Ed25519 key from RV_SIGN_PRIVATE_KEY.
 *
 * The signature covers the complete GLB with the compact rv_sig value replaced
 * by a fixed 88-character placeholder. RV_SIGN_CUSTOMER_CERT optionally points
 * to an RV-KEY-V1 customer certificate JSON file.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RV_SIG_PLACEHOLDER = `${'A'.repeat(86)}==`;
export const RV_SIG_ROOT_PUBLIC_KEY_BASE64 = '99rD6Wl3Jsk7w9D+WIN9/jfEXNXns0jDRV5yf4LX48U=';
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const encoder = new TextEncoder();

function strictBase64(value, bytes, label) {
  const chars = bytes === 64 ? 86 : 43;
  const padding = bytes === 64 ? '==' : '=';
  const re = new RegExp(`^[A-Za-z0-9+/]{${chars}}${padding}$`);
  if (typeof value !== 'string' || !re.test(value)) {
    throw new Error(`${label} must be strict padded standard Base64`);
  }
  const out = Buffer.from(value, 'base64');
  if (out.length !== bytes || out.toString('base64') !== value) {
    throw new Error(`${label} has invalid Base64 encoding`);
  }
  return out;
}

function parseGlb(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 20) throw new Error('malformed GLB');
  if (bytes.readUInt32LE(0) !== GLB_MAGIC || bytes.readUInt32LE(4) !== GLB_VERSION) {
    throw new Error('malformed GLB header');
  }
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error('malformed GLB length');
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== JSON_CHUNK || jsonLength === 0 || 20 + jsonLength > bytes.length) {
    throw new Error('malformed GLB JSON chunk');
  }
  const jsonText = bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/ +$/u, '');
  const json = JSON.parse(jsonText);
  return { bytes, json, jsonLength, restOffset: 20 + jsonLength };
}

/** Normative file-global extras path shared with the browser verifier. */
export function getDefaultSceneExtras(json, create = false) {
  const sceneIndex = json.scene ?? 0;
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || !Array.isArray(json.scenes) || !json.scenes[sceneIndex]) {
    if (create) throw new Error('GLB has no default scene for scenes[scene ?? 0].extras');
    return null;
  }
  const scene = json.scenes[sceneIndex];
  if (!scene.extras && create) scene.extras = {};
  if (!scene.extras || typeof scene.extras !== 'object' || Array.isArray(scene.extras)) {
    if (create) throw new Error('default scene extras must be an object');
    return null;
  }
  return scene.extras;
}

function rebuildJsonChunk(parsed) {
  const compact = Buffer.from(JSON.stringify(parsed.json), 'utf8');
  const paddedLength = (compact.length + 3) & ~3;
  const jsonChunk = Buffer.alloc(paddedLength, 0x20);
  compact.copy(jsonChunk);
  const rest = parsed.bytes.subarray(parsed.restOffset);
  const out = Buffer.alloc(20 + paddedLength + rest.length);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(GLB_VERSION, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(paddedLength, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jsonChunk.copy(out, 20);
  rest.copy(out, 20 + paddedLength);
  return out;
}

function rawPublicKey(key) {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

function parsePrivateKey(value) {
  if (!value?.trim()) throw new Error('RV_SIGN_PRIVATE_KEY is not configured');
  const trimmed = value.trim();
  const pem = trimmed.includes('BEGIN PRIVATE KEY')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('RV_SIGN_PRIVATE_KEY must be an Ed25519 PKCS#8 key');
  return key;
}

function customerKeyMessage(publicKey, organization) {
  const org = encoder.encode(organization.normalize('NFC'));
  const prefix = encoder.encode('RV-KEY-V1');
  const out = Buffer.alloc(prefix.length + publicKey.length + 4 + org.length);
  Buffer.from(prefix).copy(out, 0);
  publicKey.copy(out, prefix.length);
  out.writeUInt32LE(org.length, prefix.length + publicKey.length);
  Buffer.from(org).copy(out, prefix.length + publicKey.length + 4);
  return out;
}

function validateCustomerCert(cert, rootPublicKey = Buffer.from(RV_SIG_ROOT_PUBLIC_KEY_BASE64, 'base64')) {
  if (!cert || typeof cert !== 'object' || Array.isArray(cert)) throw new Error('customer certificate must be an object');
  const pub = strictBase64(cert.pub, 32, 'rv_key.pub');
  const sig = strictBase64(cert.sig, 64, 'rv_key.sig');
  if (typeof cert.org !== 'string' || !cert.org.trim()) throw new Error('rv_key.org must be a non-empty string');
  const org = cert.org.normalize('NFC');
  if (!verify(null, customerKeyMessage(pub, org), {
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      rootPublicKey,
    ]),
    format: 'der',
    type: 'spki',
  }, sig)) {
    throw new Error('rv_key root signature is invalid');
  }
  return { pub: pub.toString('base64'), org, sig: sig.toString('base64') };
}

/**
 * Resolve signing configuration once per deploy. The private key never enters
 * Vite env and this function returns only Node KeyObjects.
 */
export function loadSigningConfig(
  env = process.env,
  rootPublicKey = Buffer.from(RV_SIG_ROOT_PUBLIC_KEY_BASE64, 'base64'),
) {
  if (!env.RV_SIGN_PRIVATE_KEY?.trim()) return null;
  const privateKey = parsePrivateKey(env.RV_SIGN_PRIVATE_KEY);
  let customerCert = null;
  if (env.RV_SIGN_CUSTOMER_CERT?.trim()) {
    const certPath = resolve(env.RV_SIGN_CUSTOMER_CERT.trim());
    customerCert = validateCustomerCert(JSON.parse(readFileSync(certPath, 'utf8')), rootPublicKey);
    const actual = rawPublicKey(privateKey);
    const expected = Buffer.from(customerCert.pub, 'base64');
    if (!actual.equals(expected)) {
      throw new Error('RV_SIGN_PRIVATE_KEY does not match RV_SIGN_CUSTOMER_CERT rv_key.pub');
    }
  }
  return { privateKey, customerCert };
}

/**
 * Return a signed GLB Buffer. Re-signing is size-idempotent because JSON is
 * compacted once with the fixed-width placeholder before the signature bytes
 * replace it in place.
 */
export function signGlbBytes(input, signing) {
  if (!signing?.privateKey) throw new Error('signing configuration is required');
  const parsed = parseGlb(input);
  const extras = getDefaultSceneExtras(parsed.json, true);
  if (signing.customerCert) extras.rv_key = signing.customerCert;
  else delete extras.rv_key;
  extras.rv_sig = RV_SIG_PLACEHOLDER;

  const canonical = rebuildJsonChunk(parsed);
  const marker = Buffer.from(`"rv_sig":"${RV_SIG_PLACEHOLDER}"`, 'ascii');
  const markerOffset = canonical.indexOf(marker);
  if (markerOffset < 0 || canonical.indexOf(marker, markerOffset + 1) >= 0) {
    throw new Error('canonical rv_sig field could not be located uniquely');
  }
  const valueOffset = markerOffset + '"rv_sig":"'.length;
  const signature = sign(null, canonical, signing.privateKey);
  if (signature.length !== 64) throw new Error(`unexpected Ed25519 signature length ${signature.length}`);
  signature.toString('base64').split('').forEach((char, index) => {
    canonical[valueOffset + index] = char.charCodeAt(0);
  });
  return canonical;
}

export function verifyGlbBytes(input, rootPublicKey = Buffer.from(RV_SIG_ROOT_PUBLIC_KEY_BASE64, 'base64')) {
  try {
    const parsed = parseGlb(input);
    const extras = getDefaultSceneExtras(parsed.json, false);
    if (!extras || !Object.prototype.hasOwnProperty.call(extras, 'rv_sig')) return 'none';
    const signature = strictBase64(extras.rv_sig, 64, 'rv_sig');
    const signatureText = `"rv_sig":"${extras.rv_sig}"`;
    const markerOffset = parsed.bytes.indexOf(Buffer.from(signatureText, 'ascii'), 20);
    if (markerOffset < 0 || parsed.bytes.indexOf(Buffer.from(signatureText, 'ascii'), markerOffset + 1) >= 0) return 'invalid';
    const canonical = Buffer.from(parsed.bytes);
    canonical.write(RV_SIG_PLACEHOLDER, markerOffset + '"rv_sig":"'.length, 'ascii');

    let publicKey = rootPublicKey;
    if (extras.rv_key !== undefined) {
      const cert = validateCustomerCert(extras.rv_key, rootPublicKey);
      publicKey = Buffer.from(cert.pub, 'base64');
    }
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]);
    return verify(null, canonical, { key: spki, format: 'der', type: 'spki' }, signature)
      ? 'valid'
      : 'invalid';
  } catch {
    return 'invalid';
  }
}

export function signGlbFile(filePath, signing) {
  const sidecar = filePath.replace(/\.glb$/i, '.kin.json');
  if (existsSync(sidecar)) {
    console.warn(`[rv-sign-glb] WARNING: ${sidecar} is excluded from signed-model runtime and will not be applied`);
  }
  const signed = signGlbBytes(readFileSync(filePath), signing);
  writeFileSync(filePath, signed);
  return signed;
}

function runCli() {
  const args = process.argv.slice(2);
  const verifyMode = args[0] === '--verify';
  const files = verifyMode ? args.slice(1) : args;
  if (files.length === 0) {
    throw new Error('Usage: node scripts/rv-sign-glb.mjs [--verify] <file.glb> [...]');
  }
  if (verifyMode) {
    let failed = false;
    for (const file of files) {
      const state = verifyGlbBytes(readFileSync(file));
      console.log(`${file}: ${state}`);
      if (state !== 'valid') failed = true;
    }
    if (failed) process.exitCode = 1;
    return;
  }
  const signing = loadSigningConfig();
  if (!signing) throw new Error('RV_SIGN_PRIVATE_KEY is required');
  for (const file of files) {
    const before = readFileSync(file).length;
    const signed = signGlbFile(file, signing);
    console.log(`${file}: signed (${signed.length} bytes${before === signed.length ? ', size unchanged' : ''})`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    console.error(`[rv-sign-glb] ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
