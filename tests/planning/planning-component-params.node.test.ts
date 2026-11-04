// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 test 9.10 (pure half) — planning parameters that are EXISTING component
 * properties: the one key format, the derivation from the schema, the one writer, the
 * `initial` start value and `selection[]` in the scenario block.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_KEY_HASH_HEX,
  PROBLEM_SELECTION_INVALID,
  PROBLEM_SELECTION_UNSUPPORTED,
  componentParamEffectiveKey,
  componentParamKey,
  deriveComponentParamDef,
  parseComponentSelection,
  registerComponentParamResolver,
  sha256Hex,
  type ComponentParamEnv,
  type ComponentParamFieldInfo,
  type ComponentParamTarget,
  type PlanningReconfig,
} from '../../src/core/planning/rv-planning-component-params';
import { readComponentField, writeComponentField } from '../../src/core/params/rv-param-field';
import { isValidPlanningKey, parsePlanningDeclaration } from '../../src/core/planning/rv-planning-params';
import { createPlanningRegistry } from '../../src/core/planning/rv-planning-registry';
import {
  isEffectivePlanningKey, isEmptyScenarioBlock, parsePlanningScenarios, planningScenariosPayload,
  withScenario, withSelection, emptyScenarioBlock,
} from '../../src/core/planning/rv-planning-scenario';

// ─── A fake viewer side ────────────────────────────────────────────────────

type Node = { userData: Record<string, unknown> };

function makeEnv(opts: {
  nodes: Record<string, Node>;
  schema: Record<string, Record<string, ComponentParamFieldInfo>>;
  reconfig?: Record<string, PlanningReconfig>;
}): ComponentParamEnv & { reads: number } {
  const env = {
    reads: 0,
    schemaField: (component: string, field: string) => opts.schema[component]?.[field] ?? null,
    reconfigOf: (t: ComponentParamTarget) => opts.reconfig?.[t.component] ?? null,
    resolves: (address: string) => address in opts.nodes,
    documentValue: (t: ComponentParamTarget) => { env.reads++; return readComponentField(opts.nodes[t.address], t.component, t.field); },
    currentValue: (t: ComponentParamTarget) => readComponentField(opts.nodes[t.address], t.component, t.field),
    nodeLabel: (address: string) => `Line/${address}`,
  };
  return env;
}

const SOURCE_SCHEMA: Record<string, ComponentParamFieldInfo> = {
  Interval: { type: 'number', unit: 's', default: 0 },
  LimitNumber: { type: 'boolean', default: false },
  Mode: { type: 'enum', enum: ['Fixed', 'Random'], default: 'Fixed' },
  Count: { type: 'string', default: '' },
  Total: { type: 'number', readonly: true },
  Run: { type: 'boolean', signal: 'PLCOutputBool' },
  Belt: { type: 'ComponentReference', refType: 'Drive' },
};

function sourceNode(interval: unknown = 2): Node {
  return { userData: { realvirtual: { Source: { Interval: interval, LimitNumber: false, Mode: 'Fixed' } } } };
}

// ─── Key format ────────────────────────────────────────────────────────────

describe('componentParamKey — the one key format (§2.14)', () => {
  it('hashes the address with SHA-256 (pinned against node:crypto)', () => {
    for (const text of ['', 'abc', '#n1', 'p7/p9#4f1c-…-ü', 'x'.repeat(200)]) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });

  it('is stable, distinct for two placements of the same file, and fits the registry key alphabet', () => {
    const a = componentParamKey('placeA#node-1', 'Source', 'Interval');
    const b = componentParamKey('placeB#node-1', 'Source', 'Interval');
    expect(a).toBe(componentParamKey('placeA#node-1', 'Source', 'Interval'));
    expect(a).not.toBe(b);
    expect(a).toBe(`a${sha256Hex('placeA#node-1').slice(0, COMPONENT_KEY_HASH_HEX)}.Source.Interval`);
    expect(isValidPlanningKey(a)).toBe(true);
    const eff = componentParamEffectiveKey('placeA#node-1', 'Source', 'Interval')!;
    expect(isEffectivePlanningKey(eff)).toBe(true);
    // splitKey cuts at the FIRST dot: owner 'component', the rest is the owner-local key.
    expect(eff.slice(0, eff.indexOf('.'))).toBe('component');
    expect(eff.slice(eff.indexOf('.') + 1)).toBe(a);
  });

  it('keeps a nested field path as dotted segments and refuses unusable names', () => {
    expect(componentParamKey('#n', 'ScriptComponent', 'Values.speed')).toMatch(/^a[0-9a-f]{20}\.ScriptComponent\.Values\.speed$/);
    expect(componentParamKey('', 'Source', 'Interval')).toBeNull();
    expect(componentParamKey('#n', 'Sou rce', 'Interval')).toBeNull();
    expect(componentParamKey('#n', 'Source', 'Values..x')).toBeNull();
    expect(componentParamKey('#n', 'Source', '__proto__')).toBeNull();
  });
});

// ─── The one writer ────────────────────────────────────────────────────────

describe('writeComponentField — the one writer', () => {
  it('writes a nested field path nested, never as a literal "Values.x" key', () => {
    const node: Node = { userData: {} };
    expect(writeComponentField(node, 'ScriptComponent', 'Values.speed', 3)).toBe(true);
    expect(node.userData).toEqual({ realvirtual: { ScriptComponent: { Values: { speed: 3 } } } });
    expect(readComponentField(node, 'ScriptComponent', 'Values.speed')).toBe(3);
    expect(writeComponentField(node, 'ScriptComponent', 'Values.speed', 3)).toBe(false);
  });

  it('never overwrites a non-object with an object and refuses prototype segments', () => {
    const node: Node = { userData: { realvirtual: { Script: { Values: 7 } } } };
    expect(() => writeComponentField(node, 'Script', 'Values.speed', 1)).toThrow(/not an object/);
    expect(() => writeComponentField(node, 'Script', 'constructor.x', 1)).toThrow(/invalid/);
  });
});

// ─── Derivation ────────────────────────────────────────────────────────────

describe('deriveComponentParamDef (§2.14)', () => {
  const env = makeEnv({ nodes: { '#src': sourceNode(2) }, schema: { Source: SOURCE_SCHEMA }, reconfig: { Source: 'des-extras' } });

  it('takes type, unit and options from the schema; default = the stored value; always reset/factor', () => {
    const v = deriveComponentParamDef({ address: '#src', component: 'Source', field: 'Interval' }, env);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.def).toMatchObject({ type: 'number', unit: 's', default: 2, apply: 'reset', role: 'factor', group: 'Components' });
    expect(v.def.target).toEqual({ address: '#src', component: 'Source', field: 'Interval' });
    expect(v.def.label).toBe('Line/#src · Interval');
    expect(v.def.initial).toBeUndefined(); // = default
    const e = deriveComponentParamDef({ address: '#src', component: 'Source', field: 'Mode' }, env);
    expect(e.ok && e.def.options).toEqual([{ id: 'Fixed', label: 'Fixed' }, { id: 'Random', label: 'Random' }]);
  });

  it('uses the schema default only when the field is absent', () => {
    const bare = makeEnv({ nodes: { '#s': { userData: { realvirtual: { Source: {} } } } }, schema: { Source: SOURCE_SCHEMA }, reconfig: { Source: 'des-extras' } });
    const v = deriveComponentParamDef({ address: '#s', component: 'Source', field: 'Interval' }, bare);
    expect(v.ok && v.def.default).toBe(0);
  });

  it('narrows the range from the selection without changing the type', () => {
    const v = deriveComponentParamDef({ address: '#src', component: 'Source', field: 'Interval', min: 1, max: 10, step: 0.5, label: 'Takt' }, env);
    expect(v.ok && v.def).toMatchObject({ type: 'number', min: 1, max: 10, step: 0.5, label: 'Takt' });
    const b = deriveComponentParamDef({ address: '#src', component: 'Source', field: 'LimitNumber', min: 1, max: 2 }, env);
    expect(b.ok && b.def.type).toBe('boolean');
    expect(b.ok && b.def.min).toBeUndefined();
    const out = deriveComponentParamDef({ address: '#src', component: 'Source', field: 'Interval', min: 5, max: 10 }, env);
    expect(out).toMatchObject({ ok: false, code: PROBLEM_SELECTION_INVALID });
  });

  it('refuses readonly, signal, reference and non-scalar fields', () => {
    for (const field of ['Total', 'Run', 'Belt', 'Count', 'Missing']) {
      expect(deriveComponentParamDef({ address: '#src', component: 'Source', field }, env)).toMatchObject({ ok: false, code: PROBLEM_SELECTION_INVALID });
    }
  });

  it('a type without a re-config path is unsupported, an unknown address unresolved', () => {
    const none = makeEnv({ nodes: { '#d': { userData: { realvirtual: { Drive: { TargetSpeed: 100 } } } } }, schema: { Drive: { TargetSpeed: { type: 'number', unit: 'mm/s' } } } });
    expect(deriveComponentParamDef({ address: '#d', component: 'Drive', field: 'TargetSpeed' }, none))
      .toMatchObject({ ok: false, code: PROBLEM_SELECTION_UNSUPPORTED });
    expect(deriveComponentParamDef({ address: '#gone', component: 'Source', field: 'Interval' }, env))
      .toMatchObject({ ok: false, code: 'unresolved' });
  });

  it('never changes a field while deriving', () => {
    const node = sourceNode(2);
    const e = makeEnv({ nodes: { '#n': node }, schema: { Source: SOURCE_SCHEMA }, reconfig: { Source: 'des-extras' } });
    const before = JSON.stringify(node.userData);
    deriveComponentParamDef({ address: '#n', component: 'Source', field: 'Interval' }, e);
    expect(JSON.stringify(node.userData)).toBe(before);
  });

  it('a registered per-type resolver answers for a nested path (plan-2003 K1 seam)', () => {
    const off = registerComponentParamResolver('ScriptComponent', (t) => (t.field === 'Values.speed' ? { type: 'integer', unit: 'rpm', default: 5 } : null));
    try {
      const e = makeEnv({
        nodes: { '#sc': { userData: { realvirtual: { ScriptComponent: { Values: { speed: 7 } } } } } },
        schema: {}, reconfig: { ScriptComponent: 'rebuild' },
      });
      const v = deriveComponentParamDef({ address: '#sc', component: 'ScriptComponent', field: 'Values.speed' }, e);
      expect(v.ok && v.def).toMatchObject({ type: 'integer', unit: 'rpm', default: 7 });
      expect(v.ok && v.reconfig).toBe('rebuild');
    } finally { off(); }
  });
});

// ─── initial vs default in the registry ────────────────────────────────────

describe('initial (start value) vs default (Reset to defaults)', () => {
  function registry() {
    return createPlanningRegistry({ problems: { report: () => {}, clear: () => {} } });
  }
  const def = { key: 'x', label: 'X', type: 'number' as const, default: 2, initial: 5, group: 'g', apply: 'reset' as const };

  it('declaring with initial ≠ default commits initial — no pending value, no log row', () => {
    const r = registry();
    r.declare({ owner: 'component', title: 'C', params: [def] });
    const p = r.list().find((s) => s.key === 'component.x')!;
    expect(p.value).toBe(5);
    expect(p.pending).toBeUndefined();
    expect(p.source).toBe('default');
    expect(r.getSnapshot().pendingCount).toBe(0);
    expect(r.changeLog()).toEqual([]);
    // Reset to defaults targets the DEFAULT (the document value), as a pending reset value.
    expect(r.nonDefaultKeys('component')).toEqual(['component.x']);
    r.resetToDefaults('component', 'ui');
    expect(r.list().find((s) => s.key === 'component.x')!.pending).toBe(2);
  });

  it('a dormant scenario value wins over initial', () => {
    const r = registry();
    r.loadScenario({ 'component.x': 9 });
    r.declare({ owner: 'component', title: 'C', params: [def] });
    const p = r.list().find((s) => s.key === 'component.x')!;
    expect(p.value).toBe(9);
    expect(p.source).toBe('scenario');
  });

  it('an unusable initial is dropped and reported; the parameter stays', () => {
    const parsed = parsePlanningDeclaration({ owner: 'o', title: 't', params: [{ ...def, min: 0, max: 4 }] });
    expect(parsed.errors.map((e) => e.code)).toEqual(['initial-invalid']);
    expect(parsed.declaration!.params[0].initial).toBeUndefined();
  });

  it('a value set back to the default survives dispose + redeclare (it is not the initial)', () => {
    const r = registry();
    const h = r.declare({ owner: 'component', title: 'C', params: [def] });
    r.set('component.x', 2, 'ui');
    return r.applyPendingAndReset().then(() => {
      expect(r.list().find((s) => s.key === 'component.x')!.value).toBe(2);
      h.dispose();
      r.declare({ owner: 'component', title: 'C', params: [def] });
      expect(r.list().find((s) => s.key === 'component.x')!.value).toBe(2);
    });
  });

  it('forgetDormant drops a value instead of leaving an orphan', () => {
    const r = registry();
    r.loadScenario({ 'component.gone': 1 });
    expect(r.forgetDormant(['component.gone'])).toBe(true);
    expect(r.dormant()).toEqual({});
  });
});

// ─── selection[] in the scenario block ─────────────────────────────────────

describe('selection[] in PlanningScenarios', () => {
  const entry = { address: 'p1#n7', component: 'Source', field: 'Interval', label: 'Takt', min: 1, max: 60 };

  it('round-trips through payload and parse; a block with a selection is not empty', () => {
    const block = withScenario(withSelection(emptyScenarioBlock(), [entry]), 'Basis', { [componentParamEffectiveKey(entry.address, 'Source', 'Interval')!]: 4 });
    expect(isEmptyScenarioBlock(block)).toBe(false);
    const parsed = parsePlanningScenarios({ PlanningScenarios: JSON.parse(JSON.stringify(planningScenariosPayload(block))) });
    expect(parsed.issues).toEqual([]);
    expect(parsed.block!.selection).toEqual([entry]);
    expect(Object.values(parsed.block!.scenarios.Basis)).toEqual([4]);
  });

  it('a file without selection[] reads unchanged (no field), a bad entry is dropped and named', () => {
    const plain = parsePlanningScenarios({ PlanningScenarios: { version: 1, active: 'Basis', scenarios: { Basis: {} } } });
    expect(plain.block).toEqual({ version: 1, active: 'Basis', scenarios: { Basis: {} } });
    const sel = parseComponentSelection([entry, { address: 'x', component: 'A B', field: 'f' }, entry, { ...entry, field: 'Mode', min: 'low' }]);
    expect(sel.selection).toEqual([entry]);
    expect(sel.issues).toHaveLength(3);
    expect(isEmptyScenarioBlock(withSelection(emptyScenarioBlock(), []))).toBe(true);
  });
});
