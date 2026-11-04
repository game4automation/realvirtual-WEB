// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ControlWindow — a permanent, movable operator window over the 3D scene.
 *
 * The same chrome as every other floating window (drag by the title bar, glass
 * surface, remembered position), minus the one thing an operator panel must not
 * have: a way to close it. It collapses to its title bar instead, and remembers
 * that. A project defines its contents in code, in its own plugin module
 * (`projects/<name>/plugins/index.ts`, slot `overlay`) — see
 * `doc-extending-webviewer.md` § "A control window in a project plugin".
 *
 * Three controls, deliberately few and deliberately distinct (plan-477 E5, and
 * ISA-101: a latching selector and a momentary button must not look alike):
 *
 *  - {@link LatchGroup}      one of N, latched, with the active one lit
 *  - {@link MomentaryButton} press-and-hold; the effect lasts while it is held
 *  - {@link ControlSlider}   a continuous value, live in its own label
 *
 * Two more for a value a planner types rather than drags (plan-630 §2.6):
 *
 *  - {@link ControlNumber}   a bounded number with its unit, committed on
 *                            Enter / blur — never per keystroke
 *  - {@link ChipToggleRow}   one on/off chip per element of a set
 *                            (`[A1 ●] [A2 ○]`), the compact form of N
 *                            independent booleans that belong together
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Box, Typography, ToggleButton, ToggleButtonGroup, Slider, Button, TextField, Tooltip,
} from '@mui/material';
import { createTheme, ThemeProvider, type Theme } from '@mui/material/styles';
import { FloatingPanel } from './FloatingPanel';
import { PANEL_SURFACE } from './shared-sx';

const ACCENT = '#4fc3f7';

// ─── ControlWindow ──────────────────────────────────────────────────────

export interface ControlWindowProps {
  title: string;
  /** Stable key for the remembered position and collapsed state. Required. */
  panelId: string;
  defaultPosition?: { x: number; y: number };
  defaultWidth?: number;
  subtitle?: string;
  /**
   * Title-bar content that stays visible when the window is collapsed (plan-542
   * F6): state chips, a mini stack light — whatever an operator must still see.
   */
  headerExtras?: ReactNode;
  /**
   * Title-bar content shown ONLY while the window is collapsed — the controls an
   * operator must still reach with the body gone (the mini E-stop). Rendered in
   * addition to {@link headerExtras}.
   */
  collapsedHeaderExtras?: ReactNode;
  /**
   * The window's surface (plan-542 F11). `glass` (default) = the theme's glass.
   * `plate` = the darkest near-opaque glass rgba(15,15,15,0.92) as the enclosure
   * plate of an operator panel, whose legends must stay readable over any scene,
   * with a tighter content padding.
   */
  surface?: 'glass' | 'plate';
  /** Start collapsed until the user changes it (the stored state wins afterwards). */
  defaultCollapsed?: boolean;
  /**
   * Let the user resize the window (plan-659). Default `false` — a control box
   * has the size of its plate, which is why every operator window before this
   * was fixed and content-high.
   *
   * A window that carries live telemetry is the exception: how much of it fits
   * is the operator's call, so it gets a real height and a resize handle. The
   * two go together — a handle on a content-high window has no height to drag.
   */
  resizable?: boolean;
  /** Window height in px when {@link resizable}; ignored otherwise. Default 420. */
  defaultHeight?: number;
  children: ReactNode;
}

/** The plate surface: the darkest glass tier, near-opaque. */
export const PLATE_SURFACE = PANEL_SURFACE;

/**
 * A theme layer that puts every Paper below it on the plate. The global theme
 * sets the Paper background with `!important` (theme.ts, MuiPaper), so the
 * window cannot take it back with its own `sx` — it re-themes its own subtree
 * instead (React context crosses FloatingPanel's portal).
 */
const plateTheme = (outer: Theme): Theme => createTheme(outer, {
  components: {
    MuiPaper: { styleOverrides: { root: { backgroundColor: `${PLATE_SURFACE} !important` } } },
  },
});

export function ControlWindow({
  title,
  panelId,
  defaultPosition,
  defaultWidth = 320,
  subtitle,
  headerExtras,
  collapsedHeaderExtras,
  surface = 'glass',
  defaultCollapsed,
  resizable = false,
  defaultHeight = 420,
  children,
}: ControlWindowProps) {
  const toolbar = (
    <ControlWindowHeader collapsedExtras={collapsedHeaderExtras}>{headerExtras}</ControlWindowHeader>
  );
  const plate = surface === 'plate';
  const panel = (
    <FloatingPanel
      open
      closable={false}
      collapsible
      persistCollapsed
      defaultCollapsed={defaultCollapsed}
      autoHeight={!resizable}
      resizable={resizable}
      defaultHeight={defaultHeight}
      // Non-modal and permanently present: a landmark region, not a dialog.
      // https://github.com/w3c/aria-practices/issues/1021
      role="region"
      aria-label={title}
      title={title}
      subtitle={subtitle}
      panelId={panelId}
      defaultWidth={defaultWidth}
      minWidth={defaultWidth}
      defaultPosition={defaultPosition}
      toolbar={toolbar}
    >
      <Box data-surface={surface} sx={{ display: 'flex', flexDirection: 'column', gap: plate ? 0.75 : 1.25, p: plate ? 1 : 1.25 }}>
        {children}
      </Box>
    </FloatingPanel>
  );
  return plate ? <ThemeProvider theme={plateTheme}>{panel}</ThemeProvider> : panel;
}

/**
 * The title-bar slot of a {@link ControlWindow}: right-aligned extras, and the
 * window's own title-bar buttons raised to a 32 px hit area (they follow this
 * slot as siblings in the FloatingPanel title bar — the general sibling
 * combinator reaches them without touching FloatingPanel).
 *
 * Whether the window is collapsed is read from the collapse button's
 * `aria-expanded`, observed — FloatingPanel owns that state and keeps it.
 */
function ControlWindowHeader({ children, collapsedExtras }: { children?: ReactNode; collapsedExtras?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!collapsedExtras) return;
    const bar = ref.current?.closest('[data-drag-handle]');
    const toggle = bar?.querySelector('[aria-controls^="rv-panel-content"]');
    if (!toggle) return;
    const read = () => setCollapsed(toggle.getAttribute('aria-expanded') === 'false');
    read();
    const obs = new MutationObserver(read);
    obs.observe(toggle, { attributes: true, attributeFilter: ['aria-expanded'] });
    return () => obs.disconnect();
  }, [collapsedExtras]);

  return (
    <Box
      ref={ref}
      data-control-window-header=""
      sx={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 0.75,
        '& ~ .MuiIconButton-root': { width: 32, height: 32 },
      }}
    >
      {children}
      {collapsed && collapsedExtras}
    </Box>
  );
}

/** A labelled row inside a {@link ControlWindow}. */
export function ControlGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {label && (
        <Typography sx={{ fontSize: 10, letterSpacing: 0.4, color: 'rgba(255,255,255,0.45)' }}>
          {label}
        </Typography>
      )}
      {children}
    </Box>
  );
}

// ─── LatchGroup ─────────────────────────────────────────────────────────

export interface LatchOption {
  id: string;
  label: string;
  color?: string;
}

export interface LatchGroupProps {
  options: LatchOption[];
  /** The latched option, or null when the model matches none of them. */
  value: string | null;
  onChange(id: string): void;
  ariaLabel: string;
  disabled?: boolean;
}

/**
 * One of N, latched, with the active one lit (ISA-101: inactive grey, active
 * coloured). `value === null` is a real state: the model is somewhere none of
 * the options describes, and the panel says so by lighting none of them.
 */
export function LatchGroup({ options, value, onChange, ariaLabel, disabled }: LatchGroupProps) {
  return (
    <ToggleButtonGroup
      value={value}
      exclusive
      size="small"
      fullWidth
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(_, val) => { if (val) onChange(String(val)); }}
      sx={{ '& .MuiToggleButton-root': { fontSize: 11, py: 0.5, textTransform: 'none', fontWeight: 600, minHeight: 44 } }}
    >
      {options.map((opt) => {
        const c = opt.color ?? ACCENT;
        return (
          <ToggleButton
            key={opt.id}
            value={opt.id}
            sx={{
              color: 'rgba(255,255,255,0.55)',
              '&.Mui-selected': { bgcolor: `${c}20`, color: c },
              '&.Mui-selected:hover': { bgcolor: `${c}30` },
            }}
          >
            {opt.label}
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
}

// ─── MomentaryButton ────────────────────────────────────────────────────

export interface MomentaryButtonProps {
  label: string;
  onPress(): void;
  /** Omit for a one-shot action; supply it for press-and-hold. */
  onRelease?(): void;
  color?: string;
  disabled?: boolean;
}

export interface MomentaryPressOptions {
  onPress(): void;
  onRelease?(): void;
  disabled?: boolean;
  /** Told when the held state changes — for visuals only, never for the release logic. */
  onHeldChange?(held: boolean): void;
}

/**
 * The release logic of {@link MomentaryButton}, for any control that is a
 * momentary push button (the operator devices of plan-542 use it too).
 *
 * `onRelease` runs EXACTLY once per press, down every path a press can end
 * (plan-477 F7/A3): the caller wires `press` to pointerdown / key down and
 * `release` to pointerup · pointerleave · pointercancel · lost pointer capture
 * · key up; the hook itself covers the window losing focus (alt-tab), the tab
 * being hidden and unmount. A ref flag rather than state: the release path
 * must be correct even between renders.
 */
export function useMomentaryPress({ onPress, onRelease, disabled, onHeldChange }: MomentaryPressOptions): {
  press(): void;
  release(): void;
} {
  const pressed = useRef(false);
  // Fresh handlers without re-subscribing the window listeners.
  const handlers = useRef({ onPress, onRelease, disabled, onHeldChange });
  handlers.current = { onPress, onRelease, disabled, onHeldChange };

  const release = useCallback(() => {
    if (!pressed.current) return;
    pressed.current = false;
    handlers.current.onHeldChange?.(false);
    handlers.current.onRelease?.();
  }, []);

  const press = useCallback(() => {
    // Belt and braces: the browser already withholds pointer events from a
    // disabled control, but a disabled button must do nothing however it is
    // reached — including programmatically.
    if (handlers.current.disabled) return;
    if (pressed.current) return;   // keyboard auto-repeat, double pointerdown
    pressed.current = true;
    handlers.current.onHeldChange?.(true);
    handlers.current.onPress();
  }, []);

  useEffect(() => {
    const onBlur = () => release();
    const onVisibility = () => { if (document.visibilityState === 'hidden') release(); };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      // Unmounting while held is a release too — the alternative is a machine
      // that keeps running because a panel was swapped out.
      release();
    };
  }, [release]);

  return { press, release };
}

/**
 * Press-and-hold. `onPress` on the way down, `onRelease` on the way up — and
 * `onRelease` runs EXACTLY once per press, down every path a press can end
 * (plan-477 F7/A3):
 *
 *   pointerup · pointerleave · pointercancel · lost pointer capture ·
 *   the window losing focus (alt-tab) · the tab being hidden · unmount
 *
 * A held button whose release is missed leaves the machine running, which is
 * the one failure mode this control may not have. Hence a ref flag rather than
 * state: the release path must be correct even between renders.
 */
export function MomentaryButton({ label, onPress, onRelease, color, disabled }: MomentaryButtonProps) {
  const { press, release } = useMomentaryPress({ onPress, onRelease, disabled });

  const c = color ?? ACCENT;
  return (
    <Button
      variant="outlined"
      size="small"
      fullWidth
      disabled={disabled}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return;
        if (e.repeat) return;   // held key must not re-press
        e.preventDefault();     // and must not become a synthetic click
        press();
      }}
      onKeyUp={(e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return;
        e.preventDefault();
        release();
      }}
      sx={{
        minHeight: 44,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'none',
        color: c,
        borderColor: `${c}55`,
        // Momentary must not look latched: it lights only while held.
        '&:active': { bgcolor: `${c}25`, borderColor: c },
        touchAction: 'none',
      }}
    >
      {label}
    </Button>
  );
}

// ─── ControlSlider ──────────────────────────────────────────────────────

export interface ControlSliderProps {
  label: string;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange(v: number): void;
  /** Called once when the drag ends, for work too expensive to do live. */
  onCommit?(v: number): void;
  disabled?: boolean;
  color?: string;
}

/** A continuous value with its live reading in the label, in monospace. */
export function ControlSlider({
  label, unit, min, max, step = 1, value, onChange, onCommit, disabled, color,
}: ControlSliderProps) {
  const c = color ?? ACCENT;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>{label}</Typography>
        <Box sx={{ ml: 'auto' }} />
        <Typography sx={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 600, color: c }}>
          {Math.round(value)}{unit ? ` ${unit}` : ''}
        </Typography>
      </Box>
      <Slider
        size="small"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(_, v) => onChange(Array.isArray(v) ? v[0] : v)}
        onChangeCommitted={(_, v) => onCommit?.(Array.isArray(v) ? v[0] : v)}
        sx={{
          color: c,
          touchAction: 'none',
          '& .MuiSlider-thumb': { width: 14, height: 14 },
          '& .MuiSlider-track': { height: 2 },
          '& .MuiSlider-rail': { height: 2, opacity: 0.2 },
        }}
      />
    </Box>
  );
}

// ─── ControlNumber ──────────────────────────────────────────────────────

export interface ControlNumberProps {
  label: string;
  unit?: string;
  value: number;
  /** Committed on Enter / blur — NOT per keystroke (a live change per digit floods the log). */
  onCommit(v: number): void;
  min?: number;
  max?: number;
  /** `true` = only whole numbers are accepted. */
  integer?: boolean;
  /** A rejection to show under the field (cross rule, out of range from the model side). */
  error?: string;
  disabled?: boolean;
  color?: string;
  /** Shown as the field's tooltip (the parameter's description). */
  description?: string;
}

/**
 * A number a planner TYPES: a parameter with no useful drag range (a pause of
 * 1200 s), or one with no range at all.
 *
 * The text is local while it is being edited and committed once, on Enter or on
 * blur — the same rule as {@link ControlSlider}'s `onCommit`, and for the same
 * reason: every commit is a change of the running plant. Escape puts the field
 * back to the model value. Input that is not a number of the declared kind is
 * never committed; the field says why and keeps the text so it can be fixed.
 */
export function ControlNumber({
  label, unit, value, onCommit, min, max, integer, error, disabled, color, description,
}: ControlNumberProps) {
  const c = color ?? ACCENT;
  const [text, setText] = useState<string | null>(null);
  const [local, setLocal] = useState<string | null>(null);

  const shown = text ?? String(value);
  const message = local ?? error;

  const commit = useCallback((raw: string) => {
    const s = raw.trim();
    const n = Number(s);
    if (s === '' || !Number.isFinite(n)) { setLocal(`'${raw}' is not a number`); return; }
    if (integer && !Number.isInteger(n)) { setLocal('expected a whole number'); return; }
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
      setLocal(`outside [${min ?? '-∞'}, ${max ?? '∞'}]`);
      return;
    }
    setLocal(null);
    setText(null);
    if (n !== value) onCommit(n);
  }, [integer, min, max, onCommit, value]);

  const field = (
    <TextField
      size="small"
      value={shown}
      disabled={disabled}
      error={!!message}
      inputProps={{
        'aria-label': label,
        inputMode: 'decimal',
        style: { fontFamily: 'monospace', fontSize: 12, fontWeight: 600, textAlign: 'right', padding: '4px 6px' },
      }}
      onChange={(e) => { setText(e.target.value); setLocal(null); }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit((e.target as HTMLInputElement).value); }
        if (e.key === 'Escape') { e.preventDefault(); setText(null); setLocal(null); }
      }}
      sx={{
        width: unit ? 78 : 96,
        '& .MuiOutlinedInput-root': { color: message ? undefined : c },
      }}
    />
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>{label}</Typography>
        <Box sx={{ ml: 'auto' }} />
        {description ? <Tooltip title={description}>{field}</Tooltip> : field}
        {unit && (
          <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', minWidth: 28 }}>{unit}</Typography>
        )}
      </Box>
      {message && (
        <Typography role="alert" sx={{ fontSize: 10, color: '#ef9a9a' }}>{message}</Typography>
      )}
    </Box>
  );
}

// ─── ChipToggleRow ──────────────────────────────────────────────────────

export interface ChipToggleItem {
  id: string;
  label: string;
  value: boolean;
  /** Pending value of this chip, when one is waiting for the next reset. */
  pending?: boolean;
  disabled?: boolean;
  /** Tooltip (the parameter's description). */
  description?: string;
}

export interface ChipToggleRowProps {
  label?: string;
  items: readonly ChipToggleItem[];
  onToggle(id: string, next: boolean): void;
  ariaLabel: string;
  color?: string;
}

/**
 * One on/off chip per element of a set — `[A1 ●] [A2 ○] [V1 ●]`.
 *
 * N independent booleans that belong together (every output, every vehicle):
 * a {@link LatchGroup} per boolean would be a wall of two-button groups, and a
 * checkbox list loses the at-a-glance reading of which elements are in.
 * A chip whose value is waiting for the next reset carries a dashed outline and
 * says so in its accessible name, so "on" and "about to be on" never look alike.
 */
export function ChipToggleRow({ label, items, onToggle, ariaLabel, color }: ChipToggleRowProps) {
  const c = color ?? ACCENT;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }} role="group" aria-label={ariaLabel}>
      {label && (
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', minWidth: 76 }}>{label}</Typography>
      )}
      {items.map((item) => {
        const pending = item.pending !== undefined && item.pending !== item.value;
        const effective = pending ? item.pending! : item.value;
        const chip = (
          <Box
            component="button"
            type="button"
            key={item.id}
            disabled={item.disabled}
            aria-pressed={item.value}
            aria-label={pending ? `${item.label} (pending: ${item.pending ? 'on' : 'off'})` : item.label}
            onClick={() => onToggle(item.id, !item.value)}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.5,
              minHeight: 28,
              px: 0.9,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              borderRadius: 1,
              cursor: item.disabled ? 'default' : 'pointer',
              color: effective ? c : 'rgba(255,255,255,0.5)',
              bgcolor: effective ? `${c}20` : 'rgba(255,255,255,0.05)',
              border: `1px ${pending ? 'dashed' : 'solid'} ${effective ? `${c}80` : 'rgba(255,255,255,0.18)'}`,
              opacity: item.disabled ? 0.45 : 1,
              '&:hover': { bgcolor: effective ? `${c}30` : 'rgba(255,255,255,0.1)' },
            }}
          >
            {item.label}
            <Box component="span" aria-hidden sx={{ fontSize: 9 }}>{effective ? '●' : '○'}</Box>
          </Box>
        );
        return item.description ? <Tooltip key={item.id} title={item.description}>{chip}</Tooltip> : chip;
      })}
    </Box>
  );
}
