// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { DesLintDiagnostic, DesLintOptions, LiveGeometryVerdict } from './rv-des-lint';

// Use Acorn's own tree without depending on a second AST package.
interface Node {
  type: string;
  start: number;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
}
interface Scope {
  parent?: Scope;
  fn: Node;
  bindings: Map<string, Binding>;
}
interface Binding { scope: Scope; persist: boolean; primitive: boolean; service?: boolean; protectedProperties?: boolean; }
let parser: typeof import('acorn') | undefined;
export async function loadParser(): Promise<void> { parser ??= await import('acorn'); }
function node(value: unknown): Node | undefined {
  return value !== null && typeof value === 'object' && 'type' in value ? value as Node : undefined;
}
function children(n: Node): Node[] {
  return Object.entries(n).flatMap(([key, value]) => key === 'loc' ? [] :
    Array.isArray(value) ? value.flatMap(v => node(v) ? [v as Node] : []) : node(value) ? [value as Node] : []);
}
// Methods that mutate their receiver: refused even on SDK handles (a handle result may be an ordinary array/map).
const MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear', 'assign']);
const isFunction = (n: Node) => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);
const name = (n: Node | undefined): string => n?.type === 'Identifier' ? String(n.name) : '';
function member(n: Node | undefined): string {
  if (n?.type !== 'MemberExpression') return '';
  const p = node(n.property);
  return n.computed ? p?.type === 'Literal' ? String(p.value) : '' : name(p);
}
function persistCall(n: Node | undefined): boolean {
  const c = node(n?.callee);
  return n?.type === 'CallExpression' && member(c) === 'persist' && name(node(c?.object)) === 'self';
}

/** Conservative state check: no execution, and no work on event hot paths. */
export function checkDesScriptState(code: string, opts: DesLintOptions = {}): DesLintDiagnostic[] {
  if (!parser) throw new Error('Call loadDesAstCheck() before checking script state');
  const diagnostics: DesLintDiagnostic[] = [];
  const reported = new Set<number>();
  const fail = (n: Node, reason: string) => {
    if (reported.has(n.start)) return;
    reported.add(n.start);
    const line = n.loc?.start.line ?? 1;
    diagnostics.push({ line, col: (n.loc?.start.column ?? 0) + 1,
      rule: 'des-script-undeclared-state', severity: opts.desSafe ? 'error' : 'warning',
      message: `des-script-undeclared-state: line ${line}: ${reason}; use self.persist(...).` });
  };
  let tree: Node;
  try {
    tree = parser.parse(code, { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true }) as unknown as Node;
  } catch {
    fail({ type: 'Invalid', start: 0 }, 'Cannot prove script state safe (invalid syntax)');
    return diagnostics;
  }
  const root: Scope = { fn: tree, bindings: new Map() };
  const scopes = new Map<Node, Scope>();
  const setupFunctions = new Set<Node>();
  const persistentScope = (s: Scope) => s.fn === tree || setupFunctions.has(s.fn);
  function resolve(s: Scope | undefined, id: string): Binding | undefined {
    for (; s; s = s.parent) { const b = s.bindings.get(id); if (b) return b; }
    return undefined;
  }
  function primitive(n: Node | undefined, s: Scope): boolean {
    if (!n) return false;
    if (n.type === 'Literal') return n.regex === undefined && (n.value === null || ['string', 'number', 'boolean'].includes(typeof n.value));
    if (n.type === 'Identifier') return ['undefined', 'NaN', 'Infinity'].includes(name(n)) || resolve(s, name(n))?.primitive === true;
    if (n.type === 'UnaryExpression') return primitive(node(n.argument), s);
    if (n.type === 'TemplateLiteral') return children(n).every(c => c.type === 'TemplateElement' || primitive(c, s));
    if (n.type === 'BinaryExpression' || n.type === 'LogicalExpression') return primitive(node(n.left), s) && primitive(node(n.right), s);
    return false;
  }
  // A handle obtained from the SDK (`self.drive(...)`, `self.vec3`, `V(0, 1, 0)`) is rebuilt by the
  // setup that runs again on every bind/restore: it is wiring, not run state. Writes to its
  // properties stay refused (protectedProperties) like for any captured binding.
  function serviceDerived(n: Node | undefined, s: Scope): boolean {
    if (n?.type === 'ConditionalExpression') {
      return [node(n.consequent), node(n.alternate)].every(b => primitive(b, s) || serviceDerived(b, s));
    }
    if (n?.type === 'LogicalExpression') {
      return [node(n.left), node(n.right)].every(b => primitive(b, s) || serviceDerived(b, s));
    }
    let cur = n;
    while (cur) {
      // A persist() result destructured out would be a detached copy: never wiring.
      if (persistCall(cur)) return false;
      if (cur.type === 'CallExpression') cur = node(cur.callee);
      else if (cur.type === 'MemberExpression') {
        // Constructor/prototype traversal or computed access can reach ordinary mutable values.
        if (cur.computed || ['constructor', '__proto__', 'prototype'].includes(member(cur))) return false;
        cur = node(cur.object);
      }
      else if (cur.type === 'ChainExpression') cur = node(cur.expression);
      else break;
    }
    if (cur?.type !== 'Identifier') return false;
    const b = resolve(s, name(cur));
    return name(cur) === 'self' ? b !== undefined && !b.persist : b?.service === true;
  }
  function declare(pattern: Node | undefined, s: Scope, persist = false, prim = false, service = false): void {
    if (!pattern) return;
    if (pattern.type === 'Identifier') s.bindings.set(name(pattern), { scope: s, persist, primitive: prim, service });
    else if (pattern.type === 'AssignmentPattern') declare(node(pattern.left), s);
    else for (const c of children(pattern)) {
      if (pattern.type === 'Property' && c === node(pattern.key)) continue;
      declare(c, s);
    }
  }
  // First pass resolves bindings before examining writes (including hoisted functions).
  function collect(n: Node, s: Scope, parent?: Node): void {
    if (isFunction(n)) {
      if (n.type === 'FunctionDeclaration') declare(node(n.id), s);
      const id = name(node(n.id));
      const p = parent?.type === 'VariableDeclarator' ? name(node(parent.id)) : '';
      if (id === 'setup' || p === 'setup' || (parent?.type === 'AssignmentExpression' && name(node(parent.left)) === 'setup')) setupFunctions.add(n);
      s = { parent: s, fn: n, bindings: new Map() };
      if (n.type === 'FunctionExpression') declare(node(n.id), s);
      for (const param of (n.params as Node[])) declare(param, s);
    } else if (n.type === 'BlockStatement' || n.type === 'ForStatement' || n.type === 'CatchClause') {
      s = { parent: s, fn: s.fn, bindings: new Map() };
      if (n.type === 'CatchClause') declare(node(n.param), s);
    }
    scopes.set(n, s);
    if (n.type === 'ClassDeclaration' && persistentScope(s)) fail(n, 'Setup/module class may retain undeclared state');
    if (n.type === 'VariableDeclarator') {
      const init = node(n.init);
      const isPersist = node(n.id)?.type === 'Identifier' && persistCall(init);
      let declarationScope = s;
      if (parent?.kind === 'var') {
        while (declarationScope.parent?.fn === s.fn) declarationScope = declarationScope.parent;
      }
      const service = !isPersist && !primitive(init, s) && serviceDerived(init, s);
      declare(node(n.id), declarationScope, isPersist, primitive(init, s), service);
      // Keep aliases to captured/global objects from disguising property writes.
      let base = init;
      while (base?.type === 'MemberExpression') base = node(base.object);
      const origin = resolve(s, name(base));
      const binding = declarationScope.bindings.get(name(node(n.id)));
      if (binding && (base?.type === 'ThisExpression' || name(base) === 'globalThis' ||
          (origin && !origin.persist && (origin.protectedProperties || persistentScope(origin.scope) || origin.scope.fn !== s.fn)))) {
        binding.protectedProperties = true;
      }
      if (persistentScope(s) && (parent?.kind !== 'const' || (!isPersist && !service && !primitive(init, s) && !(init && isFunction(init))))) {
        fail(n, 'Setup/module binding may retain undeclared state');
      }
    }
    for (const c of children(n)) collect(c, s, n);
  }
  collect(tree, root);
  function write(target: Node | undefined, at: Node, s: Scope, fromCall = false): void {
    if (!target) return;
    if (target.type === 'Identifier') {
      const b = resolve(s, name(target));
      if (b && (persistentScope(b.scope) || b.scope.fn !== s.fn)) fail(at, `Write to captured binding '${name(target)}'`);
      else if (!b) fail(at, `Write to global binding '${name(target)}'`);
    } else if (target.type === 'MemberExpression') {
      let base = node(target.object);
      while (base?.type === 'MemberExpression') base = node(base.object);
      const b = resolve(s, name(base));
      if (base?.type === 'ThisExpression' || name(base) === 'globalThis' || (!fromCall && !b && name(base) !== '') ||
          (b && !b.persist && (b.protectedProperties || persistentScope(b.scope) || b.scope.fn !== s.fn))) fail(at, 'Property write to global or captured state');
    } else for (const c of children(target)) {
      if (target.type === 'Property' && c === node(target.key) && !target.shorthand) continue;
      write(c, at, s, fromCall);
    }
  }
  // A setup return may only assemble literal handlers, never call a factory.
  function handlerValue(n: Node, sc: Scope): void {
    if (isFunction(n)) return;
    // `return self.disable('...')` and similar SDK calls build no closure state.
    if (n.type === 'CallExpression' && serviceDerived(n, sc)) return;
    if (n.type === 'CallExpression' || n.type === 'NewExpression') fail(n, 'Factory-created handler or handler object');
    for (const c of children(n)) handlerValue(c, sc);
  }
  function inspect(n: Node): void {
    const s = scopes.get(n)!;
    if (setupFunctions.has(n) && node(n.body)?.type !== 'BlockStatement') {
      const body = node(n.body); if (body) handlerValue(body, s);
    }
    if (n.type === 'AssignmentExpression') write(node(n.left), n, s);
    if (n.type === 'UpdateExpression' || (n.type === 'UnaryExpression' && n.operator === 'delete')) write(node(n.argument), n, s);
    if (n.type === 'ForOfStatement' || n.type === 'ForInStatement') {
      if (node(n.left)?.type !== 'VariableDeclaration') write(node(n.left), n, s);
    }
    if (n.type === 'ReturnStatement' && (setupFunctions.has(s.fn) || s.fn === tree)) {
      const arg = node(n.argument); if (arg) handlerValue(arg, s);
    }
    if (n.type === 'CallExpression') {
      const callee = node(n.callee);
      if (callee?.type === 'Identifier') {
        const b = resolve(s, name(callee));
        if (b?.service) { /* SDK handle: wiring */ } else
        if (b && b.scope.fn !== s.fn && !persistentScope(b.scope)) fail(n, 'Captured function used as a factory/helper instead of a handler');
        // Setup helper calls can also manufacture hidden state.
        // Calling a setup helper from INSIDE a handler is fine (state writes are refused by the write rules).
        if (b && !b.service && persistentScope(b.scope) && persistentScope(s)) fail(n, 'Setup/module function must only be referenced as a handler');
      }
      if (callee?.type === 'MemberExpression') {
        const owner = name(node(callee.object));
        const method = member(callee);
        if ((owner === 'Object' && ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(method)) ||
            (owner === 'Reflect' && ['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf'].includes(method))) {
          write({ type: 'MemberExpression', start: n.start, object: node((n.arguments as unknown[])[0]) }, n, s);
        } else {
          // Unknown methods on captured objects may mutate them; fail closed.
          let base = node(callee.object);
          while (base?.type === 'MemberExpression') base = node(base.object);
          const binding = resolve(s, name(base));
          if (name(base) !== 'self' && !binding?.primitive && (!binding?.service || MUTATING_METHODS.has(method))) write(callee, n, s, true);
        }
      }
    }
    for (const c of children(n)) inspect(c);
  }
  inspect(tree);
  return diagnostics.sort((a, b) => a.line - b.line || a.col - b.col);
}

// ─── plan-2212 Phase 4b: may this script read LIVE geometry? ──────────────────
//
// The DES runner settles every running tween at each new event time only while
// some consumer may read live geometry. A Model-Script used to count as such a
// consumer whenever it existed (every script has the synthesized `des.on`). This
// check proves the opposite for simple scripts and is deliberately one-sided:
// `mayRead: false` only when the source PROVABLY uses nothing that can reach a
// transform. Anything it cannot follow is "may read" (the settle stays on).

/**
 * `self` members a script may touch without reaching geometry. `sink(...)` and
 * `component(...)` return HANDLES: they are allowed only as a direct call, and
 * their result is an opaque value (see {@link checkLiveGeometry} rule 4).
 *  - time and timers: now, in, at, every, cancel
 *  - KPIs: statValue, statState, statOutput, statCycleStart, statCycleEnd
 *  - state: persist, state, setState, prop, random, name, path, enabled, disable
 *  - logging and errors: log, warn, error, raiseError, clearError
 *  - material flow listening: sink (handle)
 *  - script messages: component (handle), broadcast
 *  - pure in-VM math: vec3, quat, mat4, aabb, DEG2RAD, RAD2DEG, clamp
 */
export const GEOMETRY_FREE_SELF_MEMBERS: ReadonlySet<string> = new Set([
  'now', 'in', 'at', 'every', 'cancel',
  'statValue', 'statState', 'statOutput', 'statCycleStart', 'statCycleEnd',
  'persist', 'state', 'setState', 'prop', 'random', 'name', 'path', 'enabled', 'disable',
  'log', 'warn', 'error', 'raiseError', 'clearError',
  'sink', 'component', 'broadcast',
  'vec3', 'quat', 'mat4', 'aabb', 'DEG2RAD', 'RAD2DEG', 'clamp',
]);

/** `self` members that return a handle: direct call only, the result is opaque. */
const HANDLE_SELF_MEMBERS: ReadonlySet<string> = new Set(['sink', 'component']);

/**
 * Property names (on ANY object - the check knows no types) that lead to a node
 * handle or a transform: MU/sink/port `.node`, port `.partner` / `.worldAngle`,
 * every node-handle read, and the reflective routes to getters or the global
 * object. `onSignal` (a handler key) is listed too: signal values are not proven
 * geometry-free. Every name starting with `__` is refused as well.
 */
export const GEOMETRY_PROPERTIES: ReadonlySet<string> = new Set([
  'node', 'self', 'partner', 'parent', 'children',
  'worldPosition', 'worldQuaternion', 'worldDirection', 'worldMatrix', 'worldToLocal', 'localToWorld',
  'localPosition', 'localQuaternion', 'scale', 'bounds', 'worldAngle',
  'constructor', 'prototype', 'onSignal', 'toJSON', 'valueOf',
  // drive / transport pose surfaces (not reachable through the whitelist; belt and braces)
  'position', 'direction',
]);

/**
 * Globals that reach the global object, the host bridge or reflection (plus
 * every `__*` name): JSON (replacer / toJSON walk getters and call methods),
 * Object / Reflect / Proxy / structuredClone / Symbol (property walks, getters,
 * conversion hooks), eval / Function / globalThis / arguments.
 */
const FORBIDDEN_GLOBALS: ReadonlySet<string> = new Set([
  'globalThis', 'eval', 'Function', 'Reflect', 'Proxy', 'arguments',
  'JSON', 'Object', 'structuredClone', 'Symbol',
]);

/**
 * Conservative static proof that a Model-Script reads no live geometry
 * (doc-scripting.md § Fast-forward settle gate). `mayRead` is false only when
 * ALL of these hold:
 *  1. the source parses and declares `setup` exactly once, in a recognised form:
 *     a top-level `function setup(p) {}` or a top-level `const|let|var setup =
 *     function|arrow` whose first parameter is a plain identifier; the name
 *     `setup` occurs nowhere else;
 *  2. every reference to a self name (`self` and setup's first parameter) is the
 *     object of a NON-computed member access whose name is in
 *     {@link GEOMETRY_FREE_SELF_MEMBERS}; `sink` / `component` only as a direct
 *     call; no other binding of a self name;
 *  3. no member access, object key or pattern key is dynamic (computed with a
 *     non-literal key) or names a {@link GEOMETRY_PROPERTIES} entry / a `__*` name;
 *  4. OPAQUE values - every function / catch parameter (hook, callback and
 *     station arguments: hydrated MUs and ports), every `self.sink(...)` /
 *     `self.component(...)` result, every member read of an opaque value
 *     (`mu.id`, `p.copy`), the result of calling or constructing one (`s.on(cb)`,
 *     `p.copy()`), and `const x = <opaque>` bindings - are used ONLY as: the
 *     object of a non-computed member read, a callee, an operand of `===` `!==`
 *     `==` `!=`, under `!` / `typeof` / `void`, a test (`if`, loops, `?:`), the
 *     left side of `&&`, a bare expression statement, or the initialiser of
 *     `const <identifier>`. Passing one to ANY function (also `self.log`),
 *     spreading, returning, assigning, storing, iterating, templating or
 *     destructuring it is "may read", and so is WRITING a member of one
 *     (`p.copy = ...`, `mu.n++`, `delete mu.x`);
 *  5. no `this`, `with`, `import()`, meta property, and none of the forbidden
 *     globals (JSON, Object, Reflect, Proxy, structuredClone, Symbol, globalThis,
 *     eval, Function, arguments) or a `__*` global.
 * Requires the parser ({@link loadParser}); without it the verdict is "may read".
 */
export function checkLiveGeometry(code: string): LiveGeometryVerdict {
  if (!parser) return { mayRead: true, reason: 'parser not loaded' };
  let tree: Node;
  try {
    tree = parser.parse(code, { ecmaVersion: 'latest', allowReturnOutsideFunction: true }) as unknown as Node;
  } catch {
    return { mayRead: true, reason: 'invalid syntax' };
  }
  let reason = '';
  const refuse = (why: string): void => { if (!reason) reason = why; };
  const parents = new Map<Node, Node>();
  (function link(n: Node): void {
    for (const c of children(n)) { parents.set(c, n); link(c); }
  })(tree);

  // 1. Exactly one recognised setup declaration; `setup` occurs nowhere else.
  const body = (tree.body as Node[]) ?? [];
  let setupFn: Node | undefined;
  const setupIds = new Set<Node>();
  for (const stmt of body) {
    if (stmt.type === 'FunctionDeclaration' && name(node(stmt.id)) === 'setup') {
      setupIds.add(node(stmt.id)!); setupFn = setupFn ? undefined : stmt;
      if (setupIds.size > 1) refuse('setup declared more than once');
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations as Node[]) {
        const init = node(d.init);
        if (name(node(d.id)) === 'setup' && init && isFunction(init)) {
          setupIds.add(node(d.id)!); setupFn = setupFn ? undefined : init;
          if (setupIds.size > 1) refuse('setup declared more than once');
        }
      }
    }
  }
  if (!setupFn) refuse('no recognised setup declaration');
  const selfNames = new Set<string>(['self']);
  let selfParam: Node | undefined;
  if (setupFn) {
    const first = node((setupFn.params as unknown[])[0]);
    if (first && first.type !== 'Identifier') refuse('setup destructures its self parameter');
    else if (first) { selfParam = first; selfNames.add(name(first)); }
  }
  if (reason) return { mayRead: true, reason };

  const isFn = (n: Node | undefined): boolean => !!n && isFunction(n);
  const isPropertyName = (n: Node, parent: Node | undefined): boolean =>
    (parent?.type === 'MemberExpression' && node(parent.property) === n && !parent.computed)
    || ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition')
      && node(parent.key) === n && !parent.computed && !parent.shorthand)
    || parent?.type === 'LabeledStatement' || parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement';
  const keyName = (key: Node | undefined, computed: boolean): string | null => {
    if (!key) return null;
    if (!computed) return key.type === 'Identifier' ? name(key) : key.type === 'Literal' ? String(key.value) : null;
    if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) return String(key.value);
    return null; // dynamic key: may be anything
  };
  const forbiddenProperty = (p: string): boolean => GEOMETRY_PROPERTIES.has(p) || p.startsWith('__');
  const isSelfRef = (n: Node | undefined): boolean => n?.type === 'Identifier' && selfNames.has(name(n));

  // 4a. Opaque bindings: every parameter (except setup's self) and catch parameter.
  const opaqueNames = new Set<string>();
  const declarePattern = (p: Node | undefined): void => {
    if (!p) return;
    if (p.type === 'Identifier') { opaqueNames.add(name(p)); return; }
    refuse('a parameter is destructured or has a default'); // patterns would read opaque values
  };
  (function params(n: Node): void {
    if (isFunction(n)) for (const p of n.params as Node[]) { if (p !== selfParam) declarePattern(p); }
    if (n.type === 'CatchClause') declarePattern(node(n.param) ?? undefined);
    for (const c of children(n)) params(c);
  })(tree);
  if (reason) return { mayRead: true, reason };

  /** An expression whose value may be a handle (rule 4). */
  const opaque = (n: Node | undefined): boolean => {
    if (!n) return false;
    switch (n.type) {
      case 'Identifier': return opaqueNames.has(name(n));
      // A member read of an opaque value is opaque (Codex round 2: `p.copy()` may
      // return anything the script or the host put on the handle).
      case 'MemberExpression': return opaque(node(n.object));
      case 'TaggedTemplateExpression': return opaque(node(n.tag));
      case 'NewExpression': return opaque(node(n.callee));
      case 'CallExpression': {
        const callee = node(n.callee);
        if (callee?.type === 'MemberExpression' && isSelfRef(node(callee.object)) && !callee.computed
          && HANDLE_SELF_MEMBERS.has(name(node(callee.property)))) return true;
        return opaque(callee);
      }
      case 'ChainExpression': return opaque(node(n.expression));
      case 'AssignmentExpression': return opaque(node(n.right));
      case 'SequenceExpression': return opaque((n.expressions as Node[]).at(-1));
      case 'ConditionalExpression': return opaque(node(n.consequent)) || opaque(node(n.alternate));
      case 'LogicalExpression': return opaque(node(n.right)) || (n.operator !== '&&' && opaque(node(n.left)));
      case 'AwaitExpression': case 'YieldExpression': return opaque(node(n.argument));
      default: return false;
    }
  };
  // 4b. `const x = <opaque>` makes x opaque (to a fixpoint: chains of such bindings).
  for (let changed = true; changed;) {
    changed = false;
    (function decls(n: Node): void {
      if (n.type === 'VariableDeclarator' && node(n.id)?.type === 'Identifier' && opaque(node(n.init))
        && !opaqueNames.has(name(node(n.id)))) { opaqueNames.add(name(node(n.id))); changed = true; }
      for (const c of children(n)) decls(c);
    })(tree);
  }

  /** Is this use of an opaque expression one of the allowed contexts (rule 4)? */
  const allowedUse = (n: Node): boolean => {
    const p = parents.get(n);
    if (!p) return false;
    switch (p.type) {
      case 'MemberExpression': return node(p.object) === n;          // computed / token keys are refused separately
      case 'CallExpression': return node(p.callee) === n;            // the call result is checked on its own
      case 'ChainExpression': return allowedUse(p);
      case 'BinaryExpression': return ['===', '!==', '==', '!='].includes(String(p.operator));
      case 'UnaryExpression': return ['!', 'typeof', 'void'].includes(String(p.operator));
      case 'IfStatement': case 'WhileStatement': case 'DoWhileStatement': case 'ForStatement': return node(p.test) === n;
      case 'ConditionalExpression': return node(p.test) === n || allowedUse(p);
      case 'LogicalExpression': return (p.operator === '&&' && node(p.left) === n) || allowedUse(p);
      case 'ExpressionStatement': return true;
      case 'VariableDeclarator': {
        const decl = parents.get(p);
        return node(p.init) === n && node(p.id)?.type === 'Identifier' && decl?.kind === 'const';
      }
      default: return false;
    }
  };

  (function walk(n: Node, parent?: Node): void {
    if (reason) return;
    switch (n.type) {
      case 'ThisExpression': refuse('uses this'); return;
      case 'WithStatement': refuse('uses with'); return;
      case 'ImportExpression': refuse('uses import()'); return;
      case 'MetaProperty': refuse('uses a meta property'); return;
      case 'Identifier': {
        if (isPropertyName(n, parent)) break;
        const id = name(n);
        if (FORBIDDEN_GLOBALS.has(id) || id.startsWith('__')) { refuse(`uses '${id}'`); return; }
        if (id === 'setup' && !setupIds.has(n)) { refuse("'setup' is used outside its declaration"); return; }
        if (selfNames.has(id)) {
          if (n === selfParam) break;
          if (!(parent?.type === 'MemberExpression' && node(parent.object) === n)) {
            refuse(`'${id}' escapes (alias, argument, destructuring, return or binding)`); return;
          }
          if (parent.computed) { refuse(`computed member access on '${id}'`); return; }
          const member = name(node(parent.property));
          if (!GEOMETRY_FREE_SELF_MEMBERS.has(member)) { refuse(`'${id}.${member}' is not geometry-free`); return; }
          if (HANDLE_SELF_MEMBERS.has(member)) {
            const call = parents.get(parent);
            if (call?.type !== 'CallExpression' || node(call.callee) !== parent) { refuse(`'${id}.${member}' is not called directly`); return; }
          }
        }
        // Opaque bindings: their declarations are fine, every use must be an allowed context.
        if (opaqueNames.has(id) && !isDeclaration(n, parent) && !allowedUse(n)) { refuse(`opaque value '${id}' escapes`); return; }
        break;
      }
      case 'CallExpression':
      case 'AssignmentExpression':
      case 'ConditionalExpression':
      case 'LogicalExpression':
      case 'SequenceExpression':
      case 'AwaitExpression':
      case 'YieldExpression':
        if (opaque(n) && !allowedUse(n)) { refuse('an opaque value (handle) escapes'); return; }
        if (n.type === 'AssignmentExpression' && opaque(node(n.right))) { refuse('an opaque value (handle) is stored'); return; }
        break;
      case 'MemberExpression': {
        const p = keyName(node(n.property), n.computed === true);
        if (p === null) { refuse('dynamic member access'); return; }
        if (forbiddenProperty(p)) { refuse(`reads '.${p}'`); return; }
        if (opaque(node(n.object))) {
          if (isWriteTarget(n, parent)) { refuse(`writes '.${p}' of an opaque value`); return; }
          if (!allowedUse(n)) { refuse(`'.${p}' of an opaque value escapes`); return; }
        }
        break;
      }
      case 'Property':
      case 'MethodDefinition':
      case 'PropertyDefinition': {
        const p = keyName(node(n.key), n.computed === true);
        if (p === null) { refuse('dynamic property key'); return; }
        if (forbiddenProperty(p)) { refuse(`uses key '${p}'`); return; }
        break;
      }
      case 'SpreadElement':
      case 'RestElement':
        if (opaque(node(n.argument))) { refuse('an opaque value is spread'); return; }
        break;
      default: break;
    }
    for (const c of children(n)) walk(c, n);
  })(tree);
  return reason ? { mayRead: true, reason } : { mayRead: false, reason: '' };

  /** Assignment / update / delete / for-in-of / destructuring target. */
  function isWriteTarget(n: Node, parent: Node | undefined): boolean {
    switch (parent?.type) {
      case 'AssignmentExpression': return node(parent.left) === n;
      case 'UpdateExpression': return true;
      case 'UnaryExpression': return parent.operator === 'delete';
      case 'ForInStatement': case 'ForOfStatement': return node(parent.left) === n;
      case 'ArrayPattern': case 'ObjectPattern': case 'AssignmentPattern': case 'RestElement': return true;
      case 'Property': return node(parent.value) === n && parents.get(parent)?.type === 'ObjectPattern';
      default: return false;
    }
  }

  function isDeclaration(n: Node, parent: Node | undefined): boolean {
    if (isFn(parent) && (parent!.params as unknown[]).includes(n)) return true;
    if (parent?.type === 'CatchClause' && node(parent.param) === n) return true;
    if (parent?.type === 'VariableDeclarator' && node(parent.id) === n) return true;
    if ((parent?.type === 'FunctionDeclaration' || parent?.type === 'FunctionExpression') && node(parent.id) === n) return true;
    return false;
  }
}
