// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalSearchOverlay — a reusable, filterable signal picker rendered as a popover.
 *
 * Anchored to any element; shows a search field plus a live-status list of signals
 * (each rendered with the standard SignalListItem). The list is VIRTUALIZED
 * (@tanstack/react-virtual) so thousands of CONNECT signals stay responsive, and
 * the query is deferred (useDeferredValue) so typing never blocks on filtering.
 *
 * Two-group mode (plan-325 F3): when items carry `origin`, the list splits into
 * "CONNECT (live)" and "Model signals" groups with sticky group headers —
 * external CONNECT sources and internal model signals in one picker.
 *
 * Generic on purpose: any part of the HMI that needs "search a signal, pick one"
 * (signal binding, HMI wiring, force targeting, …) reuses this instead of rolling
 * its own dropdown.
 *
 * ## Focus model — APG combobox with a controlled listbox (plan-341 §2.8 d)
 *
 * The SEARCH FIELD keeps DOM focus for the whole life of the overlay and is the
 * `role="combobox"`; the list is a `role="listbox"` that is never focusable and
 * whose options carry no `tabIndex`. Arrow/Home/End/Enter/Escape all hang off
 * the search field's `onKeyDown`, and the current option is pointed at with
 * `aria-activedescendant`. Roving tabindex was not an option: it would have to
 * move focus INTO a virtualized list, where the focused row can be unmounted by
 * a scroll at any moment.
 *
 * Two consequences worth keeping in mind when editing this file:
 *
 *  - **Option ids are namespaced per instance.** `SignalBindPopover` and
 *    `InlineSignalSlots` mount this overlay independently, and two live
 *    instances with a global `sigopt-{i}` scheme would make
 *    `aria-activedescendant` resolve to the OTHER overlay's row.
 *  - **The active row is force-rendered.** `aria-activedescendant` must point
 *    at an element that exists, so the range extractor pins the active index
 *    into the rendered window — arrowing far past the overscan window keeps the
 *    reference valid without any mount-timing dance.
 *
 * `aria-setsize`/`aria-posinset` count ITEMS ONLY. The virtualizer mixes group
 * headers and items in one index space, so the raw index would tell a screen
 * reader "3 of 24" on a list of 22 signals.
 */

import {
  useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState,
} from 'react';
import { Box, ButtonBase, Popover, TextField, Typography, InputAdornment } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import SearchIcon from '@mui/icons-material/Search';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import type { RVViewer } from '../rv-viewer';
import type { SignalDirection } from './rv-signal-badge';
import { SignalListItem } from './SignalListItem';
import { dropRejectText, type DropRejectReason } from '../../plugins/signal-bind/drop-accept';

/** One selectable signal in the overlay. */
export interface SignalSearchItem {
  name: string;
  interfaceId?: string;
  topic?: string;
  /** A v1 duplicate-name or feedback fan-in conflict; conflicted entries are not selectable. */
  conflict?: boolean;
  direction: SignalDirection;
  /** Full PLC type (e.g. "PLCInputBool") for the status badge label. */
  plcType?: string;
  /** Protocol address (e.g. "%I0.6") — shown as subtitle. */
  address?: string;
  /** Free-text comment from the tag table — shown as subtitle. */
  comment?: string;
  /** Source group (plan-325): 'internal' = model signal; default CONNECT. */
  origin?: 'connect' | 'internal';
}

/** Instrument Blue — the one accent of the product (DESIGN.md). */
const INSTRUMENT_BLUE = '#4fc3f7';

const LIST_HEIGHT = 260;
const LIST_WIDTH = 300;
const HEADER_ROW = 22;
const ITEM_ROW = 30;

type RowEntry =
  | { kind: 'header'; label: string }
  | { kind: 'item'; item: SignalSearchItem };

export function SignalSearchOverlay({
  open, anchorEl, onClose, signals, onPick, viewer, title, getRejectReason,
}: {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  signals: readonly SignalSearchItem[];
  onPick: (name: string, signal?: SignalSearchItem) => void;
  viewer?: RVViewer;
  /** Optional heading (e.g. the slot being wired). */
  title?: string;
  /**
   * Why the target slot would refuse this signal — `null` = it accepts
   * (plan-341 §2.8 a). ONE seam for everything: the selection lock, the Enter
   * key, `aria-disabled` and the shown reason text. Callers pass the very same
   * `slotRejectReason` the drop path uses, so click and drag can never diverge.
   * Omitted (e.g. force targeting) = every option stays selectable.
   */
  getRejectReason?: (item: SignalSearchItem) => DropRejectReason | null;
}) {
  const [q, setQ] = useState('');
  // Deferred filtering: keystrokes stay snappy, the (potentially large) list
  // catches up in a lower-priority render.
  const deferredQ = useDeferredValue(q);
  /**
   * Show the options the slot would refuse (User decision 30.07.: "when I click
   * Link signal I should only see suitable signals"). Default OFF — on a real
   * PLC tag table the compatible handful drowned in hundreds of refused rows.
   * The footer still names how many are hidden and opens them in one click, so
   * nothing disappears silently (the concern behind the old plan-341 F11 rule).
   */
  const [showAll, setShowAll] = useState(false);
  /** Ordinal (items only, headers excluded) of the option `aria-activedescendant` points at. */
  const [activeOrdinal, setActiveOrdinal] = useState(0);

  // Per-INSTANCE id namespace. `useId` yields ":r7:"; the colons are legal in an
  // id attribute but not in a CSS selector, so they are stripped — e2e and
  // devtools address these rows by id.
  const rawId = useId();
  const listId = `rv-siglist-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const optionId = useCallback((ordinal: number) => `${listId}-sigopt-${ordinal}`, [listId]);

  // Fresh query, fresh active option and a fresh (compatible-only) list every
  // time the overlay opens.
  useEffect(() => { if (open) { setQ(''); setActiveOrdinal(0); setShowAll(false); } }, [open]);

  // Grouped when at least one item carries an explicit origin (plan-325).
  const grouped = useMemo(() => signals.some((s) => s.origin !== undefined), [signals]);

  /**
   * An option is blocked either by a v1 duplicate-name conflict or by the
   * slot's own rejection rule — the SAME `slotRejectReason` the drop path asks
   * (plan-341 §2.8 a). Drives the list filter, the selection lock and the text.
   */
  const blockedText = useCallback((item: SignalSearchItem): string | null => {
    if (item.conflict) return 'Duplicate signal name — this entry is ambiguous';
    const reason = getRejectReason?.(item) ?? null;
    return reason ? dropRejectText(reason) : null;
  }, [getRejectReason]);

  /** Matches the query but refused by the slot — the count the footer offers. */
  const [rows, hiddenCount] = useMemo<[RowEntry[], number]>(() => {
    const s = deferredQ.trim().toLowerCase();
    // Search across ALL signal fields: name, protocol address and comment.
    const matched = s
      ? signals.filter((x) =>
        x.name.toLowerCase().includes(s)
        || (x.address?.toLowerCase().includes(s) ?? false)
        || (x.comment?.toLowerCase().includes(s) ?? false))
      : signals;
    const base = showAll ? matched : matched.filter((x) => !blockedText(x));
    const hidden = matched.length - base.length;
    if (!grouped) return [base.map((item) => ({ kind: 'item' as const, item })), hidden];
    const connect = base.filter((x) => (x.origin ?? 'connect') === 'connect');
    const internal = base.filter((x) => x.origin === 'internal');
    const out: RowEntry[] = [];
    if (connect.length > 0) {
      out.push({ kind: 'header', label: 'CONNECT (live)' });
      for (const item of connect) out.push({ kind: 'item', item });
    }
    if (internal.length > 0) {
      out.push({ kind: 'header', label: 'Model signals' });
      for (const item of internal) out.push({ kind: 'item', item });
    }
    return [out, hidden];
  }, [deferredQ, signals, grouped, showAll, blockedText]);

  const headerIndexes = useMemo(
    () => rows.flatMap((row, index) => (row.kind === 'header' ? [index] : [])),
    [rows],
  );

  /** Row index of every ITEM, in order — the bridge between ordinals and rows. */
  const itemRowIndexes = useMemo(
    () => rows.flatMap((row, index) => (row.kind === 'item' ? [index] : [])),
    [rows],
  );
  /** Reverse lookup so a rendered row finds its ordinal in O(1). */
  const ordinalByRow = useMemo(() => {
    const map = new Map<number, number>();
    itemRowIndexes.forEach((rowIndex, ordinal) => map.set(rowIndex, ordinal));
    return map;
  }, [itemRowIndexes]);

  // A filter change shortens the list under the active option — snap back to
  // the top rather than leaving the reference dangling (§2.8 d).
  //
  // Deliberately keyed on the QUERY only, not on `signals`: a live CONNECT
  // update re-creates that array, and resetting on it would yank the active
  // option back to the top while the user is arrowing. A list that shrinks for
  // any other reason is caught by the clamp below, which keeps the reference
  // valid — which is what the contract actually asks for.
  useEffect(() => { setActiveOrdinal(0); }, [deferredQ]);

  const activeIndex = itemRowIndexes.length === 0
    ? -1
    : Math.min(activeOrdinal, itemRowIndexes.length - 1);
  const activeRowIndex = activeIndex >= 0 ? itemRowIndexes[activeIndex] : -1;
  // No match → the attribute is REMOVED, never left pointing at a dead id.
  const activeDescendant = activeIndex >= 0 ? optionId(activeIndex) : undefined;

  // Sticky group headers (tanstack rangeExtractor pattern): the active header
  // is pinned into the rendered range and positioned sticky. The ACTIVE OPTION
  // is pinned the same way, so `aria-activedescendant` always resolves even
  // when the user has arrowed far outside the overscan window.
  const activeStickyRef = useRef(-1);
  const rangeExtractor = useCallback((range: Range) => {
    let sticky = -1;
    if (grouped) {
      for (const index of headerIndexes) {
        if (index <= range.startIndex) sticky = index;
        else break;
      }
    }
    activeStickyRef.current = sticky;
    const indexes = new Set(defaultRangeExtractor(range));
    if (sticky >= 0) indexes.add(sticky);
    if (activeRowIndex >= 0) indexes.add(activeRowIndex);
    return [...indexes].sort((a, b) => a - b);
  }, [headerIndexes, grouped, activeRowIndex]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'header' ? HEADER_ROW : ITEM_ROW),
    overscan: 8,
    rangeExtractor,
    // jsdom/tests report a 0-height scroll rect — seed a sane viewport.
    initialRect: { width: LIST_WIDTH, height: LIST_HEIGHT },
  });

  const pick = (item: SignalSearchItem): void => {
    if (blockedText(item)) return;
    onPick(item.name, item);
    onClose();
  };

  /**
   * Escape and click-away both land here: close, then hand focus back to the
   * assignment cell that opened us (§2.8 d).
   *
   * The focus call is deferred by one microtask on purpose. `onClose()` only
   * SCHEDULES the unmount; while the Popover is still mounted its focus trap
   * pulls any outside focus straight back, so focusing synchronously here would
   * leave focus on `<body>` once the trap finally goes away.
   */
  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    const cell = anchorEl;
    if (!cell) return;
    queueMicrotask(() => {
      if (cell.isConnected) cell.focus?.();
    });
  }, [onClose, anchorEl]);

  const moveActive = useCallback((next: number) => {
    if (itemRowIndexes.length === 0) return;
    const bounded = Math.max(0, Math.min(itemRowIndexes.length - 1, next));
    setActiveOrdinal(bounded);
    virtualizer.scrollToIndex(itemRowIndexes[bounded], { align: 'center' });
  }, [itemRowIndexes, virtualizer]);

  const onSearchKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveActive(activeIndex + 1); break;
      case 'ArrowUp': e.preventDefault(); moveActive(activeIndex - 1); break;
      case 'Home': e.preventDefault(); moveActive(0); break;
      case 'End': e.preventDefault(); moveActive(itemRowIndexes.length - 1); break;
      case 'Enter': {
        e.preventDefault();
        const row = activeRowIndex >= 0 ? rows[activeRowIndex] : undefined;
        // `pick` is inert for a blocked option — Enter and click share one rule.
        if (row?.kind === 'item') pick(row.item);
        break;
      }
      case 'Escape': e.preventDefault(); closeAndRestoreFocus(); break;
      default: break;
    }
  };

  const virtualItems = virtualizer.getVirtualItems();

  /**
   * Free positioning (User decision 30.07.). The picker opens anchored to the
   * slot row, which is right where the row it is about to change sits — the
   * user must be able to shove it aside and still see the row.
   *
   * The displacement is written to the paper's CSS `translate` PROPERTY, not to
   * `transform`: MUI's Grow transition owns `transform` (scale) and would wipe
   * a value written there. It also stays out of React state — a drag would
   * otherwise re-render the virtualized list on every pointermove.
   */
  const paperRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ x: 0, y: 0 });
  useEffect(() => { if (open) dragRef.current = { x: 0, y: 0 }; }, [open]);

  const onGripDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = { ...dragRef.current };
    const move = (ev: PointerEvent) => {
      dragRef.current = { x: base.x + (ev.clientX - startX), y: base.y + (ev.clientY - startY) };
      const el = paperRef.current;
      if (el) el.style.translate = `${dragRef.current.x}px ${dragRef.current.y}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  };

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={closeAndRestoreFocus}
      // Focus return is ours: the anchor is the assignment cell the user came
      // from, which is not necessarily what held focus before the popover opened.
      disableRestoreFocus
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{ paper: { ref: paperRef, sx: { bgcolor: '#1e1e1e', border: '1px solid rgba(255,255,255,0.12)' } } }}
    >
      <Box sx={{ width: LIST_WIDTH, p: 0.75 }}>
        {/* Titlebar = drag handle, same grip vocabulary as the AnchoredPopover
            windows, so "grip means movable" holds across the whole HMI. */}
        <Box
          onPointerDown={onGripDown}
          data-testid="signal-picker-grip"
          sx={{
            display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5,
            cursor: 'move', color: 'rgba(255,255,255,0.4)',
            '&:hover': { color: 'rgba(255,255,255,0.7)' },
          }}
        >
          <DragIndicatorIcon sx={{ fontSize: 13, transform: 'rotate(90deg)', flexShrink: 0 }} />
          {title && (
            <Typography sx={{ fontSize: 11, fontWeight: 700, color: INSTRUMENT_BLUE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </Typography>
          )}
        </Box>
        <TextField
          autoFocus
          fullWidth
          size="small"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search name, address, comment…"
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 14, color: 'rgba(255,255,255,0.5)' }} />
                </InputAdornment>
              ),
            },
            htmlInput: {
              role: 'combobox',
              'aria-expanded': true,
              'aria-controls': listId,
              'aria-activedescendant': activeDescendant,
              'aria-autocomplete': 'list',
              'aria-label': title ?? 'Search signals',
            },
          }}
          sx={{ '& .MuiInputBase-input': { fontSize: 11, py: 0.5 } }}
        />

        <Box
          ref={parentRef}
          id={listId}
          role="listbox"
          aria-label={title ?? 'Signals'}
          sx={{ maxHeight: LIST_HEIGHT, overflow: 'auto', mt: 0.5 }}
        >
          {signals.length === 0 ? (
            <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', textAlign: 'center', py: 1.5, px: 1, lineHeight: 1.5 }}>
              No interface connected.<br />Connect an interface to link signals.
            </Typography>
          ) : rows.length === 0 && (
            <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', textAlign: 'center', py: 1.5 }}>
              {hiddenCount > 0 ? 'No signal fits this slot' : 'No matches'}
            </Typography>
          )}
          {rows.length > 0 && (
            <Box role="presentation" sx={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualItems.map((vi) => {
                const row = rows[vi.index];
                if (!row) return null;
                const isActiveSticky = row.kind === 'header' && vi.index === activeStickyRef.current;
                const positionSx = isActiveSticky
                  ? { position: 'sticky' as const, top: 0, zIndex: 1 }
                  : { position: 'absolute' as const, top: 0, transform: `translateY(${vi.start}px)` };
                if (row.kind === 'header') {
                  return (
                    <Box
                      key={vi.key}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      role="presentation"
                      sx={{ ...positionSx, left: 0, width: '100%', bgcolor: '#1e1e1e', display: 'flex', alignItems: 'center', minHeight: HEADER_ROW, px: 0.5 }}
                    >
                      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' }}>
                        {row.label}
                      </Typography>
                    </Box>
                  );
                }
                const s = row.item;
                const blocked = blockedText(s);
                const ordinal = ordinalByRow.get(vi.index) ?? 0;
                const isActive = vi.index === activeRowIndex;
                return (
                  <Box
                    key={vi.key}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    // Positioning shell only. `role="presentation"` keeps it out
                    // of the listbox's owned set, so the listbox owns OPTIONS and
                    // nothing else; the `title` stays here because it is the
                    // pointer-hover reason and has to cover the whole band.
                    // No tabIndex: the search field owns focus and the option is
                    // addressed through aria-activedescendant (§2.8 d).
                    role="presentation"
                    title={blocked ?? undefined}
                    onClickCapture={(e) => {
                      if (blocked) return;
                      // The trailing SignalBadge normally uses click-to-force.
                      // Inside a picker the whole option has one meaning:
                      // select this signal. Capture the click before the nested
                      // badge can open force UI or stop the row event.
                      e.preventDefault();
                      e.stopPropagation();
                      pick(s);
                    }}
                    sx={{ ...positionSx, left: 0, width: '100%' }}
                  >
                    <SignalListItem
                      viewer={viewer}
                      name={s.name}
                      direction={s.direction}
                      plcType={s.plcType}
                      address={s.address}
                      comment={s.comment}
                      interfaceId={s.interfaceId}
                      topic={s.topic}
                      origin={s.origin}
                      role="option"
                      ariaLabel={s.name}
                      optionId={optionId(ordinal)}
                      ariaSelected={isActive}
                      ariaDisabled={!!blocked}
                      ariaDescribedBy={blocked ? `${optionId(ordinal)}-why` : undefined}
                      ariaSetSize={itemRowIndexes.length}
                      ariaPosInSet={ordinal + 1}
                      onClick={blocked ? undefined : () => pick(s)}
                      sx={{
                        px: 0.5, py: 0.25, borderRadius: 0.5, cursor: 'pointer',
                        minHeight: 24,
                        opacity: blocked ? 0.5 : 1,
                        // Blocked options stay READABLE and hoverable (the title
                        // carries the reason); only their activation is gone.
                        pointerEvents: s.conflict ? 'none' : undefined,
                        bgcolor: isActive ? 'rgba(79,195,247,0.14)' : undefined,
                        boxShadow: isActive ? 'inset 2px 0 0 #4fc3f7' : undefined,
                        '&:hover': { bgcolor: 'rgba(79,195,247,0.10)' },
                      }}
                    />
                    {blocked && (
                      // The reason, verbatim from `dropRejectText()`, as the
                      // option's DESCRIPTION. Sighted users get it from the
                      // row `title`; without this a screen-reader user would
                      // hear "dimmed" and never learn why.
                      <Box
                        component="span"
                        id={`${optionId(ordinal)}-why`}
                        sx={visuallyHidden}
                      >
                        {blocked}
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>

        {/* Nothing vanishes silently: the count is stated and one click brings
            the refused options back, each with its reason (plan-341 §2.8 a). */}
        {(hiddenCount > 0 || showAll) && (
          <ButtonBase
            data-testid="signal-picker-show-all"
            onClick={() => { setShowAll((v) => !v); setActiveOrdinal(0); }}
            sx={{
              mt: 0.5, px: 0.5, py: 0.25, borderRadius: 0.5, width: '100%',
              justifyContent: 'flex-start', fontSize: 11,
              color: showAll ? INSTRUMENT_BLUE : 'rgba(255,255,255,0.5)',
              '&:hover': { color: INSTRUMENT_BLUE, bgcolor: 'rgba(79,195,247,0.10)' },
              '&:focus-visible': { outline: `1px solid ${INSTRUMENT_BLUE}`, outlineOffset: 1 },
            }}
          >
            {showAll
              ? 'Hide signals that do not fit'
              : `${hiddenCount} ${hiddenCount === 1 ? 'signal does' : 'signals do'} not fit — show`}
          </ButtonBase>
        )}
      </Box>
    </Popover>
  );
}
