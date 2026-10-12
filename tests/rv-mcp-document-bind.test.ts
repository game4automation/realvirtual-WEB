// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 §9.8 / F9 — `web_document_bind`, the agent's route to the three refs.
 *
 * §9.8 as written only asks the two convention tests to keep counting. That
 * proves the tool is ANNOUNCED correctly and proves nothing about what it does,
 * which for a write tool is the half that matters — so the behaviour is pinned
 * here.
 *
 * The three contracts:
 *
 *  - the answer is read BACK out of the store, never echoed from the argument
 *    (the McpKnowledgeTools rule). A tool that reports its own intent will
 *    happily report a write that never landed;
 *  - every refusal is a JSON `error`, never a throw. A throw crosses the bridge
 *    as a stack trace, which an agent cannot act on;
 *  - the check ORDER is fixed — no project, then read-only, then not-found,
 *    then the field rule. Each question is only answerable once the one before
 *    it held, so a different order answers about the wrong problem.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── The store double ───────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string };

const state = {
  backend: null as null | {
    writable: boolean;
    listConnectConfigs?: () => Promise<string[]>;
    listKnowledgeFiles?: () => Promise<string[]>;
    listProjectScripts?: () => Promise<string[]>;
  },
  documents: [] as Row[],
  /** Set to make the next write throw, the way a bundled row makes it throw. */
  writeThrows: null as string | null,
  /** Set to make the write land nowhere — the case an echoing tool misreports. */
  writeDrops: false,
};

function writeRef(field: string, id: string, ref: string | null) {
  if (state.writeThrows) throw new Error(state.writeThrows);
  if (state.writeDrops) return;
  state.documents = state.documents.map((d) => {
    if (d.id !== id) return d;
    const { [field]: _gone, ...rest } = d;
    return (ref === null ? rest : { ...rest, [field]: ref }) as Row;
  });
}

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getBackend: () => state.backend,
    getProject: () => (state.backend ? { documents: state.documents } : null),
    getSnapshot: () => ({ documents: state.documents }),
    setDocumentConnectRef: async (id: string, ref: string | null) =>
      writeRef('connectRef', id, ref),
    setDocumentScriptRef: async (id: string, ref: string | null) =>
      writeRef('scriptRef', id, ref),
    setDocumentKnowledgeRef: async (id: string, ref: string | null) =>
      writeRef('knowledgeRef', id, ref),
  }),
}));

async function bind(document: string, field: string, ref?: string) {
  const { McpProjectTools } = await import('../src/plugins/mcp-bridge/rv-mcp-project-tools');
  const out = await new McpProjectTools(() => undefined).webDocumentBind(document, field, ref);
  return JSON.parse(out) as Record<string, unknown>;
}

beforeEach(() => {
  state.writeThrows = null;
  state.writeDrops = false;
  state.documents = [{
    id: 'd1', path: 'models/DemoRibbonTension.glb', name: 'DemoRibbonTension', tier: 'user',
  }];
  state.backend = {
    writable: true,
    listConnectConfigs: async () => ['connect/line1.connect.json'],
    listKnowledgeFiles: async () => ['notes.knowledge.md'],
    listProjectScripts: async () => ['plugins/ribbon-tension-controls-plugin.tsx'],
  };
});

// ─── The three fields ───────────────────────────────────────────────────

describe('plan-479 §9.8 — one tool binds and clears all three fields', () => {
  it('binds scriptRef and reports the state it read back', async () => {
    const out = await bind('DemoRibbonTension', 'scriptRef', 'plugins/ribbon-tension-controls-plugin.tsx');
    expect(out).toMatchObject({
      bound: true,
      documentId: 'd1',
      field: 'scriptRef',
      ref: 'plugins/ribbon-tension-controls-plugin.tsx',
      fileInProject: true,
    });
    expect(state.documents[0].scriptRef).toBe('plugins/ribbon-tension-controls-plugin.tsx');
  });

  it('binds connectRef and knowledgeRef through their short aliases', async () => {
    expect(await bind('d1', 'connect', 'connect/line1.connect.json'))
      .toMatchObject({ bound: true, field: 'connectRef' });
    expect(await bind('d1', 'knowledge', 'notes.knowledge.md'))
      .toMatchObject({ bound: true, field: 'knowledgeRef' });
    expect(state.documents[0]).toMatchObject({
      connectRef: 'connect/line1.connect.json',
      knowledgeRef: 'notes.knowledge.md',
    });
  });

  it('an empty ref clears the binding', async () => {
    await bind('d1', 'plugin', 'plugins/ribbon-tension-controls-plugin.tsx');
    const out = await bind('d1', 'plugin', '');
    expect(out).toMatchObject({ bound: false, ref: null });
    expect(state.documents[0].scriptRef).toBeUndefined();
    // An omitted ref means the same thing — the field is optional in the schema.
    await bind('d1', 'plugin', 'plugins/ribbon-tension-controls-plugin.tsx');
    expect((await bind('d1', 'plugin')).bound).toBe(false);
  });

  it('resolves the document by path and by id, not only by name', async () => {
    expect(await bind('models/DemoRibbonTension.glb', 'plugin', 'plugins/ribbon-tension-controls-plugin.tsx'))
      .toMatchObject({ documentId: 'd1' });
    expect(await bind('d1', 'plugin', '')).toMatchObject({ documentId: 'd1' });
  });
});

// ─── Read-back, not echo ────────────────────────────────────────────────

describe('plan-479 §9.8 — the answer comes from the store, not from the argument', () => {
  it('reports what the store holds even when the write did not take', async () => {
    // A store that quietly drops the write is exactly the case an echoing tool
    // would misreport as success. Nothing about the CALL differs — only the
    // state afterwards — so only a tool that re-reads can tell the difference.
    state.writeDrops = true;
    const out = await bind('d1', 'plugin', 'plugins/ribbon-tension-controls-plugin.tsx');
    expect(out).toMatchObject({ bound: false, ref: null });
  });

  it('says so when the bound file is not in the project', async () => {
    const out = await bind('d1', 'plugin', 'plugins/not-there.ts');
    expect(out).toMatchObject({ bound: true, fileInProject: false });
    expect(String(out.note)).toContain('missing reference');
  });

  it('leaves fileInProject unknown when the backend cannot list', async () => {
    state.backend = { writable: true };
    const out = await bind('d1', 'plugin', 'plugins/ribbon-tension-controls-plugin.tsx');
    expect(out).toMatchObject({ bound: true, fileInProject: null });
  });
});

// ─── Refusals: JSON errors, in order ────────────────────────────────────

describe('plan-479 §9.8 — every refusal is an answer, never a throw', () => {
  it('no project open comes before everything else', async () => {
    state.backend = null;
    const out = await bind('nonsense', 'nonsense', '../escape.ts');
    expect(String(out.error)).toContain('No project is open');
  });

  it('read-only comes before the not-found check', async () => {
    state.backend = { writable: false };
    const out = await bind('does-not-exist', 'plugin', 'plugins/x.ts');
    expect(String(out.error)).toContain('read-only');
  });

  it('an unknown field lists the ones that exist', async () => {
    const out = await bind('d1', 'pluginRef', 'plugins/x.ts');
    expect(String(out.error)).toContain('connectRef');
    expect(String(out.error)).toContain('knowledgeRef');
  });

  it('an unknown document names the tool that lists them', async () => {
    const out = await bind('Nope', 'plugin', 'plugins/x.ts');
    expect(String(out.error)).toContain('web_document_list');
  });

  it('a .ts outside plugins/ is refused WITH the rule (F8 for agents)', async () => {
    const out = await bind('d1', 'plugin', 'models/helper.ts');
    expect(String(out.error)).toContain('plugins/');
    expect(state.documents[0].scriptRef).toBeUndefined();
  });

  it('refuses a path the OTHER fields would not accept either', async () => {
    expect(String((await bind('d1', 'connect', 'connect/line1.json')).error))
      .toContain('.connect.json');
    expect(String((await bind('d1', 'knowledge', 'notes.txt')).error))
      .toContain('.md');
  });

  it('a containment escape is JSON, not a throw', async () => {
    // Asked on connectRef because it is the only field whose own rule lets a
    // `..` through: `isProjectScriptPath` already refuses one, which makes the
    // containment guard defence in depth for scriptRef and the FIRST line for
    // the other two.
    const out = await bind('d1', 'connect', '../shared/line1.connect.json');
    expect(String(out.error)).toContain('leaves the project');
    expect(state.documents[0].connectRef).toBeUndefined();
  });

  it('a throw from the store becomes the store\'s own sentence', async () => {
    state.writeThrows = '"DemoRibbonTension" is read-only — duplicate it into this project first.';
    const out = await bind('d1', 'plugin', 'plugins/ribbon-tension-controls-plugin.tsx');
    expect(String(out.error)).toContain('duplicate it into this project');
  });
});
