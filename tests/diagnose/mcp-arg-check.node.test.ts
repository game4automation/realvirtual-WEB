// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2005 T9.1 — no MCP argument is dropped silently.
 */

import { describe, expect, it } from 'vitest';
import { checkToolArgs, UNKNOWN_PARAM_PREFIX } from '../../src/plugins/mcp-bridge/rv-mcp-arg-check';

const LOGS = ['level', 'limit', 'category', 'since'];
const SIGNALS = ['filter', 'limit'];

describe('plan-2005 F6 — checkToolArgs', () => {
  it('an unknown parameter is an error naming the tool and the allowed names', () => {
    const r = checkToolArgs('web_status', ['cacheLast', 'detail'], { verbose: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.startsWith(UNKNOWN_PARAM_PREFIX)).toBe(true);
    expect(r.error).toContain("'verbose' is not a parameter of web_status");
    expect(r.error).toContain('Allowed: cacheLast, detail');
  });

  it('several unknown parameters are all named', () => {
    const r = checkToolArgs('web_status', ['detail'], { a: 1, b: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'a', 'b' are not parameters of web_status");
  });

  it('declared parameters pass unchanged', () => {
    expect(checkToolArgs('web_logs', LOGS, { level: 'warn', limit: 5 }))
      .toEqual({ ok: true, args: { level: 'warn', limit: 5 } });
  });

  it('_reason / _source / _confidence (and any _ key) pass through', () => {
    const r = checkToolArgs('web_status', [], { _reason: 'why', _source: 'doc', _confidence: 'observed', _future: 1 });
    expect(r).toEqual({ ok: true, args: { _reason: 'why', _source: 'doc', _confidence: 'observed', _future: 1 } });
  });

  it('a JSON __proto__ key is refused, it cannot smuggle parameters in', () => {
    const r = checkToolArgs('web_logs', LOGS, JSON.parse('{"__proto__":{"level":"error"}}'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'__proto__' is not a parameter");
  });

  it('web_logs: types is an alias of category', () => {
    expect(checkToolArgs('web_logs', LOGS, { types: 'signal,drive' }))
      .toEqual({ ok: true, args: { category: 'signal,drive' } });
  });

  it('web_signal_list: name and pattern are aliases of filter', () => {
    expect(checkToolArgs('web_signal_list', SIGNALS, { name: 'stapler_2' }))
      .toEqual({ ok: true, args: { filter: 'stapler_2' } });
    expect(checkToolArgs('web_signal_list', SIGNALS, { pattern: 'Fault', limit: 3 }))
      .toEqual({ ok: true, args: { filter: 'Fault', limit: 3 } });
  });

  it('an alias next to its own parameter is refused, not silently overwritten', () => {
    const r = checkToolArgs('web_logs', LOGS, { category: 'signal', types: 'drive' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'types' is an alias of 'category'");
  });

  it('an alias of another tool is not an alias here', () => {
    const r = checkToolArgs('web_status', ['cacheLast', 'detail'], { types: 'signal' });
    expect(r.ok).toBe(false);
  });

  it('a tool without parameters accepts empty / missing arguments', () => {
    expect(checkToolArgs('web_errors', [], {})).toEqual({ ok: true, args: {} });
    expect(checkToolArgs('web_errors', [], undefined)).toEqual({ ok: true, args: {} });
    const r = checkToolArgs('web_errors', [], { x: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Allowed: (none)');
  });
});
