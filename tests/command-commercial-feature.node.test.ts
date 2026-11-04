// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { ensurePlanningCommandsRegistered } from '../src/plugins/planning-parameters/planning-command-descriptors';
const viewer = { modes: { activeMode: 'hmi' }, selectionManager: { getSnapshot: () => ({ selectedPaths: [] }) } } as unknown as RVViewer;
const tools = new McpCommandTools(() => viewer);
const parse = async (p: Promise<string>) => JSON.parse(await p);
describe('commercial command prefixes without a body', () => {
 it.each(['experiment.list', 'experiment.run'])('%s refuses through every dispatch door', async id => {
  const expected = { ok: false, kind: 'commercial-feature', error: 'experiment manager is a commercial module (realvirtual Commercial)', details: { module: 'des-experiments' } };
  expect(await parse(tools.webExecute(id))).toMatchObject(expected);
  expect(await parse(tools.webQuery(id))).toMatchObject(expected);
  const batch = await parse(tools.webBatch(JSON.stringify([{ command: id }, { command: 'planning.param.list' }])));
  expect(batch).toMatchObject({ ok: false, ran: 1 });
  expect(batch.steps[0]).toMatchObject({ errorKind: 'commercial-feature' });
  expect((await parse(tools.webCommands())).commands.some((row: { id: string }) => row.id === id)).toBe(false);
 });
 it('planning.factor.* is gone (plan-2211 G7b): an unknown command, no commercial prefix', async () => {
  for (const id of ['planning.factor.list', 'planning.factor.set', 'planning.factor.remove']) {
   expect(await parse(tools.webExecute(id))).toMatchObject({ ok: false, kind: 'unknown' });
   expect(await commandRegistry.execute(id, {}, { origin: 'mcp', viewer })).toMatchObject({ ok: false, kind: 'unknown', reason: `Unknown command: ${id}` });
  }
 });
 it('keeps core planning descriptors and lets registered commands win', async () => {
  ensurePlanningCommandsRegistered();
  expect(commandRegistry.get('planning.param.list')).toBeDefined();
  expect((await parse(tools.webQuery('planning.param.list'))).kind).not.toBe('commercial-feature');
  const impl = { enabled: () => true as const, run: () => 'registered' };
  const off = commandRegistry.register({ id: 'experiment.test', label: 'test', readOnly: true, scope: 'none', available: true, unavailableReason: '', argsSchema: {}, impl: async () => impl });
  try { expect(await commandRegistry.execute('experiment.test', {}, { origin: 'mcp', viewer })).toEqual({ ok: true, value: 'registered' }); }
  finally { off(); }
 });
});
