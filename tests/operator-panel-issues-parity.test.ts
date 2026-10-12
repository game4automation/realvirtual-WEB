// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * operator-panel-issues-parity.test.ts — plan-555 9.3: the structured
 * validator issues are a refactoring, not a behaviour change.
 *
 * GOLDEN was generated from `validateOperatorPanelConfig` BEFORE the
 * structured-issues refactor (one input per error branch of
 * operator-panel-model.ts). It pins:
 *  - `validateOperatorPanelConfig(x).errors` byte-identical to the golden;
 *  - `validateOperatorPanelConfigIssues(x).issues` rendering to the same strings;
 *  - every issue's `path` a correct segment list into the raw config;
 *  - the rule (`webOperatorPanelRuleWarnings`) and the controller path
 *    (`OperatorPanelController.start`) reporting the same strings.
 */

import { describe, expect, it } from 'vitest';
import {
  OperatorPanelController, validateOperatorPanelConfig, validateOperatorPanelConfigIssues,
} from '../src/core/hmi/operator-devices/operator-panel-model';
import { webOperatorPanelRuleWarnings } from '../src/core/engine/rv-extras-validator';
import { SignalStore } from '../src/core/engine/rv-signal-store';

/** Golden inputs: one per error branch of validateOperatorPanelConfig (plan-555 9.3). */
const BTN = { label: 'Start', signal: 'S_Start', capColor: 'green', row: 1, col: 1 };
const SEL = { label: 'Mode', variant: 'knob', signal: 'S_Auto', positions: [{ legend: 'Hand', value: false }, { legend: 'Auto', value: true }], row: 2, col: 1 };
const EST = { label: 'E-stop', signal: 'S_EStop', row: 2, col: 2 };
const TOW = { name: 'Red', signal: 'L_Fault', color: 'red' };
const STA = { kind: 'idle', tone: 'neutral', text: 'READY' };
const BASE = { version: 1, id: 'p', title: 'P', buttons: [BTN], selectors: [SEL], estops: [EST], stackLight: [TOW], status: [STA] };
const w = (patch: Record<string, unknown>) => ({ ...BASE, ...patch });

interface GoldenCase { name: string; raw: unknown; signals?: string[] }

const GOLDEN_CASES: GoldenCase[] = [
  { name: 'valid', raw: BASE },
  { name: 'null', raw: null },
  { name: 'array', raw: [] },
  { name: 'string', raw: 'x' },
  { name: 'empty object', raw: {} },
  { name: 'version/id/title', raw: w({ version: 2, id: '', title: 5 }) },
  { name: 'lists not arrays', raw: w({ buttons: {}, selectors: 'x', estops: null, stackLight: 1, status: true }) },
  { name: 'list elements not objects', raw: w({ buttons: [1], selectors: [null], estops: [[]], stackLight: ['x'], status: [2] }) },
  { name: 'button fields', raw: w({ buttons: [{ legend: '', capColor: 'gren', row: 0, col: 'a' }] }) },
  { name: 'button col > columns', raw: w({ columns: 2, buttons: [{ ...BTN, col: 3 }] }) },
  { name: 'button col > default columns', raw: w({ buttons: [{ ...BTN, col: 4 }] }) },
  { name: 'lamp not object', raw: w({ buttons: [{ ...BTN, lamp: 'red' }] }) },
  { name: 'lamp fields', raw: w({ buttons: [{ ...BTN, lamp: { color: 'pink', simDriven: 'yes' } }] }) },
  { name: 'flashWhen not object', raw: w({ buttons: [{ ...BTN, lamp: { signal: 'L', color: 'red', flashWhen: 3 } }] }) },
  { name: 'condition signal/is', raw: w({ buttons: [{ ...BTN, lamp: { signal: 'L', color: 'red', flashWhen: { signal: '', is: 'x' } } }] }) },
  { name: 'condition all empty', raw: w({ buttons: [{ ...BTN, lamp: { signal: 'L', color: 'red', flashWhen: { all: [] } } }] }) },
  { name: 'condition any nested bad', raw: w({ buttons: [{ ...BTN, lamp: { signal: 'L', color: 'red', flashWhen: { any: [{ signal: 'A', is: true }, { foo: 1 }] } } }] }) },
  { name: 'condition not nested', raw: w({ buttons: [{ ...BTN, lamp: { signal: 'L', color: 'red', flashWhen: { not: { all: 'x' } } } }] }) },
  { name: 'condition two keys', raw: w({ buttons: [{ ...BTN, lamp: { signal: 'L', color: 'red', flashWhen: { all: [], any: [] } } }] }) },
  { name: 'selector fields', raw: w({ selectors: [{ caption: '', variant: 'dial', row: 1, col: 1 }] }) },
  { name: 'selector positions count', raw: w({ selectors: [{ ...SEL, positions: [{ legend: 'A', value: true }] }] }) },
  { name: 'selector positions not array', raw: w({ selectors: [{ ...SEL, positions: 'x' }] }) },
  { name: 'selector position fields', raw: w({ selectors: [{ ...SEL, positions: [5, { legend: '', value: 'no' }] }] }) },
  { name: 'selector lamp', raw: w({ selectors: [{ ...SEL, lamp: { signal: 'L', color: 'black' } }] }) },
  { name: 'estop fields', raw: w({ estops: [{ lamp: [], row: -1, col: 1.5 }] }) },
  { name: 'stackLight fields', raw: w({ stackLight: [{ name: '', color: 'black' }] }) },
  { name: 'chips not array', raw: w({ chips: {} }) },
  { name: 'chips fields', raw: w({ chips: [{ label: '', text: 'HAND', when: null, tone: 'loud' }, 7] }) },
  { name: 'chips valid', raw: w({ chips: [{ label: 'Mode', text: 'HAND', when: { signal: 'S_Auto', is: false }, tone: 'warn' }] }) },
  { name: 'status fields', raw: w({ status: [{ tone: 'bad', icon: 'star', when: 'x', step: 0 }, { kind: 'k', tone: 'ok', text: 't', step: 1.5 }] }) },
  { name: 'restart not object', raw: w({ restart: [] }) },
  { name: 'restart fields', raw: w({ restart: { hint: '', steps: [1, 'a'] } }) },
  { name: 'restart steps missing', raw: w({ restart: { hint: 'h' } }) },
  { name: 'restart valid', raw: w({ restart: { hint: 'h', steps: ['a'] } }) },
  {
    name: 'unknown signals everywhere',
    raw: w({
      buttons: [{ ...BTN, signal: 'BT9', lamp: { signal: 'L_X', color: 'green', flashWhen: { all: [{ signal: 'F1', is: true }, { not: { signal: 'F2', is: false } }] } } }],
      selectors: [{ ...SEL, signal: 'SEL9', lamp: { signal: 'L_SEL', color: 'blue' } }],
      estops: [{ ...EST, signal: 'ES9', lamp: { signal: 'L_ES', color: 'red', flashWhen: { any: [{ signal: 'F3', is: true }] } } }],
      stackLight: [{ ...TOW, signal: 'T9' }, { ...TOW, signal: 'BT9' }],
      chips: [{ label: 'c', text: 'C', when: { signal: 'C9', is: true } }],
      status: [{ ...STA, when: { any: [{ signal: 'ST9', is: true }, { all: [{ signal: 'S_Start', is: true }] }] } }, STA],
    }),
    signals: ['S_Start', 'S_Auto', 'S_EStop', 'L_Fault'],
  },
  { name: 'all signals known', raw: BASE, signals: ['S_Start', 'S_Auto', 'S_EStop', 'L_Fault'] },
  { name: 'structure errors suppress signal check', raw: w({ version: 3, buttons: [{ ...BTN, signal: 'BT9' }] }), signals: [] },
];

/** Generated BEFORE the refactor — never edit by hand. */
const GOLDEN: Record<string, string[]> = {
  "valid": [],
  "null": [
    "config must be an object"
  ],
  "array": [
    "config must be an object"
  ],
  "string": [
    "config must be an object"
  ],
  "empty object": [
    "version must be 1",
    "config.id must be a non-empty string",
    "config.title must be a non-empty string",
    "buttons must be an array",
    "selectors must be an array",
    "estops must be an array",
    "stackLight must be an array",
    "status must be an array"
  ],
  "version/id/title": [
    "version must be 1",
    "config.id must be a non-empty string",
    "config.title must be a non-empty string"
  ],
  "lists not arrays": [
    "buttons must be an array",
    "selectors must be an array",
    "estops must be an array",
    "stackLight must be an array",
    "status must be an array"
  ],
  "list elements not objects": [
    "buttons[0] must be an object",
    "selectors[0] must be an object",
    "estops[0] must be an object",
    "stackLight[0] must be an object",
    "status[0] must be an object"
  ],
  "button fields": [
    "buttons[0].label must be a non-empty string",
    "buttons[0].legend must be a non-empty string",
    "buttons[0].signal must be a non-empty string",
    "buttons[0].capColor must be one of red, yellow, green, blue, white, black (got \"gren\")",
    "buttons[0].row must be an integer ≥ 1",
    "buttons[0].col must be an integer ≥ 1"
  ],
  "button col > columns": [
    "buttons[0].col must be ≤ columns (2)"
  ],
  "button col > default columns": [
    "buttons[0].col must be ≤ columns (3)"
  ],
  "lamp not object": [
    "buttons[0].lamp must be an object"
  ],
  "lamp fields": [
    "buttons[0].lamp.signal must be a non-empty string",
    "buttons[0].lamp.color must be one of red, yellow, green, blue, white (got \"pink\")",
    "buttons[0].lamp.simDriven must be true or false"
  ],
  "flashWhen not object": [
    "buttons[0].lamp.flashWhen must be a condition object"
  ],
  "condition signal/is": [
    "buttons[0].lamp.flashWhen.signal must be a non-empty string",
    "buttons[0].lamp.flashWhen.is must be true or false"
  ],
  "condition all empty": [
    "buttons[0].lamp.flashWhen.all must be a non-empty array"
  ],
  "condition any nested bad": [
    "buttons[0].lamp.flashWhen.any[1] must be {signal,is}, {all:[…]}, {any:[…]} or {not:{…}}"
  ],
  "condition not nested": [
    "buttons[0].lamp.flashWhen.not.all must be a non-empty array"
  ],
  "condition two keys": [
    "buttons[0].lamp.flashWhen must be {signal,is}, {all:[…]}, {any:[…]} or {not:{…}}"
  ],
  "selector fields": [
    "selectors[0].label must be a non-empty string",
    "selectors[0].caption must be a non-empty string",
    "selectors[0].signal must be a non-empty string",
    "selectors[0].variant must be one of knob, key (got \"dial\")",
    "selectors[0].positions must be exactly two positions"
  ],
  "selector positions count": [
    "selectors[0].positions must be exactly two positions"
  ],
  "selector positions not array": [
    "selectors[0].positions must be exactly two positions"
  ],
  "selector position fields": [
    "selectors[0].positions[0] must be an object",
    "selectors[0].positions[1].legend must be a non-empty string",
    "selectors[0].positions[1].value must be true or false"
  ],
  "selector lamp": [
    "selectors[0].lamp.color must be one of red, yellow, green, blue, white (got \"black\")"
  ],
  "estop fields": [
    "estops[0].label must be a non-empty string",
    "estops[0].signal must be a non-empty string",
    "estops[0].lamp must be an object",
    "estops[0].row must be an integer ≥ 1",
    "estops[0].col must be an integer ≥ 1"
  ],
  "stackLight fields": [
    "stackLight[0].name must be a non-empty string",
    "stackLight[0].signal must be a non-empty string",
    "stackLight[0].color must be one of red, yellow, green, blue, white (got \"black\")"
  ],
  "chips not array": [
    "chips must be an array"
  ],
  "chips fields": [
    "chips[0].label must be a non-empty string",
    "chips[0].when must be a condition object",
    "chips[0].tone must be one of warn, neutral (got \"loud\")",
    "chips[1] must be an object"
  ],
  "chips valid": [],
  "status fields": [
    "status[0].kind must be a non-empty string",
    "status[0].text must be a non-empty string",
    "status[0].tone must be one of ok, neutral, action, fault (got \"bad\")",
    "status[0].icon must be one of check, hourglass, play, error, warning, info (got \"star\")",
    "status[0].when must be a condition object",
    "status[0].step must be an integer ≥ 1",
    "status[1].step must be an integer ≥ 1"
  ],
  "restart not object": [
    "restart must be an object"
  ],
  "restart fields": [
    "restart.hint must be a non-empty string",
    "restart.steps must be an array of strings"
  ],
  "restart steps missing": [
    "restart.steps must be an array of strings"
  ],
  "restart valid": [],
  "unknown signals everywhere": [
    "selectors[0].signal 'SEL9' not found in model",
    "selectors[0].lamp.signal 'L_SEL' not found in model",
    "buttons[0].signal 'BT9' not found in model",
    "buttons[0].lamp.signal 'L_X' not found in model",
    "buttons[0].lamp.flashWhen.all[0].signal 'F1' not found in model",
    "buttons[0].lamp.flashWhen.all[1].not.signal 'F2' not found in model",
    "estops[0].signal 'ES9' not found in model",
    "estops[0].lamp.signal 'L_ES' not found in model",
    "estops[0].lamp.flashWhen.any[0].signal 'F3' not found in model",
    "stackLight[0].signal 'T9' not found in model",
    "chips[0].when.signal 'C9' not found in model",
    "status[0].when.any[0].signal 'ST9' not found in model"
  ],
  "all signals known": [],
  "structure errors suppress signal check": [
    "version must be 1"
  ],
};

/** Cases whose STRUCTURE is valid (config !== null), from the same pre-refactor run. */
const STRUCTURALLY_VALID = new Set(["valid", "chips valid", "restart valid", "unknown signals everywhere", "all signals known"]);

const hasOf = (c: GoldenCase) => (c.signals ? (n: string) => c.signals!.includes(n) : undefined);

/** `['buttons', 0, 'signal']` → `buttons[0].signal`. */
function fmt(path: (string | number)[]): string {
  let out = '';
  for (const seg of path) out += typeof seg === 'number' ? `[${seg}]` : (out === '' ? seg : `.${seg}`);
  return out;
}

describe('plan-555 9.3 — validator issues parity (golden)', () => {
  it('covers every golden case', () => {
    expect(GOLDEN_CASES.map((c) => c.name).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  for (const c of GOLDEN_CASES) {
    it(`${c.name}: strings byte-identical, issues render the same, paths are segment lists`, () => {
      const has = hasOf(c);
      const v = validateOperatorPanelConfig(c.raw, has);
      expect(v.errors).toEqual(GOLDEN[c.name]);
      expect(v.config !== null).toBe(STRUCTURALLY_VALID.has(c.name));

      const { config, issues } = validateOperatorPanelConfigIssues(c.raw, has);
      expect(issues.map((i) => `${i.pathText} ${i.message}`)).toEqual(GOLDEN[c.name]);
      expect(config !== null).toBe(STRUCTURALLY_VALID.has(c.name));

      for (const issue of issues) {
        // pathText is the segment path, rooted at "config" for top-level scalars.
        const p = fmt(issue.path);
        expect([p, `config.${p}`, issue.path.length === 0 ? 'config' : null]).toContain(issue.pathText);
        // Every prefix but the last segment exists in the raw config (the last may be missing).
        let node: unknown = c.raw;
        for (const seg of issue.path.slice(0, -1)) {
          expect(node !== null && typeof node === 'object', `${issue.pathText}: container at ${String(seg)}`).toBe(true);
          node = (node as Record<string | number, unknown>)[seg];
        }
      }
    });
  }

  it('example segment paths', () => {
    const at = (name: string) => {
      const c = GOLDEN_CASES.find((x) => x.name === name)!;
      return validateOperatorPanelConfigIssues(c.raw, hasOf(c)).issues;
    };
    expect(at('version/id/title').map((i) => i.path)).toEqual([['version'], ['id'], ['title']]);
    expect(at('null')[0]).toEqual({ path: [], pathText: 'config', message: 'must be an object' });
    expect(at('condition not nested')[0].path).toEqual(['buttons', 0, 'lamp', 'flashWhen', 'not', 'all']);
    const unknown = at('unknown signals everywhere');
    expect(unknown[0]).toEqual({ path: ['selectors', 0, 'signal'], pathText: 'selectors[0].signal', message: "'SEL9' not found in model" });
    expect(unknown.map((i) => i.path)).toContainEqual(['buttons', 0, 'lamp', 'flashWhen', 'all', 1, 'not', 'signal']);
    expect(unknown.map((i) => i.path)).toContainEqual(['status', 0, 'when', 'any', 0, 'signal']);
  });

  it('the rule (Problems panel / inspector) reports the golden strings', () => {
    for (const c of GOLDEN_CASES) {
      if (c.raw === null || typeof c.raw !== 'object' || Array.isArray(c.raw)) continue;
      expect(webOperatorPanelRuleWarnings(JSON.stringify(c.raw), hasOf(c))).toEqual(GOLDEN[c.name]);
    }
  });

  it('the controller (structure at construction, signals at start) reports the golden strings', () => {
    for (const c of GOLDEN_CASES) {
      const ctl = new OperatorPanelController(c.raw);
      if (!c.signals) {
        expect([...ctl.getSnapshot().errors]).toEqual(GOLDEN[c.name]);
        continue;
      }
      if (!STRUCTURALLY_VALID.has(c.name)) continue;
      const store = new SignalStore();
      for (const name of c.signals) store.register(name, `Model/PLC/${name}`, false);
      const warn = console.warn;
      console.warn = () => {};
      try {
        ctl.start({ signalStore: store });
      } finally {
        console.warn = warn;
      }
      expect([...ctl.getSnapshot().errors]).toEqual(GOLDEN[c.name]);
      ctl.stop();
    }
  });
});
