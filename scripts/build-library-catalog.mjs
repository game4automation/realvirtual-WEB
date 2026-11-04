// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * build-library-catalog.mjs — Generates the standard parts library manifest
 * (`catalog.json`) for the realvirtual WebViewer from the GitHub repository
 * `game4automation/realvirtual-Library`.
 *
 * Why this exists: the WebViewer can scan a GitHub repo for `.glb` files live
 * via the GitHub tree API, but anonymous API calls are capped at 60 req/h per
 * IP. On the public demo (many visitors behind a CDN) that limit is permanently
 * exhausted, so the library shows "GitHub API rate limit reached". Shipping a
 * pre-built `catalog.json` served from raw.githubusercontent.com (not rate
 * limited) sidesteps the problem entirely. `DEFAULT_LIBRARY_URLS` in
 * `src/plugins/layout-planner/index.ts` points at that manifest.
 *
 * The entry shape produced here is byte-for-byte what `buildCatalogFromGitHub`
 * (src/plugins/layout-planner/rv-layout-store.ts) builds from a live scan, so
 * switching between live-scan and static manifest is transparent.
 *
 * Usage:
 *   node scripts/build-library-catalog.mjs            # write catalog.json locally
 *   node scripts/build-library-catalog.mjs --publish  # also PUT it into the library repo
 *
 * Auth: uses $GITHUB_TOKEN if set, otherwise falls back to `gh auth token`.
 *
 * plan-508: every entry carries `sha256` + `sizeBytes` of the file behind its
 * `glbUrl`. The tree API only knows git blob ids (SHA-1 over a header), so each
 * GLB is downloaded once from raw.githubusercontent.com and hashed here — the
 * browser keys its blob cache on this hash and verifies every download with it.
 */

import { writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import { sha256Buffer } from './lib/rv-hash.mjs';

const OWNER = 'game4automation';
const REPO = 'realvirtual-Library';
const BRANCH = 'main';
const OUT_FILE = 'catalog.json';

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function gh(path, token, init = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers ?? {}),
  };
  const resp = await fetch(`https://api.github.com/${path}`, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`GitHub API ${resp.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

/** Mirror of buildCatalogFromGitHub() — keep the two in sync. */
function buildCatalog(tree) {
  const glbNodes = (tree ?? []).filter(
    (n) => n.type === 'blob' && /\.glb$/i.test(n.path),
  );
  if (glbNodes.length === 0) throw new Error('No .glb files found in repository');

  const entries = glbNodes.map((n) => {
    const rel = n.path;
    const filename = n.path.split('/').pop() ?? n.path;
    const stem = filename.replace(/\.glb$/i, '');
    const parent = rel.includes('/')
      ? rel.slice(0, rel.lastIndexOf('/')).split('/').pop() ?? ''
      : '';
    const rawUrl =
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/` +
      n.path.split('/').map(encodeURIComponent).join('/');
    return {
      id: `${REPO}/${n.path}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: stem.replace(/[_-]+/g, ' ').trim(),
      category: 'custom',
      glbUrl: rawUrl,
      // No picture field (plan-776 F11): a GitHub catalog ships no saved
      // previews, and an empty `thumbnailUrl` said nothing the absence does not.
      _path: n.path,
      ...(parent ? { collections: [parent] } : {}),
    };
  });

  return { version: '1.0', name: REPO, entries };
}

//! Download every entry's GLB once and stamp `sha256` + `sizeBytes` (plan-508).
//! Sequential on purpose: a catalog build is rare, and parallel 30-MB downloads
//! are what trips raw.githubusercontent.com's abuse limits.
async function stampHashes(catalog, token) {
  for (const entry of catalog.entries) {
    const resp = await fetch(entry.glbUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${entry._path} for its hash`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    entry.sha256 = sha256Buffer(bytes);
    entry.sizeBytes = bytes.byteLength;
    delete entry._path;
  }
  return catalog;
}

async function main() {
  const publish = process.argv.includes('--publish');
  const token = getToken();
  if (!token) {
    console.warn('No GITHUB_TOKEN and `gh auth token` failed — using anonymous API (may hit rate limit).');
  }

  const treeData = await gh(
    `repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`,
    token,
  );
  if (treeData.truncated) {
    throw new Error('Repository tree was truncated — manifest would be incomplete.');
  }

  const catalog = await stampHashes(buildCatalog(treeData.tree), token);
  const json = JSON.stringify(catalog, null, 2) + '\n';
  await writeFile(OUT_FILE, json, 'utf8');
  console.log(`Wrote ${OUT_FILE} with ${catalog.entries.length} entries.`);

  if (publish) {
    if (!token) throw new Error('--publish requires a token (set GITHUB_TOKEN or run `gh auth login`).');
    let sha;
    try {
      const existing = await gh(`repos/${OWNER}/${REPO}/contents/${OUT_FILE}`, token);
      sha = existing.sha;
    } catch {
      sha = undefined; // file does not exist yet
    }
    const res = await gh(`repos/${OWNER}/${REPO}/contents/${OUT_FILE}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Update catalog.json (WebViewer library manifest)',
        content: Buffer.from(json, 'utf8').toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    console.log(`Published: ${res.content.html_url}`);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
