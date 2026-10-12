// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.6 — `web_project_list` / `web_project_open` on the LINKED list (plan-743).
 *
 * The contract an agent depends on is `slug`: prompts and workflows written
 * against `web_project_list` match on it, and the workspace engine that used to
 * derive it from the manifest is gone. It now comes off the stored row, so this
 * file pins that it is still there — and that neither tool ever spends a
 * permission prompt, because an MCP call has no user gesture to pay one with.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LinkedProjectEntry } from '../src/core/project/rv-project-linked';

// ─── Doubles ────────────────────────────────────────────────────────────

let LINKED: LinkedProjectEntry[] = [];
let OPEN: { id: string; name: string } | null = null;
let GRANTED = true;
const openedDirs: unknown[] = [];
const requestPermission = vi.fn();

vi.mock('../src/core/project/rv-project-linked', () => ({
  listLinkedProjects: async () => LINKED,
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getProject: () => OPEN,
    getBackend: () => ({ kind: 'folder', writable: true }),
    hasUnpersistedWork: () => false,
    rescanDocuments: async () => {},
    openProjectFolder: async (dir: unknown) => { openedDirs.push(dir); return true; },
  }),
}));

vi.mock('../src/core/engine/rv-local-filesystem', () => ({
  projectHandleKey: (id: string) => `projectfolder:${id}`,
  getFolderHandle: async (key: string, opts: { prompt?: boolean }) => {
    // The tools must never ask for a prompt; a spy on the option is the only
    // way to catch a regression that would hang the call on a browser dialog.
    if (opts?.prompt) requestPermission(key);
    return GRANTED ? ({ name: `dir-for-${key}` } as unknown) : null;
  },
}));

const entry = (over: Partial<LinkedProjectEntry> & { id: string }): LinkedProjectEntry => ({
  name: over.id,
  slug: over.id,
  folderName: over.id,
  linkedAt: '2025-01-01T00:00:00.000Z',
  ...over,
});

async function tools() {
  const { McpProjectTools } = await import('../src/plugins/mcp-bridge/rv-mcp-project-tools');
  return new McpProjectTools(() => undefined);
}

beforeEach(() => {
  LINKED = [];
  OPEN = null;
  GRANTED = true;
  openedDirs.length = 0;
  requestPermission.mockClear();
});

// ─── web_project_list ───────────────────────────────────────────────────

describe('web_project_list', () => {
  it('reports slug, name, folderName, id and current from the linked list', async () => {
    LINKED = [
      entry({ id: 'prj_a', name: 'Line A', slug: 'line-a', folderName: 'lineA' }),
      entry({ id: 'prj_b', name: 'Line B', slug: 'line-b', folderName: 'lineB' }),
    ];
    OPEN = { id: 'prj_b', name: 'Line B' };

    const json = JSON.parse(await (await tools()).webProjectList());

    expect(json.projects).toEqual([
      { slug: 'line-a', name: 'Line A', folderName: 'lineA', id: 'prj_a', current: false },
      { slug: 'line-b', name: 'Line B', folderName: 'lineB', id: 'prj_b', current: true },
    ]);
    expect(json.current).toMatchObject({ id: 'prj_b', name: 'Line B', writable: true });
  });

  it('never asks for a permission prompt', async () => {
    LINKED = [entry({ id: 'prj_a' })];
    await (await tools()).webProjectList();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('points an empty list at Add rather than at a workspace', async () => {
    const json = JSON.parse(await (await tools()).webProjectList());
    expect(json.projects).toEqual([]);
    expect(json.hint).toContain('Add');
    expect(json.hint.toLowerCase()).not.toContain('workspace');
  });
});

// ─── web_project_open ───────────────────────────────────────────────────

describe('web_project_open', () => {
  beforeEach(() => {
    LINKED = [entry({ id: 'prj_a', name: 'Line A', slug: 'line-a', folderName: 'line_A' })];
  });

  it.each([
    ['slug', 'line-a'],
    ['name', 'Line A'],
    ['folderName', 'line_A'],
    ['id', 'prj_a'],
  ])('matches on %s', async (_what, wanted) => {
    const json = JSON.parse(await (await tools()).webProjectOpen(wanted, false));
    expect(json.opened).toBe(true);
    expect(openedDirs).toHaveLength(1);
  });

  it('reports a lapsed grant as an actionable error and does not prompt', async () => {
    GRANTED = false;

    const json = JSON.parse(await (await tools()).webProjectOpen('line-a', false));

    expect(json.error).toContain('lapsed');
    expect(json.remedy).toContain('dashboard');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(openedDirs).toHaveLength(0);
  });

  it('names the linked list, not a workspace, when nothing matches', async () => {
    const json = JSON.parse(await (await tools()).webProjectOpen('nope', false));
    expect(json.error).toContain('linked project');
    expect(json.available).toEqual(['line-a']);
  });
});
