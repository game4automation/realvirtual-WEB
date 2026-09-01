// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-audit-instruction-targets — offline GLB check: can the viewer still find
 * every `CustomRuntimeInstruction` target this model authors? (plan-734 F5)
 *
 * Why offline and without three.js: the answer depends only on the glTF JSON
 * chunk (node names + hierarchy + rv_extras). Reading it directly keeps the
 * check runnable in CI and on a delivery machine, and lets a 178 MB customer
 * model be audited in a second without a browser.
 *
 * What it models
 * --------------
 * Three.js' `GLTFLoader` renames nodes twice over:
 *   1. `PropertyBinding.sanitizeNodeName` — whitespace → `_`, then the reserved
 *      characters `[ ] . : /` are REMOVED (not replaced).
 *   2. `createUniqueName` — a FILE-GLOBAL `_N` suffix when the sanitized name is
 *      already taken. The namespace is shared by nodes, meshes, cameras and
 *      lights, and names are claimed in load order.
 *
 * `detectRenamedNodes()` then restores the raw name wherever step 2 did not
 * fire (pure sanitization). Wherever it DID fire, the node keeps its `_N` name
 * and the loader publishes a path alias instead.
 *
 * That alias is the whole point of this audit. Before plan-734 it was built
 * from the SANITIZED spelling of the original name, so an authored path through
 * a node that was deduplicated AND sanitized resolved against nothing — the
 * instruction card appeared but nothing highlighted and the camera never moved.
 *
 * `auditGlb` therefore reports each target twice: `resolvable` under the
 * pre-fix ("legacy") alias rule and under the current one. The delta is the
 * blast radius of the bug in that specific model; the current column is the
 * shipping gate.
 *
 * Usage:
 *   node scripts/rv-audit-instruction-targets.mjs <model.glb> [--json] [--all]
 *
 * Exit codes: 0 = every target resolvable · 1 = at least one is not ·
 * 2 = the file could not be read or is not a GLB.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Three.js naming parity ──────────────────────────────────────────────

/** Reserved track-binding characters Three.js strips from node names. */
const RESERVED_CHARS_RE = /[[\].:/]/g;

/**
 * Reproduce `THREE.PropertyBinding.sanitizeNodeName`: whitespace → `_`, then
 * strip `[ ] . : /`. Kept byte-identical to `src/core/engine/rv-three-names.ts`
 * — this script cannot import the TypeScript module, so the parity is pinned by
 * `tests/rv-audit-instruction-targets.node.test.ts` instead.
 */
export function sanitizeLikeThree(name) {
  return name.replace(/\s/g, '_').replace(RESERVED_CHARS_RE, '');
}

// ─── GLB container ───────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

/**
 * Extract the glTF JSON chunk from GLB bytes.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {object} the parsed glTF JSON
 */
export function readGlbJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('not a GLB file (bad magic)');
  }
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === CHUNK_JSON) {
      const text = new TextDecoder().decode(bytes.subarray(start, start + length));
      return JSON.parse(text);
    }
    offset = start + length;
  }
  throw new Error('no JSON chunk in GLB');
}

// ─── Name simulation ─────────────────────────────────────────────────────

/**
 * Replay `createUniqueName` over the file in load order and return, per glTF
 * node index, what the loader ends up doing to its name.
 *
 * Load order (GLTFLoader r185): `loadScene` walks its root nodes in order;
 * `_loadNodeShallow` reserves the NODE name first ("so the root has the
 * intended name"), then the node's mesh, then recurses into the children.
 * Meshes share the same namespace (`GLTFLoader.js:3895`), which is why a model
 * full of `Volumenkörper1` meshes pushes its equally-named NODES into `_N`.
 *
 * @returns {{ threeName: string, restored: boolean, deduped: boolean }[]}
 *   indexed by glTF node index. `restored` = pure sanitization, the loader puts
 *   the raw name back. `deduped` = a `_N` suffix was appended, the raw name is
 *   only reachable through an alias.
 */
export function simulateThreeNames(gltf) {
  const nodes = gltf.nodes ?? [];
  const meshes = gltf.meshes ?? [];
  const used = new Map(); // sanitized name → times claimed
  const out = nodes.map(() => null);
  const meshClaimed = new Set();

  const claim = (rawName) => {
    const sanitized = sanitizeLikeThree(rawName);
    const seen = used.get(sanitized);
    if (seen !== undefined) {
      used.set(sanitized, seen + 1);
      return { threeName: `${sanitized}_${seen + 1}`, deduped: true };
    }
    used.set(sanitized, 0);
    return { threeName: sanitized, deduped: false };
  };

  const visit = (index, guard) => {
    if (index < 0 || index >= nodes.length || guard.has(index)) return;
    guard.add(index);
    const def = nodes[index];
    const raw = def.name ?? '';
    if (raw) {
      const { threeName, deduped } = claim(raw);
      out[index] = {
        raw,
        // Pure sanitization → `detectRenamedNodes` restores the raw name.
        threeName: !deduped && threeName !== raw ? raw : threeName,
        restored: !deduped && threeName !== raw,
        deduped,
      };
    } else {
      out[index] = { raw: '', threeName: '', restored: false, deduped: false };
    }
    // The node's mesh claims its name before the children are walked.
    if (def.mesh !== undefined && !meshClaimed.has(def.mesh)) {
      meshClaimed.add(def.mesh);
      claim(meshes[def.mesh]?.name ?? `mesh_${def.mesh}`);
    }
    for (const child of def.children ?? []) visit(child, guard);
  };

  const guard = new Set();
  for (const scene of gltf.scenes ?? []) {
    for (const root of scene.nodes ?? []) visit(root, guard);
  }
  // Nodes outside any scene (skins, unreferenced) still consume names.
  for (let i = 0; i < nodes.length; i++) visit(i, guard);

  return out;
}

// ─── Path table ──────────────────────────────────────────────────────────

/**
 * Build every node's authored (raw) path and the paths the viewer's
 * `NodeRegistry` would actually hold.
 *
 * Path convention mirrors `NodeRegistry.computeNodePath`: the scene root is NOT
 * part of the path, so a root node's path is just its own name.
 *
 * @returns {{
 *   rawPath: string[], canonicalPath: string[],
 *   legacyAlias: (string|null)[], fixedAliases: string[][],
 *   info: object[]
 * }}
 */
export function buildPathTable(gltf) {
  const nodes = gltf.nodes ?? [];
  const info = simulateThreeNames(gltf);

  const rawPath = nodes.map(() => null);
  const canonicalPath = nodes.map(() => null);
  /** The alias `registerNodeAliases` publishes TODAY (post-fix): raw + sanitized. */
  const fixedAliases = nodes.map(() => []);
  /** The single alias it published BEFORE plan-734 (sanitized spelling only). */
  const legacyAlias = nodes.map(() => null);

  // Per node: the "original" spelling each rule contributes for its OWN segment.
  const legacySeg = (i) => (info[i].deduped ? sanitizeLikeThree(info[i].raw) : info[i].threeName);
  const rawSeg = (i) => (info[i].deduped ? info[i].raw : info[i].threeName);

  const walk = (index, rawPrefix, canonPrefix, legacyPrefix, fixedPrefixes, guard) => {
    if (index < 0 || index >= nodes.length || guard.has(index)) return;
    guard.add(index);
    const def = nodes[index];
    const i = info[index];

    const rp = rawPrefix ? `${rawPrefix}/${i.raw}` : i.raw;
    const cp = canonPrefix ? `${canonPrefix}/${i.threeName}` : i.threeName;
    const lp = legacyPrefix ? `${legacyPrefix}/${legacySeg(index)}` : legacySeg(index);
    // Post-fix: BOTH spellings per segment, cartesian but de-duplicated — a
    // segment whose raw and sanitized form agree does not double the set.
    const segs = [...new Set([rawSeg(index), legacySeg(index)])];
    const fp = [...new Set(
      fixedPrefixes.flatMap((p) => segs.map((s) => (p ? `${p}/${s}` : s))),
    )];

    rawPath[index] = rp;
    canonicalPath[index] = cp;
    legacyAlias[index] = lp === cp ? null : lp;
    fixedAliases[index] = fp.filter((p) => p !== cp);

    for (const child of def.children ?? []) walk(child, rp, cp, lp, fp, guard);
  };

  const guard = new Set();
  for (const scene of gltf.scenes ?? []) {
    for (const root of scene.nodes ?? []) walk(root, '', '', '', [''], guard);
  }

  return { rawPath, canonicalPath, legacyAlias, fixedAliases, info };
}

// ─── Resolution model ────────────────────────────────────────────────────

/** Last `/`-separated segment of a path. */
function lastSegment(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * Model `NodeRegistry._getNode`: exact → space-normalized → suffix match with
 * an ambiguity refusal → (post-fix) sanitize-normalized full-path match with
 * its own ambiguity refusal.
 *
 * @param {Map<string, number>} index registered path → node index
 * @param {Map<string, number[]>} suffixIndex leaf name → registered paths' node indices
 * @param {Map<string, string[]>} suffixPaths leaf name → registered paths
 * @param {Map<string, number|'AMBIGUOUS'>} sanitizedIndex only present post-fix
 */
function resolvePath(path, index, suffixPaths, sanitizedIndex) {
  const direct = index.get(path);
  if (direct !== undefined) return { node: direct, stage: 'exact' };

  const normalized = path.replace(/ /g, '_');
  if (normalized !== path) {
    const norm = index.get(normalized);
    if (norm !== undefined) return { node: norm, stage: 'space-normalized' };
  }

  const candidates = suffixPaths.get(lastSegment(path)) ?? [];
  let found = null;
  let hits = 0;
  for (const registered of candidates) {
    const matches = registered === path || registered.endsWith(`/${path}`)
      || (normalized !== path
        && (registered === normalized || registered.endsWith(`/${normalized}`)));
    if (!matches) continue;
    const node = index.get(registered);
    if (node === undefined) continue;
    if (found === null) { found = node; hits = 1; } else if (node !== found) hits++;
  }
  if (hits > 1) return { node: null, stage: 'ambiguous-suffix' };
  if (found !== null) return { node: found, stage: 'suffix' };

  if (sanitizedIndex) {
    const hit = sanitizedIndex.get(sanitizeLikeThree(path));
    if (hit === 'AMBIGUOUS') return { node: null, stage: 'ambiguous-sanitized' };
    if (hit !== undefined) return { node: hit, stage: 'sanitize-normalized' };
  }
  return { node: null, stage: 'miss' };
}

/** Build the registry index for one alias rule. */
function buildIndex(table, aliasesFor, withSanitizedStage) {
  const index = new Map();
  const suffixPaths = new Map();
  const add = (path, node) => {
    if (path === '' ) return;
    if (index.has(path)) return; // registerAlias never overwrites
    index.set(path, node);
    const leaf = lastSegment(path);
    let arr = suffixPaths.get(leaf);
    if (!arr) { arr = []; suffixPaths.set(leaf, arr); }
    arr.push(path);
  };
  let dropped = 0;
  for (let i = 0; i < table.canonicalPath.length; i++) {
    if (table.canonicalPath[i] !== null) add(table.canonicalPath[i], i);
  }
  for (let i = 0; i < table.canonicalPath.length; i++) {
    for (const alias of aliasesFor(i)) {
      if (index.has(alias)) { dropped++; continue; }
      add(alias, i);
    }
  }

  let sanitizedIndex = null;
  if (withSanitizedStage) {
    sanitizedIndex = new Map();
    for (const [path, node] of index) {
      const key = sanitizeLikeThree(path);
      const prev = sanitizedIndex.get(key);
      if (prev === undefined) sanitizedIndex.set(key, node);
      else if (prev !== node) sanitizedIndex.set(key, 'AMBIGUOUS');
    }
  }
  return { index, suffixPaths, sanitizedIndex, dropped };
}

// ─── rv_extras target extraction ─────────────────────────────────────────

/** Coerce one raw target reference (string or `{path}`) to a path. */
function parseTargetRef(t) {
  if (typeof t === 'string') return t.length > 0 ? t : null;
  if (t && typeof t === 'object' && typeof t.path === 'string' && t.path.length > 0) return t.path;
  return null;
}

/**
 * Every `CustomRuntimeInstruction` target in the file, in authoring order.
 *
 * Mirrors `parseStep()` in `rv-custom-runtime-instruction.ts`: the multi-target
 * `targetObjects` list plus the legacy single `targetObject`, de-duplicated per
 * step; `steps` may be a JSON array OR the legacy numeric-keyed object that
 * pre-export-fix GLBs carry.
 */
export function collectInstructionTargets(gltf) {
  const out = [];
  const nodes = gltf.nodes ?? [];
  for (let i = 0; i < nodes.length; i++) {
    const rv = nodes[i]?.extras?.realvirtual;
    const cri = rv?.CustomRuntimeInstruction;
    if (!cri) continue;
    const rawSteps = cri.steps;
    const list = Array.isArray(rawSteps)
      ? rawSteps
      : (rawSteps && typeof rawSteps === 'object' ? Object.values(rawSteps) : []);
    list.forEach((step, stepIndex) => {
      if (!step || typeof step !== 'object') return;
      const paths = [];
      if (Array.isArray(step.targetObjects)) {
        for (const t of step.targetObjects) {
          const p = parseTargetRef(t);
          if (p && !paths.includes(p)) paths.push(p);
        }
      }
      const legacy = parseTargetRef(step.targetObject);
      if (legacy && !paths.includes(legacy)) paths.push(legacy);
      for (const path of paths) {
        out.push({
          ownerNode: i,
          owner: nodes[i].name ?? `node_${i}`,
          step: stepIndex + 1,
          instruction: typeof step.instruction === 'string' ? step.instruction : '',
          path,
        });
      }
    });
  }
  return out;
}

// ─── Audit ───────────────────────────────────────────────────────────────

/**
 * Audit one GLB: which `CustomRuntimeInstruction` targets does the viewer
 * resolve, and which does it not?
 *
 * Exported so a CI gate can call it in-process instead of parsing stdout —
 * `validate-project.mjs` is the precedent, and the reason this one has a test.
 *
 * @param {Buffer|Uint8Array|object} input GLB bytes, or already-parsed glTF JSON.
 * @returns {{
 *   ok: boolean, nodes: number, meshes: number, targets: number,
 *   unresolvable: number, unresolvableLegacy: number,
 *   dedupedNodes: number, dedupedAndSanitized: number, droppedAliases: number,
 *   findings: object[]
 * }}
 */
export function auditGlb(input) {
  const gltf = (input instanceof Uint8Array) ? readGlbJson(input) : input;
  const table = buildPathTable(gltf);

  const legacy = buildIndex(table, (i) => (table.legacyAlias[i] ? [table.legacyAlias[i]] : []), false);
  const fixed = buildIndex(table, (i) => table.fixedAliases[i], true);

  // Authored-path table for the "is it even in the GLB?" verdict.
  const authored = new Map();
  const authoredSuffix = new Map();
  for (let i = 0; i < table.rawPath.length; i++) {
    const p = table.rawPath[i];
    if (p === null || p === '') continue;
    if (!authored.has(p)) authored.set(p, i);
    const leaf = lastSegment(p);
    let arr = authoredSuffix.get(leaf);
    if (!arr) { arr = []; authoredSuffix.set(leaf, arr); }
    arr.push(p);
  }

  let dedupedNodes = 0;
  let dedupedAndSanitized = 0;
  for (const i of table.info) {
    if (!i || !i.deduped) continue;
    dedupedNodes++;
    if (sanitizeLikeThree(i.raw) !== i.raw) dedupedAndSanitized++;
  }

  const findings = [];
  for (const target of collectInstructionTargets(gltf)) {
    const inGlb = authored.has(target.path)
      || (authoredSuffix.get(lastSegment(target.path)) ?? [])
        .some((p) => p === target.path || p.endsWith(`/${target.path}`));

    const before = resolvePath(target.path, legacy.index, legacy.suffixPaths, null);
    const after = resolvePath(target.path, fixed.index, fixed.suffixPaths, fixed.sanitizedIndex);

    let status;
    if (after.node !== null) status = 'resolvable';
    else if (!inGlb) status = 'path not in GLB';
    else status = 'unresolvable';

    // Which segment broke it? The first one that Three both deduped and
    // sanitized is the culprit the fix addresses.
    let culprit = null;
    if (before.node === null && inGlb) {
      const idx = authored.get(target.path)
        ?? table.rawPath.findIndex((p) => p !== null && p.endsWith(`/${target.path}`));
      if (idx >= 0) {
        const segments = table.rawPath[idx].split('/');
        // Walk the chain from the root and find the offending ancestor.
        let acc = '';
        for (const seg of segments) {
          acc = acc ? `${acc}/${seg}` : seg;
          const node = table.rawPath.indexOf(acc);
          const meta = node >= 0 ? table.info[node] : null;
          if (meta?.deduped && sanitizeLikeThree(meta.raw) !== meta.raw) { culprit = seg; break; }
        }
      }
    }

    findings.push({
      owner: target.owner,
      step: target.step,
      instruction: target.instruction.slice(0, 60),
      path: target.path,
      status,
      inGlb,
      stageBefore: before.stage,
      stageAfter: after.stage,
      resolvableBefore: before.node !== null,
      culprit,
    });
  }

  const unresolvable = findings.filter((f) => f.status !== 'resolvable').length;
  const unresolvableLegacy = findings.filter((f) => !f.resolvableBefore).length;

  return {
    ok: unresolvable === 0,
    nodes: (gltf.nodes ?? []).length,
    meshes: (gltf.meshes ?? []).length,
    targets: findings.length,
    unresolvable,
    unresolvableLegacy,
    dedupedNodes,
    dedupedAndSanitized,
    droppedAliases: fixed.dropped,
    findings,
  };
}

/** Read a GLB from disk and audit it. */
export function auditGlbFile(path) {
  return auditGlb(new Uint8Array(readFileSync(path)));
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function main(argv) {
  const asJson = argv.includes('--json');
  const showAll = argv.includes('--all');
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node scripts/rv-audit-instruction-targets.mjs <model.glb> [--json] [--all]');
    return 2;
  }
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    console.error(`error: not a file: ${path}`);
    return 2;
  }

  let result;
  try {
    result = auditGlbFile(path);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  console.log(`nodes ${result.nodes} · meshes ${result.meshes} · targets ${result.targets}`);
  console.log(`deduped nodes ${result.dedupedNodes} · deduped+sanitized ${result.dedupedAndSanitized}`
    + ` · dropped aliases ${result.droppedAliases}`);
  console.log(`unresolvable: ${result.unresolvable} (before plan-734: ${result.unresolvableLegacy})`);
  for (const f of result.findings) {
    if (!showAll && f.status === 'resolvable' && f.resolvableBefore) continue;
    const mark = f.status === 'resolvable' ? 'OK  ' : 'FAIL';
    const why = f.status === 'resolvable'
      ? `via ${f.stageAfter}${f.resolvableBefore ? '' : ' (was broken before plan-734)'}`
      : (f.status === 'path not in GLB'
        ? 'path not in GLB'
        : `unresolvable${f.culprit ? ` (segment "${f.culprit}" is deduped AND sanitized)` : ''}`);
    console.log(`  ${mark} ${f.owner} step ${f.step}: "${f.path}" — ${why}`);
  }
  return result.ok ? 0 : 1;
}

// Importing this module must not terminate its host (the node test imports it).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
