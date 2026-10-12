// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect } from 'react';
import { Box, Modal, Typography, Button } from '@mui/material';
import SlideshowOutlinedIcon from '@mui/icons-material/SlideshowOutlined';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import { setWelcomeModalOpen } from './welcome-modal-store';
import { useCustomBranding } from './branding-store';
import { formatVersionFull } from '../rv-version';
import { getProjectStore } from '../project/project-store';
import { DEMO_PROJECT_SLUG } from '../project/backends/bundled-backend';
import { documentsOf, findStartDocument, stableDocumentId } from '../project/rv-project-documents';
import { projectStartDocument } from '../project/rv-project-open';
import type { RvProject } from '../project/rv-project-types';

/** Primary use cases, shown as a compact list. */
const USE_CASES: Array<[string, string]> = [
  ['Virtual commissioning', 'test real PLC code against the twin before the machine is built'],
  ['3D HMI & monitoring', 'live PLC dashboards in the browser'],
  ['Material flow studies', 'throughput and bottlenecks with the DES kernel'],
  ['Machine & maintenance info', 'documents, guides and drawings on 3D parts'],
  ['Product configuration', 'interactive configurators from a single GLB'],
  ['Sales & presales', 'share a live digital twin with one link'],
  ['Training', 'safe, interactive learning environments'],
];

/**
 * Interface types realvirtual CONNECT ships today — the number the welcome
 * text quotes. The authoritative list is the CONNECT "Supported Protocols"
 * documentation page; further protocols exist in realvirtual for Unity and
 * must NOT be named here as if CONNECT spoke them.
 */
const CONNECT_PROTOCOL_COUNT = 15;

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

/**
 * The document a `demos` entry names, or null.
 *
 * `project.demos` is the manifest saying WHICH document a demo link opens
 * (plan-744 F8). It replaced two section lookups — "the first document under
 * `models/`", "the first under `scenes/`" — which made a folder name part of
 * the product's behaviour and answered nothing at all once the demo project
 * stopped filing its documents that way.
 */
function statedDemo(
  project: RvProject | null,
  which: 'hmi' | 'planner',
): { id: string } | null {
  const stated = project?.demos?.[which];
  if (typeof stated !== 'string' || stated.trim() === '') return null;
  return documentsOf(project).find(d => d.id === stated) ?? null;
}

/** The HMI demo: what the manifest states, else the project's start document. */
function hmiDemoHref(): string {
  return demoHref(
    project => statedDemo(project, 'hmi')
      ?? findStartDocument(project, projectStartDocument(project))
      ?? documentsOf(project)[0],
    `?project=${DEMO_PROJECT_SLUG}&mode=hmi`,
    '&mode=hmi',
  );
}

/** The planner demo: what the manifest states, else the project's first document. */
function plannerDemoHref(): string {
  return demoHref(
    project => statedDemo(project, 'planner') ?? documentsOf(project)[0],
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

  return (
    <Modal
      open={open}
      onClose={mustAccept ? undefined : onClose}
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
    >
      <Box
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        sx={{
          width: '100vw',
          height: '100dvh',
          maxWidth: 'none',
          maxHeight: 'none',
          borderRadius: 0,
          bgcolor: '#1e1e1e',
          color: 'text.primary',
          backgroundImage: 'none',
          backdropFilter: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Full-width application entry points and supporting information. */}
        <Box
          sx={{
            width: '100%',
            boxSizing: 'border-box',
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            '& > *': { flexShrink: 0 },
            p: { xs: 3, sm: 4, lg: 6 },
            display: 'flex',
            flexDirection: 'column',
            gap: 2.5,
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Typography id={custom ? 'welcome-title' : undefined} variant="h6" sx={{ fontWeight: 700, color: '#4fc3f7' }}>
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
          {!custom && (
            <Box component="section" aria-labelledby="welcome-title" sx={{ py: { xs: 1, md: 4 } }}>
              <Typography id="welcome-title" component="h1" variant="h3" sx={{ fontWeight: 600, fontSize: { xs: '2rem', md: '3rem' } }}>
                What would you like to do?
              </Typography>
              <Typography sx={{ color: 'text.secondary', mt: 1, mb: 4 }}>
                Choose an application to get started.
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: { xs: 2, md: 4 } }}>
                {[
                  { title: 'Demo scene', description: 'Machine information system', detail: 'Explore the machine and its documents, maintenance guides and technical drawings.', href: hmiDemoHref(), icon: <ViewQuiltOutlinedIcon />, id: 'welcome-demo-hmi', action: 'Open demo scene' },
                  { title: 'Layout planning', description: 'Build your material flow', detail: 'Open the planner demo and arrange reusable library objects into your own layout.', href: plannerDemoHref(), icon: <GridViewOutlinedIcon />, id: 'welcome-demo-planner', action: 'Open layout planning' },
                  { title: 'Editor', description: 'Start with your CAD model', detail: 'Open an empty editor with CAD import ready to bring in your model.', href: `${import.meta.env.BASE_URL}?doc=new&mode=editor`, icon: <FileUploadOutlinedIcon />, id: 'welcome-editor', action: 'Open editor & import CAD' },
                ].map(app => (
                  <Box key={app.id} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', borderTop: 1, borderColor: 'divider', pt: 3, gap: 1.5 }}>
                    <Typography component="h2" variant="h5" sx={{ fontWeight: 600 }}>{app.title}</Typography>
                    <Typography sx={{ fontWeight: 600 }}>{app.description}</Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: '48ch', lineHeight: 1.7, mb: 1 }}>{app.detail}</Typography>
                    <Button component="a" href={app.href} onClick={acceptAndClose} variant="outlined" startIcon={app.icon} endIcon={<ArrowForwardIcon />} data-testid={app.id}
                      sx={{ mt: 'auto', minHeight: 44, textTransform: 'none', textAlign: 'left', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 4 } }}>
                      {app.action}
                    </Button>
                  </Box>
                ))}
              </Box>
              {mustAccept && (
                <Typography variant="body2" sx={{ color: 'text.secondary', mt: 3 }}>
                  By opening an application you acknowledge the beta status and accept the{' '}
                  <Box component="a" href="https://realvirtual.io/en/terms/" target="_blank" rel="noopener noreferrer" sx={{ color: 'primary.main', textUnderlineOffset: '3px' }}>license terms</Box>.
                </Typography>
              )}
            </Box>
          )}

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' }, gap: { xs: 3, md: 6 }, borderTop: 1, borderColor: 'divider', pt: 3 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: '75ch' }}>
              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
                A browser-based digital twin platform for industrial automation — from CAD
                import and kinematics to virtual commissioning, 3D HMI and material flow,
                live in the browser. Use it for:
              </Typography>

              <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {USE_CASES.map(([label, desc]) => (
                  <Typography key={label} component="li" variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
                    <strong style={{ color: '#fff' }}>{label}</strong> &mdash; {desc}
                  </Typography>
                ))}
              </Box>

            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: '75ch' }}>
              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
                One link is all it takes. Share interactive 3D digital twins with operators,
                service technicians, sales teams, and customers — directly in the browser,
                on any device, no installation required.
                No cloud lock-in. Your data, your server.
              </Typography>

              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
                Build the twin in the browser as well: import STEP, JT, USD or FBX geometry,
                structure and kinematize it, size drives from the resulting forces, and run
                the line — no CAD round trip and no installation.
              </Typography>

              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
                Then connect it to the real controller with{' '}
                <a href="https://realvirtual.io/en/products/connect/" target="_blank" rel="noopener noreferrer" style={{ color: '#4fc3f7', textDecoration: 'none' }}>
                  realvirtual CONNECT
                </a>, the local gateway that speaks {CONNECT_PROTOCOL_COUNT} industrial protocols —
                Siemens S7 and PLCSIM Advanced, OPC UA, Beckhoff TwinCAT ADS, Modbus TCP,
                EtherNet/IP, MQTT, Bosch Rexroth ctrlX, Keba, Festo AX, FANUC, Denso and
                ABB RobotStudio. That is what makes virtual commissioning work in a browser:
                your PLC program drives the twin exactly as it drives the machine.
              </Typography>

              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
                Attach documents, maintenance guides,
                and technical drawings directly to 3D components. Build product configurators,
                KPI dashboards, and training environments — all from a single GLB export.
              </Typography>

            </Box>
          </Box>

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
            <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', fontSize: 10 }}>
              realvirtual WEB {formatVersionFull()}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              &copy; 2025 realvirtual GmbH
            </Typography>
          </Box>

        </Box>
        <Box
          component="footer"
          sx={{
            width: '100%',
            boxSizing: 'border-box',
            flexShrink: 0,
            borderTop: 1,
            borderColor: 'divider',
            px: { xs: 3, sm: 4, lg: 6 },
            pt: 2,
            pb: 'max(16px, env(safe-area-inset-bottom))',
          }}
        >
          {mustAccept && (
            <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
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
                sx={{ textTransform: 'none', fontWeight: 600, minHeight: 44 }}
              >
                Start Demo
              </Button>
            )}
            <Button
              variant="contained"
              size="small"
              onClick={acceptAndClose}
              data-testid="welcome-dismiss"
              sx={{ textTransform: 'none', fontWeight: 600, minHeight: 44 }}
            >
              {mustAccept ? 'Accept & continue' : 'Got it'}
            </Button>
          </Box>
        </Box>
      </Box>
    </Modal>
  );
}
