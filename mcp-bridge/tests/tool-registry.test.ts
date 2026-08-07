// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tool-registry.js';
import type { ToolSchema } from '../src/protocol.js';

function tool(name: string): ToolSchema {
  return { name, description: name, inputSchema: { type: 'object', properties: {}, required: [] } };
}

describe('ToolRegistry', () => {
  it('replaces the whole set on each replace()', () => {
    const reg = new ToolRegistry();
    reg.replace([tool('web_status'), tool('web_logs')]);
    expect(reg.list().map((t) => t.name).sort()).toEqual(['web_logs', 'web_status']);
    reg.replace([tool('web_find')]);
    expect(reg.list().map((t) => t.name)).toEqual(['web_find']);
  });

  it('ignores entries without a name', () => {
    const reg = new ToolRegistry();
    reg.replace([tool('web_status'), { name: '' } as ToolSchema, undefined as unknown as ToolSchema]);
    expect(reg.size).toBe(1);
    expect(reg.has('web_status')).toBe(true);
  });

  it('clears to empty', () => {
    const reg = new ToolRegistry();
    reg.replace([tool('web_status')]);
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  it('serves the timeoutMs hint but strips it from the client tool list', () => {
    const reg = new ToolRegistry();
    reg.replace([{ ...tool('web_slow'), timeoutMs: 60_000 }, tool('web_fast')]);
    expect(reg.timeoutMs('web_slow')).toBe(60_000);
    expect(reg.timeoutMs('web_fast')).toBeUndefined();
    expect(reg.timeoutMs('web_missing')).toBeUndefined();
    for (const t of reg.list()) {
      expect('timeoutMs' in t).toBe(false);
    }
  });

  // plan-327 AP3: annotations are part of the MCP tool shape and must reach the client, so both
  // transports advertise the same tool identically. Only timeoutMs is bridge-internal.
  it('passes annotations through to the client tool list', () => {
    const reg = new ToolRegistry();
    reg.replace([
      { ...tool('web_node_tree'), annotations: { readOnlyHint: true }, timeoutMs: 30_000 },
      { ...tool('web_layout_place'), annotations: { readOnlyHint: false } },
      tool('web_legacy'),
    ]);

    const byName = Object.fromEntries(reg.list().map((t) => [t.name, t]));
    expect(byName.web_node_tree.annotations).toEqual({ readOnlyHint: true });
    expect(byName.web_layout_place.annotations).toEqual({ readOnlyHint: false });
    // An old browser that classifies nothing keeps no annotation at all — the client can tell
    // "declared a write" apart from "never classified".
    expect(byName.web_legacy.annotations).toBeUndefined();
    expect('timeoutMs' in byName.web_node_tree).toBe(false);
  });

  it('treats a missing or false readOnlyHint as a write (secure by default)', () => {
    const reg = new ToolRegistry();
    reg.replace([
      { ...tool('web_status'), annotations: { readOnlyHint: true } },
      { ...tool('web_signal_set_bool'), annotations: { readOnlyHint: false } },
      { ...tool('web_unspecified'), annotations: {} },
      tool('web_legacy'),
    ]);

    expect(reg.isReadOnly('web_status')).toBe(true);
    expect(reg.isReadOnly('web_signal_set_bool')).toBe(false);
    expect(reg.isReadOnly('web_unspecified')).toBe(false);
    expect(reg.isReadOnly('web_legacy')).toBe(false);
    expect(reg.isReadOnly('web_missing')).toBe(false);
  });
});
