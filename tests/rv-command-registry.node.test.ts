// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.1 — the command registry's dispatcher contract.
 *
 * One dispatcher order (unknown → available → guard → lazy impl → identity
 * recheck → visible → enabled → recheck → run → onExecuted), ONE reason for
 * tooltip and tool result, no `run` on refusal, the loading state before the
 * implementation arrives, an early context capture that pins the call to its
 * document, and `details` / `CommandError` for tool-only extras.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  COMMAND_LOADING_REASON,
  CommandError,
  CommandRegistry,
  type CommandDescriptor,
  type CommandImpl,
  type ExecutedEvent,
} from '../src/core/hmi/rv-command-registry';
import { NEEDS_TARGET } from '../src/core/hmi/editor-command-descriptors';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import {
  ERR_DOCUMENT_CHANGED,
  ERR_EDITOR_ACTIVATING,
  ERR_EDITOR_UNAVAILABLE,
  ERR_NOT_EDITOR,
} from '../src/core/editor/rv-editor-guard-core';

// ─── Fixture ────────────────────────────────────────────────────────────

function fakeViewer(mode = 'editor', selection: string[] = []): RVViewer & { setMode(m: string): void } {
  let active = mode;
  return {
    modes: { get activeMode() { return active; } },
    selectionManager: { getSnapshot: () => ({ selectedPaths: selection }) },
    setMode(m: string) { active = m; },
  } as unknown as RVViewer & { setMode(m: string): void };
}

function fakeDoc(id: string) {
  return { id, whenIdle: async () => {} } as unknown as ActiveAssetContext['doc'];
}

function enterEditor(viewer: RVViewer, docId = 'doc-1'): void {
  setActiveAssetContext({ viewer, doc: fakeDoc(docId) });
}

type Args = { path?: string | null };

interface Probe {
  loader: ReturnType<typeof vi.fn>;
  enabled: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  desc: CommandDescriptor<Args, { path: string }>;
}

function probeCommand(opts: { available?: boolean; loadGate?: Promise<void>; run?: (a: Args) => unknown } = {}): Probe {
  const enabled = vi.fn((_ctx, a: Args) => (a?.path ? true : { reason: NEEDS_TARGET }));
  const run = vi.fn(async (_ctx, a: Args) => (opts.run ? opts.run(a) : { path: a.path as string }));
  const impl = { enabled, run } as unknown as CommandImpl<Args, { path: string }>;
  const loader = vi.fn(async () => { if (opts.loadGate) await opts.loadGate; return impl; });
  return {
    loader, enabled, run,
    desc: {
      id: 'editor.probe', label: 'Probe', readOnly: false, scope: 'editor',
      available: opts.available ?? true, unavailableReason: ERR_EDITOR_UNAVAILABLE,
      argsSchema: { path: 'string' },
      buttonKey: () => 'qe.probe', impl: loader,
    },
  };
}

beforeEach(() => { setActiveAssetContext(null); });
afterEach(() => { setActiveAssetContext(null); });

// ─── Dispatcher order ───────────────────────────────────────────────────

describe('CommandRegistry — dispatcher order', () => {
  it('unavailable answers BEFORE the mode guard and never loads the impl', async () => {
    const reg = new CommandRegistry();
    const p = probeCommand({ available: false });
    reg.register(p.desc);
    const r = await reg.execute('editor.probe', { path: 'A' }, { origin: 'mcp', viewer: fakeViewer('planner') });
    expect(r).toEqual({ ok: false, kind: 'unavailable', reason: ERR_EDITOR_UNAVAILABLE });
    expect(p.loader).not.toHaveBeenCalled();
    expect(p.run).not.toHaveBeenCalled();
  });

  it('guard before impl load: outside the editor → ERR_NOT_EDITOR, loader untouched', async () => {
    const reg = new CommandRegistry();
    const p = probeCommand();
    reg.register(p.desc);
    const r = await reg.execute('editor.probe', { path: 'A' }, { origin: 'mcp', viewer: fakeViewer('planner') });
    expect(r).toEqual({ ok: false, kind: 'invisible', reason: ERR_NOT_EDITOR });
    expect(p.loader).not.toHaveBeenCalled();
  });

  it('activation race: editor mode without active context → ERR_EDITOR_ACTIVATING', async () => {
    const reg = new CommandRegistry();
    reg.register(probeCommand().desc);
    const r = await reg.execute('editor.probe', { path: 'A' }, { origin: 'mcp', viewer: fakeViewer('editor') });
    expect(r).toMatchObject({ ok: false, reason: ERR_EDITOR_ACTIVATING });
  });

  it('unknown id is only for typos', async () => {
    const reg = new CommandRegistry();
    const r = await reg.execute('editor.nope', {}, { origin: 'mcp', viewer: fakeViewer() });
    expect(r).toMatchObject({ ok: false, kind: 'unknown' });
  });

  it('returns the same reason from enabled() and execute(), run never called, onExecuted fires once', async () => {
    const reg = new CommandRegistry();
    const p = probeCommand();
    reg.register(p.desc);
    const viewer = fakeViewer();
    enterEditor(viewer);
    await reg.preload(['editor.probe']);
    const events: ExecutedEvent[] = [];
    reg.onExecuted((e) => events.push(e));

    const tooltip = reg.enabled('editor.probe', { path: null }, viewer);
    const r = await reg.execute('editor.probe', { path: null }, { origin: 'mcp', viewer });

    expect(tooltip).toEqual({ reason: NEEDS_TARGET });
    expect(r).toEqual({ ok: false, kind: 'disabled', reason: NEEDS_TARGET });
    expect(p.run).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'editor.probe', origin: 'mcp', buttonKey: 'qe.probe' });
  });

  it('fires onExecuted with origin and result; value passed through', async () => {
    const reg = new CommandRegistry();
    const p = probeCommand();
    reg.register(p.desc);
    const viewer = fakeViewer();
    enterEditor(viewer);
    const events: ExecutedEvent[] = [];
    reg.onExecuted((e) => events.push(e));
    const r = await reg.execute('editor.probe', { path: 'A' }, { origin: 'ui', viewer });
    expect(r).toEqual({ ok: true, value: { path: 'A' } });
    expect(p.run).toHaveBeenCalledTimes(1);
    expect(events.map((e) => [e.origin, e.buttonKey, e.result.ok])).toEqual([['ui', 'qe.probe', true]]);
  });

  it('reports COMMAND_LOADING_REASON before the impl is loaded and the real reason after preload()', async () => {
    const reg = new CommandRegistry();
    const p = probeCommand();
    reg.register(p.desc);
    const viewer = fakeViewer();
    enterEditor(viewer);
    expect(reg.enabled('editor.probe', { path: null }, viewer)).toEqual({ reason: COMMAND_LOADING_REASON });
    await reg.preload(['editor.probe']);
    expect(reg.enabled('editor.probe', { path: null }, viewer)).toEqual({ reason: NEEDS_TARGET });
    expect(reg.enabled('editor.probe', { path: 'A' }, viewer)).toBe(true);
    // _resetForTest drops the loaded impl again.
    reg._resetForTest();
    expect(reg.enabled('editor.probe', { path: 'A' }, viewer)).toEqual({ reason: COMMAND_LOADING_REASON });
  });

  it('identity recheck: the document changes while the impl loads → stale, nothing runs', async () => {
    const reg = new CommandRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = probeCommand({ loadGate: gate });
    reg.register(p.desc);
    const viewer = fakeViewer();
    enterEditor(viewer, 'doc-1');

    const pending = reg.execute('editor.probe', { path: 'A' }, { origin: 'mcp', viewer });
    enterEditor(viewer, 'doc-2'); // base swap during the slow load
    release();
    const r = await pending;

    expect(r).toEqual({ ok: false, kind: 'stale', reason: ERR_DOCUMENT_CHANGED });
    expect(p.enabled).not.toHaveBeenCalled();
    expect(p.run).not.toHaveBeenCalled();
  });

  it('identity recheck also catches a mode change during the load', async () => {
    const reg = new CommandRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = probeCommand({ loadGate: gate });
    reg.register(p.desc);
    const viewer = fakeViewer();
    enterEditor(viewer);
    const pending = reg.execute('editor.probe', { path: 'A' }, { origin: 'mcp', viewer });
    viewer.setMode('planner');
    release();
    expect(await pending).toMatchObject({ ok: false, kind: 'stale' });
    expect(p.run).not.toHaveBeenCalled();
  });

  it('early capture (bridge path): a document swapped between capture and execute is stale, same path or not', async () => {
    const reg = new CommandRegistry();
    const p = probeCommand();
    reg.register(p.desc);
    const viewer = fakeViewer('editor', ['A']);
    enterEditor(viewer, 'doc-A');
    const captured = reg.captureContext(viewer);
    expect(captured.handle?.documentKey).toBe('doc-A');
    expect(captured.selection).toEqual(['A']);
    enterEditor(viewer, 'doc-B'); // document B also has a node "A"
    const r = await reg.execute('editor.probe', { path: 'A' }, { origin: 'mcp', viewer, context: captured });
    expect(r).toEqual({ ok: false, kind: 'stale', reason: ERR_DOCUMENT_CHANGED });
    expect(reg.enabled('editor.probe', { path: 'A' }, viewer, captured)).toEqual({ reason: ERR_DOCUMENT_CHANGED });
    expect(p.run).not.toHaveBeenCalled();
  });

  it('the captured selection (not the live one) reaches enabled() and run()', async () => {
    const reg = new CommandRegistry();
    const seen: string[][] = [];
    reg.register({
      id: 'probe.sel', label: 'Sel', readOnly: false, scope: 'none', available: true,
      unavailableReason: 'x', argsSchema: {},
      impl: async () => ({
        enabled: (ctx) => { seen.push([...ctx.selection]); return true; },
        run: (ctx) => { seen.push([...ctx.selection]); },
      }),
    });
    const viewer = fakeViewer('viewer', ['live']);
    await reg.execute('probe.sel', {}, { origin: 'mcp', viewer, context: { handle: null, selection: ['early'] } });
    expect(seen).toEqual([['early'], ['early']]);
  });

  it('keyboard path: origin shortcut takes the same enabled() gate', async () => {
    const reg = new CommandRegistry();
    const p = probeCommand();
    reg.register(p.desc);
    const viewer = fakeViewer();
    enterEditor(viewer);
    const refused = await reg.execute('editor.probe', { path: null }, { origin: 'shortcut', viewer });
    const done = await reg.execute('editor.probe', { path: 'A' }, { origin: 'shortcut', viewer });
    expect(refused).toMatchObject({ ok: false, reason: NEEDS_TARGET });
    expect(done.ok).toBe(true);
    expect(p.run).toHaveBeenCalledTimes(1);
  });

  it('details ride along a refusal; a CommandError from run() becomes kind threw with details', async () => {
    const reg = new CommandRegistry();
    reg.register({
      id: 'probe.details', label: 'D', readOnly: false, scope: 'none', available: true,
      unavailableReason: 'x', argsSchema: { ok: 'boolean' },
      impl: async () => ({
        enabled: (_c, a: { ok: boolean }) => (a.ok ? true : { reason: 'Unknown type', details: { availableTypes: ['Drive'] } }),
        run: () => { throw new CommandError('did not land', { stored: 1 }); },
      }),
    });
    const viewer = fakeViewer('viewer');
    expect(await reg.execute('probe.details', { ok: false }, { origin: 'mcp', viewer }))
      .toEqual({ ok: false, kind: 'disabled', reason: 'Unknown type', details: { availableTypes: ['Drive'] } });
    expect(await reg.execute('probe.details', { ok: true }, { origin: 'mcp', viewer }))
      .toEqual({ ok: false, kind: 'threw', reason: 'did not land', details: { stored: 1 } });
  });

  it('labelOf / buttonKeyOf read the descriptor (function labels see the args)', () => {
    const reg = new CommandRegistry();
    reg.register({
      id: 'probe.label', label: (a: { axis: string }) => `Rotate ${a.axis}`, readOnly: false, scope: 'none',
      available: true, unavailableReason: 'x', argsSchema: { axis: 'string' },
      buttonKey: (a: { axis: string }) => `qe.rotate-${a.axis}`, impl: async () => null,
    });
    expect(reg.labelOf('probe.label', { axis: 'y' })).toBe('Rotate y');
    expect(reg.buttonKeyOf('probe.label', { axis: 'y' })).toBe('qe.rotate-y');
    expect(reg.buttonKeyOf('nope', {})).toBe('nope');
  });

  it('stale unregister is a no-op after re-register (generation guard)', () => {
    const reg = new CommandRegistry();
    const off1 = reg.register(probeCommand().desc);
    reg.register(probeCommand().desc);
    off1();
    expect(reg.get('editor.probe')).toBeDefined();
  });
});
