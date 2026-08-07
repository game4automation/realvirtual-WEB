// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-st-monarch.test.ts — plan-242 Phase 3 (ST Monarch grammar as pure data).
 *
 * The Monarch definition is exported as a plain object so it can be verified
 * WITHOUT loading Monaco:
 *  - keywords are matched case-insensitively (`ignoreCase: true` + canonical
 *    keyword list),
 *  - TIME literals are their own token class ('number.time') and the rule's
 *    regex accepts the same forms as the chevrotain lexer,
 *  - hex / real / int literal classes and the FB-type list are present,
 *  - the language configuration carries the ST comment toggles.
 */

import { describe, it, expect } from 'vitest';
import {
  ST_MONARCH,
  ST_LANGUAGE_CONFIGURATION,
  ST_KEYWORDS,
  ST_TYPE_KEYWORDS,
  ST_FB_TYPES,
  ST_TIME_LITERAL_RE,
  ST_HEX_LITERAL_RE,
} from '@rv-private/plugins/plc/st-monarch';

type Rule = [RegExp, unknown, ...unknown[]];

function rootRules(): Rule[] {
  return ST_MONARCH.tokenizer.root as unknown as Rule[];
}

/** Finds the first root rule whose action (string form) equals `token`. */
function ruleWithToken(token: string): Rule | undefined {
  return rootRules().find((r) => r[1] === token);
}

function matchesWhole(re: RegExp, text: string): boolean {
  const m = new RegExp(re.source, re.flags).exec(text);
  return m !== null && m[0] === text;
}

describe('ST Monarch grammar — keywords', () => {
  it('is case-insensitive (ignoreCase: true)', () => {
    expect(ST_MONARCH.ignoreCase).toBe(true);
  });

  it('classifies the ST structure keywords', () => {
    for (const kw of ['PROGRAM', 'END_PROGRAM', 'VAR_EXTERNAL', 'VAR', 'END_VAR',
      'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'FOR', 'WHILE', 'REPEAT', 'UNTIL',
      'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE']) {
      expect(ST_KEYWORDS).toContain(kw);
    }
    // Monarch keyword matching goes through the identifier rule's cases:
    const identRule = rootRules().find(
      (r) => typeof r[1] === 'object' && r[1] !== null && 'cases' in (r[1] as object),
    );
    expect(identRule).toBeDefined();
    const cases = (identRule![1] as { cases: Record<string, string> }).cases;
    expect(cases['@keywords']).toBe('keyword');
    expect(cases['@typeKeywords']).toBe('type');
    expect(cases['@fbTypes']).toBe('type.identifier');
    // The monarch object exposes the same lists under the case names.
    expect(ST_MONARCH.keywords).toEqual([...ST_KEYWORDS]);
    expect(ST_MONARCH.typeKeywords).toEqual([...ST_TYPE_KEYWORDS]);
    expect(ST_MONARCH.fbTypes).toEqual([...ST_FB_TYPES]);
  });

  it('lists all 5 elementary types and all 10 standard FBs', () => {
    expect([...ST_TYPE_KEYWORDS].sort()).toEqual(['BOOL', 'DINT', 'INT', 'REAL', 'TIME'].sort());
    expect([...ST_FB_TYPES].sort()).toEqual(
      ['TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG', 'RS', 'SR'].sort(),
    );
  });
});

describe('ST Monarch grammar — literals', () => {
  it('TIME literals are a dedicated token class (number.time)', () => {
    const rule = ruleWithToken('number.time');
    expect(rule).toBeDefined();
    expect(rule![0].source).toBe(ST_TIME_LITERAL_RE.source);
  });

  it('the TIME regex accepts the lexer-supported forms', () => {
    for (const lit of ['T#2s', 'T#500ms', 'T#1m30s', 'T#1.5s', 'TIME#2s', 't#10ms']) {
      // ignoreCase is applied by Monarch at runtime — emulate with the i flag.
      expect(matchesWhole(new RegExp(ST_TIME_LITERAL_RE.source, 'i'), lit)).toBe(true);
    }
    expect(matchesWhole(new RegExp(ST_TIME_LITERAL_RE.source, 'i'), 'T#')).toBe(false);
    expect(matchesWhole(new RegExp(ST_TIME_LITERAL_RE.source, 'i'), 'T#2x')).toBe(false);
  });

  it('hex literals are a dedicated token class (number.hex) matching 16#FF', () => {
    const rule = ruleWithToken('number.hex');
    expect(rule).toBeDefined();
    expect(matchesWhole(ST_HEX_LITERAL_RE, '16#FF')).toBe(true);
    expect(matchesWhole(ST_HEX_LITERAL_RE, '16#dead_BEEF')).toBe(true);
  });

  it('real and int literal classes exist', () => {
    expect(ruleWithToken('number.float')).toBeDefined();
    expect(ruleWithToken('number')).toBeDefined();
  });

  it('TIME literal rule precedes the identifier rule (T# must not lex as identifier)', () => {
    const rules = rootRules();
    const timeIdx = rules.findIndex((r) => r[1] === 'number.time');
    const identIdx = rules.findIndex(
      (r) => typeof r[1] === 'object' && r[1] !== null && 'cases' in (r[1] as object),
    );
    expect(timeIdx).toBeGreaterThanOrEqual(0);
    expect(timeIdx).toBeLessThan(identIdx);
  });
});

describe('ST Monarch grammar — comments + configuration', () => {
  it('block comments (* *) enter a comment state; // is a line comment', () => {
    const rules = rootRules();
    const block = rules.find((r) => r[0].source === '\\(\\*');
    expect(block).toBeDefined();
    expect(block![2]).toBe('@blockComment');
    expect(ST_MONARCH.tokenizer).toHaveProperty('blockComment');
    const line = rules.find((r) => r[0].source === '\\/\\/.*$');
    expect(line).toBeDefined();
    expect(line![1]).toBe('comment');
  });

  it('language configuration exposes the ST comment toggles + parens', () => {
    expect(ST_LANGUAGE_CONFIGURATION.comments.lineComment).toBe('//');
    expect(ST_LANGUAGE_CONFIGURATION.comments.blockComment).toEqual(['(*', '*)']);
    expect(ST_LANGUAGE_CONFIGURATION.brackets).toEqual([['(', ')']]);
  });
});
