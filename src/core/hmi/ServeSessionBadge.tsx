// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ServeSessionBadge — dev-server-only banner naming the checkout this tab is
 * served from.
 *
 * With several worktree sessions open at once nothing in the viewport tells
 * them apart, and the expensive mistake is not noticing that a tab points at
 * the CANONICAL checkout, which pure web plans must not edit (ADR-040). The
 * banner therefore states DEV SERVER plainly and names the served directory —
 * the directory is the authority, branch and plan are derived from it.
 *
 * The whole subtree disappears from production builds: `RV_SERVE_INFO` is the
 * injected `__RV_SERVE_INFO__` constant, replaced by the literal `null` for
 * every command except `serve`, so Rollup eliminates it — no banner, and no
 * machine path in the bundle.
 *
 * Dismissal is intentionally NOT persisted: closing it clears the current view,
 * every reload brings it back. A dev-server warning you can permanently silence
 * is one you will eventually forget about — which is the failure mode it exists
 * to prevent.
 */

import { useEffect, useState } from 'react';
import { Box, IconButton, Portal, Typography } from '@mui/material';
import { Close } from '@mui/icons-material';
import {
  RV_SERVE_INFO,
  isCanonicalCheckout,
  formatServeRoot,
  formatSessionLabel,
} from '../rv-serve-info';

/**
 * Above every product layer, including the welcome overlay (10000).
 *
 * Normally overlay stacking is solved with MUI `Modal` rather than z-index
 * bumps, but this banner is not a competing product overlay: it is a dev-only
 * status strip that must stay readable and closable at all times — the welcome
 * overlay is not dismissable by backdrop click, so a lower value would leave
 * the close button dead on every fresh load. It occupies a 21 px strip at the
 * very top and never exists in a build.
 */
const BANNER_ZINDEX = 10001;

export function ServeSessionBadge() {
  const info = RV_SERVE_INFO;
  const [dismissed, setDismissed] = useState(false);
  const canonical = isCanonicalCheckout(info);
  const sessionLabel = formatSessionLabel(info);

  // The tab title carries the session as well: with several tabs open the tab
  // bar is where you actually look, and the banner is only visible in the
  // focused tab — and gone entirely once dismissed.
  useEffect(() => {
    if (!info) return;
    const original = document.title;
    document.title = `[${sessionLabel}] ${original}`;
    return () => { document.title = original; };
  }, [info, sessionLabel]);

  if (!info || dismissed) return null;

  return (
    // Portalled to <body>: mounted inside the app root, the banner sits in the
    // root's stacking context and loses to the welcome overlay's own body-level
    // portal no matter how high its z-index goes.
    <Portal>
    <Box
      data-ui-panel
      data-testid="serve-session-badge"
      role="status"
      title={`Serving ${info.root}${info.branch ? `\nBranch: ${info.branch}` : ''}`}
      sx={{
        position: 'fixed',
        top: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: BANNER_ZINDEX,
        pointerEvents: 'auto',
        userSelect: 'none',
        maxWidth: 'calc(100vw - 16px)',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        pl: 1.25,
        pr: 0.5,
        py: 0.25,
        bgcolor: 'rgba(176,32,32,0.94)',
        borderRadius: '0 0 6px 6px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
        backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
      }}
    >
      <Typography
        component="span"
        sx={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.08em',
          lineHeight: 1.6,
          color: '#fff',
          flexShrink: 0,
        }}
      >
        ENTWICKLUNGSSERVER
      </Typography>
      <Typography
        component="span"
        sx={{
          fontSize: 10.5,
          fontWeight: 600,
          lineHeight: 1.6,
          color: '#fff',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {canonical ? '⚠ CANONICAL' : sessionLabel}
        {info.vitePort ? ` · :${info.vitePort}` : ''}
      </Typography>
      {/* Clipped from the tail: the head of the path (worktree base vs the
          canonical checkout) is what actually tells them apart. */}
      <Typography
        component="span"
        sx={{
          fontSize: 10.5,
          lineHeight: 1.6,
          color: 'rgba(255,255,255,0.8)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}
      >
        {formatServeRoot(info.root)}
      </Typography>
      <IconButton
        size="small"
        onClick={() => setDismissed(true)}
        aria-label="Hide dev server banner until reload"
        sx={{
          p: 0.15,
          flexShrink: 0,
          color: 'rgba(255,255,255,0.75)',
          '&:hover': { color: '#fff' },
        }}
      >
        <Close sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
    </Portal>
  );
}
