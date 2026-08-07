// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ReorderableList.tsx — Reusable ordered-list UI with drag reordering, row
 * selection, and optional remove. Presentational only: it owns no data, it just
 * renders `items` and calls the handlers. Use it anywhere an ordered list needs
 * in-place reordering (IK path targets, LogicStep children, …).
 *
 * Layout (when `title` is set, e.g. inside the Property Inspector): the title
 * reads like a normal field label on the left and doubles as a collapse toggle
 * (caret in the dot gutter); a blue rail stays at the left edge while the rows
 * sit in the right ~50% area (the field/value column), left-aligned within it.
 * A drag handle marks each row as draggable; the remove (−) action stays hidden
 * until the row is hovered (or selected) to keep the list calm at rest.
 *
 * Drag-to-reorder (HTML5 DnD) is enabled automatically when `onReorder` is set.
 */

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, IconButton, Typography, Tooltip } from '@mui/material';
import RemoveIcon from '@mui/icons-material/Remove';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { INSPECTOR_DOT_GUTTER, INSPECTOR_ROW_GAP } from './layout-constants';

const ACCENT = '79,195,247'; // selection / rail / drag-insertion accent (rgb tuple)

// Left offset (px) of the inspector's label column, so a titled list's heading
// and rail line up with the property-field labels above/below it:
//   row px (InspectorRow uses px:1 = 8px) + dot gutter + grid column gap.
const LABEL_LEFT = 8 + INSPECTOR_DOT_GUTTER + INSPECTOR_ROW_GAP;

export interface ReorderableListItem {
  /** Stable unique id (used for selection match + React key). */
  id: string;
  /** Primary label. */
  label: string;
  /** Optional secondary label shown right-aligned, dimmed. */
  sublabel?: string;
}

export interface ReorderableListProps {
  items: ReorderableListItem[];
  /** Optional heading shown above the list (e.g. the field name). When set, the
   *  rows are laid out in the right-hand value column with a left rail. */
  title?: string;
  /** Move item from index `from` to index `to`. */
  onReorder?: (from: number, to: number) => void;
  /** Row clicked (not on a button). */
  onSelect?: (index: number, item: ReorderableListItem) => void;
  /** Remove button clicked. Omit to hide the remove button. */
  onRemove?: (index: number, item: ReorderableListItem) => void;
  /** Highlight the row whose item.id matches. */
  selectedId?: string | null;
  /** Text shown when the list is empty. */
  emptyText?: string;
  /** Show 1-based index prefix. Default true. */
  showIndex?: boolean;
}

export function ReorderableList({
  items, title, onReorder, onSelect, onRemove, selectedId, emptyText = '(empty)', showIndex = true,
}: ReorderableListProps) {
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const canDrag = !!onReorder;
  const indented = !!title;

  // Title row — the title reads like a normal field label at the label column;
  // the collapse caret and count sit in the right 50% value column so they line
  // up directly above the rows. The whole row is the click toggle.
  const header = title ? (
    <Box
      onClick={() => setCollapsed((c) => !c)}
      sx={{
        display: 'flex', alignItems: 'center',
        cursor: 'pointer', userSelect: 'none',
        '&:hover .rv-rl-title': { textDecoration: 'underline' },
      }}
    >
      <Typography
        className="rv-rl-title"
        sx={{ fontSize: 11, color: 'text.primary', pl: `${LABEL_LEFT}px`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {title}
      </Typography>
      <Box sx={{ width: 'calc(50% - 8px)', mr: '8px', ml: 'auto', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 0.25 }}>
        {items.length > 0 && (
          // 14px slot matching the drag-knob column, so the count centers over the knobs.
          <Box sx={{ width: 14, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
            <Typography
              sx={{
                fontSize: 9, fontWeight: 600, lineHeight: 1.5, color: 'text.disabled',
                px: 0.5, borderRadius: 4, bgcolor: 'rgba(255,255,255,0.06)',
              }}
            >
              {items.length}
            </Typography>
          </Box>
        )}
        {collapsed
          ? <ChevronRightIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
          : <ExpandMoreIcon sx={{ fontSize: 14, color: 'text.disabled' }} />}
      </Box>
    </Box>
  ) : null;

  const rows = items.map((item, i) => {
    const selected = selectedId != null && item.id === selectedId;
    return (
      <Box
        key={item.id + '#' + i}
        draggable={canDrag}
        onClick={() => onSelect?.(i, item)}
        onDragStart={canDrag ? (e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; } : undefined}
        onDragOver={canDrag ? (e) => { e.preventDefault(); if (dragOver !== i) setDragOver(i); } : undefined}
        onDragLeave={canDrag ? () => { if (dragOver === i) setDragOver(null); } : undefined}
        onDrop={canDrag ? (e) => {
          e.preventDefault();
          const from = dragFrom.current;
          if (from != null && from !== i) onReorder!(from, i);
          dragFrom.current = null; setDragOver(null);
        } : undefined}
        onDragEnd={canDrag ? () => { dragFrom.current = null; setDragOver(null); } : undefined}
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.25,
          px: indented ? 0 : 0.5, py: 0.1, borderRadius: 0.75,
          cursor: onSelect ? 'pointer' : (canDrag ? 'grab' : 'default'),
          bgcolor: selected ? `rgba(${ACCENT},0.18)` : 'transparent',
          border: selected ? `1px solid rgba(${ACCENT},0.5)` : '1px solid transparent',
          // Insertion line on the drop target — inset shadow so the row doesn't
          // shift while dragging over it.
          boxShadow: dragOver === i ? `inset 0 2px 0 0 rgba(${ACCENT},0.9)` : 'none',
          transition: 'background-color 120ms ease',
          '&:hover': { bgcolor: selected ? `rgba(${ACCENT},0.22)` : 'rgba(255,255,255,0.06)' },
          '&:hover .rv-rl-actions': { opacity: 1 },
        }}
      >
        {canDrag && (
          <DragIndicatorIcon sx={{ fontSize: 14, color: 'rgba(255,255,255,0.3)', flexShrink: 0, cursor: 'grab' }} />
        )}
        {showIndex && (
          <Box sx={{ width: 14, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
            <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>{i + 1}</Typography>
          </Box>
        )}
        <Typography sx={{ fontSize: 11, color: '#fff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.label}
        </Typography>
        {item.sublabel && (
          <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', fontFamily: 'monospace', flexShrink: 0 }}>{item.sublabel}</Typography>
        )}
        {/* Remove (−) — hidden at rest, revealed on row hover (or selection).
            Reordering is drag-only now, so there are no up/down arrows. */}
        {onRemove && (
          <Box
            className="rv-rl-actions"
            sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, opacity: selected ? 1 : 0, transition: 'opacity 120ms ease' }}
          >
            <Tooltip title="Remove" placement="top">
              <IconButton size="small" onClick={(e) => { e.stopPropagation(); onRemove(i, item); }} sx={{ p: 0.25, color: 'rgba(255,120,120,0.8)' }}>
                <RemoveIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Box>
        )}
      </Box>
    );
  });

  // The blue rail stays at the left; `rowsArea` holds the rows in the right
  // ~50% area (left-aligned), mirroring a property field's value column.
  const railedBody = (children: ReactNode) => (
    <Box sx={{ display: 'flex', alignItems: 'stretch' }}>
      {/* Blue rail at the label-column left edge (kept on the left). */}
      <Box sx={{ ml: `${LABEL_LEFT}px`, borderLeft: `1px solid rgba(${ACCENT},0.5)`, flexShrink: 0 }} />
      {/* Rows fill the field/value column: from 50% of the panel width to the
          right edge (8px inset), matching the inspector's right-anchored 50%
          field track so the rows line up with the number/checkbox fields. */}
      <Box sx={{ width: 'calc(50% - 8px)', mr: '8px', ml: 'auto', display: 'flex', flexDirection: 'column' }}>
        {children}
      </Box>
    </Box>
  );

  if (items.length === 0) {
    const empty = <Typography sx={{ fontSize: 11, color: 'text.disabled', py: 0.25 }}>{emptyText}</Typography>;
    return (
      <Box sx={{ px: indented ? 0 : 0.5, pt: 0.5, pb: 0 }}>
        {header}
        {!collapsed && (indented ? railedBody(empty) : empty)}
      </Box>
    );
  }

  return (
    <Box sx={{ px: indented ? 0 : 0.5, pt: 0.5, pb: 0 }}>
      {header}
      {!collapsed && (indented
        ? railedBody(rows)
        : <Box sx={{ display: 'flex', flexDirection: 'column' }}>{rows}</Box>)}
    </Box>
  );
}
