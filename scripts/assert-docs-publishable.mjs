// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * assert-docs-publishable.mjs — documentation gate for the public GitHub mirror.
 *
 * The mirror is unfiltered: every git-tracked file becomes readable, and every
 * relative link inside a tracked Markdown file becomes a link a community reader
 * clicks. Two failure modes have actually happened and are checked here:
 *
 *   1. **Dangling link** — a mirrored doc links to a doc that is NOT tracked
 *      (e.g. doc-unity-to-web.md → doc-node-paths.md), so the reader gets a 404
 *      on GitHub while it resolves fine on a maintainer machine.
 *   2. **Internal doc published by accident** — `NEVER_DELIVERED_DOCS` in
 *      scripts/_workspace-lib.mjs is the SSOT for "not for outside eyes", but it
 *      only gated the generated customer workspace; the mirror push was manual
 *      discipline. doc-deploy.md reached the public mirror that way.
 *
 * Exit 0 = the tracked docs are safe to publish. Exit 1 = findings (listed).
 * `--warn-only` reports without failing.
 *
 * Usage: node scripts/assert-docs-publishable.mjs [--warn-only]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WARN_ONLY = process.argv.includes('--warn-only');

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

/**
 * Docs that are in NEVER_DELIVERED_DOCS but are nevertheless published on the
 * public mirror ON PURPOSE.
 *
 * The two lists answer different questions. `NEVER_DELIVERED_DOCS` governs the
 * generated CUSTOMER WORKSPACE: a customer gets a snapshot of the product and
 * has no business with our CDN credentials or an internal-tier subsystem. The
 * public mirror is a different audience — an open-source reader who benefits
 * from seeing how the thing is built and what the commercial tiers contain.
 * Membership in one list therefore implies nothing about the other; each entry
 * here records a deliberate decision rather than letting the two drift silently.
 */
const MIRROR_PUBLIC_ON_PURPOSE = new Map([
  ['doc-deploy.md', 'Self-hosters need the build/deploy story; credentials live in a gitignored .env.'],
  ['doc-plc-programming.md', 'Documents a commercial tier honestly, incl. its own "internal tier only" banner; '
    + 'the public control surface src/core/plc-control.ts is part of the community edition.'],
]);

/** Docs that must never reach outside eyes — read from the staging lib (SSOT). */
function neverDeliveredDocs() {
  const source = readFileSync(join(ROOT, 'scripts', '_workspace-lib.mjs'), 'utf8');
  const block = source.match(/const NEVER_DELIVERED_DOCS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  return new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT })
    .toString('utf8').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')),
);

const findings = [];

// ─── 1. Dangling relative links in tracked Markdown ───────────────────────

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Blank out fenced code blocks — a link-shaped string in a sample is not a link. */
function stripCodeBlocks(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
}

// Recipes are authored for the DELIVERED customer workspace, where the core sits
// under realvirtual-web/ — their relative links are correct there and meaningless
// against this repo's root, so they are out of scope for the mirror check.
const LINK_CHECK_SKIP_DIRS = ['recipes/'];

const trackedDirs = new Set();
for (const path of tracked) {
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i++) trackedDirs.add(segments.slice(0, i).join('/'));
}

for (const file of [...tracked].filter((p) => p.endsWith('.md'))) {
  if (LINK_CHECK_SKIP_DIRS.some((dir) => file.startsWith(dir))) continue;
  const text = stripCodeBlocks(readFileSync(join(ROOT, file), 'utf8'));
  for (const [, rawTarget] of text.matchAll(LINK_RE)) {
    // Only relative, in-repo targets matter — external URLs and anchors are out of scope.
    if (/^(https?:|mailto:|#)/.test(rawTarget)) continue;
    const target = rawTarget.split('#')[0];
    if (!target) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), target))
      .replace(/^\.\//, '').replace(/\/+$/, '');
    // A link that leaves the repo root cannot be a mirror path at all.
    if (!resolved || resolved.startsWith('..')) continue;
    // A directory link renders as a browsable listing on GitHub — valid as long as
    // the directory exists in the tracked tree.
    if (tracked.has(resolved) || trackedDirs.has(resolved)) continue;
    findings.push({
      kind: 'dangling-link',
      message: `${file} links to "${rawTarget}" — not a git-tracked path, so it 404s on the public mirror.`,
    });
  }
}

// ─── 2. NEVER_DELIVERED_DOCS that are tracked (→ would be mirrored) ───────

for (const doc of neverDeliveredDocs()) {
  if (!tracked.has(doc)) continue;
  const reason = MIRROR_PUBLIC_ON_PURPOSE.get(doc);
  if (reason) {
    console.log(`${DIM}on purpose: ${doc} — ${reason}${RESET}`);
    continue;
  }
  findings.push({
    kind: 'internal-doc-tracked',
    message: `${doc} is withheld from customer deliveries (NEVER_DELIVERED_DOCS) and is git-tracked, `
      + 'so publishing the mirror exposes it — and no deliberate decision is recorded. Either untrack it '
      + '(move to the private sibling) or add it to MIRROR_PUBLIC_ON_PURPOSE in this script with a reason.',
  });
}

// ─── Report ───────────────────────────────────────────────────────────────

if (findings.length === 0) {
  console.log(`${GREEN}✓ docs publishable${RESET} — no dangling in-repo links, no internal docs tracked.`);
  process.exit(0);
}

const byKind = new Map();
for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
for (const [kind, items] of byKind) {
  console.log(`\n${WARN_ONLY ? YELLOW : RED}${kind}${RESET} (${items.length})`);
  for (const item of items) console.log(`  - ${item.message}`);
}
console.log(`\n${DIM}${findings.length} finding(s).${RESET}`);
process.exit(WARN_ONLY ? 0 : 1);
