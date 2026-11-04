// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { robotRunHarness } from './helpers/robot-run-harness';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { McpMacroTools } from '../src/plugins/mcp-bridge/rv-mcp-macro-tools';
import { McpRobotTools, createIkCommandDescriptors } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { runPath } from '../src/plugins/mcp-bridge/rv-mcp-robot-run';

let h: Awaited<ReturnType<typeof robotRunHarness>>;
let tools: McpCommandTools;
let macros: McpMacroTools;
async function setup() {
  h = await robotRunHarness();
  new McpRobotTools(() => h.viewer);
  tools = new McpCommandTools(() => h.viewer);
  macros = new McpMacroTools(() => h.viewer);
}
async function execute(command: string, args = {}) {
  return JSON.parse(await tools.webExecute(command, JSON.stringify(args)));
}
async function status(id: string) { return JSON.parse(await macros.webMacroStatus(id)); }
async function running(id: string) {
  await expect.poll(() => h.path.PathIsActive).toBe(true);
  expect((await status(id)).state).toBe('running');
}
async function ended(id: string) {
  await expect.poll(async () => (await status(id)).state).not.toBe('running');
  const s = await status(id);
  expect(h.listenerCount()).toBe(0);
  return s.report[0].value;
}
afterEach(() => { setActiveEditTarget(null); h?.dispose(); });
describe('ik.path.run via the MCP job door (plumbing, baked-angle replay)', () => {
  it('returns a job and keeps the complete first-pass result, including loop continuation', async () => {
    await setup(); h.path.LoopPath = true;
    const job = await execute('ik.path.run');
    expect(job.jobId).toBeTypeOf('string');
    await running(job.jobId);
    for (let n = 0; n < 20000 && h.path.runSeq === 1; n++) h.tick();
    const value = await ended(job.jobId);
    expect(value.finished).toBe(true);
    expect(value.continues).toBe('loop');
    expect(value.reachedTargets).toHaveLength(h.path.targets.length);
    expect(value.skipped).toEqual([]);
    expect(h.path.PathIsActive).toBe(true);
  }, 180000);
  it('finishes a single pass and reports skips and LIN fallback without double counting', async () => {
    await setup();
    h.path.targets[1].AxisPos = [];
    h.path.targets[2].InterpolationToTarget = 'Linear';
    // An untaught intermediate pose must fall back to the baked replay; this
    // proves reporting, not the kinematic quality of a linear interpolation.
    const job = await execute('ik.path.run'); await running(job.jobId);
    h.tick(20000);
    const value = await ended(job.jobId);
    expect(value.finished).toBe(true);
    expect(value.continues).toBeUndefined();
    expect(value.skipped).toEqual([{ index: 1, name: h.path.targets[1].node.name, reason: 'no-angles' }]);
    expect(value.reachedTargets.map((t: { index: number }) => t.index)).not.toContain(1);
    expect(value.reachedTargets).toHaveLength(h.path.targets.length - 1);
    expect(value.linFallbacks).toEqual(expect.arrayContaining([expect.objectContaining({ index: 2, reason: 'step-unreachable' })]));
  }, 180000);
  it('refuses paused simulation and already active paths, and resolves implicit args', async () => {
    await setup();
    const impl = await createIkCommandDescriptors().find(d => d.id === 'ik.path.run')!.impl();
    expect(impl).not.toBeNull();
    if (!impl) throw new Error('Missing run implementation');
    const ctx = { viewer: h.viewer } as Parameters<typeof impl.run>[0];
    const args = await impl.resolveArgs!(ctx, {} as never);
    expect(args).toHaveProperty('pathPath', h.result.registry.getPathForNode(h.path.node));
    h.pause(true);
    const paused = await execute('ik.path.run');
    await expect.poll(async () => JSON.stringify(await status(paused.jobId))).toContain('sim.playPause');
    h.pause(false); h.path.startPath();
    expect(await new McpRobotTools(() => h.viewer).runOrStopPath()).toHaveProperty('kind', 'already-running');
    const active = await execute('ik.path.run');
    await ended(active.jobId);
    expect((await status(active.jobId)).report[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('already running') });
  }, 180000);
  it('stops in the asset editor and reports a missing path as failed', async () => {
    await setup(); h.path.startPath();
    setActiveEditTarget({ available: true, persistsTo: 'asset' } as EditTarget);
    expect(await execute('ik.path.stop')).toMatchObject({ ok: true, value: { wasActive: true } });
    expect(h.path.PathIsActive).toBe(false);
    expect(await execute('ik.path.stop', { pathPath: '/missing' })).toMatchObject({ status: 'failed', ok: false });
  });
  it('cancels the job, holds axes and disarms StartPath', async () => {
    await setup(); h.path.StartPath = true;
    const job = await execute('ik.path.run'); await running(job.jobId);
    h.tick(10);
    await macros.webMacroCancel(job.jobId);
    expect((await ended(job.jobId)).error).toBe('cancelled');
    const positions = h.drives.map(d => d.currentPosition);
    h.tick(20);
    expect(h.path.PathIsActive).toBe(false);
    expect(h.drives.map(d => d.currentPosition)).toEqual(positions);
  }, 180000);
  it('cancel immediately after creation starts nothing', async () => {
    await setup();
    const job = await execute('ik.path.run');
    await macros.webMacroCancel(job.jobId);
    expect((await ended(job.jobId)).error).toBe('cancelled');
    expect(h.path.runSeq).toBe(0);
  }, 180000);
  it('waits through pause and times out on the wall clock', async () => {
    await setup();
    const job = await execute('ik.path.run', { timeoutMs: 200 }); await running(job.jobId);
    h.pause(true); h.tick(20000);
    expect((await status(job.jobId)).state).toBe('running');
    expect((await ended(job.jobId)).error).toBe('timeout');
    expect(h.path.PathIsActive).toBe(false);
  }, 180000);
  it('reports the expected signal before timeout clears it', async () => {
    await setup();
    // Exercise the runtime wait contract without inventing a second signal resolver.
    Object.defineProperty(h.path.targets[0], 'waitForSignalAddr', { get: () => 'PLC/continue' });
    const pending = runPath(h.viewer, h.path, { timeoutMs: 200 });
    for (let i = 0; i < 20000 && !h.path.WaitForSignal; i++) h.tick();
    expect(h.path.WaitForSignal).toBe(true);
    expect(await pending).toMatchObject({ error: 'timeout', waitingFor: 'PLC/continue' });
    expect(h.listenerCount()).toBe(0);
  }, 180000);
  it.each(['simulation-reset', 'model-cleared', 'model-loaded'] as const)('terminates on %s', async event => {
    await setup(); const job = await execute('ik.path.run'); await running(job.jobId);
    h.viewer.emit(event, undefined as never);
    expect(h.path.PathIsActive).toBe(false);
    expect((await ended(job.jobId)).error).toBe(event === 'simulation-reset' ? 'reset' : 'model-unloaded');
  }, 180000);
  it('stop ends the job and is idempotent', async () => {
    await setup(); const job = await execute('ik.path.run'); await running(job.jobId);
    expect((await execute('ik.path.stop')).value.wasActive).toBe(true);
    expect((await ended(job.jobId)).error).toBe('stopped');
    expect((await execute('ik.path.stop')).value.wasActive).toBe(false);
  }, 180000);
  it('does not follow a LogicStep restart into a different run', async () => {
    await setup(); const job = await execute('ik.path.run'); await running(job.jobId);
    h.path.reset(); h.path.startPath();
    expect((await ended(job.jobId)).error).toBe('stopped');
    expect(h.path.PathIsActive).toBe(true);
  }, 180000);
  it('an already aborted request never starts the engine', async () => {
    await setup(); const controller = new AbortController(); controller.abort();
    expect(await runPath(h.viewer, h.path, { signal: controller.signal })).toMatchObject({ error: 'cancelled', reachedTargets: [] });
    expect(h.path.runSeq).toBe(0);
    expect(h.listenerCount()).toBe(0);
  }, 180000);
});
