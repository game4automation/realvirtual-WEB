// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-path-rewrite.mjs — THE rewrite core for stored node paths (plan-610 Phase 1).
 *
 * Renaming or moving a node changes the canonical path of the node and of its whole
 * subtree. Every stored reference to one of those nodes — a `ComponentReference`
 * anywhere inside a component's rv extras, a declared path-string field
 * ({@link PATH_FIELDS}) or a declared name field ({@link NAME_FIELDS}) — has to be
 * rewritten in the SAME step, or it silently breaks on the next save + reload.
 *
 * This module PLANS that rewrite; it never mutates its input. Two writers share it:
 *   - the WEB editor (`AssetDocument` turns the steps into `setField` ops of ONE
 *     composite, so structure change + rewrite are one undo step — plan-610 Phase 2);
 *   - the Node GLB scripts (`scripts/lib/rv-glb-nodes.mjs`, plan-610 Phase 4).
 *
 * Deliberately WITHOUT imports and without Node or DOM APIs: plain JS, so the browser
 * bundle, the Node scripts and both test runners load the very same file (pattern of
 * `rv-cinematic-manifest.mjs`). Everything that needs a scene — resolving a written path
 * against the state BEFORE the change, telling whether a referrer lives in foreign
 * (referenced) content — is injected by the caller.
 *
 * Rules:
 *   - Segment boundary: `PLC` matches `PLC` and `PLC/X`, never `PLC_Programs`.
 *   - Spelling is kept: an asset-relative path stays relative, a root-prefixed (Unity)
 *     path stays root-prefixed (with the author's own root segment).
 *   - A reference that resolved only by a fallback stage (alias, suffix, sanitized, …)
 *     onto a moved node is HEALED onto the exact new path, in its spelling.
 *   - Except one written in the AUTHORED names of the moved node (`_rvOrigName` of a
 *     loader dedup, plan-765 F2b): given `authoredMoves`, it is rewritten in authored
 *     names, never healed onto the loader's `_N` spelling.
 *   - Several hits in one top-level field (an array, records inside an array) become ONE
 *     step carrying the complete new field value — the editor writes top-level keys.
 *   - Idempotent: the planned values point at the new paths; a second run with the same
 *     map over the rewritten state plans nothing.
 *   - A name field is rewritten only when it resolves UNIQUELY to a renamed node; an
 *     ambiguous one is a warning, never a write.
 */

/**
 * Declared path-string fields (values are node paths, read RAW by their component, so the
 * schema never sees them as references). A dotted field walks into records and arrays of
 * records at every segment (`connections.source` = every `connections[i].source`) — the
 * notation of `REFERENCE_BAKE_TARGETS` (rv-bake-survival.ts), which derives its
 * path-string entries from this table. A leaf value is a string, a legacy `{ path }`
 * record, or an array of those. `shape` documents the stored form only; the walker
 * handles all of them the same way.
 *
 * NOT here: `Kinematic.GroupNamePrefix` / `Group.GroupNamePrefix` (a group-name prefix,
 * not a path — it stays a bake-only entry), `JumpOnSignal.JumpToStep` (a step name),
 * signal names (operator panel, ST, WebSensor), `AssetOverrides.byPath` (keys relative
 * to the referenced asset). `MechanismPath.StartNextPath` / `IKPath.StartNextPath` are
 * `ComponentReference` objects (read raw, but in the reference shape) and are covered by
 * the generic walk, not by this table.
 */
export const PATH_FIELDS = Object.freeze([
  // Instruction steps outline / isolate their targets (rv-custom-runtime-instruction.ts parseStep).
  Object.freeze({ component: 'CustomRuntimeInstruction', field: 'steps.targetObjects', shape: 'deep' }),
  Object.freeze({ component: 'CustomRuntimeInstruction', field: 'steps.targetObject', shape: 'deep' }),
  // Kinematic re-parent target, resolved by the Kinematic prepare hook.
  Object.freeze({ component: 'Kinematic', field: 'Parent', shape: 'path' }),
  // Physics zone static walls, a raw string array (rv-physics-zone.ts).
  Object.freeze({ component: 'WebPhysicsZone', field: 'StaticColliders', shape: 'pathArray' }),
  // RvConnection edges of the rv-ODT `Connections` block.
  Object.freeze({ component: 'Connections', field: 'connections.source', shape: 'path' }),
  Object.freeze({ component: 'Connections', field: 'connections.target', shape: 'path' }),
  // The object a LogicStep_Enable shows / hides (rv-logic-engine.ts, read raw; plan-769:
  // migrated on load and written as an address like every other path field).
  Object.freeze({ component: 'LogicStep_Enable', field: 'Target', shape: 'path' }),
  // A robot's tool centre point. Unity's exporter serialises a GameObject field as a
  // bare path STRING (GLBComponentSerializer), so the schema never sees it as a
  // reference and `resolveTcpNode()` reads it raw — which also means nothing claimed
  // the node for the bake. Measured on DemoRobotIK.glb: unbaked the TCP resolves and
  // the chain carries a 0.2399 m tool offset; baked (the production path — the viewer
  // always passes a `bakeRegistry`) the node is gone, `getTcpNode()` is null and both
  // the offset and the tool rotation collapse to identity, so every live solve lands
  // ~240 mm / 180° off. Declaring it here gives the bake its target, and brings the
  // rename/move rewrite and the reference audit with it.
  Object.freeze({ component: 'RobotIK', field: 'TCP', shape: 'path' }),
  // The node a Source parents its new MUs to (Unity `Source.Destination`, a GameObject
  // field the exporter writes as a bare path string; plan-2016 S1). Read raw by RVSource.
  Object.freeze({ component: 'Source', field: 'Destination', shape: 'path' }),
  // The node a Grip aligns a picked MU to (Unity `Grip.PickAlignWithObject`, a GameObject
  // field written as a bare path string; plan-2016 S4). Read raw by RVGrip.
  Object.freeze({ component: 'Grip', field: 'PickAlignWithObject', shape: 'path' }),
]);

/**
 * Declared name fields: the value is a NODE NAME looked up in the owner's subtree, then
 * in the registry (`RVSource`, `findNameInSubtreeTarget`). Rewritten only on a rename of
 * the uniquely resolved target.
 */
export const NAME_FIELDS = Object.freeze([
  Object.freeze({ component: 'Source', field: 'ThisObjectAsMU' }),
]);

/**
 * Is `v` a raw rv-ODT `ComponentReference` in ANY stored form (plan-769 Phase 3)?
 *  - legacy / Unity: `{ type: 'ComponentReference', path, componentType }`;
 *  - address: `{ type: 'ComponentReference', address, componentType, componentIndex? }`;
 *  - kept unresolved: `{ type: 'ComponentReference', unresolvedPath, reason, componentType }`.
 * THE guard: a reference in the address form is a reference to every walker, not an
 * unknown record. `path` is therefore OPTIONAL on a hit — read the written form through
 * {@link storedReferenceForm}, never `v.path` blindly.
 */
export function isComponentReference(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && v.type === 'ComponentReference'
    && (typeof v.path === 'string' || typeof v.address === 'string' || typeof v.unresolvedPath === 'string');
}

/** The reasons an `unresolvedPath` may carry (rv-ODT §5a, plan-769 F4). */
const UNRESOLVED_REASONS = new Set(['missing', 'ambiguous', 'synthetic-target']);

/**
 * The stored FORM of one reference value (plan-769 Phase 3) — a ComponentReference,
 * a path-field leaf (string, `{ path }`, `{ address }`, `{ unresolvedPath, reason }`):
 *  - `{ form: 'path', path }` — a path (Unity export, or written this session);
 *  - `{ form: 'address', address }` — `#id`, `p#id`, `p/b#id` relative to its file;
 *  - `{ form: 'unresolved', unresolvedPath, reason }` — kept, never guessed (D7);
 *  - `null` — no reference (empty string, anything else).
 * An address wins over a path on a (malformed) value carrying both.
 */
export function storedReferenceForm(v) {
  if (typeof v === 'string') return v.length > 0 ? { form: 'path', path: v } : null;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  if (typeof v.address === 'string' && v.address.length > 0) return { form: 'address', address: v.address };
  if (typeof v.unresolvedPath === 'string') {
    const reason = UNRESOLVED_REASONS.has(v.reason) ? v.reason : 'missing';
    return { form: 'unresolved', unresolvedPath: v.unresolvedPath, reason };
  }
  if (typeof v.path === 'string' && v.path.length > 0) return { form: 'path', path: v.path };
  return null;
}

/**
 * What a READER hands `NodeRegistry.readStoredRef` / `storedNode` for one stored value:
 * the written path string for the path form, `{ address }` / `{ unresolvedPath, reason }`
 * for the others, `null` for no reference. The one adapter every raw reader uses instead
 * of `ref.path`, so an address-form reference is read, not dropped.
 */
export function storedReferenceValue(v) {
  const f = storedReferenceForm(v);
  if (!f) return null;
  if (f.form === 'path') return f.path;
  if (f.form === 'address') return { address: f.address };
  return { unresolvedPath: f.unresolvedPath, reason: f.reason };
}

/** A human label of a stored value: its path, its kept path, or its address. `null` = none. */
export function storedReferenceLabel(v) {
  const f = storedReferenceForm(v);
  if (!f) return null;
  return f.form === 'path' ? f.path : f.form === 'address' ? f.address : f.unresolvedPath;
}

/**
 * Segment-boundary prefix test: `path` is `oldPath` itself or lies below it.
 * `matchesPrefix('PLC/FG01/X', 'PLC')` → true, `matchesPrefix('PLC_Programs', 'PLC')` → false.
 * An empty `oldPath` is the origin and matches every path.
 */
export function matchesPrefix(path, oldPath) {
  if (typeof path !== 'string' || typeof oldPath !== 'string') return false;
  if (oldPath === '') return true;
  return path === oldPath || (path.length > oldPath.length && path.startsWith(oldPath) && path.charCodeAt(oldPath.length) === 47 /* '/' */);
}

/** Trim, strip leading `/`, collapse `//` — the normalisation of rv-reference-resolver.ts. */
function normalizePath(path) {
  let p = String(path).trim();
  while (p.startsWith('/')) p = p.slice(1);
  return p.replace(/\/{2,}/g, '/');
}

function segmentsOf(path) {
  return path === '' ? [] : path.split('/');
}

function leafOf(path) {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** `relativeToRoot` of rv-reference-resolver.ts; `null` when `path` lies outside `rootPath`. */
function relativeTo(path, rootPath) {
  if (rootPath === '') return path;
  if (path === rootPath) return '';
  return path.startsWith(rootPath + '/') ? path.slice(rootPath.length + 1) : null;
}

/**
 * The new written form of a reference whose target moved from `oldCanonical` to
 * `newCanonical`, in the spelling it was written in.
 *
 *  - `'relative'`: written relative to the scope root (`Mount/Kine` in scope `Machine`);
 *    an unscoped path is the special case `scopeRootPath === ''`.
 *  - `'root-prefixed'`: the first written segment names the scope root (`Machine/Mount/Kine`,
 *    the Unity form); that segment is kept exactly as the author wrote it.
 *
 * `scopeRootPath` is the scope root's canonical path. Without it, it is derived from the
 * written path (the written tail must have as many segments as the canonical tail) — exact
 * for paths that resolved as written or root-stripped, NOT for suffix/alias fallbacks.
 *
 * Returns `null` when the new target lies outside the scope (a relative spelling cannot
 * express it) or the scope cannot be derived.
 */
export function respell(writtenPath, oldCanonical, newCanonical, spelling, scopeRootPath) {
  const w = normalizePath(writtenPath);
  const oc = normalizePath(oldCanonical);
  const nc = normalizePath(newCanonical);
  const wSegs = segmentsOf(w);
  let root;
  if (typeof scopeRootPath === 'string') {
    root = normalizePath(scopeRootPath);
  } else {
    const tailLen = spelling === 'root-prefixed' ? wSegs.length - 1 : wSegs.length;
    const ocSegs = segmentsOf(oc);
    if (tailLen < 0 || tailLen > ocSegs.length) return null;
    root = ocSegs.slice(0, ocSegs.length - tailLen).join('/');
  }
  const rel = relativeTo(nc, root);
  if (rel === null) return null;
  if (spelling === 'root-prefixed') {
    const head = wSegs.length > 0 ? wSegs[0] : leafOf(root);
    if (head === '') return null;
    return rel === '' ? head : `${head}/${rel}`;
  }
  return rel;
}

/** Map a canonical path through `moves` (exact entry, else the deepest moved ancestor). */
function mapPath(moves, path) {
  const exact = moves.get(path);
  if (exact !== undefined) return exact;
  let i = path.lastIndexOf('/');
  while (i > 0) {
    const prefix = path.slice(0, i);
    const hit = moves.get(prefix);
    if (hit !== undefined) return hit + path.slice(i);
    i = path.lastIndexOf('/', i - 1);
  }
  return null;
}

/**
 * Does the written path's tail (all segments; for `'root-prefixed'` all but the head)
 * equal the last segments of `canonical`, segment by segment? With an AUTHORED
 * `canonical` this is "written in the authored names of exactly this node" (plan-765).
 */
export function writtenTailMatches(writtenPath, canonical, spelling) {
  const wSegs = segmentsOf(normalizePath(writtenPath));
  const tail = spelling === 'root-prefixed' ? wSegs.slice(1) : wSegs;
  const cSegs = segmentsOf(normalizePath(canonical));
  if (tail.length === 0 || tail.length > cSegs.length) return false;
  const off = cSegs.length - tail.length;
  for (let i = 0; i < tail.length; i++) if (tail[i] !== cSegs[off + i]) return false;
  return true;
}

/** Table entries of an extras key, with the `_N` dedup fallback (`Kinematic_1` → `Kinematic`). */
function entriesOf(table, component) {
  const exact = table.filter((e) => e.component === component);
  if (exact.length > 0) return exact;
  const base = component.replace(/_\d+$/, '');
  return base === component ? exact : table.filter((e) => e.component === base);
}

/** Per table: extras key → its entries (the walk asks once per component record). */
const _entriesCache = new WeakMap();

function cachedEntriesOf(table, component) {
  let perKey = _entriesCache.get(table);
  if (!perKey) { perKey = new Map(); _entriesCache.set(table, perKey); }
  let entries = perKey.get(component);
  if (!entries) { entries = entriesOf(table, component); perKey.set(component, entries); }
  return entries;
}

/**
 * THE walk over every stored node reference of one node's rv extras (plan-769 F1,
 * Phase 1): every `ComponentReference` at any depth, every declared path-string field
 * ({@link PATH_FIELDS}) and every declared name field ({@link NAME_FIELDS}). The ONE
 * enumeration the reference audit, the migration on load (`rv-reference-migration.mjs`)
 * and the Phase-0 baseline share; `planReferenceRewrite` below keeps its own
 * copy-on-write walk over the SAME positions (pinned by
 * `tests/characterise-769-reference-walker.node.test.ts`).
 *
 * Every position is visited, empty strings included — what counts as "no reference"
 * (`''`, whitespace) is the caller's rule. A `ComponentReference` inside a declared
 * path field is visited ONCE, as a reference. `visit` receives:
 *  - `componentKey` — the extras key (`Kinematic_1`); `field` — its top-level key;
 *  - `trail` — the location below `field` (array indices as numbers, record keys as
 *    strings; a legacy `{ path }` record of a path field ends at the record, its
 *    `record` flag is set);
 *  - `kind` — `'ref'` (ComponentReference), `'path'` (path field), `'name'` (name field);
 *  - `path` — the written path / name; `refComponentType` for a reference;
 *  - `declared` — the dotted table entry of a path / name field;
 *  - `value` — the value at the position; `set(next)` — replace it IN PLACE (the
 *    caller owns the extras; the walker never copies).
 *
 * @param {Record<string, unknown> | null | undefined} extras
 * @param {(ref: import('./rv-node-path-rewrite.d.mts').VisitedReference) => void} visit
 * @param {import('./rv-node-path-rewrite.d.mts').VisitReferencesOptions} [opts]
 */
export function visitReferences(extras, visit, opts) {
  if (!extras || typeof extras !== 'object') return;
  const pathFields = opts?.pathFields ?? PATH_FIELDS;
  const nameFields = opts?.nameFields ?? NAME_FIELDS;
  const skip = typeof opts?.skipComponent === 'function' ? opts.skipComponent : null;
  const refsFirst = opts?.order === 'refs-first';
  // plan-769 9.15: this walk runs over every component of every node on each decode
  // (the large CAD line: 308 000 component records), so it allocates nothing for a value that
  // cannot hold a reference: no trail copy while descending (one stack, copied only
  // for a visited position), no per-component closure, one table lookup per component,
  // and keys through `for…in` (V8's enum cache, no key array) wherever that is exactly
  // `Object.keys`: a plain object while Object.prototype has no enumerable key
  // (checked per walk) — else `Object.keys`.
  // The walk state is pooled (a visitor may start another walk, so a stack, not one object).
  const cx = _walkStates.pop() ?? { visit: null, componentKey: '', trail: [], ownKeysOnly: false, tables: null, skip: null, refsFirst: false };
  cx.visit = visit;
  cx.componentKey = '';
  cx.trail.length = 0;
  cx.ownKeysOnly = !hasInheritedEnumerableKeys();
  cx.tables = entryTablesOf(pathFields, nameFields);
  cx.skip = skip;
  cx.refsFirst = refsFirst;
  try {
    if (cx.ownKeysOnly && Object.getPrototypeOf(extras) === Object.prototype) {
      for (const componentKey in extras) visitComponent(cx, extras, componentKey);
    } else {
      for (const componentKey of Object.keys(extras)) visitComponent(cx, extras, componentKey);
    }
  } finally {
    cx.visit = null;
    cx.skip = null;
    cx.tables = null;
    _walkStates.push(cx);
  }
}

/** Idle walk states of {@link visitReferences}. */
const _walkStates = [];

/** Every reference position of ONE component record `extras[componentKey]`. */
function visitComponent(cx, extras, componentKey) {
  if (cx.skip && cx.skip(componentKey)) return;
  const record = extras[componentKey];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return;
  cx.componentKey = componentKey;

  const entries = cx.tables.of(componentKey);
  const declared = entries.declared;
  if (cx.refsFirst) {
    walkRecord(cx, record);
    for (const e of declared) declaredAt(cx, record, e);
  } else if (declared.length === 0) {
    walkRecord(cx, record);
  } else {
    for (const key of Object.keys(record)) {
      const v = record[key];
      if (v !== null && typeof v === 'object') walkRefs(cx, v, key, record, key);
      for (const e of declared) if (e.field.split('.')[0] === key) declaredAt(cx, record, e);
    }
  }
  for (const e of entries.names) {
    const name = record[e.field];
    if (typeof name === 'string') emitRef(cx, 'name', e.field, [], name, name, record, e.field, { declared: e.field, form: 'path' });
    // plan-769 Phase 3: a web save stores the name field's TARGET as `{ address }`
    // (or `{ unresolvedPath, reason }`) — the name it was written as is gone.
    else if (name && typeof name === 'object' && !Array.isArray(name)
      && (typeof name.address === 'string' || typeof name.unresolvedPath === 'string')) {
      emitRef(cx, 'name', e.field, [], '', name, record, e.field, { declared: e.field, ...formOf(name) });
    }
  }
}

/** Any enumerable key a plain object would inherit (then `for…in` ≠ `Object.keys`)? */
function hasInheritedEnumerableKeys() {
  // eslint-disable-next-line no-unreachable-loop
  for (const _ in EMPTY_OBJECT) return true;
  return false;
}
const EMPTY_OBJECT = {};

/** {@link walkRefs} over every value of a component record (by-key order). */
function walkRecord(cx, record) {
  if (cx.ownKeysOnly && Object.getPrototypeOf(record) === Object.prototype) {
    for (const key in record) {
      const v = record[key];
      if (v !== null && typeof v === 'object') walkRefs(cx, v, key, record, key);
    }
    return;
  }
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (v !== null && typeof v === 'object') walkRefs(cx, v, key, record, key);
  }
}

/**
 * Per (path table, name table): extras key → `{ declared, names }` — the entries of
 * both tables for one component, ONE map lookup per component record.
 */
const _entryTables = new WeakMap();
function entryTablesOf(pathFields, nameFields) {
  let byName = _entryTables.get(pathFields);
  if (!byName) { byName = new WeakMap(); _entryTables.set(pathFields, byName); }
  let t = byName.get(nameFields);
  if (!t) {
    const perKey = new Map();
    t = {
      of(componentKey) {
        let e = perKey.get(componentKey);
        if (!e) {
          e = { declared: cachedEntriesOf(pathFields, componentKey), names: cachedEntriesOf(nameFields, componentKey) };
          perKey.set(componentKey, e);
        }
        return e;
      },
    };
    byName.set(nameFields, t);
  }
  return t;
}

/** One visited position of {@link visitReferences} (`cx` = the visitor + current component key). */
function emitRef(cx, kind, field, trail, path, value, container, key, extra) {
  cx.visit({
    componentKey: cx.componentKey, field, trail, kind, path, value,
    ...extra,
    set: (next) => { container[key] = next; },
  });
}

// plan-769 Phase 3: the stored form travels with every position. `path` is the
// written path of the PATH form only (`''` for an address / a kept path), so a
// consumer that reads paths never mistakes an address for one.
function formOf(value) {
  const f = storedReferenceForm(value);
  if (!f || f.form === 'path') return { form: 'path' };
  return f.form === 'address'
    ? { form: 'address', address: f.address }
    : { form: 'unresolved', unresolvedPath: f.unresolvedPath, reason: f.reason };
}

function writtenOf(f, path) {
  return f.form === 'path' ? path : '';
}

/**
 * The visited position of a ComponentReference — what `emitRef(cx, 'ref', …, { ...formOf(value),
 * refComponentType? })` builds, as ONE object literal per form (same keys, same order):
 * this runs once per reference of every decoded file.
 */
function emitComponentRef(cx, value, field, container, key) {
  const componentKey = cx.componentKey;
  const trail = cx.trail.slice();
  const set = (next) => { container[key] = next; };
  const typed = typeof value.componentType === 'string';
  let pos;
  if (typeof value.address === 'string' && value.address.length > 0) {
    const address = value.address;
    pos = typed
      ? { componentKey, field, trail, kind: 'ref', path: '', value, form: 'address', address, refComponentType: value.componentType, set }
      : { componentKey, field, trail, kind: 'ref', path: '', value, form: 'address', address, set };
  } else if (typeof value.unresolvedPath === 'string') {
    const unresolvedPath = value.unresolvedPath;
    const reason = UNRESOLVED_REASONS.has(value.reason) ? value.reason : 'missing';
    pos = typed
      ? { componentKey, field, trail, kind: 'ref', path: '', value, form: 'unresolved', unresolvedPath, reason, refComponentType: value.componentType, set }
      : { componentKey, field, trail, kind: 'ref', path: '', value, form: 'unresolved', unresolvedPath, reason, set };
  } else {
    const path = typeof value.path === 'string' ? value.path : '';
    pos = typed
      ? { componentKey, field, trail, kind: 'ref', path, value, form: 'path', refComponentType: value.componentType, set }
      : { componentKey, field, trail, kind: 'ref', path, value, form: 'path', set };
  }
  cx.visit(pos);
}

/**
 * Every ComponentReference at any depth below an OBJECT value (primitives never reach
 * here). `cx.trail` holds the location of `value` below `field`; a visited position
 * gets its own copy.
 */
function walkRefs(cx, value, field, container, key) {
  if (isComponentReference(value)) {
    emitComponentRef(cx, value, field, container, key);
    return;
  }
  const trail = cx.trail;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (v !== null && typeof v === 'object') { trail.push(i); walkRefs(cx, v, field, value, i); trail.pop(); }
    }
    return;
  }
  if (cx.ownKeysOnly && Object.getPrototypeOf(value) === Object.prototype) {
    for (const k in value) {
      const v = value[k];
      if (v !== null && typeof v === 'object') { trail.push(k); walkRefs(cx, v, field, value, k); trail.pop(); }
    }
    return;
  }
  for (const k of Object.keys(value)) {
    const v = value[k];
    if (v !== null && typeof v === 'object') { trail.push(k); walkRefs(cx, v, field, value, k); trail.pop(); }
  }
}

function leafRef(cx, value, field, trail, container, key, declared) {
  if (typeof value === 'string') { emitRef(cx, 'path', field, trail, value, value, container, key, { declared, form: 'path' }); return; }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) leafRef(cx, value[i], field, [...trail, i], value, i, declared);
    return;
  }
  // A ComponentReference is the generic walk's business — never visited twice.
  if (value && typeof value === 'object' && !isComponentReference(value)) {
    // A legacy `{ path }` record, or (plan-769 Phase 3) the stored `{ address }` /
    // `{ unresolvedPath, reason }` of a path field.
    if (typeof value.address === 'string' || typeof value.unresolvedPath === 'string') {
      const f = formOf(value);
      emitRef(cx, 'path', field, trail, '', value, container, key, { declared, record: true, ...f });
    } else if (typeof value.path === 'string') {
      emitRef(cx, 'path', field, trail, value.path, value, container, key, { declared, record: true, form: 'path' });
    }
  }
}

function atRef(cx, value, segs, field, trail, container, key, declared) {
  if (segs.length === 0) { leafRef(cx, value, field, trail, container, key, declared); return; }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) atRef(cx, value[i], segs, field, [...trail, i], value, i, declared);
    return;
  }
  if (!value || typeof value !== 'object' || !(segs[0] in value)) return;
  atRef(cx, value[segs[0]], segs.slice(1), field, [...trail, segs[0]], value, segs[0], declared);
}

function declaredAt(cx, record, e) {
  const segs = e.field.split('.');
  const top = segs[0];
  if (!(top in record)) return;
  atRef(cx, record[top], segs.slice(1), top, [], record, top, e.field);
}

/**
 * Plan the reference rewrite for one structural change.
 *
 * @param {import('./rv-node-path-rewrite.d.mts').ReferenceRewriteInput} input
 * @returns {import('./rv-node-path-rewrite.d.mts').ReferenceRewritePlan}
 */
export function planReferenceRewrite(input) {
  const moves = input.moves instanceof Map ? input.moves : new Map(Object.entries(input.moves ?? {}));
  // A SEPARATE map, not extra keys in `moves`: an authored path may equal another
  // node's current path (`Pusher` stamped on `Pusher_1` beside a real `Pusher`), and
  // `moves` also decides referrer paths and renamed leaves (plan-765 F2b).
  const authoredMoves = input.authoredMoves == null
    ? null
    : input.authoredMoves instanceof Map ? input.authoredMoves : new Map(Object.entries(input.authoredMoves));
  const resolveOld = input.resolveOld;
  const resolveName = typeof input.resolveName === 'function' ? input.resolveName : null;
  const isForeign = typeof input.isForeign === 'function' ? input.isForeign : () => false;
  const pathFields = input.pathFields ?? PATH_FIELDS;
  const nameFields = input.nameFields ?? NAME_FIELDS;

  const steps = [];
  const nameSteps = [];
  const warnings = [];
  const counts = {
    referrers: 0,
    skippedForeign: 0,
    referencesSeen: 0,
    referencesRewritten: 0,
    referencesHealed: 0,
    unresolved: 0,
    nameFieldsRewritten: 0,
  };

  // Old leaf names of every RENAMED node (leaf changed) — the only names a name field
  // can lose its target by.
  const renamedOldLeaves = new Set();
  for (const [oldPath, newPath] of moves) {
    if (leafOf(oldPath) !== leafOf(newPath)) renamedOldLeaves.add(leafOf(oldPath));
  }

  for (const referrer of input.referrers) {
    const referrerPath = referrer.nodePath;
    const extras = referrer.extras;
    if (!extras || typeof extras !== 'object') continue;
    counts.referrers++;
    if (isForeign(referrerPath)) { counts.skippedForeign++; continue; }
    const postPath = mapPath(moves, referrerPath) ?? referrerPath;

    for (const componentType of Object.keys(extras)) {
      const record = extras[componentType];
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;

      /** Rewrite one written path; returns the new string or `null` (unchanged). */
      const rewritePath = (written, refComponentType, field) => {
        if (typeof written !== 'string' || written.length === 0) return null;
        counts.referencesSeen++;
        const hit = resolveOld({ path: written, componentType: refComponentType, referrerPath });
        if (!hit) { counts.unresolved++; return null; }
        const next = mapPath(moves, hit.canonical);
        if (next === null) return null;
        const exact = hit.stage === undefined || hit.stage === 'exact';
        // plan-765 F2b: written in the AUTHORED spelling of a moved node (the loader's
        // dedup renamed a segment, `NL6:501` → `NL6501_1`). That is the file's own name
        // space, not a fallback to heal: it is rewritten through `authoredMoves`, in that
        // spelling. Gated on the canonical hit above, so the authored map can only
        // re-spell a node that really moved — authored paths are not unique (true
        // sibling duplicates), current paths are.
        if (!exact && authoredMoves && typeof hit.authoredCanonical === 'string'
          && hit.authoredCanonical !== hit.canonical
          && writtenTailMatches(written, hit.authoredCanonical, hit.spelling)) {
          const authoredNext = mapPath(authoredMoves, normalizePath(hit.authoredCanonical));
          if (authoredNext !== null) {
            // No scope root: the written tail IS the authored canonical tail, so
            // `respell` derives the root from it — exact by construction.
            const spelledAuthored = respell(written, hit.authoredCanonical, authoredNext, hit.spelling);
            if (spelledAuthored === null) {
              warnings.push({
                code: 'reference-left-scope', nodePath: postPath, componentType, field, path: written,
                message: `${componentType}.${field} on "${postPath}": "${authoredNext}" cannot be written in the ${hit.spelling} spelling of "${written}" — left unchanged.`,
              });
              return null;
            }
            if (spelledAuthored === written) return null;
            counts.referencesRewritten++;
            return spelledAuthored;
          }
        }
        if (!exact && typeof hit.scopeRootPath !== 'string') {
          warnings.push({
            code: 'reference-heal-needs-scope', nodePath: postPath, componentType, field, path: written,
            message: `${componentType}.${field} on "${postPath}": "${written}" resolved only by fallback (${hit.stage}) and no scope root was given — left unchanged.`,
          });
          return null;
        }
        const spelled = respell(written, hit.canonical, next, hit.spelling, hit.scopeRootPath);
        if (spelled === null) {
          warnings.push({
            code: 'reference-left-scope', nodePath: postPath, componentType, field, path: written,
            message: `${componentType}.${field} on "${postPath}": "${next}" cannot be written in the ${hit.spelling} spelling of "${written}" — left unchanged.`,
          });
          return null;
        }
        if (spelled === written) return null;
        counts.referencesRewritten++;
        if (!exact) counts.referencesHealed++;
        return spelled;
      };

      /** Copy-on-write deep walk over ComponentReferences; returns the same value when unchanged. */
      const walkRefs = (value, field) => {
        if (value === null || typeof value !== 'object') return value;
        if (isComponentReference(value)) {
          const next = rewritePath(value.path, typeof value.componentType === 'string' ? value.componentType : undefined, field);
          return next === null ? value : { ...value, path: next };
        }
        if (Array.isArray(value)) {
          let out = null;
          for (let i = 0; i < value.length; i++) {
            const v = walkRefs(value[i], field);
            if (v !== value[i]) { if (!out) out = value.slice(); out[i] = v; }
          }
          return out ?? value;
        }
        let out = null;
        for (const k of Object.keys(value)) {
          const v = walkRefs(value[k], field);
          if (v !== value[k]) { if (!out) out = { ...value }; out[k] = v; }
        }
        return out ?? value;
      };

      /** Rewrite a path-string leaf value (string, `{ path }` record, or array of those). */
      const rewriteLeaf = (value, field) => {
        if (typeof value === 'string') return rewritePath(value, undefined, field) ?? value;
        if (Array.isArray(value)) {
          let out = null;
          for (let i = 0; i < value.length; i++) {
            const v = rewriteLeaf(value[i], field);
            if (v !== value[i]) { if (!out) out = value.slice(); out[i] = v; }
          }
          return out ?? value;
        }
        // A ComponentReference is the generic walk's business — never rewritten twice.
        if (value && typeof value === 'object' && !isComponentReference(value) && typeof value.path === 'string') {
          const next = rewritePath(value.path, undefined, field);
          return next === null ? value : { ...value, path: next };
        }
        return value;
      };

      /** Walk the dotted `segs` below `value` (arrays flattened at every segment). */
      const rewriteAt = (value, segs, field) => {
        if (segs.length === 0) return rewriteLeaf(value, field);
        if (Array.isArray(value)) {
          let out = null;
          for (let i = 0; i < value.length; i++) {
            const v = rewriteAt(value[i], segs, field);
            if (v !== value[i]) { if (!out) out = value.slice(); out[i] = v; }
          }
          return out ?? value;
        }
        if (!value || typeof value !== 'object') return value;
        const [seg, ...rest] = segs;
        if (!(seg in value)) return value;
        const child = value[seg];
        const next = rewriteAt(child, rest, field);
        return next === child ? value : { ...value, [seg]: next };
      };

      const declared = entriesOf(pathFields, componentType);
      for (const key of Object.keys(record)) {
        const prev = record[key];
        let value = walkRefs(prev, key);
        for (const e of declared) {
          const segs = e.field.split('.');
          if (segs[0] !== key) continue;
          const fieldName = e.field;
          value = segs.length === 1 ? rewriteLeaf(value, fieldName) : rewriteAt(value, segs.slice(1), fieldName);
        }
        if (value !== prev) steps.push({ nodePath: postPath, oldNodePath: referrerPath, componentType, field: key, value, prev });
      }

      // Name fields.
      for (const e of entriesOf(nameFields, componentType)) {
        const name = record[e.field];
        if (typeof name !== 'string' || name.length === 0) continue;
        if (!resolveName) {
          if (renamedOldLeaves.has(name)) {
            warnings.push({
              code: 'name-field-unchecked', nodePath: postPath, componentType, field: e.field, path: name,
              message: `${componentType}.${e.field} on "${postPath}" names "${name}", a renamed node, but no name resolver was given — left unchanged.`,
            });
          }
          continue;
        }
        const hit = resolveName({ name, componentType, field: e.field, referrerPath });
        if (!hit) continue;
        if (hit.ambiguous || typeof hit.canonical !== 'string') {
          if (renamedOldLeaves.has(name)) {
            warnings.push({
              code: 'name-field-ambiguous', nodePath: postPath, componentType, field: e.field, path: name,
              message: `${componentType}.${e.field} on "${postPath}" names "${name}", which is not unique in its scope — left unchanged.`,
            });
          }
          continue;
        }
        const next = mapPath(moves, hit.canonical);
        if (next === null) continue;
        const newName = leafOf(next);
        if (newName === leafOf(hit.canonical) || newName === name) continue;
        counts.nameFieldsRewritten++;
        nameSteps.push({ nodePath: postPath, oldNodePath: referrerPath, componentType, field: e.field, value: newName, prev: name });
      }
    }
  }

  return { steps, nameSteps, warnings, counts };
}
