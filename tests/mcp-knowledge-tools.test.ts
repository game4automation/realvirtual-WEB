// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-knowledge-tools — the contracts of `web_knowledge_set/get/list`
 * (plan-394 test 9.3).
 *
 * Most of this file is about refusals, and two of them carry the feature.
 *
 * **A write that will not be kept must not be reported as kept.** A transient
 * workspace — an Example model, a shared link — accepts ops, supports undo and
 * reports `EditTarget.available === true`, and persists absolutely nothing. An
 * agent told `persistedTo: 'scene'` there would write two hundred notes over an
 * afternoon and lose every one of them on reload, with nothing having said so.
 *
 * **A note over the limit is an error, never a shortening.** Truncated
 * engineering knowledge reads as complete knowledge. That is worse than no note,
 * so the tool refuses and stores nothing.
 *
 * The real `RvExtrasEditorPlugin` is used rather than a stub, because its three
 * guards (readonly field, locked LayoutObject ancestor, ephemeral field) are
 * precisely what F10 has to react to — a stubbed `updateOverlayField` would test
 * the mock instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { McpKnowledgeTools } from '../src/plugins/mcp-bridge/rv-mcp-knowledge-tools';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import {
  MAX_NOTE_CHARS,
  NODE_KNOWLEDGE_TYPE,
  readNodeKnowledge,
} from '../src/core/engine/rv-node-knowledge';
import { getNodeId, setNodeId } from '../src/core/engine/rv-node-id';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Edit-target fixtures ───────────────────────────────────────────────

/** Records ops and reports a normal, persisting scene. */
function recordingEditTarget(persistsTo: 'scene' | 'asset' = 'scene') {
  const ops: Array<{ kind: string; nodePath: string; field?: string; value?: unknown }> = [];
  const target: EditTarget = {
    available: true,
    persistsTo,
    setField: (nodePath, _c, field, value) => { ops.push({ kind: 'setField', nodePath, field, value }); },
    unsetField: (nodePath, _c, field) => { ops.push({ kind: 'unsetField', nodePath, field }); },
    withTransaction: async (label, fn) => { ops.push({ kind: `transaction:${label}`, nodePath: '' }); await fn(); },
  };
  return { target, ops };
}

/**
 * The case `available` alone cannot see: ops are accepted, undo works, and
 * `_afterOpsChanged` returns before every persistence path.
 */
function transientEditTarget() {
  const { target, ops } = recordingEditTarget();
  return { target: { ...target, persistsTo: 'none' } as EditTarget, ops };
}

/** Pre-boot / no document. */
const UNAVAILABLE: EditTarget = {
  available: false,
  persistsTo: 'none',
  setField: () => { throw new Error('must not be called'); },
  unsetField: () => { throw new Error('must not be called'); },
  withTransaction: async (_label, fn) => { await fn(); },
};

/** An asset-editor target: it owns a real removeComponent op. */
function assetEditTarget() {
  const removed: Array<{ nodePath: string; componentType: string }> = [];
  const { target, ops } = recordingEditTarget('asset');
  return {
    target: {
      ...target,
      removeComponent: (nodePath: string, componentType: string) => {
        removed.push({ nodePath, componentType });
      },
    } as EditTarget,
    ops,
    removed,
  };
}

// ─── Scene fixture ──────────────────────────────────────────────────────

interface Fixture {
  tools: McpKnowledgeTools;
  nodes: Record<string, Object3D>;
  editor: RvExtrasEditorPlugin;
}

/**
 * Cell/Axis1, Cell/Axis2 and Cell/Locked/Inner, the last under a LOCKED
 * LayoutObject — the guard path F10 must surface as an error.
 */
function makeFixture(): Fixture {
  const root = new Object3D();
  root.name = 'Cell';
  const axis1 = new Object3D(); axis1.name = 'Axis1'; root.add(axis1);
  const axis2 = new Object3D(); axis2.name = 'Axis2'; root.add(axis2);
  const locked = new Object3D(); locked.name = 'Locked'; root.add(locked);
  locked.userData.realvirtual = { LayoutObject: { Locked: true } };
  const inner = new Object3D(); inner.name = 'Inner'; locked.add(inner);

  setNodeId(axis1, 'a1b2c3d4e5f60718');
  setNodeId(axis2, 'a1b2c3d4e5f60718');   // SAME id — the multi-reference case

  const byPath: Record<string, Object3D> = {
    'Cell': root,
    'Cell/Axis1': axis1,
    'Cell/Axis2': axis2,
    'Cell/Locked': locked,
    'Cell/Locked/Inner': inner,
  };
  const pathByNode = new Map<Object3D, string>(
    Object.entries(byPath).map(([path, node]) => [node, path]),
  );

  const registry = {
    getNode: (path: string) => byPath[path] ?? null,
    getPathForNode: (node: Object3D) => pathByNode.get(node) ?? null,
  };

  const editor = new RvExtrasEditorPlugin();
  const viewer = {
    registry,
    currentModelRoot: root,
    scene: root,
    getPlugin: <T>(id: string): T | undefined =>
      (id === 'rv-extras-editor' ? editor as unknown as T : undefined),
  } as unknown as RVViewer;
  (editor as unknown as { _viewer: RVViewer })._viewer = viewer;

  return { tools: new McpKnowledgeTools(() => viewer), nodes: byPath, editor };
}

const parse = (raw: string): Record<string, unknown> => JSON.parse(raw);

describe('web_knowledge_set', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => { setActiveEditTarget(null); });

  it('stores the note and reports persistedTo "scene" for a normal scene', async () => {
    const { target, ops } = recordingEditTarget();
    setActiveEditTarget(target);

    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', '- backlash ~0.2deg'));
    expect(res.error).toBeUndefined();
    expect(res.path).toBe('Cell/Axis1');
    expect(res.chars).toBe('- backlash ~0.2deg'.length);
    expect(res.persistedTo).toBe('scene');
    // "Optimistic" has to be said out loud: a model switch cancels the autosave.
    expect(String(res.persistenceNote)).toContain('cancelled');

    // Five fields, five ops — provenance is persisted, not just returned.
    expect(ops.filter((o) => o.kind === 'setField').map((o) => o.field)).toEqual([
      'Note', 'UpdatedAt', 'Author', 'Confidence', 'NodeIdAtWrite',
    ]);
    const stored = readNodeKnowledge(fx.nodes['Cell/Axis1']);
    expect(stored?.Note).toBe('- backlash ~0.2deg');
    expect(stored?.Author).toBe('agent');
    expect(stored?.Confidence).toBe('observed');
    expect(stored?.NodeIdAtWrite).toBe('a1b2c3d4e5f60718');
    expect(Date.parse(stored!.UpdatedAt)).not.toBeNaN();
  });

  it('reports persistedTo "none" for a transient workspace, not "scene"', async () => {
    // The bug the first plan draft had: `available` is true here as well.
    const { target, ops } = transientEditTarget();
    expect(target.available).toBe(true);
    setActiveEditTarget(target);

    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', 'note'));
    expect(res.error).toBeUndefined();
    expect(res.persistedTo).toBe('none');
    expect(String(res.persistenceNote)).toContain('gone on reload');
    // Still WRITTEN — refusing the edit would make transient scenes unusable.
    expect(ops.length).toBeGreaterThan(0);
  });

  it('reports persistedTo "none" when no edit target is available', async () => {
    setActiveEditTarget(UNAVAILABLE);
    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', 'note'));
    expect(res.persistedTo).toBe('none');
  });

  it('reports persistedTo "asset" inside the asset editor', async () => {
    const { target } = assetEditTarget();
    setActiveEditTarget(target);
    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', 'note'));
    expect(res.persistedTo).toBe('asset');
    expect(String(res.persistenceNote)).toContain('web_editor_save');
  });

  it('still reports "asset" for an override that declares no persistsTo', async () => {
    // The REAL asset-editor target (`asset-editor/index.ts::_buildEditTarget`)
    // declares no `persistsTo` — production relies entirely on the documented
    // `?? 'asset'` fallback in `getActivePersistenceTarget()`. The fixture above
    // declares one, so without this case that fallback is unpinned and a future
    // change to it would break the asset editor with every test still green.
    const { target } = assetEditTarget();
    const withoutDeclaration = { ...target } as Record<string, unknown>;
    delete withoutDeclaration.persistsTo;
    setActiveEditTarget(withoutDeclaration as unknown as EditTarget);

    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', 'note'));
    expect(res.persistedTo).toBe('asset');
  });

  it('fails with an explicit error on an unknown node path, storing nothing (F10)', async () => {
    const { target, ops } = recordingEditTarget();
    setActiveEditTarget(target);

    const res = parse(await fx.tools.webKnowledgeSet('Cell/NoSuchNode', 'note'));
    expect(String(res.error)).toContain('Node not found');
    expect(ops).toEqual([]);
  });

  it('fails when updateOverlayField refuses (locked LayoutObject ancestor) (F10)', async () => {
    const { target } = recordingEditTarget();
    setActiveEditTarget(target);

    const res = parse(await fx.tools.webKnowledgeSet('Cell/Locked/Inner', 'note'));
    expect(String(res.error)).toContain('refused');
    expect(res.persistedTo).toBe('none');
    expect(readNodeKnowledge(fx.nodes['Cell/Locked/Inner'])).toBeNull();
  });

  it('rejects a note over MAX_NOTE_CHARS with an error, storing nothing (F6)', async () => {
    const { target, ops } = recordingEditTarget();
    setActiveEditTarget(target);

    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', 'x'.repeat(MAX_NOTE_CHARS + 1)));
    expect(String(res.error)).toContain(String(MAX_NOTE_CHARS));
    expect(res.chars).toBe(MAX_NOTE_CHARS + 1);
    expect(ops).toEqual([]);
    expect(readNodeKnowledge(fx.nodes['Cell/Axis1'])).toBeNull();
  });

  it('accepts a note of exactly MAX_NOTE_CHARS', async () => {
    setActiveEditTarget(recordingEditTarget().target);
    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', 'x'.repeat(MAX_NOTE_CHARS)));
    expect(res.error).toBeUndefined();
    expect(res.chars).toBe(MAX_NOTE_CHARS);
  });

  it('counts UTF-16 code units — 2001 astral emoji (4002 units) are rejected', async () => {
    setActiveEditTarget(recordingEditTarget().target);
    // 2001 visible characters, 4002 String.length. The documented convention:
    // the limit protects the GLB's JSON chunk, not a reading experience.
    const emoji = '\u{1F600}'.repeat(2001);
    expect(emoji.length).toBe(4002);
    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', emoji));
    expect(String(res.error)).toContain('4002');
  });

  it('overwrites rather than appending', async () => {
    setActiveEditTarget(recordingEditTarget().target);
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'first version');
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'second version');
    expect(readNodeKnowledge(fx.nodes['Cell/Axis1'])?.Note).toBe('second version');
  });

  it('records author and confidence when given, and narrows nonsense values', async () => {
    setActiveEditTarget(recordingEditTarget().target);
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'n', 'user', 'unverified');
    expect(readNodeKnowledge(fx.nodes['Cell/Axis1'])?.Author).toBe('user');
    expect(readNodeKnowledge(fx.nodes['Cell/Axis1'])?.Confidence).toBe('unverified');

    await fx.tools.webKnowledgeSet('Cell/Axis2', 'n', 'ceo', 'certain');
    expect(readNodeKnowledge(fx.nodes['Cell/Axis2'])?.Author).toBe('agent');
    expect(readNodeKnowledge(fx.nodes['Cell/Axis2'])?.Confidence).toBe('observed');
  });

  /**
   * plan-431 test 9.5b — the write path the inspector feature must NOT break.
   *
   * plan-431 makes the five NodeKnowledge fields non-editable in the inspector.
   * The obvious implementation, `readonly: true` in `NODE_KNOWLEDGE_SCHEMA`,
   * would have switched this tool off completely: `updateOverlayField` uses
   * `isFieldDisplayReadonly` — the very predicate that flag feeds — as a WRITE
   * guard, and the loop above pushes all five fields through it. Measured while
   * writing that plan: `readonly: true` on `Note` alone turned 20 of these tests
   * red with "[rvExtrasEditor] Refusing to edit readonly field".
   *
   * So read-only is done in the UI (a custom field renderer plus
   * `HIDDEN_FIELDS_PER_TYPE`) and this test states the other half of the deal
   * explicitly: every field still goes through, nothing is rejected, the note is
   * persisted. `field-descriptor-readonly` style unit checks would stay green if
   * someone broke `webKnowledgeSet`, the type normalisation or the persistence
   * report instead — this goes through the real tool.
   */
  it('accepts ALL FIVE field writes and reports them persisted (plan-431 §2.1)', async () => {
    const { target, ops } = assetEditTarget();
    setActiveEditTarget(target);

    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', '## still writable', 'user', 'inferred'));

    expect(res.error).toBeUndefined();
    expect(res.rejected).toBeUndefined();
    expect(res.persistedTo).toBe('asset');
    expect(ops.filter((o) => o.kind === 'setField').map((o) => o.field)).toEqual([
      'Note', 'UpdatedAt', 'Author', 'Confidence', 'NodeIdAtWrite',
    ]);

    const stored = readNodeKnowledge(fx.nodes['Cell/Axis1'])!;
    expect(stored.Note).toBe('## still writable');
    expect(stored.Author).toBe('user');
    expect(stored.Confidence).toBe('inferred');
  });

  it('keeps multi-line Markdown intact', async () => {
    setActiveEditTarget(recordingEditTarget().target);
    const note = '## Axis 1\n- one\n- two';
    await fx.tools.webKnowledgeSet('Cell/Axis1', note);
    expect(readNodeKnowledge(fx.nodes['Cell/Axis1'])?.Note).toBe(note);
  });
});

describe('web_knowledge_set — clearing (F7)', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => { setActiveEditTarget(null); });

  it('treats a whitespace-only note as empty and removes the entry', async () => {
    const { target, ops } = recordingEditTarget();
    setActiveEditTarget(target);
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'to be removed');
    ops.length = 0;

    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', '   \n\t  '));
    expect(res.removed).toBe(true);
    expect(res.chars).toBe(0);
    // No stub: the type hull is gone, not just the Note field. The scene store
    // has no removeComponent op, so this is one unsetField per present field —
    // `deleteUserDataField` only drops the hull when the LAST field goes.
    const rv = fx.nodes['Cell/Axis1'].userData.realvirtual as Record<string, unknown>;
    expect(NODE_KNOWLEDGE_TYPE in rv).toBe(false);
    expect(readNodeKnowledge(fx.nodes['Cell/Axis1'])).toBeNull();

    expect(ops.some((o) => o.kind.startsWith('transaction:'))).toBe(true);
    expect(ops.filter((o) => o.kind === 'unsetField').map((o) => o.field).sort()).toEqual(
      ['Author', 'Confidence', 'NodeIdAtWrite', 'Note', 'UpdatedAt'],
    );
  });

  it('uses the removeComponent op when the target has one (asset editor)', async () => {
    const { target, removed } = assetEditTarget();
    setActiveEditTarget(target);
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'to be removed');

    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', ''));
    expect(res.removed).toBe(true);
    expect(removed).toEqual([{ nodePath: 'Cell/Axis1', componentType: NODE_KNOWLEDGE_TYPE }]);
    expect(readNodeKnowledge(fx.nodes['Cell/Axis1'])).toBeNull();
  });

  it('says so plainly when there was nothing to remove', async () => {
    setActiveEditTarget(recordingEditTarget().target);
    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', ''));
    expect(res.error).toBeUndefined();
    expect(res.removed).toBe(false);
  });

  it('refuses to claim a removal with no edit target', async () => {
    // Seed through a working target, then take the document away.
    setActiveEditTarget(recordingEditTarget().target);
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'note');
    setActiveEditTarget(UNAVAILABLE);

    const res = parse(await fx.tools.webKnowledgeSet('Cell/Axis1', ''));
    expect(String(res.error)).toContain('cannot be removed');
    expect(readNodeKnowledge(fx.nodes['Cell/Axis1'])?.Note).toBe('note');
  });
});

describe('web_knowledge_get', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); setActiveEditTarget(recordingEditTarget().target); });
  afterEach(() => { setActiveEditTarget(null); });

  it('returns raw markdown, not a JSON-wrapped string (F2)', async () => {
    const note = '## Axis 1\n- backlash ~0.2deg\n- "quoted" & <angled>';
    await fx.tools.webKnowledgeSet('Cell/Axis1', note);

    const res = parse(await fx.tools.webKnowledgeGet('Cell/Axis1'));
    // Byte-identical, including the characters the PROMPT path neutralizes.
    // Sanitizing is a property of the prompt embedding, not of storage: a tool
    // handing an agent a mangled note would be handing it a wrong note.
    expect(res.markdown).toBe(note);
    expect(res.chars).toBe(note.length);
    expect(res.author).toBe('agent');
    expect(res.confidence).toBe('observed');
    expect(typeof res.updatedAt).toBe('string');
  });

  it('reads a note set in the same session, before any reload', async () => {
    // Guards the raw-userData read path. Going through the component registry
    // would answer "no note" here: NodeKnowledge registers no factory, so no
    // instance is ever created for it — not at load, and not on write.
    await fx.tools.webKnowledgeSet('Cell/Axis2', 'fresh in this session');
    const res = parse(await fx.tools.webKnowledgeGet('Cell/Axis2'));
    expect(res.markdown).toBe('fresh in this session');
  });

  it('distinguishes "unknown path" from "node has no note" (F11)', async () => {
    const unknown = parse(await fx.tools.webKnowledgeGet('Cell/NoSuchNode'));
    expect(String(unknown.error)).toContain('Node not found');
    expect(unknown.hasNote).toBeUndefined();

    const noNote = parse(await fx.tools.webKnowledgeGet('Cell/Axis1'));
    expect(String(noNote.error)).toContain('no knowledge note');
    expect(noNote.hasNote).toBe(false);
    // Two different next actions for the agent: fix the path vs. write the note.
    expect(noNote.error).not.toBe(unknown.error);
  });

  it('rejects an empty path instead of guessing', async () => {
    expect(String(parse(await fx.tools.webKnowledgeGet('')).error)).toContain('required');
  });

  it('reports a NodeId mismatch when the node was renumbered', async () => {
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'note');
    setNodeId(fx.nodes['Cell/Axis1'], 'ffffffffffffffff');   // as a re-import would
    const res = parse(await fx.tools.webKnowledgeGet('Cell/Axis1'));
    expect(res.nodeIdMismatch).toBe(true);
    expect(res.nodeIdAtWrite).toBe('a1b2c3d4e5f60718');
    expect(res.nodeIdNow).toBe('ffffffffffffffff');
  });

  it('reports NO mismatch for two placements sharing one NodeId — the documented blind spot', async () => {
    // Axis1 and Axis2 carry the same NodeId, because a NodeId is unique within a
    // FILE, not globally. The complete address would be `occurrence#nodeId`, but
    // rv-node-id.ts forbids writing the occurrence chain into a file. So this
    // check is knowingly weak, and this test pins that weakness as INTENDED —
    // absence of a mismatch is not evidence of identity.
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'note about axis 1');
    const res = parse(await fx.tools.webKnowledgeGet('Cell/Axis1'));
    expect(res.nodeIdMismatch).toBeUndefined();

    const foreign = readNodeKnowledge(fx.nodes['Cell/Axis1'])!;
    expect(foreign.NodeIdAtWrite).toBe('a1b2c3d4e5f60718');
    // Written on Axis1, indistinguishable from having been written on Axis2.
    expect(getNodeId(fx.nodes['Cell/Axis2'])).toBe(foreign.NodeIdAtWrite);
  });
});

describe('web_knowledge_list', () => {
  let fx: Fixture;
  beforeEach(() => { fx = makeFixture(); setActiveEditTarget(recordingEditTarget().target); });
  afterEach(() => { setActiveEditTarget(null); });

  it('lists nothing when no node carries a note', async () => {
    const res = parse(await fx.tools.webKnowledgeList());
    expect(res.total).toBe(0);
    expect(res.results).toEqual([]);
  });

  it('lists every annotated node with provenance', async () => {
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'about axis one', 'agent', 'observed');
    await fx.tools.webKnowledgeSet('Cell/Axis2', 'about axis two', 'user', 'inferred');

    const res = parse(await fx.tools.webKnowledgeList());
    expect(res.total).toBe(2);
    const rows = res.results as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.path).sort()).toEqual(['Cell/Axis1', 'Cell/Axis2']);
    const two = rows.find((r) => r.path === 'Cell/Axis2')!;
    expect(two.author).toBe('user');
    expect(two.confidence).toBe('inferred');
    expect(two.excerpt).toBe('about axis two');
    expect(two.chars).toBe('about axis two'.length);
    expect(two.truncated).toBeUndefined();
  });

  it('filters by query over note text AND node path', async () => {
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'hydraulic clamp, not a drive');
    await fx.tools.webKnowledgeSet('Cell/Axis2', 'plain rotary axis');

    const byText = parse(await fx.tools.webKnowledgeList('HYDRAULIC'));
    expect((byText.results as unknown[]).length).toBe(1);
    expect((byText.results as Array<{ path: string }>)[0].path).toBe('Cell/Axis1');

    const byPath = parse(await fx.tools.webKnowledgeList('axis2'));
    expect((byPath.results as Array<{ path: string }>)[0].path).toBe('Cell/Axis2');

    expect((parse(await fx.tools.webKnowledgeList('nothing matches')).results as unknown[]).length)
      .toBe(0);
  });

  it('caps with a truncated flag and keeps total honest', async () => {
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'one');
    await fx.tools.webKnowledgeSet('Cell/Axis2', 'two');

    const res = parse(await fx.tools.webKnowledgeList(undefined, 1));
    expect(res.total).toBe(2);           // what exists
    expect(res.truncated).toBe(true);    // said out loud
    expect((res.results as unknown[]).length).toBe(1);
  });

  it('marks a long note excerpt as truncated', async () => {
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'y'.repeat(400));
    const row = (parse(await fx.tools.webKnowledgeList()).results as Array<Record<string, unknown>>)[0];
    expect(row.truncated).toBe(true);
    expect((row.excerpt as string).length).toBeLessThan(400);
    expect(row.chars).toBe(400);         // the excerpt is short, the note is not
  });

  it('orders newest first', async () => {
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'older');
    // UpdatedAt is ISO with millisecond resolution; force a distinct stamp.
    const older = fx.nodes['Cell/Axis1'].userData.realvirtual as Record<string, Record<string, unknown>>;
    older[NODE_KNOWLEDGE_TYPE].UpdatedAt = '2020-01-01T00:00:00.000Z';
    await fx.tools.webKnowledgeSet('Cell/Axis2', 'newer');

    const rows = parse(await fx.tools.webKnowledgeList()).results as Array<{ path: string }>;
    expect(rows[0].path).toBe('Cell/Axis2');
  });

  it('skips an entry whose note is empty, so a husk never shows up as knowledge', async () => {
    fx.nodes['Cell/Axis1'].userData.realvirtual = {
      [NODE_KNOWLEDGE_TYPE]: { Note: '   ', UpdatedAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(parse(await fx.tools.webKnowledgeList()).total).toBe(0);
  });

  it('traverses a large tree within a sane time budget', async () => {
    // Grenzwert-Zeitmessung: the tool has no cache and traverses per call, so
    // the number worth knowing is what a CAD-sized assembly costs. The repo's
    // stress reference is a ~4500-node assembly.
    const root = fx.nodes['Cell'];
    for (let i = 0; i < 5000; i++) {
      const n = new Object3D();
      n.name = `Filler${i}`;
      root.add(n);
    }
    await fx.tools.webKnowledgeSet('Cell/Axis1', 'the only note');

    const t0 = performance.now();
    const res = parse(await fx.tools.webKnowledgeList());
    const elapsed = performance.now() - t0;
    expect(res.total).toBe(1);
    // Generous on purpose — this is a regression fence against an accidental
    // O(N^2), not a benchmark. Measured well under 50 ms locally.
    expect(elapsed).toBeLessThan(2000);
  });
});
