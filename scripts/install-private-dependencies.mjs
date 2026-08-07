// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Keeps dependencies owned by the optional private WebViewer package installed.
 *
 * The private package is a sibling of the public AGPL project, so npm does not
 * install it as part of the public dependency tree. In particular, NVIDIA's
 * Omniverse WebRTC library must remain private and comes from the registry in
 * the private package's own .npmrc. A fresh checkout therefore needs a second
 * `npm ci`; this script makes that step deterministic for internal development.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const privateRoot = [
  resolve(scriptDir, '../../realvirtual-WebViewer-Private~'),
  resolve(scriptDir, '../../realvirtual-web-pro'),
].find((candidate) => existsSync(join(candidate, 'package.json')))
  ?? resolve(scriptDir, '../../realvirtual-WebViewer-Private~');
const privateManifestPath = join(privateRoot, 'package.json');
const internalOnly = process.argv.includes('--internal-only');

if (internalOnly && !process.env.RV_INTERNAL) {
  console.log('[private-deps] customer/public build — skipped.');
  process.exit(0);
}

if (!existsSync(privateManifestPath)) {
  console.log('[private-deps] private WebViewer package not present — skipped.');
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(privateManifestPath, 'utf8'));
const dependencies = Object.entries(manifest.dependencies ?? {});
const missing = dependencies.filter(([name, wanted]) => {
  const installedManifest = join(privateRoot, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(installedManifest)) return true;
  try {
    const installed = JSON.parse(readFileSync(installedManifest, 'utf8'));
    return installed.version !== wanted;
  } catch {
    return true;
  }
});

if (missing.length === 0) {
  console.log(`[private-deps] ${dependencies.length} private dependencies already installed.`);
  process.exit(0);
}

console.log(`[private-deps] installing ${missing.map(([name, version]) => `${name}@${version}`).join(', ')}...`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Node >= 22 refuses spawning .cmd shims without a shell (EINVAL, CVE-2024-27980 hardening).
execFileSync(npm, ['ci'], { cwd: privateRoot, stdio: 'inherit', shell: process.platform === 'win32' });
