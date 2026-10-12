// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * IlluminatedPushButton — a momentary illuminated push button as on a control
 * box (plan-542 F2), drawn flat: a 40 px round cap in its IEC function colour
 * inside a bezel, a 3 px lamp ring around it in the colour the lamp is wired
 * with, and a legend plate below.
 *
 * Two colours, two meanings, two places (user decision, plan-542): the CAP says
 * what the button does (IEC 60204-1 §10.2), the RING says what the lamp shows
 * (the lamp colour as wired). A lit lamp lights the cap from inside and casts
 * its light around the ring (F10); a drawn dot beside the legend repeats the
 * state as a shape, so it never rests on colour alone.
 *
 * Layout (F11): the device fills its grid cell; the cap is centred and the
 * legend box below is the cell's full width and always two lines high, so
 * legends of every length sit centred under their caps on one baseline. The
 * lamp dot is positioned absolutely and never moves the legend.
 *
 * The press logic is {@link useMomentaryPress} from the ControlWindow kit —
 * `onRelease` runs exactly once per press, down every path a press can end.
 */

import { useState, type KeyboardEvent } from 'react';
import { Box } from '@mui/material';
import { useMomentaryPress } from '../ControlWindow';
import { ACCENT, IEC_BEZEL, IEC_CAP, IEC_LAMP, type IecCapColor } from '../shared-sx';
import { LegendBox } from './LegendBox';
import { lampRing, lampWords, litLens, NOT_DRIVEN_HINT, usePrefersReducedMotion, type LampState } from './PilotLamp';

export const CAP_SIZE = 40;
export const RING_WIDTH = 3;
/** Plate gap between ring and bezel. */
const RING_GAP = 2;
const BEZEL_WIDTH = 2;
/** Outer diameter of the device (ring included). */
export const BUTTON_OUTER = CAP_SIZE + 2 * (RING_WIDTH + RING_GAP);

export interface IlluminatedPushButtonProps {
  /** Accessible name — the function, e.g. "Acknowledge". */
  label: string;
  /** Legend plate text (shown uppercase). Defaults to `label`. */
  legend?: string;
  /** Cap colour by function (IEC 60204-1 §10.2). */
  cap: IecCapColor;
  /** The lamp as wired, or omit for a button without a lamp. */
  lamp?: LampState;
  onPress(): void;
  /** Omit for a one-shot action; supply it for press-and-hold. */
  onRelease?(): void;
  disabled?: boolean;
}

export function IlluminatedPushButton({
  label, legend, cap, lamp, onPress, onRelease, disabled,
}: IlluminatedPushButtonProps) {
  const [held, setHeld] = useState(false);
  const { press, release } = useMomentaryPress({ onPress, onRelease, disabled, onHeldChange: setHeld });
  const reduced = usePrefersReducedMotion();

  const ring = lamp ? lampRing(lamp, RING_WIDTH, reduced) : null;
  const glowing = !!ring?.glowing;
  const name = lamp ? `${label}, ${lampWords(lamp)}` : label;
  // The inner rim of a pressed cap: dark on a light cap, bezel grey on the black one.
  const rim = cap === 'black' ? IEC_BEZEL : 'rgba(0,0,0,0.4)';

  return (
    <Box
      component="button"
      type="button"
      aria-label={name}
      aria-pressed={held}
      disabled={disabled}
      title={ring?.look === 'not-driven' ? `${label}: lamp ${NOT_DRIVEN_HINT}` : undefined}
      data-lamp={ring?.look ?? 'none'}
      data-ring={ring?.stroke ?? 'none'}
      data-glow={glowing ? 'true' : 'false'}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== ' ' && e.key !== 'Enter') return;
        if (e.repeat) return;   // held key must not re-press
        e.preventDefault();     // and must not become a synthetic click
        press();
      }}
      onKeyUp={(e: KeyboardEvent) => {
        if (e.key !== ' ' && e.key !== 'Enter') return;
        e.preventDefault();
        release();
      }}
      sx={{
        all: 'unset',
        boxSizing: 'border-box',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '2px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        touchAction: 'none',
        userSelect: 'none',
        borderRadius: '4px',
        '&:focus-visible': { outline: `2px solid ${ACCENT}`, outlineOffset: '2px' },
      }}
    >
      {/* Lamp ring → plate gap → bezel → cap */}
      <Box
        aria-hidden
        data-part="ring"
        style={ring?.style}
        sx={{
          boxSizing: 'border-box',
          width: BUTTON_OUTER,
          height: BUTTON_OUTER,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          // No lamp: keep the footprint, draw no ring.
          ...(ring ? {} : { border: `${RING_WIDTH}px solid transparent` }),
        }}
      >
        <Box
          data-part="cap"
          data-cap={cap}
          sx={{
            boxSizing: 'border-box',
            width: CAP_SIZE,
            height: CAP_SIZE,
            borderRadius: '50%',
            background: glowing && lamp ? litLens(lamp.color, IEC_CAP[cap]) : IEC_CAP[cap],
            border: `${BEZEL_WIDTH}px solid ${IEC_BEZEL}`,
            transform: held ? 'scale(0.94)' : 'none',
            outline: held ? `2px solid ${rim}` : 'none',
            outlineOffset: '-6px',
            transition: reduced ? 'none' : 'transform 80ms ease-out',
          }}
        />
      </Box>
      <LegendBox lines={2} marker={glowing && lamp ? IEC_LAMP[lamp.color] : undefined}>
        {legend ?? label}
      </LegendBox>
    </Box>
  );
}
