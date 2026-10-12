// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-inspector-blocks.tsx — the Inspector building blocks next to
 * `InspectorRow` (plan-510).
 *
 * New inspector UI is composed ONLY of these four blocks plus the design
 * values in `shared-sx.ts` (see DESIGN.md):
 *
 *  - `InspectorRow`        (rv-inspector-row.tsx) — label → value row;
 *  - `InspectorSubheader`  — the one group heading inside a component section;
 *  - `InspectorActionRow`  — a pure LAYOUT wrapper that puts existing buttons
 *                            on the value column's left edge (no action model:
 *                            `CommandActionButton` keeps enablement, disabled
 *                            reason, command data attributes and "one dispatch
 *                            per click");
 *  - `DetailsDisclosure`   — collapsed-by-default technical details (hashes,
 *                            GUIDs, package metadata) with a one-line summary.
 *
 * Plus the two component-action patterns (plan-514):
 *
 *  - `InspectorSectionMenu`  — the section header's ⋮ menu for component
 *                              management (Replace…, Re-import…, Remove);
 *  - `segmentActions` + `inspectorSegmentedGroupSx` — consecutive body actions
 *                              sharing a `group` render as ONE segmented control.
 *
 * The four blocks share `inspectorGridColumns()` with `InspectorRow`, so their
 * value-column content starts on the same x as every row value.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Box, Divider, IconButton, ListItemIcon, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { ChevronRight, ExpandMore, MoreVert } from '@mui/icons-material';
import { INSPECTOR_DOT_GUTTER, INSPECTOR_ROW_GAP } from './layout-constants';
import { inspectorGridColumns, INSPECTOR_ROW_PX } from './rv-inspector-row';
import { ACCENT, FS, ICON_SIZE, INK_HIGH, INK_LOW, INK_MID, ROW_HOVER } from './shared-sx';
import type { ComponentAction, ComponentActionContext } from './rv-component-action-registry';

/** Style of a button inside an {@link InspectorActionRow} (small, dense, sentence case). */
export const inspectorActionButtonSx = {
  minWidth: 0,
  height: 24,
  px: 0.75,
  py: 0,
  fontSize: FS.label,
  fontWeight: 600,
  textTransform: 'none',
} as const;

/** Keyboard activation (Enter / Space) for a role="button" element. */
function activateOnKey(handler: () => void) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handler();
    }
  };
}

// ── InspectorSubheader ───────────────────────────────────────────────────

export interface InspectorSubheaderProps {
  /** Heading text — rendered uppercase. */
  children: ReactNode;
  /** Accent colour: tints the text and draws a tinted band (e.g. runtime state, Transform). */
  accent?: string;
  /** Content in the dot gutter (e.g. a state dot). */
  dot?: ReactNode;
  /** Content pinned to the right (a state label, icon buttons). */
  trailing?: ReactNode;
  'data-testid'?: string;
}

/** The one group heading inside an inspector section: micro size, uppercase, Ink Low. */
export function InspectorSubheader({ children, accent, dot, trailing, 'data-testid': testId }: InspectorSubheaderProps) {
  return (
    <Box
      data-testid={testId}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: `${INSPECTOR_ROW_GAP}px`,
        px: INSPECTOR_ROW_PX,
        pt: accent ? 0.5 : 0.75,
        pb: 0.5,
        ...(accent ? { bgcolor: `${accent}18`, borderBottom: `2px solid ${accent}44` } : {}),
      }}
    >
      <Box sx={{ width: INSPECTOR_DOT_GUTTER, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {dot}
      </Box>
      <Typography
        component="div"
        sx={{
          flex: 1,
          minWidth: 0,
          fontSize: FS.micro,
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: accent ?? INK_LOW,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </Typography>
      {trailing}
    </Box>
  );
}

// ── InspectorActionRow ───────────────────────────────────────────────────

export interface InspectorActionRowProps {
  /** Existing buttons (e.g. `CommandActionButton`s) — rendered unchanged. */
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * Pure layout wrapper: the buttons start on the value column of the
 * inspector grid (same x as every `InspectorRow` field) and wrap below each
 * other when they do not fit.
 */
export function InspectorActionRow({ children, 'data-testid': testId }: InspectorActionRowProps) {
  return (
    <Box
      data-testid={testId}
      sx={{
        display: 'grid',
        gridTemplateColumns: inspectorGridColumns(false),
        columnGap: `${INSPECTOR_ROW_GAP}px`,
        px: INSPECTOR_ROW_PX,
        py: 0.5,
      }}
    >
      <Box
        className="rv-inspector-action-row-buttons"
        sx={{ gridColumn: 4, minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-start', gap: 0.5 }}
      >
        {children}
      </Box>
    </Box>
  );
}

// ── DetailsDisclosure ────────────────────────────────────────────────────

export interface DetailsDisclosureProps {
  /** Disclosure title (label column). */
  title: string;
  /** One-line summary in the value column (e.g. "BouncingBall · 188.5 kB"). */
  summary?: ReactNode;
  /** Open on first render. Default false; the state is not persisted. */
  defaultOpen?: boolean;
  /** The detail rows — usually `InspectorRow`s. Not rendered while closed. */
  children: ReactNode;
  'data-testid'?: string;
}

/** Collapsed-by-default technical details: chevron + title + summary; Enter/Space/click toggles. */
export function DetailsDisclosure({ title, summary, defaultOpen = false, children, 'data-testid': testId }: DetailsDisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = (): void => setOpen((o) => !o);
  const Chevron = open ? ExpandMore : ChevronRight;
  return (
    <Box data-testid={testId} data-open={open ? 'true' : 'false'}>
      <Box
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={activateOnKey(toggle)}
        sx={{
          display: 'grid',
          gridTemplateColumns: inspectorGridColumns(false),
          columnGap: `${INSPECTOR_ROW_GAP}px`,
          alignItems: 'center',
          px: INSPECTOR_ROW_PX,
          minHeight: 24,
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': { bgcolor: ROW_HOVER },
          '&:focus-visible': { outline: `1px solid ${ACCENT}`, outlineOffset: -1 },
        }}
      >
        <Box sx={{ gridColumn: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Chevron sx={{ fontSize: ICON_SIZE.sm, color: INK_LOW }} />
        </Box>
        <Typography sx={{ gridColumn: 2, fontSize: FS.label, color: INK_LOW, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </Typography>
        {summary != null && (
          <Typography
            component="div"
            sx={{ gridColumn: 4, fontSize: FS.label, color: INK_LOW, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {summary}
          </Typography>
        )}
      </Box>
      {open && <Box>{children}</Box>}
    </Box>
  );
}

// ── Segmented action groups (plan-510 fix → building block, plan-514) ────

/** One run of body actions: a `group` segment, or a single ungrouped action. */
export interface ActionSegment {
  group?: string;
  items: ComponentAction[];
}

/** Consecutive actions sharing a `group` → one segment; ungrouped actions → one segment each. */
export function segmentActions(actions: readonly ComponentAction[]): ActionSegment[] {
  const segments: ActionSegment[] = [];
  for (const action of actions) {
    const last = segments[segments.length - 1];
    if (action.group && last?.group === action.group) last.items.push(action);
    else segments.push({ group: action.group, items: [action] });
  }
  return segments;
}

/**
 * A segment group spans the value column as ONE control: equal-width segments,
 * joined borders, rounded only at the outer ends. Children are Buttons or the
 * `<span>` a disabled command button is wrapped in (tooltip), hence both selectors.
 * A COMMAND group (Jog − | Stop | Jog +) — not a selection toggle; toggles that
 * pick one state keep `compactToggleGroupSx`.
 */
export const inspectorSegmentedGroupSx = {
  display: 'flex',
  flex: '1 1 100%',
  minWidth: 0,
  '& > *': { flex: '1 1 0', minWidth: 0, display: 'flex' },
  // One line per segment: a label like "Jog −" must never break at its space.
  // Text only — in the ~150 px value column an icon + label does not fit a third
  // of it and ran into the segment borders; the tooltip still explains the action.
  '& .MuiButton-root': { width: '100%', borderRadius: 0, whiteSpace: 'nowrap', px: 0.5, justifyContent: 'center' },
  '& .MuiButton-startIcon': { display: 'none' },
  '& > *:not(:first-of-type)': { ml: '-1px' },
  '& > .MuiButton-root:first-of-type, & > *:first-of-type .MuiButton-root': { borderRadius: '4px 0 0 4px' },
  '& > .MuiButton-root:last-of-type, & > *:last-of-type .MuiButton-root': { borderRadius: '0 4px 4px 0' },
} as const;

// ── InspectorSectionMenu ─────────────────────────────────────────────────

export interface InspectorSectionMenuProps {
  /** The `placement: 'menu'` actions of the component (visibility is evaluated here). */
  actions: readonly ComponentAction[];
  ctx: ComponentActionContext;
  /** Called after an item ran (lets the section re-evaluate `isActive`). */
  onAfterClick: () => void;
  /** Open the menu on mount (reference gallery only — sections never pass it). */
  defaultOpen?: boolean;
}

/**
 * The section header's ⋮ menu: component management (Replace…, Re-import…,
 * Remove). Destructive items (`danger`) sit last, in red, behind a divider.
 * Hidden entirely when no menu action is visible for this node. MUI `Menu`
 * returns focus to the ⋮ button on close — deliberately not overridden.
 */
export function InspectorSectionMenu({ actions, ctx, onAfterClick, defaultOpen = false }: InspectorSectionMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (defaultOpen && buttonRef.current) setAnchor(buttonRef.current);
  }, [defaultOpen]);
  const visible = actions.filter((a) => !a.visible || a.visible(ctx));
  if (visible.length === 0) return null;
  const normal = visible.filter((a) => !a.danger);
  const danger = visible.filter((a) => a.danger);
  const open = anchor !== null;
  const item = (action: ComponentAction) => {
    const Icon = action.icon;
    const label = typeof action.label === 'function' ? action.label(ctx) : action.label ?? action.id;
    return (
      <MenuItem
        key={action.id}
        dense
        title={action.tooltip}
        data-testid={`rv-component-menu-item-${action.id}`}
        onClick={() => { setAnchor(null); action.onClick(ctx); onAfterClick(); }}
        sx={{ fontSize: FS.body, minHeight: 28, ...(action.danger ? { color: 'error.main' } : {}) }}
      >
        {Icon && (
          <ListItemIcon sx={{ minWidth: 24, color: 'inherit' }}>
            <Icon sx={{ fontSize: ICON_SIZE.sm }} />
          </ListItemIcon>
        )}
        {label}
      </MenuItem>
    );
  };
  return (
    <>
      <Tooltip title="Component actions" placement="top">
        <IconButton
          ref={buttonRef}
          size="small"
          aria-label={`${ctx.componentType} actions`}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="rv-component-menu"
          onClick={(e) => { e.stopPropagation(); setAnchor(e.currentTarget); }}
          sx={{ p: 0.25, color: INK_MID, '&:hover': { color: INK_HIGH } }}
        >
          <MoreVert sx={{ fontSize: ICON_SIZE.sm }} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {normal.map(item)}
        {normal.length > 0 && danger.length > 0 && <Divider />}
        {danger.map(item)}
      </Menu>
    </>
  );
}
