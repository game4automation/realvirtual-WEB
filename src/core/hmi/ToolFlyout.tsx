// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ToolFlyout — a menu button for the floating tool toolbar (`button-group`
 * slot, plan-2010): ONE toolbar icon that opens a small menu of related tools
 * (the planner's snap switches, the DES snapshot actions).
 *
 *   <ToolFlyout title="Snap" icon={<GridOn />} active={anyOn} testId="planner-snap-flyout">
 *     <ToolFlyoutRow kind="checkbox" label="Grid snap" checked={grid} onSelect={toggleGrid} />
 *     <ToolFlyoutDivider />
 *     <ToolFlyoutRow label="Grid snap settings…" onSelect={(trigger) => openSettings(trigger)} />
 *   </ToolFlyout>
 *
 * Rows must be DIRECT children (no Fragment, no wrapper element): `MenuList`
 * walks its children for the arrow keys.
 *
 * Mechanics taken from `ActionDropdownSegment` (`action-group.tsx`, plan-578),
 * which stays untouched (plan-2010 E4): a non-modal `Popper` with
 * `role="presentation"`, a `ClickAwayListener`, Escape / Tab handled on the
 * paper, `DROPDOWN_Z_INDEX`, the UI zoom applied to the portal content, the
 * Glass tier without a shadow (DESIGN.md §4) and the corner wedge as the
 * "opens a menu" hint. Different on purpose:
 *  - no hover-open — the toolbar sits at the edge of the 3D view, a pointer
 *    passing by must not unfold a panel;
 *  - right-click and press-and-hold open it too (the gestures the planner's
 *    tool buttons used for their settings, `useToolButtonInteraction`);
 *  - the menu opens to the RIGHT of the vertical toolbar (above the mobile
 *    bottom row), sized by its content instead of as a tower;
 *  - closing because a row was CHOSEN hands the focus back to the trigger
 *    BEFORE the row's `onSelect` runs (when the focus was in the menu), so a
 *    popover the row opens next remembers the trigger as its return target and
 *    restores it on Escape / click-away (gate finding SOL R1 #4).
 *
 * WAI-ARIA menu button: the trigger carries `aria-haspopup="menu"`,
 * `aria-expanded`, `aria-controls`; Enter / Space / ArrowDown open the menu and
 * focus its first row, the arrow keys move between rows, Space / Enter toggle a
 * checkbox row without closing, Escape closes and refocuses the trigger, Tab
 * closes and moves on to the control after the trigger.
 */

import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';
import {
  Box, ClickAwayListener, Divider, Fade, IconButton, MenuItem, MenuList, Paper, Popper, Tooltip,
} from '@mui/material';
import { Check } from '@mui/icons-material';
import { DROPDOWN_Z_INDEX } from './action-group';
import { useUIZoom } from './visual-settings-store';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { DIVIDER, FIELD_BORDER, FS, ICON_SIZE, INK_HIGH, INK_LOW } from './shared-sx';

/** Press-and-hold threshold before the menu opens — same as `useToolButtonInteraction`. */
export const TOOL_FLYOUT_LONG_PRESS_MS = 450;

/** Where the menu opens: `auto` = right of the trigger on desktop, above it on mobile. */
export type ToolFlyoutPlacement = 'auto' | 'right' | 'top';

/** Why the menu closed — decides where the focus goes. */
type FlyoutCloseReason = 'escape' | 'tab' | 'clickaway' | 'select' | 'toggle';

interface FlyoutContextValue {
  /** Close the menu for the given reason (focus policy included). */
  close: (reason: FlyoutCloseReason) => void;
  /** The trigger button — handed to a row's `onSelect`. */
  getTrigger: () => HTMLElement | null;
}

const FlyoutContext = createContext<FlyoutContextValue | null>(null);

export interface ToolFlyoutProps {
  /** Name of the tool: the closed trigger's tooltip and its `aria-label`. */
  title: string;
  /** Trigger icon (any MUI icon; normalised to the toolbar's 18 px). */
  icon: ReactNode;
  /** The tool is engaged (e.g. any snap switch on) → the trigger is coloured. Default false. */
  active?: boolean;
  /** Accessible name of the menu. Default: `title`. */
  menuLabel?: string;
  /** `data-testid` of the trigger; the menu paper gets `<testId>-menu`. */
  testId?: string;
  /** Where the menu opens. Default `auto`. */
  placement?: ToolFlyoutPlacement;
  /** The rows: {@link ToolFlyoutRow} / {@link ToolFlyoutDivider}, as direct children. */
  children: ReactNode;
}

/** Elements the browser's Tab sequence can land on. */
const TABBABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]', '[contenteditable="true"]',
].join(',');

/**
 * Move the focus to the element before / after `from` in the Tab sequence,
 * skipping everything inside `exclude` (the open menu — a portal at the end of
 * the body, which a natural Tab would walk into or past the whole page).
 *
 * Candidates are TRIED in turn: an element the browser refuses to focus
 * (`visibility: hidden`, inside a disabled fieldset, …) is skipped instead of
 * swallowing the move. Nothing focusable on that side → back to `from`.
 */
function focusBesides(from: HTMLElement, backwards: boolean, exclude: HTMLElement | null): void {
  const all = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => (
    el === from || (
      el.tabIndex >= 0
      && !(exclude?.contains(el))
      && !el.closest('[inert]')
      && el.getClientRects().length > 0
    )
  ));
  const start = all.indexOf(from);
  if (start >= 0) {
    const step = backwards ? -1 : 1;
    for (let i = start + step; i >= 0 && i < all.length; i += step) {
      all[i].focus();
      if (document.activeElement === all[i]) return;
    }
  }
  from.focus();
}

/** Focus the first enabled row of an open menu paper, else its first row. */
function focusFirstRow(paper: HTMLElement | null): void {
  if (!paper) return;
  const row = paper.querySelector<HTMLElement>('[data-rv-flyout-row]:not([aria-disabled="true"])')
    ?? paper.querySelector<HTMLElement>('[data-rv-flyout-row]');
  row?.focus();
}

/** A menu button of the floating tool toolbar. See the file header. */
export function ToolFlyout(props: ToolFlyoutProps) {
  const { title, icon, active = false, menuLabel, testId, placement = 'auto', children } = props;
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const open = anchorEl !== null;
  // The long-press timer reads the CURRENT anchor (a click may have opened it meanwhile).
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = anchorEl;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A press-and-hold opened the menu → the click that ends the press must not close it again. */
  const didLongPress = useRef(false);
  const menuId = useId();
  const isMobile = useMobileLayout();
  // Portal content does not inherit HMIShell's zoom (same reason as ActionDropdownSegment).
  const uiZoom = useUIZoom();
  const side = placement === 'auto' ? (isMobile ? 'top' : 'right') : placement;

  const clearHold = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);
  useEffect(() => clearHold, [clearHold]);

  const openMenu = useCallback((el: HTMLElement) => {
    setTipOpen(false);
    setAnchorEl(el);
  }, []);

  const close = useCallback((reason: FlyoutCloseReason) => {
    const paper = paperRef.current;
    const focusInMenu = !!paper && paper.contains(document.activeElement);
    const trigger = triggerRef.current;
    // The focus only comes back when it WAS in the menu: after Escape, and after a
    // row was chosen (BEFORE the row runs — a popover it opens then takes the
    // trigger as its return target). A click-away leaves it on what was clicked.
    if (focusInMenu && trigger && (reason === 'escape' || reason === 'select')) {
      trigger.focus();
    }
    // A hold released outside the trigger never produced its closing click —
    // the stale flag must not swallow the next one.
    didLongPress.current = false;
    setAnchorEl(null);
  }, []);

  /**
   * Focus the first row once the paper is in the DOM. A ref callback, not an
   * effect: MUI's Portal mounts its children one commit later, so an effect on
   * `open` here would still see no paper (see ActionDropdownSegment).
   */
  const attachPaper = useCallback((node: HTMLDivElement | null) => {
    paperRef.current = node;
    if (node) focusFirstRow(node);
  }, []);

  const getTrigger = useCallback(() => triggerRef.current, []);
  const ctx = useMemo<FlyoutContextValue>(() => ({ close, getTrigger }), [close, getTrigger]);

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    // Enter / Space open through the button's own (native) click; ArrowDown opens too.
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault();
      openMenu(e.currentTarget);
    } else if (e.key === 'Escape' && open) {
      // Open, but the focus stayed on the trigger: Escape still closes.
      e.preventDefault();
      e.stopPropagation();
      close('escape');
    }
  };

  const onPaperKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Handled here, so the FloatingPanel Escape stack does not see it too.
      e.preventDefault();
      e.stopPropagation();
      close('escape');
    } else if (e.key === 'Tab') {
      // The paper is a portal at the end of the body — the natural Tab would
      // leave the toolbar for the page's end. Close and continue from the trigger.
      e.preventDefault();
      const trigger = triggerRef.current;
      const paper = paperRef.current;
      close('tab');
      if (trigger) focusBesides(trigger, e.shiftKey, paper);
    }
  };

  const trigger = (
    <IconButton
      ref={triggerRef}
      size="small"
      aria-label={title}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      data-testid={testId}
      data-rv-tool-flyout=""
      data-active={active ? 'true' : 'false'}
      onClick={(e) => {
        if (didLongPress.current) {
          didLongPress.current = false;
          // The hold already opened the menu; the POINTER click that ends the
          // press must not close it again. A keyboard click (detail 0) is never
          // that click — the press may have ended outside the trigger.
          if (e.detail > 0) return;
        }
        if (open) close('toggle');
        else openMenu(e.currentTarget);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        clearHold();
        if (!open) openMenu(e.currentTarget);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return; // right-click goes through onContextMenu
        didLongPress.current = false;
        const el = e.currentTarget; // captured: currentTarget is gone when the timer fires
        clearHold();
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          if (anchorRef.current === null) {
            didLongPress.current = true;
            openMenu(el);
          }
        }, TOOL_FLYOUT_LONG_PRESS_MS);
      }}
      onPointerUp={clearHold}
      onPointerLeave={clearHold}
      onKeyDown={onTriggerKeyDown}
      sx={{
        p: 0.75,
        position: 'relative',
        color: active ? 'primary.main' : 'inherit',
        '& svg': { fontSize: ICON_SIZE.lg },
        ...(open ? { bgcolor: 'action.selected' } : null),
      }}
    >
      {icon}
      {/* The "opens a menu" hint — the same corner wedge as ActionDropdownSegment. */}
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
    </IconButton>
  );

  return (
    <>
      {/* Controlled: the tooltip never stands next to the open menu. */}
      <Tooltip
        title={title}
        placement={side === 'top' ? 'top' : 'right'}
        open={tipOpen && !open}
        onOpen={() => setTipOpen(true)}
        onClose={() => setTipOpen(false)}
      >
        {trigger}
      </Tooltip>
      <Popper
        open={open}
        anchorEl={anchorEl}
        placement={side === 'top' ? 'top-start' : 'right-start'}
        // MUI's Popper root says `role="tooltip"` — wrong around a menu.
        role="presentation"
        // Inline `style`: the Popper root ignores `sx` (see ActionDropdownSegment).
        style={{ zIndex: DROPDOWN_Z_INDEX }}
        modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
      >
        {/* Enter-only fade: the menu arrives softly but leaves at once. */}
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
                data-rv-flyout-paper=""
                data-testid={testId ? `${testId}-menu` : undefined}
                // Inline, so the no-shadow rule (DESIGN.md §4) and the UI scale are
                // at the highest specificity and directly assertable.
                style={{ boxShadow: 'none', zoom: uiZoom }}
                onKeyDown={onPaperKeyDown}
                // Theme Glass Floating tier, untouched (same glass as the toolbar).
                sx={{
                  minWidth: 200,
                  borderRadius: 1,
                  border: `1px solid ${FIELD_BORDER}`,
                  overflow: 'hidden',
                }}
              >
                <FlyoutContext.Provider value={ctx}>
                  <MenuList
                    id={menuId}
                    dense
                    role="menu"
                    aria-label={menuLabel ?? title}
                    // A refusing row stays reachable (its second line says why).
                    disabledItemsFocusable
                    sx={{ py: 0.5 }}
                  >
                    {children}
                  </MenuList>
                </FlyoutContext.Provider>
              </Paper>
            </ClickAwayListener>
          </div>
        </Fade>
      </Popper>
    </>
  );
}

export interface ToolFlyoutRowProps {
  /** Row text (also its accessible name). */
  label: string;
  /** Optional icon — leading column of an action row, after the check of a checkbox row. */
  icon?: ReactNode;
  /** `checkbox` = an independent switch (`menuitemcheckbox`), `action` = a command. Default `action`. */
  kind?: 'checkbox' | 'action';
  /** State of a checkbox row. */
  checked?: boolean;
  /** Second line under the label (a setting's value, a refusal reason). */
  description?: string;
  /** Refusing row: focusable, but `onSelect` never runs. */
  disabled?: boolean;
  /** Close the menu when chosen. Default: action rows close, checkbox rows stay open. */
  closeOnSelect?: boolean;
  /** Runs when the row is chosen (click, Enter, Space) — AFTER the menu closed, if it closes. */
  onSelect?: (trigger: HTMLElement) => void;
  testId?: string;
  /** @internal Injected by MenuList (roving focus); forwarded to the MenuItem. */
  tabIndex?: number;
  /** @internal Injected by MenuList; forwarded to the MenuItem. */
  autoFocus?: boolean;
}

/** One row of a {@link ToolFlyout}. */
export function ToolFlyoutRow(props: ToolFlyoutRowProps) {
  const {
    label, icon, kind = 'action', checked = false, description, disabled = false,
    closeOnSelect, onSelect, testId, tabIndex, autoFocus,
  } = props;
  const flyout = useContext(FlyoutContext);
  const closes = closeOnSelect ?? kind === 'action';

  const choose = () => {
    if (disabled) return;
    const trigger = flyout?.getTrigger() ?? null;
    // Close FIRST (focus back to the trigger), execute after.
    if (closes) flyout?.close('select');
    if (trigger) onSelect?.(trigger);
  };

  return (
    <MenuItem
      role={kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={kind === 'checkbox' ? checked : undefined}
      // NOT MUI's `disabled`: it sets pointer-events none and drops the row out
      // of the keyboard walk; a refusing row keeps its focus (as ActionMenuRow).
      aria-disabled={disabled ? 'true' : undefined}
      aria-description={description}
      tabIndex={tabIndex}
      autoFocus={autoFocus}
      data-rv-flyout-row=""
      data-testid={testId}
      onClick={choose}
      sx={{
        gap: 1,
        alignItems: 'flex-start',
        py: 0.5,
        px: 1,
        minHeight: 0,
        color: disabled ? INK_LOW : INK_HIGH,
        ...(disabled ? { cursor: 'default', '&:hover': { bgcolor: 'transparent' } } : null),
      }}
    >
      {/* Leading column: the check of a checkbox row, the icon of an action row. */}
      <Box
        component="span"
        aria-hidden
        sx={{
          width: ICON_SIZE.lg,
          height: ICON_SIZE.lg,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: kind === 'checkbox' ? 'primary.main' : 'inherit',
          '& svg': { fontSize: ICON_SIZE.lg },
        }}
      >
        {kind === 'checkbox'
          ? <Check data-rv-flyout-check="" style={{ visibility: checked ? 'visible' : 'hidden' }} />
          : icon}
      </Box>
      {kind === 'checkbox' && icon != null && (
        <Box
          component="span"
          aria-hidden
          sx={{ display: 'flex', alignItems: 'center', height: ICON_SIZE.lg, '& svg': { fontSize: ICON_SIZE.lg } }}
        >
          {icon}
        </Box>
      )}
      <Box component="span" sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Box component="span" sx={{ fontSize: FS.body, lineHeight: `${ICON_SIZE.lg}px` }}>{label}</Box>
        {description && (
          <Box component="span" sx={{ fontSize: FS.label, color: INK_LOW, lineHeight: 1.3 }}>
            {description}
          </Box>
        )}
      </Box>
    </MenuItem>
  );
}

/** A hairline between two blocks of rows. */
export function ToolFlyoutDivider() {
  return <Divider component="li" sx={{ my: 0.5, borderColor: DIVIDER }} />;
}
// MenuList skips this child when it picks the row that gets the roving focus.
(ToolFlyoutDivider as unknown as { muiSkipListHighlight: boolean }).muiSkipListHighlight = true;
