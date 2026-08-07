// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Box, Paper, Typography, Button } from '@mui/material';
import SlideshowOutlinedIcon from '@mui/icons-material/SlideshowOutlined';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import { setWelcomeModalOpen } from './welcome-modal-store';
import { useCustomBranding } from './branding-store';
import { formatVersionFull } from '../rv-version';

/** Primary use cases, shown as a compact list. */
const USE_CASES: Array<[string, string]> = [
  ['3D HMI & monitoring', 'live PLC dashboards in the browser'],
  ['Machine & maintenance info', 'documents, guides and drawings on 3D parts'],
  ['Product configuration', 'interactive configurators from a single GLB'],
  ['Sales & presales', 'share a live digital twin with one link'],
  ['Training', 'safe, interactive learning environments'],
];

/** Deep links to the two built-in demos (resolved against the deploy base path). */
const HMI_DEMO_HREF = `${import.meta.env.BASE_URL}?model=DemoRealvirtualWeb.glb`;
const PLANNER_DEMO_HREF = `${import.meta.env.BASE_URL}?scene=published:DemoPlanner&mode=planner`;

// ─── License / beta acceptance ────────────────────────────────────────────
//
// The first time the dialog is shown it acts as an acceptance gate: the
// backdrop does not dismiss it and the confirm button reads "Accept &
// continue". Acceptance covers the beta status and the license terms and is
// recorded once per browser. Where the dialog never auto-opens (Viewer
// workspaces, plan-387 F4) no acceptance is asked — spectators following a
// shared link only run the software, which the AGPL permits without
// accepting anything.

const TERMS_ACCEPTED_KEY = 'rv-terms-accepted';

// Session fallback so a throwing storage (Safari private mode) still holds
// the answer until the page is reloaded.
let sessionAccepted = false;

/** True once the user accepted the beta note + license terms in this browser. */
export function hasAcceptedTerms(): boolean {
  if (sessionAccepted) return true;
  try {
    return localStorage.getItem(TERMS_ACCEPTED_KEY) === '1';
  } catch {
    return false;
  }
}

function recordTermsAccepted(): void {
  sessionAccepted = true;
  try {
    localStorage.setItem(TERMS_ACCEPTED_KEY, '1');
  } catch {
    // Storage unavailable — sessionAccepted carries the answer.
  }
}

interface WelcomeModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional: when supplied, a "Start Demo" button is rendered beside "Got it". */
  onStartDemo?: () => void;
}

export function WelcomeModal({ open, onClose, onStartDemo }: WelcomeModalProps) {
  // Track visibility in the welcome-modal-store so KioskPlugin can pause idle
  // detection while the modal blocks interaction. Cleanup on unmount sets false.
  useEffect(() => {
    setWelcomeModalOpen(open);
    return () => { setWelcomeModalOpen(false); };
  }, [open]);

  // Demo links only make sense on the public realvirtual demo. A customer deploy
  // sets custom branding, so we hide the demo shortcuts there.
  const custom = useCustomBranding();

  // First visit in this browser: the dialog is an acceptance gate. Reading
  // storage at render is fine — the component renders only while visible.
  const mustAccept = open && !hasAcceptedTerms();

  const acceptAndClose = () => {
    recordTermsAccepted();
    onClose();
  };

  if (!open) return null;

  return createPortal(
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.6)',
        pointerEvents: 'auto',
      }}
      onClick={mustAccept ? undefined : onClose}
    >
      <Paper
        elevation={12}
        sx={{
          borderRadius: 2,
          width: 680,
          maxWidth: '95vw',
          p: { xs: 2.5, sm: 4 },
          display: 'flex',
          flexDirection: 'column',
          gap: 2.5,
          maxHeight: '90dvh',
          overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, color: '#4fc3f7' }}>
            realvirtual WEB
          </Typography>
          <Box
            component="span"
            data-testid="welcome-beta-badge"
            sx={{
              px: 0.75,
              borderRadius: 1,
              border: '1px solid rgba(79,195,247,0.5)',
              color: '#4fc3f7',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 1.5,
              lineHeight: '18px',
            }}
          >
            BETA
          </Box>
        </Box>
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.45)', letterSpacing: 2, textTransform: 'uppercase', fontSize: 10, mt: -1 }}>
          Open. Light. Industrial. Anywhere.
        </Typography>

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          A browser-based 3D HMI and digital-twin viewer for industrial automation —
          everything from a single GLB export, live in the browser. Use it for:
        </Typography>

        <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {USE_CASES.map(([label, desc]) => (
            <Typography key={label} component="li" variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
              <strong style={{ color: '#fff' }}>{label}</strong> &mdash; {desc}
            </Typography>
          ))}
        </Box>

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          One link is all it takes. Share interactive 3D digital twins with operators,
          service technicians, sales teams, and customers — directly in the browser,
          on any device, no installation required.
          No cloud lock-in. Your data, your server.
        </Typography>

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          Connect to real PLCs via WebSocket or MQTT. Attach documents, maintenance guides,
          and technical drawings directly to 3D components. Build product configurators,
          KPI dashboards, and training environments — all from a single GLB export.
        </Typography>

        {!custom && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography variant="body2" sx={{ color: '#fff', fontWeight: 600 }}>
              Two demos to explore
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Button
                component="a"
                href={HMI_DEMO_HREF}
                variant="outlined"
                size="small"
                startIcon={<ViewQuiltOutlinedIcon />}
                data-testid="welcome-demo-hmi"
                sx={{ textTransform: 'none', fontWeight: 600, minWidth: 150, justifyContent: 'flex-start' }}
              >
                HMI Demo
              </Button>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Operate &amp; monitor a running line
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Button
                component="a"
                href={PLANNER_DEMO_HREF}
                variant="outlined"
                size="small"
                startIcon={<GridViewOutlinedIcon />}
                data-testid="welcome-demo-planner"
                sx={{ textTransform: 'none', fontWeight: 600, minWidth: 150, justifyContent: 'flex-start' }}
              >
                Planner Demo
              </Button>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Build a layout from reusable library objects
              </Typography>
            </Box>
          </Box>
        )}

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          <strong style={{ color: '#fff' }}>Beta software</strong> — realvirtual WEB is under
          active development. Features, file formats, and APIs may still change, and it is
          not intended for production use yet.
          Open source under the <strong style={{ color: '#fff' }}>AGPL-3.0 license</strong>.
          Provided as is, without warranty of any kind — see the{' '}
          <a href="https://realvirtual.io/en/terms/" target="_blank" rel="noopener noreferrer" style={{ color: '#4fc3f7', textDecoration: 'none' }}>
            license terms
          </a>.
          Part of the{' '}
          <a href="https://realvirtual.io" target="_blank" rel="noopener noreferrer" style={{ color: '#4fc3f7', textDecoration: 'none' }}>
            realvirtual.io
          </a>{' '}
          industrial digital twin platform.
        </Typography>

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          <a href="https://github.com/game4automation/realvirtual-WEB" target="_blank" rel="noopener noreferrer" style={{ color: '#4fc3f7', textDecoration: 'none' }}>
            github.com/game4automation/realvirtual-WEB
          </a>
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', fontSize: 10 }}>
            realvirtual WEB {formatVersionFull()}
          </Typography>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)' }}>
            &copy; 2025 realvirtual GmbH
          </Typography>
        </Box>

        {mustAccept && (
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
            By continuing you acknowledge the beta status of this software and accept the
            license terms.
          </Typography>
        )}

        <Box sx={{ display: 'flex', justifyContent: onStartDemo ? 'space-between' : 'flex-end', mt: 1, gap: 1 }}>
          {onStartDemo && (
            <Button
              variant="contained"
              color="primary"
              size="small"
              startIcon={<SlideshowOutlinedIcon />}
              onClick={() => { acceptAndClose(); onStartDemo(); }}
              data-testid="welcome-start-demo"
              sx={{ textTransform: 'none', fontWeight: 600 }}
            >
              Start Demo
            </Button>
          )}
          <Button
            variant="contained"
            size="small"
            onClick={acceptAndClose}
            data-testid="welcome-dismiss"
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {mustAccept ? 'Accept & continue' : 'Got it'}
          </Button>
        </Box>
      </Paper>
    </Box>,
    document.body,
  );
}
