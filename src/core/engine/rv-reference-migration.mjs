// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-reference-migration.mjs — the migration of a file's stored PATH references into
 * node addresses (plan-769 F3/F4, Phase 1), on the file's glTF JSON alone.
 *
 * A Unity export carries no NodeIds and writes every reference as a path. On load the
 * viewer seeds the ids (`rv-node-id-seed.mjs`) and reads each written path through
 * THIS file's AUTHORED index — the raw `json.nodes[].name` joined by `/` — never
 * through the registry's guessing stages:
 *
 *   as written below the scene → as written below the content root (JSON mirror of
 *   `unwrapGltfRoot`, {@link contentRootOf}) → with a leading root-name segment
 *   stripped (below the scene, then below the content root) — in the authored index,
 *   then the same tries in the exact legacy Three.js (loader) spelling.
 *
 * The first try with an entry decides; an AMBIGUOUS entry is the answer (never a
 * reason to try another spelling — that would be a guess). The result is decode-site
 * independent: the main-model load (no unwrap), a placement (unwrapped) and the Node
 * scripts all get the same answer for the same bytes. A NAME field (`NAME_FIELDS`)
 * names a node: unique in the owner's subtree, else unique in the file, else — Unity
 * writes it as a path — the path rule above.
 *
 * Moved verbatim from the Phase-0 baseline (`scripts/rv-reference-baseline.mjs`, whose
 * snapshot `tests/fixtures/reference-baseline.json` is the acceptance reference: the
 * baseline now imports these functions, so the snapshot test pins exactly the code the
 * viewer runs). Known quirk kept on purpose for snapshot parity: the wrapper pattern
 * of {@link contentRootOf} reads `_d+` where `rv-gltf-unwrap.ts` has `_\d+` (a fix
 * moves content roots of `AuxScene_N` chains and needs a conscious re-baseline).
 *
 * Deliberately WITHOUT imports beyond the two sibling `.mjs` cores and without Node or
 * DOM APIs: the browser bundle, the Node scripts and both test runners load this file.
 */

import { visitReferences } from './rv-node-path-rewrite.mjs';

/** Index value of a path that names more than one node. */
export const AMBIGUOUS = -3;

/** `sanitizeLikeThree` of rv-three-names.ts (`THREE.PropertyBinding.sanitizeNodeName`). */
export function sanitizeLikeThree(name) {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

/** Trim, strip leading `/`, collapse `//` — the normalisation of rv-reference-resolver.ts. */
export function normalizeWrittenPath(path) {
  let p = String(path).trim();
  while (p.startsWith('/')) p = p.slice(1);
  return p.includes('//') ? p.replace(/\/{2,}/g, '/') : p;
}

// ─── Tree ───────────────────────────────────────────────────────────────

/**
 * `parent[i]` of every node of scene `json.scene ?? 0`: `-1` top level, `-2` not
 * reachable. A node reachable twice keeps its first parent in glTF order (the rule of
 * `canonicalAuthoredPaths`); for a tree this is `buildTree` of rv-glb-nodes.mjs.
 */
export function sceneParents(json) {
  const nodes = Array.isArray(json?.nodes) ? json.nodes : [];
  const parent = new Array(nodes.length).fill(-2);
  const scene = json?.scenes?.[json?.scene ?? 0];
  const roots = Array.isArray(scene?.nodes) ? scene.nodes : [];
  const stack = [];
  for (let k = roots.length - 1; k >= 0; k--) stack.push(roots[k], -1);
  while (stack.length > 0) {
    const p = stack.pop();
    const i = stack.pop();
    if (!Number.isInteger(i) || i < 0 || i >= nodes.length || parent[i] !== -2) continue;
    parent[i] = p;
    const kids = nodes[i]?.children;
    if (Array.isArray(kids)) for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k], i);
  }
  return parent;
}

/** Raw authored path (names joined by `/`, unescaped — how Unity writes) per node index. */
export function rawAuthoredPaths(json, parent) {
  const nodes = json.nodes ?? [];
  const out = new Array(nodes.length);
  const nameOf = (i) => (typeof nodes[i]?.name === 'string' ? nodes[i].name : '');
  const get = (i) => {
    if (out[i] !== undefined) return out[i];
    const p = parent[i];
    if (p === -2) return undefined;
    const v = p === -1 ? nameOf(i) : `${get(p)}/${nameOf(i)}`;
    out[i] = v;
    return v;
  };
  for (let i = 0; i < nodes.length; i++) if (parent[i] !== -2) get(i);
  return out;
}

/** Paths per index from per-index names (`names[i]`) along `parent` — the loader spelling. */
export function pathsFromNames(names, parent) {
  const out = new Array(names.length);
  const get = (i) => {
    if (out[i] !== undefined) return out[i];
    const p = parent[i];
    if (p === -2) return undefined;
    const n = names[i] ?? '';
    const v = p === -1 ? n : `${get(p)}/${n}`;
    out[i] = v;
    return v;
  };
  for (let i = 0; i < names.length; i++) if (parent[i] !== -2) get(i);
  return out;
}

const WRAPPER_RE = /^(?:__root__|auxscene)(?:_d+)*$/i;
const STRIP_NAMES = new Set(['default camera', 'hdrskybox']);

function rawName0(json, i) {
  const n = json.nodes?.[i]?.name;
  return typeof n === 'string' ? n : '';
}

/**
 * JSON mirror of `unwrapGltfRoot` (rv-gltf-unwrap.ts): node index of the content
 * root, `-1` = the scene itself. A glTF node with exactly one single-primitive
 * mesh IS a Mesh in three (`_loadNodeShallow`); a camera / light-only node is
 * not content.
 */
export function contentRootOf(json) {
  const nodes = json.nodes ?? [];
  const scene = json.scenes?.[json.scene ?? 0] ?? {};
  const nameOf = (i) => (i === -1 ? (typeof scene.name === 'string' ? scene.name : '') : rawName0(json, i));
  const kids = (i) => (i === -1 ? (scene.nodes ?? []) : (nodes[i]?.children ?? []));
  const isWrapper = (name) => !name || WRAPPER_RE.test(name) || /.?glb$/i.test(name);
  const isMesh = (i) => nodes[i]?.mesh !== undefined && (json.meshes?.[nodes[i].mesh]?.primitives?.length ?? 0) === 1;
  const isContent = (i) => {
    const n = nodes[i] ?? {};
    if (STRIP_NAMES.has(nameOf(i).toLowerCase())) return false;
    const only = n.mesh === undefined && !(n.children?.length);
    if (only && n.camera !== undefined) return false;
    if (only && n.extensions?.KHR_lights_punctual?.light !== undefined) return false;
    return true;
  };
  const hasContentChildren = (i) => kids(i).some((c) => isContent(c) && (isMesh(c) || kids(c).length > 0));
  let node = -1;
  for (let guard = 0; guard < 64; guard++) {
    if (!(isWrapper(nameOf(node)) || (kids(node).length <= 3 && !hasContentChildren(node)))) break;
    const content = kids(node).filter(isContent);
    if (content.length === 1 && !isMesh(content[0])) node = content[0];
    else break;
  }
  return node;
}

/** path → node index, {@link AMBIGUOUS} when several nodes share the path. */
export function indexPaths(paths) {
  const m = new Map();
  paths.forEach((p, i) => {
    if (p === undefined) return;
    m.set(p, m.has(p) ? AMBIGUOUS : i);
  });
  return m;
}

function rvOf(holder) {
  const rv = holder?.extras?.realvirtual;
  return rv && typeof rv === 'object' && !Array.isArray(rv) ? rv : null;
}

/** A non-embedded `AssetReference` node (foreign content behind it) — rv-glb-nodes.mjs' rule. */
export function isReferenceNodeJson(node) {
  const ref = rvOf(node)?.AssetReference;
  if (!ref || typeof ref !== 'object') return false;
  const named = (typeof ref.assetId === 'string' && ref.assetId) || (typeof ref.path === 'string' && ref.path);
  return !!named && ref.embedded !== true;
}

/** Is node `i` (inclusive) inside a non-embedded reference? */
export function insideReferenceJson(json, parent, i) {
  for (let cur = i; cur >= 0; cur = parent[cur]) if (isReferenceNodeJson(json.nodes[cur])) return true;
  return false;
}

// ─── Reference enumeration ──────────────────────────────────────────────

/** Location label of one visited position (`steps[0].targetObjects[1]`; a name field: its field). */
export function referenceFieldLabel(r) {
  return r.kind === 'name' ? r.field : fieldLabel(r.field, r.trail);
}

function fieldLabel(field, trail) {
  let s = field;
  for (const t of trail) s += typeof t === 'number' ? `[${t}]` : `.${t}`;
  return s;
}

/**
 * Every stored reference of one extras bag: `{ componentType, field, path, kind,
 * refType? }` with kind `ref` (ComponentReference), `path` (PATH_FIELDS) or `name`
 * (NAME_FIELDS); `field` is the location label (`steps[0].targetObjects[1]`). Empty
 * strings are not references. THE walk (`visitReferences`) in its by-key order.
 */
export function enumerateReferences(extras) {
  const out = [];
  visitReferences(extras, (r) => {
    if (typeof r.path !== 'string' || r.path.length === 0) return;
    const entry = { componentType: r.componentKey, field: r.kind === 'name' ? r.field : fieldLabel(r.field, r.trail), path: r.path, kind: r.kind };
    if (r.kind === 'ref') entry.refType = r.refComponentType;
    out.push(entry);
  });
  return out;
}

/**
 * The referrers of a file: the scene (lifted root components, `idx -1`) and every
 * reachable node outside foreign (referenced) content that carries rv extras.
 */
export function listReferrers(json, parent, isForeign) {
  const out = [];
  forEachReferrer(json, parent, isForeign, (idx, extras) => { out.push({ idx, extras }); });
  return out;
}

/** {@link listReferrers} without the list: `fn(idx, extras)` per referrer, in the same order. */
export function forEachReferrer(json, parent, isForeign, fn) {
  const nodes = json.nodes ?? [];
  const scene = json.scenes?.[json.scene ?? 0] ?? {};
  if (scene.extras?.realvirtual) fn(-1, scene.extras.realvirtual);
  for (let i = 0; i < nodes.length; i++) {
    if (parent[i] === -2 || isForeign(i)) continue;
    const rv = nodes[i]?.extras?.realvirtual;
    if (rv && typeof rv === 'object' && !Array.isArray(rv)) fn(i, rv);
  }
}

// ─── The migration context of one file ──────────────────────────────────

/** Up to this many children a tree-index step compares names in place instead of hashing a segment. */
const SCAN_CHILDREN = 16;

/**
 * A path index of one name spelling WITHOUT a map of every node's full path
 * (plan-769 9.15): `get(p)` answers what `indexPaths(paths).get(p)` answers for the
 * paths "names joined by `/` along `parent`" — the node index, {@link AMBIGUOUS}
 * when several nodes have exactly that path, `undefined` when none — by walking
 * down from the scene: a short child list is compared in place, a long one through
 * a child-name table (built on first visit). A name may contain `/`, so every
 * name that the rest starts with at a `/` (or at its end) is followed; every split
 * that consumes the whole path is a node with that path.
 * Hashing 70 000 full paths per decode to answer a few thousand lookups was the
 * cost this replaces.
 */
function createTreeIndex(parent, nameOf) {
  const N = parent.length;
  let start = null;
  let list = null;
  const buildChildren = () => {
    // Children of every reachable node from `parent` (slot 0 = the scene, i + 1 = node i).
    const count = new Int32Array(N + 2);
    for (let i = 0; i < N; i++) { const p = parent[i]; if (p !== -2) count[p + 2]++; }
    for (let s = 1; s < N + 2; s++) count[s] += count[s - 1];
    start = count;
    list = new Int32Array(N);
    const fill = start.slice(0, N + 1);
    for (let i = 0; i < N; i++) { const p = parent[i]; if (p !== -2) list[fill[p + 1]++] = i; }
  };
  const names = new Array(N);
  const nameAt = (i) => (names[i] ??= nameOf(i));
  const tables = new Array(N + 1);
  /** Child-name table of `node` (-1 = the scene): name → index | index[]; `slashed` = some name has a `/`. */
  const tableOf = (node) => {
    let t = tables[node + 1];
    if (t) return t;
    const byName = new Map();
    let slashed = false;
    for (let s = start[node + 1], e = start[node + 2]; s < e; s++) {
      const c = list[s];
      const name = nameAt(c);
      if (!slashed && name.includes('/')) slashed = true;
      const prev = byName.get(name);
      if (prev === undefined) byName.set(name, c);
      else if (typeof prev === 'number') byName.set(name, [prev, c]);
      else prev.push(c);
    }
    t = { byName, slashed };
    tables[node + 1] = t;
    return t;
  };
  let hits = 0;
  let hit = -1;
  /** Count the descendants of `node` whose path below it is `p.slice(from)` (stops at 2). */
  const descend = (node, p, from) => {
    if (!start) buildChildren();
    const s0 = start[node + 1];
    const e0 = start[node + 2];
    if (e0 - s0 <= SCAN_CHILDREN) {
      // A short child list is compared in place — no segment string, no hashing; a
      // name with `/` needs no special case here.
      for (let s = s0; s < e0 && hits < 2; s++) {
        const c = list[s];
        const name = nameAt(c);
        if (!p.startsWith(name, from)) continue;
        const end = from + name.length;
        if (end === p.length) { hits++; hit = c; } else if (p.charCodeAt(end) === 47 /* / */) descend(c, p, end + 1);
      }
      return;
    }
    const t = tableOf(node);
    if (!t.slashed) {
      const slash = p.indexOf('/', from);
      step(t.byName, slash === -1 ? p.slice(from) : p.slice(from, slash), p, slash);
      return;
    }
    for (let j = p.indexOf('/', from); j !== -1 && hits < 2; j = p.indexOf('/', j + 1)) step(t.byName, p.slice(from, j), p, j);
    if (hits < 2) step(t.byName, p.slice(from), p, -1);
  };
  /** The children named `name` = the segment of `p` ending at `end` (-1 = the end of `p`). */
  const step = (byName, name, p, end) => {
    const v = byName.get(name);
    if (v === undefined) return;
    if (typeof v === 'number') { follow(v, p, end); return; }
    for (let k = 0; k < v.length && hits < 2; k++) follow(v[k], p, end);
  };
  const follow = (child, p, end) => {
    if (end === -1) { hits++; hit = child; return; }
    descend(child, p, end + 1);
  };
  return {
    get(p) {
      hits = 0;
      hit = -1;
      descend(-1, p, 0);
      return hits === 0 ? undefined : hits === 1 ? hit : AMBIGUOUS;
    },
  };
}

/**
 * The F3 lookups of one file.
 *
 * @param json the glTF JSON (only `scene`, `scenes[].name/nodes`, `nodes[].name/children/
 *   mesh/camera/extensions` and `meshes[].primitives` are read).
 * @param opts.parent `parent[i]` (default {@link sceneParents}).
 * @param opts.legacyPaths asset-relative loader path per node index (the exact legacy
 *   Three.js spelling: rv-glb-nodes.mjs `referenceLookup().rel` in Node). Absent = no
 *   legacy step unless `legacyNames` is given.
 * @param opts.legacyNames the loader NAME per node index (the decoded objects' names in
 *   the browser) — the legacy paths are these joined by `/` along `parent`
 *   ({@link pathsFromNames}); an array, a function returning one, or — `legacyNameOf` —
 *   a function of ONE index, asked only for the nodes a legacy lookup visits. Ignored
 *   when `legacyPaths` is given.
 * @param opts.legacyRootName loader name of the content root (`rel.names[U]`).
 * @param opts.contentRoot the content root when the caller knows it ({@link contentRootOf}
 *   of the same file) — then `json` needs no mesh / camera / light data.
 *
 * The full-path tables `raw` / `authored` / `legacy` / `legacyPaths` are built on first
 * read (plan-769 9.15); the lookups themselves walk the tree ({@link createTreeIndex}).
 */
export function createMigrationContext(json, opts = {}) {
  const nodes = json.nodes ?? [];
  const scene = json.scenes?.[json.scene ?? 0] ?? {};
  const parent = opts.parent ?? sceneParents(json);
  const nameOf = (i) => (typeof nodes[i]?.name === 'string' ? nodes[i].name : '');
  let raw = null;
  const rawOf = () => (raw ??= rawAuthoredPaths(json, parent));
  /** Raw authored path of one node (without building {@link rawAuthoredPaths}). */
  const rawPathOf = (i) => {
    if (raw) return raw[i];
    if (i < 0 || i >= parent.length || parent[i] === -2) return undefined;
    const names = [];
    for (let cur = i; cur >= 0; cur = parent[cur]) names.push(nameOf(cur));
    return names.reverse().join('/');
  };
  const authoredIndex = createTreeIndex(parent, nameOf);
  let authored = null;

  const legacyPathsGiven = opts.legacyPaths ?? null;
  const legacyNameOfOpt = legacyPathsGiven ? null : (opts.legacyNameOf ?? null);
  const legacyNamesOpt = legacyPathsGiven || legacyNameOfOpt ? null : (opts.legacyNames ?? null);
  let legacyNames = null;
  const legacyNamesOf = () => {
    if (legacyNames) return legacyNames;
    if (legacyNameOfOpt) {
      legacyNames = new Array(parent.length);
      for (let i = 0; i < parent.length; i++) legacyNames[i] = legacyNameOfOpt(i);
    } else legacyNames = typeof legacyNamesOpt === 'function' ? legacyNamesOpt() : legacyNamesOpt;
    return legacyNames;
  };
  /** One node's loader name (`''` when none). */
  const legacyName = (i) => (legacyNameOfOpt && !legacyNames ? legacyNameOfOpt(i) : legacyNamesOf()[i]) ?? '';
  let legacyPathsBuilt = null;
  const hasLegacy = !!(legacyPathsGiven || legacyNamesOpt || legacyNameOfOpt);
  const legacyPathsOf = () => legacyPathsGiven ?? (hasLegacy ? (legacyPathsBuilt ??= pathsFromNames(legacyNamesOf(), parent)) : null);
  let legacyMap = null;
  let legacyIndex = null;
  /** The legacy index: the given paths as a map, or the loader names walked like the authored ones. */
  const legacyLookup = () => {
    if (legacyIndex) return legacyIndex;
    if (legacyPathsGiven) legacyIndex = (legacyMap ??= indexPaths(legacyPathsGiven));
    else legacyIndex = createTreeIndex(parent, legacyName);
    return legacyIndex;
  };
  const legacyBaseOf = (i) => {
    if (legacyPathsGiven) return legacyPathsGiven[i];
    if (legacyPathsBuilt) return legacyPathsBuilt[i];
    if (i < 0 || i >= parent.length || parent[i] === -2) return undefined;
    const out = [];
    for (let cur = i; cur >= 0; cur = parent[cur]) out.push(legacyName(cur));
    return out.reverse().join('/');
  };

  const sceneName = typeof scene.name === 'string' ? scene.name : '';
  const U = Number.isInteger(opts.contentRoot) ? opts.contentRoot : contentRootOf(json);
  // The content root's path in each spelling (the base of the 'content-root' tries).
  let rawU = null;
  const rawBaseU = () => (U < 0 ? undefined : (rawU ??= [rawPathOf(U)])[0]);
  let legacyU = null;
  const legacyBaseU = () => (U < 0 ? undefined : (legacyU ??= [legacyBaseOf(U)])[0]);
  const rootNames = new Set([sceneName, U >= 0 ? rawName0(json, U) : '', U >= 0 ? (opts.legacyRootName ?? '') : ''].filter(Boolean));
  const rootSanitized = new Set([...rootNames].map(sanitizeLikeThree));
  // Per distinct first segment (a file writes few): a root name, raw or in Three spelling?
  const rootSegmentMemo = new Map();
  const isRootSegment = (seg) => {
    let v = rootSegmentMemo.get(seg);
    if (v === undefined) {
      v = rootNames.has(seg) || rootSanitized.has(sanitizeLikeThree(seg));
      rootSegmentMemo.set(seg, v);
    }
    return v;
  };

  /**
   * plan-769 F3 lookup in ONE index (authored or legacy Three spelling): as
   * written below the scene, as written below the content root, then with a
   * leading root-name segment stripped (below the scene, below the content
   * root). The first step with an entry decides — an AMBIGUOUS entry is the
   * answer, never a reason to try another spelling (that would be a guess).
   * `baseU` = the content root's path in the index's spelling.
   */
  const lookUp = (index, p, baseU) => {
    const slash = p.indexOf('/');
    const first = slash === -1 ? p : p.slice(0, slash);
    const rooted = isRootSegment(first);
    // The bare root name IS the content root — decided before any index try.
    if (rooted && slash === -1) return { idx: U, step: 'root-stripped' };
    const v0 = index.get(p);
    if (v0 !== undefined) return { idx: v0, step: 'written' };
    const withBase = U >= 0 && baseU !== undefined;
    if (withBase) {
      const v = index.get(`${baseU}/${p}`);
      if (v !== undefined) return { idx: v, step: 'content-root' };
    }
    if (rooted) {
      const rest = p.slice(slash + 1);
      const v = index.get(rest);
      if (v !== undefined) return { idx: v, step: 'root-stripped' };
      if (withBase) {
        const w = index.get(`${baseU}/${rest}`);
        if (w !== undefined) return { idx: w, step: 'root-stripped' };
      }
    }
    return null;
  };
  /** {@link lookUp} with a map index and per-index base paths (the Phase-0 baseline's form). */
  const lookIn = (index, p, base) => lookUp(index, p, U >= 0 ? base[U] : undefined);

  /** `{ via, idx }` (idx `-1` = the scene) | `{ via: 'unresolved', reason }` | `{ via: 'empty' }`. */
  const migratePath = (written) => {
    const p = normalizeWrittenPath(written);
    if (p === '') return { via: 'empty' };
    const a = lookUp(authoredIndex, p, rawBaseU());
    if (a) return a.idx === AMBIGUOUS ? { via: 'unresolved', reason: 'ambiguous' } : { via: `authored${a.step === 'written' ? '' : `-${a.step}`}`, idx: a.idx };
    if (hasLegacy) {
      const l = lookUp(legacyLookup(), p, legacyBaseU());
      if (l) return l.idx === AMBIGUOUS ? { via: 'unresolved', reason: 'ambiguous' } : { via: `legacy-three${l.step === 'written' ? '' : `-${l.step}`}`, idx: l.idx };
    }
    return { via: 'unresolved', reason: 'missing' };
  };

  const rawName = (i) => (i === -1 ? sceneName : nameOf(i));
  const kidsOf = (i) => (i === -1 ? (scene.nodes ?? []) : (nodes[i]?.children ?? []));
  const namedUnder = (root, name) => {
    const hits = [];
    const stack = [root];
    while (stack.length) {
      const i = stack.pop();
      if (rawName(i) === name) hits.push(i);
      for (const c of kidsOf(i)) stack.push(c);
    }
    return hits;
  };
  /** NAME_FIELDS: unique in the owner's subtree, else unique in the file, else the path rule. */
  const migrateName = (name, owner) => {
    const own = namedUnder(owner, name);
    if (own.length === 1) return { via: 'authored-name-in-owner', idx: own[0] };
    if (own.length > 1) return { via: 'unresolved', reason: 'ambiguous' };
    const all = namedUnder(-1, name);
    if (all.length === 1) return { via: 'authored-name-in-file', idx: all[0] };
    if (all.length > 1) return { via: 'unresolved', reason: 'ambiguous' };
    // Unity writes the field as a PATH (`DemoCell/Turbine`); today's lookup falls
    // to the path chain the same way.
    const asPath = migratePath(name);
    return asPath.idx !== undefined ? { ...asPath, via: `name-as-path:${asPath.via}` } : asPath;
  };

  return {
    parent,
    get raw() { return rawOf(); },
    get authored() { return (authored ??= indexPaths(rawOf())); },
    get legacy() { return hasLegacy ? (legacyMap ??= indexPaths(legacyPathsOf())) : null; },
    get legacyPaths() { return legacyPathsOf(); },
    rawPathOf,
    U, sceneName, rootNames, lookIn, migratePath, migrateName,
  };
}

/**
 * The migration of every stored reference of one file (F3/F4): per reference the
 * referrer index, its location and the migration verdict — `idx` of the target
 * (`-1` = the scene) or `reason` (`missing` / `ambiguous`). Pure JSON; the caller turns
 * an `idx` into an address with the file's seeded ids.
 *
 * @returns {{ ctx: ReturnType<typeof createMigrationContext>, entries: Array<object> }}
 */
export function migrateFileReferences(json, opts = {}) {
  const ctx = createMigrationContext(json, opts);
  const isForeign = (i) => i >= 0 && insideReferenceJson(json, ctx.parent, i);
  const entries = [];
  for (const r of listReferrers(json, ctx.parent, isForeign)) {
    for (const ref of enumerateReferences(r.extras)) {
      const mig = ref.kind === 'name' ? ctx.migrateName(ref.path, r.idx) : ctx.migratePath(ref.path);
      entries.push({ referrer: r.idx, ...ref, mig });
    }
  }
  return { ctx, entries };
}
