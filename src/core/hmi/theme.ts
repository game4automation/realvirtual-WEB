// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { createTheme } from '@mui/material/styles';

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
      paper: 'rgba(18, 18, 18, 0.65)',
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
          backdropFilter: 'blur(16px)',
          backgroundImage: 'none !important',
          backgroundColor: 'rgba(18, 18, 18, 0.65) !important',
          // Reduce blur on touch devices for GPU performance
          '@media (hover: none) and (pointer: coarse)': {
            backdropFilter: 'blur(8px)',
          },
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
