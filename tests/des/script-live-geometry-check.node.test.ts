// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 Phase 4b (A + F) — the conservative static settle-gate check
 * (`desScriptMayReadLiveGeometry`) and the per-source lint cache.
 *
 * The check may only say "no live geometry" when the source PROVABLY uses
 * nothing that can reach a transform; every detour (alias, computed access,
 * passing `self` on, destructuring, reflection) must keep the settle ON.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { desScriptMayReadLiveGeometry, lintDesSafety, loadDesAstCheck } from '../../src/core/sdk/rv-des-lint';
import { GEOMETRY_FREE_SELF_MEMBERS } from '../../src/core/sdk/rv-des-ast-check';

beforeAll(loadDesAstCheck);

const setup = (body: string) => `function setup(self) {\n${body}\n}`;
const may = (code: string) => desScriptMayReadLiveGeometry(code).mayRead;

/** Unrecognised setup forms (Codex #3): the check must not guess which function is setup. */
const SETUP_FORMS: Record<string, string> = {
  'setup by array destructuring': 'var [setup] = [s => { s.self.worldPosition(); return {}; }];',
  'setup by object destructuring': 'var { setup } = { setup: function (s) { return {}; } };',
  'setup assigned later': 'var setup; setup = function (s) { return {}; };',
  'setup declared twice': 'function setup(self) { return {}; } var setup = function (s) { return {}; };',
  'setup referenced elsewhere': 'function setup(self) { return {}; } const again = setup;',
  'setup nested': 'function wrap() { function setup(s) { return {}; } }',
  'no setup at all': 'const x = 1;',
};

/** The ShippingMonitor-style script of pallet-yard-script-sink.test.ts. */
const SHIPPING = `
function setup(self) {
  const st = self.persist({ v1: [], v2: 0 });
  self.sink('Sink_V1').on(function (mu) { st.v1.push([self.now, mu.id]); });
  self.sink('Sink_V2').on(function () { st.v2++; });
  return { state() { return st; } };
}`;

/** The realistic Model-Script: sink listener + every(600), KPIs and persist. */
const PLAIN = setup(`
  const st = self.persist({ arrivals: 0, last: -1, gap: 0, audits: 0 });
  self.statValue('Arrivals', 0);
  const s = self.sink('Sink_V1');
  if (s) s.on(function (mu) {
    st.arrivals++;
    if (st.last >= 0 && self.now - st.last > st.gap) st.gap = self.now - st.last;
    st.last = self.now;
    if (mu.type === 'Pallet' && mu.prop.sku !== 'X') self.log('arrival', st.arrivals, self.random());
  });
  self.every(600, 'audit');
  return {
    des: { on(hook) { if (hook === 'audit') { st.audits++; self.statValue('Arrivals', st.arrivals, '', 'KPI'); } } },
    state() { return st; },
  };`);

describe('plan-2212 Phase 4b — static live-geometry check (settle gate)', () => {
  it('proves the realistic sink + every script geometry-free', () => {
    expect(desScriptMayReadLiveGeometry(PLAIN)).toEqual({ mayRead: false, reason: '' });
  });

  it('the ShippingMonitor STORES mu.id - since Codex round 2 a derived handle value that is stored keeps the settle on', () => {
    // st.v1.push([self.now, mu.id]): mu.id is a member read of an opaque value and goes into an array.
    expect(desScriptMayReadLiveGeometry(SHIPPING).mayRead).toBe(true);
    // The same monitor counting instead of storing the id stays geometry-free.
    const counting = SHIPPING.replace('st.v1.push([self.now, mu.id]);', 'if (mu.id !== null) st.v2++;');
    expect(desScriptMayReadLiveGeometry(counting)).toEqual({ mayRead: false, reason: '' });
  });

  it.each([
    ['scalar member reads of callback arguments in comparisons and tests', 'return { des: { canAccept(mu, p) { if (mu.prop.sku === "A" && !p.occupied()) self.statOutput(); return p.role === "input" && mu.id !== 0 && typeof mu.type === "string"; } } };'],
    ['handle methods and guards', 'const s = self.sink("S"); if (s) s.on(function (mu) { if (!mu) return; mu.release(); }); const c = self.component("X"); if (c && c.state === "idle") c.send("go", { n: 1 }); return {};'],
    ['hook name comparisons', 'self.every(600, "audit"); return { des: { on(hook) { if (typeof hook === "string" && hook === "audit") self.statOutput(); } } };'],
    ['setup as a const arrow', ''],
  ])('geometry-free: %s', (_label, body) => {
    const code = body ? setup(body) : 'const setup = (self) => { self.every(60, "x"); return {}; };';
    expect(desScriptMayReadLiveGeometry(code)).toEqual({ mayRead: false, reason: '' });
  });

  it.each([
    ['timers, FSM, messages, math', 'self.in(1, "a"); self.at(2, "b"); const id = self.every(5, "c"); self.cancel(id); self.setState("run"); self.broadcast("t", { n: 1 }); const c = self.component("Other"); if (c) c.send("x", 1); const v = self.vec3(1, 2, 3); return { des: { on() { self.statOutput(); self.statState(self.state); } } };'],
    ['props, name, path, numeric index', 'const a = [1, 2]; return { des: { on() { self.log(self.name, self.path, self.prop.speed, a[0], a["length"]); } } };'],
    ['renamed self parameter', ''],
  ])('geometry-free: %s', (_label, body) => {
    const code = body ? setup(body) : 'function setup(me) { me.every(60, "x"); return { des: { on() { me.log(me.now); } } }; }';
    expect(desScriptMayReadLiveGeometry(code)).toEqual({ mayRead: false, reason: '' });
  });

  it.each([
    ['direct node read', 'return { des: { on() { self.log(self.node("Robot").worldPosition()); } } };'],
    ['own node', 'return { des: { on() { self.log(self.self.worldQuaternion()); } } };'],
    ['MU node in a sink callback', 'const s = self.sink("Sink"); if (s) s.on(function (mu) { self.log(mu.node.worldPosition()); }); return {};'],
    ['sink handle node', 'const s = self.sink("Sink"); return { des: { on() { self.log(s.node); } } };'],
    ['alias of self', 'const s = self; return { des: { on() { self.log(s.node("R").worldPosition()); } } };'],
    ['alias without geometry token', 'const s = self; return { des: { on() { s.log(1); } } };'],
    ['computed self member', 'return { des: { on() { self.log(self["wor" + "ldPosition"]); } } };'],
    ['computed self member with a literal', 'return { des: { on() { self["now"]; } } };'],
    ['computed member on an MU', 'const k = "no" + "de"; const s = self.sink("Sink"); if (s) s.on(function (mu) { self.log(mu[k]); }); return {};'],
    ['self passed to a helper', 'function read(x) { return x.node("R"); } return { des: { on() { read(self); } } };'],
    ['self returned', 'return { des: { on() { return self; } } };'],
    ['self in an object literal', 'const o = { self }; return {};'],
    ['self destructured', 'const { node } = self; return {};'],
    ['self destructured with rename', 'const { now: n } = self; return {};'],
    ['MU destructured', 'const s = self.sink("Sink"); if (s) s.on(function ({ node }) { self.log(node); }); return {};'],
    ['non-whitelisted self member', 'return { des: { on() { self.log(self.mus.length); } } };'],
    ['signal read', 'return { des: { on() { self.log(self.signal("Pos").num); } } };'],
    ['onSignal handler', 'return { onSignal(name, v) { self.log(v); } };'],
    ['this', 'return { des: { on() { self.log(this); } } };'],
    ['globalThis', 'return { des: { on() { self.log(globalThis); } } };'],
    ['host bridge global', 'return { des: { on() { self.log(__rvHostCall("now")); } } };'],
    ['getter lookup', 'const s = self.sink("Sink"); if (s) s.on(function (mu) { self.log(mu.__lookupGetter__); }); return {};'],
    ['Object.values', 'const s = self.sink("Sink"); if (s) s.on(function (mu) { self.log(Object.values(mu)); }); return {};'],
    ['Reflect', 'const s = self.sink("Sink"); if (s) s.on(function (mu) { self.log(Reflect.get(mu, "x")); }); return {};'],
    ['constructor', 'return { des: { on() { self.log([].constructor); } } };'],
    ['arguments', 'const s = self.sink("Sink"); if (s) s.on(function () { self.log(arguments[0]); }); return {};'],
    ['with', 'const s = self.sink("Sink"); if (s) s.on(function (mu) { with (mu) { self.log(1); } }); return {};'],
    ['dynamic object key', 'const k = "x"; return { [k]: 1 };'],
    // ── Codex review of 32d6b1ff, #1: JSON reflection walks getters and calls methods ──
    ['JSON replacer on a sink handle', 'return { des: { on() { self.log(JSON.stringify(self.sink("S"), (k, v) => k === "world" + "Position" ? v() : v)); } } };'],
    ['JSON replacer on a hydrated MU (des.on)', 'return { des: { on(hook, mu) { self.log(JSON.stringify(mu, (k, v) => typeof v === "function" ? v() : v)); } } };'],
    ['JSON on a hydrated port (canAccept)', 'return { des: { canAccept(mu, p) { self.statValue("x", JSON.stringify(p).length); return true; } } };'],
    ['JSON on a hydrated MU (onAccept)', 'return { des: { onAccept(mu) { const t = JSON.stringify(mu); self.log(t); return true; } } };'],
    ['toJSON variant', 'const s = self.sink("S"); return { des: { on() { self.log(JSON.stringify({ toJSON: s.on })); } } };'],
    ['toJSON key alone', 'return { des: { on() { self.log({ toJSON() { return 1; } }); } } };'],
    ['JSON aliased', 'const J = JSON; return {};'],
    ['Object.keys', 'return { des: { on(h, mu) { self.log(Object.keys(mu.prop)); } } };'],
    ['structuredClone', 'return { des: { canAccept(mu) { self.log(structuredClone(mu)); return true; } } };'],
    ['Symbol', 'return { des: { on() { self.log(Symbol.iterator); } } };'],
    ['valueOf returns the handle', 'return { des: { canAccept(mu, p) { self.log(p.valueOf()); return true; } } };'],
    // ── #2: whole-object operations on hook / callback arguments and handles ──
    ['port spread in canAccept', 'return { des: { canAccept(mu, p) { self.log({ ...p }); return true; } } };'],
    ['array spread', 'return { des: { canAccept(mu, p) { self.log([...p]); return true; } } };'],
    ['port passed to self.log', 'return { des: { canAccept(mu, p) { self.log(p); return true; } } };'],
    ['MU passed to statValue', 'const s = self.sink("S"); if (s) s.on(function (mu) { self.statValue("last", mu); }); return {};'],
    ['MU passed to a helper', 'function f(x) { return 1; } return { des: { on(h, mu) { f(mu); } } };'],
    ['handle returned', 'return { des: { canAccept(mu, p) { return p; } } };'],
    ['handle returned by an arrow body', 'const s = self.sink("S"); if (s) s.on(mu => mu); return {};'],
    ['handle stored in persist', 'const st = self.persist({ m: null }); return { des: { on(h, mu) { st.m = mu; } } };'],
    ['handle pushed into an array', 'const st = self.persist({ l: [] }); return { des: { on(h, mu) { st.l.push(mu); } } };'],
    ['handle in an array literal', 'return { des: { on(h, mu) { const a = [mu]; self.log(a.length); } } };'],
    ['handle in an object literal', 'return { des: { on(h, mu) { const o = { m: mu }; self.log(o.m.id); } } };'],
    ['handle assigned to a let', 'return { des: { on(h, mu) { let m; m = mu; self.log(m.id); } } };'],
    ['handle bound with let', 'return { des: { on(h, mu) { let m = mu; self.log(m.id); } } };'],
    ['handle iterated with for-in', 'return { des: { canAccept(mu, p) { for (const k in p) self.log(k); return true; } } };'],
    ['handle iterated with for-of', 'return { des: { canAccept(mu, p) { for (const v of p) self.log(v); return true; } } };'],
    ['handle in a template literal', 'return { des: { canAccept(mu, p) { self.log(`${p}`); return true; } } };'],
    ['handle concatenated', 'return { des: { canAccept(mu, p) { self.log("" + p); return true; } } };'],
    ['handle via || fallback', 'return { des: { canAccept(mu, p) { self.log(p || 1); return true; } } };'],
    ['handle via ?: branch', 'return { des: { canAccept(mu, p) { self.log(mu ? p : 1); return true; } } };'],
    ['handle destructured in the parameter list', 'return { des: { canAccept(mu, { worldAngle }) { return true; } } };'],
    ['handle destructured in the body', 'return { des: { canAccept(mu, p) { const { id } = p; return true; } } };'],
    ['parameter default', 'return { des: { on(h, mu = 1) { } } };'],
    ['handle method bound to the handle', 'return { des: { on(h, mu) { const f = mu.release.bind(mu); } } };'],
    ['handle thrown and caught', 'return { des: { on(h, mu) { try { throw mu; } catch (e) { self.log(e); } } } };'],
    ['sink handle passed on', 'return { des: { on() { self.log(self.sink("S")); } } };'],
    ['sink handle via a const alias passed on', 'const s = self.sink("S"); const t = s; return { des: { on() { self.log(t); } } };'],
    ['self.sink not called directly', 'const f = self.sink; return {};'],
    ['self.sink applied', 'const s = self.sink.call(null, "S"); return {};'],
    ['component handle passed on', 'return { des: { on() { self.log(self.component("Other")); } } };'],
    ['port worldAngle', 'return { des: { canAccept(mu, p) { self.log(p.worldAngle); return true; } } };'],
    ['message payload passed on', 'return { onMessage(topic, data) { self.log(data); } };'],
    // ── Codex round 2: member reads of opaque values are opaque, member writes are refused ──
    ['Codex round 2 example', 'return { des: { canAccept(mu, p) { p.copy = [].reverse; let q = p.copy(); self.log({ ...q }); return true; } } };'],
    ['derived call result into const, then spread', 'return { des: { canAccept(mu, p) { const q = p.occupied(); self.log({ ...q }); return true; } } };'],
    ['derived member into let', 'return { des: { canAccept(mu, p) { let r = p.role; return true; } } };'],
    ['derived member assigned', 'const st = self.persist({ r: "" }); return { des: { canAccept(mu, p) { st.r = p.role; return true; } } };'],
    ['derived member spread', 'return { des: { on(h, mu) { self.log({ ...mu.prop }); } } };'],
    ['derived member returned', 'return { des: { canAccept(mu, p) { return p.role; } } };'],
    ['derived member as a function argument', 'return { des: { on(h, mu) { self.log(mu.id); } } };'],
    ['derived member to statValue', 'return { des: { on(h, mu) { self.statValue("w", mu.prop.weight); } } };'],
    ['derived member in an array', 'const st = self.persist({ l: [] }); return { des: { on(h, mu) { st.l.push([self.now, mu.id]); } } };'],
    ['derived member in a template', 'return { des: { on(h, mu) { self.log(`${mu.type}`); } } };'],
    ['derived call result in a template', 'return { des: { canAccept(mu, p) { self.log("x" + p.occupied()); return true; } } };'],
    ['sink on() result escapes', 'const st = self.persist({ u: null }); const s = self.sink("S"); if (s) st.u = s.on(function () {}); return {};'],
    ['handle constructed', 'return { des: { canAccept(mu, p) { const x = new p.Ctor(); self.log(x.a); return true; } } };'],
    ['handle as a template tag', 'return { des: { canAccept(mu, p) { p.tag`x`; return true; } } };'],
    ['member write on a port', 'return { des: { canAccept(mu, p) { p.copy = 1; return true; } } };'],
    ['member write on an MU', 'return { des: { on(h, mu) { mu.x = 1; } } };'],
    ['compound member write', 'return { des: { on(h, mu) { mu.n += 1; } } };'],
    ['member update', 'return { des: { on(h, mu) { mu.n++; } } };'],
    ['member delete', 'return { des: { on(h, mu) { delete mu.x; } } };'],
    ['nested member write', 'return { des: { on(h, mu) { mu.prop.x = 1; } } };'],
    ['member write on a sink handle', 'const s = self.sink("S"); if (s) s.on = 1; return {};'],
    ['member as a destructuring target', 'return { des: { on(h, mu) { [mu.a] = [1]; } } };'],
    ['member as an object-pattern target', 'return { des: { on(h, mu) { ({ a: mu.b } = { a: 1 }); } } };'],
    ['member as a for-in target', 'return { des: { on(h, mu) { for (mu.k in { a: 1 }) self.statOutput(); } } };'],
    ['position token', 'const st = self.persist({ position: 0 }); return { des: { on() { self.statValue("p", st.position); } } };'],
    ['direction token', 'return { des: { on(h, mu) { if (mu.direction === 1) self.statOutput(); } } };'],
    // ── #3: unrecognised setup forms ──
    ['setup by array destructuring', ''],
    ['setup by object destructuring', ''],
    ['setup assigned later', ''],
    ['setup declared twice', ''],
    ['setup referenced elsewhere', ''],
    ['setup nested', ''],
    ['no setup at all', ''],
    ['destructured setup parameter', ''],
    ['invalid syntax', 'return {'],
  ])('may read: %s', (label, body) => {
    const code = body ? setup(body) : SETUP_FORMS[label] ?? 'function setup({ now }) { return {}; }';
    const verdict = desScriptMayReadLiveGeometry(code);
    expect(verdict.mayRead).toBe(true);
    expect(verdict.reason).not.toBe('');
  });

  it('the whitelist holds no member that returns a node or reads a transform', () => {
    for (const m of ['node', 'self', 'find', 'findAll', 'children', 'drive', 'sensor', 'signal', 'scene', 'ports', 'mus', 'inputs', 'outputs', 'spawn', 'transfer', 'paths']) {
      expect(GEOMETRY_FREE_SELF_MEMBERS.has(m), m).toBe(false);
    }
  });

  it('is cached per source text and hands out copies', () => {
    const a = desScriptMayReadLiveGeometry(PLAIN);
    a.mayRead = true;
    expect(desScriptMayReadLiveGeometry(PLAIN).mayRead).toBe(false);
    expect(may(setup('return { des: { on() { self.log(self.self); } } };'))).toBe(true);
  });
});

describe('plan-2212 Phase 4b (F) — lintDesSafety per-source cache', () => {
  it('returns the same findings again, as independent copies, per flag combination', () => {
    const code = setup('let n = 0; return { des: { on() { n++; } } };');
    const first = lintDesSafety(code, { desSafe: true, checkState: true });
    expect(first.length).toBeGreaterThan(0);
    first[0].message = 'mutated';
    first.length = 0;
    const second = lintDesSafety(code, { desSafe: true, checkState: true });
    expect(second.length).toBeGreaterThan(0);
    expect(second[0].message).not.toBe('mutated');
    expect(second.every(d => d.severity === 'error')).toBe(true);
    // Other flags are another cache entry: DesSafe off → warnings.
    const warn = lintDesSafety(code, { desSafe: false, checkState: true });
    expect(warn.filter(d => d.rule === 'des-script-undeclared-state').every(d => d.severity === 'warning')).toBe(true);
    expect(lintDesSafety(code).some(d => d.rule === 'des-script-undeclared-state')).toBe(false);
  });

  it('stays bounded: many distinct sources do not break later lookups', () => {
    for (let i = 0; i < 300; i++) lintDesSafety(setup(`return { des: { on() { self.log(${i}); } } };`), { checkState: true });
    expect(lintDesSafety(setup('return {};'), { checkState: true })).toEqual([]);
  });
});
