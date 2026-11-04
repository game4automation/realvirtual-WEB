// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * SelectorSwitch — a two-position selector as on a control box (plan-542 F3),
 * drawn flat: a knob (or key cylinder) whose pointer turns to −45° / +45°, the
 * two position marks engraved at the pointer's two end positions — up-left
 * and up-right of the knob, like on a cam switch plate — the caption in a
 * legend box below and an optional lamp ring.
 *
 * Layout (the panel's grid contract, shared with the push button): the face
 * — ring, plate gap, bezel — has exactly the push button's footprint
 * ({@link BUTTON_OUTER}) and the legend box is two lines high, so a selector
 * and a button in one row put their faces on one centre line and their
 * legends on one baseline. The marks live in a band ABOVE the face; the panel
 * aligns the devices of a row at the bottom, so the band never pushes a face
 * down. Each mark is centred on its end angle and grows only outwards; it
 * never comes closer than {@link MARK_GAP} to the knob's axis and never leaves
 * its cell. A lit ring is a border + box-shadow of the same reserved box: a
 * lamp or a turn changes nothing that is laid out.
 *
 * It latches: clicking the knob turns it to the other position, clicking a
 * mark selects that position, ArrowLeft / ArrowRight do the same from the
 * keyboard. A `radiogroup` of two radios — the marks — so a screen reader hears
 * the positions and which one is set. `value === null` is a real state (the
 * signal matches neither position): the pointer stands upright.
 */

import { useRef, type KeyboardEvent } from 'react';
import { Box } from '@mui/material';
import { ACCENT, FS, IEC_BEZEL, IEC_CAP, INK_HIGH, INK_MID } from '../shared-sx';
import { LEGEND_LINE, LegendBox } from './LegendBox';
import { BUTTON_OUTER, CAP_SIZE } from './IlluminatedPushButton';
import { lampRing, lampWords, usePrefersReducedMotion, type LampState } from './PilotLamp';

/** Knob diameter: the same 22 mm device as a push button cap. */
export const KNOB_SIZE = CAP_SIZE;
const RING_WIDTH = 3;
/** The face incl. lamp ring — identical to a push button's. */
const OUTER = BUTTON_OUTER;
/** Height of the mark band above the face; the marks reach a little into the face's corners. */
export const MARK_BAND = 10;
/** Closest a mark's inner edge comes to the knob's axis, in px. */
export const MARK_GAP = 5;
/** Least distance between a mark and its cell's edge, in px — the neighbour's marks stay farther away than the own pair. */
const MARK_EDGE = 3;
/** Farthest a mark's centre sits from the knob's axis (the 45° point just outside the ring), in px. */
const MARK_REACH = 26;

export interface SelectorPosition {
  id: string;
  /** Position mark, e.g. "0", "I", "Hand", "Auto" (shown uppercase). */
  legend: string;
}

export interface SelectorSwitchProps {
  /** Accessible name of the group, e.g. "Control". */
  label: string;
  /** Caption in the legend box below (shown uppercase). Defaults to `label`. */
  caption?: string;
  /** Left, then right position. */
  positions: readonly [SelectorPosition, SelectorPosition];
  value: string | null;
  onChange(id: string): void;
  /** `knob` = a turn knob, `key` = a key switch. */
  variant?: 'knob' | 'key';
  lamp?: LampState;
  disabled?: boolean;
}

export function SelectorSwitch({
  label, caption, positions, value, onChange, variant = 'knob', lamp, disabled,
}: SelectorSwitchProps) {
  const reduced = usePrefersReducedMotion();
  const radios = useRef<(HTMLSpanElement | null)[]>([]);
  const index = positions.findIndex((p) => p.id === value);
  const angle = index === 0 ? -45 : index === 1 ? 45 : 0;
  const ring = lamp ? lampRing(lamp, RING_WIDTH, reduced) : null;
  const unmatched = index < 0 && !disabled;

  const select = (i: number) => {
    if (disabled) return;
    if (positions[i].id !== value) onChange(positions[i].id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const next = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 0
      : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : null;
    if (next === null) return;
    e.preventDefault();
    select(next);
    radios.current[next]?.focus();
  };

  const mark = (i: number) => {
    const checked = i === index;
    const left = i === 0;
    // The mark's box runs from the cell edge (less MARK_EDGE, or MARK_REACH * 2
    // - MARK_GAP from the axis, whichever is nearer) to MARK_GAP from the axis; the text
    // is centred in it. A short mark therefore sits on its end angle, a long
    // one grows outwards only — and both marks mirror each other.
    const outer = `max(${MARK_EDGE}px, calc(50% - ${2 * MARK_REACH - MARK_GAP}px))`;
    const inner = `calc(50% + ${MARK_GAP}px)`;
    return (
      <Box
        component="span"
        role="radio"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        // Roving tab stop: the set position, or the first one when none is set.
        tabIndex={checked || (index < 0 && i === 0) ? 0 : -1}
        ref={(el: HTMLSpanElement | null) => { radios.current[i] = el; }}
        onClick={() => select(i)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); select(i); }
        }}
        data-mark={left ? 'left' : 'right'}
        sx={{
          position: 'absolute',
          top: 0,
          height: LEGEND_LINE,
          ...(left ? { left: outer, right: inner } : { left: inner, right: outer }),
          display: 'flex',
          justifyContent: 'center',
          // A size under the legend's, like the engraving of a switch plate —
          // and so that two marks fit above a knob in a narrow column.
          fontSize: FS.micro,
          lineHeight: `${LEGEND_LINE}px`,
          // One weight for both: the set position is told by brightness, so
          // switching never re-flows the marks.
          fontWeight: 600,
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          // The set position reads brightest; the other stays legible (≥ 4.5:1).
          color: checked ? INK_HIGH : INK_MID,
          cursor: disabled ? 'not-allowed' : 'pointer',
          borderRadius: '2px',
          userSelect: 'none',
          zIndex: 1,
          '&:focus-visible': { outline: `2px solid ${ACCENT}`, outlineOffset: '1px' },
        }}
      >
        <Box component="span" data-part="mark-text">{positions[i].legend}</Box>
      </Box>
    );
  };

  return (
    <Box
      role="radiogroup"
      aria-label={lamp ? `${label}, ${lampWords(lamp)}` : label}
      aria-disabled={disabled || undefined}
      data-variant={variant}
      onKeyDown={onKeyDown}
      sx={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // The same 2 px between face and legend as a push button.
        gap: '2px',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Box
        data-part="face"
        sx={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center', pt: `${MARK_BAND}px` }}
      >
        {mark(0)}
        {mark(1)}
        <Box
          aria-hidden
          data-part="ring"
          data-lamp={ring?.look ?? 'none'}
          data-ring={ring?.stroke ?? 'none'}
          data-glow={ring?.glowing ? 'true' : 'false'}
          style={ring?.style}
          onClick={() => select(index === 0 ? 1 : 0)}
          sx={{
            boxSizing: 'border-box',
            width: OUTER,
            height: OUTER,
            flex: '0 0 auto',
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            cursor: disabled ? 'not-allowed' : 'pointer',
            ...(ring ? {} : { border: `${RING_WIDTH}px solid transparent` }),
          }}
        >
          <Box
            data-part="knob"
            data-angle={angle}
            sx={{
              boxSizing: 'border-box',
              width: KNOB_SIZE,
              height: KNOB_SIZE,
              borderRadius: '50%',
              bgcolor: IEC_CAP.black,
              border: `2px solid ${IEC_BEZEL}`,
              display: 'grid',
              placeItems: 'center',
              transform: `rotate(${angle}deg)`,
              transition: reduced ? 'none' : 'transform 150ms ease-out',
            }}
          >
            {variant === 'knob' ? (
              // The grip bar across the knob; the dot at its top end is the pointer.
              <Box sx={{ width: 8, height: 30, borderRadius: '3px', bgcolor: IEC_CAP.white, position: 'relative' }}>
                <Box sx={{ position: 'absolute', top: 3, left: 2, width: 4, height: 4, borderRadius: '50%', bgcolor: IEC_CAP.black }} />
              </Box>
            ) : (
              // The keyway of a key switch: a narrow slot with the key's bow on top.
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <Box sx={{ width: 10, height: 6, borderRadius: '3px 3px 1px 1px', bgcolor: IEC_BEZEL }} />
                <Box sx={{ width: 3, height: 18, bgcolor: IEC_BEZEL }} />
              </Box>
            )}
          </Box>
        </Box>
      </Box>
      <Box sx={{ width: '100%' }} aria-hidden>
        {/* "no position" only on a LIVE switch whose signal matches neither
            position — a disabled panel has no reading at all, and the long
            legend would not fit two lines of a narrow cell. */}
        <LegendBox lines={2} tone={unmatched ? INK_MID : undefined}>{unmatched ? `${caption ?? label} · no position` : caption ?? label}</LegendBox>
      </Box>
    </Box>
  );
}
