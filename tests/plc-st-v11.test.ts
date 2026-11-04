// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, it, expect, afterEach } from 'vitest';
import { compileSt, type CompiledProgram } from '@rv-private/plc/st-compiler';
import { RVPlcRunner } from '@rv-private/plc/rv-plc-runner';
import { SignalStore } from '../src/core/engine/rv-signal-store';
const P = (body: string, decls = '') => `PROGRAM Main\n${decls}\n${body}\nEND_PROGRAM`;
function compileOk(source: string): CompiledProgram {
  const r = compileSt(source);
  expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  expect(r.program).toBeDefined();
  return r.program!;
}
function env() { return { ext: {}, mem: {} as Record<string, number | boolean>, fb: {} }; }
function makeScan(source: string) {
  return new Function(`${compileOk(source).jsSource}\nreturn scan;`)() as (e: ReturnType<typeof env>) => void;
}
function fails(source: string, message?: RegExp) {
  const r = compileSt(source);
  expect(r.program).toBeUndefined();
  const errors = r.diagnostics.filter(d => d.severity === 'error');
  expect(errors.length).toBeGreaterThan(0);
  for (const d of errors) { expect(d.line).toBeGreaterThan(0); expect(d.column).toBeGreaterThan(0); }
  if (message) expect(errors.some(d => message.test(d.message))).toBe(true);
}
describe('ST v1.1 initializers and constants', () => {
  it('initializes all elementary types once, preserves warm memory and restores cold memory', () => {
    const scan = makeScan(P('', `VAR x : INT := 5; b : BOOL := TRUE; r : REAL := 1.5;
      t : TIME := T#2s; n : DINT := 16#FF; m : INT := -3; END_VAR`));
    const e = env(); scan(e);
    expect(e.mem).toEqual({ x: 5, b: true, r: 1.5, t: 2000, n: 255, m: -3 });
    e.mem.x = 99; scan(e); expect(e.mem.x).toBe(99);
    e.mem = {}; scan(e); expect(e.mem.x).toBe(5);
  });
  it('folds constants in declaration order and omits them from vars and memory', () => {
    const source = P('FOR i := 1 TO K DO sum := sum + 1; END_FOR',
      'VAR CONSTANT K : INT := 4; END_VAR VAR a : INT := k * 2; i : INT; sum : INT; END_VAR');
    const program = compileOk(source); const e = env(); makeScan(source)(e);
    expect(e.mem.a).toBe(8); expect(e.mem.sum).toBe(4);
    expect(e.mem).not.toHaveProperty('K'); expect(program.vars.map(v => v.name)).not.toContain('K');
    expect(program.fbInits).toEqual([]);
  });
  it.each([['7 / 2', 3], ['-7 / 2', -3], ['7 MOD 3', 1], ['-7 MOD 3', -1]] as const)('folds %s with runtime integer semantics', (expr, value) => {
    const e = env(); makeScan(P('', `VAR x : INT := ${expr}; END_VAR`))(e); expect(e.mem.x).toBe(value);
  });
  it('folds REAL division', () => {
    const e = env(); makeScan(P('', 'VAR x : REAL := 7.0 / 2.0; END_VAR'))(e); expect(e.mem.x).toBe(3.5);
  });
  it.each([
    'VAR b : INT; a : INT := b; END_VAR', 'VAR x : INT := 1.5; END_VAR',
    'VAR CONSTANT K : INT; END_VAR', 'VAR CONSTANT t : TON := (PT := T#2s); END_VAR',
    'VAR_EXTERNAL x : INT := 1; END_VAR', 'VAR x : INT := 1 / 0; END_VAR',
    'VAR x : INT := 1 MOD 0; END_VAR', 'VAR x : REAL := 1.0e308 * 2.0; END_VAR',
    'VAR CONSTANT A : INT := B; B : INT := 1; END_VAR',
    'VAR CONSTANT A : INT := B; B : INT := A; END_VAR',
    'VAR CONSTANT A : INT := A; END_VAR',
  ])('rejects invalid declaration: %s', decls => fails(P('', decls)));
  it('rejects constant writes and FOR control variables', () => {
    const decls = 'VAR CONSTANT K : INT := 2; END_VAR';
    fails(P('K := 1;', decls), /constant/i);
    fails(P('FOR K := 1 TO 3 DO END_FOR', decls), /constant/i);
  });
  const decls = 'VAR CONSTANT K : INT := 2; L : INT := 4; END_VAR VAR s : INT; x : INT; END_VAR';
  it.each([
    ['K: x := 1; L: x := 2;', 4, 2],
    ['1: x := 1; K: x := 2;', 2, 2],
    ['K, 3: x := 3;', 3, 3],
    ['K: CASE s OF K: x := 7; L: x := 8; END_CASE L: x := 9;', 2, 7],
    ['K: x := 1; x := x + 1; L: x := 9;', 2, 2],
  ] as const)('parses CASE arm heads: %s', (arms, selector, value) => {
    const e = env(); makeScan(P(`s := ${selector}; CASE s OF ${arms} END_CASE`, decls))(e);
    expect(e.mem.x).toBe(value);
  });
  it.each([
    ['VAR CONSTANT K : INT := 2; END_VAR', -2, 1],
    ['VAR CONSTANT K : INT := 2; END_VAR', 2, 9],
    ['VAR CONSTANT K : INT := -2; END_VAR', 2, 1],
    ['VAR CONSTANT K : INT := -2; END_VAR', -2, 9],
  ] as const)('negated named CASE label -K (%s) selector %s', (cdecl, selector, value) => {
    const e = env();
    makeScan(P(`s := ${selector}; x := 0; CASE s OF -K: x := 1; ELSE x := 9; END_CASE`, `${cdecl} VAR s : INT; x : INT; END_VAR`))(e);
    expect(e.mem.x).toBe(value);
  });
  describe('negative constants substituted into expressions', () => {
    const neg = 'VAR CONSTANT K : INT := -2; END_VAR';
    it('x := -K and double negation', () => {
      const e = env();
      makeScan(P('x := -K; y := - -K; z := 3 - K; w := K * -K;', `${neg} VAR x : INT; y : INT; z : INT; w : INT; END_VAR`))(e);
      expect([e.mem.x, e.mem.y, e.mem.z, e.mem.w]).toEqual([2, -2, 5, -4]);
    });
    it('FOR bound -K', () => {
      const e = env();
      makeScan(P('n := 0; FOR i := -K TO 4 DO n := n + 1; END_FOR', `${neg} VAR i : INT; n : INT; END_VAR`))(e);
      expect(e.mem.n).toBe(3);
    });
    it('initializer a : INT := -K', () => {
      const e = env();
      makeScan(P('', `${neg} VAR a : INT := -K; b : INT := K; END_VAR`))(e);
      expect([e.mem.a, e.mem.b]).toEqual([2, -2]);
    });
    it('CASE label K with negative K', () => {
      const e = env();
      makeScan(P('s := -2; CASE s OF K: x := 1; ELSE x := 9; END_CASE', `${neg} VAR s : INT; x : INT; END_VAR`))(e);
      expect(e.mem.x).toBe(1);
    });
  });
  it('detects duplicate CASE labels when -K equals a numeric label', () => {
    const d = 'VAR CONSTANT K : INT := 2; END_VAR VAR s : INT; x : INT; END_VAR';
    fails(P('CASE s OF -K: x := 1; -2: x := 2; END_CASE', d), /duplicate CASE label/i);
    fails(P('CASE s OF -2: x := 1; -K: x := 2; END_CASE', d), /duplicate CASE label/i);
    compileOk(P('CASE s OF K: x := 1; -K: x := 2; END_CASE', d));
  });
  it('parses assignment inside an arm, then reports the constant write', () => {
    fails(P('CASE s OF K: K := 1; L: x := 2; END_CASE', decls), /cannot assign to constant/i);
  });
  it('requires integer constants for named CASE labels', () => {
    fails(P('CASE s OF x: s := 1; END_CASE', 'VAR s : INT; x : INT; END_VAR'), /integer constant/i);
  });
  it('exports typed, canonical FB inputs without calling the FB', () => {
    const p = compileOk(P('', 'VAR CONSTANT N : INT := 3; END_VAR VAR t : TON := (pt := T#2s, in := TRUE); c : CTU := (PV := N); END_VAR'));
    expect(p.fbInits).toEqual([{ inst: 't', values: { PT: 2000, IN: true } }, { inst: 'c', values: { PV: 3 } }]);
    expect(p.jsSource).not.toContain('.call(');
  });
  it.each(['bad := 1', 'Q := TRUE', 'PT := TRUE', 'PT := T#1s, pt := T#2s'])('rejects invalid FB initializer %s', params => {
    fails(P('', `VAR t : TON := (${params}); END_VAR`));
  });
  it('rejects variable expressions in FB initializers', () => {
    fails(P('', 'VAR duration : TIME; t : TON := (PT := duration); END_VAR'));
  });
  it('suggests renaming CONSTANT identifiers while allowing keyword prefixes', () => {
    fails(P('', 'VAR CONSTANT : INT; END_VAR'), /rename/i);
    compileOk(P('', 'VAR ConstantValue : INT := 1; END_VAR'));
  });
});

const runners: RVPlcRunner[] = [];
afterEach(() => { for (const runner of runners) runner.dispose(); runners.length = 0; });
async function deploy(source: string, store = new SignalStore()) {
  const runner = new RVPlcRunner(store, { scanDeadlineMs: 50 });
  runners.push(runner);
  expect((await runner.deploy(source)).filter(d => d.severity === 'error')).toEqual([]);
  return runner;
}

describe('ST v1.1 EXIT and RETURN (9.4)', () => {
  it('exits FOR without incrementing its control variable', () => {
    const e = env();
    makeScan(P('FOR i := 1 TO 10 DO n := n + 1; IF i = 3 THEN EXIT; END_IF END_FOR n := n + 10;',
      'VAR i : INT; n : INT; END_VAR'))(e);
    expect(e.mem).toEqual({ i: 3, n: 13 });
  });
  it.each([
    'WHILE i < 10 DO i := i + 1; IF i = 3 THEN EXIT; END_IF END_WHILE',
    'REPEAT i := i + 1; IF i = 3 THEN EXIT; END_IF UNTIL i >= 10 END_REPEAT',
  ])('exits %s', body => {
    const e = env(); makeScan(P(body, 'VAR i : INT; END_VAR'))(e);
    expect(e.mem.i).toBe(3);
  });
  it('EXIT in CASE breaks the enclosing FOR rather than just the switch', () => {
    const e = env();
    makeScan(P(`FOR i := 1 TO 10 DO
      CASE i OF 2: EXIT; ELSE n := n + 1; END_CASE
      n := n + 10;
    END_FOR`, 'VAR i : INT; n : INT; END_VAR'))(e);
    expect(e.mem).toEqual({ i: 2, n: 11 });
  });
  it('only exits the innermost loop, and restores the outer EXIT target', () => {
    const e = env();
    makeScan(P(`FOR i := 1 TO 10 DO
      WHILE TRUE DO
        REPEAT n := n + 1; EXIT; UNTIL FALSE END_REPEAT
        n := n + 10; EXIT;
      END_WHILE
      IF i = 2 THEN EXIT; END_IF
    END_FOR`, 'VAR i : INT; n : INT; END_VAR'))(e);
    expect(e.mem).toEqual({ i: 2, n: 22 });
  });
  it.each(['EXIT;', 'IF TRUE THEN EXIT; END_IF', 'WHILE FALSE DO END_WHILE EXIT;'])('rejects EXIT outside loops: %s', body => {
    fails(P(body), /EXIT.*loop/i);
  });
  it('RETURN skips later statements and leaves earlier writes intact', () => {
    const e = env(); makeScan(P('x := 7; RETURN; x := 9;', 'VAR x : INT; END_VAR'))(e);
    expect(e.mem.x).toBe(7);
  });
  it('RETURN from CASE in a loop exits the scan and still flushes runner outputs', async () => {
    const store = new SignalStore();
    store.register('Out', 'PLC/Out', 0);
    const runner = await deploy(P(`Out := 7;
      FOR i := 1 TO 3 DO CASE i OF 1: RETURN; END_CASE END_FOR
      Out := 99;`, 'VAR_EXTERNAL Out : INT; END_VAR VAR i : INT; END_VAR'), store);
    runner.step();
    expect(runner.state).toBe('stopped'); expect(runner.lastError).toBeNull();
    expect(store.getInt('Out')).toBe(7);
  });
  it.each(['Exit', 'Return'])('reports reserved identifier %s with a rename hint', name => {
    fails(P('', `VAR ${name} : INT; END_VAR`), /reserved.*rename/i);
    compileOk(P(`${name}Value := 1;`, `VAR ${name}Value : INT; END_VAR`));
  });
});

describe('ST v1.1 FB output parameters (9.5)', () => {
  it('evaluates inputs, calls the FB once, then assigns outputs in source order', () => {
    const calls: unknown[] = [];
    const t = { Q: true, ET: 42, call(inputs: unknown) { calls.push(inputs); this.Q = false; this.ET = 900; } };
    const e = env(); e.fb = { t };
    makeScan(P('t(q => done, pt := T#1s, et => elapsed, in := done);',
      'VAR t : TON; done : BOOL := TRUE; elapsed : TIME; END_VAR'))(e);
    expect(calls).toEqual([{ PT: 1000, IN: true }]);
    expect(e.mem.done).toBe(false); expect(e.mem.elapsed).toBe(900);

  });
  it('assigns two BOOL outputs to a shared target in source order', () => {
    for (const [params, expected] of [['QU => done, QD => done', false], ['QD => done, QU => done', true]] as const) {
      const e = env(); e.fb = { c: { QU: true, QD: false, call() {} } };
      makeScan(P(`c(${params});`, 'VAR c : CTUD; done : BOOL; END_VAR'))(e);
      expect(e.mem.done).toBe(expected);
    }
  });
  it('marks VAR_EXTERNAL output targets as written and copies real FB results to the store', async () => {
    const source = P('t(Q => done, IN := TRUE, ET => elapsed, PT := T#0ms);',
      'VAR t : TON; END_VAR VAR_EXTERNAL done : BOOL; elapsed : TIME; END_VAR');
    expect(compileOk(source).externals).toEqual([
      { name: 'done', type: 'BOOL', written: true }, { name: 'elapsed', type: 'TIME', written: true },
    ]);
    const store = new SignalStore();
    store.register('done', 'PLC/done', false); store.register('elapsed', 'PLC/elapsed', 0);
    const runner = await deploy(source, store); runner.step();
    expect(runner.lastError).toBeNull(); expect(store.getBool('done')).toBe(true);
    expect(store.getFloat('elapsed')).toBe(0);
  });
  it.each([
    ['t(Q => K);', 'VAR CONSTANT K : BOOL := FALSE; END_VAR', /constant/i],
    ['t(Q => t);', '', /FB instance/i],
    ['t(bogus => done);', '', /unknown output/i],
    ['t(IN => done);', '', /unknown output/i],
    ['t(Q => missing);', '', /unknown variable/i],
    ['t(ET => done);', '', /type mismatch/i],
    ['t(Q => done, q => done);', '', /duplicate/i],
    ['t(Q := TRUE);', '', /unknown parameter/i],
  ] as const)('rejects %s with a source position', (body, extra, message) => {
    fails(P(body, `${extra} VAR t : TON; done : BOOL; END_VAR`), message);
  });
  it('rejects output bindings in FB initializers', () => {
    fails(P('', 'VAR done : BOOL; t : TON := (IN := TRUE, Q => done); END_VAR'), /initializer.*inputs/i);
  });
});

describe('ST v1.1 integer bit logic (9.5)', () => {
  it.each([
    ['16#0F0F AND 16#00FF', 15], ['NOT 0', -1], ['16#8000 OR 1', -32767],
    ['16#00FF XOR 16#0F0F', 4080], ['NOT 16#10000', -1],
    ['16#10000 AND 16#FFFF', 0], ['16#10000 OR 1', 1], ['16#10001 XOR 1', 0],
  ] as const)('evaluates INT %s = %s', (expr, expected) => {
    const e = env(); makeScan(P(`x := ${expr};`, 'VAR x : INT; END_VAR'))(e);
    expect(e.mem.x).toBe(expected);
  });
  it('uses 32 bits for DINT, masks overflow and keeps arithmetic without wrap', () => {
    const e = env();
    makeScan(P(`a := d AND 16#FFFF; b := d OR 1; c := d XOR 16#FFFF; inv := NOT d;
      wide := overflow AND d; arithmetic := 32767 + 1;`,
    'VAR d : DINT := 16#12345678; overflow : DINT := 16#1FFFFFFFF; a : DINT; b : DINT; c : DINT; inv : DINT; wide : DINT; arithmetic : INT; END_VAR'))(e);
    expect([e.mem.a, e.mem.b, e.mem.c, e.mem.inv, e.mem.wide, e.mem.arithmetic])
      .toEqual([22136, 305419897, 305441159, -305419897, 305419896, 32768]);
  });
  it('retains logical BOOL operators', () => {
    const e = env(); makeScan(P('a := TRUE AND FALSE; b := TRUE OR FALSE; c := TRUE XOR TRUE; d := NOT FALSE;',
      'VAR a : BOOL; b : BOOL; c : BOOL; d : BOOL; END_VAR'))(e);
    expect(e.mem).toEqual({ a: false, b: true, c: false, d: true });
  });
  it.each(['TRUE AND 1', '1 OR FALSE', 'TRUE XOR 2', '1.0 AND 2', '1 OR 2.0', '1.0 XOR 2.0', 'NOT 1.0', 'NOT T#1s'])('rejects invalid bit expression %s', expr => {
    fails(P(`x := ${expr};`, 'VAR x : INT; END_VAR'), /must.*BOOL|must.*INT/i);
  });
});

describe('ST v1.1 shifts and rotations (9.5)', () => {
  it.each([
    ['SHL(1, 15)', -32768], ['SHL(1, 16)', 0], ['SHL(1, 32)', 0], ['SHL(-1, 0)', -1],
    ['SHR(-1, 1)', 32767], ['SHR(-1, 16)', 0], ['SHR(-1, 32)', 0],
    ['SHR(16#10000, 1)', 0], ['ROL(16#8001, 1)', 3], ['ROR(1, 1)', -32768],
    ['ROL(16#8001, 17)', 3], ['ROR(1, 17)', -32768], ['ROL(16#8001, 16)', -32767],
    ['ROR(16#10001, 0)', 1], ['ROL(16#10000, 1)', 0], ['ROR(16#10000, 1)', 0],
    ['SHL(IN := 1, N := 2)', 4], ['shr(n := 1, in := -1)', 32767],
    ['ROR(SHL(1, 1), 1)', 1],
  ] as const)('evaluates INT %s = %s', (expr, expected) => {
    const e = env(); makeScan(P(`x := ${expr};`, 'VAR x : INT; END_VAR'))(e);
    expect(e.mem.x).toBe(expected);
  });
  it.each([
    ['SHL(d, 31)', -2147483648], ['SHL(d, 32)', 0], ['SHL(d, 64)', 0],
    ['ROR(d, 1)', -2147483648], ['ROR(d, 33)', -2147483648], ['ROL(d, 32)', 1],
    ['SHR(negative, 1)', 2147483647], ['SHR(negative, 32)', 0], ['SHR(negative, 64)', 0],
    ['ROL(high, 1)', 3], ['ROR(high, 1)', -1073741824],
    ['SHR(overflow, 1)', 0], ['ROR(overflow, 1)', 0], ['ROL(overflow, 1)', 0],
  ] as const)('evaluates DINT %s = %s', (expr, expected) => {
    const e = env(); makeScan(P(`x := ${expr};`,
      'VAR d : DINT := 1; negative : DINT := -1; high : DINT := 16#80000001; overflow : DINT := 16#100000000; x : DINT; END_VAR'))(e);
    expect(e.mem.x).toBe(expected);
  });
  it('derives width from IN rather than destination or N', () => {
    const e = env(); makeScan(P('a := ROR(1, 1); b := SHL(1, n); c := ROR(d, 1);',
      'VAR a : DINT; b : DINT; c : DINT; d : DINT := 1; n : DINT := 15; END_VAR'))(e);
    expect([e.mem.a, e.mem.b, e.mem.c]).toEqual([-32768, -32768, -2147483648]);
    fails(P('x := ROR(d, 1);', 'VAR x : INT; d : DINT; END_VAR'), /type mismatch/i);
  });
  it('keeps function words usable as variables while recognizing calls', () => {
    const e = env(); makeScan(P('SHL := 1; SHR := SHL(SHL, 2); ROL := SHR; ROR := ROL + 1;',
      'VAR SHL : INT; SHR : INT; ROL : INT; ROR : INT; END_VAR'))(e);
    expect(e.mem).toEqual({ SHL: 1, SHR: 4, ROL: 4, ROR: 5 });
  });
  it.each(['SHL(TRUE, 1)', 'SHR(1.0, 1)', 'ROL(1, 1.0)', 'ROR(1, TRUE)', 'SHL(T#1s, 1)',
    'SHL()', 'SHR(1)', 'ROL(1, 2, 3)', 'ROR(IN := 1, N := 1, N := 2)',
    'SHL(IN := 1, IN := 2)', 'SHR(IN := 1, BAD := 2)', 'ROL(1, N := 2)', 'OTHER(1, 2)'])('rejects invalid function call %s', expr => {
    fails(P(`x := ${expr};`, 'VAR x : DINT; END_VAR'));
  });
  it.each(['SHL', 'SHR', 'ROL', 'ROR'])('%s rejects negative N at runtime and enters runner error state', async name => {
    const source = P(`x := ${name}(1, n);`, 'VAR x : INT; n : INT := -1; END_VAR');
    const scan = makeScan(source); expect(() => scan(env())).toThrow(/negative.*shift/i);
    const runner = await deploy(source); runner.step();
    expect(runner.state).toBe('error'); expect(runner.lastError).toMatch(/negative.*shift/i);
  });
});

describe('ST operator precedence (IEC 61131-3 ed. 2 Table 55 / ed. 3 Annex A grammar)', () => {
  const D = 'VAR x : BOOL; f : BOOL; a : INT; b : INT; c : INT; d : INT; END_VAR';
  const run = (body: string, init: Record<string, number | boolean>) => {
    const e = env(); Object.assign(e.mem, init); makeScan(P(body, D))(e); return e.mem;
  };
  it.each([
    [true, 1, 2, true], [true, 2, 1, false], [false, 2, 1, true], [false, 1, 2, false],
  ] as const)('x = a < b binds as x = (a < b) (x=%s, a=%s, b=%s)', (x, a, b, expected) => {
    expect(run('f := x = a < b;', { x, a, b }).f).toBe(expected);
  });
  it.each([
    [1, 2, 5, 3, true], [1, 2, 3, 5, false], [2, 1, 3, 5, true], [2, 1, 5, 3, false],
  ] as const)('a < b = c > d binds as (a < b) = (c > d) (%s %s %s %s)', (a, b, c, d, expected) => {
    expect(run('f := a < b = c > d;', { a, b, c, d }).f).toBe(expected);
    expect(run('f := a < b <> c > d;', { a, b, c, d }).f).toBe(!expected);
  });
  it('binds relational stronger than equality also with >= and <=', () => {
    expect(run('f := x <> a >= b;', { x: true, a: 1, b: 2 }).f).toBe(true);
    expect(run('f := a <= b = x;', { x: true, a: 1, b: 2 }).f).toBe(true);
  });
  it('NOT binds stronger than = (INT: (NOT a) = b, not NOT (a = b))', () => {
    // (NOT 0) = 1 → -1 = 1 → FALSE; NOT (0 = 1) would be TRUE
    expect(run('f := NOT a = b;', { a: 0, b: 1 }).f).toBe(false);
    expect(run('f := NOT a = b;', { a: 0, b: -1 }).f).toBe(true);
  });
  it('pins unchanged unary precedence: NOT a AND b, -a * b', () => {
    expect(run('f := NOT x AND f;', { x: false, f: false }).f).toBe(false);
    expect(run('f := NOT x AND f;', { x: false, f: true }).f).toBe(true);
    expect(run('c := -a * b + d;', { a: 2, b: 3, d: 1 }).c).toBe(-5);
    expect(run('c := 10 - -a * b;', { a: 2, b: 3 }).c).toBe(16);
  });
  it('keeps equality left-associative: a = b = x is (a = b) = x', () => {
    // right-associative a = (b = x) would compare INT with BOOL and fail to compile
    expect(run('f := a = b = x;', { a: 1, b: 1, x: true }).f).toBe(true);
    expect(run('f := a = b = x;', { a: 1, b: 2, x: true }).f).toBe(false);
    // all-BOOL chain: (x = f) = x
    for (const [p, q] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      expect(run('f := x = f = x;', { x: p, f: q }).f).toBe((p === q) === p);
    }
  });
  it('discriminates the AND / equality boundary: FALSE AND TRUE = FALSE is FALSE AND (TRUE = FALSE)', () => {
    // wrong grouping (FALSE AND TRUE) = FALSE would give TRUE
    expect(run('f := FALSE AND TRUE = FALSE;', { f: true }).f).toBe(false);
    expect(run('f := TRUE AND FALSE = FALSE;', {}).f).toBe(true);
  });
  it('recovers across the split tiers: a < = b and a = < b give two positioned diagnostics', () => {
    const r = compileSt(P('f := a < = b;\nf := a = < b;', D));
    expect(r.program).toBeUndefined();
    const errors = r.diagnostics.filter(d => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    // P() puts the declarations on line 2, so the two statements are lines 3 and 4
    expect(errors.some(d => d.line === 3 && d.column === 10)).toBe(true);
    expect(errors.some(d => d.line === 4 && d.column === 10)).toBe(true);
    // the shared parser instance is clean again for the next source
    expect(run('f := a <= b;', { a: 1, b: 2 }).f).toBe(true);
  });
  it('still rejects chained relational operators and BOOL operands of < / >', () => {
    fails(P('f := a < b < c;', D), /must both be numeric or TIME/);
    fails(P('f := x < f;', D), /must both be numeric or TIME/);
  });
});

describe('ST comments: nesting is a compile error', () => {
  it('rejects a nested block comment at the inner (* with line and column', () => {
    const source = 'PROGRAM Main\nVAR n : INT; END_VAR\n(* outer (* inner *) n := 123; // *)\nEND_PROGRAM';
    fails(source, /nested comments/i);
    const err = compileSt(source).diagnostics.find(d => /nested comments/i.test(d.message))!;
    expect([err.line, err.column]).toEqual([3, 10]);
  });
  it('positions an inner (* on a later line of a multi-line comment', () => {
    const source = 'PROGRAM Main\nVAR n : INT; END_VAR\n(* first line\n   x (* second *)\nEND_PROGRAM';
    const err = compileSt(source).diagnostics.find(d => /nested comments/i.test(d.message))!;
    expect([err.line, err.column]).toEqual([4, 6]);
  });
  it('accepts plain block comments, // comments and (* inside a // comment', () => {
    const e = env();
    makeScan(P('n := 1; (* a\nmulti-line comment *) n := n + 1; // (* not a block start\n// *) n := 99;\nn := n + 1;',
      'VAR n : INT; END_VAR'))(e);
    expect(e.mem.n).toBe(3);
  });
});
