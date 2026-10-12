// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * share-encrypt.mjs — encrypt a GLB for a confidential `?glb=` share link (plan-560).
 *
 *   npm run share:encrypt -- <in.glb> [--out <file>] [--upload] [--expiry-days 30]
 *                            [--file-url <https url>] [--base https://web.realvirtual.io/demo/]
 *   npm run share:encrypt -- --link-only --file-url <https url>      (needs RV_SHARE_FRAGMENT)
 *
 * The GLB becomes an RVE1 envelope — the SAME format as the hosted deploy
 * (plan-759, scripts/lib/rv-crypto.mjs), keyed by a password AND a 32-byte
 * fragment secret that travels only in the link's `#k=`. The viewer recognises
 * the envelope in its `?glb=` boot and asks for the password.
 *
 * Secrets never arrive as arguments (bunny-deploy convention):
 *   RV_SHARE_PASSWORD        optional; otherwise a random password is generated (min. 12 chars)
 *   RV_SHARE_FRAGMENT        `--link-only` only: the fragment of an earlier run (base64url)
 *   RV_FILESHARE_API_KEY     `--upload`: the fileshare Bearer key, or
 *   RV_FILESHARE_API_KEY_FILE  a file holding it (default E:/firebase-files/.api-key)
 *
 * Output contract (plan-560 §2.4): with a file URL (`--upload` or `--file-url`)
 * stdout carries exactly one line `LINK <viewer link with #k=>`; without one it
 * carries `FRAGMENT <b64url>` and `FILE <path>`. Every encrypting run writes
 * `PASSWORD (send via a separate channel): …` to stderr. The fragment is never
 * written to a file; the password never to stdout or a file.
 */

import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CHUNK_SIZE,
  FRAGMENT_BYTES,
  base64UrlToBytes,
  bytesToBase64Url,
  encryptGlb,
  generateFragmentSecret,
  randomBytes,
} from './lib/rv-crypto.mjs';

/**
 * Mirror of `DEFAULT_SHARE_BYTE_BUDGET` in src/core/share/rv-share-fetch.ts —
 * the viewer refuses a larger `?glb=` download. Kept as a copy (this script runs
 * without a TS loader); tests/share-encrypt-cli.node.test.ts compares the two.
 */
export const SHARE_BYTE_BUDGET = 250 * 1024 * 1024;
/** Plaintext size above which mobile browsers struggle (warning only). */
export const MOBILE_WARN_BYTES = 100 * 1024 * 1024;
/** RVE1 header length with a 16-byte salt and the default `hkdfInfo`. */
export const ENVELOPE_HEADER_BYTES = 55;
/** Per-chunk framing: iv length byte + 12-byte IV + 4-byte length + 16-byte GCM tag. */
export const ENVELOPE_CHUNK_OVERHEAD = 33;
export const DEFAULT_BASE = 'https://web.realvirtual.io/demo/';
export const DEFAULT_EXPIRY_DAYS = 30;
export const FILESHARE_API_BASE = 'https://us-central1-realvirtual-files.cloudfunctions.net/api';
/** Default location of the fileshare key; a default only, overridable by ENV. */
export const DEFAULT_API_KEY_FILE = 'E:/firebase-files/.api-key';
export const MIN_PASSWORD_LENGTH = 12;

const USAGE = [
  'Usage: npm run share:encrypt -- <in.glb> [--out <file>] [--upload] [--expiry-days <n>]',
  '                                [--file-url <https url>] [--base <viewer url>]',
  '       npm run share:encrypt -- --link-only --file-url <https url> [--base <viewer url>]',
  'ENV:   RV_SHARE_PASSWORD, RV_SHARE_FRAGMENT (--link-only), RV_FILESHARE_API_KEY / RV_FILESHARE_API_KEY_FILE',
].join('\n');

class CliError extends Error {}

// ─── Pure helpers ──────────────────────────────────────────────────────────

/** Parse the command line. Throws on unknown flags, missing values and conflicting modes. */
export function parseArgs(argv) {
  const opts = {
    input: null,
    out: null,
    upload: false,
    expiryDays: DEFAULT_EXPIRY_DAYS,
    fileUrl: null,
    base: DEFAULT_BASE,
    linkOnly: false,
    help: false,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new CliError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out': opts.out = value(i, a); i++; break;
      case '--upload': opts.upload = true; break;
      case '--expiry-days': {
        const n = Number(value(i, a)); i++;
        if (!Number.isInteger(n) || n < 0) throw new CliError('--expiry-days must be a whole number >= 0 (0 = permanent)');
        opts.expiryDays = n;
        break;
      }
      case '--file-url': opts.fileUrl = value(i, a); i++; break;
      case '--base': opts.base = value(i, a); i++; break;
      case '--link-only': opts.linkOnly = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (a.startsWith('--')) throw new CliError(`unknown option ${a}`);
        if (opts.input) throw new CliError(`only one input file, got "${opts.input}" and "${a}"`);
        opts.input = a;
    }
  }
  if (opts.help) return opts;
  if (opts.fileUrl !== null) assertHttpUrl(opts.fileUrl, '--file-url');
  assertHttpUrl(opts.base, '--base');
  if (opts.linkOnly) {
    if (opts.input || opts.upload || opts.out) throw new CliError('--link-only takes no input file, --out or --upload');
    if (!opts.fileUrl) throw new CliError('--link-only needs --file-url');
  } else {
    if (!opts.input) throw new CliError('missing input file');
    if (opts.upload && opts.fileUrl) throw new CliError('--upload and --file-url are mutually exclusive');
  }
  return opts;
}

function assertHttpUrl(raw, label) {
  let u;
  try { u = new URL(raw); } catch { throw new CliError(`${label} is not a valid URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new CliError(`${label} must be http(s): ${raw}`);
}

/** Exact envelope size the CLI writes for `plainBytes` (16-byte salt, default hkdfInfo). */
export function envelopeSize(plainBytes, chunkSize = DEFAULT_CHUNK_SIZE) {
  const chunks = Math.max(1, Math.ceil(plainBytes / chunkSize));
  return ENVELOPE_HEADER_BYTES + ENVELOPE_CHUNK_OVERHEAD * chunks + plainBytes;
}

/**
 * Size gate before any upload: an envelope above the viewer's fetch budget is
 * an error (the link could never open), a large plaintext only a warning.
 */
export function checkShareSize(envelopeBytes, plainBytes, budget = SHARE_BYTE_BUDGET) {
  const warnings = [];
  if (plainBytes > MOBILE_WARN_BYTES) {
    warnings.push(`the model is ${Math.round(plainBytes / (1024 * 1024))} MiB — large for mobile browsers`);
  }
  if (envelopeBytes > budget) {
    return {
      error: `the encrypted file is ${envelopeBytes} bytes, above the viewer's ${budget}-byte limit — the link could never open`,
      warnings,
    };
  }
  return { warnings };
}

/** A random password: 15 random bytes as base64url = 20 characters. */
export function generatePassword() {
  return bytesToBase64Url(randomBytes(15));
}

/** The password from RV_SHARE_PASSWORD, or a generated one. Throws when the given one is too short. */
export function resolvePassword(env) {
  const given = env.RV_SHARE_PASSWORD;
  if (given !== undefined && given !== '') {
    if ([...given].length < MIN_PASSWORD_LENGTH) {
      throw new CliError(`RV_SHARE_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    return { password: given, generated: false };
  }
  return { password: generatePassword(), generated: true };
}

/** Parse RV_SHARE_FRAGMENT (base64url, exactly 32 bytes). */
export function parseFragment(raw) {
  if (!raw) throw new CliError('RV_SHARE_FRAGMENT is required for --link-only (the FRAGMENT of the encrypting run)');
  const bytes = base64UrlToBytes(raw.trim());
  if (bytes.length !== FRAGMENT_BYTES || bytesToBase64Url(bytes) !== raw.trim()) {
    throw new CliError(`RV_SHARE_FRAGMENT must be ${FRAGMENT_BYTES} bytes of base64url`);
  }
  return bytes;
}

/**
 * Encrypt a GLB into an RVE1 envelope. Chunked explicitly with
 * DEFAULT_CHUNK_SIZE — without `chunkSize` encryptGlb writes ONE chunk.
 * `iterations` is for tests only; the CLI uses the library default (600k).
 */
export async function encryptShare(plain, { password, fragment, iterations } = {}) {
  return encryptGlb(plain, password, fragment, {
    chunkSize: DEFAULT_CHUNK_SIZE,
    ...(iterations !== undefined ? { iterations } : {}),
  });
}

/** `…/dl/<token>` (the landing page) → `…/dl/<token>/file` (the bytes). */
export function fileUrlOf(shareUrl) {
  const trimmed = String(shareUrl).replace(/\/+$/, '');
  return /\/file$/.test(trimmed) ? trimmed : `${trimmed}/file`;
}

/** The viewer link: `<base>?glb=<encoded file url>#k=<fragment>`. */
export function buildEncryptedShareLink(base, fileUrl, fragment) {
  const frag = typeof fragment === 'string' ? fragment : bytesToBase64Url(fragment);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}glb=${encodeURIComponent(fileUrl)}#k=${frag}`;
}

/** The fileshare API key: RV_FILESHARE_API_KEY, else the file RV_FILESHARE_API_KEY_FILE (default path). */
export function loadApiKey(env, readFile = (p) => readFileSync(p, 'utf8')) {
  if (env.RV_FILESHARE_API_KEY) return env.RV_FILESHARE_API_KEY.trim();
  const file = env.RV_FILESHARE_API_KEY_FILE || DEFAULT_API_KEY_FILE;
  let key;
  try { key = readFile(file).trim(); } catch {
    throw new CliError(`no fileshare API key: set RV_FILESHARE_API_KEY or RV_FILESHARE_API_KEY_FILE (tried ${file})`);
  }
  if (!key) throw new CliError(`the fileshare API key file is empty: ${file}`);
  return key;
}

async function readErrorText(resp) {
  try { return (await resp.text()).slice(0, 300); } catch { return ''; }
}

/**
 * Upload a file to the realvirtual fileshare: create-upload-url → PUT (signed
 * URL, NO Bearer) → confirm-upload. Returns the share URL and its `/file` URL.
 * Throws on every non-success HTTP status.
 */
export async function uploadToFileshare(file, {
  apiKey,
  expiryDays = DEFAULT_EXPIRY_DAYS,
  fetchImpl = globalThis.fetch,
  apiBase = FILESHARE_API_BASE,
  brand = 'realvirtual',
} = {}) {
  if (!apiKey) throw new CliError('uploadToFileshare needs an apiKey');
  const auth = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  const r1 = await fetchImpl(`${apiBase}/create-upload-url`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ fileName: basename(file), uploadType: 'share', brand, expiryDays }),
  });
  if (!r1.ok) throw new CliError(`create-upload-url failed (HTTP ${r1.status}): ${await readErrorText(r1)}`);
  const created = await r1.json();
  if (!created?.signedUrl || !created?.token) throw new CliError('create-upload-url returned no signedUrl/token');

  const size = statSync(file).size;
  const r2 = await fetchImpl(created.signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: Readable.toWeb(createReadStream(file)),
    duplex: 'half',
  });
  if (!r2.ok) throw new CliError(`upload failed (HTTP ${r2.status}): ${await readErrorText(r2)}`);

  const r3 = await fetchImpl(`${apiBase}/confirm-upload`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ token: created.token, sendEmail: false }),
  });
  if (!r3.ok) throw new CliError(`confirm-upload failed (HTTP ${r3.status}): ${await readErrorText(r3)}`);
  const confirmed = await r3.json();
  const url = confirmed?.url || created.downloadUrl;
  if (!url) throw new CliError('confirm-upload returned no url');
  return { url, fileUrl: fileUrlOf(url) };
}

function defaultOutPath(input) {
  const name = basename(input).replace(/\.glb$/i, '');
  return join(dirname(resolve(input)), `${name}.rve.glb`);
}

// ─── Command ───────────────────────────────────────────────────────────────

/**
 * Run the command. Returns the exit code; never calls process.exit, so tests
 * drive it in-process with an injected env, streams and fetch.
 */
export async function runShareEncrypt(argv, {
  env = process.env,
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { stdout(USAGE); return 0; }

    if (opts.linkOnly) {
      // No re-encryption, no new password: the original password stays valid.
      const fragment = parseFragment(env.RV_SHARE_FRAGMENT);
      stdout(`LINK ${buildEncryptedShareLink(opts.base, opts.fileUrl, fragment)}`);
      return 0;
    }

    const plain = readFileSync(opts.input);
    if (plain.length < 4 || plain.toString('latin1', 0, 4) !== 'glTF') {
      stderr(`WARNING: ${opts.input} does not start with the GLB magic "glTF"`);
    }
    const { password } = resolvePassword(env);
    const fragment = generateFragmentSecret();
    const envelope = await encryptShare(plain, { password, fragment });

    const size = checkShareSize(envelope.length, plain.length);
    for (const w of size.warnings) stderr(`WARNING: ${w}`);
    if (size.error) throw new CliError(size.error);

    const outPath = resolve(opts.out ?? defaultOutPath(opts.input));
    writeFileSync(outPath, envelope);

    let fileUrl = opts.fileUrl;
    if (opts.upload) {
      const apiKey = loadApiKey(env);
      const uploaded = await uploadToFileshare(outPath, { apiKey, expiryDays: opts.expiryDays, fetchImpl });
      fileUrl = uploaded.fileUrl;
      stderr(`Uploaded: ${uploaded.url} (${opts.expiryDays === 0 ? 'permanent' : `expires in ${opts.expiryDays} days`})`);
    }

    if (fileUrl) {
      stdout(`LINK ${buildEncryptedShareLink(opts.base, fileUrl, fragment)}`);
    } else {
      stdout(`FRAGMENT ${bytesToBase64Url(fragment)}`);
      stdout(`FILE ${outPath}`);
    }
    stderr(`PASSWORD (send via a separate channel): ${password}`);
    return 0;
  } catch (error) {
    stderr(`[share-encrypt] ${error?.message ?? error}`);
    if (error instanceof CliError && /missing input|unknown option|needs a value/.test(error.message)) stderr(USAGE);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runShareEncrypt(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
