// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-lint.test.ts — plan-210 §6b DES-safety lint v1 (three rules,
 * positive + negative cases, DesSafe escalation, comment/string immunity).
 */

import { describe, it, expect } from 'vitest';
import { lintDesSafety, loadDesAstCheck } from '../src/core/sdk/rv-des-lint';

const EVENT_ONLY = `
function setup(self) {
  return {
    des: {
      onAccept(mu) { self.in(1.5, 'done', mu); return true; },
      on(hook, mu) { if (hook === 'done') self.transfer(mu); },
    },
  };
}
`;

describe('des-lint — rule (a): continuous.fixedUpdate', () => {
  it('flags a fixedUpdate handler as warning (default) with position', () => {
    const code = `function setup(self) {\n  return { continuous: { fixedUpdate(dt) {} } };\n}`;
    const d = lintDesSafety(code);
    const hit = d.filter((x) => x.rule === 'fixed-update');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('warning');
    expect(hit[0].line).toBe(2);
    expect(hit[0].message).toMatch(/continuous-only/);
  });

  it('escalates to error when DesSafe is true', () => {
    const code = `function setup(self) { return { continuous: { fixedUpdate: (dt) => {} } }; }`;
    const d = lintDesSafety(code, { desSafe: true });
    const hit = d.filter((x) => x.rule === 'fixed-update');
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('error');
    expect(hit[0].message).toMatch(/DesSafe/);
  });

  it('does not flag event-only components or lateFixedUpdate-free code', () => {
    expect(lintDesSafety(EVENT_ONLY).filter((x) => x.rule === 'fixed-update')).toHaveLength(0);
  });

  it('ignores the word fixedUpdate inside comments and strings', () => {
    const code = `// continuous: { fixedUpdate(dt) {} }\nconst s = "fixedUpdate(dt)";\n/* fixedUpdate: function(){} */`;
    expect(lintDesSafety(code)).toHaveLength(0);
  });
});

describe('des-lint — rule (b): dt accumulation', () => {
  it('flags x -= dt and x += dt', () => {
    const code = `function setup(self) {\n  let t = 0;\n  return { continuous: { } };\n}\nfunction tick(dt) { clearTimer -= dt; total += dt; }`;
    const d = lintDesSafety(code).filter((x) => x.rule === 'dt-accumulation');
    expect(d).toHaveLength(2);
    expect(d[0].severity).toBe('warning');
    expect(d[0].message).toMatch(/self\.in/);
  });

  it('flags the explicit form x = x - dt', () => {
    const d = lintDesSafety('timer = timer - dt;').filter((x) => x.rule === 'dt-accumulation');
    expect(d).toHaveLength(1);
  });

  it('escalates to error when DesSafe is true', () => {
    const d = lintDesSafety('t -= dt;', { desSafe: true });
    expect(d[0].severity).toBe('error');
  });

  it('does not flag unrelated arithmetic or dt reads', () => {
    const code = `const v = speed * dt;\nconst d2 = dt / 2;\npos = target;`;
    expect(lintDesSafety(code).filter((x) => x.rule === 'dt-accumulation')).toHaveLength(0);
  });
});

describe('des-lint — rule (c): blocked globals', () => {
  it('flags Date / setTimeout / setInterval / Math.random as errors with an explanation', () => {
    const code = [
      'const t = Date.now();',
      'setTimeout(() => {}, 100);',
      'setInterval(() => {}, 100);',
      'const r = Math.random();',
    ].join('\n');
    const d = lintDesSafety(code).filter((x) => x.rule === 'blocked-global');
    expect(d).toHaveLength(4);
    for (const diag of d) expect(diag.severity).toBe('error');
    expect(d.find((x) => x.line === 1)?.message).toMatch(/self\.now/);
    expect(d.find((x) => x.line === 4)?.message).toMatch(/self\.random/);
  });

  it('blocked globals are errors even without DesSafe (they are not exposed at all)', () => {
    const d = lintDesSafety('Math.random();', { desSafe: false });
    expect(d[0].severity).toBe('error');
  });

  it('does not flag self.random() or the word update inside strings', () => {
    const code = `const r = self.random();\nself.log("Date is a blocked global");`;
    expect(lintDesSafety(code)).toHaveLength(0);
  });
});

describe('des-lint rule (d): AST state check', () => {
  it('refuses undeclared state with a persistence hint', async () => {
    await loadDesAstCheck();
    const d = lintDesSafety('function setup(self) { let n = 0; return { des: { on() { n++; } } }; }', { desSafe: true, checkState: true });
    expect(d.some(x => x.rule === 'des-script-undeclared-state' && x.severity === 'error')).toBe(true);
    expect(d.find(x => x.rule === 'des-script-undeclared-state')?.message).toMatch(/use self.persist/);
  });
});

describe('des-lint — rule (e): live geometry sampling in DES-hook components (plan-262)', () => {
  it('flags worldPosition() in a component with DES hooks as a hint-level warning', () => {
    const code = `function setup(self) {\n  const n = self.node('Part');\n  return { des: { on(hook, mu) { const p = n.worldPosition(); } } };\n}`;
    const d = lintDesSafety(code).filter((x) => x.rule === 'geometry-sampling');
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe('warning');
    expect(d[0].message).toMatch(/settle/);
    expect(d[0].line).toBe(3);
  });

  it('stays a warning even with DesSafe: true (hint level, never escalated)', () => {
    const code = `return { des: { on() { self.node('X').worldQuaternion(); } } };`;
    const d = lintDesSafety(code, { desSafe: true }).filter((x) => x.rule === 'geometry-sampling');
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe('warning');
  });

  it('does not flag geometry reads in components WITHOUT DES hooks, or inside comments/strings', () => {
    const noDes = `function setup(self) {\n  return { continuous: { fixedUpdate(dt) { self.node('X').worldPosition(); } } };\n}`;
    expect(lintDesSafety(noDes).filter((x) => x.rule === 'geometry-sampling')).toHaveLength(0);
    const commented = `return { des: { on() {} } };\n// n.worldPosition()\nconst s = "worldPosition()";`;
    expect(lintDesSafety(commented).filter((x) => x.rule === 'geometry-sampling')).toHaveLength(0);
  });
});

describe('des-lint — clean component', () => {
  it('an event-only DesSafe component passes with zero diagnostics', () => {
    expect(lintDesSafety(EVENT_ONLY, { desSafe: true })).toHaveLength(0);
  });

  it('diagnostics come back sorted by position', () => {
    const code = `t += dt;\nMath.random();\nfixedUpdate(dt) {}`;
    const d = lintDesSafety(code);
    const lines = d.map((x) => x.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});
