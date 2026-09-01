// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-450 — the HOST half of "Rename is a verb again".
 *
 * ## Why the host is reproduced instead of mounted
 *
 * `ProjectsDashboardHost.tsx` says so itself, at the import of
 * `dashboard-documents`: *"They live in their own module because this file
 * cannot be rendered by a test."* It pulls the project store, the library
 * registry, the scene store, the viewer and the private asset editor. So the
 * pattern of `projects-folder-cards.test.tsx` applies here too: the host's
 * WIRING is reproduced, and every RULE it consults is imported unchanged —
 * `buildDashboardTree`, `buildProjectTree`, `canRenameInTree`, `findTreeNode`,
 * `isRenamableInTree`. Nothing below re-implements a verdict.
 *
 * What that buys is the three things a pane test cannot reach:
 *
 *   - 9.1 the visibility MATRIX over the real selection kinds — the branch
 *     supplies `onRename` exactly when the selection may be renamed, and the
 *     pane's button follows it
 *   - 9.4 the refusal path, which lives entirely in the host: `onRename`
 *     returns `void`, so the pane never learns a verdict (§2.5)
 *   - 9.5 / 9.6 the F2 chain at the REAL focus path, through a real
 *     `ProjectTree`
 *
 * ## The one promise that does not hold
 *
 * 9.5 found F5 broken, and plan-450 §2.4's stop rule was followed: no second
 * F2 handler was built. F2 opens an editor for a FOLDER and not for a library
 * ASSET, because the tree draws folders only and the editor is a row. The test
 * is kept, marked `it.fails`, with the diagnosis beside it — see §9.5 below.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { useMemo, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
// `vitest/browser`, not the `@vitest/browser/context` the two MCP suites still
// import: vitest 4 deprecates that path and prints a warning per file that uses
// it. The real (CDP-driven) click is the point — a synthetic `fireEvent.click`
// moves focus nowhere, and focus is exactly what §9.5 is about.
import { userEvent } from 'vitest/browser';
import { ProjectsDetailPane, type DetailAction } from '../src/core/hmi/projects/ProjectsDetailPane';
import { ProjectTree } from '../src/core/hmi/projects/ProjectTree';
import {
  ProjectFolderContents,
  type FolderCardModel,
} from '../src/core/hmi/projects/ProjectFolderContents';
import {
  buildDashboardTree,
  type CatalogRootInput,
} from '../src/core/project/rv-project-tree-sources';
import {
  buildProjectTree,
  canRenameInTree,
  findTreeNode,
  folderContents,
  isRenamableInTree,
  nearestFolderPath,
  type ProjectTreeNode,
} from '../src/core/project/rv-project-tree';

// ─── The world the host would be looking at ──────────────────────────────

const PROJECT_ID = 'proj_myplant';
const LIBRARY_FOLDER = 'library';

const DOCUMENTS = [
  { id: 'doc_filler', path: 'machines/Filler.glb', name: 'Filler' },
  { id: 'doc_belt', path: `${LIBRARY_FOLDER}/Belt.glb`, name: 'Belt' },
  { id: 'doc_roll', path: `${LIBRARY_FOLDER}/Roll2m.glb`, name: 'Roll2m' },
];

/** An attached, read-only catalog — the second `ProjectTree`'s content. */
const CLOUD: CatalogRootInput = {
  providerId: 'core',
  sourceId: 'cloud',
  label: 'Component Cloud',
  // False for EVERY catalog root, whatever the source says — see the host's
  // `catalogRoots` memo. It is what makes `canRenameInTree` refuse the row.
  writable: false,
  remote: true,
  entries: [{ assetId: 'cloud:clamp', name: 'Clamp', path: 'fixtures/Clamp.glb' }],
};

const WORLD = buildDashboardTree({
  project: {
    id: PROJECT_ID,
    name: 'MyPlant',
    writable: true,
    documents: DOCUMENTS,
    attachments: [],
  },
  catalogs: [CLOUD],
});
const ROOTS = buildProjectTree(WORLD.roots);
const PROJECT_ROOTS = ROOTS.filter(r => r.rootKind !== 'catalog');
const LIBRARY_ROOTS = ROOTS.filter(r => r.rootKind === 'catalog');

// ─── The host's selection model, reproduced ──────────────────────────────

type Selection =
  | { kind: 'none' }
  | { kind: 'document'; documentId: string }
  | { kind: 'documentPath'; path: string }
  | { kind: 'asset'; providerId: string; sourceId: string; assetId: string }
  | { kind: 'folder'; rootId: string; relPath: string };

/**
 * `ProjectsDashboardHost.tsx:1756-1781`, verbatim in behaviour.
 *
 * Derived from the selection rather than stored beside it — which is exactly
 * why the branch can ask it and get `null` for a selection the tree does not
 * hold, the case 9.1 carries as its own row.
 */
function selectedTreePathFor(sel: Selection): string | null {
  if (sel.kind === 'folder') {
    return sel.relPath === '' ? sel.rootId : `${sel.rootId}/${sel.relPath}`;
  }
  for (const [path, ref] of WORLD.refs) {
    if (sel.kind === 'asset' && ref.kind === 'catalogAsset'
      && ref.providerId === sel.providerId && ref.sourceId === sel.sourceId
      && ref.assetId === sel.assetId) return path;
    if (sel.kind === 'documentPath' && ref.kind === 'document' && ref.path === sel.path) return path;
    if (sel.kind === 'document' && ref.kind === 'document'
      && ref.documentId === sel.documentId) return path;
  }
  return null;
}

// ─── The three branches that decide `onRename` ───────────────────────────

interface HostSeams {
  setMessage: (text: string) => void;
  runTreeEdit: (label: string, node: ProjectTreeNode, to: string) => void;
  /** The scene-row commit — the host's `renameDocumentRow`. */
  renameDocumentRow: (id: string, name: string) => void;
  /** No scene store attached (`!sceneStore` in the host). */
  noSceneStore?: boolean;
}

const NO_SEAMS: HostSeams = {
  setMessage: () => {},
  runTreeEdit: () => {},
  renameDocumentRow: () => {},
};

/**
 * `renameLibraryAsset` (`ProjectsDashboardHost.tsx:2364-2395`), reproduced.
 *
 * The extension restore, the missing-node report and the verdict report are the
 * three things 9.4 is about, and all three live here rather than in the pane.
 */
function renameLibraryAsset(relPath: string, rawName: string, seams: HostSeams): void {
  let fileName = rawName.trim();
  if (!fileName) return;
  const dot = relPath.lastIndexOf('.');
  const ext = dot > 0 ? relPath.slice(dot) : '';
  if (ext && !/\.[a-z0-9]+$/i.test(fileName)) fileName += ext;

  const treePath = `${PROJECT_ID}/${LIBRARY_FOLDER}/${relPath}`;
  const node = findTreeNode(ROOTS, treePath);
  if (!node) {
    seams.setMessage(`Rename refused: "${relPath}" is not part of this project's tree.`);
    return;
  }
  const verdict = canRenameInTree(ROOTS, treePath, fileName);
  if (!verdict.ok) {
    if (verdict.reason !== 'unchanged') seams.setMessage(`Rename refused: ${verdict.reason}.`);
    return;
  }
  seams.runTreeEdit('Rename asset', node, verdict.to);
}

/** The `documentPath` branch's `onRename` (`…Host.tsx:2827-2840`), reproduced. */
function renameDocumentPath(path: string, name: string, seams: HostSeams): void {
  const treePath = selectedTreePathFor({ kind: 'documentPath', path });
  if (!treePath) return;
  const node = findTreeNode(ROOTS, treePath);
  if (!node) return;
  const verdict = canRenameInTree(ROOTS, treePath, name);
  if (!verdict.ok) {
    if (verdict.reason !== 'unchanged') seams.setMessage(`Rename refused: ${verdict.reason}.`);
    return;
  }
  seams.runTreeEdit('Rename', node, verdict.to);
}

/**
 * A selection's detail-pane model — the `onRename` half of the host's
 * `detail` memo, branch for branch.
 *
 * Only the fields plan-450 turns on: the title, the actions (so 9.1 also sees
 * the insertion point in a real action list) and the rename commit.
 */
interface PaneCase {
  /** What the user picked. */
  sel: Selection;
  /** Bundled sample / published example — the read-only marks the host reads. */
  bundled?: boolean;
  /** Library-asset case: is the source writable, and does it resolve a path? */
  assetWritable?: boolean;
  assetLocalPath?: string | null;
}

function detailModelFor(c: PaneCase, seams: HostSeams = NO_SEAMS): {
  title: string | null;
  actions: DetailAction[];
  onRename?: (next: string) => void;
} {
  const sel = c.sel;
  const open: DetailAction = { key: 'open', label: 'Open', primary: true, onClick: () => {} };

  // ── a scene row, selected by manifest id (…Host.tsx:2711-2755) ──
  if (sel.kind === 'document') {
    const doc = DOCUMENTS.find(d => d.id === sel.documentId);
    if (!doc) return { title: null, actions: [] };
    return {
      title: doc.name,
      actions: c.bundled
        ? [open, { key: 'dup', label: 'Duplicate to this project', onClick: () => {} }]
        : [open, { key: 'dup', label: 'Duplicate', onClick: () => {} }],
      ...(c.bundled || seams.noSceneStore
        ? {}
        : { onRename: (name: string) => seams.renameDocumentRow(doc.id, name) }),
    };
  }

  // ── a document addressed by PATH (…Host.tsx:2758-2841) ──
  if (sel.kind === 'documentPath') {
    const published = sel.path.startsWith('published:');
    const readOnly = published || c.bundled === true;
    const treePath = selectedTreePathFor(sel);
    return {
      title: (sel.path.split('/').pop() ?? sel.path).replace(/\.glb$/i, ''),
      actions: [open],
      ...(readOnly || !treePath
        ? {}
        : { onRename: (name: string) => renameDocumentPath(sel.path, name, seams) }),
    };
  }

  // ── a library asset (…Host.tsx:2844-2873) ──
  if (sel.kind === 'asset') {
    const writable = c.assetWritable ?? false;
    return {
      title: 'Belt',
      actions: [{ key: 'edit', label: writable ? 'Edit' : 'Edit a copy', primary: true, onClick: () => {} }],
      ...(() => {
        if (!writable || sel.providerId !== 'project-library') return {};
        // `libraryRelPathOf` — three lines, private to the host.
        const p = c.assetLocalPath ?? null;
        const relPath = !p
          ? null
          : p.startsWith(`${LIBRARY_FOLDER}/`) ? p.slice(LIBRARY_FOLDER.length + 1) : p;
        return relPath
          ? { onRename: (name: string) => renameLibraryAsset(relPath, name, seams) }
          : {};
      })(),
    };
  }

  return { title: null, actions: [] };
}

function renderPane(c: PaneCase, seams: HostSeams = NO_SEAMS) {
  return render(<ProjectsDetailPane {...detailModelFor(c, seams)} />);
}

/** Does the rendered pane offer the Rename verb? */
function offersRename(): boolean {
  return screen.queryByRole('button', { name: 'Rename' }) !== null;
}

afterEach(cleanup);

// ─── 9.1 — the visibility matrix ─────────────────────────────────────────

describe('plan-450 §9.1 — Rename appears exactly where the branch grants it', () => {
  /** [what was selected, may it be renamed] — the host's real branches. */
  const MATRIX: Array<[string, PaneCase, boolean]> = [
    ['a writable scene row', { sel: { kind: 'document', documentId: 'doc_filler' } }, true],
    ['a bundled scene row', { sel: { kind: 'document', documentId: 'doc_filler' }, bundled: true }, false],
    ['a writable documentPath in the tree',
      { sel: { kind: 'documentPath', path: 'machines/Filler.glb' } }, true],
    ['a published example',
      { sel: { kind: 'documentPath', path: 'published:demo' } }, false],
    ['a bundled documentPath',
      { sel: { kind: 'documentPath', path: 'machines/Filler.glb' }, bundled: true }, false],
    ['a documentPath the tree does not hold',
      { sel: { kind: 'documentPath', path: 'nowhere/Ghost.glb' } }, false],
    ['a writable project-library asset', {
      sel: { kind: 'asset', providerId: 'project-library', sourceId: PROJECT_ID, assetId: 'project:Belt.glb' },
      assetWritable: true,
      assetLocalPath: `${LIBRARY_FOLDER}/Belt.glb`,
    }, true],
    ['a read-only project-library asset', {
      sel: { kind: 'asset', providerId: 'project-library', sourceId: PROJECT_ID, assetId: 'project:Belt.glb' },
      assetWritable: false,
      assetLocalPath: `${LIBRARY_FOLDER}/Belt.glb`,
    }, false],
    ['an asset of somebody else\'s provider', {
      sel: { kind: 'asset', providerId: 'core', sourceId: 'cloud', assetId: 'cloud:clamp' },
      assetWritable: true,
      assetLocalPath: 'fixtures/Clamp.glb',
    }, false],
    ['an asset with no resolvable path', {
      sel: { kind: 'asset', providerId: 'project-library', sourceId: PROJECT_ID, assetId: 'project:Belt.glb' },
      assetWritable: true,
      assetLocalPath: null,
    }, false],
    ['nothing at all', { sel: { kind: 'none' } }, false],
  ];

  for (const [what, c, expected] of MATRIX) {
    it(`${expected ? 'offers' : 'withholds'} Rename for ${what}`, () => {
      renderPane(c);
      expect(offersRename()).toBe(expected);
      // …and the branch and the button agree, which is the whole claim: the
      // button is derived from `onRename`, never restated beside it.
      expect(detailModelFor(c).onRename !== undefined).toBe(expected);
    });
  }

  it('withholds it from a scene when no scene store is attached', () => {
    // `!sceneStore` in the host: there is nowhere to write the new name, so the
    // verb is absent rather than a button that fails on the click.
    const seams: HostSeams = { ...NO_SEAMS, noSceneStore: true };
    renderPane({ sel: { kind: 'document', documentId: 'doc_filler' } }, seams);
    expect(offersRename()).toBe(false);
  });

  it('places it after the primary verb in a real action list', () => {
    renderPane({ sel: { kind: 'document', documentId: 'doc_filler' } });
    expect(screen.getAllByRole('button').map(b => b.textContent))
      .toEqual(['Open', 'Rename', 'Duplicate']);
  });

  it('leaves a read-only selection its way forward instead of a dead button', () => {
    renderPane({ sel: { kind: 'document', documentId: 'doc_filler' }, bundled: true });
    expect(screen.getAllByRole('button').map(b => b.textContent))
      .toEqual(['Open', 'Duplicate to this project']);
  });
});

// ─── 9.4 — a refused rename reports, and changes nothing ─────────────────

describe('plan-450 §9.4 — the refusal lives in the host', () => {
  /** Type `name` into the pane's editor and press Enter. */
  function commit(name: string): void {
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Rename');
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  const LIBRARY_ASSET: PaneCase = {
    sel: { kind: 'asset', providerId: 'project-library', sourceId: PROJECT_ID, assetId: 'project:Belt.glb' },
    assetWritable: true,
    assetLocalPath: `${LIBRARY_FOLDER}/Belt.glb`,
  };
  const DOCUMENT_PATH: PaneCase = { sel: { kind: 'documentPath', path: `${LIBRARY_FOLDER}/Belt.glb` } };

  it('reports an illegal name through `renameLibraryAsset` and writes nothing', async () => {
    const setMessage = vi.fn();
    const runTreeEdit = vi.fn();
    renderPane(LIBRARY_ASSET, { ...NO_SEAMS, setMessage, runTreeEdit });
    commit('a/b.glb');

    expect(setMessage).toHaveBeenCalledWith('Rename refused: invalid-name.');
    expect(runTreeEdit).not.toHaveBeenCalled();
    // The name is untouched — the pane closed its editor and put the old title
    // back, because the commit never reached the write path.
    await waitFor(() => expect(screen.getByText('Belt')).toBeTruthy());
  });

  it('reports a taken name through `renameLibraryAsset` and writes nothing', async () => {
    const setMessage = vi.fn();
    const runTreeEdit = vi.fn();
    renderPane(LIBRARY_ASSET, { ...NO_SEAMS, setMessage, runTreeEdit });
    commit('Roll2m.glb');                        // the sibling already has it

    expect(setMessage).toHaveBeenCalledWith('Rename refused: name-taken.');
    expect(runTreeEdit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Belt')).toBeTruthy());
  });

  it('reports an illegal name through `runTreeEdit`\'s branch and writes nothing', async () => {
    const setMessage = vi.fn();
    const runTreeEdit = vi.fn();
    renderPane(DOCUMENT_PATH, { ...NO_SEAMS, setMessage, runTreeEdit });
    commit('a?b.glb');

    expect(setMessage).toHaveBeenCalledWith('Rename refused: invalid-name.');
    expect(runTreeEdit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Belt')).toBeTruthy());
  });

  it('reports a taken name through `runTreeEdit`\'s branch and writes nothing', async () => {
    const setMessage = vi.fn();
    const runTreeEdit = vi.fn();
    renderPane(DOCUMENT_PATH, { ...NO_SEAMS, setMessage, runTreeEdit });
    commit('Roll2m.glb');

    expect(setMessage).toHaveBeenCalledWith('Rename refused: name-taken.');
    expect(runTreeEdit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Belt')).toBeTruthy());
  });

  it('says nothing at all when the name is merely unchanged', () => {
    // `unchanged` is the user pressing Enter on the name that is already there.
    // A snackbar for that would be noise, and the pane's own trim already
    // swallows the identical string — this covers the spelling that survives
    // it: "Belt" grows back to "Belt.glb" inside `renameLibraryAsset`.
    const setMessage = vi.fn();
    const runTreeEdit = vi.fn();
    renderPane(LIBRARY_ASSET, { ...NO_SEAMS, setMessage, runTreeEdit });
    commit('Belt');

    expect(setMessage).not.toHaveBeenCalled();
    expect(runTreeEdit).not.toHaveBeenCalled();
  });

  it('reports a row the tree does not hold rather than renaming bytes', () => {
    const setMessage = vi.fn();
    const runTreeEdit = vi.fn();
    renameLibraryAsset('Ghost.glb', 'Other.glb', { ...NO_SEAMS, setMessage, runTreeEdit });
    expect(setMessage).toHaveBeenCalledWith(
      'Rename refused: "Ghost.glb" is not part of this project\'s tree.');
    expect(runTreeEdit).not.toHaveBeenCalled();
  });

  it('commits an accepted name — the refusal path is not the only path', () => {
    const setMessage = vi.fn();
    const runTreeEdit = vi.fn();
    renderPane(LIBRARY_ASSET, { ...NO_SEAMS, setMessage, runTreeEdit });
    commit('Belt 2');

    expect(setMessage).not.toHaveBeenCalled();
    expect(runTreeEdit).toHaveBeenCalledTimes(1);
    // The extension the user did not type is restored before the write.
    expect(runTreeEdit.mock.calls[0][2]).toBe(`${LIBRARY_FOLDER}/Belt 2.glb`);
  });
});

// ─── 9.5 / 9.6 — F2 at the real focus path ───────────────────────────────

/**
 * The two trees and the card grid, wired the way the host wires them.
 *
 * The panel really is two `ProjectTree` instances side by side (the project and
 * the attached libraries, `…Host.tsx:3354` and `:3391`) with the card grid in
 * a SIBLING column. That geometry is the point of 9.6: the grid is not inside
 * either tree, and neither tree is inside the other.
 */
function Panel({ initial = null }: { initial?: string | null }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(initial);
  const folderPath = nearestFolderPath(ROOTS, selectedPath);
  const cards: FolderCardModel[] = useMemo(() => folderContents(ROOTS, folderPath).map(node => ({
    key: node.path!,
    entry: { id: node.path!, name: node.name, category: 'custom' as const },
    tier: 'user' as const,
    selected: selectedPath === node.path,
    onSelect: () => setSelectedPath(node.path!),
    onOpen: () => {},
  })), [folderPath, selectedPath]);

  return (
    <div>
      <ProjectTree
        roots={PROJECT_ROOTS}
        height={300}
        selectedPath={selectedPath}
        onSelect={(n) => setSelectedPath(n.path!)}
      />
      <ProjectTree
        roots={LIBRARY_ROOTS}
        height={300}
        selectedPath={selectedPath}
        onSelect={(n) => setSelectedPath(n.path!)}
      />
      <ProjectFolderContents cards={cards} />
    </div>
  );
}

describe('plan-450 §9.5 — F2 on a library asset, at the real focus path', () => {
  it('a real click inside the tree puts focus where the handler can hear it', async () => {
    // The premise of the chain (`ProjectTree.tsx:562-568`): the keydown handler
    // sits on the CONTAINER, because a row cannot hold one that fires. A real
    // click focuses the row itself (`tabIndex={-1}` is focusable by mouse in
    // Chromium, which the comment there does not say) — either way the event
    // bubbles to the container, and either way `document.activeElement` is
    // inside this tree and not in the other one. A synthetic `fireEvent.click`
    // would move focus nowhere at all, which is why this one is real.
    render(<Panel />);
    const [projectTree, libraryTree] = screen.getAllByRole('tree');
    await userEvent.click(document.querySelector(`[data-path="${PROJECT_ID}/${LIBRARY_FOLDER}"]`)!);
    await waitFor(() => expect(projectTree.contains(document.activeElement)).toBe(true));
    expect(libraryTree.contains(document.activeElement)).toBe(false);
  });

  it('resolves the selected library asset to a renamable tree node', () => {
    // The model half of the chain, independent of any event: the asset the user
    // picked in the grid IS a row of the project tree, and the rule accepts it.
    const path = `${PROJECT_ID}/${LIBRARY_FOLDER}/Belt.glb`;
    expect(findTreeNode(ROOTS, path)).not.toBeNull();
    expect(isRenamableInTree(ROOTS, path)).toBe(true);
    // …while an asset of a read-only catalog is refused, which is the control:
    // it resolves to a node and still gets no editor.
    expect(isRenamableInTree(ROOTS, 'core:cloud/fixtures/Clamp.glb')).toBe(false);
  });

  /**
   * **F5 does not hold, and this is where plan-450 Phase 2 stopped.**
   *
   * `it.fails` on purpose: the assertion below is F5 spelled out, it is the
   * right assertion, and it does not pass. Flipping it to
   * `expect(...).toBeNull()` would turn a broken promise into a documented
   * feature; deleting it would lose the finding. Marked failing instead, so the
   * day the gap is closed THIS test turns red and asks to be un-marked.
   *
   * The chain is intact up to the last step — the next test proves each link —
   * and breaks at the rendering: `ProjectTree` flattens
   * `foldersOnlyTree(roots)` (`ProjectTree.tsx:444`), so a document/asset node
   * has no row. `startRename(node)` duly sets `renamingPath` to a path no
   * rendered row matches, and the `InputBase` that carries `aria-label="Rename"`
   * (`ProjectTree.tsx:343-347`) is never mounted. F2 on a FOLDER works, which is
   * why this went unnoticed.
   *
   * plan-450 §2.4's stop rule applies: no second F2 handler was built. The fix
   * is a decision about where a card's inline editor lives, and that is a plan,
   * not a patch.
   */
  it.fails('opens the rename editor for the selected library ASSET (F5 — NOT met)', async () => {
    // The selection is the asset (a card click made it); the focus is put into
    // the tree by clicking its empty space, which is the one click that focuses
    // without also re-selecting. Then F2, at whatever really has focus.
    render(<Panel initial={`${PROJECT_ID}/${LIBRARY_FOLDER}/Belt.glb`} />);
    const [projectTree] = screen.getAllByRole('tree');
    await userEvent.click(projectTree);
    await waitFor(() => expect(document.activeElement).toBe(projectTree));

    fireEvent.keyDown(document.activeElement!, { key: 'F2' });
    expect(await screen.findByLabelText('Rename')).toBeTruthy();
  });

  it('…because the tree renders no row for an asset, though every rule accepts it', async () => {
    // The diagnosis behind the failure above, link by link, so the next reader
    // does not have to re-derive it.
    const assetPath = `${PROJECT_ID}/${LIBRARY_FOLDER}/Belt.glb`;
    render(<Panel initial={assetPath} />);

    // 1. the model accepts the row …
    expect(isRenamableInTree(ROOTS, assetPath)).toBe(true);
    // 2. … and the folder that holds it IS drawn …
    expect(document.querySelector(`[data-path="${PROJECT_ID}/${LIBRARY_FOLDER}"]`)).not.toBeNull();
    // 3. … but the asset itself is not a row, because the tree draws folders only.
    expect(document.querySelector(`[data-path="${assetPath}"]`)).toBeNull();
    // 4. so the handler runs, sets `renamingPath`, and there is nothing to host
    //    the editor — the failure is in the rendering, not in the focus chain.
    const [projectTree] = screen.getAllByRole('tree');
    await userEvent.click(projectTree);
    fireEvent.keyDown(document.activeElement!, { key: 'F2' });
    expect(screen.queryByLabelText('Rename')).toBeNull();
  });

  it('opens it for a FOLDER the same way', async () => {
    render(<Panel initial={`${PROJECT_ID}/${LIBRARY_FOLDER}`} />);
    const [projectTree] = screen.getAllByRole('tree');
    await userEvent.click(projectTree);
    fireEvent.keyDown(document.activeElement!, { key: 'F2' });
    expect(await screen.findByLabelText('Rename')).toBeTruthy();
  });

  it('leaves a read-only catalog asset without an editor — the plan\'s non-goal', async () => {
    render(<Panel initial="core:cloud/fixtures/Clamp.glb" />);
    const [, libraryTree] = screen.getAllByRole('tree');
    await userEvent.click(libraryTree);
    fireEvent.keyDown(document.activeElement!, { key: 'F2' });
    expect(screen.queryByLabelText('Rename')).toBeNull();
  });
});

describe('plan-450 §9.6 — only the focused tree instance answers F2', () => {
  it('opens exactly ONE editor with both trees mounted', async () => {
    render(<Panel initial={`${PROJECT_ID}/${LIBRARY_FOLDER}`} />);
    expect(screen.getAllByRole('tree')).toHaveLength(2);

    await userEvent.click(document.querySelector(`[data-path="${PROJECT_ID}/${LIBRARY_FOLDER}"]`)!);
    fireEvent.keyDown(document.activeElement!, { key: 'F2' });

    // Both instances hold a handler and both are looking at the same
    // `selectedPath`; only the focused one gets the event.
    await waitFor(() => expect(screen.getAllByLabelText('Rename')).toHaveLength(1));
  });

  it('the OTHER instance stays silent though it is given the same selection', async () => {
    render(<Panel initial={`${PROJECT_ID}/${LIBRARY_FOLDER}`} />);
    const [projectTree, libraryTree] = screen.getAllByRole('tree');
    // Focus the LIBRARY tree without touching the selection — its empty space.
    await userEvent.click(libraryTree);
    await waitFor(() => expect(document.activeElement).toBe(libraryTree));

    fireEvent.keyDown(document.activeElement!, { key: 'F2' });
    // It is handed the very same `selectedPath` the project tree has, and its
    // handler runs — `findTreeNode` over ITS roots answers null, so nothing
    // opens. Not in it, and not in the instance that was never focused.
    expect(screen.queryByLabelText('Rename')).toBeNull();
    expect(projectTree.querySelector('[data-rename-input]')).toBeNull();
  });
});
