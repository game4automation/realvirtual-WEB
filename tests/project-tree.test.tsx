// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.14 — the project tree (plan-703 Phase 6, §2.6, §3.1, F11–F13).
 *
 * Takes the place of `projects-dashboard-store.test.ts` and
 * `dashboard-document-filter.test.tsx`, which go away with the tabs (A9). What
 * it pins is the five things the tree is FOR:
 *
 *  1. Several roots, one tree — the project and the catalogs as siblings, the
 *     catalogs marked.
 *  2. The System node: present, collapsed, and not restructurable.
 *  3. Inline rename on F2 (the one interaction this phase adds).
 *  4. Drag-and-drop between folders.
 *  5. A read-only catalog refusing both verbs.
 *
 * Renderer-free, after `hierarchy-virtualized.test.tsx`: real DOM through
 * Testing Library, no `WebGLRenderer`, no viewer.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectTree } from '../src/core/hmi/projects/ProjectTree';
import {
  RESERVED_SYSTEM_FOLDERS,
  SYSTEM_NODE_PATH,
  ancestorPathsOf,
  buildProjectTree,
  canMoveInTree,
  canRenameInTree,
  defaultExpandedPaths,
  findTreeNode,
  flattenProjectTree,
  folderContents,
  foldersOnlyTree,
  nearestFolderPath,
  isDocumentPath,
  isReservedSystemFolder,
  planTreeMove,
  walkProjectTree,
  type ProjectTreeNode,
  type ProjectTreeRootInput,
} from '../src/core/project/rv-project-tree';

// ─── Fixtures ────────────────────────────────────────────────────────────

const PROJECT_ROOT: ProjectTreeRootInput = {
  id: 'proj_myplant',
  name: 'MyPlant',
  kind: 'project',
  writable: true,
  files: [
    { path: 'machines/Filler.glb', documentId: 'doc_filler' },
    { path: 'machines/Capper.glb', documentId: 'doc_capper' },
    { path: 'parts/Roll2m.glb', documentId: 'doc_roll' },
    { path: 'docs/Module_A/4112630_BOM.pdf' },
    { path: 'settings/project-settings.json' },
    { path: 'thumbnails/Filler.png' },
    { path: '.trash/Old.glb' },
  ],
};

const READONLY_CATALOG: ProjectTreeRootInput = {
  id: 'cat_cloud',
  name: 'Component Cloud',
  kind: 'catalog',
  writable: false,
  remote: true,
  files: [{ path: 'conveyors/Belt.glb', documentId: 'cloud_belt' }],
};

const WRITABLE_CATALOG: ProjectTreeRootInput = {
  id: 'cat_local',
  name: 'Local library',
  kind: 'catalog',
  writable: true,
  files: [{ path: 'fixtures/Clamp.glb' }],
};

function tree(...roots: ProjectTreeRootInput[]): ProjectTreeNode[] {
  return buildProjectTree(roots.length > 0 ? roots : [PROJECT_ROOT, READONLY_CATALOG]);
}

function pathOf(roots: readonly ProjectTreeNode[], name: string): string {
  const hit = walkProjectTree(roots).find(n => n.name === name);
  if (!hit) throw new Error(`test fixture: no tree node named ${name}`);
  return hit.path!;
}

/** Render with everything expanded, so a row is reachable without clicking. */
function renderTree(
  roots: ProjectTreeNode[],
  props: Partial<React.ComponentProps<typeof ProjectTree>> = {},
) {
  return render(<ProjectTree roots={roots} height={800} {...props} />);
}

/** Expand every folder by clicking its caret — the tree opens roots only. */
async function expandAll(): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    const carets = screen.queryAllByLabelText('Expand');
    if (carets.length === 0) return;
    for (const caret of carets) fireEvent.click(caret);
    await waitFor(() => expect(screen.queryAllByRole('treeitem').length).toBeGreaterThan(0));
  }
}

afterEach(cleanup);

// ─── 1. Several roots, one tree ──────────────────────────────────────────

describe('§9.14 — one tree, several roots', () => {
  it('puts the project and the catalog side by side at depth 0', () => {
    const roots = tree();
    const rows = flattenProjectTree(roots, defaultExpandedPaths(roots));
    const topLevel = rows.filter(r => r.depth === 0);
    expect(topLevel.map(r => r.node.name)).toEqual(['MyPlant', 'Component Cloud']);
    expect(topLevel.map(r => r.node.rootKind)).toEqual(['project', 'catalog']);
  });

  it('marks the catalog root by icon, not by words', () => {
    // The "remote · read-only" caption is gone — the cloud icon carries the
    // origin, and the row's right-hand slot belongs to the library verbs
    // (`renderRootActions`). The distinction that remains testable is the
    // root-kind attribute the styling and the verbs key on.
    renderTree(tree());
    const project = document.querySelector('[data-path="proj_myplant"]')!;
    const catalog = document.querySelector('[data-path="cat_cloud"]')!;
    expect(project.getAttribute('data-root-kind')).toBe('project');
    expect(catalog.getAttribute('data-root-kind')).toBe('catalog');
    expect(catalog.querySelector('[data-catalog-badge]')).toBeNull();
  });

  it('keeps two catalogs holding the same relative path apart', () => {
    const a: ProjectTreeRootInput = { ...WRITABLE_CATALOG, id: 'cat_a', name: 'A' };
    const b: ProjectTreeRootInput = { ...WRITABLE_CATALOG, id: 'cat_b', name: 'B' };
    const roots = tree(a, b);
    const paths = walkProjectTree(roots).map(n => n.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('cat_a/fixtures/Clamp.glb');
    expect(paths).toContain('cat_b/fixtures/Clamp.glb');
  });

  it('opens with the roots expanded and nothing else', () => {
    const roots = tree();
    expect([...defaultExpandedPaths(roots)]).toEqual(['proj_myplant', 'cat_cloud']);
  });
});

// ─── 1b. Folders only (Lauf 13) ──────────────────────────────────────────

describe('Lauf 13 — the tree shows folders, nothing else', () => {
  it('renders no document and no attachment row', async () => {
    renderTree(tree(PROJECT_ROOT));
    await expandAll();
    const kinds = [...document.querySelectorAll('[role="treeitem"]')]
      .map(el => el.getAttribute('data-kind'));
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain('document');
    expect(kinds).not.toContain('file');
    // …and the folders that held them are all still there.
    expect(kinds.filter(k => k === 'folder').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-path="proj_myplant/machines"]')).not.toBeNull();
    expect(document.querySelector('[data-path="proj_myplant/parts/Roll2m.glb"]')).toBeNull();
  });

  it('keeps a folder whose only content is documents', async () => {
    renderTree(tree(PROJECT_ROOT));
    await expandAll();
    // `machines` holds two GLBs and no subfolder — it must not vanish with them.
    expect(document.querySelector('[data-path="proj_myplant/machines"]')).not.toBeNull();
  });

  it('prunes for rendering only — the model keeps every row', () => {
    const roots = tree(PROJECT_ROOT);
    const pruned = foldersOnlyTree(roots);
    expect(walkProjectTree(pruned).some(n => n.kind === 'document')).toBe(false);
    expect(walkProjectTree(roots).some(n => n.kind === 'document')).toBe(true);
    // The rules therefore still see the collision a pruned tree would miss.
    expect(canMoveInTree(roots, 'proj_myplant/parts/Roll2m.glb', 'proj_myplant/machines').ok)
      .toBe(true);
  });

  it('answers which folder a row belongs to', () => {
    const roots = tree(PROJECT_ROOT);
    // A folder and a root are their own folder…
    expect(nearestFolderPath(roots, 'proj_myplant/parts')).toBe('proj_myplant/parts');
    expect(nearestFolderPath(roots, 'proj_myplant')).toBe('proj_myplant');
    // …a document answers with its parent, so a card click never navigates.
    expect(nearestFolderPath(roots, 'proj_myplant/parts/Roll2m.glb')).toBe('proj_myplant/parts');
    expect(nearestFolderPath(roots, 'proj_myplant/nope')).toBeNull();
    expect(nearestFolderPath(roots, null)).toBeNull();
  });

  it('lists a folder\'s direct documents and attachments, and nothing deeper', () => {
    const roots = tree(PROJECT_ROOT);
    expect(folderContents(roots, 'proj_myplant/machines').map(n => n.name))
      .toEqual(['Capper.glb', 'Filler.glb']);
    // `docs` holds only the subfolder `Module_A` — its PDF belongs to that one.
    expect(folderContents(roots, 'proj_myplant/docs')).toEqual([]);
    expect(folderContents(roots, 'proj_myplant/docs/Module_A').map(n => n.name))
      .toEqual(['4112630_BOM.pdf']);
    expect(folderContents(roots, 'proj_myplant/nope')).toEqual([]);
  });
});

// ─── 2. The System node ──────────────────────────────────────────────────

describe('§9.14 — the System node', () => {
  it('gathers every reserved folder under ONE node', () => {
    const roots = tree(PROJECT_ROOT);
    const system = findTreeNode(roots, `proj_myplant/${SYSTEM_NODE_PATH}`)!;
    expect(system).not.toBeNull();
    expect(system.kind).toBe('system');
    expect(system.children.map(c => c.name).sort())
      .toEqual(['.trash', 'settings', 'thumbnails']);
    // …and none of them is a sibling of the content folders.
    const rootChildren = roots[0].children.map(c => c.name);
    expect(rootChildren).not.toContain('settings');
    expect(rootChildren).toContain('machines');
  });

  it('sorts System last, so it never sits between two content folders', () => {
    const roots = tree(PROJECT_ROOT);
    expect(roots[0].children.at(-1)!.kind).toBe('system');
  });

  it('is collapsed on open — it is machinery, not content', () => {
    const roots = tree(PROJECT_ROOT);
    const expanded = defaultExpandedPaths(roots);
    expect(expanded.has(`proj_myplant/${SYSTEM_NODE_PATH}`)).toBe(false);
    const rows = flattenProjectTree(roots, expanded);
    expect(rows.some(r => r.node.name === 'settings')).toBe(false);
  });

  it('is not restructurable, and neither is anything inside it', () => {
    const roots = tree(PROJECT_ROOT);
    const systemPath = `proj_myplant/${SYSTEM_NODE_PATH}`;
    const settings = findTreeNode(roots, 'proj_myplant/settings')!;
    expect(settings.writable).toBe(false);

    expect(canRenameInTree(roots, systemPath, 'Machinery'))
      .toEqual({ ok: false, reason: 'system' });
    expect(canRenameInTree(roots, 'proj_myplant/settings', 'config'))
      .toEqual({ ok: false, reason: 'read-only' });
    expect(canMoveInTree(roots, 'proj_myplant/settings', 'proj_myplant/machines'))
      .toEqual({ ok: false, reason: 'read-only' });
    // …and nothing may be dropped INTO it either.
    expect(canMoveInTree(roots, 'proj_myplant/parts/Roll2m.glb', systemPath))
      .toEqual({ ok: false, reason: 'system' });
  });

  it('does not appear at all for a root with no reserved folder', () => {
    const roots = tree(WRITABLE_CATALOG);
    expect(walkProjectTree(roots).some(n => n.kind === 'system')).toBe(false);
  });

  it('agrees with the reserved-folder list it is built from', () => {
    for (const name of RESERVED_SYSTEM_FOLDERS) expect(isReservedSystemFolder(name)).toBe(true);
    // The four folders decision 7 DEMOTED are ordinary again.
    for (const name of ['models', 'library', 'scenes', 'splats']) {
      expect(isReservedSystemFolder(name)).toBe(false);
    }
  });
});

// ─── 3. Inline rename (F2) ───────────────────────────────────────────────

// The three interaction cases moved from a GLB row to a FOLDER row in Lauf 13:
// documents are cards now, so F2-on-a-row is a promise about folders. The
// promise itself — an inline editor, Enter commits, Escape abandons, a rejected
// name keeps the editor open — is unchanged, and the card's own "Rename…" runs
// the same `canRenameInTree` (see `projects-folder-cards.test.tsx`).
describe('§9.14 — inline rename', () => {
  it('opens an editor on F2 and commits on Enter', async () => {
    const roots = tree(PROJECT_ROOT);
    const onRename = vi.fn();
    renderTree(roots, { onRename });
    await expandAll();

    const row = document.querySelector('[data-path="proj_myplant/parts"]')!;
    fireEvent.keyDown(row, { key: 'F2' });
    const input = await screen.findByLabelText('Rename');
    expect((input as HTMLInputElement).value).toBe('parts');

    fireEvent.change(input, { target: { value: 'components' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename.mock.calls[0][1]).toBe('components');
  });

  it('abandons the edit on Escape', async () => {
    const roots = tree(PROJECT_ROOT);
    const onRename = vi.fn();
    renderTree(roots, { onRename });
    await expandAll();

    const row = document.querySelector('[data-path="proj_myplant/parts"]')!;
    fireEvent.keyDown(row, { key: 'F2' });
    const input = await screen.findByLabelText('Rename');
    fireEvent.change(input, { target: { value: 'whatever' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRename).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText('Rename')).toBeNull());
  });

  it('keeps the editor open on a rejected name instead of committing it', async () => {
    const roots = tree(PROJECT_ROOT);
    const onRename = vi.fn();
    renderTree(roots, { onRename });
    await expandAll();

    const row = document.querySelector('[data-path="proj_myplant/parts"]')!;
    fireEvent.keyDown(row, { key: 'F2' });
    const input = await screen.findByLabelText('Rename');
    // A sibling folder already carries that name.
    fireEvent.change(input, { target: { value: 'machines' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Rename')).toBeTruthy();
  });

  it('refuses the names a file system cannot hold, and the empty one', () => {
    const roots = tree(PROJECT_ROOT);
    const path = 'proj_myplant/parts/Roll2m.glb';
    for (const bad of ['', '   ', '.', '..', 'a/b.glb', 'a\\b.glb', 'a:b', 'a?b']) {
      expect(canRenameInTree(roots, path, bad)).toEqual({ ok: false, reason: 'invalid-name' });
    }
    expect(canRenameInTree(roots, path, 'Roll2m.glb'))
      .toEqual({ ok: false, reason: 'unchanged' });
    expect(canRenameInTree(roots, path, 'Roll3m.glb'))
      .toEqual({ ok: true, from: 'parts/Roll2m.glb', to: 'parts/Roll3m.glb' });
  });

  it('restores the file extension a typed name dropped', () => {
    // Users naturally type the display name — "Roll3m", no ".glb". Committing
    // that verbatim renames the file out of every extension-filtered scan,
    // which reads as the asset being deleted. The gate restores the original
    // extension; a name that brings its OWN extension keeps it.
    const roots = tree(PROJECT_ROOT);
    const path = 'proj_myplant/parts/Roll2m.glb';
    expect(canRenameInTree(roots, path, 'Roll3m'))
      .toEqual({ ok: true, from: 'parts/Roll2m.glb', to: 'parts/Roll3m.glb' });
    expect(canRenameInTree(roots, path, 'Roll3m.gltf'))
      .toEqual({ ok: true, from: 'parts/Roll2m.glb', to: 'parts/Roll3m.gltf' });
    // The restored extension can land exactly on the current path — that is
    // "unchanged" at the level that matters, not a rename.
    expect(canRenameInTree(roots, path, 'Roll2m'))
      .toEqual({ ok: false, reason: 'unchanged' });
  });

  it('offers no F2 on a root or on System', async () => {
    const roots = tree(PROJECT_ROOT);
    renderTree(roots);
    for (const path of ['proj_myplant', `proj_myplant/${SYSTEM_NODE_PATH}`]) {
      fireEvent.keyDown(document.querySelector(`[data-path="${path}"]`)!, { key: 'F2' });
    }
    expect(screen.queryByLabelText('Rename')).toBeNull();
  });
});

// ─── 4. Drag and drop ────────────────────────────────────────────────────

describe('§9.14 — moving between folders', () => {
  /**
   * Drag `from` and drop it onto the middle of `to`'s row.
   *
   * A REAL `DataTransfer`: these tests run in Chromium, where `DragEvent`
   * refuses a plain object for the field — a stub would pass in jsdom and fail
   * here, which is the wrong way round for a drag test.
   */
  function drag(fromPath: string, toPath: string): void {
    const source = document.querySelector(`[data-path="${fromPath}"]`)!;
    const target = document.querySelector(`[data-path="${toPath}"]`)!;
    const dataTransfer = new DataTransfer();
    // Middle of the row = the `onto` zone (dropZoneFromPointer, 25%/50%/25%).
    target.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect;
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientY: 10 });
    fireEvent.drop(target, { dataTransfer, clientY: 10 });
  }

  /** Drop onto `to` a row that is being dragged from OUTSIDE the tree. */
  function dropExternal(toPath: string): void {
    const target = document.querySelector(`[data-path="${toPath}"]`)!;
    const dataTransfer = new DataTransfer();
    target.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect;
    fireEvent.dragOver(target, { dataTransfer, clientY: 10 });
    fireEvent.drop(target, { dataTransfer, clientY: 10 });
  }

  // A GLB is no longer a tree row (Lauf 13), so the drag that used to start on
  // one now starts on a card and reaches the tree through `externalDragPath`.
  // Same rules, same `onMove`, same destination — which is the point.
  it('moves a GLB dragged in from the card grid', async () => {
    const roots = tree(PROJECT_ROOT);
    const onMove = vi.fn();
    renderTree(roots, { onMove, externalDragPath: 'proj_myplant/parts/Roll2m.glb' });
    await expandAll();

    dropExternal('proj_myplant/machines');

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0].documentId).toBe('doc_roll');
    expect(onMove.mock.calls[0][1]).toBe('machines/Roll2m.glb');
  });

  it('refuses a card dragged into a read-only catalog', async () => {
    const roots = tree(PROJECT_ROOT, READONLY_CATALOG);
    const onMove = vi.fn();
    renderTree(roots, { onMove, externalDragPath: 'proj_myplant/parts/Roll2m.glb' });
    await expandAll();

    dropExternal('cat_cloud/conveyors');

    expect(onMove).not.toHaveBeenCalled();
  });

  it('moves a folder into another folder', async () => {
    const roots = tree(PROJECT_ROOT);
    const onMove = vi.fn();
    renderTree(roots, { onMove });
    await expandAll();

    drag('proj_myplant/docs/Module_A', 'proj_myplant/parts');

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][1]).toBe('parts/Module_A');
  });

  it('moves a non-GLB too — and says so, so the caller rewrites docs-index', () => {
    const roots = tree(PROJECT_ROOT);
    const pdf = 'proj_myplant/docs/Module_A/4112630_BOM.pdf';
    const verdict = canMoveInTree(roots, pdf, 'proj_myplant/parts');
    expect(verdict).toEqual({
      ok: true, from: 'docs/Module_A/4112630_BOM.pdf', to: 'parts/4112630_BOM.pdf',
    });
    const plan = planTreeMove(roots, pdf, verdict);
    expect(plan.rewritesDocsIndex).toBe(true);
    expect(plan.documentId).toBeUndefined();
  });

  it('carries a folder\'s contents with it, each keeping its position', () => {
    const roots = tree(PROJECT_ROOT);
    const verdict = canMoveInTree(roots, 'proj_myplant/docs/Module_A', 'proj_myplant/parts');
    expect(verdict.ok).toBe(true);
    const plan = planTreeMove(roots, 'proj_myplant/docs/Module_A', verdict);
    expect(plan.descendants).toEqual([{
      from: 'docs/Module_A/4112630_BOM.pdf',
      to: 'parts/Module_A/4112630_BOM.pdf',
      rewritesDocsIndex: true,
    }]);
  });

  it('refuses a folder into its own descendant', () => {
    const roots = tree(PROJECT_ROOT);
    expect(canMoveInTree(roots, 'proj_myplant/docs', 'proj_myplant/docs/Module_A'))
      .toEqual({ ok: false, reason: 'into-itself' });
    expect(canMoveInTree(roots, 'proj_myplant/docs', 'proj_myplant/docs'))
      .toEqual({ ok: false, reason: 'into-itself' });
  });

  it('refuses a move onto a taken name instead of shadowing it', () => {
    const roots = tree({
      ...PROJECT_ROOT,
      files: [
        ...PROJECT_ROOT.files,
        { path: 'machines/Roll2m.glb', documentId: 'doc_other' },
      ],
    });
    expect(canMoveInTree(roots, 'proj_myplant/parts/Roll2m.glb', 'proj_myplant/machines'))
      .toEqual({ ok: false, reason: 'name-taken' });
  });

  it('refuses a move that would cross from a project into a catalog', () => {
    const roots = tree(PROJECT_ROOT, WRITABLE_CATALOG);
    expect(canMoveInTree(roots, 'proj_myplant/parts/Roll2m.glb', 'cat_local/fixtures'))
      .toEqual({ ok: false, reason: 'cross-root' });
  });

  it('refuses a drop onto a file', () => {
    const roots = tree(PROJECT_ROOT);
    expect(canMoveInTree(
      roots, 'proj_myplant/parts/Roll2m.glb', 'proj_myplant/machines/Filler.glb',
    )).toEqual({ ok: false, reason: 'not-a-folder' });
  });

  it('can move to the root of its own tree', () => {
    const roots = tree(PROJECT_ROOT);
    expect(canMoveInTree(roots, 'proj_myplant/parts/Roll2m.glb', 'proj_myplant'))
      .toEqual({ ok: true, from: 'parts/Roll2m.glb', to: 'Roll2m.glb' });
  });
});

// ─── 5. A read-only catalog refuses both verbs ───────────────────────────

describe('§9.14 — a read-only catalog', () => {
  it('refuses a rename', () => {
    const roots = tree(READONLY_CATALOG);
    expect(canRenameInTree(roots, 'cat_cloud/conveyors/Belt.glb', 'Belt2.glb'))
      .toEqual({ ok: false, reason: 'read-only' });
  });

  it('refuses a move, in and out', () => {
    const roots = tree(READONLY_CATALOG);
    expect(canMoveInTree(roots, 'cat_cloud/conveyors/Belt.glb', 'cat_cloud'))
      .toEqual({ ok: false, reason: 'read-only' });
  });

  it('makes its rows undraggable, so the refusal is visible before the drag', () => {
    renderTree(tree(READONLY_CATALOG));
    const row = document.querySelector('[data-path="cat_cloud/conveyors"]')!;
    expect(row.getAttribute('draggable')).toBeNull();
  });

  it('offers no F2 on its rows', async () => {
    renderTree(tree(READONLY_CATALOG));
    await expandAll();
    fireEvent.keyDown(document.querySelector('[data-path="cat_cloud/conveyors"]')!, { key: 'F2' });
    expect(screen.queryByLabelText('Rename')).toBeNull();
  });

  it('a WRITABLE catalog is restructurable — read-only is the property, not the kind', () => {
    const roots = tree(WRITABLE_CATALOG);
    expect(canRenameInTree(roots, 'cat_local/fixtures/Clamp.glb', 'Clamp2.glb'))
      .toEqual({ ok: true, from: 'fixtures/Clamp.glb', to: 'fixtures/Clamp2.glb' });
  });
});

// ─── Model odds and ends ─────────────────────────────────────────────────

describe('§9.14 — the folder path is the category (decision 7)', () => {
  it('treats models/library/scenes/splats as ordinary folders', () => {
    const roots = tree({
      id: 'p', name: 'P', kind: 'project', writable: true,
      files: [{ path: 'models/A.glb' }, { path: 'scenes/B.glb' }, { path: 'anything/C.glb' }],
    });
    for (const folder of ['models', 'scenes', 'anything']) {
      const node = findTreeNode(roots, `p/${folder}`)!;
      expect(node.kind).toBe('folder');
      expect(node.writable).toBe(true);
    }
  });

  it('classifies assets by extension, not by folder', () => {
    expect(isDocumentPath('anything/C.glb')).toBe(true);
    expect(isDocumentPath('models/scan.ksplat')).toBe(true);
    expect(isDocumentPath('docs/BOM.pdf')).toBe(false);
    expect(isDocumentPath('README.md')).toBe(false);
  });

  it('reports the ancestors a reveal has to expand', () => {
    const roots = tree(PROJECT_ROOT);
    expect(ancestorPathsOf(roots, 'proj_myplant/docs/Module_A/4112630_BOM.pdf'))
      .toEqual(['proj_myplant', 'proj_myplant/docs', 'proj_myplant/docs/Module_A']);
  });

  it('finds nothing for a path that is not in the tree', () => {
    const roots = tree(PROJECT_ROOT);
    expect(findTreeNode(roots, 'proj_myplant/nope')).toBeNull();
    expect(canMoveInTree(roots, 'proj_myplant/nope', 'proj_myplant'))
      .toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses to plan a move from a refused verdict', () => {
    const roots = tree(PROJECT_ROOT);
    expect(() => planTreeMove(roots, pathOf(roots, 'Roll2m.glb'), { ok: false, reason: 'read-only' }))
      .toThrow(/refused edit/);
  });
});

// ─── Declared folders (empty folders) ────────────────────────────────────
//
// Every other folder in the tree is DERIVED from a file path, which is exactly
// why an empty one needed somewhere to be declared: `RvProject.folders` is that
// place, and `ProjectTreeRootInput.folders` carries it in.
describe('declared (empty) folders', () => {
  const withFolders = (...folders: string[]): ProjectTreeRootInput =>
    ({ ...PROJECT_ROOT, folders });

  it('creates a folder node that no file put there', () => {
    const roots = tree(withFolders('staging'));
    const node = findTreeNode(roots, 'proj_myplant/staging');
    expect(node?.kind).toBe('folder');
    expect(node?.children).toEqual([]);
  });

  it('creates the whole chain for a nested declaration', () => {
    const roots = tree(withFolders('a/b/c'));
    for (const p of ['proj_myplant/a', 'proj_myplant/a/b', 'proj_myplant/a/b/c']) {
      expect(findTreeNode(roots, p)?.kind).toBe('folder');
    }
    expect(findTreeNode(roots, 'proj_myplant/a/b/c')?.children).toEqual([]);
  });

  it('does not duplicate a folder that files already created', () => {
    const roots = tree(withFolders('machines'));
    const machines = findTreeNode(roots, 'proj_myplant/machines');
    // Still the ONE folder, still holding both GLBs — declaring it changes
    // nothing, which is what lets the two lists overlap freely.
    expect(machines?.children.map(c => c.name).sort()).toEqual(['Capper.glb', 'Filler.glb']);
    expect(findTreeNode(roots, 'proj_myplant')!.children
      .filter(c => c.name === 'machines')).toHaveLength(1);
  });

  it('sorts beside the derived folders rather than after them', () => {
    const roots = tree(withFolders('aaa', 'zzz'));
    const names = findTreeNode(roots, 'proj_myplant')!.children
      .filter(c => c.kind === 'folder').map(c => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain('aaa');
    expect(names).toContain('zzz');
  });

  it('is empty-folder shaped: nearestFolderPath resolves to itself', () => {
    const roots = tree(withFolders('staging'));
    expect(nearestFolderPath(roots, 'proj_myplant/staging')).toBe('proj_myplant/staging');
  });

  it('ignores junk entries instead of throwing', () => {
    const roots = tree(withFolders('', '   ', 'ok'));
    expect(findTreeNode(roots, 'proj_myplant/ok')?.kind).toBe('folder');
  });
});
