// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-reference-baseline — how every stored reference of every shipped GLB binds
 * TODAY, and how it will bind after plan-769's migration (plan-769 Phase 0).
 *
 * For each reference (ComponentReference anywhere in a component, the declared
 * PATH_FIELDS and NAME_FIELDS of `rv-node-path-rewrite.mjs`) on the scene or a
 * reachable node:
 *  - `stage`: today's node-level chain (`referenceLookup` of rv-glb-nodes.mjs —
 *    the replica of NodeRegistry's chain the rename / move pipeline uses):
 *    exact / space / suffix / sanitized / name-in-scope, or `unresolved`.
 *    Static: the file's own hierarchy under loader names — no prepare hooks
 *    (Kinematic re-parent) and no component-level `alias`. That is what a
 *    written path can bind to; the live viewer resolves after re-parenting.
 *  - `via`: plan-769 F3 migration — the AUTHORED index of the file (raw
 *    `json.nodes[].name` joined by `/`): exact → root-stripped → exact legacy
 *    Three spelling (loader path) → `unresolved` with `reason` missing |
 *    ambiguous. No guessing. NAME_FIELDS: unique raw name in the owner's
 *    subtree, else unique in the file.
 *  - `guessOnly`: today bound only by a guessing stage and the migration finds
 *    nothing — the reference that becomes `unresolvedPath` in Phase 1;
 *    `disagree`: both bind, to DIFFERENT nodes — today's guess hits the wrong node.
 * Nodes are named by their canonical authored path (rv-node-id-seed.mjs), the
 * identity the seed hangs on. The same pass runs the seed spike (canonical
 * paths, seed collisions, existing / duplicate NodeIds, awkward names), counts
 * signal components and `AssetOverrides` keys.
 *
 * Reads only the JSON chunk (a 659 MB GLB costs its JSON, not its BIN).
 *
 * Usage:
 *   node scripts/rv-reference-baseline.mjs [--root <dir>]... [--out <file.json>] [--private-out <file.json>] [--entries all|nontrivial|none] [--quiet]
 * Defaults: roots `../realvirtual-WebViewer-Private~/projects` and `public`
 * (`.trash`, `node_modules`, `dist` skipped), entries `nontrivial`. Only files git
 * TRACKS below a root are read (`listBaselineFiles`) — local drafts never enter the
 * snapshot.
 * `--out` writes the snapshot; otherwise a summary table goes to stdout.
 * Private entries other than `PUBLIC_PINNED_LABELS` go to `--private-out` (default:
 * the private sibling's `tests/fixtures/reference-baseline.private.json`), never into `--out`.
 */

import { openSync, readSync, closeSync, fstatSync, readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planReferenceRewrite } from '../src/core/engine/rv-node-path-rewrite.mjs';
import { referenceLookup, SIGNAL_COMPONENT_TYPES } from './lib/rv-glb-nodes.mjs';
import { AMBIGUOUS, contentRootOf, createMigrationContext, enumerateReferences, normalizeWrittenPath as normalize } from '../src/core/engine/rv-reference-migration.mjs';
import { canonicalAuthoredPaths, seedNodeIdsForFile } from '../src/core/engine/rv-node-id-seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const SKIP_DIRS = new Set(['.trash', 'node_modules', 'dist', '.git']);
const GUESS_STAGES = new Set(['space', 'suffix', 'sanitized', 'name-in-scope']);

// ─── GLB JSON chunk ─────────────────────────────────────────────────────

/** The parsed JSON chunk of a GLB plus its text hash, without reading the BIN chunk. */
export function readGlbJson(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) !== 20) throw new Error('not a GLB (short header)');
    if (head.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB (magic)');
    const len = head.readUInt32LE(12);
    if (head.readUInt32LE(16) !== 0x4e4f534a) throw new Error('not a GLB (first chunk is not JSON)');
    if (20 + len > size) throw new Error('not a GLB (truncated JSON chunk)');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 20);
    const text = buf.toString('utf8').replace(/[\u0000 ]+$/, '');
    return { json: JSON.parse(text), bytes: size, jsonSha1: createHash('sha1').update(text).digest('hex').slice(0, 16) };
  } finally {
    closeSync(fd);
  }
}

// ─── Reference enumeration + F3 migration: THE viewer code ──────────────
//
// plan-769 Phase 1: the enumeration (`visitReferences`) and the migration
// (`createMigrationContext`) live in `src/core/engine/rv-reference-migration.mjs`,
// the module the viewer's decode identity runs. This script only adds today's
// stage (the registry replica) — so the snapshot pins the viewer's own code.

export { enumerateReferences, contentRootOf };

// ─── One GLB ────────────────────────────────────────────────────────────

export function analyseGlb(json, opts = {}) {
  const entriesMode = opts.entries ?? 'nontrivial';
  const L = referenceLookup(json);
  const nodes = json.nodes ?? [];
  const sceneIdx = json.scene ?? 0;
  const scene = json.scenes?.[sceneIdx] ?? {};
  const canonical = canonicalAuthoredPaths(json, sceneIdx);
  const regToIdx = new Map([[L.R, -1]]);
  L.rel.forEach((p, i) => { if (p !== undefined) regToIdx.set(L.reg(i), i); });
  const nodeLabel = (i) => (i === -1 ? '' : (canonical[i] ?? `<unreachable ${i}>`));

  // The CONTENT root: where `unwrapGltfRoot` (ModelCache, parseGlbSubtree) lands
  // for this file — the scope root a placement of it resolves against. The main
  // model (`loadGLB`) does NOT unwrap, so the same file is scoped differently per
  // decode site today; the migration reads both roots, in a fixed order.
  const ctx = createMigrationContext(json, { parent: L.parent, legacyPaths: L.rel, legacyRootName: L.rel.names?.[contentRootOf(json)] });
  const { raw, authored, lookIn, migratePath, migrateName } = ctx;

  // Referrers: the scene (lifted root components) and every reachable, non-foreign node.
  const referrers = [];
  if (scene.extras?.realvirtual) referrers.push({ idx: -1, extras: scene.extras.realvirtual });
  for (let i = 0; i < nodes.length; i++) {
    if (L.rel[i] === undefined || L.isForeign(i)) continue;
    const rv = nodes[i]?.extras?.realvirtual;
    if (rv && typeof rv === 'object' && !Array.isArray(rv)) referrers.push({ idx: i, extras: rv });
  }

  const refs = { total: 0, byKind: {}, byStage: {}, byVia: {}, unresolved: { missing: 0, ambiguous: 0 }, guessOnly: 0, disagree: 0, todayUnresolved: 0, healedByMigration: 0, lostByMigration: 0 };
  const guessOnlyByComponent = {};
  const entries = [];
  const digestLines = [];
  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  for (const r of referrers) {
    for (const ref of enumerateReferences(r.extras)) {
      refs.total++;
      bump(refs.byKind, ref.kind);
      let today = null;
      if (ref.kind === 'name') {
        const hit = L.resolveName(ref.path, r.idx);
        if (hit && typeof hit.canonical === 'string') today = { idx: regToIdx.get(hit.canonical) ?? null, stage: 'name' };
      } else {
        // The registry chain: exact (loader spelling) → alias (the authored
        // spelling the loader publishes for renamed nodes) → space → suffix →
        // sanitized → name-in-scope. Static: no re-parent, no shadowed aliases.
        const hit = L.resolve(ref.path);
        if (hit && hit.stage === 'exact') today = { idx: hit.idx, stage: 'exact' };
        else {
          const a = lookIn(authored, normalize(ref.path), raw);
          if (a && a.idx !== AMBIGUOUS) today = { idx: a.idx, stage: 'alias' };
          else if (hit) today = { idx: hit.idx, stage: hit.stage };
        }
      }
      const stage = today ? today.stage : 'unresolved';
      bump(refs.byStage, stage);
      const mig = ref.kind === 'name' ? migrateName(ref.path, r.idx) : migratePath(ref.path);
      bump(refs.byVia, mig.via);
      if (mig.via === 'unresolved') refs.unresolved[mig.reason]++;
      if (!today) refs.todayUnresolved++;
      const guessOnly = !!today && GUESS_STAGES.has(stage) && mig.via === 'unresolved';
      const disagree = !!today && mig.idx !== undefined && today.idx !== mig.idx;
      if (guessOnly) { refs.guessOnly++; bump(guessOnlyByComponent, `${ref.componentType}.${ref.field.replace(/\[\d+\]/g, '[]')}`); }
      if (disagree) refs.disagree++;
      if (!today && mig.idx !== undefined) refs.healedByMigration++;
      const lost = !!today && mig.via === 'unresolved';
      if (lost) refs.lostByMigration++;
      const trivial = (stage === 'exact' || stage === 'alias') && mig.via.startsWith('authored') && !disagree;
      const trivialName = stage === 'name' && mig.idx !== undefined && !disagree;
      digestLines.push([nodeLabel(r.idx), ref.componentType, ref.field, ref.path, stage, mig.via, mig.idx !== undefined ? nodeLabel(mig.idx) : mig.reason].join('\t'));
      if (entriesMode === 'all' || (entriesMode === 'nontrivial' && !trivial && !trivialName)) {
        entries.push({
          referrer: nodeLabel(r.idx), component: ref.componentType, field: ref.field, kind: ref.kind, path: ref.path,
          stage, todayTarget: today && today.idx !== null ? nodeLabel(today.idx) : null,
          via: mig.via, ...(mig.idx !== undefined ? { target: nodeLabel(mig.idx) } : { reason: mig.reason }),
          ...(guessOnly ? { guessOnly: true } : {}), ...(disagree ? { disagree: true } : {}),
        });
      }
    }
  }

  // Cross-check: the mirror walk sees exactly what planReferenceRewrite sees.
  const plan = planReferenceRewrite({
    referrers: referrers.map((r) => ({ nodePath: L.reg(r.idx), extras: r.extras })),
    moves: new Map(),
    resolveOld: () => null,
  });
  const pathRefs = refs.total - (refs.byKind.name ?? 0);
  if (plan.counts.referencesSeen !== pathRefs) {
    throw new Error(`reference enumeration drifted from planReferenceRewrite: ${pathRefs} vs ${plan.counts.referencesSeen}`);
  }

  // Seed spike.
  const t0 = performance.now();
  const seed = seedNodeIdsForFile(json, sceneIdx);
  const seedMs = performance.now() - t0;
  let reachable = 0;
  const names = { slash: 0, bracket: 0, backslash: 0, hashLead: 0, empty: 0 };
  for (let i = 0; i < nodes.length; i++) {
    if (canonical[i] === undefined) continue;
    reachable++;
    const n = typeof nodes[i]?.name === 'string' ? nodes[i].name : '';
    if (n === '') names.empty++;
    if (n.includes('/')) names.slash++;
    if (n.includes('[')) names.bracket++;
    if (n.includes('\\')) names.backslash++;
    if (n.startsWith('#')) names.hashLead++;
  }
  const canonicalSet = new Set(canonical.filter((p) => p !== undefined));
  let ambiguousRawPaths = 0;
  for (const v of authored.values()) if (v === AMBIGUOUS) ambiguousRawPaths++;
  let sameNameSiblings = 0;
  for (const p of canonical) if (p !== undefined && /(^|[^\\])\[\d+\]$/.test(p)) sameNameSiblings++;

  // Signals.
  const signals = { total: 0, explicitName: 0, nameFollowsNode: 0 };
  for (const r of referrers) {
    for (const key of Object.keys(r.extras)) {
      if (!SIGNAL_COMPONENT_TYPES.includes(key.replace(/_\d+$/, ''))) continue;
      signals.total++;
      const nm = r.extras[key]?.Name;
      if (typeof nm === 'string' && nm.length > 0) signals.explicitName++; else signals.nameFollowsNode++;
    }
  }

  return {
    nodes: nodes.length,
    reachable,
    seed: {
      existingIds: seed.existing,
      seeded: seed.seeded,
      collisions: seed.collisions.length,
      duplicateExistingIds: seed.duplicates.length,
      canonicalPathsUnique: canonicalSet.size === reachable,
      ambiguousRawPaths,
      sameNameSiblings,
      names,
      seedMs: Math.round(seedMs),
    },
    refs,
    /** sha1 over every reference (referrer, component, field, path, stage, via, target) — sorted; Phase 1 must reproduce it. */
    refsDigest: createHash('sha1').update(digestLines.sort().join('\n')).digest('hex').slice(0, 20),
    guessOnlyByComponent,
    signals,
    overrides: countOverrides(json),
    entries,
  };
}

/** `AssetOverrides` keys anywhere in the file: entry counts of byNodeId / byPath / trsByNodeId. */
export function countOverrides(root) {
  const out = { byNodeId: 0, byPath: 0, trsByNodeId: 0 };
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
    for (const k of Object.keys(v)) {
      const x = v[k];
      if ((k === 'byNodeId' || k === 'byPath' || k === 'trsByNodeId') && x && typeof x === 'object' && !Array.isArray(x)) out[k] += Object.keys(x).length;
      if (x && typeof x === 'object') stack.push(x);
    }
  }
  return out;
}

// ─── CLI ────────────────────────────────────────────────────────────────

function* walkFiles(dir, ext) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, ext);
    else if (e.name.toLowerCase().endsWith(ext)) yield p;
  }
}

/**
 * The files with extension `ext` below `dir` that the snapshot describes: the ones
 * git TRACKS there (`git ls-files`, present on disk, the `SKIP_DIRS` rule applied),
 * sorted. A local draft, an editor save or an untracked download never belongs to
 * the baseline — it would make the snapshot machine-specific. Outside a git work
 * tree (an exported copy, git missing) the plain disk walk applies.
 */
export function listBaselineFiles(dir, ext) {
  if (!existsSync(dir)) return [];
  let listed = null;
  try {
    listed = execFileSync('git', ['-C', dir, 'ls-files', '-z', '--', '.'], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    listed = null;
  }
  if (listed === null) return [...walkFiles(dir, ext)].sort();
  const out = [];
  for (const rel of listed.split('\0')) {
    if (!rel || !rel.toLowerCase().endsWith(ext)) continue;
    if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    const abs = resolve(dir, rel);
    if (existsSync(abs)) out.push(abs);
  }
  return out.sort();
}

/** `<repo>/<path>` label: `private:` or `public:` + forward-slash path relative to that repo. */
export function labelOf(file) {
  const privRoot = resolve(WEB_ROOT, '..', 'realvirtual-WebViewer-Private~');
  if (file.startsWith(privRoot + sep)) return `private:${relative(privRoot, file).split(sep).join('/')}`;
  return `public:${relative(WEB_ROOT, file).split(sep).join('/')}`;
}

/** Customer = first folder under `projects/` (private) or `public`. */
function customerOf(label) {
  const m = /^private:projects\/([^/]+)\//.exec(label);
  return m ? m[1] : (label.startsWith('public:') ? 'public' : 'other');
}

export function runBaseline(roots, opts = {}) {
  const files = [];
  for (const r of roots) for (const f of listBaselineFiles(r, '.glb')) files.push(f);
  files.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  const glbs = {};
  const errors = {};
  for (const f of files) {
    const label = labelOf(f);
    try {
      const { json, bytes, jsonSha1 } = readGlbJson(f);
      glbs[label] = { bytes, jsonSha1, ...analyseGlb(json, opts) };
      if (!opts.quiet) process.stderr.write(`ok   ${label}\n`);
    } catch (e) {
      errors[label] = String(e?.message ?? e);
      if (!opts.quiet) process.stderr.write(`fail ${label}: ${errors[label]}\n`);
    }
  }
  // Override keys in project JSON files (layouts / project manifests), per customer.
  const jsonOverrides = {};
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const f of listBaselineFiles(r, '.json')) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
      const c = countOverrides(parsed);
      if (c.byNodeId + c.byPath + c.trsByNodeId > 0) jsonOverrides[labelOf(f)] = c;
    }
  }
  const perCustomer = {};
  for (const [label, g] of Object.entries(glbs)) {
    const c = (perCustomer[customerOf(label)] ??= { glbs: 0, refs: 0, guessOnly: 0, disagree: 0, unresolvedAfter: 0, todayUnresolved: 0, byPath: 0, byNodeId: 0, trsByNodeId: 0, seedCollisions: 0 });
    c.glbs++;
    c.refs += g.refs.total;
    c.guessOnly += g.refs.guessOnly;
    c.disagree += g.refs.disagree;
    c.unresolvedAfter += g.refs.unresolved.missing + g.refs.unresolved.ambiguous;
    c.todayUnresolved += g.refs.todayUnresolved;
    c.byPath += g.overrides.byPath;
    c.byNodeId += g.overrides.byNodeId;
    c.trsByNodeId += g.overrides.trsByNodeId;
    c.seedCollisions += g.seed.collisions;
  }
  for (const [label, o] of Object.entries(jsonOverrides)) {
    const c = (perCustomer[customerOf(label)] ??= { glbs: 0, refs: 0, guessOnly: 0, disagree: 0, unresolvedAfter: 0, todayUnresolved: 0, byPath: 0, byNodeId: 0, trsByNodeId: 0, seedCollisions: 0 });
    c.byPath += o.byPath; c.byNodeId += o.byNodeId; c.trsByNodeId += o.trsByNodeId;
  }
  return { tool: 'scripts/rv-reference-baseline.mjs', plan: 769, entries: opts.entries ?? 'nontrivial', perCustomer, glbs, jsonOverrides, errors };
}

/**
 * Snapshot labels of private project GLBs that PUBLIC tests read by key (the large
 * reference-baseline acceptance, plan-769 9.13). Every other `private:` entry is
 * withheld from the public fixture: the public tree is a mirror, and a private
 * project's file list (customer and project names) is a disclosure.
 */
export const PUBLIC_PINNED_LABELS = ['private:projects/mauser3dhmi/models/MauserCageline30.glb'];

/** Default location of the withheld part: the private sibling's own test fixtures. */
export const PRIVATE_SNAPSHOT_FILE = resolve(WEB_ROOT, '..', 'realvirtual-WebViewer-Private~', 'tests', 'fixtures', 'reference-baseline.private.json');

/**
 * Split a `runBaseline` result into the public fixture (public GLBs + the pinned
 * private labels, per-customer totals of `public` only) and the private supplement
 * (every other private entry, full per-customer totals). Tests merge both `glbs`.
 */
export function splitSnapshot(result) {
  const isPublic = (label) => label.startsWith('public:') || PUBLIC_PINNED_LABELS.includes(label);
  const part = (obj, pub) => Object.fromEntries(Object.entries(obj ?? {}).filter(([l]) => isPublic(l) === pub));
  const head = { tool: result.tool, plan: result.plan, entries: result.entries };
  return {
    public: {
      ...head,
      perCustomer: Object.fromEntries(Object.entries(result.perCustomer ?? {}).filter(([c]) => c === 'public')),
      glbs: part(result.glbs, true), jsonOverrides: part(result.jsonOverrides, true), errors: part(result.errors, true),
    },
    private: {
      ...head,
      _comment: 'Private part of tests/fixtures/reference-baseline.json in realvirtual-WebViewer~ (written by scripts/rv-reference-baseline.mjs --out). Merged by the reference-baseline tests when present.',
      perCustomer: result.perCustomer ?? {},
      glbs: part(result.glbs, false), jsonOverrides: part(result.jsonOverrides, false), errors: part(result.errors, false),
    },
  };
}

function main(argv) {
  const roots = [];
  let out = null;
  let privateOut = PRIVATE_SNAPSHOT_FILE;
  let entries = 'nontrivial';
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') roots.push(resolve(argv[++i]));
    else if (a === '--out') out = resolve(argv[++i]);
    else if (a === '--private-out') privateOut = resolve(argv[++i]);
    else if (a === '--entries') entries = argv[++i];
    else if (a === '--quiet') quiet = true;
    else { process.stderr.write(`unknown argument ${a}\n`); process.exit(2); }
  }
  if (roots.length === 0) roots.push(resolve(WEB_ROOT, '..', 'realvirtual-WebViewer-Private~', 'projects'), resolve(WEB_ROOT, 'public'));
  const result = runBaseline(roots, { entries, quiet });
  if (out) {
    // The public fixture never carries withheld private entries; they go to the private sibling.
    const split = splitSnapshot(result);
    writeFileSync(out, JSON.stringify(split.public, null, 1) + '\n');
    process.stderr.write(`wrote ${out}\n`);
    if (Object.keys(split.private.glbs).length || Object.keys(split.private.jsonOverrides).length) {
      if (!existsSync(dirname(privateOut))) process.stderr.write(`private entries NOT written: ${dirname(privateOut)} missing\n`);
      else { writeFileSync(privateOut, JSON.stringify(split.private, null, 1) + '\n'); process.stderr.write(`wrote ${privateOut}\n`); }
    }
  }
  const rows = Object.entries(result.glbs)
    .filter(([, g]) => g.refs.total > 0)
    .map(([l, g]) => `${String(g.refs.total).padStart(6)} refs  guessOnly ${String(g.refs.guessOnly).padStart(4)}  disagree ${String(g.refs.disagree).padStart(4)}  after-unresolved ${String(g.refs.unresolved.missing + g.refs.unresolved.ambiguous).padStart(4)}  today-unresolved ${String(g.refs.todayUnresolved).padStart(4)}  ${l}`);
  process.stdout.write(rows.join('\n') + '\n');
  process.stdout.write(JSON.stringify(result.perCustomer, null, 1) + '\n');
  if (Object.keys(result.errors).length) process.stdout.write(`errors: ${JSON.stringify(result.errors, null, 1)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
