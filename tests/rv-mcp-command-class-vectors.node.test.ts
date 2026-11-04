// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callClassOf, commandIdsOfCall, type McpToolClass } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';

const vectors = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/command-class-vectors.json'), 'utf8')) as Array<{
  name: string; tool: string; arguments: unknown; ids: string[] | null;
}>;

describe('plan-2007 shared command class vectors', () => {
  it.each(vectors)('$name', (v) => {
    expect(commandIdsOfCall(v.tool, v.arguments)).toEqual(v.ids);
  });
});

describe('plan-2007 call classes', () => {
  const commands = new Map<string, McpToolClass>([
    ['editor.setField', 'edit'], ['plc.deploy', 'signal'], ['document.delete', 'destructive'],
    ['editor.signalSetBinding', 'signal'], ['inspect', 'read'],
  ]);
  const tools = new Map<string, McpToolClass>([['web_status', 'read']]);
  const classify = (tool: string, args: unknown) => callClassOf(tool, args, (id) => commands.get(id), (name) => tools.get(name), 'file');

  it('uses the strictest command class for mixed batches', () => {
    expect(classify('web_batch', { steps: [{ command: 'editor.setField' }, { command: 'plc.deploy' }] })).toBe('signal');
    expect(classify('web_batch', { steps: JSON.stringify([{ command: 'plc.deploy' }, { command: 'document.delete' }]) })).toBe('destructive');
    expect(classify('web_batch', { steps: [{ command: 'inspect' }] })).toBe('read');
  });

  it('fails closed for malformed arguments and defaults unknown ids to edit', () => {
    expect(classify('web_execute', { kwargs: '{broken' })).toBe('destructive');
    expect(classify('web_batch', { steps: [] })).toBe('destructive');
    expect(classify('web_execute', { command: 'unknown' })).toBe('edit');
    expect(classify('web_batch', { steps: [{ command: 'unknown' }, { command: 'plc.deploy' }] })).toBe('signal');
  });

  it('keeps the signal binding class directly, wrapped and in a batch', () => {
    expect(classify('web_execute', { command: ' editor.signalSetBinding ' })).toBe('signal');
    expect(classify('web_execute', { kwargs: '{"command":"editor.signalSetBinding"}' })).toBe('signal');
    expect(classify('web_batch', { steps: [{ command: 'editor.signalSetBinding' }] })).toBe('signal');
  });

  it('pins query, replay and ordinary tool fallback', () => {
    expect(classify('web_query', null)).toBe('read');
    expect(classify('web_macro_replay', {})).toBe('file');
    expect(classify('web_status', {})).toBe('read');
    expect(classify('web_unknown', {})).toBe('unclassified');
  });
});
