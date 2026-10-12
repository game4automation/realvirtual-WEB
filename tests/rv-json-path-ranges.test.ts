// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-json-path-ranges.test.ts — plan-555 9.4: JSON path ↔ text range of the
 * JSON field editor (jsonc-parser, no Monaco).
 */

import { describe, expect, it } from 'vitest';
import { locationAt, rangeForPath, stringTokenAt } from '../src/core/hmi/json-editor/rv-json-path-ranges';

const TEXT = `{
  "version": 1,
  "buttons": [
    { "label": "Start", "signal": "S_Start", "capColor": "green" },
    { "label": "Stop", "signal": "S_Stop" }
  ]
}`;

const slice = (text: string, r: { start: number; end: number } | null) => (r ? text.slice(r.start, r.end) : null);

describe('plan-555 9.4 — rangeForPath', () => {
  it('finds the value of buttons[0].signal', () => {
    expect(slice(TEXT, rangeForPath(TEXT, ['buttons', 0, 'signal']))).toBe('"S_Start"');
    expect(slice(TEXT, rangeForPath(TEXT, ['version']))).toBe('1');
    expect(slice(TEXT, rangeForPath(TEXT, []))).toBe(TEXT);
  });

  it('a missing property marks its parent object', () => {
    expect(slice(TEXT, rangeForPath(TEXT, ['buttons', 1, 'capColor']))).toBe('{ "label": "Stop", "signal": "S_Stop" }');
    expect(slice(TEXT, rangeForPath(TEXT, ['title']))).toBe(TEXT);
  });

  it('an index past the end, or a path through a scalar, has no range', () => {
    expect(rangeForPath(TEXT, ['buttons', 2, 'signal'])).toBeNull();
    expect(rangeForPath(TEXT, ['version', 'x'])).toBeNull();
    expect(rangeForPath(TEXT, ['buttons', 'x'])).toBeNull();
  });

  it('unparsable text → null, never a throw', () => {
    expect(rangeForPath('{ "a": ', ['a'])).toBeNull();
    expect(rangeForPath('', [])).toBeNull();
    expect(rangeForPath('}{', ['a'])).toBeNull();
  });

  it('escapes and unicode keep the ranges right', () => {
    const t = '{ "k\\"ey": "a\\"b", "ü": "😀x", "n": "after" }';
    expect(slice(t, rangeForPath(t, ['k"ey']))).toBe('"a\\"b"');
    expect(slice(t, rangeForPath(t, ['ü']))).toBe('"😀x"');
    expect(slice(t, rangeForPath(t, ['n']))).toBe('"after"');
  });

  it('a trailing comma and comments are tolerated (ranges stay right)', () => {
    const t = '{\n  // note\n  "a": [1, 2,],\n  /* b */ "b": true,\n}';
    expect(slice(t, rangeForPath(t, ['a', 1]))).toBe('2');
    expect(slice(t, rangeForPath(t, ['b']))).toBe('true');
  });
});

describe('plan-555 9.4 — locationAt / stringTokenAt', () => {
  it('inside the value of signal in flashWhen.all[1] → last segment "signal", not a key', () => {
    const t = '{ "buttons": [ { "lamp": { "flashWhen": { "all": [ { "signal": "A", "is": true }, { "signal": "BX", "is": false } ] } } } ] }';
    const at = t.indexOf('"BX"') + 2;
    const loc = locationAt(t, at);
    expect(loc.path).toEqual(['buttons', 0, 'lamp', 'flashWhen', 'all', 1, 'signal']);
    expect(loc.isAtPropertyKey).toBe(false);
  });

  it('on a key → isAtPropertyKey', () => {
    const t = '{ "sig": 1 }';
    expect(locationAt(t, t.indexOf('sig') + 1).isAtPropertyKey).toBe(true);
  });

  it('string token: terminated and unterminated', () => {
    const t = '{ "signal": "S_Ru" }';
    const tok = stringTokenAt(t, t.indexOf('S_Ru') + 2)!;
    expect(t.slice(tok.start, tok.end)).toBe('"S_Ru"');
    expect(tok.terminated).toBe(true);
    // Right before the closing quote still counts as inside.
    expect(stringTokenAt(t, t.indexOf('S_Ru') + 4)?.terminated).toBe(true);
    // After the closing quote it does not.
    expect(stringTokenAt(t, t.indexOf('S_Ru') + 5)).toBeNull();

    const open = '{ "signal": "S_R\n}';
    const u = stringTokenAt(open, open.indexOf('S_R') + 3)!;
    expect(u.terminated).toBe(false);
    expect(open.slice(u.start, u.end)).toBe('"S_R');
    expect(locationAt(open, open.indexOf('S_R') + 3).path).toEqual(['signal']);
  });
});
