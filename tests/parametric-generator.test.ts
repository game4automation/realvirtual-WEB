// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * parametric-generator.test.ts — plan-650 phase 2 (tests 9.2): the rule part
 * of a part family runs as a pure function in its own QuickJS runtime.
 *
 * Budgets are asserted through the deterministic interrupt-tick counter, never
 * through the wallclock (the deadline is only an emergency brake and is set
 * far out of reach in these tests).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  runGenerator,
  getGeneratorRunCount,
  type PartInfo,
} from '../src/core/engine/rv-parametric-generator';
import { computePlanHash } from '../src/core/engine/rv-parametric-hash';
import { RVScriptHost } from '../src/core/engine/rv-script-host';

/** Wallclock brake out of reach: only the tick counter may stop a run here. */
const NO_WALLCLOCK = { deadlineMs: 60_000 };
/** Generous budgets for tests that must reach a STRUCTURAL limit first. */
const ROOMY = { ...NO_WALLCLOCK, maxResultChars: 64 * 1024 * 1024, memoryLimitBytes: 256 * 1024 * 1024, maxInterruptTicks: 1e9 };

const PARTS: PartInfo[] = [
  { name: 'Profile', boundsMm: { min: [0, 0, 0], max: [1000, 50, 120] }, vertexCount: 200 },
  { name: 'Roller420', boundsMm: { min: [-25, 0, -25], max: [25, 420, 25] }, vertexCount: 400 },
  { name: 'Guide', boundsMm: { min: [0, 0, 0], max: [1000, 10, 40] }, vertexCount: 100 },
];

/** RM 8110 reference rules (simplified for the golden test; the real example arrives in phase 6). */
const RM8110 = `
function generate(v, parts) {
  var n = Math.floor(v.ML / v.P);
  var dBF = v.BF - 420;
  var instances = [];
  for (var s = 0; s < 2; s++) {
    instances.push({ part: 'Profile', name: 'Profile_' + s, positionMm: [0, s * (v.BF + 50), 0],
      stretch: [{ axis: 'x', atMm: 500, byMm: v.ML - 1000 }] });
  }
  for (var k = 0; k < n; k++) {
    instances.push({ part: 'Roller420', name: 'Roller_' + k, positionMm: [v.P / 2 + k * v.P, 50, v.HSG],
      stretch: dBF ? [{ axis: 'y', atMm: 210, byMm: dBF }] : undefined });
  }
  return {
    instances: instances,
    nodes: [
      { name: 'Snap-X-0', positionMm: [0, (v.BF + 50) / 2, v.HSG] },
      { name: 'Snap-X+0', positionMm: [v.ML, (v.BF + 50) / 2, v.HSG] },
      { name: 'Transport-Surface', positionMm: [v.ML / 2, (v.BF + 50) / 2, v.HSG + 25] },
    ],
    components: [{ node: 'Transport-Surface', type: 'TransportSurface', fields: { Speed: 300 } }],
    messages: [{ level: 'info', text: n + ' rollers' }],
  };
}`;
const DEFAULTS = { BF: 420, ML: 2160, P: 90, HSG: 68 };
const ENDLESS = 'function generate(){ while(true){} }';
const MEMORY_HOG = 'function generate(){ var a=[]; while(true) a.push(new Float64Array(100000)); }';

/** Golden plan hash of RM8110 at DEFAULTS (update only on an intended rule/format change). */
const GOLDEN_PLAN_HASH = 'b000463a49a94c2c64f85f32deb5716a381fdf89ee8762da989df057ecb11208';

const hosts: RVScriptHost[] = [];
afterEach(() => {
  for (const h of hosts) h.dispose();
  hosts.length = 0;
});

function errCode(r: Awaited<ReturnType<typeof runGenerator>>): string {
  return r.ok ? 'ok' : r.error.code;
}

describe('runGenerator — golden + determinism', () => {
  it('RM 8110 defaults produce the golden build plan', async () => {
    const r = await runGenerator(RM8110, DEFAULTS, PARTS, NO_WALLCLOCK);
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (!r.ok) return;
    expect(r.plan.instances.length).toBe(2 + 24);
    expect(r.plan.instances[0].stretch).toEqual([{ axis: 'x', atMm: 500, byMm: 1160 }]);
    expect(r.plan.instances[2].stretch).toBeUndefined();
    expect(r.plan.nodes.map((n) => n.name)).toEqual(['Snap-X-0', 'Snap-X+0', 'Transport-Surface']);
    expect(r.stats.vertices).toBe(2 * 200 + 24 * 400);
    expect(await computePlanHash(r.plan)).toBe(GOLDEN_PLAN_HASH);
  });

  it('same inputs give a bit-identical plan; other values a different one', async () => {
    const a = await runGenerator(RM8110, DEFAULTS, PARTS, NO_WALLCLOCK);
    const b = await runGenerator(RM8110, DEFAULTS, PARTS, NO_WALLCLOCK);
    const c = await runGenerator(RM8110, { ...DEFAULTS, BF: 620, ML: 3240, P: 120 }, PARTS, NO_WALLCLOCK);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(JSON.stringify(b.plan)).toBe(JSON.stringify(a.plan));
    expect(b.stats.interruptTicks).toBe(a.stats.interruptTicks);
    expect(c.plan.instances.length).toBe(2 + 27);
    expect(c.plan.instances[2].stretch).toEqual([{ axis: 'y', atMm: 210, byMm: 200 }]);
  });

  it('counts every run (A7 counter)', async () => {
    const before = getGeneratorRunCount();
    await runGenerator(RM8110, DEFAULTS, PARTS, NO_WALLCLOCK);
    expect(getGeneratorRunCount()).toBe(before + 1);
  });
});

describe('runGenerator — budgets (tick counter, not wallclock)', () => {
  it('while(true) stops at the tick budget and the next run works', async () => {
    const r = await runGenerator(ENDLESS, {}, PARTS, { ...NO_WALLCLOCK, maxInterruptTicks: 50 });
    expect(errCode(r)).toBe('limit-ticks');
    expect(r.stats.interruptTicks).toBe(51);
    const next = await runGenerator(RM8110, DEFAULTS, PARTS, NO_WALLCLOCK);
    expect(next.ok).toBe(true);
  });

  it('the default tick budget is what stops a runaway rule (not the wallclock)', async () => {
    const r = await runGenerator(ENDLESS, {}, PARTS, NO_WALLCLOCK);
    expect(errCode(r)).toBe('limit-ticks');
  });

  it('10^6 instances, 10^5 nodes, 3 MB string', async () => {
    const many = await runGenerator(
      'function generate(){ var a=[]; for(var i=0;i<1000000;i++) a.push({part:"Guide",positionMm:[i,0,0]}); return {instances:a}; }',
      {}, PARTS, ROOMY,
    );
    expect(errCode(many)).toBe('limit-instances');
    const nodes = await runGenerator(
      'function generate(){ var a=[]; for(var i=0;i<100000;i++) a.push({name:"n"+i,positionMm:[0,0,0]}); return {nodes:a}; }',
      {}, PARTS, ROOMY,
    );
    expect(errCode(nodes)).toBe('limit-nodes');
    const big = await runGenerator(
      'function generate(){ var s="x"; while(s.length < 3*1024*1024) s += s; return {messages:[{level:"info",text:s}]}; }',
      {}, PARTS, NO_WALLCLOCK,
    );
    expect(errCode(big)).toBe('limit-size');
  });

  it('structural limits: stretch count, string length, vertices', async () => {
    const stretch = await runGenerator(
      'function generate(){ var s=[]; for(var i=0;i<17;i++) s.push({axis:"x",atMm:1,byMm:1}); return {instances:[{part:"Guide",positionMm:[0,0,0],stretch:s}]}; }',
      {}, PARTS, NO_WALLCLOCK,
    );
    expect(errCode(stretch)).toBe('limit-stretch');
    const str = await runGenerator(
      'function generate(){ return {nodes:[{name:new Array(300).join("a"),positionMm:[0,0,0]}]}; }', {}, PARTS, NO_WALLCLOCK,
    );
    expect(errCode(str)).toBe('limit-string');
    const verts = await runGenerator(
      'function generate(){ var a=[]; for(var i=0;i<10;i++) a.push({part:"Roller420",positionMm:[i,0,0]}); return {instances:a}; }',
      {}, PARTS, { ...NO_WALLCLOCK, maxVertices: 3000 },
    );
    expect(errCode(verts)).toBe('limit-vertices');
  });

  it('memory hog → limit-memory', async () => {
    const r = await runGenerator(MEMORY_HOG, {}, PARTS, { ...NO_WALLCLOCK, maxInterruptTicks: 1e9 });
    expect(errCode(r)).toBe('limit-memory');
  });
});

describe('runGenerator — hostile results stay inside the VM budget', () => {
  const tight = { ...NO_WALLCLOCK, maxInterruptTicks: 200 };
  it('cyclic object', async () => {
    const r = await runGenerator('function generate(){ var o={}; o.self=o; return o; }', {}, PARTS, tight);
    expect(errCode(r)).toBe('runtime-error');
  });
  it('getter with an endless loop', async () => {
    const r = await runGenerator('function generate(){ return { get instances(){ while(true){} } }; }', {}, PARTS, tight);
    expect(errCode(r)).toBe('limit-ticks');
  });
  it('toJSON with an endless loop', async () => {
    const r = await runGenerator('function generate(){ return { toJSON: function(){ while(true){} } }; }', {}, PARTS, tight);
    expect(errCode(r)).toBe('limit-ticks');
  });
  it('depth 50', async () => {
    const r = await runGenerator(
      'function generate(){ var o={}; var c=o; for(var i=0;i<50;i++){ c.a={}; c=c.a; } return {components:[{node:"n",type:"T",fields:o}]}; }',
      {}, PARTS, tight,
    );
    expect(errCode(r)).toBe('limit-depth');
  });
  it('unknown plan keys, unknown parts, missing generate, syntax errors, non-objects', async () => {
    expect(errCode(await runGenerator('function generate(){ return {grandchildren:[]}; }', {}, PARTS, tight))).toBe('invalid-plan');
    expect(errCode(await runGenerator('function generate(){ return {instances:[{part:"Nope",positionMm:[0,0,0]}]}; }', {}, PARTS, tight))).toBe('invalid-plan');
    expect(errCode(await runGenerator('var x = 1;', {}, PARTS, tight))).toBe('no-generate');
    expect(errCode(await runGenerator('function generate( {', {}, PARTS, tight))).toBe('syntax-error');
    expect(errCode(await runGenerator('function generate(){ return 5; }', {}, PARTS, tight))).toBe('invalid-plan');
  });
});

describe('runGenerator — zero host surface, no trust gate', () => {
  it('self, Date and Math.random are undefined; runs without ?scripts', async () => {
    expect(new URLSearchParams(location.search).has('scripts')).toBe(false);
    const r = await runGenerator(
      'function generate(){ return {messages:[{level:"info",text:[typeof self, typeof Date, typeof Math.random, typeof fetch].join(",")}]}; }',
      {}, PARTS, NO_WALLCLOCK,
    );
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (r.ok) expect(r.plan.messages[0].text).toBe('undefined,undefined,undefined,undefined');
  });

  it('a running script component keeps working while a generator hits its memory limit', async () => {
    const host = await RVScriptHost.create();
    hosts.push(host);
    const ctx = host.createContext({ callDeadlineMs: 50 });
    expect(ctx.loadScript('function setup(){ var n = 0; return { tick: function(){ n++; return n; } }; }').ok).toBe(true);
    expect(ctx.runSetup().ok).toBe(true);
    expect(ctx.callHandler('tick')).toEqual({ ok: true, value: 1 });
    const r = await runGenerator(MEMORY_HOG, {}, PARTS, { ...NO_WALLCLOCK, maxInterruptTicks: 1e9 });
    expect(errCode(r)).toBe('limit-memory');
    expect(ctx.callHandler('tick')).toEqual({ ok: true, value: 2 });
  });
});
