// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * operator-panel-json-schema.test.ts — plan-555 9.5: the operator panel JSON
 * schema (completion / hover only) cannot drift from the validator, and every
 * snippet expands to a valid device.
 */

import { describe, expect, it } from 'vitest';
import { IEC_CAP, IEC_LAMP } from '../src/core/hmi/shared-sx';
import { STATUS_ICONS, STATUS_TONES, validateOperatorPanelConfig } from '../src/core/hmi/operator-devices/operator-panel-model';
import { OPERATOR_PANEL_JSON_SCHEMA } from '../src/core/hmi/operator-devices/operator-panel-json-schema';
import { OPERATOR_PANEL_SNIPPETS } from '../src/core/hmi/operator-devices/operator-panel-snippets';

type SchemaNode = { $ref?: string; properties?: Record<string, SchemaNode>; items?: SchemaNode; enum?: readonly unknown[] };
const schema = OPERATOR_PANEL_JSON_SCHEMA as unknown as SchemaNode & { definitions: Record<string, SchemaNode> };

function resolve(node: SchemaNode): SchemaNode {
  let n = node;
  while (n.$ref) n = schema.definitions[n.$ref.replace('#/definitions/', '')];
  return n;
}

/** Every key of `value` must have a schema entry (recursively). Returns the missing paths. */
function missingKeys(value: unknown, node: SchemaNode, path: string, out: string[]): string[] {
  const n = resolve(node);
  if (Array.isArray(value)) {
    value.forEach((v, i) => { if (n.items) missingKeys(v, n.items, `${path}[${i}]`, out); else out.push(`${path}[${i}]`); });
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const child = n.properties?.[k];
      if (!child) out.push(`${path}.${k}`);
      else missingKeys(v, child, `${path}.${k}`, out);
    }
  }
  return out;
}

// Fixtures of web-operator-panel.test.tsx (CELL / STATION) and operator-devices.test.tsx (MINI).
const CELL = {
  version: 1, id: 'cell-panel', title: 'Cell',
  buttons: [
    { label: 'Start', signal: 'S_Start', capColor: 'green', lamp: { signal: 'L_Run', color: 'green' }, row: 1, col: 1 },
    { label: 'Stop', signal: 'S_Stop', capColor: 'black', row: 1, col: 2 },
  ],
  selectors: [
    { label: 'Mode', variant: 'knob', signal: 'S_Auto', positions: [{ legend: 'Hand', value: false }, { legend: 'Auto', value: true }], row: 2, col: 1 },
  ],
  estops: [{ label: 'E-stop', signal: 'S_EStop', row: 2, col: 2 }],
  stackLight: [{ name: 'Red', signal: 'L_Fault', color: 'red' }, { name: 'Green', signal: 'L_Run', color: 'green' }],
  status: [
    { kind: 'fault', tone: 'fault', text: 'FAULT', when: { signal: 'S_EStop', is: false } },
    { kind: 'running', tone: 'ok', text: 'RUNNING', when: { signal: 'L_Run', is: true } },
    { kind: 'idle', tone: 'neutral', text: 'READY' },
  ],
};
const STATION = { ...CELL, id: 'station-panel', title: 'Station', buttons: [CELL.buttons[1]], selectors: [], estops: [] };
const MINI = {
  version: 1, id: 'mini-panel', title: 'Mini panel', columns: 2,
  buttons: [{ label: 'Start', signal: 'S_Start', capColor: 'green', lamp: { signal: 'S_Run', color: 'green' }, row: 1, col: 1 }],
  selectors: [],
  estops: [{ label: 'E-stop', signal: 'S_Estop', lamp: { signal: 'S_EstopLamp', color: 'yellow' }, row: 1, col: 2 }],
  stackLight: [{ name: 'Green', signal: 'S_Run', color: 'green' }],
  status: [
    { kind: 'running', tone: 'ok', text: 'RUNNING', when: { signal: 'S_Run', is: true } },
    { kind: 'idle', tone: 'action', text: 'press START' },
  ],
};
/** Every optional field once, so their schema entries are checked too. */
const FULL = {
  ...CELL, width: 320, position: { x: 10, y: 20 }, columns: 3, headerEstop: 0,
  buttons: [{ ...CELL.buttons[0], legend: 'GO', separated: true, lamp: { signal: 'L', color: 'green', simDriven: false, flashWhen: { any: [{ not: { signal: 'A', is: true } }, { all: [{ signal: 'B', is: false }] }] } } }],
  selectors: [{ ...CELL.selectors[0], caption: 'Mode', lamp: { signal: 'L', color: 'blue' } }],
  estops: [{ ...CELL.estops[0], normallyClosed: true, lamp: { signal: 'L', color: 'red' } }],
  stackLight: [{ ...CELL.stackLight[0], simDriven: true }],
  chips: [{ label: 'Mode', text: 'HAND', when: { signal: 'S_Auto', is: false }, tone: 'warn' }],
  status: [{ kind: 'fault', tone: 'fault', icon: 'error', text: 'FAULT', step: 1, when: { signal: 'S_EStop', is: false } }],
  restart: { hint: 'Restart', steps: ['Reset', 'Start'] },
};

const def = (name: string) => schema.definitions[name].properties!;

describe('plan-555 9.5 — operator panel JSON schema', () => {
  it('enums are the validator constants', () => {
    expect(def('button').capColor.enum).toEqual(Object.keys(IEC_CAP));
    expect(def('lamp').color.enum).toEqual(Object.keys(IEC_LAMP));
    expect(def('towerSegment').color.enum).toEqual(Object.keys(IEC_LAMP));
    expect(def('status').tone.enum).toEqual([...STATUS_TONES]);
    expect(def('status').icon.enum).toEqual([...STATUS_ICONS]);
    expect(def('selector').variant.enum).toEqual(['knob', 'key']);
    expect(def('chip').tone.enum).toEqual(['warn', 'neutral']);
  });

  it('every key of the test fixtures (CELL, STATION, MINI) and of a full config has a schema entry', () => {
    for (const [name, cfg] of Object.entries({ CELL, STATION, MINI, FULL })) {
      expect(validateOperatorPanelConfig(cfg).errors, name).toEqual([]);
      expect(missingKeys(cfg, schema, name, []), name).toEqual([]);
    }
  });

  it('every property carries a description (hover)', () => {
    const undocumented: string[] = [];
    const walk = (props: Record<string, SchemaNode & { description?: string }> | undefined, at: string) => {
      for (const [k, v] of Object.entries(props ?? {})) {
        if (!v.description && !v.$ref && at !== 'position') undocumented.push(`${at}.${k}`);
      }
    };
    walk(schema.properties as never, 'root');
    for (const [name, d] of Object.entries(schema.definitions)) walk(d.properties as never, name);
    expect(undocumented).toEqual([]);
  });
});

/** Expands Monaco snippet placeholders: `${1:x}` → x, `${1|a,b|}` → a, `$1` → ''. */
function expandSnippet(body: string): string {
  return body
    .replace(/\$\{\d+\|([^,|]*)[^}]*\|\}/g, '$1')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\d+/g, '');
}

describe('plan-555 9.5 — snippets', () => {
  it('there are six snippets: button, selector, E-stop, stack-light segment, status rule, chip', () => {
    expect(OPERATOR_PANEL_SNIPPETS.map((s) => s.arrayKey).sort())
      .toEqual(['buttons', 'chips', 'estops', 'selectors', 'stackLight', 'status']);
  });

  it('each expands to a valid element — only its signal names are unknown', () => {
    for (const sn of OPERATOR_PANEL_SNIPPETS) {
      const element = JSON.parse(expandSnippet(sn.body)) as Record<string, unknown>;
      const cfg = { version: 1, id: 'p', title: 'P', buttons: [], selectors: [], estops: [], stackLight: [], status: [], [sn.arrayKey]: [element] };
      const { errors } = validateOperatorPanelConfig(cfg, () => false);
      expect(errors.length, sn.label).toBeGreaterThan(0);
      expect(errors.filter((e) => !/ not found in model$/.test(e)), sn.label).toEqual([]);
      expect(missingKeys(cfg, schema, sn.label, []), sn.label).toEqual([]);
    }
  });
});
