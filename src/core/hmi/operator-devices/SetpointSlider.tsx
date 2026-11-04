// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * SetpointSlider — the analog INPUT of an operator panel (plan-659): a setpoint
 * potentiometer on the enclosure plate, drawn flat like every other device
 * here, with its caption and live value on one line above the track.
 *
 * Why the panel needs one at all: a control box is boolean, and every other
 * device in this folder is. A setpoint dial is the one device on a real
 * enclosure that is not — a speed command, a force, the strength of a
 * disturbance. Without it those have to be faked as a ladder of buttons.
 *
 * It writes a NUMBER to its signal, live while dragged (an operator turning a
 * dial expects the machine to follow, not to wait for the release), and
 * `onCommit` once when the drag ends for work too expensive to do per frame.
 * The value is OWNED by the signal: the slider renders what it reads back, so a
 * PLC or an MCP write moves the thumb exactly like a hand does.
 */

import { Box, Slider } from '@mui/material';
import { ACCENT, FS, INK_HIGH, INK_MID, MONO } from '../shared-sx';
import { LEGEND_LINE, LEGEND_LINE_COMPACT } from './LegendBox';

/** Track inset = the thumb radius (+1): the rail, the caption and the value share one left and one right edge. */
const TRACK_INSET = 7;

export interface SetpointSliderProps {
  /** Accessible name. */
  label: string;
  /** Legend plate text; defaults to `label`. */
  caption?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Unit shown after the live value, e.g. "m/s". */
  unit?: string;
  /** Decimals of the live value. Default 0. */
  decimals?: number;
  disabled?: boolean;
  /**
   * Tighter value line and track padding, for a plate packed `compact`
   * (plan-659). The thumb keeps its size — it is a drag target. Default off.
   */
  compact?: boolean;
  /** Live, on every move of the thumb. */
  onChange(value: number): void;
  /** Once, when the drag ends. */
  onCommit?(value: number): void;
}

export function SetpointSlider({
  label, caption, value, min, max, step = 1, unit, decimals = 0, disabled, compact, onChange, onCommit,
}: SetpointSliderProps) {
  const shown = Number.isFinite(value) ? value.toFixed(decimals) : '--';
  const line = compact ? LEGEND_LINE_COMPACT : LEGEND_LINE;
  return (
    <Box
      data-device="setpoint-slider"
      data-signal-value={Number.isFinite(value) ? value : ''}
      sx={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}
    >
      {/* Caption and reading on ONE line above the track, as on a panel
          meter's scale plate: the name where the track starts, the value
          where it ends — the thumb never covers either. */}
      <Box
        data-part="caption-line"
        sx={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1,
          px: `${TRACK_INSET}px`, minHeight: line,
        }}
      >
        <Box
          component="span"
          data-part="caption"
          sx={{
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: compact ? FS.micro : FS.label, fontWeight: 500, lineHeight: `${line}px`,
            letterSpacing: '0.02em', textTransform: 'uppercase', color: INK_HIGH,
          }}
        >
          {caption ?? label}
        </Box>
        <Box
          component="span"
          data-part="value"
          sx={{
            flex: '0 0 auto',
            fontFamily: MONO,
            fontSize: compact ? FS.label : FS.body,
            fontWeight: 600,
            lineHeight: `${line}px`,
            color: disabled ? INK_MID : ACCENT,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {shown}{unit ? ` ${unit}` : ''}
        </Box>
      </Box>
      <Slider
        size="small"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        disabled={disabled}
        aria-label={label}
        onChange={(_, v) => onChange(Array.isArray(v) ? v[0] : v)}
        onChangeCommitted={(_, v) => onCommit?.(Array.isArray(v) ? v[0] : v)}
        sx={{
          // The full cell width, minus the thumb radius on each side so the
          // track ends where the caption line does.
          width: `calc(100% - ${2 * TRACK_INSET}px)`,
          mx: `${TRACK_INSET}px`,
          py: compact ? 0.75 : 1,
          color: ACCENT,
          // The panel's own drag gesture and the thumb's are the same gesture;
          // FloatingPanel lets MuiSlider-root through (plan-477 F9).
          touchAction: 'none',
          '& .MuiSlider-thumb': { width: 12, height: 12 },
          '& .MuiSlider-track': { height: 3, border: 'none' },
          '& .MuiSlider-rail': { height: 3, opacity: 0.25 },
        }}
      />
    </Box>
  );
}
