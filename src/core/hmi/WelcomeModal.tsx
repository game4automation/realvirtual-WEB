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
import { getProjectStore } from '../project/project-store';
import { DEMO_PROJECT_SLUG } from '../project/backends/bundled-backend';
import { documentsInSection, findStartDocument, stableDocumentId } from '../project/rv-project-documents';
import { projectStartDocument } from '../project/rv-project-open';
import type { RvProject } from '../project/rv-project-types';

/** Primary use cases, shown as a compact list. */
const USE_CASES: Array<[string, string]> = [
  ['3D HMI & monitoring', 'live PLC dashboards in the browser'],
  ['Machine & maintenance info', 'documents, guides and drawings on 3D parts'],
  ['Product configuration', 'interactive configurators from a single GLB'],
  ['Sales & presales', 'share a live digital twin with one link'],
  ['Training', 'safe, interactive learning environments'],
];

/**
 * Deep links to the two built-in demos, addressed as DOCUMENTS of the demo
 * project (plan-726 Phase 5).
 *
 * Both buttons used to carry a filename literal each — `?model=…glb` and
 * `?scene=published:…` — which made this file two of the seven independent
 * definitions of "the demo model". They now resolve against the active
 * project's own manifest, so renaming or replacing a demo document changes one
 * file (`public/project.json`) instead of seven.
 *
 * `?doc=<id>` is the app's own canonical document address, and the ids the
 * manifest carries are `stableDocumentId(path)` — the same ids
 * `openDocument()` writes into the address bar. A link built here is therefore
 * indistinguishable from one the user copied out of their own URL bar.
 *
 * The fallbacks are not decoration: this modal can be shown before a project
 * resolves, and then there is no document list to pick an id from. What they
 * must NOT be is a second definition of "the demo model" — that was the whole
 * point of routing these buttons through the manifest.
 *
 * So the HMI fallback names the PROJECT, not a file: `?project=demorealvirtual`
 * (the `DEMO_PROJECT_SLUG` route, plan-726 F7). An href is a navigation target,
 * not a render-time answer — following it reloads the app, and resolution then
 * runs normally and picks the project's own start document from the manifest.
 * The race this fallback covers therefore costs nothing: the link is as correct
 * as the `?doc=` one, just resolved a moment later.
 *
 * Since plan-735 `readManifest()` DOES return null — a deploy root without a
 * readable `project.json` has no project, and none is invented. That does not
 * weaken this fallback: the slug is a NAVIGATION target, and following it on a
 * deploy with no manifest lands on the same "no project here" answer the boot
 * would have given anyway, named rather than silent. What it does mean is that
 * the fallback is no longer a guarantee that *something* opens — it is a
 * guarantee that the link is correct wherever a project exists at all.
 *
 * The planner fallback used to carry the literal `?scene=published:DemoPlanner`
 * — the last hard-coded address in the second identity space plan-731 melted
 * down, and the first click of a community visitor. A project reference cannot
 * replace it (that addresses the START document, and this button deliberately
 * opens a DIFFERENT one), so it names the same document the manifest row does,
 * by the same derivation: `stableDocumentId(<path>)`.
 *
 * That is not a second definition sneaking back in. `stableDocumentId` is a pure
 * function of the path, and it is what MINTED the id sitting in
 * `public/project.json` — the fallback and the manifest cannot drift, because
 * one computes what the other stores. The path literal is the only input, and
 * `DEMO_PLANNER_PATH` is where it is spelled once.
 */

/**
 * Path of the planner demo document, relative to the deploy root — the sole
 * input of the planner fallback link. Matches the `documents[]` row in
 * `public/project.json`.
 */
const DEMO_PLANNER_PATH = 'DemoPlanner.glb';
function demoHref(
  pick: (project: RvProject | null) => { id: string } | null | undefined,
  fallback: string,
  extraParams = '',
): string {
  const base = import.meta.env.BASE_URL;
  const doc = pick(getProjectStore().getProject());
  return doc
    ? `${base}?doc=${encodeURIComponent(doc.id)}${extraParams}`
    : `${base}${fallback}`;
}

/** The HMI demo: the project's own start document. */
function hmiDemoHref(): string {
  return demoHref(
    project => findStartDocument(project, projectStartDocument(project))
      ?? documentsInSection(project, 'models')[0],
    `?project=${DEMO_PROJECT_SLUG}`,
  );
}

/** The planner demo: the project's first scene document, opened in planner mode. */
function plannerDemoHref(): string {
  return demoHref(
    project => documentsInSection(project, 'scenes')[0],
    `?doc=${encodeURIComponent(stableDocumentId(DEMO_PLANNER_PATH))}&mode=planner`,
    '&mode=planner',
  );
}

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
                href={hmiDemoHref()}
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
                href={plannerDemoHref()}
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
