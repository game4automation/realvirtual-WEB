// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentCrumbs — the breadcrumb row of the document card (plan-709 §2.1).
 *
 * Chevron separators, the location in disabled ink, the chain in secondary
 * ink, the current leaf in high ink at weight 600, a stale frame in italic.
 *
 * ## It fits, it never scrolls
 *
 * The row used to be `overflow-x: auto` — the house form of the mobile
 * selection sheet, where a finger can flick a trail sideways. In a docked
 * header a scrollbar under the panel title is noise, and a long name pushed
 * the Save button off the row before anyone noticed the bar was there.
 *
 * The row now takes the width it is given and fills it in one order of
 * priority, three groups deep:
 *
 *  1. **the open document** — the answer to "what am I editing" — is placed
 *     first, at its natural width, and is the last thing to be truncated;
 *  2. **the ancestors** — the frames a descend passed through — take what is
 *     left over;
 *  3. **the location** (`Development › Library`) takes what is left after
 *     that.
 *
 * Leftover space rather than proportional shrink, and THREE groups rather than
 * one flex item per chip. Both were learned the hard way:
 *
 *  - A floor per chip summed past the panel's own width, so the row still
 *    overflowed although every chip could ellipsize on its own.
 *  - Proportional shrink never lands on zero. Whatever it leaves behind —
 *    four pixels, say — the browser fills with the first glyph of the group,
 *    and the title ends up behind a fragment of a chevron or a stranded `D…`.
 *
 * So a group is offered only space nobody above it wanted, and a group offered
 * less than {@link MIN_LEGIBLE_PREFIX} is closed outright rather than shown as
 * a sliver ({@link useLegiblePrefix}). Everything that survives is whole words
 * or an honest `Warehouse L…`, and the complete trail is always in the row's
 * `title`, so nothing that closed is actually lost.
 *
 * `tests/document-card-compact-fit.test.tsx` pins all of this as geometry.
 *
 * ## Dirty marks are opt-in, and the card opts out
 *
 * The chain used to dot every dirty frame unconditionally. In the document
 * card that produced two amber dots on one line — the card's own leading mark
 * and the trail's — which reads as two facts about two things. The card
 * carries the mark and the trail is the name, so `showDirtyMarks` is off by
 * default. The floating stack bar turns it on: it lists several frames, has no
 * mark of its own in front, and "which of these has unsaved work" is exactly
 * the question it exists to answer.
 *
 * Clicking a chip is navigation, not a jump: the handler climbs one frame at a
 * time (§2.7.3 of plan-703). A row without `onCrumbClick` renders plain text,
 * which is what the single-chip scene case needs.
 */

import type { KeyboardEvent, RefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { ChevronRight } from '@mui/icons-material';
import type { RvStackCrumb } from '../../ops/rv-document-stack';
import { DirtyDot } from '../rv-dirty-dot';

export interface DocumentCrumbsProps {
  crumbs: RvStackCrumb[];
  /**
   * Storage location, rendered as dimmed segments in FRONT of the chain.
   *
   * The chain alone says which document and how deep the descend went, never
   * where the thing lives — so a card showed a bare leaf name and the user had
   * to remember the rest. These segments are location and not navigation: they
   * stay plain text even when the chain behind them is clickable.
   */
  location?: string[];
  /** Called for a chip that is not the current one. Absent = plain text. */
  onCrumbClick?: (crumb: RvStackCrumb) => void;
  /** `data-testid` stem; the current chip gets `-current`. */
  testIdPrefix?: string;
  /** Chip font size in px. 12 in the compact card, 16 in the hero. */
  fontSize?: number;
  /**
   * Dot each dirty frame inside the trail. Off by default — see the module
   * doc: a surface that shows its own dirty mark must not show a second one.
   */
  showDirtyMarks?: boolean;
  ariaLabel?: string;
}

/**
 * Who gets the space that is left — ancestors before location.
 *
 * Used as `flex-grow` against a zero basis, so a prefix group is only ever
 * offered what the open document did not need. `max-content` caps each group
 * at its own text, and flexbox hands the surplus of a capped item on to the
 * next, which is what makes "ancestors first, then location" a priority rather
 * than a ratio.
 */
const GROW_ANCESTORS = 100;
const GROW_LOCATION = 1;

/**
 * The open document holds on to this much before it starts ellipsizing.
 *
 * It is also the reason the prefix is sized from LEFTOVER space rather than by
 * shrinking: every floor wide enough to hold an ellipsis is also wide enough to
 * strand one letter in front of it, and the browser fills that space before it
 * truncates — `D… › W… › AGV - Forklifter…`. Two one-letter stubs are not
 * context; they read as a rendering fault and they cost the name the width it
 * needed.
 */
const MIN_CURRENT = '5ch';

/**
 * Narrower than this a prefix group is a fragment, not context, so it is not
 * shown at all (see {@link useLegiblePrefix}).
 *
 * Leftover-space allocation alone gets close but cannot land on a clean zero:
 * whatever the open document leaves over — four pixels, say — is handed to a
 * group that then paints four pixels of the first glyph in front of the title.
 * `40px` is about four characters plus the ellipsis: enough that a truncated
 * group still says something ("Devel…"), and the threshold below which the row
 * is better off giving those pixels to the name.
 */
const MIN_LEGIBLE_PREFIX = 40;

const ELLIPSIZE = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/** A prefix group: zero by default, grown only into space nobody else wants. */
const PREFIX_GROUP = {
  ...ELLIPSIZE,
  display: 'block',
  flexBasis: 0,
  flexShrink: 1,
  minWidth: 0,
  maxWidth: 'max-content',
} as const;

/** Refs the measurement reads. `null` for a group this trail does not render. */
interface PrefixRefs {
  row: RefObject<HTMLElement | null>;
  location: RefObject<HTMLElement | null>;
  ancestors: RefObject<HTMLElement | null>;
  current: RefObject<HTMLElement | null>;
}

/**
 * Decides which prefix groups are wide enough to be worth showing.
 *
 * Reads `scrollWidth`, which reports a group's NATURAL content width even
 * while the group is squeezed to nothing. That is what makes this stable: the
 * numbers the decision is made from do not move when the decision changes
 * them, so hiding a group cannot feed back into hiding the next one. The
 * layout itself stays CSS — this only closes groups that CSS would otherwise
 * render as a sliver.
 */
function useLegiblePrefix(refs: PrefixRefs, signature: string) {
  const [shown, setShown] = useState({ location: true, ancestors: true });
  useLayoutEffect(() => {
    const row = refs.row.current;
    if (!row) return;
    const recompute = () => {
      const natural = (r: RefObject<HTMLElement | null>) => r.current?.scrollWidth ?? 0;
      const free = row.clientWidth - Math.min(natural(refs.current), row.clientWidth);
      const ancestors = natural(refs.ancestors) > 0 && free >= MIN_LEGIBLE_PREFIX;
      const rest = ancestors ? free - Math.min(free, natural(refs.ancestors)) : free;
      const location = natural(refs.location) > 0 && rest >= MIN_LEGIBLE_PREFIX;
      setShown((prev) =>
        prev.location === location && prev.ancestors === ancestors
          ? prev
          : { location, ancestors });
    };
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(row);
    return () => observer.disconnect();
    // `signature` stands for the trail's content: new crumbs, new measurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return shown;
}

/** Separator. `verticalAlign` for the inline runs, `flexShrink` for the row. */
function Chevron() {
  return (
    <ChevronRight
      sx={{ fontSize: 14, color: 'text.disabled', flexShrink: 0, verticalAlign: 'middle' }}
    />
  );
}

export function DocumentCrumbs({
  crumbs,
  location,
  onCrumbClick,
  testIdPrefix = 'stack-crumb',
  fontSize = 11,
  showDirtyMarks = false,
  ariaLabel = 'Document stack',
}: DocumentCrumbsProps) {
  const segments = location ?? [];
  const ancestors = crumbs.filter((c) => !c.current);
  const current = crumbs.find((c) => c.current) ?? null;
  const fullTrail = [...segments, ...crumbs.map((c) => c.label)].join(' › ');

  const rowRef = useRef<HTMLElement | null>(null);
  const locationRef = useRef<HTMLElement | null>(null);
  const ancestorsRef = useRef<HTMLElement | null>(null);
  const currentRef = useRef<HTMLElement | null>(null);
  const shown = useLegiblePrefix(
    { row: rowRef, location: locationRef, ancestors: ancestorsRef, current: currentRef },
    `${fullTrail}|${fontSize}`,
  );

  /** Closed, but still measurable — width zero, content intact behind it. */
  const CLOSED = { flexGrow: 0, maxWidth: 0 } as const;

  const chipSx = (c: RvStackCrumb, clickable: boolean) => ({
    fontSize,
    fontWeight: c.current ? 600 : 400,
    color: c.current ? 'text.primary' : 'text.secondary',
    fontStyle: c.stale ? 'italic' : 'normal',
    ...(clickable
      ? {
          cursor: 'pointer',
          '&:hover': { color: 'text.primary' },
          '&:focus-visible': {
            outline: '1px solid', outlineColor: 'primary.main', outlineOffset: 1,
            borderRadius: '2px',
          },
        }
      : {}),
  });

  /**
   * A clickable crumb is a `span`, not a `button` — the one non-obvious call
   * in this file.
   *
   * `text-overflow: ellipsis` truncates INLINE TEXT. A `<button>` is an atomic
   * inline-level box: the group's ellipsis cannot reach inside it, so an
   * ancestor chip under pressure was chopped mid-glyph ("Wa|") while the plain
   * spans beside it ellipsized properly ("Deve…"). Since the whole point of
   * the group is that it degrades as one continuous run, the chips have to BE
   * text, and the button contract is carried explicitly: the role a screen
   * reader announces, a tab stop, and Enter/Space activation.
   */
  const activate = (c: RvStackCrumb) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onCrumbClick!(c);
  };

  return (
    <Box
      aria-label={ariaLabel}
      title={fullTrail}
      // A fixed id, NOT one derived from `testIdPrefix`: the tests select the
      // chips with `/^document-crumb/`, and a container sharing that stem
      // would join every list of chip labels as a row that is all of them.
      data-testid="document-trail"
      ref={rowRef}
      sx={{
        // No `gap`: a closed group must cost exactly nothing, and a gap would
        // leave its spacing behind. The chevrons carry the spacing instead,
        // and they live inside the group they belong to.
        flex: 1, minWidth: 0, display: 'flex', alignItems: 'center',
        overflow: 'hidden', whiteSpace: 'nowrap',
      }}
    >
      {segments.length > 0 && (
        <Box
          data-testid="document-location"
          data-shown={shown.location}
          ref={locationRef}
          sx={{
            ...PREFIX_GROUP, flexGrow: GROW_LOCATION,
            ...(shown.location ? {} : CLOSED),
          }}
        >
          {segments.map((segment, i) => (
            <Typography
              key={`loc:${i}:${segment}`}
              data-testid="document-location-crumb"
              component="span"
              sx={{ fontSize, fontWeight: 400, color: 'text.disabled' }}
            >
              {segment}
              {i < segments.length - 1 && <Chevron />}
            </Typography>
          ))}
        </Box>
      )}

      {ancestors.length > 0 && (
        <Box
          data-testid="document-ancestors"
          data-shown={shown.ancestors}
          ref={ancestorsRef}
          sx={{
            ...PREFIX_GROUP, flexGrow: GROW_ANCESTORS,
            ...(shown.ancestors ? {} : CLOSED),
          }}
        >
          {/* LEADING, not trailing. A separator at the end of a group is the
              first thing an ellipsis eats, and the row then read as one run:
              "Warehouse Lay… AGV - Forklifter". The start of a group is the
              one place truncation never reaches. */}
          {segments.length > 0 && shown.location && <Chevron />}
          {ancestors.map((c, i) => {
            const clickable = !!onCrumbClick;
            return (
              <Typography
                key={`${c.index}:${c.occurrence}`}
                data-testid={testIdPrefix}
                component="span"
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => onCrumbClick!(c) : undefined}
                onKeyDown={clickable ? activate(c) : undefined}
                sx={chipSx(c, clickable)}
              >
                {c.label}
                {showDirtyMarks && c.dirty && (
                  <DirtyDot size={6} sx={{ ml: 0.5 }} title={`${c.label} has unsaved changes`} />
                )}
                {i < ancestors.length - 1 && <Chevron />}
              </Typography>
            );
          })}
        </Box>
      )}

      {/* The one separator that cannot be truncated away, because it is not
          inside anything that truncates. Absent when the whole prefix closed:
          a chevron pointing back at nothing is a worse use of 14px than four
          more characters of the name. */}
      {((segments.length > 0 && shown.location) || (ancestors.length > 0 && shown.ancestors)) && (
        <Chevron />
      )}

      {current && (
        <Typography
          data-testid={`${testIdPrefix}-current`}
          component="span"
          ref={currentRef}
          sx={{
            ...ELLIPSIZE, display: 'block',
            // Natural width first, and it is the only item allowed to keep
            // any: the prefix groups start at zero and grow into what is left.
            flexGrow: 0, flexShrink: 1, flexBasis: 'auto', minWidth: MIN_CURRENT,
            ...chipSx(current, false),
          }}
        >
          {current.label}
          {showDirtyMarks && current.dirty && (
            <DirtyDot size={6} sx={{ ml: 0.5 }} title={`${current.label} has unsaved changes`} />
          )}
        </Typography>
      )}
    </Box>
  );
}
