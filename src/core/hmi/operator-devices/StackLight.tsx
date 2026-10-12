// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * StackLight — a compact signal tower (plan-542 F5): its segments stacked top
 * to bottom in the order the 3D tower shows them, each lit in its lamp colour
 * with its light (F10), or drawn as an unlit outline (dotted when nothing
 * drives it).
 *
 * `role="img"`, named with the lit segments in words ("Signal tower: green on")
 * — the tower's state never rests on colour alone.
 */

import { Box } from '@mui/material';
import { IEC_LAMP, IEC_LAMP_OFF, type IecLampColor } from '../shared-sx';
import { lampLook, NOT_DRIVEN_HINT } from './PilotLamp';

/** Segment size in px: `mini` is the title-bar tower, still legible at a glance (F11). */
const SEGMENT = { mini: { w: 10, h: 6 }, full: { w: 16, h: 10 } } as const;

export interface StackLightSegment {
  /** Segment name, e.g. "Green". */
  name: string;
  color: IecLampColor;
  on: boolean;
  flash?: boolean;
  /** False when nothing drives this segment in the current mode. Default true. */
  driven?: boolean;
}

export interface StackLightProps {
  /** Top to bottom. */
  segments: readonly StackLightSegment[];
  /** Accessible name of the tower. Default "Signal tower". */
  label?: string;
  /** `mini` = title-bar size (10 × 6 px segments), `full` = 16 × 10 px. */
  size?: 'mini' | 'full';
}

export function stackLightWords(segments: readonly StackLightSegment[]): string {
  const lit = segments.filter((s) => s.on || s.flash).map((s) => `${s.name.toLowerCase()} ${s.flash ? 'flashing' : 'on'}`);
  return lit.length > 0 ? lit.join(', ') : 'all off';
}

export function StackLight({ segments, label = 'Signal tower', size = 'mini' }: StackLightProps) {
  const { w, h } = SEGMENT[size];
  const words = stackLightWords(segments);
  return (
    <Box
      role="img"
      aria-label={`${label}: ${words}`}
      title={`${label}: ${words}`}
      sx={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: '0 0 auto' }}
    >
      {segments.map((s) => {
        const look = lampLook({ color: s.color, on: s.on, flash: s.flash, driven: s.driven });
        // A tower segment is too small to carry a flash pattern; flashing reads as lit, in words as flashing.
        const lit = look === 'on' || look === 'flash';
        return (
          <Box
            key={s.name}
            component="span"
            aria-label={`Tower ${s.name.toLowerCase()}`}
            title={look === 'not-driven' ? `${s.name}: ${NOT_DRIVEN_HINT}` : undefined}
            data-on={s.on ? 'true' : 'false'}
            data-lamp={look}
            data-glow={lit ? 'true' : 'false'}
            sx={{
              display: 'block',
              boxSizing: 'border-box',
              width: w,
              height: h,
              borderRadius: '1px',
              bgcolor: lit ? IEC_LAMP[s.color] : 'transparent',
              // A lit segment emits its light (F10); an unlit one none.
              boxShadow: lit ? `0 0 6px ${IEC_LAMP[s.color]}b3` : 'none',
              border: lit ? 'none' : `1px ${look === 'not-driven' ? 'dotted' : 'solid'} ${IEC_LAMP_OFF}`,
            }}
          />
        );
      })}
    </Box>
  );
}
