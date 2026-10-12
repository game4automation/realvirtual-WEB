// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.4 — `web_editor_shortcut` is a view of commands (F6).
 *
 * Every key combo is a branch of SHORTCUT_BINDING and dispatches the command
 * the real key triggers — exactly once, with the call's selection as the
 * implicit target (`null` args). Aliases normalise (Backspace, Ctrl+Shift+Z,
 * K>NAME, any case/spacing); an unknown combo answers the table and dispatches
 * nothing; K without a name answers the reason plus the existing names and
 * dispatches nothing. Chromium: the tool class imports viewer modules.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { createMcpDelegates } from '../src/plugins/mcp-bridge/rv-mcp-instances';
import type { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureEditorCommandsRegistered } from '../src/core/hmi/editor-command-descriptors';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';

const viewer = {
  modes: { activeMode: 'editor' },
  selectionManager: { getSnapshot: () => ({ selectedPaths: ['A'] }), clear() {}, selectPaths() {} },
  registry: { getNode: () => null },
  currentModelRoot: null,
} as unknown as RVViewer;

let tools: McpEditorTools;

beforeAll(() => {
  ensureEditorCommandsRegistered();
  tools = createMcpDelegates(() => viewer)['McpEditorTools'] as McpEditorTools;
});

afterEach(() => {
  vi.restoreAllMocks();
  setActiveAssetContext(null);
});

const CASES: ReadonlyArray<{ keys: string; arg?: string; id: string; args: unknown; value: Record<string, unknown>; result: Record<string, unknown> }> = [
  { keys: 'S>I', id: 'select.identical', args: { seeds: null }, value: { selected: 4 }, result: { shortcut: 'S>I', selected: 4 } },
  { keys: 's > m', id: 'select.sameMaterial', args: { seeds: null }, value: { selected: 2 }, result: { shortcut: 'S>M', selected: 2 } },
  { keys: 'S>V', id: 'select.invert', args: { selected: null }, value: { selected: 9 }, result: { shortcut: 'S>V', selected: 9 } },
  {
    keys: 'K', arg: 'Turntable', id: 'editor.assignToKinematic', args: { name: 'Turntable', paths: null, requireExisting: false },
    value: { kinematicPath: 'Turntable', groupName: 'Turntable', members: 1 },
    result: { shortcut: 'K', groupName: 'Turntable', kinematicPath: 'Turntable' },
  },
  {
    keys: 'K>NAME', arg: 'Lift', id: 'editor.assignToKinematic', args: { name: 'Lift', paths: null, requireExisting: false },
    value: { kinematicPath: 'Lift', groupName: 'Lift' }, result: { shortcut: 'K', groupName: 'Lift' },
  },
  { keys: 'H', id: 'editor.hide', args: { paths: null }, value: { changed: 1, visible: false }, result: { shortcut: 'H', changed: 1, visible: false } },
  { keys: 'Shift+H', id: 'editor.show', args: { paths: null }, value: { changed: 1, visible: true }, result: { shortcut: 'SHIFT+H', changed: 1, visible: true } },
  { keys: 'Delete', id: 'editor.delete', args: { paths: null }, value: { deleted: 1 }, result: { shortcut: 'Delete', deleted: 1 } },
  { keys: 'Backspace', id: 'editor.delete', args: { paths: null }, value: { deleted: 1 }, result: { shortcut: 'Delete', deleted: 1 } },
  { keys: 'Ctrl+Z', id: 'editor.undo', args: { count: 1 }, value: { undone: 1, canUndo: false, canRedo: true }, result: { undone: 1 } },
  { keys: 'Ctrl+Y', id: 'editor.redo', args: { count: 1 }, value: { redone: 1 }, result: { redone: 1 } },
  { keys: 'Ctrl+Shift+Z', id: 'editor.redo', args: { count: 1 }, value: { redone: 1 }, result: { redone: 1 } },
  { keys: 'Escape', id: 'selection.clear', args: {}, value: { selected: 0 }, result: { shortcut: 'Escape', selected: 0 } },
  // Wireframe view: the bare key flips (on: null), arg sets it explicitly.
  { keys: 'Shift+Z', id: 'editor.wireframe', args: { on: null }, value: { wireframe: true }, result: { shortcut: 'Shift+Z', wireframe: true } },
  { keys: 'Shift+Z', arg: 'off', id: 'editor.wireframe', args: { on: false }, value: { wireframe: false }, result: { shortcut: 'Shift+Z', wireframe: false } },
];

describe('web_editor_shortcut over commands', () => {
  it('every branch dispatches its command exactly once, with the selection as the implicit target', async () => {
    for (const c of CASES) {
      const spy = vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: true, value: c.value });
      const res = JSON.parse(await tools.webEditorShortcut(c.keys, c.arg as string)) as Record<string, unknown>;
      expect(spy, c.keys).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0], c.keys).toBe(c.id);
      expect(spy.mock.calls[0][1], c.keys).toEqual(c.args);
      // The early-captured selection travels with the dispatch.
      expect(spy.mock.calls[0][2], c.keys).toMatchObject({ origin: 'mcp', context: { selection: ['A'] } });
      expect(res, c.keys).toMatchObject(c.result);
      spy.mockRestore();
    }
  }, 30_000);

  it('a refused command answers its reason', async () => {
    vi.spyOn(commandRegistry, 'execute').mockResolvedValue({ ok: false, kind: 'disabled', reason: 'Nothing selected — select first (web_select)' });
    expect(JSON.parse(await tools.webEditorShortcut('H', undefined as unknown as string)))
      .toEqual({ error: 'Nothing selected — select first (web_select)' });
  });

  it('an unknown combo answers the table and dispatches nothing', async () => {
    setActiveAssetContext({ viewer, doc: { id: 'd' } as unknown as ActiveAssetContext['doc'] });
    const spy = vi.spyOn(commandRegistry, 'execute');
    const res = JSON.parse(await tools.webEditorShortcut('Q>Z', undefined as unknown as string)) as Record<string, unknown>;
    expect(spy).not.toHaveBeenCalled();
    expect(res['error']).toBe('Unknown shortcut "Q>Z"');
    expect(Object.keys(res['shortcuts'] as object)).toContain('S>I');
  });

  it('K without a name answers the reason (with the existing names) and dispatches nothing', async () => {
    const spy = vi.spyOn(commandRegistry, 'execute');
    const res = JSON.parse(await tools.webEditorShortcut('K', '')) as Record<string, unknown>;
    expect(spy).not.toHaveBeenCalled();
    expect(res['error']).toBe('K needs arg = kinematic/group name');
    expect(Array.isArray(res['existing'])).toBe(true);
  });
});
