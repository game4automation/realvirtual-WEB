// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * HierarchyCategoryChips — the hierarchy panel's type filter (plan-597).
 *
 * Two levels: a chip per coarse category (`ui.category`) that the loaded model
 * actually has, in the fixed `CATEGORY_ORDER`, and — behind the chip's ▾ — a
 * menu of the fine type labels (`ui.filter`) inside it, each with its count.
 * A chosen label reads "Transport › Conveyors 12" in the chip.
 *
 * ## Shape and keyboard (WAI-ARIA APG: toolbar + menu button)
 *
 * The row is ONE `toolbar` with a roving tabindex: one tab stop, ←/→ walk every
 * part (category label AND ▾), Home/End jump to the ends. A category is a split
 * chip — a `group` of two native buttons: the label part toggles the filter
 * (`aria-pressed`), the ▾ part is a menu button (`aria-haspopup="menu"`,
 * `aria-expanded`/`aria-controls` only while open). Deliberately NOT a MUI
 * `Chip` with `onDelete`: Backspace/Delete would then open a menu. The menu's
 * items are `menuitemradio` with `aria-checked`; MUI returns focus to the ▾ on
 * Escape, which is not overridden.
 *
 * Inactive empty categories are not rendered; the ACTIVE one stays, even at 0,
 * so a selection is never pulled away under the user.
 *
 * While a search term is active (`matchCounts` given) every count reads
 * "matching/total" — "3/21", accessible name "Transport, 3 of 21" — so the chips
 * track what the list shows (plan-597 Phase 6b). Which categories are rendered
 * still follows the totals.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Box, ButtonBase, Menu, MenuItem } from '@mui/material';
import { ArrowDropDown } from '@mui/icons-material';
import { ACCENT, ACCENT_BORDER, ACCENT_TINT, CHIP_HOVER, DIVIDER, FIELD_BORDER_HOVER, FS, ICON_SIZE, MONO, filterChipSx } from './shared-sx';
import { CATEGORY_LABEL, CATEGORY_ORDER, type CategoryId } from '../engine/rv-component-category';
import { filterIdOf, parseFilterId, type HierarchyFilterId } from './hierarchy-utils';
import type { TypeCounts } from './hierarchy-rows';
import { componentColor } from './rv-inspector-helpers';

export interface HierarchyCategoryChipsProps {
  counts: TypeCounts;
  /** The same counts restricted to the active search's hits; `null`/absent
   *  without a search term. Turns every count into "matching/total". */
  matchCounts?: TypeCounts | null;
  value: HierarchyFilterId;
  onChange(id: HierarchyFilterId): void;
}

/** Chip height in this row (WCAG 2.2 SC 2.5.8: every target ≥ 24 px). */
const CHIP_HEIGHT = 24;

/** Key of one focusable part: `all`, `<category>` (label part), `<category>:menu`. */
type PartKey = string;
const menuKey = (category: string): PartKey => `${category}:menu`;

// Each part of a split chip hovers on its own (the wrapper does not), and the
// focus ring is the theme's 2 px accent ring, drawn INSIDE the part so the
// wrapper's clipping cannot cut it and it stays visible on an active chip
// (accent ring vs. the active tint >= 3:1).
const partSx = {
  height: '100%',
  px: 0.75,
  fontSize: FS.label,
  color: 'inherit',
  fontWeight: 'inherit',
  borderRadius: 0,
  '&:hover': { bgcolor: CHIP_HOVER },
  '&.Mui-focusVisible, &:focus-visible': { outline: `2px solid ${ACCENT}`, outlineOffset: '-2px' },
} as const;

/** The split chip's outer box: the shared chip look, minus its whole-chip hover. */
function wrapperSx(active: boolean): object {
  return {
    ...(filterChipSx(active, CHIP_HEIGHT) as object),
    '&:hover': { bgcolor: active ? ACCENT_TINT : 'transparent' },
    display: 'inline-flex',
    alignItems: 'stretch',
    overflow: 'hidden',
    p: 0,
  };
}

/** Visible count: "21", or "3/21" while a search runs. */
function countText(total: number, match: number | null): string {
  return match === null ? `${total}` : `${match}/${total}`;
}
/** Count in an accessible name: "21", or "3 of 21" while a search runs. */
function countName(total: number, match: number | null): string {
  return match === null ? `${total}` : `${match} of ${total}`;
}

const countSx = {
  fontFamily: MONO,
  fontVariantNumeric: 'tabular-nums',
  ml: 0.5,
  flexShrink: 0,
} as const;

export function HierarchyCategoryChips({ counts, matchCounts = null, value, onChange }: HierarchyCategoryChipsProps) {
  const { category: activeCategory, label: activeLabel } = parseFilterId(value);

  /** Rendered categories: any with hits, plus the active one (even at 0). */
  const categories = useMemo(() => CATEGORY_ORDER.filter((c) =>
    (counts.byCategory.get(c) ?? 0) > 0 || c === activeCategory), [counts, activeCategory]);

  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [focusKey, setFocusKey] = useState<PartKey>(() => activeCategory ?? 'all');
  const focusWithinRef = useRef(false);

  const partsInOrder = useCallback((): HTMLElement[] => {
    const root = toolbarRef.current;
    return root ? Array.from(root.querySelectorAll<HTMLElement>('[data-rv-chip-part]')) : [];
  }, []);

  // Roving tabindex target: the remembered part when it still exists, else the
  // label part of the same category (its ▾ vanished), else All. When the
  // focused part itself disappeared under keyboard focus, move focus there too.
  const keys = useMemo(() => {
    const out: PartKey[] = ['all'];
    for (const c of categories) {
      out.push(c);
      if ((counts.byLabel.get(c)?.size ?? 0) >= 2) out.push(menuKey(c));
    }
    return out;
  }, [categories, counts]);
  const resolvedFocusKey = keys.includes(focusKey)
    ? focusKey
    : (focusKey.endsWith(':menu') && keys.includes(focusKey.slice(0, -5)) ? focusKey.slice(0, -5) : 'all');

  useLayoutEffect(() => {
    if (resolvedFocusKey === focusKey) return;
    setFocusKey(resolvedFocusKey);
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const lostFocus = !active || active === document.body || !active.isConnected;
    if (focusWithinRef.current && lostFocus) {
      toolbarRef.current?.querySelector<HTMLElement>(`[data-rv-chip-part="${resolvedFocusKey}"]`)?.focus();
    }
  }, [resolvedFocusKey, focusKey]);

  const onToolbarKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    // React events bubble through portals: the open ▾ menu (portalled to
    // body) would otherwise hand its Home/End/←/→ to the toolbar, which moved
    // focus out of the menu. Handled keys and keys from outside the toolbar's
    // own DOM are not ours.
    if (e.defaultPrevented) return;
    if (!toolbarRef.current?.contains(e.target as Node)) return;
    const parts = partsInOrder();
    if (parts.length === 0) return;
    const current = parts.indexOf(document.activeElement as HTMLElement);
    let next = current;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = parts.length - 1;
    else if (e.key === 'ArrowRight') next = current < 0 ? 0 : Math.min(parts.length - 1, current + 1);
    else next = current < 0 ? 0 : Math.max(0, current - 1);
    e.preventDefault();
    const target = parts[next];
    if (!target) return;
    target.focus();
    setFocusKey(target.dataset.rvChipPart ?? 'all');
  }, [partsInOrder]);

  const onFocusCapture = useCallback((e: FocusEvent<HTMLDivElement>) => {
    focusWithinRef.current = true;
    const key = (e.target as HTMLElement).dataset?.rvChipPart;
    if (key) setFocusKey(key);
  }, []);
  const onBlurCapture = useCallback((e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && toolbarRef.current?.contains(next)) return;
    if (next) { focusWithinRef.current = false; return; }
    // No related target: either focus went nowhere (click on empty space) or the
    // focused part is being REMOVED. Only the first means "left the toolbar".
    const target = e.target as HTMLElement;
    queueMicrotask(() => { if (target.isConnected) focusWithinRef.current = false; });
  }, []);

  const tabIndexOf = (key: PartKey): number => (key === resolvedFocusKey ? 0 : -1);

  const allActive = value === 'all';

  return (
    <Box
      ref={toolbarRef}
      role="toolbar"
      aria-label="Filter by type"
      onKeyDown={onToolbarKeyDown}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      // Same left edge as the search field above (px 0.75); 4 px rhythm.
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 0.75, pt: 0, pb: 0.5 }}
    >
      <Box sx={wrapperSx(allActive)}>
        <ButtonBase
          data-rv-chip-part="all"
          tabIndex={tabIndexOf('all')}
          aria-pressed={allActive}
          aria-label={`All, ${countName(counts.total, matchCounts?.total ?? null)}`}
          onClick={() => onChange('all')}
          sx={partSx}
        >
          All<Box component="span" sx={countSx}>{countText(counts.total, matchCounts?.total ?? null)}</Box>
        </ButtonBase>
      </Box>
      {categories.map((c) => (
        <CategorySplitChip
          key={c}
          category={c}
          counts={counts}
          matchCounts={matchCounts}
          active={activeCategory === c}
          activeLabel={activeCategory === c ? activeLabel : null}
          onChange={onChange}
          tabIndexOf={tabIndexOf}
        />
      ))}
    </Box>
  );
}

interface CategorySplitChipProps {
  category: CategoryId;
  counts: TypeCounts;
  matchCounts: TypeCounts | null;
  active: boolean;
  activeLabel: string | null;
  onChange(id: HierarchyFilterId): void;
  tabIndexOf(key: PartKey): number;
}

function CategorySplitChip({ category, counts, matchCounts, active, activeLabel, onChange, tabIndexOf }: CategorySplitChipProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const open = anchor !== null;

  const categoryLabel = CATEGORY_LABEL[category];
  const labels = counts.byLabel.get(category);
  const categoryCount = counts.byCategory.get(category) ?? 0;
  const hasMenu = (labels?.size ?? 0) >= 2;
  const shownCount = activeLabel !== null ? (labels?.get(activeLabel) ?? 0) : categoryCount;
  const fullText = activeLabel !== null ? `${categoryLabel} › ${activeLabel}` : categoryLabel;
  // Search hits (the "3" of "3/21"); null without a search term.
  const matchLabels = matchCounts?.byLabel.get(category);
  const labelMatch = (label: string): number | null => (matchCounts ? (matchLabels?.get(label) ?? 0) : null);
  const categoryMatch = matchCounts ? (matchCounts.byCategory.get(category) ?? 0) : null;
  const shownMatch = activeLabel !== null ? labelMatch(activeLabel) : categoryMatch;

  // A ▾ that disappears (the category dropped to one label) takes its open
  // menu with it — otherwise the stale anchor re-opens the menu by itself, and
  // steals focus, the moment the ▾ comes back.
  useEffect(() => {
    if (!hasMenu) setAnchor(null);
  }, [hasMenu]);

  const menuEntries = useMemo(() => {
    const entries = [...(labels?.entries() ?? [])].sort((a, b) => a[0].localeCompare(b[0]));
    // A chosen label the model no longer has keeps its (checked) entry at 0.
    if (activeLabel !== null && !labels?.has(activeLabel)) entries.push([activeLabel, 0]);
    return entries;
  }, [labels, activeLabel]);

  const onLabelClick = (): void => {
    if (!active) onChange(filterIdOf(category));
    else if (activeLabel !== null) onChange(filterIdOf(category));
    else onChange('all');
  };

  const openMenu = (): void => { if (wrapperRef.current) setAnchor(wrapperRef.current); };
  const pick = (label: string | null): void => {
    setAnchor(null);
    onChange(filterIdOf(category, label));
  };

  return (
    <Box
      ref={wrapperRef}
      role="group"
      aria-label={categoryLabel}
      title={`${fullText} ${countText(shownCount, shownMatch)}`}
      sx={{ ...wrapperSx(active), maxWidth: '100%', minWidth: 0 }}
    >
      <ButtonBase
        data-rv-chip-part={category}
        tabIndex={tabIndexOf(category)}
        aria-pressed={active}
        aria-label={`${fullText}, ${countName(shownCount, shownMatch)}`}
        onClick={onLabelClick}
        sx={{ ...partSx, minWidth: 0, justifyContent: 'flex-start' }}
      >
        <Box component="span" sx={{ flexShrink: 0 }}>{categoryLabel}</Box>
        {activeLabel !== null && (
          <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {` › ${activeLabel}`}
          </Box>
        )}
        <Box component="span" sx={countSx}>{countText(shownCount, shownMatch)}</Box>
      </ButtonBase>
      {hasMenu && (
        <ButtonBase
          data-rv-chip-part={menuKey(category)}
          tabIndex={tabIndexOf(menuKey(category))}
          aria-haspopup="menu"
          aria-expanded={open ? true : undefined}
          aria-controls={open ? menuId : undefined}
          aria-label={`${categoryLabel} types`}
          onClick={openMenu}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(); }
          }}
          // The split line: at least as strong as the chip's own border.
          sx={{ ...partSx, px: 0, minWidth: CHIP_HEIGHT, borderLeft: `1px solid ${active ? ACCENT_BORDER : FIELD_BORDER_HOVER}` }}
        >
          <ArrowDropDown sx={{ fontSize: ICON_SIZE.md }} />
        </ButtonBase>
      )}
      {hasMenu && (
        <Menu
          anchorEl={anchor}
          open={open}
          onClose={() => setAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          // The id goes on the element that carries role="menu" — aria-controls
          // must name it, not the popover root.
          slotProps={{ list: { id: menuId, 'aria-label': `${categoryLabel} types`, dense: true } }}
        >
          <MenuItem
            dense
            role="menuitemradio"
            aria-checked={activeLabel === null && active}
            aria-label={`All ${categoryLabel}, ${countName(categoryCount, categoryMatch)}`}
            selected={activeLabel === null && active}
            onClick={() => pick(null)}
            sx={{ fontSize: FS.body, minHeight: 28, gap: 1 }}
          >
            <Box component="span" sx={{ flex: 1 }}>{`All ${categoryLabel}`}</Box>
            <Box component="span" sx={countSx}>{countText(categoryCount, categoryMatch)}</Box>
          </MenuItem>
          {menuEntries.map(([label, n]) => {
            const type = counts.labelType.get(`${category}/${label}`);
            const checked = activeLabel === label;
            return (
              <MenuItem
                key={label}
                dense
                role="menuitemradio"
                aria-checked={checked}
                aria-label={`${label}, ${countName(n, labelMatch(label))}`}
                selected={checked}
                onClick={() => pick(label)}
                sx={{ fontSize: FS.body, minHeight: 28, gap: 1 }}
              >
                <Box
                  component="span"
                  aria-hidden
                  sx={{ width: ICON_SIZE.dot, height: ICON_SIZE.dot, borderRadius: '50%', flexShrink: 0, bgcolor: type ? componentColor(type) : DIVIDER }}
                />
                <Box component="span" sx={{ flex: 1 }}>{label}</Box>
                <Box component="span" sx={countSx}>{countText(n, labelMatch(label))}</Box>
              </MenuItem>
            );
          })}
        </Menu>
      )}
    </Box>
  );
}

