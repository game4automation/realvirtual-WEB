// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.4 + §9.7b (M1, M2) — the `web_macro_*` tools end to end over the
 * app-wide registry: record via `web_execute` / `web_batch`, list / get /
 * annotate, dry run, replay as a JOB (status, cancel, one job per document,
 * document binding, concurrent edits), the Problems entry of a failed line,
 * `requires-commercial`, and "a replay is never recorded".
 *
 * The document is a real `RvDocument` published through the active asset
 * context; the commands are scope-'none' fixtures (`t641r.*`) that write
 * `setField` ops for nodes of a small in-memory "scene" (`nodes`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry, type CommandDescriptor, type CommandImpl } from '../src/core/hmi/rv-command-registry';
import { ERR_EDITOR_UNAVAILABLE } from '../src/core/editor/rv-editor-guard-core';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvExecutor } from '../src/core/ops/rv-unified-executors';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { MACRO_STEP_FAILED, McpMacroTools } from '../src/plugins/mcp-bridge/rv-mcp-macro-tools';
import { macroBookOf, macroJobs, macroRecorder, type RvMacroCommandStep } from '../src/plugins/mcp-bridge/rv-mcp-macro';

// ─── Fixture ────────────────────────────────────────────────────────────

class StubExecutor implements RvExecutor {
  async applyForward(): Promise<void> {}
  async applyInverse(): Promise<void> {}
}

let opSeq = 0;
const op = (path: string, value: unknown): RvOp => ({
  id: `op_t641r_${++opSeq}`, ts: Date.now() + opSeq * 10_000, schemaV: 1, kind: 'setField',
  nodePath: path, componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: null,
} as RvOp);

let selection: string[] = [];
const viewer = {
  modes: { activeMode: 'hmi' },
  selectionManager: { getSnapshot: () => ({ selectedPaths: selection }) },
} as unknown as RVViewer;

/** The "scene": which node paths exist, and the value written per path. */
let nodes: Map<string, unknown>;
let doc: RvDocument;
let gate: Promise<void> | null = null;
const cleanups: Array<() => void> = [];

function publish(d: RvDocument): void {
  setActiveAssetContext({ viewer, doc: { id: d.id, name: d.name, document: d, whenIdle: () => d.whenIdle() } as unknown as ActiveAssetContext['doc'] });
}

type SetArgs = { path?: string | null; value?: number };

function reg(id: string, impl: Partial<CommandImpl<SetArgs, unknown>>, extra: Partial<CommandDescriptor<SetArgs, unknown>> = {}): void {
  const full: CommandImpl<SetArgs, unknown> = {
    enabled: (ctx, a) => {
      const path = a?.path ?? ctx.selection[0];
      if (!path) return { reason: 'Select a node first' };
      return nodes.has(path) ? true : { reason: `Node not found: ${path}` };
    },
    async run(ctx, a) {
      if (gate) await gate;
      const path = (a.path ?? ctx.selection[0]) as string;
      nodes.set(path, a.value ?? 1);
      await doc.applyOp(op(path, a.value ?? 1));
      return { path };
    },
    resolveArgs: (ctx, a) => ({ path: a?.path ?? ctx.selection[0] ?? null, value: a?.value ?? 1 }),
    ...impl,
  };
  cleanups.push(commandRegistry.register<SetArgs, unknown>({
    id, label: id, readOnly: false, scope: 'none', available: true, macro: true,
    unavailableReason: ERR_EDITOR_UNAVAILABLE, argsSchema: { path: 'string', value: 'number' },
    impl: async () => full, eagerImpl: full, ...extra,
  }));
}

const cmd = new McpCommandTools(() => viewer);
const mac = new McpMacroTools(() => viewer);
const parse = async (p: Promise<string>): Promise<Record<string, unknown>> => JSON.parse(await p);

async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const s = await parse(mac.webMacroStatus(jobId));
    if (s['state'] !== 'running') return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not finish');
}

/** Record the standard three-line macro: two ok lines + one failed. */
async function recordStandard(name = 'round-2'): Promise<void> {
  expect(await parse(mac.webMacroRecordStart(name))).toMatchObject({ recording: name });
  selection = ['Cell/Slide'];
  await cmd.webExecute('t641r.set', '{"value":5}', 'DFM-6-5 has 5 mm stroke', 'parts:DFM-6-5', 'observed');
  await cmd.webBatch(JSON.stringify([
    { command: 't641r.set', args: { path: 'Cell/Stopper', value: 2 }, _reason: 'stopper speed' },
    { command: 't641r.set', args: { path: 'Cell/Missing', value: 3 } },
  ]), false);
  expect(await parse(mac.webMacroRecordStop())).toMatchObject({ name, steps: 3, newSteps: 3, failedOrNoop: 1 });
}

beforeEach(() => {
  nodes = new Map([['Cell/Slide', 0], ['Cell/Stopper', 0]]);
  selection = [];
  gate = null;
  doc = new RvDocument({ id: 'doc_t641r', name: 'Festo', mode: 'asset', executor: new StubExecutor() });
  publish(doc);
  clearAllProblems();
  reg('t641r.set', {});
  reg('t641r.runtime', {}, { macro: undefined });
  reg('t641r.commercial', {}, { available: false });
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  macroRecorder._resetForTest();
  macroJobs._resetForTest();
  setActiveAssetContext(null);
  doc.dispose();
});

// ─── Record, read, annotate ─────────────────────────────────────────────

describe('plan-641 — record / list / get / annotate', () => {
  it('records resolved args with notes; failed lines are kept as failed', async () => {
    await recordStandard();
    const got = await parse(mac.webMacroGet('round-2'));
    const steps = got['steps'] as Array<RvMacroCommandStep & { step: number }>;
    expect(steps.map((s) => [s.step, s.args['path'], s.result.status])).toEqual([
      [1, 'Cell/Slide', 'ok'], [2, 'Cell/Stopper', 'ok'], [3, 'Cell/Missing', 'failed'],
    ]);
    expect(steps[0].note).toEqual({ author: 'agent', reason: 'DFM-6-5 has 5 mm stroke', source: 'parts:DFM-6-5', confidence: 'observed' });
    expect(steps[1].note).toEqual({ author: 'agent', reason: 'stopper speed' });
    const list = await parse(mac.webMacroList());
    expect(list['macros']).toEqual([{ name: 'round-2', steps: 3, replayable: 2 }]);
  });

  it('annotate adds a reason afterwards', async () => {
    await recordStandard();
    expect(await parse(mac.webMacroAnnotate('round-2', 2, 'customer asked', 'customer:festo/2026-10-19'))).toMatchObject({
      step: 2, note: { author: 'agent', reason: 'customer asked', source: 'customer:festo/2026-10-19' },
    });
    expect(await parse(mac.webMacroAnnotate('round-2', 9, 'x'))).toEqual({ error: 'step must be 1..3' });
  });

  it('a document switch ends the recording; the buffer stays with the old document (M5)', async () => {
    await parse(mac.webMacroRecordStart('sw'));
    await cmd.webExecute('t641r.set', '{"path":"Cell/Slide","value":1}');
    const other = new RvDocument({ id: 'doc_other', name: 'Other', mode: 'asset', executor: new StubExecutor() });
    publish(other);
    expect(macroRecorder.active).toBeNull();
    expect(macroRecorder.lastInterruption?.interruption.reason).toBe('document-changed');
    expect(macroBookOf(doc).macros.get('sw')?.steps).toHaveLength(1);
    other.dispose();
  });
});

// ─── Replay ─────────────────────────────────────────────────────────────

describe('plan-641 §9.4 — web_macro_replay', () => {
  it('dryRun lists what would run and changes nothing', async () => {
    await recordStandard();
    const before = doc.changeSeq;
    const r = await parse(mac.webMacroReplay('round-2', true));
    expect((r['steps'] as Array<{ willRun: boolean; skipReason?: string }>).map((s) => [s.willRun, s.skipReason ?? null])).toEqual([
      [true, null], [true, null], [false, 'recorded as failed'],
    ]);
    expect(doc.changeSeq).toBe(before);
  });

  it('replays the lines in order as a job, skips failed ones, and records nothing', async () => {
    await recordStandard();
    nodes.set('Cell/Slide', 0); nodes.set('Cell/Stopper', 0);
    selection = ['Cell/Stopper']; // a different selection must not matter: args are explicit
    const r = await parse(mac.webMacroReplay('round-2'));
    expect(typeof r['jobId']).toBe('string');
    const s = await waitJob(r['jobId'] as string);
    expect(s).toMatchObject({ state: 'done', progress: { done: 3, total: 3 } });
    expect((s['report'] as Array<{ status: string }>).map((l) => l.status)).toEqual(['ok', 'ok', 'skipped']);
    expect(nodes.get('Cell/Slide')).toBe(5);
    expect(nodes.get('Cell/Stopper')).toBe(2);
    expect(macroBookOf(doc).macros.get('round-2')?.steps).toHaveLength(3); // no new lines
  });

  it('a target that no longer exists → failed line + macro-step-failed in the Problems panel; stopOnError stops', async () => {
    await recordStandard();
    nodes.delete('Cell/Slide');
    const s = await waitJob((await parse(mac.webMacroReplay('round-2')))['jobId'] as string);
    expect((s['report'] as Array<{ status: string; reason?: string }>)).toEqual([
      expect.objectContaining({ step: 1, status: 'failed', reason: 'Node not found: Cell/Slide' }),
    ]);
    const p = getProblems().filter((x) => x.code === MACRO_STEP_FAILED);
    expect(p).toHaveLength(1);
    expect(p[0].title).toContain('step 1');

    const s2 = await waitJob((await parse(mac.webMacroReplay('round-2', false, false)))['jobId'] as string);
    expect((s2['report'] as Array<{ status: string }>).map((l) => l.status)).toEqual(['failed', 'ok', 'skipped']);
  });

  it('requires-commercial lines are reported and never stop the replay; non-macro lines are skipped', async () => {
    const book = macroBookOf(doc);
    const line = (command: string, path: string): RvMacroCommandStep => ({
      kind: 'command', command, args: { path, value: 1 }, note: { author: 'agent' }, result: { status: 'ok' }, at: '',
    });
    book.macros.set('mixed', {
      $schema: 'rv-macro/1', name: 'mixed', document: { name: 'Festo' },
      steps: [line('t641r.commercial', 'Cell/Slide'), line('t641r.runtime', 'Cell/Slide'), line('t641r.set', 'Cell/Stopper')],
    });
    const s = await waitJob((await parse(mac.webMacroReplay('mixed')))['jobId'] as string);
    expect((s['report'] as Array<{ status: string; reason?: string }>).map((l) => [l.status, l.reason ?? null])).toEqual([
      ['requires-commercial', ERR_EDITOR_UNAVAILABLE], ['skipped', 'not a macro command'], ['ok', null],
    ]);
  });

  it('M2: cancel stops between two lines; a second start on the same document is refused', async () => {
    await recordStandard();
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const r = await parse(mac.webMacroReplay('round-2'));
    const jobId = r['jobId'] as string;
    expect(await parse(mac.webMacroReplay('round-2'))).toMatchObject({ error: expect.stringContaining('already running') });
    expect(await parse(mac.webMacroCancel(jobId))).toEqual({ jobId, cancelRequested: true });
    gate = null;
    release();
    const s = await waitJob(jobId);
    expect(s).toMatchObject({ state: 'cancelled', progress: { done: 1, total: 3 } });
    expect(await parse(mac.webMacroCancel(jobId))).toEqual({ error: `Job ${jobId} is already cancelled` });
  });

  it('M2: a document switch aborts the job with document-changed', async () => {
    await recordStandard();
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const jobId = (await parse(mac.webMacroReplay('round-2')))['jobId'] as string;
    const other = new RvDocument({ id: 'doc_other2', name: 'Other', mode: 'asset', executor: new StubExecutor() });
    publish(other);
    gate = null;
    release();
    const s = await waitJob(jobId);
    expect(s).toMatchObject({ state: 'aborted', abortReason: 'document-changed' });
    other.dispose();
  });

  it('M2/M9: a foreign edit between two lines is reported as concurrentEdit, not refused', async () => {
    await recordStandard();
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const jobId = (await parse(mac.webMacroReplay('round-2')))['jobId'] as string;
    gate = null;
    release();
    // Let line 1 finish, then edit the document from "somewhere else".
    for (let i = 0; i < 100 && macroJobs.get(jobId)!.done < 1; i++) await new Promise((r) => setTimeout(r, 1));
    await doc.applyOp(op('Cell/Foreign', 1));
    const s = await waitJob(jobId);
    expect(s['state']).toBe('done');
    expect(s['concurrentEdits']).toBeGreaterThanOrEqual(1);
    expect((s['report'] as Array<{ concurrentEdit?: boolean }>).some((l) => l.concurrentEdit)).toBe(true);
  });

  it('M1: no recording starts during a replay, no replay during a recording', async () => {
    await recordStandard();
    await parse(mac.webMacroRecordStart('busy'));
    expect(await parse(mac.webMacroReplay('round-2'))).toMatchObject({ error: expect.stringContaining('recording is running') });
    await parse(mac.webMacroRecordStop());
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const jobId = (await parse(mac.webMacroReplay('round-2')))['jobId'] as string;
    expect(await parse(mac.webMacroRecordStart('during'))).toMatchObject({ error: expect.stringContaining('replay is running') });
    gate = null;
    release();
    await waitJob(jobId);
  });
});
