// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-st-compiler.test.ts — plan-242 Phase 1 (IEC 61131-3 ST → JS compiler).
 *
 * Contract of `compileSt()` (plan-242 §9.1 + §9.6):
 *  - expressions with IEC precedence, assignments, IF/ELSIF/ELSE, CASE,
 *    FOR (with BY), WHILE, REPEAT/UNTIL, nested blocks
 *  - FB call syntax + member access (mock FB via `__env.fb`)
 *  - TIME literals (T#2s → 2000 ms) and hex literals (16#FF → 255)
 *  - type errors (INT := REAL), unknown variables, non-BOOL conditions and
 *    syntax errors are line/column diagnostics — compileSt NEVER throws
 *  - division by zero throws at scan time (catchable — ERROR state in phase 2)
 *  - externals[].written reflects assignment, mem persists between scans
 *
 * The generated jsSource is executed here via `new Function` (trusted test
 * context) — the QuickJS sandbox integration is phase 2.
 *
 * Runs only in the private build (imports `@rv-private/plc/st-compiler`).
 */

import { describe, it, expect } from 'vitest';
import { compileSt, type CompiledProgram } from '@rv-private/plc/st-compiler';

// ─── Helpers ───────────────────────────────────────────────────────────────

interface PlcEnv {
  ext: Record<string, boolean | number>;
  mem: Record<string, boolean | number>;
  fb: Record<string, unknown>;
}

type ScanFn = (env: PlcEnv) => void;

function compileOk(source: string): CompiledProgram {
  const r = compileSt(source);
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  expect(errors).toEqual([]);
  expect(r.program).toBeDefined();
  return r.program!;
}

function makeScan(source: string): ScanFn {
  const program = compileOk(source);
  // Trusted test context — the real runtime evaluates jsSource inside the
  // QuickJS sandbox (type:'global'), so it must be plain global-eval JS.
  return new Function(`${program.jsSource}\nreturn scan;`)() as ScanFn;
}

function env(
  ext: Record<string, boolean | number> = {},
  fb: Record<string, unknown> = {},
): PlcEnv {
  return { ext, mem: {}, fb };
}

/** Mock FB instance: records `call(inputs)` and exposes fixed output properties. */
function mockFb(outputs: Record<string, boolean | number> = {}) {
  const calls: Array<Record<string, boolean | number>> = [];
  return Object.assign(
    {
      calls,
      call(inputs: Record<string, boolean | number>) {
        calls.push(inputs);
      },
    },
    outputs,
  );
}

const P = (body: string, decls = '') => `PROGRAM Main\n${decls}\n${body}\nEND_PROGRAM`;

// ─── Expressions & precedence ───────────────────────────────────────────────

describe('ST compiler — expressions', () => {
  it('compiles 1 + 2 * 3 with IEC precedence (→ 7 in the executed scan)', () => {
    const scan = makeScan(P('x := 1 + 2 * 3;', 'VAR x : INT; END_VAR'));
    const e = env();
    scan(e);
    expect(e.mem.x).toBe(7);
  });

  it('respects parentheses: (1 + 2) * 3 → 9', () => {
    const scan = makeScan(P('x := (1 + 2) * 3;', 'VAR x : INT; END_VAR'));
    const e = env();
    scan(e);
    expect(e.mem.x).toBe(9);
  });

  it('binds comparison tighter than OR/AND: b := 1 + 2 * 3 = 7 OR FALSE', () => {
    const scan = makeScan(P('b := 1 + 2 * 3 = 7 OR FALSE;', 'VAR b : BOOL; END_VAR'));
    const e = env();
    scan(e);
    expect(e.mem.b).toBe(true);
  });

  it('supports NOT, XOR, MOD and unary minus', () => {
    const scan = makeScan(
      P(
        'a := NOT FALSE; b := TRUE XOR TRUE; m := 7 MOD 3; n := -2 + 5;',
        'VAR a : BOOL; b : BOOL; m : INT; n : INT; END_VAR',
      ),
    );
    const e = env();
    scan(e);
    expect(e.mem.a).toBe(true);
    expect(e.mem.b).toBe(false);
    expect(e.mem.m).toBe(1);
    expect(e.mem.n).toBe(3);
  });

  it('parses hex literals: 16#FF → 255', () => {
    const scan = makeScan(P('x := 16#FF;', 'VAR x : INT; END_VAR'));
    const e = env();
    scan(e);
    expect(e.mem.x).toBe(255);
  });

  it('parses TIME literals to milliseconds (T#2s, T#500ms, T#1m30s, TIME#1h)', () => {
    const scan = makeScan(
      P(
        't1 := T#2s; t2 := T#500ms; t3 := T#1m30s; t4 := TIME#1h;',
        'VAR t1 : TIME; t2 : TIME; t3 : TIME; t4 : TIME; END_VAR',
      ),
    );
    const e = env();
    scan(e);
    expect(e.mem.t1).toBe(2000);
    expect(e.mem.t2).toBe(500);
    expect(e.mem.t3).toBe(90000);
    expect(e.mem.t4).toBe(3600000);
  });

  it('keywords are case-insensitive', () => {
    const scan = makeScan('program p var x : int; end_var x := 1 + 1; end_program');
    const e = env();
    scan(e);
    expect(e.mem.x).toBe(2);
  });

  it('skips (* block *) and // line comments', () => {
    const scan = makeScan(
      P('x := 1; (* x := 99; *)\n// x := 98;\nx := x + 1;', 'VAR x : INT; END_VAR'),
    );
    const e = env();
    scan(e);
    expect(e.mem.x).toBe(2);
  });
});

// ─── Assignments & externals ────────────────────────────────────────────────

describe('ST compiler — assignments and VAR_EXTERNAL', () => {
  const source = P(
    'MotorOn := SensorA;',
    'VAR_EXTERNAL SensorA : BOOL; MotorOn : BOOL; END_VAR',
  );

  it('reads and writes externals through __env.ext', () => {
    const scan = makeScan(source);
    const e = env({ SensorA: true, MotorOn: false });
    scan(e);
    expect(e.ext.MotorOn).toBe(true);
  });

  it('reports externals[].written correctly (read-only vs. assigned)', () => {
    const program = compileOk(source);
    expect(program.name).toBe('Main');
    expect(program.externals).toEqual([
      { name: 'SensorA', type: 'BOOL', written: false },
      { name: 'MotorOn', type: 'BOOL', written: true },
    ]);
  });

  it('warns about a VAR_EXTERNAL that is declared but never used', () => {
    const r = compileSt(
      P('x := 1;', 'VAR_EXTERNAL Unused : BOOL; END_VAR VAR x : INT; END_VAR'),
    );
    expect(r.program).toBeDefined(); // warnings do not block compilation
    const warnings = r.diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('Unused');
  });

  it('persists mem between two scan() calls (and initialises type defaults)', () => {
    const scan = makeScan(P('count := count + 1;', 'VAR count : INT; END_VAR'));
    const e = env();
    scan(e);
    expect(e.mem.count).toBe(1); // default 0 + 1 on first scan
    scan(e);
    expect(e.mem.count).toBe(2);
  });
});

// ─── Control flow ───────────────────────────────────────────────────────────

describe('ST compiler — control flow', () => {
  it('IF / ELSIF / ELSE selects the right branch', () => {
    const scan = makeScan(
      P(
        'IF Mode = 1 THEN Res := 10; ELSIF Mode = 2 THEN Res := 20; ELSE Res := 30; END_IF;',
        'VAR_EXTERNAL Mode : INT; Res : INT; END_VAR',
      ),
    );
    for (const [mode, expected] of [
      [1, 10],
      [2, 20],
      [99, 30],
    ] as const) {
      const e = env({ Mode: mode, Res: 0 });
      scan(e);
      expect(e.ext.Res).toBe(expected);
    }
  });

  it('CASE with single values, label lists and ELSE', () => {
    const scan = makeScan(
      P(
        'CASE Mode OF 1: Res := 10; 2, 3: Res := 23; ELSE Res := 99; END_CASE;',
        'VAR_EXTERNAL Mode : INT; Res : INT; END_VAR',
      ),
    );
    for (const [mode, expected] of [
      [1, 10],
      [2, 23],
      [3, 23],
      [7, 99],
    ] as const) {
      const e = env({ Mode: mode, Res: 0 });
      scan(e);
      expect(e.ext.Res).toBe(expected);
    }
  });

  it('FOR sums 1..5 (implicit BY 1)', () => {
    const scan = makeScan(
      P('FOR i := 1 TO 5 DO sum := sum + i; END_FOR;', 'VAR i : INT; sum : INT; END_VAR'),
    );
    const e = env();
    scan(e);
    expect(e.mem.sum).toBe(15);
  });

  it('FOR with BY 2 and a negative BY step', () => {
    const scan = makeScan(
      P(
        'FOR i := 1 TO 5 BY 2 DO up := up + i; END_FOR; FOR i := 5 TO 1 BY -1 DO down := down + i; END_FOR;',
        'VAR i : INT; up : INT; down : INT; END_VAR',
      ),
    );
    const e = env();
    scan(e);
    expect(e.mem.up).toBe(9); // 1 + 3 + 5
    expect(e.mem.down).toBe(15); // 5 + 4 + 3 + 2 + 1
  });

  it('WHILE loops while the condition holds', () => {
    const scan = makeScan(P('WHILE n < 5 DO n := n + 1; END_WHILE;', 'VAR n : INT; END_VAR'));
    const e = env();
    scan(e);
    expect(e.mem.n).toBe(5);
  });

  it('REPEAT/UNTIL executes the body at least once', () => {
    const scan = makeScan(
      P('n := 10; REPEAT n := n + 1; UNTIL n > 0 END_REPEAT;', 'VAR n : INT; END_VAR'),
    );
    const e = env();
    scan(e);
    expect(e.mem.n).toBe(11); // body ran once although n > 0 was already true
  });

  it('handles nested blocks (FOR with IF/CASE inside)', () => {
    const scan = makeScan(
      P(
        `FOR i := 1 TO 6 DO
           IF i MOD 2 = 0 THEN
             CASE i OF 2: even := even + 10; ELSE even := even + 1; END_CASE;
           END_IF;
         END_FOR;`,
        'VAR i : INT; even : INT; END_VAR',
      ),
    );
    const e = env();
    scan(e);
    expect(e.mem.even).toBe(12); // i=2 → +10, i=4 → +1, i=6 → +1
  });
});

// ─── Function blocks ────────────────────────────────────────────────────────

describe('ST compiler — function blocks', () => {
  const tonSource = P(
    'tDelay(IN := StartBtn, PT := T#2s); MotorOn := tDelay.Q;',
    'VAR tDelay : TON; END_VAR VAR_EXTERNAL StartBtn : BOOL; MotorOn : BOOL; END_VAR',
  );

  it('emits FB calls against __env.fb and reads output members', () => {
    const scan = makeScan(tonSource);
    const ton = mockFb({ Q: true });
    const e = env({ StartBtn: true, MotorOn: false }, { tDelay: ton });
    scan(e);
    expect(ton.calls).toEqual([{ IN: true, PT: 2000 }]);
    expect(e.ext.MotorOn).toBe(true);
  });

  it('lists FB instances in the compile result', () => {
    const program = compileOk(tonSource);
    expect(program.fbInstances).toEqual([{ name: 'tDelay', fbType: 'TON' }]);
  });

  it('canonicalises case-insensitive parameter and member names (in/pt → IN/PT)', () => {
    const scan = makeScan(
      P(
        'tDelay(in := TRUE, pt := T#1s); Q := tDelay.q;',
        'VAR tDelay : TON; Q : BOOL; END_VAR',
      ),
    );
    const ton = mockFb({ Q: true });
    const e = env({}, { tDelay: ton });
    scan(e);
    expect(ton.calls).toEqual([{ IN: true, PT: 1000 }]);
    expect(e.mem.Q).toBe(true);
  });

  it('rejects unknown FB parameters and members', () => {
    const badParam = compileSt(
      P('tDelay(FOO := TRUE);', 'VAR tDelay : TON; END_VAR'),
    );
    expect(badParam.program).toBeUndefined();
    expect(badParam.diagnostics.some((d) => d.message.includes("unknown parameter 'FOO'"))).toBe(
      true,
    );

    const badMember = compileSt(
      P('x := tDelay.Foo;', 'VAR tDelay : TON; x : BOOL; END_VAR'),
    );
    expect(badMember.program).toBeUndefined();
    expect(badMember.diagnostics.some((d) => d.message.includes("unknown member 'Foo'"))).toBe(
      true,
    );
  });

  it('rejects wrongly typed FB parameters (PT := 5 is INT, not TIME)', () => {
    const r = compileSt(P('tDelay(IN := TRUE, PT := 5);', 'VAR tDelay : TON; END_VAR'));
    expect(r.program).toBeUndefined();
    const err = r.diagnostics.find((d) => d.severity === 'error');
    expect(err?.message).toMatch(/PT.*TIME.*INT/);
  });
});

// ─── Diagnostics ────────────────────────────────────────────────────────────

describe('ST compiler — diagnostics', () => {
  it('reports line/column diagnostics for syntax errors instead of throwing', () => {
    let r: ReturnType<typeof compileSt> | undefined;
    expect(() => {
      r = compileSt('PROGRAM P x := ; END_PROGRAM');
    }).not.toThrow();
    expect(r!.program).toBeUndefined();
    expect(r!.diagnostics.length).toBeGreaterThan(0);
    expect(r!.diagnostics[0].severity).toBe('error');
    expect(r!.diagnostics[0].line).toBe(1);
    expect(r!.diagnostics[0].column).toBeGreaterThan(1);
  });

  it('reports multiple syntax errors in one pass (error recovery)', () => {
    const r = compileSt('PROGRAM P\nx := ;\ny := ;\nEND_PROGRAM');
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors[0].line).toBe(2);
    expect(errors[1].line).toBe(3);
  });

  it('rejects INT := REAL with a positioned type error (narrowing)', () => {
    const r = compileSt('PROGRAM P\nVAR x : INT; r : REAL; END_VAR\nx := r;\nEND_PROGRAM');
    expect(r.program).toBeUndefined();
    const err = r.diagnostics.find((d) => d.severity === 'error');
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/REAL/);
    expect(err!.message).toMatch(/INT/);
    expect(err!.line).toBe(3);
    expect(err!.column).toBe(1);
  });

  it('allows widening conversions (INT → DINT, INT/DINT → REAL)', () => {
    const scan = makeScan(
      P('d := i; r := d;', 'VAR i : INT; d : DINT; r : REAL; END_VAR'),
    );
    const e = env();
    scan(e);
    expect(e.mem.d).toBe(0);
  });

  it('rejects INT := DINT (narrowing DINT → INT needs an explicit cast)', () => {
    const r = compileSt(P('i := d;', 'VAR i : INT; d : DINT; END_VAR'));
    expect(r.program).toBeUndefined();
    expect(r.diagnostics.some((d) => d.message.includes('DINT'))).toBe(true);
  });

  it('rejects BOOL := INT (BOOL is only assignable from BOOL)', () => {
    const r = compileSt(P('b := 1;', 'VAR b : BOOL; END_VAR'));
    expect(r.program).toBeUndefined();
  });

  it('reports unknown variables with their name', () => {
    const r = compileSt(P('x := foo;', 'VAR x : INT; END_VAR'));
    expect(r.program).toBeUndefined();
    const err = r.diagnostics.find((d) => d.severity === 'error');
    expect(err?.message).toContain("unknown variable 'foo'");
  });

  it('reports unknown declaration types', () => {
    const r = compileSt(P('x := 1;', 'VAR x : FLOAT; END_VAR'));
    expect(r.program).toBeUndefined();
    expect(r.diagnostics.some((d) => d.message.includes("unknown type 'FLOAT'"))).toBe(true);
  });

  it('enforces BOOL conditions in IF and WHILE', () => {
    const ifRes = compileSt(P('IF 1 THEN x := 1; END_IF;', 'VAR x : INT; END_VAR'));
    expect(ifRes.program).toBeUndefined();
    expect(ifRes.diagnostics.some((d) => d.message.includes('must be BOOL'))).toBe(true);

    const whileRes = compileSt(P('WHILE 5 DO x := 1; END_WHILE;', 'VAR x : INT; END_VAR'));
    expect(whileRes.program).toBeUndefined();
    expect(whileRes.diagnostics.some((d) => d.message.includes('must be BOOL'))).toBe(true);
  });

  it('enforces INT/DINT FOR control variables', () => {
    const r = compileSt(
      P('FOR f := 1 TO 5 DO x := x + 1; END_FOR;', 'VAR f : REAL; x : INT; END_VAR'),
    );
    expect(r.program).toBeUndefined();
    expect(r.diagnostics.some((d) => d.message.includes('FOR control variable'))).toBe(true);
  });
});

// ─── Runtime semantics of the generated code ────────────────────────────────

describe('ST compiler — generated code semantics', () => {
  it('INT / INT uses truncating integer division (7 / 2 → 3)', () => {
    const scan = makeScan(P('x := 7 / 2;', 'VAR x : INT; END_VAR'));
    const e = env();
    scan(e);
    expect(e.mem.x).toBe(3);
  });

  it('REAL division keeps the fraction (7.0 / 2.0 → 3.5)', () => {
    const scan = makeScan(P('r := 7.0 / 2.0;', 'VAR r : REAL; END_VAR'));
    const e = env();
    scan(e);
    expect(e.mem.r).toBe(3.5);
  });

  it('division by zero throws a catchable Error at scan time', () => {
    const scan = makeScan(P('x := 5 / y;', 'VAR x : INT; y : INT; END_VAR'));
    expect(() => scan(env())).toThrow(/Division by zero/);
  });

  it('MOD by zero throws a catchable Error at scan time', () => {
    const scan = makeScan(P('x := 5 MOD y;', 'VAR x : INT; y : INT; END_VAR'));
    expect(() => scan(env())).toThrow(/Division by zero/);
  });

  it('generates global-eval-safe code (no import/export/fetch)', () => {
    const program = compileOk(P('x := 1;', 'VAR x : INT; END_VAR'));
    expect(program.jsSource).toContain('function scan(__env)');
    expect(program.jsSource).not.toMatch(/\b(import|export|fetch)\b/);
  });
});
