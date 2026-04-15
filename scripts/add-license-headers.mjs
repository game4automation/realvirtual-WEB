// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Batch-add AGPL-3.0 SPDX license headers to all source files.
 * Safe to re-run: skips files that already contain SPDX-License-Identifier.
 *
 * Usage: node scripts/add-license-headers.mjs [--dry]
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('..', import.meta.url));
const DRY = process.argv.includes('--dry');

const HEADER_TS = `// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
`;

const HEADER_CSS = `/* SPDX-License-Identifier: AGPL-3.0-only
   Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io> */
`;

const HEADER_HTML = `<!-- SPDX-License-Identifier: AGPL-3.0-only
     Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io> -->
`;

const SKIP_MARKER = 'SPDX-License-Identifier';
const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const CSS_EXTS = new Set(['.css', '.scss']);

// Directories to skip entirely
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', 'private-stubs']);

// Specific files to skip (type shims, config)
const SKIP_FILES = new Set([
  'vite-env.d.ts',
  'three-mesh-bvh.d.ts',
  'three-webgpu.d.ts',
]);

let modified = 0;
let skipped = 0;
let alreadyHas = 0;

function processDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) processDir(full);
      continue;
    }

    const ext = extname(entry.name);
    if (SKIP_FILES.has(entry.name)) { skipped++; continue; }

    let header = null;
    if (TS_EXTS.has(ext)) header = HEADER_TS;
    else if (CSS_EXTS.has(ext)) header = HEADER_CSS;
    else continue; // skip unknown extensions

    const content = readFileSync(full, 'utf8');
    if (content.includes(SKIP_MARKER)) {
      alreadyHas++;
      continue;
    }

    if (DRY) {
      console.log(`[dry] Would add header: ${full.replace(__dirname, '')}`);
      modified++;
      continue;
    }

    writeFileSync(full, header + '\n' + content);
    console.log(`Added header: ${full.replace(__dirname, '')}`);
    modified++;
  }
}

function processHTML(filePath) {
  const content = readFileSync(filePath, 'utf8');
  if (content.includes(SKIP_MARKER)) {
    alreadyHas++;
    return;
  }

  if (DRY) {
    console.log(`[dry] Would add header: ${filePath.replace(__dirname, '')}`);
    modified++;
    return;
  }

  // Insert after <!DOCTYPE html>
  const replaced = content.replace(
    /<!DOCTYPE html>\s*\n/i,
    `<!DOCTYPE html>\n${HEADER_HTML}`
  );
  writeFileSync(filePath, replaced);
  console.log(`Added header: ${filePath.replace(__dirname, '')}`);
  modified++;
}

function processRootScripts() {
  // Process .mjs/.cjs files in project root
  for (const entry of readdirSync(__dirname)) {
    const ext = extname(entry);
    if (!TS_EXTS.has(ext)) continue;
    const full = join(__dirname, entry);
    if (!statSync(full).isFile()) continue;

    const content = readFileSync(full, 'utf8');
    if (content.includes(SKIP_MARKER)) {
      alreadyHas++;
      continue;
    }

    if (DRY) {
      console.log(`[dry] Would add header: ${entry}`);
      modified++;
      continue;
    }

    writeFileSync(full, HEADER_TS + '\n' + content);
    console.log(`Added header: ${entry}`);
    modified++;
  }
}

// Process directories
const dirs = ['src', 'tests', 'e2e', join('relay', 'src'), join('relay', 'tests')];
for (const dir of dirs) {
  const full = join(__dirname, dir);
  try { processDir(full); } catch { /* dir may not exist */ }
}

// Process root scripts
processRootScripts();

// Process index.html
processHTML(join(__dirname, 'index.html'));

console.log(`\n--- Summary ---`);
console.log(`Modified: ${modified}`);
console.log(`Already had header: ${alreadyHas}`);
console.log(`Skipped (config/shim): ${skipped}`);
if (DRY) console.log(`(dry run — no files were changed)`);
