// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DragNumberField — Unity-Inspector-style numeric input.
 *
 * Visual: a small drag handle sits to the left of a `TextField` — an icon in
 * the default/inline layouts, or a minimal 1px vertical bar in `compact` mode
 * (the Property Inspector). Horizontal click-drag on the handle scrubs the
 * value (compact uses a col-resize cursor; others ew-resize); Shift slows the
 * scrub by 10x for fine control. The browser's default number spin buttons are
 * hidden — drag and direct typing are the only ways to change the value.
 *
 * The value is exposed as a string draft (caller owns the state) so callers
 * can let users type freely without each keystroke committing. The `onCommit`
 * callback fires on blur, Enter, and at the end of a drag — that is where the
 * caller should validate / clamp and write back to its store.
 */

import { useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import { Box, TextField, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { MathUtils } from 'three';

export interface DragNumberFieldProps {
  /** Drag handle content — usually a small MUI icon. Ignored in `compact` mode,
   *  where the handle renders as a minimal 1px vertical scrub bar instead. */
  icon?: ReactNode;
  /** Current draft string (the caller owns this state). */
  value: string;
  /** Called on every keystroke and on every drag tick. */
  onValueChange: (v: string) => void;
  /** Called on blur, Enter, or end-of-drag — clamp/validate/persist here. */
  onCommit: () => void;
  /**
   * Optional live callback fired on every drag tick with the parsed numeric
   * value (already clamped to [min, max] and rounded to `fractionDigits`).
   * Use this when the receiver wants to react in real time during scrubbing
   * (e.g. a shader uniform, a transform, a splat crop box) rather than only
   * at end-of-drag. Typing into the input does NOT fire this — `onCommit`
   * remains the canonical commit point for keyboard edits.
   */
  onDragChange?: (n: number) => void;
  /** Inclusive lower bound (used by drag clamping and HTML5 validation). */
  min: number;
  /** Inclusive upper bound. */
  max: number;
  /** Drag sensitivity per pixel; also passed as HTML5 `step`. Shift = ×0.1. */
  step: number;
  /** Optional unit suffix rendered as an endAdornment (e.g. "mm", "°"). */
  unit?: string;
  /** Number of fractional digits to round drag output to. Default: derived from step. */
  fractionDigits?: number;
  /** Extra sx applied to the outer flex container. */
  sx?: SxProps<Theme>;
  /** Disables the field entirely (handle and input). */
  disabled?: boolean;
  /** Accessible label for screen readers. */
  ariaLabel?: string;
  /** Compact rendering for dense surfaces like the Property Inspector. */
  compact?: boolean;
  /**
   * Inline label rendered BETWEEN the drag handle and the input. When set, the
   * field lays out as a single settings-style row — `[handle] label … [input]` —
   * so it visually matches one-line toggle rows. The handle drops its boxed
   * styling and reads as a plain (draggable) icon. Omit for the default
   * stacked / full-width layout.
   */
  label?: ReactNode;
  /** Fixed width (px) of the input in inline-label mode. Default 92. */
  inputWidth?: number;
}

export function DragNumberField({
  icon,
  value,
  onValueChange,
  onCommit,
  onDragChange,
  min,
  max,
  step,
  unit,
  fractionDigits,
  sx,
  disabled = false,
  ariaLabel,
  compact = false,
  label,
  inputWidth = 92,
}: DragNumberFieldProps) {
  const inline = label != null;
  const dragRef = useRef<{ startX: number; startValue: number } | null>(null);

  // Default precision: 0 decimals if step >= 1, else 2.
  const decimals = fractionDigits ?? (step < 1 ? 2 : 0);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const parsed = parseFloat(value);
    dragRef.current = {
      startX: e.clientX,
      startValue: Number.isFinite(parsed) ? parsed : min,
    };
  }, [value, min, disabled]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const sensitivity = step * (e.shiftKey ? 0.1 : 1);
    const raw = dragRef.current.startValue + dx * sensitivity;
    const next = +MathUtils.clamp(raw, min, max).toFixed(decimals);
    onValueChange(String(next));
    onDragChange?.(next);
  }, [step, min, max, decimals, onValueChange, onDragChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    onCommit();
  }, [onCommit]);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        // compact: no gap; the grip is absolutely overlaid on the input (below).
        gap: inline ? 1 : compact ? 0 : 0.5,
        ...(compact && !inline
          ? {
              // positioning anchor for the absolutely-overlaid scrub grip
              position: 'relative',
              // compact: the bar is transparent until the field is hovered.
              '&:hover .rv-drag-bar': disabled ? {} : { bgcolor: 'rgba(255,255,255,0.55)' },
            }
          : {}),
        ...sx,
      }}
    >
      <Box
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        aria-label={ariaLabel ? `${ariaLabel} drag handle` : 'drag to change value'}
        sx={inline ? {
          // Plain (boxless) draggable icon so the row matches one-line toggles.
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'text.secondary',
          cursor: disabled ? 'default' : 'ew-resize',
          userSelect: 'none',
          flex: '0 0 auto',
          opacity: disabled ? 0.4 : 1,
          transition: 'color 120ms ease',
          '&:hover': disabled ? {} : { color: 'text.primary' },
        } : compact ? {
          // Minimal scrub handle — a thin 1px vertical bar (rendered below) drawn
          // OVER the input's left edge. Absolutely positioned (out of flow) so the
          // field has no left "hangover" and the grip reads as part of the input.
          // The bar is transparent until the field is hovered (reveal handled on the
          // outer container). col-resize cursor signals horizontal drag. No box/border.
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          pl: '2px',
          width: 8,
          cursor: disabled ? 'default' : 'col-resize',
          userSelect: 'none',
          opacity: disabled ? 0.4 : 1,
        } : {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          borderRadius: 1,
          cursor: disabled ? 'default' : 'ew-resize',
          userSelect: 'none',
          color: 'text.secondary',
          bgcolor: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          opacity: disabled ? 0.4 : 1,
          transition: 'background-color 120ms ease, color 120ms ease',
          '&:hover': disabled ? {} : {
            bgcolor: 'rgba(255,255,255,0.08)',
            color: 'text.primary',
          },
        }}
      >
        {compact && !inline ? (
          <Box
            className="rv-drag-bar"
            sx={{ width: '1px', height: 16, borderRadius: '1px', bgcolor: 'transparent', transition: 'background-color 120ms ease' }}
          />
        ) : icon}
      </Box>
      {inline && (
        <Typography
          sx={{
            fontSize: 12,
            flex: 1,
            minWidth: 0,
            color: disabled ? 'text.disabled' : 'text.primary',
            userSelect: 'none',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </Typography>
      )}
      <TextField
        size="small"
        type="number"
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onCommit();
            (e.currentTarget as HTMLElement).blur();
          }
        }}
        inputProps={{ min, max, step, 'aria-label': ariaLabel }}
        slotProps={{
          input: {
            endAdornment: unit ? (
              <Typography
                component="span"
                // Faded + nudged toward the right edge so it reads as a quiet
                // unit hint rather than part of the value.
                sx={{ color: 'rgba(255,255,255,0.3)', fontSize: 12, ml: 1 }}
              >
                {unit}
              </Typography>
            ) : undefined,
          },
        }}
        sx={{
          ...(inline ? { width: inputWidth, flex: '0 0 auto' } : { flex: 1 }),
          '& .MuiInputBase-input': inline
            ? { fontSize: 12, py: 0.4, textAlign: 'right' }
            : compact
              // px override: MUI's default 14px horizontal padding looks like an
              // unwanted leading space in this dense layout — tighten it so the
              // number sits close to the field's left edge.
              ? { fontSize: 11, fontFamily: 'monospace', height: 18, py: 0, px: 0.75, boxSizing: 'border-box' }
              : { fontSize: 13, py: 0.75 },
          ...((compact || inline) && {
            '& .MuiOutlinedInput-root': {
              bgcolor: 'rgba(255,255,255,0.04)',
              // Match the unit's right gap to the value's left gap (input px:0.75
              // = 6px) so the field reads symmetric. MUI defaults the root's
              // right padding to ~14px when an endAdornment is present.
              ...(compact && !inline ? { pr: 0.75 } : {}),
              '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' },
              '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.15)' },
              '&.Mui-focused fieldset': { borderColor: 'primary.main' },
            },
          }),
          '& input[type=number]::-webkit-outer-spin-button, & input[type=number]::-webkit-inner-spin-button': {
            WebkitAppearance: 'none', margin: 0,
          },
          '& input[type=number]': { MozAppearance: 'textfield' },
        }}
      />
    </Box>
  );
}
