// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectTree — the FOLDER tree of the dashboard
 * (plan-703 Phase 6, §2.6, §3.1, F11–F13; folders-only since Lauf 13).
 *
 * ## Folders here, assets on cards beside it
 *
 * Since Lauf 13 this renders the Unity project-window left half: `root`,
 * `folder` and `system` rows only. Documents and attachments are cards in
 * {@link ProjectFolderContents}, which is what "one tree" was always trying to
 * be — a hundred parts as a hundred tree leaves is a list, not a structure.
 *
 * The pruning happens **here, at render time**, never in the model: `roots`
 * arrives complete and every rule (`canMoveInTree`, `canRenameInTree`, and the
 * host's `planTreeMove`) keeps running against it. A pruned model would refuse
 * to see the document a move would collide with, and would plan a folder move
 * with no descendants in it.
 *
 * ## Why this is its own component and not `rv-hierarchy-browser`
 *
 * The plan's own finding, verified: `rv-hierarchy-browser.tsx` is 1125 lines
 * bound to the signal store, the logic engine and a live `RVViewer`. None of
 * those exist on the projects screen. What IS reused is everything below the
 * top level — `dropZoneFromPointer` and `rowDomId` from `HierarchyNodeRow`,
 * `flattenVisibleTree` (through `flattenProjectTree`) from `hierarchy-utils`,
 * and `@tanstack/react-virtual`. So the tree behaves like the scene hierarchy
 * because it literally shares the code that makes it behave that way.
 *
 * `TreeNodeRow` itself is NOT reused: it renders component badges, a step-state
 * dot and an eye toggle, none of which a file has, and it has no inline rename —
 * which is the one genuinely new interaction of this phase (§3.4, F2).
 *
 * ## Every refusal is visible before the drop
 *
 * `canMoveInTree` runs on drag-over, not on drop. A read-only catalog therefore
 * never paints an insertion line, so "this cannot be dropped here" is answered
 * by the absence of an affordance rather than by an error afterwards.
 *
 * ## Presentation only
 *
 * It owns expansion and the rename buffer. It owns no data: the tree comes in as
 * a prop and every accepted edit leaves through `onMove` / `onRename`. That is
 * what keeps the rules in `rv-project-tree.ts`, where §9.14 can reach them.
 */

import { useCallback, useMemo, useRef, useState, memo } from 'react';
import { Box, IconButton, InputBase, Tooltip, Typography } from '@mui/material';
import {
  ChevronRight,
  CloudOutlined,
  ExpandMore,
  Folder,
  FolderOutlined,
  InsertDriveFileOutlined,
  LockOutlined,
  PublicOutlined,
  SettingsOutlined,
  ViewInArOutlined,
} from '@mui/icons-material';
import { useVirtualizer } from '@tanstack/react-virtual';
import { dropZoneFromPointer, rowDomId, type DropZone } from '../HierarchyNodeRow';
import {
  canMoveInTree,
  canRenameInTree,
  defaultExpandedPaths,
  findTreeNode,
  flattenProjectTree,
  foldersOnlyTree,
  isRenamableInTree,
  type ProjectTreeNode,
  type ProjectTreeRow,
} from '../../project/rv-project-tree';

/** Row height, matching the scene hierarchy's fine-pointer density. */
export const PROJECT_TREE_ROW_HEIGHT = 22;

/**
 * Blank space a library row carries above itself, in pixels.
 *
 * The seam needs room on both sides or it reads as an underline of the row
 * above rather than a break between two trees. The space is part of the row —
 * the virtualizer measures it (see `estimateSize`), so scroll maths, the drop
 * geometry and the row rectangle all stay in agreement, which a margin between
 * absolutely-positioned rows could not do.
 */
const LIBRARY_GAP = 12;

/** Drag-insertion accent — the same Instrument Blue the scene hierarchy uses. */
const DND_ACCENT = '79, 195, 247';

/** MIME-ish key for the internal drag payload. */
const DRAG_TYPE = 'application/x-rv-project-tree';

export interface ProjectTreeProps {
  roots: readonly ProjectTreeNode[];
  selectedPath?: string | null;
  /**
   * The folder the selection LIVES IN, marked as the current place.
   *
   * Since documents left the tree, selecting an asset happens in the card grid
   * and the tree had nothing to show for it — the folder whose contents you are
   * looking at looked exactly like every other folder. This is deliberately a
   * second, quieter state than `selectedPath`: the selection is one row, the
   * place is the row containing it. When the selection IS a folder both point
   * at the same row and the selected fill wins.
   */
  containingFolderPath?: string | null;
  onSelect?: (node: ProjectTreeNode) => void;
  /** Double-click, i.e. "open this". */
  onActivate?: (node: ProjectTreeNode) => void;
  /**
   * Right-click on a row. The tree reports WHERE, the host decides what.
   *
   * Same division as {@link renderRootActions}: the tree knows rows, the host
   * knows verbs. It also selects the row first, so the menu and the rest of
   * the screen can never describe two different places.
   */
  onContextMenu?: (node: ProjectTreeNode, e: React.MouseEvent) => void;
  /** An accepted drop. `to` is the destination path INSIDE the node's root. */
  onMove?: (node: ProjectTreeNode, to: string) => void;
  /** An accepted rename. `to` is the new path inside the root. */
  onRename?: (node: ProjectTreeNode, to: string) => void;
  /**
   * Tree path of a row being dragged from OUTSIDE the tree — a card in the
   * folder-contents grid (plan-703 Lauf 13).
   *
   * The tree is the only drop target for a move, but since documents left the
   * tree it is no longer the only drag *source*. Rather than teach the grid the
   * move rules a second time, the host reports which card is in flight and the
   * tree treats it exactly like one of its own rows: same `canMoveInTree` on
   * drag-over, same insertion affordance, same `onMove`.
   */
  externalDragPath?: string | null;
  /**
   * Height of the scroll viewport. A number for a fixed pane, `'100%'` to fill
   * a flex parent that already has a definite height — the virtualizer needs a
   * bounded scroll element either way, so `'auto'` is not an option.
   */
  height?: number | string;
  /**
   * Right-hand controls on a CATALOG ROOT row (refresh, remove).
   *
   * A render prop rather than baked-in verbs: the tree knows rows, the host
   * knows library sources. Controls must stop their own click propagation so
   * pressing one does not also select the row. Keep the returned nodes small —
   * the row is {@link PROJECT_TREE_ROW_HEIGHT}px tall.
   */
  renderRootActions?: (node: ProjectTreeNode) => React.ReactNode;
}

// ─── Row ────────────────────────────────────────────────────────────────

function KindIcon({ node }: { node: ProjectTreeNode }) {
  const sx = { fontSize: 14, flexShrink: 0, mr: 0.5, color: 'rgba(255,255,255,0.5)' };
  // `hasContent` where the projection recorded it, `children` otherwise. The
  // rendered tree is folders-only, so counting its children would call a folder
  // holding a single GLB empty — documents are exactly what got pruned.
  const holdsSomething = node.hasContent ?? node.children.length > 0;
  if (node.kind === 'system') return <SettingsOutlined sx={sx} />;
  if (node.kind === 'root') {
    // The project root is a folder too, and follows the same filled/outlined
    // rule — an empty project showing the same icon as its full folders was
    // the inconsistency that made the rule worth having.
    if (node.rootKind !== 'catalog') {
      return holdsSomething ? <Folder sx={sx} /> : <FolderOutlined sx={sx} />;
    }
    // A cloud for what lives in the cloud, a globe for the rest. `remote` is
    // the flag the badge beside the row already says out loud, so icon and
    // wording cannot drift apart: a library reachable only over the network
    // gets the cloud, a local folder keeps the globe.
    return node.remote ? <CloudOutlined sx={sx} /> : <PublicOutlined sx={sx} />;
  }
  // Filled means "holds something", outlined means empty — the same icon in
  // both states, so the difference reads as a property of the folder rather
  // than as two kinds of thing. Weight carries it; nothing here depends on
  // colour alone (DESIGN.md).
  if (node.kind === 'folder') {
    return holdsSomething ? <Folder sx={sx} /> : <FolderOutlined sx={sx} />;
  }
  if (node.kind === 'document') return <ViewInArOutlined sx={sx} />;
  return <InsertDriveFileOutlined sx={sx} />;
}

interface RowProps {
  row: ProjectTreeRow;
  expanded: boolean;
  selected: boolean;
  containsSelection: boolean;
  renaming: boolean;
  renameError: boolean;
  dropZone: DropZone | null;
  virtualStyle: React.CSSProperties;
  onToggleExpand: (path: string) => void;
  onSelect: (node: ProjectTreeNode) => void;
  onActivate: (node: ProjectTreeNode) => void;
  onContextMenu: ((node: ProjectTreeNode, e: React.MouseEvent) => void) | undefined;
  onStartRename: (node: ProjectTreeNode) => void;
  onCommitRename: (node: ProjectTreeNode, value: string) => void;
  onCancelRename: () => void;
  onDragStart: (node: ProjectTreeNode, e: React.DragEvent) => void;
  onDragOver: (node: ProjectTreeNode, e: React.DragEvent) => void;
  onDrop: (node: ProjectTreeNode, e: React.DragEvent) => void;
  onDragEnd: () => void;
  renderRootActions?: ((node: ProjectTreeNode) => React.ReactNode) | undefined;
}

const ProjectTreeRowView = memo(function ProjectTreeRowView({
  row, expanded, selected, containsSelection, renaming, renameError, dropZone, virtualStyle,
  onToggleExpand, onSelect, onActivate, onContextMenu, onStartRename, onCommitRename, onCancelRename,
  onDragStart, onDragOver, onDrop, onDragEnd, renderRootActions,
}: RowProps) {
  const node = row.node;
  const path = node.path!;
  const hasChildren = node.children.length > 0;
  const isCatalogRoot = node.kind === 'root' && node.rootKind === 'catalog';
  // The seam and its gap separate one library from what sits ABOVE it, so the
  // very first row has nothing to separate from — and since the libraries got
  // their own header, drawing it there would put a second rule directly under
  // the header's own. Kept apart from `isCatalogRoot`, which still decides the
  // row's weight, colour and verbs: this is only about the divider.
  const drawsSeam = isCatalogRoot && !(row.depth === 0 && row.posInSet === 1);
  // A root, the System node, everything inside a read-only catalog and every
  // INERT full-view row (plan-445 F2) refuse both verbs. Checked here only to
  // decide what to RENDER — the authority is `canMoveInTree` /
  // `canRenameInTree`, which run again before anything commits. `inert` has to
  // be part of it and not only part of the context menu: without it F2 still
  // opened an inline editor on a plain file and the row was still a drag
  // source, both of which then failed at the commit instead of never offering.
  const editable = node.writable && !node.inert
    && node.kind !== 'root' && node.kind !== 'system';

  // A top-level row sits on a band a shade darker than the panel — the project
  // and each attached library. With the seam above it and its own icon, that is
  // what makes one flat list read as several trees. Selection and the drop
  // states still win: they are about what you are doing now, the band is about
  // where you are.
  // The containing folder sits between the band and the selection at a third
  // of the selected alpha: present enough to find the place at a glance, quiet
  // enough that it is never mistaken for the selection itself.
  const restFill = dropZone === 'onto'
    ? `rgba(${DND_ACCENT}, 0.22)`
    : selected ? `rgba(${DND_ACCENT}, 0.15)`
      : containsSelection ? `rgba(${DND_ACCENT}, 0.05)`
        : node.kind === 'root' ? 'rgba(0,0,0,0.13)' : 'transparent';
  const hoverFill = selected ? `rgba(${DND_ACCENT}, 0.2)`
    : containsSelection ? `rgba(${DND_ACCENT}, 0.1)`
      : node.kind === 'root' ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
  // On a library row the fill starts BELOW the gap, so the seam keeps clear
  // space on both sides instead of sitting inside the band. One background
  // property rather than a second element — the row already carries a
  // pseudo-element for the seam itself.
  const fillFrom = (colour: string) => (drawsSeam
    ? `linear-gradient(to bottom, transparent 0 ${LIBRARY_GAP}px, ${colour} ${LIBRARY_GAP}px 100%)`
    : colour);

  return (
    <Box
      id={rowDomId(path)}
      data-path={path}
      data-kind={node.kind}
      data-writable={node.writable || undefined}
      data-root-kind={node.rootKind ?? undefined}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-selected={selected}
      aria-expanded={hasChildren ? expanded : undefined}
      tabIndex={-1}
      style={virtualStyle}
      draggable={editable || undefined}
      onDragStart={editable ? (e) => onDragStart(node, e) : undefined}
      onDragOver={(e) => onDragOver(node, e)}
      onDrop={(e) => onDrop(node, e)}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(node)}
      onDoubleClick={(e) => { e.stopPropagation(); onActivate(node); }}
      // Select first, then open the menu: a right-click that left the previous
      // selection standing would offer verbs for one row while the rest of the
      // screen still describes another.
      onContextMenu={onContextMenu
        ? (e) => { e.preventDefault(); e.stopPropagation(); onSelect(node); onContextMenu(node, e); }
        : undefined}
      onKeyDown={(e) => {
        if (e.key === 'F2' && editable) { e.preventDefault(); onStartRename(node); }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        pl: row.depth * 1 + 0.5,
        pr: 1,
        cursor: 'pointer',
        userSelect: 'none',
        borderRadius: '2px',
        minWidth: 0,
        // The gap belongs to the row, so the content sits below it.
        pt: drawsSeam ? `${LIBRARY_GAP}px` : 0,
        background: fillFrom(restFill),
        boxShadow: dropZone === 'before'
          ? `inset 0 2px 0 0 rgba(${DND_ACCENT}, 0.95)`
          : dropZone === 'after'
            ? `inset 0 -2px 0 0 rgba(${DND_ACCENT}, 0.95)`
            : dropZone === 'onto'
              ? `inset 0 0 0 1px rgba(${DND_ACCENT}, 0.7)`
              : 'none',
        // Hover lifts a root off its own band rather than off the panel, so the
        // feedback stays equally visible on both kinds of row.
        '&:hover': { background: fillFrom(hoverFill) },
        // Every attached library opens with a seam: it separates the first one
        // from the project AND each library from the one above it, which a
        // single rule under the project did not. Centred in the gap the row
        // reserves for it, so it has clear space above and below.
        ...(drawsSeam && {
          '&::before': {
            content: '""',
            position: 'absolute',
            left: 4,
            right: 8,
            top: `${Math.round(LIBRARY_GAP / 2)}px`,
            height: '1px',
            bgcolor: 'rgba(255,255,255,0.12)',
          },
        }),
      }}
    >
      {hasChildren ? (
        <IconButton
          size="small"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={(e) => { e.stopPropagation(); onToggleExpand(path); }}
          sx={{ p: 0, mr: 0.25, color: 'rgba(255,255,255,0.7)' }}
        >
          {expanded ? <ExpandMore sx={{ fontSize: 14 }} /> : <ChevronRight sx={{ fontSize: 14 }} />}
        </IconButton>
      ) : (
        <Box sx={{ width: 16, flexShrink: 0 }} />
      )}

      <KindIcon node={node} />

      {renaming ? (
        <InputBase
          autoFocus
          defaultValue={node.name}
          inputProps={{ 'aria-label': 'Rename', 'data-rename-input': path }}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => onCommitRename(node, e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onCommitRename(node, (e.target as HTMLInputElement).value);
            if (e.key === 'Escape') onCancelRename();
          }}
          sx={{
            flex: 1,
            fontSize: 12,
            color: 'rgba(255,255,255,0.92)',
            bgcolor: 'rgba(255,255,255,0.06)',
            borderRadius: '2px',
            px: 0.5,
            // The one place a rejected name shows: amber, plus the name simply
            // does not commit. Colour alone is never the message (DESIGN.md).
            outline: renameError ? '1px solid #ffa726' : 'none',
            '& input': { p: 0, height: 18 },
          }}
        />
      ) : (
        <Tooltip title={node.relPath || node.name} placement="right" enterDelay={500}>
          <Typography
            sx={{
              fontSize: 12,
              lineHeight: 1.3,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              // A catalog root is a root, but not THE root. It keeps the weight
              // of a top-level row and loses a little contrast, so the project
              // stays the one thing the eye lands on first — the third cue
              // beside the rule above it and its own icon.
              // The containing folder carries the weight but not the accent —
              // fill plus weight say "you are here", colour stays reserved for
              // the selection so the two never read as the same state.
              fontWeight: node.kind === 'root' || selected || containsSelection ? 600 : 400,
              color: node.kind === 'system'
                ? 'rgba(255,255,255,0.5)'
                : selected ? '#4fc3f7'
                  : isCatalogRoot ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.92)',
            }}
          >
            {node.name}
          </Typography>
        </Tooltip>
      )}

      {/* A read-only catalog says so with a padlock rather than with the word
          "read-only": the row is 22px tall and the words crowded out the verbs
          that used to live beside them. The tooltip carries the sentence
          (plan-445 F6) — colour alone is never the message (DESIGN.md). */}
      {isCatalogRoot && !node.writable && (
        <Tooltip title={`${node.name} — read-only`} placement="top">
          <LockOutlined
            data-testid={`project-tree-lock-${path}`}
            aria-label={`${node.name} — read-only`}
            sx={{ fontSize: 12, flexShrink: 0, ml: 0.5, color: 'rgba(255,255,255,0.45)' }}
          />
        </Tooltip>
      )}
      {/* The origin words ("remote · read-only") are gone — the cloud icon
          already says remote, and the row's verbs sit here instead. */}
      {isCatalogRoot && renderRootActions?.(node)}
    </Box>
  );
});

// ─── Tree ───────────────────────────────────────────────────────────────

export function ProjectTree({
  roots,
  selectedPath = null,
  containingFolderPath = null,
  onSelect,
  onActivate,
  onContextMenu,
  onMove,
  onRename,
  height = 480,
  externalDragPath = null,
  renderRootActions,
}: ProjectTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpandedPaths(roots));
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameError, setRenameError] = useState(false);
  const [ownDragPath, setOwnDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ path: string; zone: DropZone } | null>(null);

  /**
   * Folders only (Lauf 13). `roots` stays the FULL tree and every rule below
   * still runs against it — the projection is what gets flattened and drawn,
   * nothing more. See {@link foldersOnlyTree} for why the rules may not use it.
   */
  const folderRoots = useMemo(() => foldersOnlyTree(roots), [roots]);

  /** The row in flight, whichever side of the split it started on. */
  const dragPath = ownDragPath ?? externalDragPath;

  const rows = useMemo(() => flattenProjectTree(folderRoots, expanded), [folderRoots, expanded]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const node = rows[index]?.node;
      return node?.kind === 'root' && node.rootKind === 'catalog'
        ? PROJECT_TREE_ROW_HEIGHT + LIBRARY_GAP
        : PROJECT_TREE_ROW_HEIGHT;
    },
    getItemKey: (index) => rows[index]?.rowKey ?? index,
    overscan: 12,
  });

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const handleSelect = useCallback((node: ProjectTreeNode) => {
    setRenamingPath(null);
    onSelect?.(node);
  }, [onSelect]);

  const handleActivate = useCallback((node: ProjectTreeNode) => {
    if (node.children.length > 0) toggleExpand(node.path!);
    onActivate?.(node);
  }, [onActivate, toggleExpand]);

  const startRename = useCallback((node: ProjectTreeNode) => {
    setRenameError(false);
    setRenamingPath(node.path!);
  }, []);

  const cancelRename = useCallback(() => {
    setRenameError(false);
    setRenamingPath(null);
  }, []);

  const commitRename = useCallback((node: ProjectTreeNode, value: string) => {
    const verdict = canRenameInTree(roots, node.path!, value);
    if (!verdict.ok) {
      // `unchanged` is not an error — it is the user pressing Enter on the name
      // that is already there, which must close the editor quietly.
      if (verdict.reason === 'unchanged') { cancelRename(); return; }
      setRenameError(true);
      return;
    }
    setRenameError(false);
    setRenamingPath(null);
    onRename?.(node, verdict.to);
  }, [roots, onRename, cancelRename]);

  const handleDragStart = useCallback((node: ProjectTreeNode, e: React.DragEvent) => {
    setOwnDragPath(node.path!);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData(DRAG_TYPE, node.path!); } catch { /* jsdom / old Safari */ }
  }, []);

  /**
   * A drop lands in a FOLDER, so the three zones collapse to two questions:
   * `onto` a folder means "into it", anything else means "next to the hovered
   * row", i.e. into that row's parent. Reordering inside a folder is not a
   * thing — the tree sorts folders-then-name, so a manual order would be a
   * fourth sort key nobody asked for.
   */
  const resolveDropFolder = useCallback((node: ProjectTreeNode, zone: DropZone): string | null => {
    if (zone === 'onto' && (node.kind === 'folder' || node.kind === 'root')) return node.path!;
    const parent = rowsParentPath(rows, node);
    return parent;
  }, [rows]);

  const handleDragOver = useCallback((node: ProjectTreeNode, e: React.DragEvent) => {
    if (!dragPath) return;
    const zone = dropZoneFromPointer(e);
    const folder = resolveDropFolder(node, zone);
    if (!folder) { setDropTarget(null); return; }
    // The refusal happens HERE, before any affordance is painted.
    if (!canMoveInTree(roots, dragPath, folder).ok) { setDropTarget(null); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ path: node.path!, zone });
  }, [dragPath, resolveDropFolder, roots]);

  const handleDrop = useCallback((node: ProjectTreeNode, e: React.DragEvent) => {
    e.preventDefault();
    const source = dragPath;
    setDropTarget(null);
    setOwnDragPath(null);
    if (!source) return;
    const folder = resolveDropFolder(node, dropZoneFromPointer(e));
    if (!folder) return;
    const verdict = canMoveInTree(roots, source, folder);
    if (!verdict.ok) return;
    // Looked up in the FULL tree, not in `rows`: a card's node is not a row.
    const moved = findTreeNode(roots, source);
    if (moved) onMove?.(moved, verdict.to);
  }, [dragPath, resolveDropFolder, roots, onMove]);

  const handleDragEnd = useCallback(() => {
    setOwnDragPath(null);
    setDropTarget(null);
  }, []);

  return (
    <Box
      ref={scrollRef}
      role="tree"
      aria-label="Project tree"
      tabIndex={0}
      // F2 belongs HERE, not on the row. Rows are `tabIndex={-1}` and nothing
      // focuses them, so a keydown handler on a row can never fire — clicking a
      // row focuses this container (the nearest focusable ancestor) and every
      // key lands here. The row's own handler stayed unreachable, which is why
      // renaming from the tree looked unimplemented while all of its machinery
      // was already in place.
      onKeyDown={(e) => {
        if (e.key !== 'F2' || renamingPath) return;
        // The keyboard route asks the model, not the row: the selection can be
        // a CARD (a document, an inert plain file) that this tree never
        // rendered, so a check copied off the row would not cover it.
        if (!selectedPath || !isRenamableInTree(roots, selectedPath)) return;
        const node = findTreeNode(roots, selectedPath);
        if (!node) return;
        e.preventDefault();
        startRename(node);
      }}
      sx={{ height, overflow: 'auto', position: 'relative', outline: 'none' }}
    >
      <Box sx={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const path = row.node.path!;
          return (
            <ProjectTreeRowView
              key={row.rowKey}
              row={row}
              expanded={expanded.has(path)}
              selected={selectedPath === path}
              // Never both: a selected folder is its own place, and marking it
              // twice would only dilute what the quieter state means.
              containsSelection={containingFolderPath === path && selectedPath !== path}
              renaming={renamingPath === path}
              renameError={renamingPath === path && renameError}
              dropZone={dropTarget?.path === path ? dropTarget.zone : null}
              virtualStyle={{
                position: 'absolute',
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
              onToggleExpand={toggleExpand}
              onSelect={handleSelect}
              onActivate={handleActivate}
              onContextMenu={onContextMenu}
              onStartRename={startRename}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
              renderRootActions={renderRootActions}
            />
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * The path of the folder holding `node`, read off the FLATTENED rows.
 *
 * The rows already carry depth, so the parent is the nearest preceding row one
 * level up — no second walk of the tree per drag-over event, which matters
 * because drag-over fires continuously.
 */
function rowsParentPath(rows: readonly ProjectTreeRow[], node: ProjectTreeNode): string | null {
  const index = rows.findIndex(r => r.node === node);
  if (index < 0) return null;
  const depth = rows[index].depth;
  if (depth === 0) return null;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i].depth === depth - 1) return rows[i].node.path!;
  }
  return null;
}
