// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-707 T2 — `web_describe`: state capture, the `next` rule table, and the
 * two properties the tool would be worthless without.
 *
 * The interesting cases are the three documented dead ends. Each one is a state
 * in which a tool reported something reasonable and the agent had no way to see
 * that it was stuck: the editor at `busy`, a library document that opened empty,
 * a document nothing has been perceived in yet. `next` has to name the way out
 * of each, by tool, from the state alone.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  McpDescribeTool,
  chooseNext,
  computeBlocked,
  NEXT_RULES,
  type DescribeResult,
} from '../src/plugins/mcp-bridge/rv-mcp-describe-tool';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { allSchemas } from './helpers/mcp-schemas';

// ── Mock viewer ─────────────────────────────────────────────────────────

interface MockDoc {
  id: string;
  name: string;
  base: { kind: string };
  dirty: boolean;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  opCount: number;
}

function makeViewer(opts: {
  mode?: string | null;
  doc?: Partial<MockDoc> | null;
  nodeCount?: number;
  selected?: string[];
  modelUrl?: string | null;
  paused?: boolean;
} = {}) {
  const selected = opts.selected ?? [];
  const nodeCount = opts.nodeCount ?? 0;
  // A tiny stand-in tree: `traverse` visits itself plus n-1 children.
  const root = nodeCount > 0
    ? { traverse: (cb: () => void) => { for (let i = 0; i < nodeCount; i++) cb(); } }
    : null;

  const viewer = {
    modes: {
      activeMode: opts.mode === undefined ? 'hmi' : opts.mode,
      list: () => [{ id: 'hmi' }, { id: 'planner' }, { id: 'des' }, { id: 'editor' }],
      has: (id: string) => ['hmi', 'planner', 'des', 'editor'].includes(id),
    },
    selectionManager: { getSnapshot: () => ({ selectedPaths: selected }) },
    connectionState: 'Connected',
    currentModelUrl: opts.modelUrl === undefined ? '/models/test.glb' : opts.modelUrl,
    currentModelRoot: root,
    isSimulationPaused: opts.paused ?? false,
    drives: [{ name: 'D1' }, { name: 'D2' }],
    signalStore: { size: 7, get: () => undefined },
    transportManager: null,
  };

  if (opts.doc) {
    const snap: MockDoc = {
      id: 'doc-1', name: 'TestAsset', base: { kind: 'empty' },
      dirty: false, busy: false, canUndo: false, canRedo: false, opCount: 0,
      ...opts.doc,
    };
    setActiveAssetContext({
      viewer: viewer as never,
      doc: { getSnapshot: () => snap } as never,
    });
  } else {
    setActiveAssetContext(null);
  }
  return viewer;
}

async function describeWith(opts: Parameters<typeof makeViewer>[0] = {}): Promise<DescribeResult> {
  const viewer = makeViewer(opts);
  const tool = new McpDescribeTool(() => viewer as never);
  return JSON.parse(await tool.webDescribe('')) as DescribeResult;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('web_describe — state capture', () => {
  it('reports mode, runtime and selection from the existing getters', async () => {
    const r = await describeWith({ selected: ['A/B', 'A/C'] });
    expect(r.mode).toBe('hmi');
    expect(r.availableModes).toContain('planner');
    expect(r.runtime.connectionState).toBe('Connected');
    expect(r.runtime.simRunning).toBe(true);
    expect(r.runtime.driveCount).toBe(2);
    expect(r.runtime.signalCount).toBe(7);
    expect(r.selection).toEqual({ count: 2, firstPath: 'A/B' });
  });

  it('document is null outside editor mode', async () => {
    const r = await describeWith({ mode: 'hmi' });
    expect(r.document).toBeNull();
  });

  it('document carries base kind, counts and the busy flag', async () => {
    const r = await describeWith({
      mode: 'editor',
      doc: { name: 'Robot', base: { kind: 'document' }, opCount: 12, dirty: true },
      nodeCount: 340,
    });
    expect(r.document).not.toBeNull();
    expect(r.document!.name).toBe('Robot');
    expect(r.document!.baseKind).toBe('document');
    expect(r.document!.opCount).toBe(12);
    expect(r.document!.nodeCount).toBe(340);
    expect(r.document!.dirty).toBe(true);
  });
});

describe('web_describe — the next rule table', () => {
  it('nothing loaded → names an opening tool', async () => {
    const r = await describeWith({ modelUrl: null, nodeCount: 0 });
    expect(r.next).toMatch(/web_scene_open|web_editor_open/);
    expect(r.document).toBeNull();
  });

  it('fresh editor document → perceive first, and points at the editor guide', async () => {
    const r = await describeWith({ mode: 'editor', doc: { opCount: 0 }, nodeCount: 5 });
    expect(r.next).toContain('web_node_tree');
    expect(r.guide).toBe('web_help("editor")');
  });

  it('busy editor → warns against pushing another call — scenario A1', async () => {
    const r = await describeWith({
      mode: 'editor', doc: { busy: true, opCount: 40 }, nodeCount: 900,
    });
    expect(r.next).toContain('web_editor_status');
    expect(r.next).toMatch(/not push|do NOT/i);
  });

  it('libraryGlb with an empty tree → names the re-import route — scenario A2', async () => {
    const r = await describeWith({
      mode: 'editor',
      doc: { base: { kind: 'document' }, opCount: 0 },
      nodeCount: 1,
    });
    expect(r.next).toContain('web_editor_import_glb');
    expect(r.next).toMatch(/EMPTY/i);
  });

  it('the A1 and A2 rules outrank the ordinary workflow rules', () => {
    // Both dead-end states ALSO satisfy "opCount === 0" / "dirty". Order is the
    // design here, so it is asserted rather than left to the table's shape.
    const busy = chooseNext({
      mode: 'editor', hasModel: true, selectionCount: 0,
      doc: { name: 'x', baseKind: 'document', dirty: true, busy: true, opCount: 0, nodeCount: 1, canUndo: false },
    });
    expect(busy.next).toContain('web_editor_status');

    const empty = chooseNext({
      mode: 'editor', hasModel: true, selectionCount: 0,
      doc: { name: 'x', baseKind: 'document', dirty: true, busy: false, opCount: 0, nodeCount: 1, canUndo: false },
    });
    expect(empty.next).toContain('web_editor_import_glb');
  });

  it('dirty document → verify before save', async () => {
    const r = await describeWith({
      mode: 'editor', doc: { dirty: true, opCount: 9 }, nodeCount: 50,
    });
    expect(r.next).toContain('web_editor_verify_drive');
    expect(r.next).toContain('web_editor_save');
  });

  it('the table always answers — every state hits a rule', () => {
    const last = NEXT_RULES[NEXT_RULES.length - 1];
    expect(last.when({ mode: null, hasModel: false, doc: null, selectionCount: 0 })).toBe(true);
  });
});

describe('web_describe — blocked families', () => {
  it('hmi mode blocks layout AND editor, each with the unblocking tool', async () => {
    const r = await describeWith({ mode: 'hmi' });
    const layout = r.blocked.find((b) => b.family === 'web_layout_*');
    const editor = r.blocked.find((b) => b.family === 'web_editor_*');
    expect(layout?.reason).toContain('web_mode_set');
    expect(editor?.reason).toContain('web_editor_open');
  });

  it('planner mode does not block layout', () => {
    const blocked = computeBlocked({
      mode: 'planner', hasModel: true, doc: null, selectionCount: 0,
    });
    expect(blocked.some((b) => b.family === 'web_layout_*')).toBe(false);
  });

  it('an open document does not block the editor family', () => {
    const blocked = computeBlocked({
      mode: 'editor', hasModel: true, selectionCount: 0,
      doc: { name: 'x', baseKind: 'empty', dirty: false, busy: false, opCount: 3, nodeCount: 9, canUndo: true },
    });
    expect(blocked.some((b) => b.family === 'web_editor_*')).toBe(false);
  });
});

describe('web_describe — contract', () => {
  it('is announced as read-only', () => {
    const s = allSchemas().find((x) => x.name === 'web_describe');
    expect(s, 'web_describe must be in the shared instance list').toBeTruthy();
    expect(s!.annotations?.readOnlyHint).toBe(true);
  });

  it('touches neither selection nor camera nor panels (F4)', async () => {
    const viewer = makeViewer({ mode: 'editor', doc: {}, selected: ['A'] });
    const selectPaths = vi.fn();
    const clear = vi.fn();
    (viewer.selectionManager as unknown as Record<string, unknown>).selectPaths = selectPaths;
    (viewer.selectionManager as unknown as Record<string, unknown>).clear = clear;
    (viewer as unknown as Record<string, unknown>).fitToNodes = vi.fn();
    (viewer as unknown as Record<string, unknown>).leftPanelManager = {
      open: vi.fn(), isOpen: () => false,
    };

    const tool = new McpDescribeTool(() => viewer as never);
    await tool.webDescribe('');

    expect(selectPaths).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect((viewer as unknown as { fitToNodes: ReturnType<typeof vi.fn> }).fitToNodes)
      .not.toHaveBeenCalled();
    expect(
      (viewer as unknown as { leftPanelManager: { open: ReturnType<typeof vi.fn> } })
        .leftPanelManager.open,
    ).not.toHaveBeenCalled();
  });

  it('agrees with web_status on the shared counts (R8)', async () => {
    // Both read `viewer.drives.length` and `viewer.signalStore.size`; this pins
    // that neither grows its own arithmetic.
    const r = await describeWith();
    expect(r.runtime.driveCount).toBe(2);
    expect(r.runtime.signalCount).toBe(7);
  });

  it('is cheaper than the three calls it replaces (NF2)', async () => {
    const r = await describeWith({ mode: 'editor', doc: { opCount: 4 }, nodeCount: 120 });
    const size = JSON.stringify(r).length;
    // web_status alone is ~600 B once renderDiagnostics is in it; the editor
    // status ~250 B; the selection listing grows with the selection. One
    // describe must stay below their sum, or the tool costs what it saves.
    expect(size).toBeLessThan(850);
  });

  it('names a guide by tool call, never guide content (F5, R11)', async () => {
    const r = await describeWith({ mode: 'editor', doc: {}, nodeCount: 3 });
    expect(r.guide).toMatch(/^web_help\("/);
    expect(JSON.stringify(r).length).toBeLessThan(2000); // no guide text inlined
  });

  it('answers without a viewer instead of throwing', async () => {
    const tool = new McpDescribeTool(() => undefined);
    const out = JSON.parse(await tool.webDescribe(''));
    expect(out.error).toBeTruthy();
  });
});
