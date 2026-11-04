// plan-659 — the out-of-band packages of this spike, restorable with ONE command.
//
//   node spikes/659/ensure-deps.mjs            # check, install only what is missing
//   node spikes/659/ensure-deps.mjs --check    # report only, exit 1 when incomplete
//   node spikes/659/ensure-deps.mjs --force    # reinstall both trees unconditionally
//
// ── The stumbling block this removes ─────────────────────────────────────
//
// `@mujoco/mujoco`, `onnxruntime-web` and `onnxruntime-node` are installed
// `--no-save`, i.e. they are EXTRANEOUS: they appear in no `package.json`.
// npm reifies `node_modules` from the manifest on every install, so the very
// next `npm install --no-save <anything>` in either tree DELETES them again.
// Every round of this spike so far has started by rediscovering that and
// reconstructing the version numbers by hand.
//
// Why not just put them in `package.json`: both manifests are product files of
// repositories this spike must not merge into (the plan says "Kein Merge auf
// main im Spike"), and `realvirtual-web-private` would then pull ~100 MB of
// robotics WASM on every `npm install` for every developer, for a spike. The
// packages stay out-of-band; what changes is that restoring them is this file
// instead of detective work.
//
// It is also wired in, so nobody has to remember it:
//   * `spikes/659/vitest.config.ts`  → globalSetup (the spike suite self-heals)
//   * `spikes/659/viewer-smoke.mjs`  → first statement
//   * `spikes/659/make-demo-project.mjs` → first statement
//
// ── What it must NOT change ──────────────────────────────────────────────
//
// Nothing about HOW these modules are loaded. Both are reached exclusively
// through dynamic `import()` behind the `rv_mujoco` gate, which is what keeps
// the Phase-2 proof ("in a customer or public build the increase is zero")
// valid. This file only puts bytes on disk; it adds no import, no manifest
// entry and no side effect in any bundled module.
//
// Versions are the ones the Phase-1 golden was measured against
// (`microduck-qpos-after-500-steps.wasm.json` → `meta.versions`). Changing one
// here without re-measuring that golden is a knowingly broken regression test.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = resolve(HERE, '../..');
const P = resolve(W, '../realvirtual-WebViewer-Private~');

/**
 * Per tree, the exact set — one `npm install` call each, because npm prunes
 * what the call does not name. Installing them one by one is precisely the
 * bug this file exists for.
 */
export const SPIKE_DEPS = [
  {
    name: 'W (realvirtual-WebViewer~)',
    dir: W,
    // onnxruntime-node is the Node/headless EP: the Phase-1 parity reference
    // and the golden. The browser never touches it.
    packages: ['@mujoco/mujoco@3.11.0', 'onnxruntime-web@1.27.0', 'onnxruntime-node@1.23.2'],
  },
  {
    name: 'P (realvirtual-WebViewer-Private~)',
    dir: P,
    // The private tree resolves `@mujoco/mujoco` / `onnxruntime-web/wasm` for
    // its own sources; `@types/node` is extraneous here too (this manifest has
    // no devDependencies at all) and dies in the same prune, so it is restored
    // with them rather than one round later.
    packages: ['@mujoco/mujoco@3.11.0', 'onnxruntime-web@1.27.0', '@types/node@26.6.5'],
  },
];

const specOf = (p) => {
  const at = p.lastIndexOf('@');
  return { pkg: p.slice(0, at), version: p.slice(at + 1) };
};

/** Installed version of `pkg` under `dir`, or null. */
function installedVersion(dir, pkg) {
  const manifest = resolve(dir, 'node_modules', ...pkg.split('/'), 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** What is missing or at the wrong version, per tree. */
export function auditSpikeDeps() {
  return SPIKE_DEPS.map((tree) => {
    const present = existsSync(tree.dir);
    const wrong = present
      ? tree.packages.filter((p) => {
        const { pkg, version } = specOf(p);
        return installedVersion(tree.dir, pkg) !== version;
      })
      : tree.packages;
    return { ...tree, present, wrong, complete: present && wrong.length === 0 };
  });
}

/**
 * Restores every tree that needs it. Returns the audit AFTER the work, so a
 * caller can fail on `complete === false` (a tree that is simply absent — a
 * public checkout without the private sibling — is reported, never installed
 * into).
 */
export function ensureSpikeDeps({ force = false, log = console.log } = {}) {
  for (const tree of auditSpikeDeps()) {
    if (!tree.present) { log(`[659 deps] ${tree.name}: tree not present — skipped`); continue; }
    if (tree.complete && !force) continue;
    log(`[659 deps] ${tree.name}: installing ${tree.packages.join(' ')}`);
    const r = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-save', '--no-audit', '--no-fund', ...tree.packages],
      { cwd: tree.dir, stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (r.status !== 0) throw new Error(`[659 deps] npm install failed in ${tree.name} (exit ${r.status})`);
  }
  return auditSpikeDeps();
}

/** vitest `globalSetup`: the spike suite restores its own packages. */
export default function setup() {
  ensureSpikeDeps({ log: (m) => console.log(m) });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const checkOnly = process.argv.includes('--check');
  const after = checkOnly ? auditSpikeDeps() : ensureSpikeDeps({ force: process.argv.includes('--force') });
  for (const t of after) {
    const state = !t.present ? 'absent' : t.complete ? 'ok' : `MISSING ${t.wrong.join(' ')}`;
    console.log(`${t.name.padEnd(40)} ${state}`);
  }
  const bad = after.filter((t) => t.present && !t.complete);
  process.exit(bad.length === 0 ? 0 : 1);
}
