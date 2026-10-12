// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.9 — bootstrap of the editor command descriptors.
 *
 * The descriptors are eager (registered without the editor), the guard texts
 * are the ones every editor tool already returns, the community build answers
 * ERR_EDITOR_UNAVAILABLE BEFORE the mode guard in any mode, a slow loader plus
 * a document swap writes nothing, and nothing ever answers "Unknown command".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { CommandRegistry, type CommandImpl } from '../src/core/hmi/rv-command-registry';
import {
  EDITOR_COMMAND_IDS,
  NEEDS_TARGET,
  createEditorCommandDescriptors,
  ensureEditorCommandsRegistered,
  type EditorCommandsModule,
} from '../src/core/hmi/editor-command-descriptors';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import {
  ERR_DOCUMENT_CHANGED,
  ERR_EDITOR_ACTIVATING,
  ERR_EDITOR_UNAVAILABLE,
  ERR_NOT_EDITOR,
} from '../src/core/editor/rv-editor-guard-core';

function fakeViewer(mode: string): RVViewer {
  return {
    modes: { activeMode: mode },
    selectionManager: { getSnapshot: () => ({ selectedPaths: [] as string[] }), clear() {} },
  } as unknown as RVViewer;
}
const fakeDoc = (id: string) => ({ id, whenIdle: async () => {} }) as unknown as ActiveAssetContext['doc'];

const loadStub = () =>
  import('../src/private-stubs/plugins/asset-editor/editor-commands') as Promise<EditorCommandsModule>;

beforeEach(() => setActiveAssetContext(null));
afterEach(() => setActiveAssetContext(null));

describe('editor command bootstrap', () => {
  it('descriptors are registered without an editor and every id is known', () => {
    const reg = new CommandRegistry();
    ensureEditorCommandsRegistered(reg);
    for (const id of EDITOR_COMMAND_IDS) expect(reg.get(id), id).toBeDefined();
    // Idempotent per registry.
    const n = reg.list().length;
    ensureEditorCommandsRegistered(reg);
    expect(reg.list().length).toBe(n);
  });

  it('outside the editor → ERR_NOT_EDITOR; while activating → ERR_EDITOR_ACTIVATING; never kind unknown', async () => {
    const reg = new CommandRegistry();
    ensureEditorCommandsRegistered(reg);
    const outside = await reg.execute('editor.toGround', { path: 'A' }, { origin: 'mcp', viewer: fakeViewer('planner') });
    const activating = await reg.execute('editor.toGround', { path: 'A' }, { origin: 'mcp', viewer: fakeViewer('editor') });
    const expectedOutside = __RV_HAS_PRIVATE__ ? ERR_NOT_EDITOR : ERR_EDITOR_UNAVAILABLE;
    const expectedActivating = __RV_HAS_PRIVATE__ ? ERR_EDITOR_ACTIVATING : ERR_EDITOR_UNAVAILABLE;
    expect(outside).toMatchObject({ ok: false, reason: expectedOutside });
    expect(activating).toMatchObject({ ok: false, reason: expectedActivating });
    for (const id of EDITOR_COMMAND_IDS) {
      const r = await reg.execute(id, {}, { origin: 'mcp', viewer: fakeViewer('planner') });
      expect(r.ok ? 'ok' : r.kind, id).not.toBe('unknown');
    }
    // plan-590: the signal-rename commands have scope 'none' (they run in the scene too), so outside
    // the editor they pass the guard, LOAD the private implementation and refuse on their args —
    // that cold import of the editor module is what the longer timeout below pays for.
  }, 60_000);

  it('community stub + available:false → ERR_EDITOR_UNAVAILABLE in ANY mode (before the guard)', async () => {
    for (const mode of ['planner', 'editor', 'viewer']) {
      const reg = new CommandRegistry();
      for (const d of createEditorCommandDescriptors({ load: loadStub, available: false })) reg.register(d);
      const viewer = fakeViewer(mode);
      if (mode === 'editor') setActiveAssetContext({ viewer, doc: fakeDoc('d') });
      const r = await reg.execute('editor.toGround', { path: 'A' }, { origin: 'mcp', viewer });
      expect(r, mode).toEqual({ ok: false, kind: 'unavailable', reason: ERR_EDITOR_UNAVAILABLE });
      expect(reg.enabled('editor.toGround', { path: 'A' }, viewer)).toEqual({ reason: ERR_EDITOR_UNAVAILABLE });
      setActiveAssetContext(null);
    }
  });

  it('defence in depth: a stub wrongly flagged available still answers unavailable, not unknown', async () => {
    const reg = new CommandRegistry();
    for (const d of createEditorCommandDescriptors({ load: loadStub, available: true })) reg.register(d);
    const viewer = fakeViewer('editor');
    setActiveAssetContext({ viewer, doc: fakeDoc('d') });
    const r = await reg.execute('editor.toGround', { path: 'A' }, { origin: 'mcp', viewer });
    expect(r).toEqual({ ok: false, kind: 'unavailable', reason: ERR_EDITOR_UNAVAILABLE });
  });

  it('delayed loader + document swap → stale, run never called', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ran = false;
    const impl: CommandImpl<{ path: string }, unknown> = { enabled: () => true, run: () => { ran = true; } };
    const reg = new CommandRegistry();
    for (const d of createEditorCommandDescriptors({
      load: async () => { await gate; return { impls: { 'editor.toGround': impl as never } }; },
      available: true,
    })) reg.register(d);
    const viewer = fakeViewer('editor');
    setActiveAssetContext({ viewer, doc: fakeDoc('A') });
    const pending = reg.execute('editor.toGround', { path: 'X' }, { origin: 'mcp', viewer });
    setActiveAssetContext({ viewer, doc: fakeDoc('B') });
    release();
    expect(await pending).toEqual({ ok: false, kind: 'stale', reason: ERR_DOCUMENT_CHANGED });
    expect(ran).toBe(false);
  });

  it('preload makes enabled() synchronous with the production descriptor of THIS build', async () => {
    const reg = new CommandRegistry();
    ensureEditorCommandsRegistered(reg);
    const viewer = fakeViewer('editor');
    setActiveAssetContext({ viewer, doc: { id: 'd', whenIdle: async () => {}, lockOwner: null } as unknown as ActiveAssetContext['doc'] });
    // The private impls pull the editor UI, which the Node runner cannot load;
    // the COMMUNITY answer is fully synchronous here, the private one is checked
    // in the browser suites (mcp-bridge-command-path, rv-command-view).
    if (__RV_HAS_PRIVATE__) return;
    await reg.preload(['editor.toGround']);
    expect(reg.enabled('editor.toGround', { path: null }, viewer)).toEqual({ reason: ERR_EDITOR_UNAVAILABLE });
    expect(NEEDS_TARGET).toBe('Needs a target object');
  });

  it('selection.clear is open: available in every build and clears the selection', async () => {
    const reg = new CommandRegistry();
    ensureEditorCommandsRegistered(reg);
    let cleared = false;
    const viewer = {
      modes: { activeMode: 'editor' },
      selectionManager: { getSnapshot: () => ({ selectedPaths: ['A'] }), clear() { cleared = true; } },
    } as unknown as RVViewer;
    setActiveAssetContext({ viewer, doc: fakeDoc('d') });
    const r = await reg.execute('selection.clear', {}, { origin: 'mcp', viewer });
    expect(r).toEqual({ ok: true, value: { selected: 0 } });
    expect(cleared).toBe(true);
  });
});
