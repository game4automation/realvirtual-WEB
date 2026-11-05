// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.1 + §9.7b (M3, M4, M8, M9) — recording MCP command calls as macro
 * lines through the ONE wrapper `runCommandStep`, against a real `RvDocument`.
 *
 * The registry and the recorder are private instances; the commands are tiny
 * scope-'none' fixtures that write `setField` ops into the document, so every
 * contract is pinned on the real op stack: the change evidence (`changeSeq`,
 * `onHistoryChange`), the coalesce floor of both coalescing paths, the
 * controlled interruption on undo / redo / replace / rollback / foreign edits,
 * the strictly serial step windows and the resolver on the EARLY context.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  CommandRegistry,
  type CommandDescriptor,
  type CommandImpl,
} from '../src/core/hmi/rv-command-registry';
import { ERR_EDITOR_UNAVAILABLE } from '../src/core/editor/rv-editor-guard-core';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvExecutor } from '../src/core/ops/rv-unified-executors';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { MAX_OP_HISTORY } from '../src/core/ops/rv-op-utils';
import {
  classifyCommandOutcome,
  macroBookOf,
  MacroRecorder,
  splitMacroMeta,
  type RvMacroCommandStep,
} from '../src/plugins/mcp-bridge/rv-mcp-macro';
import { runCommandStep } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { enqueueBind } from '../src/core/hmi/rv-bind-queue';
import type { EditTarget } from '../src/core/hmi/rv-edit-target';

// ─── Fixture ────────────────────────────────────────────────────────────

class StubExecutor implements RvExecutor {
  async applyForward(o: RvOp): Promise<void> { if (o.kind === 'composite') for (const c of o.ops) await this.applyForward(c); }
  async applyInverse(o: RvOp): Promise<void> {
    if (o.kind === 'composite') for (let i = o.ops.length - 1; i >= 0; i--) await this.applyInverse(o.ops[i]);
  }
}

let opSeq = 0;
function setFieldOp(path: string, value: unknown, field = 'TargetSpeed'): RvOp {
  return {
    id: `op_t641_${++opSeq}`, ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: path, componentType: 'Drive', fieldName: field, value, prev: null,
  } as RvOp;
}

interface Env {
  viewer: RVViewer & { select(paths: string[]): void };
  registry: CommandRegistry;
  recorder: MacroRecorder;
  doc: RvDocument;
  /** Last args each command's run() saw. */
  seen: Record<string, unknown>;
}

function fakeViewer(): Env['viewer'] {
  let selection: string[] = [];
  return {
    modes: { activeMode: 'editor' },
    selectionManager: { getSnapshot: () => ({ selectedPaths: selection }) },
    select(paths: string[]) { selection = [...paths]; },
  } as unknown as Env['viewer'];
}

type SetArgs = { path?: string | null; value?: number };

function desc<A>(id: string, impl: CommandImpl<A, unknown>, extra: Partial<CommandDescriptor<A, unknown>> = {}): CommandDescriptor<A, unknown> {
  return {
    id, label: id, readOnly: false, scope: 'none', available: true,
    unavailableReason: ERR_EDITOR_UNAVAILABLE, argsSchema: { path: 'string', value: 'number' },
    impl: async () => impl, eagerImpl: impl, macro: true, ...extra,
  };
}

function makeEnv(): Env {
  const viewer = fakeViewer();
  const registry = new CommandRegistry();
  registry.attachViewer(viewer);
  const recorder = new MacroRecorder();
  const doc = new RvDocument({ id: 'doc_t641', name: 'T641', mode: 'asset', executor: new StubExecutor() });
  const seen: Record<string, unknown> = {};

  // A model change with a selection fallback (resolveArgs makes it explicit).
  const setImpl: CommandImpl<SetArgs, unknown> = {
    enabled: (ctx, a) => ((a?.path ?? ctx.selection[0]) ? true : { reason: 'Select a node first' }),
    async run(ctx, a) {
      seen['t.set'] = a;
      const path = (a.path ?? ctx.selection[0]) as string;
      await doc.applyOp(setFieldOp(path, a.value ?? 1));
      return { path };
    },
    resolveArgs: (ctx, a) => ({ path: a?.path ?? ctx.selection[0] ?? null, value: a?.value ?? 1 }),
  };
  registry.register(desc('t.set', setImpl));

  // Delayed commit: run() resolves BEFORE the op landed (a void mutator).
  registry.register(desc<SetArgs>('t.setDetached', {
    enabled: () => true,
    async run(_ctx, a) { doc.applyOpDetached(setFieldOp(a.path as string, a.value ?? 1)); return { ok: true }; },
    resolveArgs: (_c, a) => ({ path: a?.path ?? null, value: a?.value ?? 1 }),
  }));

  // Accepted but changes nothing.
  registry.register(desc<SetArgs>('t.nothing', {
    enabled: () => true, async run() { return { ok: true }; }, resolveArgs: (_c, a) => ({ ...a }),
  }));

  // A refusal.
  registry.register(desc<SetArgs>('t.refuse', {
    enabled: () => ({ reason: 'No component "Drive" on X' }), async run() { return {}; },
    resolveArgs: (_c, a) => ({ ...a }),
  }));

  // A runtime command (not a macro command) that still writes — e.g. a signal write.
  registry.register(desc<SetArgs>('t.runtime', {
    enabled: () => true, async run() { return { ok: true }; },
  }, { macro: undefined }));

  // A commercial-only command (community stub).
  registry.register(desc<SetArgs>('t.commercial', {
    enabled: () => true, async run() { return {}; },
  }, { available: false }));

  return { viewer, registry, recorder, doc, seen };
}

let env: Env;

function step(command: string, args: unknown, extra: Partial<Parameters<typeof runCommandStep>[0]> = {}) {
  return runCommandStep({ command, args, registry: env.registry, recorder: env.recorder, doc: env.doc, viewer: env.viewer, ...extra });
}

function start(name = 'm1') {
  const book = macroBookOf(env.doc);
  return { book, info: env.recorder.start(env.doc, book, name, { name: 'T641' }) };
}

function lines(name = 'm1'): RvMacroCommandStep[] {
  return (macroBookOf(env.doc).macros.get(name)?.steps ?? []) as RvMacroCommandStep[];
}

beforeEach(() => { env = makeEnv(); });
afterEach(() => { env.recorder._resetForTest(); env.doc.dispose(); });

// ─── 9.1 recording ──────────────────────────────────────────────────────

describe('plan-641 §9.1 — recording through runCommandStep', () => {
  it.each([false, true])('waits for a queued unbind before reporting and recording (record=%s)', async (record) => {
    if (record) start();
    let unbind: Promise<void> | undefined;
    env.registry.register(desc('t.unbindQueued', {
      enabled: () => true,
      async run() {
        unbind = enqueueBind({ documentKey: { document: env.doc } } as EditTarget, async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
          await env.doc.applyOp({ ...setFieldOp('Carrier', [], 'Mappings'), componentType: 'SignalLinks' } as RvOp);
        });
        return { ok: true };
      },
    }));
    const result = await step('t.unbindQueued', {});
    const countAtReport = env.doc.opCount;
    await unbind;
    expect(countAtReport).toBe(1);
    expect(result.outcome.status).toBe('ok');
    if (record) {
      expect(env.recorder.active).not.toBeNull();
      expect(lines()[0].result.status).toBe('ok');
    }
  });

  it('without a recording a call runs with its raw args and records nothing', async () => {
    const o = await step('t.set', { path: 'A/B', value: 5 });
    expect(o.recorded).toBe(false);
    expect(o.outcome.status).toBe('ok');
    expect(env.seen['t.set']).toEqual({ path: 'A/B', value: 5 });
  });

  it('M4: a call without a target stores the RESOLVED target; a selection change during the await does not change the line', async () => {
    start();
    env.viewer.select(['Cell/Slide']);
    const pending = step('t.set', { value: 7 });
    env.viewer.select(['Cell/Other']); // changes after the synchronous capture
    const o = await pending;
    expect(o.recorded).toBe(true);
    expect(lines()[0].args).toEqual({ path: 'Cell/Slide', value: 7 });
    expect(env.seen['t.set']).toEqual({ path: 'Cell/Slide', value: 7 });
  });

  it('M4: a slow lazy load + a selection change while loading → args from the EARLY context', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const impl: CommandImpl<SetArgs, unknown> = {
      enabled: () => true,
      async run(ctx, a) { await env.doc.applyOp(setFieldOp(a.path as string, 1)); return { path: a.path, sel: ctx.selection }; },
      resolveArgs: (ctx, a) => ({ path: a?.path ?? ctx.selection[0] ?? null, value: 1 }),
    };
    env.registry.register(desc<SetArgs>('t.lazy', impl, {
      eagerImpl: undefined, impl: async () => { await gate; return impl; },
    }));
    start();
    env.viewer.select(['Early/Node']);
    const pending = step('t.lazy', {});
    env.viewer.select(['Late/Node']);
    release();
    await pending;
    expect(lines()[0].args).toEqual({ path: 'Early/Node', value: 1 });
  });

  it('M9: two parallel calls run strictly serially and become two correctly attributed lines', async () => {
    start();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    env.registry.register(desc<SetArgs>('t.slow', {
      enabled: () => true,
      async run(_c, a) { order.push('slow:start'); await firstGate; await env.doc.applyOp(setFieldOp(a.path as string, 1)); order.push('slow:end'); return {}; },
      resolveArgs: (_c, a) => ({ path: a?.path ?? null }),
    }));
    const p1 = step('t.slow', { path: 'A' });
    const p2 = step('t.set', { path: 'B', value: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['slow:start']); // the second waits for the first
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(lines().map((l) => [l.command, l.args['path'], l.result.status])).toEqual([
      ['t.slow', 'A', 'ok'], ['t.set', 'B', 'ok'],
    ]);
  });

  it('a UI dispatch (origin ui) during a recording records no line — and its edit ENDS the recording (M8)', async () => {
    start();
    await step('t.set', { path: 'A', value: 1 });
    // A UI click goes through registry.execute directly, not through the MCP wrapper.
    await env.registry.execute('t.set', { path: 'B', value: 2 }, { origin: 'ui' });
    expect(lines()).toHaveLength(1);
    expect(env.recorder.active).toBeNull();
    expect(env.recorder.lastInterruption?.interruption.reason).toBe('change-outside-step');
    expect(macroBookOf(env.doc).macros.get('m1')?.interruptions?.[0]).toMatchObject({ reason: 'change-outside-step', afterStep: 1 });
  });

  it('M8: undo during a recording ends it with recording-interrupted; the buffer stays', async () => {
    start();
    await step('t.set', { path: 'A', value: 1 });
    await env.doc.undo();
    expect(env.recorder.active).toBeNull();
    expect(env.recorder.lastInterruption?.interruption.reason).toBe('history-undo');
    expect(lines()).toHaveLength(1);
    // A new recording of the same name continues the buffer.
    env.recorder.start(env.doc, macroBookOf(env.doc), 'm1', { name: 'T641' });
    await step('t.set', { path: 'C', value: 3 });
    expect(lines().map((l) => l.args['path'])).toEqual(['A', 'C']);
  });

  it('M8: redo, an announced restoreHistory (recompose undo) and rollbackTo each end the recording', async () => {
    await env.doc.applyOp(setFieldOp('Z', 1));
    await env.doc.undo();
    start('r1');
    await env.doc.redo();
    expect(env.recorder.lastInterruption?.interruption.reason).toBe('history-redo');

    const snap = env.doc.captureHistory();
    start('r2');
    env.doc.restoreHistory(snap, { announce: true });
    expect(env.recorder.lastInterruption?.interruption.reason).toBe('history-replace');

    start('r3');
    const floor = env.doc.opCount;
    await env.doc.applyOp(setFieldOp('Q', 9)); // outside a window → already interrupts
    expect(env.recorder.lastInterruption?.interruption.reason).toBe('change-outside-step');
    start('r4');
    await env.doc.rollbackTo(floor);
    expect(env.recorder.lastInterruption?.interruption.reason).toBe('history-rollback');
  });

  it('M9: a delayed commit lands in the step window; no change at all → noop', async () => {
    start();
    const o1 = await step('t.setDetached', { path: 'A', value: 4 });
    expect(o1.outcome.status).toBe('ok');
    expect(env.recorder.active).not.toBeNull(); // the commit was NOT a change outside the window
    const o2 = await step('t.nothing', { path: 'A' });
    expect(o2.outcome.status).toBe('noop');
    expect(lines().map((l) => l.result.status)).toEqual(['ok', 'noop']);
  });

  it('F2: meta arguments become the note and never reach the command args', async () => {
    start();
    const { args, meta } = splitMacroMeta({ path: 'A', value: 5, _reason: 'DFM-6-5 has 5 mm stroke', _source: 'parts:DFM-6-5', _confidence: 'observed' });
    expect(args).toEqual({ path: 'A', value: 5 });
    await step('t.set', args, { meta });
    expect(env.seen['t.set']).toEqual({ path: 'A', value: 5 });
    expect(lines()[0].note).toEqual({ author: 'agent', reason: 'DFM-6-5 has 5 mm stroke', source: 'parts:DFM-6-5', confidence: 'observed' });
    expect(lines()[0].args).not.toHaveProperty('_reason');
  });

  it('runtime commands (no macro flag) are never recorded', async () => {
    start();
    const o = await step('t.runtime', {});
    expect(o.recorded).toBe(false);
    expect(lines()).toHaveLength(0);
    expect(env.recorder.active).not.toBeNull();
  });

  it('a failed call is a line with status failed and its kind; a commercial-only command is requires-commercial', async () => {
    start();
    await step('t.refuse', { path: 'X' });
    await step('t.commercial', { path: 'X' });
    expect(lines().map((l) => l.result)).toEqual([
      { status: 'failed', kind: 'disabled', reason: 'No component "Drive" on X' },
      { status: 'requires-commercial', kind: 'unavailable', reason: ERR_EDITOR_UNAVAILABLE },
    ]);
  });

  it('a second recording is refused while one runs; stop releases', () => {
    start();
    expect(() => start('m2')).toThrow(/already running/);
    expect(env.recorder.stop()?.macro.name).toBe('m1');
    expect(() => start('m2')).not.toThrow();
  });

  it('a new line marks the document dirty even without an op (M5: it has to reach the next save)', async () => {
    expect(env.doc.dirty).toBe(false);
    start();
    await step('t.nothing', { path: 'A' }); // a noop line: no op in the stack
    expect(env.doc.opCount).toBe(0);
    expect(env.doc.dirty).toBe(true);
    expect(macroBookOf(env.doc).touched).toBe(true);
  });
});

// ─── M9 change evidence ─────────────────────────────────────────────────

describe('plan-641 M9 — RvDocument.changeSeq / onHistoryChange', () => {
  it('a coalesce moves changeSeq at an unchanged opCount; an undo with nothing to undo moves nothing', async () => {
    const events: string[] = [];
    env.doc.onHistoryChange((c) => events.push(c.kind));
    await env.doc.undo(); // nothing to undo
    expect(env.doc.changeSeq).toBe(0);
    await env.doc.applyOp(setFieldOp('A', 1));
    await env.doc.applyOp(setFieldOp('A', 2)); // same target inside the window → coalesce
    expect(env.doc.opCount).toBe(1);
    expect(env.doc.changeSeq).toBe(2);
    expect(events).toEqual(['record', 'coalesce']);
  });

  it('fires synchronously, once per change', async () => {
    const seqs: number[] = [];
    env.doc.onHistoryChange((c) => seqs.push(c.seq));
    await env.doc.applyOp(setFieldOp('A', 1));
    await env.doc.applyOp(setFieldOp('B', 1));
    await env.doc.undo();
    await env.doc.redo();
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});

// ─── M8 coalesce floor ──────────────────────────────────────────────────

describe('plan-641 M8 — coalesce floor of the recording', () => {
  it('unkeyed: a field set right before record_start and again by the first step → two separate ops', async () => {
    await env.doc.applyOp(setFieldOp('Cell/Slide', 1));
    start();
    await step('t.set', { path: 'Cell/Slide', value: 2 });
    expect(env.doc.opCount).toBe(2);
    expect(lines()[0].result.status).toBe('ok');
  });

  it('keyed: a keyed chain cannot amend an entry from before record_start', async () => {
    const key = { key: 'k641' };
    await env.doc.withTransaction('sync', async () => { await env.doc.applyOp(setFieldOp('S', 1)); }, { coalesce: key });
    const release = env.doc.markCoalesceFloor();
    await env.doc.withTransaction('sync', async () => { await env.doc.applyOp(setFieldOp('S', 2)); }, { coalesce: key });
    expect(env.doc.opCount).toBe(2);
    release();
    // Control: the chain itself works — without a floor the next step amends the top.
    await env.doc.withTransaction('sync', async () => { await env.doc.applyOp(setFieldOp('S', 3)); }, { coalesce: key });
    expect(env.doc.opCount).toBe(2);
  });

  it('within the recording own lines may coalesce; after stop ordinary edits coalesce again', async () => {
    start();
    await step('t.set', { path: 'A', value: 1 });
    await step('t.set', { path: 'A', value: 2 });
    expect(env.doc.opCount).toBe(1); // above the floor: the second line amends the first op
    env.recorder.stop();
    expect(env.doc.coalesceFloor).toBeNull();
    await env.doc.applyOp(setFieldOp('A', 3));
    expect(env.doc.opCount).toBe(1);
  });

  it('record → stop → undo → ordinary edits coalesce again (the floor was released)', async () => {
    start();
    await step('t.set', { path: 'A', value: 1 });
    env.recorder.stop();
    await env.doc.undo();
    await env.doc.applyOp(setFieldOp('B', 1));
    await env.doc.applyOp(setFieldOp('B', 2));
    expect(env.doc.opCount).toBe(1);
  });

  it('an interruption releases the floor too', async () => {
    start();
    expect(env.doc.coalesceFloor).toBe(0);
    await env.doc.applyOp(setFieldOp('X', 1)); // outside a window
    expect(env.recorder.active).toBeNull();
    expect(env.doc.coalesceFloor).toBeNull();
  });

  it('the history cap shifts the floor with the entries it protects', async () => {
    for (let i = 0; i < MAX_OP_HISTORY; i++) await env.doc.applyOp(setFieldOp(`N${i}`, i));
    const release = env.doc.markCoalesceFloor();
    expect(env.doc.coalesceFloor).toBe(MAX_OP_HISTORY);
    await env.doc.applyOp(setFieldOp('Over', 1));
    expect(env.doc.opCount).toBe(MAX_OP_HISTORY);
    expect(env.doc.coalesceFloor).toBe(MAX_OP_HISTORY - 1);
    release();
  });
});

// ─── M3 classification ──────────────────────────────────────────────────

describe('plan-641 M3 — classifyCommandOutcome', () => {
  it('maps every result shape', () => {
    expect(classifyCommandOutcome({ ok: false, kind: 'unavailable', reason: 'x' }, null).status).toBe('requires-commercial');
    expect(classifyCommandOutcome({ ok: false, kind: 'disabled', reason: 'x' }, null)).toEqual({ status: 'failed', kind: 'disabled', reason: 'x' });
    expect(classifyCommandOutcome({ ok: true, value: { error: 'boom' } }, true).status).toBe('failed');
    expect(classifyCommandOutcome({ ok: true, value: { ok: false, reason: 'r' } }, true)).toMatchObject({ status: 'failed', reason: 'r' });
    expect(classifyCommandOutcome({ ok: true, value: { skipped: ['a'] } }, true).status).toBe('partial');
    expect(classifyCommandOutcome({ ok: true, value: { applied: [] } }, true).status).toBe('noop');
    expect(classifyCommandOutcome({ ok: true, value: { ok: true } }, false).status).toBe('noop');
    expect(classifyCommandOutcome({ ok: true, value: { created: ['A/New'] } }, true)).toEqual({ status: 'ok', created: ['A/New'] });
    expect(classifyCommandOutcome({ ok: true, value: {} }, null).status).toBe('ok');
  });
});
