// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry, type CapturedContext, type CommandDescriptor, type CommandImpl } from '../src/core/hmi/rv-command-registry';
import { gatewayOutdatedRefusal, McpCommandTools, setGatewayCommandClassesState } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { macroBookOf, macroJobs, RV_MACRO_SCHEMA, type RvMacroCommandStep } from '../src/plugins/mcp-bridge/rv-mcp-macro';
import { McpMacroTools } from '../src/plugins/mcp-bridge/rv-mcp-macro-tools';

vi.mock('../src/core/hmi/rv-command-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/rv-command-registry')>();
  return { ...actual, commandRegistry: new actual.CommandRegistry() };
});

vi.mock('../src/plugins/mcp-bridge/rv-mcp-dialog-policy', () => ({
  installMcpDialogPolicy: vi.fn(async () => () => []),
}));

const viewer = { modes: { activeMode: 'hmi' } } as unknown as RVViewer;
const tools = new McpCommandTools(() => viewer);
const cleanups: Array<() => void> = [];
const deploy = vi.fn(() => ({ deployed: true }));
const edit = vi.fn(() => ({ edited: true }));
const parse = async (p: Promise<string>) => JSON.parse(await p);
const steps = JSON.stringify([{ command: 'plc.testDeploy' }, { command: 'editor.testEdit' }]);

function register(id: string, run: CommandImpl['run'], extra: Partial<CommandDescriptor> = {}): void {
  const impl: CommandImpl = { enabled: () => true, run };
  cleanups.push(commandRegistry.register({
    id, label: id, scope: 'none', readOnly: false, available: true,
    unavailableReason: '', argsSchema: {}, impl: async () => impl, eagerImpl: impl, ...extra,
  }));
}

beforeEach(() => {
  register('plc.testDeploy', deploy, { timeoutMs: 600_000 });
  register('editor.testEdit', edit);
  register('plc.testRead', () => ({ read: true }), { readOnly: true });
  register('editor.existing', () => ({ existing: true }));
  setGatewayCommandClassesState('connect-without-classes');
});

afterEach(() => {
  setGatewayCommandClassesState('none');
  for (const cleanup of cleanups.splice(0)) cleanup();
  commandRegistry.attachViewer(undefined);
  macroJobs._resetForTest();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function finished(id: string) {
  await vi.waitFor(() => expect(macroJobs.get(id)?.state).not.toBe('running'));
  return macroJobs.get(id)!;
}

describe('plan-2007 F15 gateway compatibility', () => {
  it('gates commands stricter than edit when CONNECT cannot classify commands', () => {
    expect(gatewayOutdatedRefusal('plc.testDeploy', commandRegistry)).toMatchObject({
      ok: false, command: 'plc.testDeploy', status: 'failed', kind: 'gateway-outdated',
    });
    expect(gatewayOutdatedRefusal('editor.testEdit', commandRegistry)).toBeNull();
    expect(gatewayOutdatedRefusal('plc.testRead', commandRegistry)).toBeNull();
    expect(gatewayOutdatedRefusal('editor.existing', commandRegistry)).toBeNull();
  });

  it('refuses execute before auto-job or explicit background creation; edit and existing commands run', async () => {
    expect(await parse(tools.webExecute(' plc.testDeploy '))).toMatchObject({ kind: 'gateway-outdated' });
    expect(await parse(tools.webExecute('plc.testDeploy', undefined, undefined, undefined, undefined, true))).toMatchObject({ kind: 'gateway-outdated' });
    expect(macroJobs.list()).toHaveLength(0);
    expect(deploy).not.toHaveBeenCalled();
    expect(await parse(tools.webExecute('editor.testEdit'))).toMatchObject({ ok: true });
    expect(await parse(tools.webExecute('editor.existing'))).toMatchObject({ ok: true });
    expect(edit).toHaveBeenCalledOnce();
  });

  it.each([false, true])('reports refused batch steps and obeys stopOnError (background=%s)', async (background) => {
    const stopped = await parse(tools.webBatch(steps, true, false, background));
    const stoppedLines = background ? (await finished(stopped.jobId)).report : stopped.steps;
    expect(stoppedLines).toMatchObject([{ status: 'failed', errorKind: 'gateway-outdated' }]);
    expect(stoppedLines).toHaveLength(1);
    expect(edit).not.toHaveBeenCalled();
    const continued = await parse(tools.webBatch(steps, false, false, background));
    const lines = background ? (await finished(continued.jobId)).report : continued.steps;
    expect(lines).toMatchObject([{ status: 'failed', errorKind: 'gateway-outdated' }, { status: 'ok' }]);
    expect(deploy).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledOnce();
  });

  it.each(['connect-with-classes', 'none'] as const)('runs both classes with state %s', async (state) => {
    setGatewayCommandClassesState(state);
    const answer = await parse(tools.webExecute('plc.testDeploy'));
    expect((await finished(answer.jobId)).report).toMatchObject([{ status: 'ok', value: { deployed: true } }]);
    expect(await parse(tools.webExecute('editor.testEdit'))).toMatchObject({ ok: true });
    expect(deploy).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
  });

  it('never gates web_query, including its background path', async () => {
    expect(await parse(tools.webQuery('plc.testRead'))).toMatchObject({ ok: true, value: { read: true } });
    const answer = await parse(tools.webQuery('plc.testRead', undefined, true));
    expect((await finished(answer.jobId)).report).toMatchObject([{ status: 'ok' }]);
    expect(await parse(tools.webQuery('plc.testDeploy'))).toMatchObject({ kind: 'not-read-only' });
  });

  it('refuses the whole replay up front, leaving macro reads available', async () => {
    const doc = { onHistoryChange: () => () => {}, changeSeq: 0, whenIdle: async () => {} };
    vi.spyOn(commandRegistry, 'captureContext').mockReturnValue({
      handle: { doc: { document: doc } }, selection: [],
    } as unknown as CapturedContext);
    macroBookOf(doc).macros.set('gated', {
      $schema: RV_MACRO_SCHEMA, name: 'gated', document: { name: 'test' },
      steps: ['editor.testEdit', 'plc.testDeploy'].map((command): RvMacroCommandStep => ({
        kind: 'command', command, args: {}, note: { author: 'agent' }, result: { status: 'ok' }, at: '2026-10-27T00:00:00Z',
      })),
    });
    const macros = new McpMacroTools(() => viewer);
    expect(await parse(macros.webMacroGet('gated'))).toMatchObject({ name: 'gated' });
    expect(await parse(macros.webMacroReplay('gated'))).toMatchObject({ command: 'plc.testDeploy', kind: 'gateway-outdated' });
    expect(macroJobs.list()).toHaveLength(0);
    expect(edit).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
  });
});
