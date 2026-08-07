// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { createTheme, type Theme } from '@mui/material/styles';
import { CHIP_RADIUS } from './shared-sx';

/** Create a branded theme with custom primary/secondary colors. */
export function createBrandedTheme(primary?: string, secondary?: string): Theme {
  return createTheme({
    ...rvDarkTheme,
    palette: {
      ...rvDarkTheme.palette,
      ...(primary && { primary: { main: primary } }),
      ...(secondary && { secondary: { main: secondary } }),
    },
  });
}

export const rvDarkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary:    { main: '#4fc3f7' },
    secondary:  { main: '#e94078' },
    success:    { main: '#66bb6a' },
    warning:    { main: '#ffa726' },
    error:      { main: '#ef5350' },
    background: {
      default: 'rgba(0, 0, 0, 0)',
      // Brightest of three tiers — the glassy default for everything FLOATING
      // over the 3D viewport (KPI cards, message tiles, search bar, floating
      // tool toolbar, dialogs…). Windows (LeftPanel) and the outer toolbars are
      // progressively darker. Lower opacity + lighter base = brighter glass.
      paper: 'rgba(30, 30, 30, 0.6)',
    },
  },
  typography: {
    fontFamily: '"Inter", "Roboto", "Arial", sans-serif',
    fontSize: 13,
  },
  shape: {
    borderRadius: 4,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: 'transparent' },
        // Keyboard navigation needs a visible focus ring on every interactive
        // element; MUI's ripple-based focus is invisible on glass surfaces.
        // :focus-visible keeps pointer clicks ring-free.
        ':focus-visible': {
          outline: '2px solid #4fc3f7',
          outlineOffset: '1px',
        },
        // Increase base font size on touch devices so UI is readable on phones
        '@media (hover: none) and (pointer: coarse)': {
          html: { fontSize: '16px' },
        },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          // Base radius × the live `--rv-ui-blur-scale` factor (rv-ui-blur.ts).
          // At the default factor 1 this resolves to exactly the 16px radius this
          // rule always had, i.e. the pre-plan-344 look; the `Fast` visual preset
          // sets 0.25, which lands it on a quarter of that. The factor lives on
          // `document.documentElement`, so portalled Papers (Dialog / Menu /
          // Popover in document.body) inherit it too.
          backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))',
          backgroundImage: 'none !important',
          backgroundColor: 'rgba(30, 30, 30, 0.6) !important',
          // Reduce blur on touch devices for GPU performance. This is a lower
          // BASE radius, not a bypass — it scales with the same factor.
          '@media (hover: none) and (pointer: coarse)': {
            backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          // Depth comes from the three glass tiers, never from shadows —
          // without this, MUI's default elevation-24 dialog shadow leaks
          // through the elevation-0 Paper override. A hairline border keeps
          // the dialog separated from the scene behind the glass.
          boxShadow: 'none',
          border: '1px solid rgba(255,255,255,0.08)',
        },
      },
    },
    MuiButtonBase: {
      styleOverrides: {
        root: {
          // ButtonBase resets `outline: 0` with the same specificity as the
          // global :focus-visible rule — restore the ring where it matters most.
          '&:focus-visible': {
            outline: '2px solid #4fc3f7',
            outlineOffset: '1px',
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          // Squared chips everywhere — MUI's fully-rounded pill reads as a
          // consumer tag; the crisp corner keeps every chip in the HMI one
          // family (see CHIP_RADIUS in shared-sx.ts).
          borderRadius: CHIP_RADIUS,
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          // Touch-friendly targets on coarse-pointer devices (Apple HIG: 44px)
          '@media (pointer: coarse)': {
            minWidth: 44,
            minHeight: 44,
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          '@media (pointer: coarse)': {
            minHeight: 44,
          },
        },
      },
    },
  },
});
