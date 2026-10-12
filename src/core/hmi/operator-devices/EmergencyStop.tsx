// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * EmergencyStop — a latching mushroom button as on a control box (plan-542 F4),
 * drawn flat: a red mushroom on a yellow collar, an optional lamp ring around
 * the collar.
 *
 * It behaves like the real device:
 *  - PRESS is instant — one pointer down, Space or Enter;
 *  - RELEASE is deliberate — the twist of the real mushroom becomes a hold of
 *    {@link RELEASE_HOLD_MS} on the pressed button (pointer, or Enter / Space
 *    held) with an arc filling up; letting go early releases nothing. `R`
 *    releases from the keyboard at once.
 *  - It is normally closed by default: the signal it writes is FALSE while it is
 *    pressed (`normallyClosed`).
 *
 * A lit collar lamp glows (F10). Its state word is "PRESSED" in red, in the
 * legend box below the device — and nothing when it is released. A
 * released E-stop is the normal state, not an achievement, so it is never
 * drawn green.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Box } from '@mui/material';
import { ACCENT, IEC_CAP, IEC_LAMP, IEC_PLATE, type IecLampColor } from '../shared-sx';
import { LegendBox } from './LegendBox';
import { lampRing, lampWords, usePrefersReducedMotion, type LampState } from './PilotLamp';

/** The deliberate hold that releases a pressed E-stop, in ms. */
export const RELEASE_HOLD_MS = 600;

export const ESTOP_PRESSED_WORD = 'PRESSED';

const SIZES = {
  full: { collar: 68, mushroom: 56, ring: 3, gap: 1 },
  mini: { collar: 26, mushroom: 20, ring: 2, gap: 1 },
} as const;

export interface EmergencyStopProps {
  /** Accessible name and legend, e.g. "E-stop 1". */
  label: string;
  /** The signal value as it is now. */
  value: boolean;
  /** Writes the signal. Called with the value for the NEW state. */
  onWrite(value: boolean): void;
  /** Normally closed: pressed = false. Default true. */
  normallyClosed?: boolean;
  /** The collar lamp as wired. */
  lamp?: Omit<LampState, 'color'> & { color?: IecLampColor };
  /** `full` = 56 px mushroom on a 68 px collar, legend below; `mini` = title-bar size, no legend. */
  size?: 'full' | 'mini';
  disabled?: boolean;
  /** Override the release hold (tests). */
  holdMs?: number;
}

export function EmergencyStop({
  label, value, onWrite, normallyClosed = true, lamp, size = 'full', disabled, holdMs = RELEASE_HOLD_MS,
}: EmergencyStopProps) {
  const pressed = normallyClosed ? !value : value;
  const reduced = usePrefersReducedMotion();
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fresh values for the timer callback.
  const live = useRef({ pressed, onWrite, normallyClosed, disabled });
  live.current = { pressed, onWrite, normallyClosed, disabled };

  const cancelHold = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    setHolding(false);
  }, []);

  const releaseNow = useCallback(() => {
    const l = live.current;
    if (l.disabled || !l.pressed) return;
    l.onWrite(l.normallyClosed);   // released: NC true, NO false
  }, []);

  const startHold = useCallback(() => {
    if (live.current.disabled || !live.current.pressed || timer.current !== null) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      releaseNow();
    }, holdMs);
  }, [holdMs, releaseNow]);

  const pressNow = useCallback(() => {
    const l = live.current;
    if (l.disabled || l.pressed) return;
    l.onWrite(!l.normallyClosed);  // pressed: NC false, NO true
  }, []);

  // A press that started on a released button must not turn into a hold.
  const onDown = () => {
    if (live.current.pressed) startHold();
    else pressNow();
  };

  useEffect(() => {
    const onBlur = () => cancelHold();
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('blur', onBlur); cancelHold(); };
  }, [cancelHold]);

  // The state flipped underneath a running hold (signal forced) — drop the hold.
  useEffect(() => { if (!pressed) cancelHold(); }, [pressed, cancelHold]);

  const dims = SIZES[size];
  const ring = lamp ? lampRing({ color: 'yellow', ...lamp }, dims.ring, reduced) : null;
  const outer = dims.collar + 2 * (dims.ring + dims.gap);
  const lampText = lamp ? `, ${lampWords({ color: 'yellow', ...lamp })}` : '';
  const hint = pressed ? 'Pressed — hold to release (or hold Enter, or press R)' : 'Press to stop';
  const circumference = Math.PI * (outer - dims.ring);

  const device = (
    <Box
      component="button"
      type="button"
      aria-label={`${label}${lampText}`}
      aria-pressed={pressed}
      disabled={disabled}
      title={`${label}: ${hint}`}
      data-estop={pressed ? 'pressed' : 'released'}
      data-holding={holding ? 'true' : 'false'}
      data-lamp={ring?.look ?? 'none'}
      onPointerDown={onDown}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'r' || e.key === 'R') { e.preventDefault(); releaseNow(); return; }
        if (e.key !== ' ' && e.key !== 'Enter') return;
        e.preventDefault();
        if (e.repeat) return;
        onDown();
      }}
      onKeyUp={(e: KeyboardEvent) => {
        if (e.key !== ' ' && e.key !== 'Enter') return;
        e.preventDefault();
        cancelHold();
      }}
      sx={{
        all: 'unset',
        boxSizing: 'border-box',
        position: 'relative',
        flex: '0 0 auto',
        width: Math.max(outer, 32),
        height: Math.max(outer, 32),
        display: 'grid',
        placeItems: 'center',
        borderRadius: '50%',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        touchAction: 'none',
        userSelect: 'none',
        '&:focus-visible': { outline: `2px solid ${ACCENT}`, outlineOffset: '2px' },
      }}
    >
      <Box
        aria-hidden
        data-part="ring"
        style={ring?.style}
        sx={{
          boxSizing: 'border-box',
          width: outer,
          height: outer,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          ...(ring ? {} : { border: `${dims.ring}px solid transparent` }),
        }}
      >
        {/* Yellow collar → plate-coloured edge → red mushroom */}
        <Box
          data-part="collar"
          sx={{
            boxSizing: 'border-box',
            width: dims.collar,
            height: dims.collar,
            borderRadius: '50%',
            bgcolor: IEC_CAP.yellow,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <Box
            data-part="mushroom"
            sx={{
              boxSizing: 'border-box',
              width: dims.mushroom,
              height: dims.mushroom,
              borderRadius: '50%',
              bgcolor: IEC_CAP.red,
              // The collar's yellow and the cap's red differ by only 2.6:1 —
              // a plate-coloured edge separates them.
              border: `${size === 'mini' ? 1 : 2}px solid ${IEC_PLATE}`,
              // Pressed: the mushroom sits lower — smaller, with an inner rim.
              transform: pressed ? 'scale(0.9)' : 'none',
              outline: pressed ? `2px solid ${IEC_PLATE}` : 'none',
              outlineOffset: size === 'mini' ? '-5px' : '-10px',
              transition: reduced ? 'none' : 'transform 80ms ease-out',
            }}
          />
        </Box>
      </Box>
      {holding && (
        <svg
          aria-hidden
          data-part="release-arc"
          width={outer}
          height={outer}
          viewBox={`0 0 ${outer} ${outer}`}
          style={{ position: 'absolute', inset: 0, margin: 'auto', transform: 'rotate(-90deg)', pointerEvents: 'none' }}
        >
          <circle
            cx={outer / 2}
            cy={outer / 2}
            r={(outer - dims.ring) / 2}
            fill="none"
            stroke={IEC_LAMP.white}
            strokeWidth={dims.ring}
            strokeDasharray={circumference}
            strokeDashoffset={circumference}
          >
            <animate
              attributeName="stroke-dashoffset"
              from={String(circumference)}
              to="0"
              dur={`${holdMs}ms`}
              fill="freeze"
            />
          </circle>
        </svg>
      )}
    </Box>
  );

  if (size === 'mini') return device;

  // On the panel grid: the device centred, its legend box below (F11) — the
  // name, and the state word in red while pressed. Released shows nothing.
  return (
    <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
      {device}
      <LegendBox lines={2}>
        {label}
        {pressed && (
          <Box component="span" data-part="state" sx={{ display: 'block', fontWeight: 700, color: IEC_LAMP.red }}>
            {holding ? 'RELEASING…' : ESTOP_PRESSED_WORD}
          </Box>
        )}
      </LegendBox>
    </Box>
  );
}
