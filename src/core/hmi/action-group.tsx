// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared "action group" design — a compact glassy pill of full-height,
 * rectangular ButtonBase segments split by dividers. Used by the floating
 * top-left (mode + sim controls) and bottom-right (camera / view controls)
 * clusters so every action group looks identical (same height, spacing, hover).
 *
 * Two segment primitives, same optics ({@link segmentSx}):
 *  - {@link ActionSegment} — one click, one action (or one command view).
 *  - {@link ActionDropdownSegment} — a trigger that opens a menu UPWARDS
 *    (plan-578): the bottom-right cluster sits at the viewport's lower edge, so
 *    a downward menu would leave the screen. Non-modal on purpose (§2.4).
 */

import {
  createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react';
import {
  Box, Paper, ButtonBase, Divider, Fade, Tooltip, Popper, MenuList, MenuItem,
  ClickAwayListener,
} from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { aiTouchSx, useCommandView, type CommandRef } from './rv-command-view';
import {
  getAiTouchMs, useAiTouch, useButtonSimState,
  type AiTouchView, type ButtonSimPhase,
} from './button-sim-state';
import { useUIZoom } from './visual-settings-store';
import {
  ACCENT, CHIP_RADIUS, FIELD_BORDER, FS, ICON_SIZE, INK_HIGH, INK_LOW, INK_MID, MONO,
} from './shared-sx';

/**
 * Shared sizing for every action group — a single source of truth so all pills
 * line up with each other and with the ModeDropdown (same 22px desktop height).
 */
/** Fixed pill height. A *fixed* (not min-) height lets each segment's
 *  `height:'100%'` resolve deterministically → reliable vertical centering. */
const PILL_HEIGHT = { xs: 32, sm: 22 };
/** Every segment icon is forced to this size, so no group can look different. */
const SEGMENT_ICON_PX = 18;
/** Icon size inside a SQUARE cell (segment or tower): a 22px square needs air
 *  around its glyph — 4px on each side reads as a quiet instrument button,
 *  16px still crowded the cell (Thomas). The design token ICON_SIZE.sm. */
const SQUARE_ICON_PX = ICON_SIZE.sm;
/**
 * A coarse pointer (tablet, panel PC) gets the design system's 44px hit target.
 * The theme only enforces it on IconButton / Button — a segment is a bare
 * ButtonBase, so the pill and the segment carry it themselves.
 */
const COARSE_POINTER = '@media (hover: none) and (pointer: coarse)';
const TOUCH_TARGET_PX = 44;

/** Accent tints of a segment, as hex-alpha suffixes on the one accent (DESIGN.md §3). */
const TINT_ACTIVE = `${ACCENT}26`;        // ≈ 0.15
const TINT_ACTIVE_HOVER = `${ACCENT}38`;  // ≈ 0.22
const TINT_PRESSING = `${ACCENT}2e`;      // ≈ 0.18
/** Neutral hover / open tints on glass. */
const TINT_HOVER = 'rgba(255,255,255,0.10)';
const TINT_OPEN = 'rgba(255,255,255,0.14)';

/**
 * Glassy pill wrapper. Segments fill it edge-to-edge; corners clip via overflow.
 * Every other prop (`role`, `aria-label`, `data-testid`, …) goes to the Paper,
 * so an exclusive group can be a `radiogroup` (plan-761).
 */
export function ActionGroupPill({ children, sx, ...rest }: {
  children: ReactNode;
  sx?: SxProps<Theme>;
  role?: string;
  'aria-label'?: string;
  [attr: `data-${string}`]: unknown;
}) {
  return (
    <Paper
      data-ui-panel
      {...rest}
      sx={{
        display: 'flex',
        alignItems: 'stretch',
        borderRadius: 1,
        overflow: 'hidden',
        height: PILL_HEIGHT,
        [COARSE_POINTER]: { height: TOUCH_TARGET_PX },
        ...(sx as Record<string, unknown>),
      }}
    >
      {children}
    </Paper>
  );
}

/** Thin vertical divider between segments of ONE group. */
export function ActionDivider() {
  // Deliberately quiet: the group seam must read as the STRONGER line, and the
  // difference between the two is what makes a strip of sections legible.
  return <Divider orientation="vertical" flexItem sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />;
}

/**
 * The seam between two semantic GROUPS inside one pill — brighter than the
 * segment hairline and inset from the pill's edges, so a strip of several groups
 * reads as one instrument with sections, not as a row of equal buttons.
 */
export function ActionGroupDivider() {
  return (
    <Divider
      orientation="vertical"
      flexItem
      data-rv-group-divider=""
      // Much brighter than the hairline (0.08) AND set apart: 6px of glass on each
      // side turns the seam into a gap between sections, not one more line.
      sx={{ borderColor: 'rgba(255,255,255,0.55)', my: '5px', mx: '6px' }}
    />
  );
}

/**
 * Joins several already-filtered segment GROUPS into one strip: hairlines inside
 * a group ({@link withDividers}), a {@link ActionGroupDivider} between groups.
 * Empty groups vanish with their seam — the same by-construction guarantee
 * `withDividers` gives for segments.
 */
export function withGroupDividers(groups: readonly (readonly ReactNode[])[]): ReactNode[] {
  const out: ReactNode[] = [];
  groups.filter((g) => g.length > 0).forEach((group, gi) => {
    if (gi > 0) out.push(<ActionGroupDivider key={`group-div-${gi}`} />);
    // A keyed Fragment, not a wrapper element: the segments must stay direct
    // flex children of the pill, and two groups may reuse the same inner keys.
    withDividers(group).forEach((node, si) => {
      out.push(<Fragment key={`g${gi}-${si}`}>{node}</Fragment>);
    });
  });
  return out;
}

/**
 * Interpolate {@link ActionDivider}s between an **already filtered** list of
 * segments (plan-578 §2.7).
 *
 * This is deliberately NOT a `children`-walking helper: a component that
 * returns `null` internally is still a truthy child element, and a component
 * that returns a Fragment collapses its segments into one child — both produce
 * exactly the leading / doubled / missing dividers this is meant to prevent.
 * The caller therefore hands over a flat array it has already filtered (see
 * `useCameraSegments` / `useFollowSegments`), and nothing unseen can be in it.
 */
export function withDividers(segments: readonly ReactNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  segments.forEach((seg, i) => {
    if (i > 0) out.push(<ActionDivider key={`div-${i}`} />);
    out.push(seg);
  });
  return out;
}

/**
 * The shared trigger optics of a segment — extracted so
 * {@link ActionDropdownSegment} *is* an ActionSegment visually instead of
 * copying its look (plan-578 §2.2).
 */
export function segmentSx(opts: {
  /** Icon and label both present → a gap between them. */
  gap?: boolean;
  active?: boolean;
  color?: string;
  /** An icon-only segment is a SQUARE — the strip's base shape (and the
   *  dropdown tower's cell). A segment with text keeps its padding. */
  square?: boolean;
}): Record<string, unknown> {
  const { gap, active, color, square } = opts;
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: gap ? 0.5 : 0,
    px: square ? 0 : 0.75,
    ...(square ? { aspectRatio: '1 / 1', flexShrink: 0 } : null),
    height: '100%',
    lineHeight: 1,
    whiteSpace: 'nowrap',
    color: color ?? (active ? 'primary.main' : 'inherit'),
    bgcolor: active ? TINT_ACTIVE : 'transparent',
    transition: 'background-color 120ms',
    // Normalize every icon to one size + remove the inline baseline offset. The
    // dropdown caret is the one exception — it is a hint, not an icon.
    '& svg': { fontSize: `${square ? SQUARE_ICON_PX : SEGMENT_ICON_PX}px`, display: 'block' },
    '&:hover': { bgcolor: active ? TINT_ACTIVE_HOVER : TINT_HOVER },
    // The pill clips its corners (`overflow: hidden`), which would cut the global
    // 1px-offset focus ring in half — draw it INSIDE the segment instead.
    '&:focus-visible': { outline: `2px solid ${ACCENT}`, outlineOffset: '-2px' },
    [COARSE_POINTER]: square ? {} : { minWidth: TOUCH_TARGET_PX, px: 1.25 },
  };
}

interface ActionSegmentBaseProps {
  title: string;
  /** Active state → subtle primary highlight + primary text (unless `color` set). */
  active?: boolean;
  /** Explicit text/icon color override (e.g. 'warning.main', a hex string). */
  color?: string;
  /** The icon element (any MUI icon). Auto-normalized to {@link SEGMENT_ICON_PX}. */
  icon?: ReactNode;
  /** Optional text label (e.g. "VR", a camera number) in the shared label style. */
  label?: ReactNode;
  /** Extra props forwarded to the ButtonBase (pointer handlers, data-testid, …). */
  buttonProps?: Record<string, unknown>;
  sx?: SxProps<Theme>;
}

/**
 * plan-499: `onClick` OR `command`, never both — a command view never has a
 * second click path, so a double execution is a type error.
 */
type ActionSegmentTrigger =
  | { onClick?: () => void; command?: never; disabled?: never; disabledReason?: never }
  | {
    /** The segment is a VIEW of a command: click → execute (origin 'ui'), tooltip =
     *  the command's reason while it refuses, sim phase + afterglow on this segment. */
    command: CommandRef;
    onClick?: never;
    /** UI-local gate (busy, a running test session) — OR-ed with the command's own rule. */
    disabled?: boolean;
    /** Tooltip while only the UI-local gate refuses. */
    disabledReason?: string;
  };

export type ActionSegmentProps = ActionSegmentBaseProps & ActionSegmentTrigger;

/** Shared label typography of a segment (icon + text line up at one size). */
function SegmentLabel({ children }: { children: ReactNode }) {
  return <Box component="span" sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1 }}>{children}</Box>;
}

/**
 * One full-height segment with a fixed, normalized layout: an optional icon (forced
 * to a single size, `display:block` to kill the inline-SVG baseline gap) followed by
 * an optional label (shared typography). This guarantees every segment — across every
 * action group — has identical height, icon size, and vertical centering.
 */
export function ActionSegment(props: ActionSegmentProps) {
  const { title, active, color, icon, label, buttonProps, sx } = props;
  const command = props.command;
  const view = useCommandView(command ?? null);
  const localGate = command ? !!props.disabled : false;
  const disabled = command ? (view.disabled || localGate) : false;
  // The command's reason wins while it refuses; a UI-local gate keeps its own text.
  const tip = command && disabled ? (view.reason ?? props.disabledReason ?? title) : title;
  const glow = command ? view.simPhase : null;
  const onClick = command ? view.onClick : props.onClick;
  const segment = (
      <ButtonBase
        onClick={onClick}
        disabled={disabled}
        {...(command ? view.dataAttrs : {})}
        aria-description={view.touch ? 'Triggered by AI' : undefined}
        {...buttonProps}
        sx={{
          ...segmentSx({ gap: !!icon && label != null, active, color, square: !!icon && label == null }),
          ...(glow === 'hover' || glow === 'pressed' ? { bgcolor: TINT_PRESSING, color: 'primary.main' } : null),
          // Afterglow (AI touch): colour + opacity fade only, no transform (F13).
          ...(command && view.touch ? aiTouchSx(view.aiTouch, getAiTouchMs()) : null),
          ...(sx as Record<string, unknown>),
        }}
      >
        {icon}
        {label != null && <SegmentLabel>{label}</SegmentLabel>}
      </ButtonBase>
  );
  // A disabled ButtonBase fires no events, so its tooltip (= the command's reason)
  // needs a wrapper to show at all (plan-499 spike finding).
  // `top` like the dropdown trigger: the bottom-right cluster sits on the
  // viewport's lower edge. A top-left pill simply flips (Popper `flip`).
  return (
    <Tooltip title={tip} placement="top">
      {disabled ? <span style={{ display: 'flex', height: '100%' }}>{segment}</span> : segment}
    </Tooltip>
  );
}

// ─── ActionDropdownSegment (plan-578) ──────────────────────────────────────

/** Hover dwell before the menu opens — long enough that a pass-by does not. */
export const DROPDOWN_OPEN_DELAY_MS = 150;
/** Grace period after the pointer left BOTH trigger and paper. Same constant as
 *  the context-menu submenus (`ContextMenuLayer.tsx` SUBMENU_CLOSE_DELAY_MS). */
export const DROPDOWN_CLOSE_DELAY_MS = 250;
/**
 * Stacking of an open dropdown — above every floating HMI surface AND the AGPL
 * watermark (`#rv-watermark` in index.html, z-index 9999), which sits at the
 * cluster's corner and would otherwise cross a menu row. The menu only covers
 * it while it is open; the watermark itself stays untouched and always visible
 * otherwise (decision 2026-10-09, Thomas).
 */
export const DROPDOWN_Z_INDEX = 10000;

/**
 * How many proxied button keys one trigger can represent.
 *
 * The press/afterglow of each key is read through a hook, so the NUMBER of hook
 * calls must not depend on the array length — a render-mode trigger has three
 * keys in the viewer and four in the editor (plus the gated ray traced key and
 * the two quality rows, plan-762: seven in all). Padding to a fixed slot count is
 * what keeps the hook order stable; keys beyond this are ignored.
 */
const PROXY_KEY_SLOTS = 7;

/** Ein Segment, das ein Menue nach oben aufklappt. Teilt Optik und Masse mit ActionSegment. */
export interface ActionDropdownSegmentProps {
  /** Tooltip des geschlossenen Triggers (unterdrueckt, waehrend das Menue offen ist). */
  title: string;
  /** Icon des aktiven Eintrags bzw. ein statisches Overflow-Icon. */
  icon: ReactNode;
  /** Optionales Label neben dem Icon (folgt dem toolbar-labels-Flag). */
  label?: ReactNode;
  /** Active state of the trigger itself (an overflow whose content is engaged). */
  active?: boolean;
  /** Accessible name of the menu list (the group's name, e.g. "Render mode"). */
  menuLabel?: string;
  /** Button-Keys, die dieser Trigger im eingeklappten Zustand VERTRITT (§2.5). */
  proxyKeys?: readonly string[];
  /** Hover-Oeffnen aus/an (Default: an, nur fuer pointerType === 'mouse'). */
  openOnHover?: boolean;
  /** Die Eintraege. Jeder ist - wie heute jedes Segment - ein View eines Commands. */
  items: readonly ActionDropdownItem[];
  /**
   * Rows rendered after `items` that the trigger does not own — a plugin's
   * {@link ActionMenuRow}s (the overflow's `view-overflow` slot). They close the
   * menu through {@link useActionDropdownClose}. Must render MenuItems directly
   * (no wrapper element), or MenuList's arrow-key walk skips them.
   */
  extraRows?: ReactNode;
  buttonProps?: Record<string, unknown>;
}

/**
 * What a row IS for assistive tech: one of an exclusive set (`radio`, the render
 * modes), an independent toggle (`checkbox`, VR / FPV), or a plain command
 * (`action`, Record video).
 */
export type ActionMenuRowKind = 'radio' | 'checkbox' | 'action';

export interface ActionDropdownItem {
  key: string;
  icon?: ReactNode;
  label: string;
  /** Second line under the label (e.g. RenderMode.description). */
  description?: string;
  /** Keyboard shortcut, shown as a key chip at the row's end (e.g. `F`, `Shift+Z`). */
  shortcut?: string;
  /** Row semantics — default `radio`. */
  kind?: ActionMenuRowKind;
  active?: boolean;
  /** Entweder ein Command-View (wie ActionSegment) ... */
  command?: CommandRef;
  /** ... oder ein lokaler Handler (VR-Modal, FPV-Plugin-Toggle). */
  onClick?: () => void;
  /** Eigene testid, damit Tests den Eintrag im offenen Menue adressieren. */
  testId?: string;
}

/** Why the menu closed — decides whether the focus comes back (§2.4 point 3). */
type DropdownCloseReason = 'escape' | 'hover' | 'clickaway' | 'tab' | 'select' | 'toggle';

const INERT_PROXY_TOUCH: AiTouchView = { active: false, seq: 0, progress: 1 };

/** Focus the active row of an open menu paper, else its first row. */
function focusActiveRow(paper: HTMLElement | null): void {
  if (!paper) return;
  const target = paper.querySelector<HTMLElement>('[data-rv-dropdown-item][data-active="true"]')
    ?? paper.querySelector<HTMLElement>('[data-rv-dropdown-item]');
  target?.focus();
}

/**
 * The aggregate MCP state of every key a collapsed trigger represents (§2.5).
 *
 * Rule: a running press/hover phase wins over any afterglow, and among several
 * afterglows the **newest** one (highest `seq`) wins — so a fast sequence of
 * mode switches never swallows its own feedback.
 */
function useProxyActivity(proxyKeys: readonly string[] | undefined): {
  phase: ButtonSimPhase | null;
  touch: AiTouchView;
} {
  const slots = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < PROXY_KEY_SLOTS; i++) out.push(proxyKeys?.[i] ?? '');
    return out;
  }, [proxyKeys]);
  // Fixed hook count — see PROXY_KEY_SLOTS. '' never matches any button.
  const p0 = useButtonSimState(slots[0]);
  const p1 = useButtonSimState(slots[1]);
  const p2 = useButtonSimState(slots[2]);
  const p3 = useButtonSimState(slots[3]);
  const p4 = useButtonSimState(slots[4]);
  const p5 = useButtonSimState(slots[5]);
  const p6 = useButtonSimState(slots[6]);
  const t0 = useAiTouch(slots[0]);
  const t1 = useAiTouch(slots[1]);
  const t2 = useAiTouch(slots[2]);
  const t3 = useAiTouch(slots[3]);
  const t4 = useAiTouch(slots[4]);
  const t5 = useAiTouch(slots[5]);
  const t6 = useAiTouch(slots[6]);
  const phases = [p0, p1, p2, p3, p4, p5, p6];
  const touches = [t0, t1, t2, t3, t4, t5, t6];
  const pressing = phases.find((p) => p === 'hover' || p === 'pressed');
  if (pressing) return { phase: pressing, touch: INERT_PROXY_TOUCH };
  let best: AiTouchView | null = null;
  for (const t of touches) if (t.active && (!best || t.seq > best.seq)) best = t;
  return best ? { phase: 'afterglow', touch: best } : { phase: null, touch: INERT_PROXY_TOUCH };
}

/**
 * Closes the open dropdown from inside one of its rows — the hook a row that a
 * PLUGIN contributes through the `view-overflow` slot uses, since it is not
 * rendered by {@link ActionDropdownSegment} itself and gets no `onSelect` prop.
 */
const DropdownCloseContext = createContext<() => void>(() => {});

/** The close function of the dropdown this row sits in (no-op outside one). */
export function useActionDropdownClose(): () => void {
  return useContext(DropdownCloseContext);
}

/**
 * Which row of an open menu shows its tooltip — ONE at a time. Without it a row
 * focused from the keyboard and a row under the mouse both show theirs, and
 * the tower sprouts two labels. The mouse takes it over; focus claims it only
 * when the focus is visible (a click-open's programmatic focus is not).
 */
const DropdownTipContext = createContext<{ tip: string | null; setTip: (k: string | null) => void }>({
  tip: null,
  setTip: () => {},
});

/** Props of {@link ActionMenuRow} — the presentation of one menu row. */
export interface ActionMenuRowProps {
  label: string;
  icon?: ReactNode;
  /** Second line under the label: a refusal reason or a description. */
  description?: string;
  shortcut?: string;
  kind?: ActionMenuRowKind;
  active?: boolean;
  disabled?: boolean;
  /** Runs AFTER the menu closed. Never fires while `disabled`. */
  onClick?: () => void;
  /** Extra attributes for the MenuItem (`data-rv-button-id`, …). */
  attrs?: Record<string, unknown>;
  testId?: string;
  sx?: Record<string, unknown>;
}

const ROW_ROLE: Record<ActionMenuRowKind, string> = {
  radio: 'menuitemradio',
  checkbox: 'menuitemcheckbox',
  action: 'menuitem',
};

/**
 * One row of an {@link ActionDropdownSegment} menu — exported so a plugin can
 * contribute a row to the view cluster's overflow (`view-overflow` slot) that is
 * indistinguishable from the built-in ones (Record video).
 *
 * Layout: icon · label (+ second line) · shortcut chip. No native `title=`
 * tooltip — the reason a row refuses is written into the row itself.
 */
export function ActionMenuRow(props: ActionMenuRowProps) {
  const {
    label, icon, description, shortcut, kind = 'radio', active, disabled, onClick, attrs, testId, sx,
  } = props;
  const close = useActionDropdownClose();
  const { tip, setTip } = useContext(DropdownTipContext);
  const tipKey = testId ?? label;
  const row = (
    <MenuItem
      // NOT MUI's `disabled`: that sets `pointer-events: none`, and a refusing
      // row has to keep its hover/focus — the reason lives in its tooltip. The
      // row is disabled for assistive tech and in onClick instead.
      aria-disabled={disabled ? 'true' : undefined}
      role={ROW_ROLE[kind]}
      aria-checked={kind === 'action' ? undefined : !!active}
      aria-label={label}
      aria-description={description}
      aria-keyshortcuts={shortcut}
      {...attrs}
      // After `attrs`, so a plugin's own hover handler (Record's preflight
      // refresh) runs as well instead of replacing the tooltip bookkeeping.
      onMouseEnter={(e: ReactMouseEvent) => {
        setTip(tipKey);
        (attrs?.onMouseEnter as ((ev: ReactMouseEvent) => void) | undefined)?.(e);
      }}
      onMouseLeave={() => { if (tip === tipKey) setTip(null); }}
      onFocus={(e: ReactFocusEvent) => {
        if ((e.currentTarget as HTMLElement).matches(':focus-visible')) setTip(tipKey);
      }}
      onBlur={() => { if (tip === tipKey) setTip(null); }}
      data-rv-dropdown-item=""
      data-active={active ? 'true' : 'false'}
      data-testid={testId}
      onClick={() => {
        // A refusing row does nothing at all.
        if (disabled) return;
        // Close FIRST, execute after — the menu must not outlive its own click.
        close();
        onClick?.();
      }}
      sx={{
        // An icon tower: square cells as wide as the trigger above which it grew.
        justifyContent: 'center',
        p: 0,
        minHeight: 0,
        // The tower's cells are the trigger's own square (set on the paper).
        height: 'var(--rv-dropdown-cell, 28px)',
        color: active ? 'primary.main' : INK_HIGH,
        '& svg': { fontSize: SQUARE_ICON_PX, display: 'block' },
        '&:hover': { bgcolor: TINT_HOVER },
        '&.Mui-focusVisible': { bgcolor: TINT_HOVER, outline: `2px solid ${ACCENT}`, outlineOffset: '-2px' },
        ...(active ? { bgcolor: TINT_ACTIVE, '&:hover': { bgcolor: TINT_ACTIVE_HOVER } } : null),
        ...(disabled ? { color: INK_LOW, cursor: 'default', '&:hover': { bgcolor: 'transparent' } } : null),
        [COARSE_POINTER]: { height: TOUCH_TARGET_PX },
        ...sx,
      }}
    >
      {icon ?? <Box component="span" sx={{ fontSize: FS.body, px: 1 }}>{label}</Box>}
    </MenuItem>
  );
  return (
    <Tooltip
      placement="left"
      disableInteractive
      open={tip === tipKey}
      title={<ActionMenuTip label={label} shortcut={shortcut} description={description} />}
      // Above the open menu's own layer (and with it the watermark).
      slotProps={{ popper: { style: { zIndex: DROPDOWN_Z_INDEX + 1 } } }}
    >
      {row}
    </Tooltip>
  );
}

/** Tooltip body of an icon row: name · shortcut chip, then the reason / description. */
function ActionMenuTip({ label, shortcut, description }: {
  label: string;
  shortcut?: string;
  description?: string;
}) {
  return (
    <Box sx={{ py: 0.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box component="span" sx={{ fontSize: FS.body, color: INK_HIGH }}>{label}</Box>
        {shortcut && (
          <Box
            component="kbd"
            sx={{
              px: 0.5,
              fontFamily: MONO,
              fontSize: FS.label,
              lineHeight: '16px',
              color: INK_MID,
              border: `1px solid ${FIELD_BORDER}`,
              borderRadius: CHIP_RADIUS,
              whiteSpace: 'nowrap',
            }}
          >
            {shortcut}
          </Box>
        )}
      </Box>
      {description && (
        <Box sx={{ fontSize: FS.label, color: INK_LOW, mt: 0.25, maxWidth: 220 }}>{description}</Box>
      )}
    </Box>
  );
}

/**
 * One built-in menu row: a {@link ActionMenuRow} wrapped around a command VIEW.
 * Its own component on purpose: every row calls `useCommandView`, so a
 * conditional row (Wireframe only in the editor) must not change the hook count
 * of the trigger.
 */
function ActionDropdownRow({ item }: { item: ActionDropdownItem }) {
  const view = useCommandView(item.command ?? null);
  const disabled = item.command ? view.disabled : false;
  // A refusing command explains itself in the row's second line — the reason
  // text wins over the static description while it refuses.
  const description = disabled ? (view.reason ?? item.description) : item.description;
  return (
    <ActionMenuRow
      label={item.label}
      icon={item.icon}
      description={description}
      shortcut={item.shortcut}
      kind={item.kind}
      active={item.active}
      disabled={disabled}
      onClick={item.command ? view.onClick : item.onClick}
      // The real row carries `data-rv-button-id`, so while the menu is open the
      // MCP choreography finds IT and not the trigger's proxy (§2.5).
      attrs={item.command ? view.dataAttrs : undefined}
      testId={item.testId ?? item.key}
      sx={view.touch ? aiTouchSx(view.aiTouch, getAiTouchMs()) : undefined}
    />
  );
}

/**
 * A segment that opens a menu UPWARDS and shares its optics with
 * {@link ActionSegment} (plan-578 §2.4).
 *
 * Deliberately a non-modal `Popper` and not a MUI `Menu`: `Menu` is a `Popover`
 * and therefore a `Modal` — it lays its own root over the page, covers the
 * trigger, and makes a shared trigger+paper hover zone impossible. The
 * mechanics here are the ones the repo already runs for the context-menu
 * submenus (`ContextMenuLayer.tsx`): one timer for both directions, enter/leave
 * on trigger AND paper, `Escape` on the paper.
 *
 * What a `Popper` does not bring along and is spelled out here: a
 * `ClickAwayListener`, the `Tab` close, an explicit zIndex above the cluster,
 * and a focus policy that depends on WHY the menu closed — the focus only comes
 * back to the trigger after an `Escape` from inside the menu, never after a
 * hover timeout (the focus was never in there) and never after a click-away
 * (the clicked target keeps it).
 */
export function ActionDropdownSegment(props: ActionDropdownSegmentProps) {
  const {
    title, icon, label, active, menuLabel, proxyKeys, openOnHover = true, items, extraRows, buttonProps,
  } = props;
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [hovering, setHovering] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  /** One timer for both directions (§2.4 point 5). */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** How the menu was opened — only a click/keyboard open moves the focus. */
  const openedBy = useRef<'hover' | 'click'>('click');
  const open = anchorEl !== null;
  // Portal content does not inherit HMIShell's zoom — apply the UI scale here
  // (same reason as ModeDropdown).
  const uiZoom = useUIZoom();
  const proxy = useProxyActivity(proxyKeys);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const close = useCallback((reason: DropdownCloseReason) => {
    clearTimer();
    setAnchorEl(null);
    // Focus only comes back when it actually WAS in the menu, and only after an
    // explicit Escape — a hover timeout never had it, a click-away hands it to
    // the clicked target (§2.4 point 3).
    if (reason === 'escape' && paperRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus();
    }
  }, [clearTimer]);

  const scheduleClose = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      setAnchorEl(null);
    }, DROPDOWN_CLOSE_DELAY_MS);
  }, [clearTimer]);

  const openNow = useCallback((el: HTMLElement, by: 'hover' | 'click') => {
    clearTimer();
    openedBy.current = by;
    setAnchorEl(el);
  }, [clearTimer]);

  /**
   * A click/keyboard open puts the focus on the active row; a hover open must
   * NOT — otherwise a passing mouse steals the keyboard focus from a text field.
   *
   * This is a ref callback, not an effect on `open`: MUI's `Portal` renders
   * `null` on its first pass and only mounts its children after its own layout
   * effect, so an effect in THIS component still sees `paperRef.current === null`.
   * The ref callback fires in the commit that actually attaches the paper — and
   * refs attach bottom-up, so the rows are already in the DOM when it runs.
   */
  const attachPaper = useCallback((node: HTMLDivElement | null) => {
    paperRef.current = node;
    if (!node || openedBy.current !== 'click') return;
    focusActiveRow(node);
  }, []);

  const closeFromRow = useCallback(() => close('select'), [close]);
  /** One tooltip per open menu (see DropdownTipContext); cleared on close. */
  const [tip, setTip] = useState<string | null>(null);
  useEffect(() => { if (!open) setTip(null); }, [open]);
  const tipState = useMemo(() => ({ tip, setTip }), [tip]);

  const trigger = (
    <ButtonBase
      ref={triggerRef}
      aria-haspopup="menu"
      aria-expanded={open}
      onPointerEnter={(e) => {
        setHovering(true);
        // Touch and pen have no hover: a synthetic enter there would toggle
        // through the open AND the click path (§2.4 point 6).
        if (!openOnHover || e.pointerType !== 'mouse') return;
        const el = e.currentTarget as HTMLElement;
        clearTimer();
        timer.current = setTimeout(() => {
          timer.current = null;
          openedBy.current = 'hover';
          setAnchorEl(el);
        }, DROPDOWN_OPEN_DELAY_MS);
      }}
      onPointerLeave={() => {
        setHovering(false);
        scheduleClose();
      }}
      onClick={(e) => {
        // A click on a menu the hover dwell already opened PINS it instead of
        // toggling it shut — otherwise the natural "rest, then click" closes the
        // menu the user just watched appear. Pinning also hands it the focus.
        if (open && openedBy.current === 'hover') {
          clearTimer();
          openedBy.current = 'click';
          focusActiveRow(paperRef.current);
          return;
        }
        if (open) close('toggle');
        else openNow(e.currentTarget as HTMLElement, 'click');
      }}
      {...(proxyKeys && proxyKeys.length > 0 && !open
        // Only while collapsed: a menu that opens in the very moment of the
        // lookup must not leave the trigger standing in for a visible row.
        ? { 'data-rv-button-proxy': proxyKeys.join(' ') }
        : {})}
      {...buttonProps}
      sx={{
        ...segmentSx({ gap: true, active, square: label == null }),
        // The corner wedge below is positioned against the trigger.
        position: 'relative',
        // Open keeps an active trigger BLUE (one step brighter) — a neutral open
        // tint on top would erase the very state the trigger is there to show.
        ...(open ? { bgcolor: active ? TINT_ACTIVE_HOVER : TINT_OPEN } : null),
        ...(proxy.phase === 'hover' || proxy.phase === 'pressed'
          ? { bgcolor: TINT_PRESSING, color: 'primary.main' }
          : null),
        ...(proxy.touch.active ? aiTouchSx(proxy.touch, getAiTouchMs()) : null),
      }}
    >
      {icon}
      {label != null && <SegmentLabel>{label}</SegmentLabel>}
      {/* The "opens a menu" hint: a small wedge in the corner, like a tool
          flyout — the segment stays a square instead of growing a caret. */}
      <Box
        component="span"
        aria-hidden
        data-rv-caret=""
        sx={{
          position: 'absolute',
          right: '2px',
          bottom: '2px',
          width: 0,
          height: 0,
          borderLeft: '4px solid transparent',
          borderBottom: '4px solid currentColor',
          opacity: open ? 0.9 : 0.5,
          transition: 'opacity 120ms',
        }}
      />
    </ButtonBase>
  );

  return (
    <>
      {/* Controlled tooltip: a hover open would otherwise stack tooltip and
          menu on top of each other (§2.6). */}
      <Tooltip title={title} placement="top" open={!open && hovering}>
        {trigger}
      </Tooltip>
      <Popper
        open={open}
        anchorEl={anchorEl}
        placement="top-end"
        // MUI's Popper root hardcodes `role="tooltip"`; around a MENU that is
        // simply wrong (and it makes every `getByRole('tooltip')` ambiguous).
        role="presentation"
        // No offset: a gap between trigger and paper would break the shared
        // hover zone. Above the cluster (1200), the message tiles (1000) and the watermark (9999).
        // Inline `style`, not `sx`: the Popper root ignored `sx` — the menu
        // rendered with NO z-index and the tiles drew straight through it.
        style={{ zIndex: DROPDOWN_Z_INDEX }}
      >
        {/* Enter-only fade: the menu arrives softly but LEAVES at once — a
            closing menu that lingers would still catch the next pointer move. */}
        <Fade in appear timeout={100}>
        <div>
        <ClickAwayListener
          onClickAway={(e) => {
            // The trigger's own onClick toggles — do not close it twice.
            if (triggerRef.current?.contains(e.target as Node)) return;
            close('clickaway');
          }}
        >
          <Paper
            ref={attachPaper}
            elevation={0}
            data-ui-panel
            data-rv-dropdown-paper=""
            // Inline, so the no-shadow rule (DESIGN.md §4) and the UI scale are
            // at the highest specificity and directly assertable.
            style={{ boxShadow: 'none', zoom: uiZoom }}
            onPointerEnter={clearTimer}
            onPointerLeave={scheduleClose}
            onKeyDown={(e) => {
              // Escape is the ONLY closing key in here. Arrow keys belong to
              // MenuList — it moves the focus and lets the event bubble on, so a
              // handler here would navigate and then close (§2.4 point 2).
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close('escape');
              } else if (e.key === 'Tab') {
                // Close and let the focus take its natural way — `Menu` brought
                // this along as a modal, `MenuList` does not.
                close('tab');
              }
            }}
            // The surface is the theme's Glass Floating tier (DESIGN.md: three
            // tiers, never an opaque fourth) with its blur — nothing is
            // overridden here, so the menu is the same glass as the pill.
            // A tower exactly as wide as its trigger — the menu grows OUT of
            // the segment instead of standing beside it as a second panel.
            // The trigger's width is measured on screen, the paper is zoomed:
            // divide the zoom back out.
            sx={{
              width: anchorEl ? anchorEl.getBoundingClientRect().width / uiZoom : undefined,
              '--rv-dropdown-cell': anchorEl ? `${anchorEl.getBoundingClientRect().height / uiZoom}px` : undefined,
              borderRadius: 1,
              border: '1px solid rgba(255,255,255,0.1)',
              overflow: 'hidden',
            }}
          >
            <DropdownCloseContext.Provider value={closeFromRow}>
            <DropdownTipContext.Provider value={tipState}>
              <MenuList dense disablePadding role="menu" aria-label={menuLabel ?? title} sx={{ py: 0 }}>
                {items.map((item) => (
                  <ActionDropdownRow key={item.key} item={item} />
                ))}
                {extraRows}
              </MenuList>
            </DropdownTipContext.Provider>
            </DropdownCloseContext.Provider>
          </Paper>
        </ClickAwayListener>
        </div>
        </Fade>
      </Popper>
    </>
  );
}
