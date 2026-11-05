// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared MUI sx prop factories for dark-theme styled components.
 *
 * Used by chart overlays, hierarchy browser, and other HMI components
 * for consistent dark-theme styling. Parameterized by accent color or state.
 */

import type { SxProps, Theme } from '@mui/material';
import { uiBlur } from './rv-ui-blur';

/**
 * Shared corner radius for all small inline chips (type badges, filter chips,
 * signal badges). Deliberately squared — MUI's default fully-rounded pill reads
 * as a consumer tag; the crisp 2px corner matches the instrument aesthetic and
 * keeps every chip in the HMI visually one family.
 */
export const CHIP_RADIUS = '2px';

/**
 * The ONE look of a document label chip: the open mode a document card or row
 * names ("DES", "Commissioning") and the Bundled tier wear exactly this, so the
 * two read as one family. Placement (margins, absolute position) is the
 * caller's; the look is not.
 */
export const LABEL_CHIP_SX = {
  flexShrink: 0,
  px: 0.75,
  py: 0.25,
  borderRadius: CHIP_RADIUS,
  border: '1px solid rgba(255,255,255,0.14)',
  fontSize: 10,
  letterSpacing: 0.4,
  color: 'text.secondary',
  whiteSpace: 'nowrap',
} as const;

/** Backdrop of a label chip painted over a card preview — light; the blur in {@link LABEL_CHIP_ON_PREVIEW_SX} keeps it readable. */
export const LABEL_CHIP_ON_PREVIEW_BG = 'rgba(0,0,0,0.3)';

// ─── Design values (plan-510) ───────────────────────────────────────────
//
// The ONE place the inspector's colours and type sizes live. Inspector files
// import these instead of re-declaring `rgba(...)` / hex / numeric font sizes
// locally — `tests/hmi-design-lint.node.test.ts` enforces it (see DESIGN.md).
// `theme.ts` builds its palette FROM the accent values below, so there is no
// second hex source (the import runs theme → shared-sx; the reverse would be a
// cycle, because theme.ts already needs CHIP_RADIUS from here).

/** Primary text on glass — values, titles. */
export const INK_HIGH = 'rgba(255,255,255,0.92)';
/** Secondary text — descriptions, messages. */
export const INK_MID = 'rgba(255,255,255,0.70)';
/** Tertiary text — labels, hints, units, subheaders. 0.5 = the design system's
 *  Ink Low (private DESIGN.md) and the contrast floor on glass. */
export const INK_LOW = 'rgba(255,255,255,0.5)';
/**
 * Panel surface — the darkest near-opaque glass for floating panels whose
 * content is text and values (FloatingPanel, the operator-panel plate, the USD
 * menu). Over the worst-case #505050 scene it lands at #1A1A1A, over a white
 * scene at #222222, so Ink Low and the state colours keep >= 4.5:1; the lighter
 * theme Paper default (rgba(30,30,30,0.6)) does not (private DESIGN.md,
 * "Floating Glass Panel"). Paper sets its background with `!important`
 * (theme.ts), so a Paper takes this as `${PANEL_SURFACE} !important`.
 */
export const PANEL_SURFACE = 'rgba(15,15,15,0.92)';
/**
 * A label chip painted over a card preview (the open mode, Bundled, the detail
 * pane's mode selector): a light, blurred backdrop and a faint edge, so it reads
 * on any thumbnail without weighing on it. Spread AFTER {@link LABEL_CHIP_SX}.
 */
export const LABEL_CHIP_ON_PREVIEW_SX = {
  bgcolor: LABEL_CHIP_ON_PREVIEW_BG,
  borderColor: 'rgba(255,255,255,0.08)',
  backdropFilter: uiBlur(6),
  color: INK_MID,
} as const;
/** Hairline separators between inspector blocks. */
export const DIVIDER = 'rgba(255,255,255,0.06)';
/** Row hover tint. */
export const ROW_HOVER = 'rgba(255,255,255,0.02)';
/** Background of an inline input field. */
export const FIELD_BG = 'rgba(255,255,255,0.04)';
/** Border of an inline input field. */
export const FIELD_BORDER = 'rgba(255,255,255,0.08)';
/** Border of an inline input field on hover. */
export const FIELD_BORDER_HOVER = 'rgba(255,255,255,0.15)';

/** Instrument Blue — the one working accent (theme `primary`). */
export const ACCENT = '#4fc3f7';
/** Accent tint behind an active (pressed) filter chip / toggle. */
export const ACCENT_TINT = 'rgba(79, 195, 247, 0.2)';
/** Accent tint of an active filter chip on hover. */
export const ACCENT_TINT_HOVER = 'rgba(79, 195, 247, 0.25)';
/** Border of an active filter chip / toggle — carries the active state with the tint. */
export const ACCENT_BORDER = 'rgba(79, 195, 247, 0.4)';
/** Border of an inactive filter chip. */
export const CHIP_BORDER = 'rgba(255, 255, 255, 0.1)';
/** Hover tint of an inactive filter chip, and of one part of a split chip. */
export const CHIP_HOVER = 'rgba(255, 255, 255, 0.06)';
/** Theme `secondary`. */
export const SECONDARY = '#e94078';
/** Theme `success` — running / ok. */
export const SUCCESS = '#66bb6a';
/** Theme `warning` — a person has to act. */
export const WARN = '#ffa726';
/** Theme `error` — a failure. */
export const ERROR = '#ef5350';

// plan-514: the semantic colours the inspector still spelled out locally.
/** Interactive references — node links in Knowledge / Metadata, "go to" values. */
export const LINK = '#64b5f6';
/** A lightened warning — hover of a warning control, a softer caution state. */
export const WARN_LIGHT = '#ffb74d';
/** Occupied — a sensor sees an MU, a snap port is paired. Own semantic, not a warning. */
export const OCCUPIED = '#e8b04a';
/** Live — a behaviour's runtime state while it runs (Behavior live sections). */
export const LIVE = '#4dd0e1';
/** Neutral / unbound — an unlinked slot, an unknown state. */
export const NEUTRAL = '#808080';
/** Text and icons on a filled accent surface (contained button, filled chip). */
export const ON_ACCENT = '#ffffff';

// ─── IEC operator-device colours (plan-542 F1) ──────────────────────────
//
// The "Operator Device exception" of the private DESIGN.md: an operator device
// (src/core/hmi/operator-devices/) may depict a real IEC device, and these are
// its colours — NOT state or signal colours. IEC 60204-1 §10.2 gives a push
// button's CAP its colour by function (red stop, green start, blue mandatory
// action, white/black general), IEC 60073 / §10.3 gives an indicator LAMP its
// colour by meaning. Only operator devices import these; a panel names the
// colour (`cap="green"`), never the literal — `tests/operator-devices.test.tsx`
// fails if the tokens are imported anywhere else.
//
// Fixed, measured literals (never opacity-derived): every cap and lit ring
// clears 3:1 (SC 1.4.11) against BOTH ends of the enclosure plate — the window
// glass rgba(15,15,15,0.92) over the #505050 worst-case scene (#141414) and
// over a white scene (#222222). Measured (vs #141414 / #222222):
//   cap  red 4.36/3.76 · yellow 11.12/9.60 · green 5.38/4.65 · blue 4.59/3.96
//        white 15.04/12.98 · black 1.06/1.09 (carried by the bezel, below)
//   lamp red 6.02/5.20 · yellow 12.76/11.02 · green 9.83/8.49 · blue 7.06/6.10
//        white 16.75/14.47
//   bezel 5.48/4.73 (black cap vs bezel 5.18) · unlit ring 3.61/3.12

/** Push-button cap colours by function (IEC 60204-1 §10.2). */
export const IEC_CAP = {
  red: '#e53935',
  yellow: '#f2c400',
  green: '#2e9e54',
  blue: '#2f7fe0',
  white: '#e8e8e8',
  black: '#1a1a1a',
} as const;

/** Indicator lamp colours, lit (IEC 60204-1 §10.3 / IEC 60073). */
export const IEC_LAMP = {
  red: '#ff5b4f',
  yellow: '#ffd23f',
  green: '#4cd679',
  blue: '#5aa2ff',
  white: '#f4f4f4',
} as const;

/** The device's front ring (bezel) — gives every cap, the black one too, its 3:1 edge. */
export const IEC_BEZEL = '#8c8c8c';
/** A lamp ring that is present but unlit. */
export const IEC_LAMP_OFF = '#6e6e6e';
/** The enclosure plate as a solid colour, for the gap between device parts. */
export const IEC_PLATE = '#141414';

export type IecCapColor = keyof typeof IEC_CAP;
export type IecLampColor = keyof typeof IEC_LAMP;

/** Inspector type scale in px. Nothing in the inspector uses another size. */
export const FS = { micro: 10, label: 11, body: 12, title: 14 } as const;
/** Icon sizes in px (MUI `fontSize` of an SvgIcon). */
export const ICON_SIZE = { dot: 7, xs: 12, sm: 14, md: 16, lg: 18 } as const;
/** Monospace stack for measurement values, hashes and GUIDs. */
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Outlined-input look of every inline inspector editor (number, string, enum, vector). */
export const inspectorInputSx = {
  bgcolor: FIELD_BG,
  '& fieldset': { borderColor: FIELD_BORDER },
  '&:hover fieldset': { borderColor: FIELD_BORDER_HOVER },
  '&.Mui-focused fieldset': { borderColor: 'primary.main' },
} as const;

// ─── Shared scrollbar CSS class ─────────────────────────────────────────

/**
 * CSS class name for the standard dark-theme scrollbar.
 * Apply via `className={RV_SCROLL_CLASS}` on any scrollable container.
 * Injects the CSS once on first import.
 */
export const RV_SCROLL_CLASS = 'rv-scroll';

const _scrollStyleId = 'rv-scroll-shared-style';
if (typeof document !== 'undefined' && !document.getElementById(_scrollStyleId)) {
  const s = document.createElement('style');
  s.id = _scrollStyleId;
  s.textContent = `
    .${RV_SCROLL_CLASS} { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.25) transparent; }
    .${RV_SCROLL_CLASS}::-webkit-scrollbar { width: 10px; }
    .${RV_SCROLL_CLASS}::-webkit-scrollbar-track { background: transparent; }
    .${RV_SCROLL_CLASS}::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 5px; border: 2px solid transparent; background-clip: padding-box; }
    .${RV_SCROLL_CLASS}::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); border: 2px solid transparent; background-clip: padding-box; }
    .${RV_SCROLL_CLASS}::-webkit-scrollbar-button { display: none !important; }
    .${RV_SCROLL_CLASS}::-webkit-scrollbar-corner { background: transparent; }
  `;
  document.head.appendChild(s);
}

/**
 * Returns sx for a compact dark-theme ToggleButtonGroup.
 * Parameterize accent color for per-chart theming.
 */
export function compactToggleGroupSx(
  accentColor: string,
  accentRgb: string,
  extraSx?: SxProps<Theme>,
): SxProps<Theme> {
  return [
    {
      height: 22,
      '& .MuiToggleButtonGroup-grouped': {
        border: '1px solid rgba(255,255,255,0.1) !important',
      },
      '& .MuiToggleButton-root': {
        color: INK_MID,
        bgcolor: 'transparent',
        borderColor: 'rgba(255,255,255,0.1)',
        fontSize: FS.label,
        lineHeight: 1,
        px: 0.6,
        py: 0,
        minWidth: 0,
        textTransform: 'none',
        '&.Mui-selected': {
          color: accentColor,
          bgcolor: `rgba(${accentRgb},0.12)`,
          borderColor: `rgba(${accentRgb},0.3) !important`,
        },
        '&.Mui-selected:hover': {
          bgcolor: `rgba(${accentRgb},0.18)`,
        },
        '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
        '&.Mui-disabled': { color: 'text.disabled', bgcolor: 'transparent' },
      },
    },
    ...(Array.isArray(extraSx) ? extraSx : extraSx ? [extraSx] : []),
  ];
}

/**
 * Returns sx for a small filter Chip that toggles between active/inactive.
 * Used in hierarchy browser type filters, signal sort chips, etc.
 *
 * Active state = accent tint + accent border; the TEXT stays Ink High, because
 * Instrument Blue text on its own tint misses 4.5:1 on the panel glass
 * (plan-597 Phase 6b, measured against the composited panel #323232 / #3E3E3E:
 * accent text 4.31 / 3.71, hover 3.89 / 3.38 → Ink High 7.62 / 6.61, hover
 * 6.90 / 6.05). One font weight in both states, so activating a chip never
 * reflows a wrapped chip row.
 *
 * @param isActive  Whether the chip is currently selected.
 * @param height    Chip height in px (default 20).
 * @param fontSize  Font size in px (default 11).
 */
export function filterChipSx(
  isActive: boolean,
  height = 20,
  fontSize = 11,
): SxProps<Theme> {
  return {
    height,
    fontSize,
    fontWeight: 500,
    borderRadius: CHIP_RADIUS,
    bgcolor: isActive ? ACCENT_TINT : 'transparent',
    color: isActive ? INK_HIGH : 'text.secondary',
    border: `1px solid ${isActive ? ACCENT_BORDER : CHIP_BORDER}`,
    '& .MuiChip-label': { px: 0.5 },
    cursor: 'pointer',
    '&:hover': {
      bgcolor: isActive ? ACCENT_TINT_HOVER : CHIP_HOVER,
    },
  };
}
