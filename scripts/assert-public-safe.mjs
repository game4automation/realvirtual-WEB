// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Publish guard for the public AGPL remote (`git push public main`).
 *
 * The public repository is a plain mirror of `main` - there is no filter and no
 * build step between the two. Internal operations tooling (Forgejo hub account
 * management, CONNECT fetch, InfluxDB provisioning, customer fixtures) therefore
 * lives in the private sibling repo and must never appear in this tree.
 *
 *   node scripts/assert-public-safe.mjs [--remote public] [--ref main]
 *
 * Two checks, deliberately different in severity:
 *
 *   1. TREE (fatal)    - the commit about to become the public HEAD must not
 *                        contain any denied path. This is what people clone.
 *   2. HISTORY (warn)  - a plain push also transfers every intermediate commit,
 *                        so a file deleted before the push is still readable in
 *                        the published history. Fixing that means publishing a
 *                        snapshot commit instead of the full range; the guard
 *                        only reports it, because that is a policy decision.
 *
 * Exit code 1 = tree violation (do not push). Exit code 0 = safe to push, with
 * history findings printed as warnings.
 */

import { execFileSync } from 'node:child_process';

//! Paths that must never exist in the published tree. Matched against the full
//! repo-relative path; a trailing '/' marks a directory prefix.
const DENIED_PATHS = [
  'scripts/onboard-customer.mjs',
  'scripts/onboard-customer.d.mts',
  'scripts/get-connect.mjs',
  'scripts/get-connect.d.mts',
  'scripts/provision-influx.mjs',
  'scripts/provision-influx.d.mts',
  'scripts/inspect-door.mjs',
  'tests/onboard-customer.node.test.ts',
  'tests/get-connect.node.test.ts',
  'tests/provision-influx.node.test.ts',
];

//! Content markers that indicate internal infrastructure leaked into a file.
//! Deliberately narrow: only things that are useless to an outside reader and
//! point at our own operations, so a hit is always a real finding. The hub
//! hostname is NOT on this list - git.realvirtual.io is a public domain and is
//! named legitimately in the delivery instructions generated for customers.
const DENIED_CONTENT = [
  { source: 'realvirtualKnowledge', hint: 'path into the private knowledge base' },
  { source: 'FORGEJO_BOT_TOKEN', hint: 'rv-bot admin token env var' },
  { source: '\\bu634128\\b', hint: 'Hetzner storage box account' },
];

//! Text file types worth scanning; binaries are skipped by `git grep -I` anyway.
const SCANNED_GLOBS = [
  '*.mjs', '*.cjs', '*.js', '*.ts', '*.tsx', '*.json', '*.md', '*.ps1', '*.sh', '*.yml', '*.yaml',
];

//! Files exempt from the content scan: this guard names the markers it looks
//! for, and the agent guides describe the internal remotes on purpose.
const CONTENT_SCAN_SKIP = new Set(['CLAUDE.md', 'AGENTS.md', 'scripts/assert-public-safe.mjs']);

function git(args, { quiet = false } = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : undefined,
  });
}

//! `--ref` is the commit under inspection (default `main`); `--base` is the
//! published tip the history range is measured from and always follows the
//! remote's branch, so inspecting an arbitrary commit still compares sensibly.
function parseArguments(argv) {
  let remote = 'public';
  let ref = 'main';
  let base = null;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--remote') remote = argv[++index];
    else if (argv[index] === '--ref') ref = argv[++index];
    else if (argv[index] === '--base') base = argv[++index];
  }
  return { remote, ref, base: base ?? `${remote}/main` };
}

function isDenied(path) {
  return DENIED_PATHS.some((denied) => (denied.endsWith('/') ? path.startsWith(denied) : path === denied));
}

//! Every path present in the tree of `ref`.
function treePaths(ref) {
  return git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);
}

//! Every path touched by any commit in `range`, including ones deleted again
//! before the tip. These stay readable in a pushed history.
function historyPaths(range) {
  const output = git(['log', '--name-only', '--pretty=format:', range]);
  return [...new Set(output.split('\n').map((line) => line.trim()).filter(Boolean))];
}

//! Scans the tracked text files of `ref` for internal infrastructure markers.
//! One `git grep` per marker over the whole ref - scanning file by file costs a
//! process per file and turns a push guard into a minute of waiting.
function scanContent(ref) {
  const findings = [];
  for (const { source, hint } of DENIED_CONTENT) {
    let matches;
    try {
      matches = git(['grep', '-l', '-I', '-E', source, ref, '--', ...SCANNED_GLOBS], { quiet: true });
    } catch {
      continue; // exit code 1 = no match
    }
    for (const line of matches.split('\n').filter(Boolean)) {
      // `git grep <ref>` prefixes every hit with "<ref>:"
      const path = line.slice(line.indexOf(':') + 1);
      if (!CONTENT_SCAN_SKIP.has(path)) findings.push({ path, hint });
    }
  }
  return findings;
}

function main() {
  const { remote, ref, base } = parseArguments(process.argv.slice(2));

  const paths = treePaths(ref);
  const deniedInTree = paths.filter(isDenied);
  const contentFindings = scanContent(ref, paths);

  let remoteHead = null;
  try {
    remoteHead = git(['rev-parse', base], { quiet: true }).trim();
  } catch {
    console.log(`[publish-guard] no local ref for ${base} - skipping history check (run 'git fetch ${remote}' for it).`);
  }

  if (deniedInTree.length || contentFindings.length) {
    console.error('[publish-guard] BLOCKED - internal content in the tree that would become public:');
    for (const path of deniedInTree) console.error(`  - ${path} (internal ops tooling; belongs in the private sibling repo)`);
    for (const { path, hint } of contentFindings) console.error(`  - ${path} (${hint})`);
    console.error('\nMove the file to ../realvirtual-WebViewer-Private~/ or strip the marker, then re-run.');
    process.exit(1);
  }

  console.log(`[publish-guard] tree of ${ref} is clean (${paths.length} files checked).`);

  if (remoteHead) {
    const deniedInHistory = historyPaths(`${remoteHead}..${ref}`).filter(isDenied);
    if (deniedInHistory.length) {
      console.warn(`\n[publish-guard] WARNING: these files are absent from the tip but present in the ${remoteHead.slice(0, 7)}..${ref} range,`);
      console.warn('so a plain push publishes them as history:');
      for (const path of deniedInHistory) console.warn(`  - ${path}`);
      console.warn('\nTo publish the end state only, push a snapshot commit instead of the range:');
      console.warn(`  git push ${remote} $(git commit-tree ${ref}^{tree} -p ${remote}/${ref} -m "chore: publish snapshot"):refs/heads/${ref}`);
    } else {
      console.log(`[publish-guard] history ${remoteHead.slice(0, 7)}..${ref} is clean as well.`);
    }
  }
}

main();
