// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Publish the already-built dist-embed/ artifact to the realvirtual marketing
 * website's Bunny Storage zone. This is intentionally separate from
 * bunny-deploy.mjs: embed releases use another zone, separate credentials, an
 * explicit publish gate and a hard /embed/ path boundary.
 *
 * Required environment variables for a live publish:
 *   RV_EMBED_BUNNY_STORAGE_ZONE     Bunny Storage zone backing realvirtual.io
 *   RV_EMBED_BUNNY_STORAGE_KEY      Storage-zone access key
 *   RV_EMBED_BUNNY_API_KEY          Bunny account API key for path-scoped purge
 *   RV_EMBED_BUNNY_PULL_ZONE_ID     Must be 5668163 (deployment safety guard)
 * Optional:
 *   RV_EMBED_BUNNY_REGION           Storage API host (default storage.bunnycdn.com)
 *   RV_EMBED_RELEASE_TAG            If set, must equal rv-embed-v<package version>
 *
 * No website-repo secret or .env file is read. The deploy performs no DELETE
 * and no zone-wide purge. Every PUT is restricted to embed/vX.Y/ or
 * embed/latest/, then re-downloaded from Bunny Storage and SHA-256 verified.
 * Once an alias is uploaded, only manifest artifacts without a Vite content-hash
 * segment are purged by their exact https://realvirtual.io/embed/... URL. Those
 * public URLs are then fetched with bounded backoff and SHA-256 verified.
 *
 * A live publish without RV_EMBED_BUNNY_API_KEY aborts before the first upload
 * with exit code 1. Continuing would allow unchanged entry-point URLs to remain
 * stale at the edge or in browser caches for up to the current 30-day TTL.
 * --dry-run intentionally needs no credentials and lists PUT, PURGE and public
 * VERIFY operations without making network requests.
 *
 * Cache strategy (Bunny zone configuration, not enforceable by this script):
 * pinned /embed/vX.Y/ content-hashed assets should use a long immutable TTL;
 * /embed/latest/ entry points and all non-hashed assets should use a short,
 * revalidating TTL. The current zone-wide 30-day TTL does not distinguish them,
 * so exact-URL purge plus public verification is the mandatory bridge until the
 * corresponding Bunny Edge Rules are configured.
 *
 * Usage:
 *   npm run build:embed
 *   node scripts/embed-deploy.mjs --dry-run
 *   node scripts/embed-deploy.mjs
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BunnyClient, mimeType, normalizeRegion } from './_bunny-lib.mjs';

export const RV_EMBED_PULL_ZONE_ID = '5668163';
export const RV_EMBED_REMOTE_ROOT = 'embed';
export const RV_EMBED_PUBLIC_ORIGIN = 'https://realvirtual.io';
export const RV_EMBED_PURGE_ENDPOINT = 'https://api.bunny.net/purge';
export const PUBLIC_VERIFY_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(ROOT, 'dist-embed');
const PACKAGE_PATH = join(ROOT, 'package.json');

export function majorMinorVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new Error(`package.json version must be semver: ${version}`);
  return `${match[1]}.${match[2]}`;
}

export function embedPrefixes(version) {
  return {
    version: `${RV_EMBED_REMOTE_ROOT}/v${majorMinorVersion(version)}`,
    latest: `${RV_EMBED_REMOTE_ROOT}/latest`,
  };
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isContentHashedArtifact(relativePath) {
  const fileName = String(relativePath).replace(/\\/g, '/').split('/').at(-1) ?? '';
  return /[.-][A-Za-z0-9_-]{8}(?=\.[^.]+$)/.test(fileName);
}

export function assertEmbedRemotePath(remotePath, allowedPrefix) {
  const normalized = String(remotePath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe embed remote path: ${remotePath}`);
  }
  if (!normalized.startsWith(`${RV_EMBED_REMOTE_ROOT}/`)) {
    throw new Error(`Refusing path outside /${RV_EMBED_REMOTE_ROOT}/: ${remotePath}`);
  }
  if (allowedPrefix && normalized !== allowedPrefix && !normalized.startsWith(`${allowedPrefix}/`)) {
    throw new Error(`Refusing path outside ${allowedPrefix}/: ${remotePath}`);
  }
  return normalized;
}

export function assertEmbedPublicUrl(publicUrl) {
  const url = new URL(publicUrl);
  if (
    url.origin !== RV_EMBED_PUBLIC_ORIGIN
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`Refusing purge URL outside ${RV_EMBED_PUBLIC_ORIGIN}/embed/: ${publicUrl}`);
  }
  const remotePath = assertEmbedRemotePath(url.pathname, RV_EMBED_REMOTE_ROOT);
  if (url.pathname !== `/${remotePath}`) {
    throw new Error(`Unsafe embed public URL: ${publicUrl}`);
  }
  return url.toString();
}

export function embedPublicUrl(remotePath) {
  const safePath = assertEmbedRemotePath(remotePath, RV_EMBED_REMOTE_ROOT);
  return assertEmbedPublicUrl(`${RV_EMBED_PUBLIC_ORIGIN}/${safePath}`);
}

export class EmbedDeliveryClient {
  constructor({ apiKey, fetchImpl = globalThis.fetch }) {
    if (!apiKey) throw new Error('EmbedDeliveryClient requires a Bunny account API key');
    if (typeof fetchImpl !== 'function') throw new Error('EmbedDeliveryClient requires fetch');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async purgeUrl(publicUrl) {
    const safeUrl = assertEmbedPublicUrl(publicUrl);
    const endpoint = new URL(RV_EMBED_PURGE_ENDPOINT);
    endpoint.searchParams.set('url', safeUrl);
    endpoint.searchParams.set('async', 'false');
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { AccessKey: this.apiKey },
    });
    if (!response.ok) {
      throw new Error(`Bunny purge failed for ${safeUrl}: HTTP ${response.status}`);
    }
  }

  async getPublicFile(publicUrl) {
    const safeUrl = assertEmbedPublicUrl(publicUrl);
    const response = await this.fetchImpl(safeUrl);
    if (!response.ok) {
      throw new Error(`Public fetch failed for ${safeUrl}: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

export function collectEmbedArtifacts(distDir = DIST_DIR) {
  const root = resolve(distDir);
  if (!existsSync(join(root, 'rv-embed.js'))) {
    throw new Error(`rv-embed build not found: ${join(root, 'rv-embed.js')}`);
  }
  const required = [
    'draco/draco_decoder.js',
    'draco/draco_decoder.wasm',
    'draco/draco_wasm_wrapper.js',
    'vignettes/conveyor-sensor.glb',
    'test/index.html',
    'test/poster.svg',
  ];
  for (const rel of required) {
    if (!existsSync(join(root, rel))) throw new Error(`Required embed artifact missing: ${rel}`);
  }

  const artifacts = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const rel = relative(root, absolute).replace(/\\/g, '/');
        assertEmbedRemotePath(`${RV_EMBED_REMOTE_ROOT}/latest/${rel}`, `${RV_EMBED_REMOTE_ROOT}/latest`);
        const bytes = readFileSync(absolute);
        artifacts.push({ rel, bytes, size: bytes.length, hash: sha256(bytes) });
      }
    }
  };
  walk(root);

  const publishRank = (rel) => {
    if (rel === 'test/index.html') return 2;
    if (rel === 'rv-embed.js') return 1;
    return 0;
  };
  return artifacts.sort((left, right) => (
    publishRank(left.rel) - publishRank(right.rel) || left.rel.localeCompare(right.rel)
  ));
}

export function loadEmbedDeployConfig(env = process.env, { dryRun = false } = {}) {
  const version = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version;
  const releaseTag = env.RV_EMBED_RELEASE_TAG?.trim() ?? '';
  const expectedTag = `rv-embed-v${version}`;
  if (releaseTag && releaseTag !== expectedTag) {
    throw new Error(`RV_EMBED_RELEASE_TAG must be ${expectedTag}, got ${releaseTag}`);
  }
  const pullZoneId = env.RV_EMBED_BUNNY_PULL_ZONE_ID?.trim() ?? '';
  if (!dryRun && pullZoneId !== RV_EMBED_PULL_ZONE_ID) {
    throw new Error(
      `RV_EMBED_BUNNY_PULL_ZONE_ID must be ${RV_EMBED_PULL_ZONE_ID}; got ${pullZoneId || '<missing>'}`,
    );
  }
  const zone = env.RV_EMBED_BUNNY_STORAGE_ZONE?.trim() ?? '';
  const storageKey = env.RV_EMBED_BUNNY_STORAGE_KEY?.trim() ?? '';
  const apiKey = env.RV_EMBED_BUNNY_API_KEY?.trim() ?? '';
  if (!dryRun && !zone) throw new Error('Missing RV_EMBED_BUNNY_STORAGE_ZONE');
  if (!dryRun && !storageKey) throw new Error('Missing RV_EMBED_BUNNY_STORAGE_KEY');
  if (!dryRun && !apiKey) {
    throw new Error(
      'WARNING: Missing RV_EMBED_BUNNY_API_KEY. Live deploy aborted before upload '
      + '(exit code 1): without exact-URL purge, public /embed/ artifacts can remain '
      + 'stale for up to 30 days.',
    );
  }
  return {
    version,
    region: normalizeRegion(env.RV_EMBED_BUNNY_REGION),
    zone,
    storageKey,
    apiKey,
    pullZoneId,
  };
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function verifyPublicArtifact({
  deliveryClient,
  artifact,
  publicUrl,
  backoffMs = PUBLIC_VERIFY_BACKOFF_MS,
  sleep = wait,
  log = console.log,
}) {
  const safeUrl = assertEmbedPublicUrl(publicUrl);
  let lastHash = '<not fetched>';
  let lastError;
  for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
    try {
      const downloaded = await deliveryClient.getPublicFile(safeUrl);
      lastHash = sha256(downloaded);
      lastError = undefined;
      if (lastHash === artifact.hash) {
        log(`VERIFY PUBLIC ${safeUrl} sha256 ${lastHash} OK`);
        return lastHash;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < backoffMs.length) {
      const delay = backoffMs[attempt];
      log(
        `VERIFY PUBLIC ${safeUrl} attempt ${attempt + 1} not current; `
        + `retrying in ${delay} ms`,
      );
      await sleep(delay);
    }
  }
  const detail = lastError ? `last error: ${lastError.message}` : `public ${lastHash}`;
  throw new Error(
    `Public hash verification failed for ${safeUrl}: local ${artifact.hash}, ${detail}`,
  );
}

export async function deployEmbedArtifacts({
  client,
  deliveryClient,
  artifacts,
  version,
  dryRun = false,
  publicVerifyBackoffMs = PUBLIC_VERIFY_BACKOFF_MS,
  sleep = wait,
  log = console.log,
}) {
  const prefixes = embedPrefixes(version);
  const results = [];
  const mutableArtifacts = artifacts.filter((artifact) => !isContentHashedArtifact(artifact.rel));

  // The immutable-looking major.minor prefix may change for patch releases.
  // Publish and verify it completely before switching the duplicated latest
  // alias. Hashed chunks go first, rv-embed.js and test/index.html last.
  for (const [alias, prefix] of Object.entries(prefixes)) {
    for (const artifact of artifacts) {
      const remotePath = assertEmbedRemotePath(`${prefix}/${artifact.rel}`, prefix);
      log(
        `${dryRun ? '[dry-run] ' : ''}PUT /${remotePath} `
        + `(${artifact.size} bytes, sha256 ${artifact.hash})`,
      );
      if (dryRun) {
        results.push({ alias, remotePath, hash: artifact.hash, verified: false });
        continue;
      }
      await client.putFile(artifact.bytes, remotePath, mimeType(artifact.rel));
      const downloaded = await client.getFile(remotePath);
      const remoteHash = sha256(downloaded);
      if (remoteHash !== artifact.hash) {
        throw new Error(
          `Hash verification failed for /${remotePath}: `
          + `local ${artifact.hash}, remote ${remoteHash}`,
        );
      }
      log(`VERIFY /${remotePath} sha256 ${remoteHash} OK`);
      results.push({ alias, remotePath, hash: remoteHash, verified: true });
    }

    for (const artifact of mutableArtifacts) {
      const remotePath = assertEmbedRemotePath(`${prefix}/${artifact.rel}`, prefix);
      const publicUrl = embedPublicUrl(remotePath);
      log(`${dryRun ? '[dry-run] ' : ''}PURGE ${publicUrl}`);
      if (!dryRun) await deliveryClient.purgeUrl(publicUrl);
    }

    for (const artifact of mutableArtifacts) {
      const remotePath = assertEmbedRemotePath(`${prefix}/${artifact.rel}`, prefix);
      const publicUrl = embedPublicUrl(remotePath);
      if (dryRun) {
        log(`[dry-run] VERIFY PUBLIC ${publicUrl} sha256 ${artifact.hash}`);
        continue;
      }
      await verifyPublicArtifact({
        deliveryClient,
        artifact,
        publicUrl,
        backoffMs: publicVerifyBackoffMs,
        sleep,
        log,
      });
      const result = results.find((entry) => entry.remotePath === remotePath);
      if (result) result.publicVerified = true;
    }
  }
  return { prefixes, results, mutableArtifacts };
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

export async function main() {
  const dryRun = hasFlag('dry-run');
  const config = loadEmbedDeployConfig(process.env, { dryRun });
  const artifacts = collectEmbedArtifacts();
  const prefixes = embedPrefixes(config.version);
  console.log('rv-embed Bunny publish');
  console.log(`  version: ${config.version}`);
  console.log(`  pinned:  https://realvirtual.io/${prefixes.version}/`);
  console.log(`  latest:  https://realvirtual.io/${prefixes.latest}/`);
  console.log(`  files:   ${artifacts.length} artifacts x 2 prefixes`);
  console.log('  cleanup: no DELETE; exact-URL purge for non-hashed manifest artifacts only');

  const client = dryRun
    ? null
    : new BunnyClient({
      region: config.region,
      zone: config.zone,
      storageKey: config.storageKey,
    });
  const deliveryClient = dryRun
    ? null
    : new EmbedDeliveryClient({ apiKey: config.apiKey });
  const result = await deployEmbedArtifacts({
    client,
    deliveryClient,
    artifacts,
    version: config.version,
    dryRun,
  });
  console.log(
    dryRun
      ? `[dry-run] ${result.results.length} PUT operations, `
        + `${result.mutableArtifacts.length * 2} PURGE operations and `
        + `${result.mutableArtifacts.length * 2} public VERIFY operations listed; `
        + 'no network request performed.'
      : `${result.results.length} uploads storage-verified; `
        + `${result.mutableArtifacts.length * 2} non-hashed public artifacts purged and verified.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[rv-embed deploy] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
