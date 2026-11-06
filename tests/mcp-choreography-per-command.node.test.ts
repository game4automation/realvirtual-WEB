// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ToolCommandBinding } from '../src/core/engine/rv-mcp-tools';
import { commandRegistry, type CommandImpl } from '../src/core/hmi/rv-command-registry';
import { commandResultJson } from '../src/core/hmi/rv-command-context';
import { choreographyKeyOf } from '../src/plugins/mcp-bridge/rv-mcp-command-choreography';
import { McpCommandTools, setCommandStepHooks } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { macroJobs } from '../src/plugins/mcp-bridge/rv-mcp-macro';

vi.mock('../src/core/hmi/rv-command-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/rv-command-registry')>();
  return { ...actual, commandRegistry: new actual.CommandRegistry() };
});
vi.mock('../src/plugins/mcp-bridge/rv-mcp-dialog-policy', () => ({
  installMcpDialogPolicy: vi.fn(async () => () => []),
}));

const tools = new McpCommandTools(() => ({ modes: { activeMode: 'hmi' } }) as unknown as RVViewer);
const cleanups: Array<() => void> = [];
const before = vi.fn(async () => 'token');
const after = vi.fn(() => ({ changed: true }));
const parse = async (result: Promise<string>) => JSON.parse(await result);

beforeEach(() => {
  for (const [id, readOnly] of [['test.write', false], ['test.read', true]] as const) {
    const impl: CommandImpl = { enabled: () => true, run: () => ({ answer: 42 }) };
    cleanups.push(commandRegistry.register({
      id, label: id, scope: 'none', readOnly, available: true,
      unavailableReason: '', argsSchema: {}, impl: async () => impl, eagerImpl: impl,
    }));
  }
  before.mockClear();
  after.mockClear();
  setCommandStepHooks({ before, after });
});
afterEach(() => {
  setCommandStepHooks(null);
  for (const cleanup of cleanups.splice(0)) cleanup();
  commandRegistry.attachViewer(undefined);
  macroJobs._resetForTest();
});

describe('per-command choreography', () => {
  it('resolves plain bindings alphabetically and otherwise uses a registered command id', () => {
    const dispatcher = new Map<string, { command?: ToolCommandBinding }>([
      ['web_z', { command: 'test.write' }],
      ['web_a', { command: 'test.write' }],
      ['web_branch', { command: { branches: [{ id: 'test.branch', when: {}, args: (wire) => wire }] } }],
    ]);
    expect(choreographyKeyOf('test.write', dispatcher)).toBe('web_a');
    expect(choreographyKeyOf('test.branch', dispatcher)).toBeUndefined();
    expect(choreographyKeyOf('test.read', dispatcher)).toBe('test.read');
    expect(choreographyKeyOf('unknown', dispatcher)).toBeUndefined();
  });

  it('brackets execute once with parsed args, captured context and an opaque token', async () => {
    const answer = await parse(tools.webExecute('test.write', '{"x":7}'));
    expect(answer).toMatchObject({ ok: true, delta: { changed: true } });
    expect(before).toHaveBeenCalledExactlyOnceWith('test.write', { x: 7 }, expect.any(Object));
    expect(after).toHaveBeenCalledExactlyOnceWith('token', 'test.write', { x: 7 }, expect.objectContaining({ result: { ok: true, value: { answer: 42 } } }));
    expect(before.mock.invocationCallOrder[0]).toBeLessThan(after.mock.invocationCallOrder[0]);
  });

  it('attaches each batch delta to its own report line', async () => {
    const answer = await parse(tools.webBatch(JSON.stringify([
      { command: 'test.write', args: { x: 1 } }, { command: 'test.write', args: { x: 2 } },
    ])));
    expect(before).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
    expect(before.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['test.write', { x: 1 }], ['test.write', { x: 2 }],
    ]);
    expect(answer.steps).toMatchObject([{ delta: { changed: true } }, { delta: { changed: true } }]);
    expect(answer).not.toHaveProperty('delta');
  });

  it.each(['before', 'after'])('a throwing %s hook cannot fail execution', async (hook) => {
    const fail = () => { throw new Error('visual failure'); };
    setCommandStepHooks(hook === 'before' ? { before: async () => fail(), after } : { before, after: fail });
    expect(await parse(tools.webExecute('test.write'))).toMatchObject({ ok: true, value: { answer: 42 } });
    expect(await parse(tools.webExecute('test.write'))).not.toHaveProperty('delta');
    if (hook === 'before') expect(after).not.toHaveBeenCalled();
  });

  it.each(['execute', 'batch', 'query'])('background %s never invokes hooks', async (door) => {
    const answer = await parse(door === 'execute'
      ? tools.webExecute('test.write', undefined, undefined, undefined, undefined, true)
      : door === 'batch' ? tools.webBatch('[{"command":"test.write"}]', undefined, undefined, true)
        : tools.webQuery('test.read', undefined, true));
    await vi.waitFor(() => expect(macroJobs.get(answer.jobId)?.state).toBe('done'));
    expect(before).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('query never invokes hooks', async () => {
    expect(await parse(tools.webQuery('test.read'))).toMatchObject({ ok: true });
    expect(before).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('serializes the alias value/refusal without the execute envelope', () => {
    expect(commandResultJson({ ok: true, value: { path: 'A' } })).toBe('{"path":"A"}');
    expect(commandResultJson({ ok: false, reason: 'refused', details: { code: 'locked' } })).toBe('{"error":"refused","code":"locked"}');
  });
});
