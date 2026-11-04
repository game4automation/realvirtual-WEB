// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandRegistry, type CommandImpl } from '../src/core/hmi/rv-command-registry';
import { dialogPolicyApplies } from '../src/plugins/mcp-bridge/rv-mcp-command-dialog-policy';
import { runWithDialogPolicy } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';

const policy = vi.hoisted(() => ({
  imported: vi.fn(),
  release: vi.fn(() => []),
  install: vi.fn(),
}));
vi.mock('../src/plugins/mcp-bridge/rv-mcp-dialog-policy', () => {
  policy.imported();
  return { installMcpDialogPolicy: policy.install };
});
vi.mock('../src/core/hmi/rv-command-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/rv-command-registry')>();
  return { ...actual, commandRegistry: new actual.CommandRegistry() };
});
vi.mock('../src/plugins/mcp-bridge/rv-mcp-moved-tools', () => ({
  MOVED_TOOLS: [{ tool: 'web_old', movedTo: ['test.write'], door: 'web_execute', example: '' }],
  movedToolOf: (name: string) => ['web_old', 'web_editor_delete'].includes(name) ? { tool: name } : undefined,
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  policy.install.mockReset().mockResolvedValue(policy.release);
  policy.release.mockClear();
  for (const [id, readOnly] of [['test.read', true], ['test.write', false]] as const) {
    const impl: CommandImpl = { enabled: () => true, run: () => ({}) };
    cleanups.push(commandRegistry.register({
      id, label: id, readOnly, scope: 'none', available: true, unavailableReason: '',
      argsSchema: {}, impl: async () => impl, eagerImpl: impl,
    }));
  }
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe('dialog policy per executed command', () => {
  it.each([
    ['web_query', undefined, false],
    ['web_execute', { command: 'test.read' }, false],
    ['web_execute', { command: 'prompt.x' }, false],
    ['web_execute', { command: 'test.write' }, true],
    ['web_execute', { command: 'unknown' }, true],
    ['web_execute', {}, true],
    ['web_batch', { steps: [{ command: 'test.read' }, { command: 'test.write' }] }, true],
    ['web_batch', { steps: '[{"command":"test.read"},{"command":"prompt.x"}]' }, false],
    ['web_batch', { steps: 'invalid' }, true],
    ['web_batch', { steps: [] }, true],
    ['web_prompt_list', undefined, false],
    ['web_editor_delete', undefined, false],
    ['web_old', undefined, false],
  ] as const)('%s with %j → %s', (tool, args, expected) => {
    expect(dialogPolicyApplies(tool, args)).toBe(expected);
  });

  it('does not treat a still-dispatched tool as a tombstone', () => {
    expect(dialogPolicyApplies('web_old', {}, new Map([['web_old', {}]]))).toBe(true);
  });

  it('does not even import the responder for read-only and prompt ids', async () => {
    expect(await runWithDialogPolicy(async () => 42, ['test.read', 'prompt.x'])).toBe(42);
    expect(policy.imported).not.toHaveBeenCalled();
    expect(policy.install).not.toHaveBeenCalled();
  });

  it('installs and releases for writes', async () => {
    expect(await runWithDialogPolicy(async () => 42, ['test.write'])).toBe(42);
    expect(policy.install).toHaveBeenCalledOnce();
    expect(policy.release).toHaveBeenCalledOnce();
  });

  it.each([{ ids: undefined }, { ids: ['unknown'] }, { ids: ['test.read', 'test.write'] }])('conservatively installs for %j', async ({ ids }) => {
    await expect(runWithDialogPolicy(async () => { throw new Error('command failed'); }, ids)).rejects.toThrow('command failed');
    expect(policy.install).toHaveBeenCalledOnce();
    expect(policy.release).toHaveBeenCalledOnce();
  });
});
