// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry, type CapturedContext, type CommandDescriptor, type CommandImpl } from '../src/core/hmi/rv-command-registry';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { generateToolSchemas, buildMultiDispatcher } from '../src/core/engine/rv-mcp-tools';
import { CALL_CONTEXT_TOOLS, McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { McpMacroTools } from '../src/plugins/mcp-bridge/rv-mcp-macro-tools';
import { macroJobs } from '../src/plugins/mcp-bridge/rv-mcp-macro';

// The tools import a singleton: substitute a private registry for this suite.
vi.mock('../src/core/hmi/rv-command-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/rv-command-registry')>();
  return { ...actual, commandRegistry: new actual.CommandRegistry() };
});

// Dialog-store installation is covered separately; keep these job tests DOM-free.
vi.mock('../src/plugins/mcp-bridge/rv-mcp-dialog-policy', () => ({
  installMcpDialogPolicy: vi.fn(async () => () => []),
}));

const viewer = { modes: { activeMode: 'hmi' } } as unknown as RVViewer;
const tools = new McpCommandTools(() => undefined);
const macros = new McpMacroTools(() => undefined);
const cleanups: Array<() => void> = [];
const parse = async (p: Promise<string>) => JSON.parse(await p);

function register(id: string, run: CommandImpl['run'], extra: Partial<CommandDescriptor> = {}): void {
  const impl: CommandImpl = { enabled: () => true, run };
  cleanups.push(commandRegistry.register({
    id, label: id, scope: 'none', readOnly: true, available: true,
    unavailableReason: '', argsSchema: {}, impl: async () => impl, eagerImpl: impl, ...extra,
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function finished(id: string) {
  await vi.waitFor(() => expect(macroJobs.get(id)?.state).not.toBe('running'));
  return parse(macros.webMacroStatus(id));
}

beforeEach(() => {
  setActiveAssetContext(null);
  // Scope 'none' still requires a viewer. Supply only that context dependency;
  // the tool itself has no viewer/document, as on the document-free MCP path.
  const attach = commandRegistry.attachViewer.bind(commandRegistry);
  vi.spyOn(commandRegistry, 'attachViewer').mockImplementation((v) => attach(v ?? viewer));
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  commandRegistry.attachViewer(undefined);
  macroJobs._resetForTest();
  setActiveAssetContext(null);
});

describe('plan-2007 web_query and execute jobs', () => {
  it('announces both timeouts, query read-only and trailing call contexts', () => {
    const schemas = generateToolSchemas(tools);
    expect(schemas.find((s) => s.name === 'web_query')).toMatchObject({ timeoutMs: 120_000, annotations: { readOnlyHint: true } });
    expect(schemas.find((s) => s.name === 'web_execute')?.timeoutMs).toBe(120_000);
    const dispatcher = buildMultiDispatcher([tools]);
    expect(dispatcher.get('web_query')?.paramNames).toEqual(['command', 'args', 'background']);
    expect(dispatcher.get('web_execute')?.paramNames.at(-1)).toBe('background');
    expect(CALL_CONTEXT_TOOLS.has('web_query')).toBe(true);
  });

  it('runs read-only commands with full values and rejects writes before execution', async () => {
    const value = { nodes: [{ name: 'A', fields: [1, 2, 3] }] };
    register('t2007.inspect', () => value);
    expect(await parse(tools.webQuery(' t2007.inspect '))).toMatchObject({ ok: true, value, recorded: false });
    const write = vi.fn();
    register('t2007.write', write, { readOnly: false });
    expect(await parse(tools.webQuery('t2007.write'))).toEqual({
      ok: false, command: 't2007.write', status: 'failed', kind: 'not-read-only',
      error: 't2007.write is not read-only — use web_execute', use: 'web_execute',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('returns the same unknown-id answer, including similar ids, even with background', async () => {
    register('t2007.inspect', () => ({}));
    const query = await parse(tools.webQuery('t2007.inpsect', undefined, true));
    expect(query).toEqual(await parse(tools.webExecute('t2007.inpsect')));
    expect(query).toMatchObject({ kind: 'unknown', similar: ['t2007.inspect'] });
  });

  it('automatically jobs long commands and preserves the full value in status', async () => {
    const pending = deferred<unknown>();
    const value = { peak: 123, rms: 4.5, samples: [{ t: 0, data: [1, 2, 3] }] };
    register('t2007.long', () => pending.promise, { timeoutMs: 600_000 });
    const answer = await parse(tools.webExecute('t2007.long'));
    expect(answer).toMatchObject({ state: 'running', total: 1, poll: 'web_macro_status', reason: 'long-running command' });
    expect(macroJobs.get(answer.jobId)?.documentKey).toBe('');
    pending.resolve(value);
    expect(await finished(answer.jobId)).toMatchObject({ state: 'done', report: [{ status: 'ok', value }] });
  });

  it.each(['execute', 'query'])('supports explicit background for %s', async (door) => {
    register('t2007.background', () => ({ result: [1, 2] }));
    const answer = await parse(door === 'query'
      ? tools.webQuery('t2007.background', undefined, true)
      : tools.webExecute('t2007.background', undefined, undefined, undefined, undefined, true));
    expect(answer).toMatchObject({ state: 'running', total: 1 });
    expect(answer).not.toHaveProperty('reason');
    expect(await finished(answer.jobId)).toMatchObject({ state: 'done', report: [{ value: { result: [1, 2] } }] });
  });

  it('keeps failures on the report line with an error', async () => {
    register('t2007.fail', () => { throw new Error('test failure'); }, { timeoutMs: 600_000 });
    const answer = await parse(tools.webExecute('t2007.fail'));
    expect(await finished(answer.jobId)).toMatchObject({ state: 'done', report: [{ status: 'failed', error: 'test failure' }] });
  });

  it('aborts cancellable commands through ctx.signal and finishes cancelled', async () => {
    const started = deferred<void>();
    let signal: AbortSignal | undefined;
    const aborted = vi.fn();
    register('t2007.cancel', (ctx) => new Promise((resolve) => {
      signal = ctx.signal;
      signal?.addEventListener('abort', () => { aborted(); resolve({ stopped: true }); }, { once: true });
      started.resolve();
    }), { timeoutMs: 600_000, cancellable: true });
    const answer = await parse(tools.webExecute('t2007.cancel'));
    await started.promise;
    expect(await parse(macros.webMacroCancel(answer.jobId))).toMatchObject({ cancelRequested: true });
    expect(signal?.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledOnce();
    expect(await finished(answer.jobId)).toMatchObject({ state: 'cancelled' });
  });

  it('refuses cancellation of non-cancellable execute jobs and lets them finish', async () => {
    const pending = deferred<unknown>();
    register('t2007.noCancel', () => pending.promise, { timeoutMs: 600_000 });
    const answer = await parse(tools.webExecute('t2007.noCancel'));
    expect(await parse(macros.webMacroCancel(answer.jobId))).toEqual({
      ok: false, jobId: answer.jobId, kind: 'not-cancellable', error: 't2007.noCancel cannot be cancelled — it runs to the end',
    });
    expect(macroJobs.get(answer.jobId)?.cancelRequested).toBe(false);
    expect(macroJobs.get(answer.jobId)?.state).toBe('running');
    pending.resolve({ completed: true });
    expect(await finished(answer.jobId)).toMatchObject({ state: 'done', report: [{ value: { completed: true } }] });
  });

  it('aborts a finished step if the active document identity changed', async () => {
    const pending = deferred<unknown>();
    const started = deferred<void>();
    register('t2007.documentChange', () => { started.resolve(); return pending.promise; }, { timeoutMs: 600_000 });
    const answer = await parse(tools.webExecute('t2007.documentChange'));
    await started.promise;
    const changed = { onHistoryChange() {} };
    vi.spyOn(commandRegistry, 'captureContext').mockReturnValue({
      handle: { doc: { document: changed } }, selection: [],
    } as unknown as CapturedContext);
    pending.resolve({ completed: true });
    expect(await finished(answer.jobId)).toMatchObject({ state: 'aborted', abortReason: 'document-changed' });
  });
});
