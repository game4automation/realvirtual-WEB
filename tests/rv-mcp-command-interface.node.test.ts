// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.0 — the reduced command interface: `web_commands`, `web_execute`,
 * `web_batch` over the app-wide command registry.
 *
 * Fixture commands (`t641.*`, scope 'none') are registered into the real
 * `commandRegistry` and removed again after each test, so the tools are tested
 * exactly as the bridge calls them. The editor alias parity
 * (`web_editor_set_field` ≡ `web_execute('editor.setField')`) needs the private
 * editor and a real AssetDocument — it lives in the browser test
 * `rv-mcp-macro-editor.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry, type CommandDescriptor, type CommandImpl } from '../src/core/hmi/rv-command-registry';
import { ERR_EDITOR_UNAVAILABLE } from '../src/core/editor/rv-editor-guard-core';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { McpCommandTools, findSimilarCommands, parseBatchSteps } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { McpMacroTools } from '../src/plugins/mcp-bridge/rv-mcp-macro-tools';
import { macroJobs, macroRecorder } from '../src/plugins/mcp-bridge/rv-mcp-macro';

const viewer = {
  modes: { activeMode: 'hmi' },
  selectionManager: { getSnapshot: () => ({ selectedPaths: [] }) },
} as unknown as RVViewer;

const ran: Array<{ id: string; args: unknown }> = [];
const cleanups: Array<() => void> = [];

function reg<A>(id: string, impl: Partial<CommandImpl<A, unknown>>, extra: Partial<CommandDescriptor<A, unknown>> = {}): void {
  const full: CommandImpl<A, unknown> = {
    enabled: () => true,
    async run(_ctx, a) { ran.push({ id, args: a }); return { ok: true }; },
    ...impl,
  };
  cleanups.push(commandRegistry.register<A, unknown>({
    id, label: `Label ${id}`, readOnly: false, scope: 'none', available: true,
    unavailableReason: ERR_EDITOR_UNAVAILABLE, argsSchema: { path: 'string' },
    impl: async () => full, eagerImpl: full, ...extra,
  }));
}

const tools = new McpCommandTools(() => viewer);
const parse = async (p: Promise<string>): Promise<Record<string, unknown>> => JSON.parse(await p);

beforeEach(() => {
  ran.length = 0;
  setActiveAssetContext(null);
  reg('t641.alpha', {});
  reg('t641.refuse', { enabled: () => ({ reason: 'Select a node first' }) });
  reg('t641.partial', { async run() { return { skipped: ['A/x'] }; } });
  reg('t641.commercial', {}, { available: false });
  reg('t641.read', {}, { readOnly: true });
  reg('t641.macro', { resolveArgs: (_c, a) => a }, { macro: true });
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  macroRecorder._resetForTest();
  macroJobs._resetForTest();
});

describe('plan-641 §9.0 — web_commands', () => {
  it('lists registered commands with argsSchema, readOnly, macro, available and filters by query', async () => {
    const all = await parse(tools.webCommands());
    const rows = all['commands'] as Array<Record<string, unknown>>;
    for (const row of rows) expect(row.door).toBe(row.readOnly ? 'web_query' : 'web_execute');
    expect(rows.find((r) => r.id === 't641.read')).toMatchObject({ door: 'web_query' });
    const alpha = rows.find((r) => r['id'] === 't641.alpha');
    expect(alpha).toMatchObject({ label: 'Label t641.alpha', argsSchema: { path: 'string' }, readOnly: false, door: 'web_execute', macro: false, available: true });
    expect(rows.find((r) => r['id'] === 't641.macro')?.['macro']).toBe(true);
    expect(rows.find((r) => r['id'] === 't641.commercial')).toMatchObject({ available: false, unavailableReason: ERR_EDITOR_UNAVAILABLE });

    const filtered = await parse(tools.webCommands('t641.'));
    expect((filtered['commands'] as Array<{ id: string }>).map((r) => r.id).sort()).toEqual([
      't641.alpha', 't641.commercial', 't641.macro', 't641.partial', 't641.read', 't641.refuse',
    ]);
    expect(filtered['count']).toBe(6);
  });
});

describe('plan-641 §9.0 — web_execute', () => {
  it('runs one command and returns the ExecuteResult value with a status', async () => {
    const r = await parse(tools.webExecute('t641.alpha', '{"path":"A/B"}'));
    expect(r).toMatchObject({ ok: true, command: 't641.alpha', status: 'ok', value: { ok: true }, recorded: false });
    expect(ran).toEqual([{ id: 't641.alpha', args: { path: 'A/B' } }]);
  });

  it('meta arguments never reach the command', async () => {
    await tools.webExecute('t641.alpha', '{"path":"A"}', 'because', 'parts:X', 'observed');
    expect(ran[0].args).toEqual({ path: 'A' });
  });

  it('an unknown id answers kind unknown with similar ids', async () => {
    const r = await parse(tools.webExecute('t641.alpah'));
    expect(r).toMatchObject({ ok: false, status: 'failed', kind: 'unknown' });
    expect(r['similar']).toContain('t641.alpha');
    expect(findSimilarCommands('t641.partal')).toContain('t641.partial');
  });

  it('a refusal answers the command reason; a commercial-only command answers unavailable / requires-commercial', async () => {
    expect(await parse(tools.webExecute('t641.refuse'))).toMatchObject({ ok: false, status: 'failed', kind: 'disabled', error: 'Select a node first' });
    expect(await parse(tools.webExecute('t641.commercial'))).toMatchObject({
      ok: false, status: 'requires-commercial', kind: 'unavailable', error: ERR_EDITOR_UNAVAILABLE,
    });
  });

  it('bad args JSON is a clear error', async () => {
    expect(await parse(tools.webExecute('t641.alpha', '{oops'))).toEqual({ error: 'args is not valid JSON' });
    expect(await parse(tools.webExecute('t641.alpha', '[1]'))).toEqual({ error: 'args must be a JSON object' });
  });
});

describe('plan-641 §9.0 — web_batch', () => {
  it('runs steps in order and reports per step', async () => {
    const r = await parse(tools.webBatch(JSON.stringify([
      { command: 't641.alpha', args: { path: '1' } },
      { command: 't641.partial' },
      { command: 't641.alpha', args: { path: '2' }, _reason: 'second' },
    ])));
    expect(r).toMatchObject({ ok: true, total: 3, ran: 3 });
    expect((r['steps'] as Array<{ status: string }>).map((s) => s.status)).toEqual(['ok', 'partial', 'ok']);
    expect(ran.map((x) => x.args)).toEqual([{ path: '1' }, { path: '2' }]);
  });

  it('stopOnError (default) stops after the first failed step', async () => {
    const r = await parse(tools.webBatch(JSON.stringify([
      { command: 't641.alpha' }, { command: 't641.refuse' }, { command: 't641.alpha' },
    ])));
    expect(r).toMatchObject({ ok: false, total: 3, ran: 2, stopped: { step: 2, status: 'failed' } });
  });

  it('stopOnError=false runs on; stopOnPartial stops at a partial; requires-commercial never stops', async () => {
    const steps = JSON.stringify([{ command: 't641.refuse' }, { command: 't641.commercial' }, { command: 't641.partial' }, { command: 't641.alpha' }]);
    const r1 = await parse(tools.webBatch(steps, false));
    expect((r1['steps'] as Array<{ status: string }>).map((s) => s.status)).toEqual(['failed', 'requires-commercial', 'partial', 'ok']);
    const r2 = await parse(tools.webBatch(steps, false, true));
    expect(r2).toMatchObject({ ran: 3, stopped: { step: 3, status: 'partial' } });
  });

  it('background=true returns a jobId at once; web_macro_status reports the job', async () => {
    const r = await parse(tools.webBatch(JSON.stringify([{ command: 't641.alpha' }, { command: 't641.alpha' }]), true, false, true));
    expect(typeof r['jobId']).toBe('string');
    const macroTools = new McpMacroTools(() => viewer);
    // Each job line lazily imports the dialog policy; cold under a loaded machine that
    // takes well over 250 ms, so wait for the terminal state rather than a fixed count.
    await vi.waitFor(async () => {
      const st = await parse(macroTools.webMacroStatus(r['jobId'] as string));
      expect(st['state']).not.toBe('running');
    }, { timeout: 5000, interval: 10 });
    const s = await parse(macroTools.webMacroStatus(r['jobId'] as string));
    expect(s).toMatchObject({ kind: 'batch', state: 'done', progress: { done: 2, total: 2 }, counts: { ok: 2 } });
  });

  it('parseBatchSteps rejects malformed input with the step number', () => {
    expect(parseBatchSteps('[]')).toEqual({ error: 'steps must be a non-empty JSON array' });
    expect(parseBatchSteps('[{"args":{}}]')).toEqual({ error: 'step 1: "command" is required' });
    expect(parseBatchSteps('[{"command":"a","args":"{x"}]')).toEqual({ error: 'step 1: args is not valid JSON' });
  });
});
