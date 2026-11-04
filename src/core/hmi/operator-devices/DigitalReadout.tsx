// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DigitalReadout — the analog OUTPUT of an operator panel (plan-659): a digital
 * panel meter on the enclosure plate. It READS one or more signals and shows
 * their values, scaled, with a unit and a legend.
 *
 * Why the panel needs one: a lamp answers "is it so?". Telemetry a station puts
 * next to its lamps — a travelled distance, a height, a count, a real-time
 * factor, an angular rate — answers "how much?", and that has no boolean form.
 * Before this, such a value could only be shown by a window built outside the
 * panel.
 *
 * It takes a LIST of values, not one, because the measured quantities of a
 * machine are routinely vectors: an angular rate, a projected gravity, a force.
 * Three separate instruments would lose that they belong together and cost
 * three legends. One value is simply a list of length one, and renders exactly
 * as a single meter.
 *
 * Tabular figures and a fixed decimal count on purpose: a value that changes
 * every tick must not make the plate twitch. `--` is a real state: the signal
 * is not there, or not a finite number.
 */

import { Box } from '@mui/material';
import { FS, INK_HIGH, INK_LOW, MONO } from '../shared-sx';
import { LegendBox } from './LegendBox';

export interface DigitalReadoutProps {
  /** Accessible name and legend text. */
  label: string;
  /** The raw signal values; one entry = a scalar meter. Non-finite renders as `--`. */
  values: readonly number[];
  /** Captions above the components of a vector, e.g. ["X","Y","Z"]. Same length as `values`. */
  componentLabels?: readonly string[];
  /** Unit shown after the value(s), e.g. "m". */
  unit?: string;
  /** Decimals. Default 0. */
  decimals?: number;
  /** Each raw value is multiplied by this before display (m to mm: 1000). Default 1. */
  scale?: number;
  /** Dimmed: the panel is not connected to its signals. */
  disabled?: boolean;
  /**
   * Tighter meter window and legend, for a plate packed `compact`
   * (plan-659). Default off — the instrument keeps its original metrics.
   */
  compact?: boolean;
}

export function DigitalReadout({
  label, values, componentLabels, unit, decimals = 0, scale = 1, disabled, compact,
}: DigitalReadoutProps) {
  const vector = values.length > 1;
  const shown = values.map((v) => {
    const scaled = v * scale;
    return Number.isFinite(scaled) && !disabled ? scaled.toFixed(decimals) : '--';
  });
  const anyOk = !disabled && values.some((v) => Number.isFinite(v * scale));
  return (
    <Box
      data-device="digital-readout"
      data-components={values.length}
      sx={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: compact ? 0 : 0.25 }}
    >
      <Box
        role="status"
        aria-label={label}
        data-part="readout"
        data-signal-value={anyOk ? shown.join(' ') : ''}
        sx={{
          width: '100%',
          // The meter window: inset, darker than the plate, so the figures read
          // as a display and not as a label.
          bgcolor: 'rgba(0,0,0,0.35)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: '2px',
          px: 0.5,
          py: compact ? 0 : 0.25,
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'center',
          gap: vector ? 0.75 : 0.4,
          minHeight: compact ? 17 : 22,
        }}
      >
        {shown.map((text, i) => (
          <Box
            // Index: the components of a vector are positional and never reorder.
            key={i}
            component="span"
            data-part="component"
            sx={{ display: 'flex', alignItems: 'baseline', gap: 0.25, minWidth: 0 }}
          >
            {componentLabels?.[i] && (
              <Box component="span" data-part="component-label" sx={{ fontSize: FS.micro, color: INK_LOW, lineHeight: 1.3 }}>
                {componentLabels[i]}
              </Box>
            )}
            <Box
              component="span"
              data-part="value"
              sx={{
                fontFamily: MONO,
                fontSize: vector || compact ? FS.label : FS.body,
                fontWeight: 600,
                lineHeight: 1.3,
                color: text === '--' ? INK_LOW : INK_HIGH,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {text}
            </Box>
          </Box>
        ))}
        {unit && (
          <Box component="span" data-part="unit" sx={{ fontSize: FS.micro, color: INK_LOW, lineHeight: 1.3 }}>
            {unit}
          </Box>
        )}
      </Box>
      <LegendBox compact={compact}>{label}</LegendBox>
    </Box>
  );
}
