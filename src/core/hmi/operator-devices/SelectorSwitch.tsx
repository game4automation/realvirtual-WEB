// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * SelectorSwitch — a two-position selector as on a control box (plan-542 F3),
 * drawn flat: a 36 px knob (or key cylinder) whose pointer turns to −45° / +45°,
 * the two position marks above it at the pointer's two end positions (like the
 * engraving of a switch plate, F11), the caption in a legend box below and an
 * optional lamp ring.
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
import { lampRing, lampWords, usePrefersReducedMotion, type LampState } from './PilotLamp';

export const KNOB_SIZE = 36;
const RING_WIDTH = 3;
const RING_GAP = 2;
const OUTER = KNOB_SIZE + 2 * (RING_WIDTH + RING_GAP);
/** The marks sit above the knob's shoulders; the knob's top rises between them. */
const MARK_OVERLAP = 8;

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
        sx={{
          justifySelf: i === 0 ? 'start' : 'end',
          px: 0.25,
          minWidth: 20,
          textAlign: 'center',
          fontSize: FS.label,
          lineHeight: `${LEGEND_LINE}px`,
          fontWeight: checked ? 700 : 500,
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          // The set position reads brightest; the other stays legible (≥ 4.5:1).
          color: checked ? INK_HIGH : INK_MID,
          cursor: disabled ? 'not-allowed' : 'pointer',
          borderRadius: '2px',
          userSelect: 'none',
          '&:focus-visible': { outline: `2px solid ${ACCENT}`, outlineOffset: '1px' },
        }}
      >
        {positions[i].legend}
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
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        justifyItems: 'center',
        // No row gap: the caption sits right under the ring, the marks overlap
        // the knob's shoulders (plan-543 — two stacked switches stay inside 400 px).
        rowGap: 0,
        opacity: disabled ? 0.4 : 1,
      }}
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
          gridColumn: '1 / -1',
          mt: `${-MARK_OVERLAP}px`,
          boxSizing: 'border-box',
          width: OUTER,
          height: OUTER,
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
            <Box sx={{ width: 8, height: 28, borderRadius: '3px', bgcolor: IEC_CAP.white, position: 'relative' }}>
              <Box sx={{ position: 'absolute', top: 3, left: 2, width: 4, height: 4, borderRadius: '50%', bgcolor: IEC_CAP.black }} />
            </Box>
          ) : (
            // The keyway of a key switch: a narrow slot with the key's bow on top.
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <Box sx={{ width: 10, height: 6, borderRadius: '3px 3px 1px 1px', bgcolor: IEC_BEZEL }} />
              <Box sx={{ width: 3, height: 16, bgcolor: IEC_BEZEL }} />
            </Box>
          )}
        </Box>
      </Box>
      <Box sx={{ gridColumn: '1 / -1', width: '100%' }} aria-hidden>
        <LegendBox tone={INK_MID}>{index < 0 ? `${caption ?? label} · no position` : caption ?? label}</LegendBox>
      </Box>
    </Box>
  );
}
