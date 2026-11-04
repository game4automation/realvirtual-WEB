// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Terms gate (plan-2209) — a blocking, versioned clickwrap shown BEFORE the
 * viewer boots, modelled on the analytics gate (consent-gate.tsx).
 *
 * - `demo`: the public demo is a hosted service under its own terms (EULA
 *   Part B §13.8(5)); they only bind an account-less visitor when shown and
 *   accepted before use, so the demo does not start without an active accept.
 * - `developer`: the commercial customer workspace on the dev server asks the
 *   developer once to accept the licence terms (Part B, incl. §13.8).
 * - `off`: every other build — and the define drops the dynamic import of this
 *   module in main.ts, so it is not even shipped there.
 *
 * Rules that are part of the contract:
 * - `navigator.webdriver === true` (Playwright, recording scripts, smoke tests)
 *   resolves at once and stores NOTHING — automation is not consent.
 * - ESC never closes the dialog and never counts as consent; "Not now" shows an
 *   info view and leaves the promise pending.
 * - The gate never touches `location` (no history.replaceState): a deep link
 *   `?doc=…&mode=…#…` reaches the boot exactly as it was opened.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeProvider, type Theme } from '@mui/material/styles';
import { Box, Typography, Button, Paper, Link } from '@mui/material';
import { GavelOutlined } from '@mui/icons-material';
import { rvDarkTheme } from './theme';
import {
  DEMO_TERMS_VERSION, DEVELOPER_TERMS_VERSION, grantTermsConsent, hasTermsConsent,
  type TermsGateMode,
} from './terms-consent-store';

/** DOM id of the gate's own React root. */
export const TERMS_GATE_ROOT_ID = 'rv-terms-gate-root';

type GateMode = Exclude<TermsGateMode, 'off'>;

export interface RequireTermsConsentOptions {
  /** Gate mode; defaults to the build define `__RV_TERMS_GATE__`. */
  mode?: TermsGateMode;
}

interface GateTexts {
  title: string;
  intro: string;
  points: string[];
  linkLabel: string;
  newTab: string;
  accept: string;
  notNow: string;
  version: string;
  infoTitle: string;
  infoBody: string;
  infoLink: string;
  back: string;
}

/** Binding text is the linked version; the dialog carries a short summary only. */
const TERMS_URL = 'https://realvirtual.io/en/terms/#part-b';

const INFO_URL = 'https://realvirtual.io';

const TEXTS: Record<GateMode, GateTexts> = {
  demo: {
    title: 'realvirtual public demo',
    intro: 'Before you start: the demo is a free service of realvirtual GmbH for evaluation and non-commercial use only. Commercial projects need a realvirtual Commercial licence or a self-hosted Community (AGPL) installation.',
    points: [
      'No automated bulk use. AI assistants connected through realvirtual CONNECT (MCP) are allowed within the limits.',
      'No reselling of access and no embedding in your own commercial offering.',
      'No support and no availability commitment; liability is excluded to the extent permitted by law.',
    ],
    linkLabel: 'Terms of use (Part B, section 13.8)',
    newTab: '(opens in a new tab)',
    accept: 'Accept and start demo',
    notNow: 'Not now',
    version: `Terms version ${DEMO_TERMS_VERSION}`,
    infoTitle: 'The demo needs your consent',
    infoBody: 'The demo starts only after you accept the terms of use. Nothing has been loaded or stored.',
    infoLink: 'More about realvirtual at realvirtual.io',
    back: 'Back',
  },
  developer: {
    title: 'realvirtual Commercial — licence terms',
    intro: 'This workspace contains realvirtual Commercial. Before you develop with it, please accept the licence terms (Part B).',
    points: [
      'Development licence: you may use the commercial modules to develop your projects.',
      'Every deployment to a machine or an end customer needs its own deployment licence.',
      'Section 13.8: the source code of the commercial modules is confidential — do not publish or pass it on.',
    ],
    linkLabel: 'Licence terms (Part B)',
    newTab: '(opens in a new tab)',
    accept: 'Accept licence terms',
    notNow: 'Not now',
    version: `Terms version ${DEVELOPER_TERMS_VERSION}`,
    infoTitle: 'The licence terms need your consent',
    infoBody: 'The workspace starts only after you accept the licence terms. Nothing has been loaded or stored.',
    infoLink: 'More about realvirtual at realvirtual.io',
    back: 'Back',
  },
};

function isAutomated(): boolean {
  return typeof navigator !== 'undefined' && navigator.webdriver === true;
}

/** One dialog per page: a second caller waits for the same answer. */
let pending: Promise<void> | null = null;
/** Tear-down of the open dialog (unmount + restore inert); null when none is open. */
let teardown: (() => void) | null = null;

/** Tests only: remove an open dialog without answering it (its promise stays pending). */
export function resetTermsGateForTests(): void {
  teardown?.();
  teardown = null;
  pending = null;
}

/**
 * Resolve at once when the mode is `off`, the browser is automated
 * (`navigator.webdriver`, nothing stored) or the current terms version was
 * already accepted. Otherwise mount the blocking dialog and resolve only after
 * the user accepts.
 */
export function requireTermsConsent(options: RequireTermsConsentOptions = {}): Promise<void> {
  const mode = options.mode ?? __RV_TERMS_GATE__;
  if (mode === 'off') return Promise.resolve();
  if (isAutomated()) return Promise.resolve();
  if (hasTermsConsent(mode)) return Promise.resolve();
  if (pending) return pending;

  pending = new Promise<void>((resolve) => {
    const el = document.createElement('div');
    el.id = TERMS_GATE_ROOT_ID;
    el.style.cssText = 'position:fixed;inset:0;z-index:30000;pointer-events:auto;';

    // Make the page behind the dialog inert while it is open (keyboard and
    // screen readers stay inside the dialog); restore exactly what we changed.
    const madeInert: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (!child.hasAttribute('inert')) {
        child.setAttribute('inert', '');
        madeInert.push(child);
      }
    }
    document.body.appendChild(el);
    const root: Root = createRoot(el);

    const close = (deferred: boolean) => {
      for (const child of madeInert) child.removeAttribute('inert');
      const unmount = () => {
        try { root.unmount(); } catch { /* ignore */ }
        el.remove();
      };
      // From a click, defer the unmount so it does not run during the component's own commit.
      if (deferred) setTimeout(unmount, 0);
      else unmount();
    };
    teardown = () => close(false);

    const finish = () => {
      grantTermsConsent(mode, 'en');
      close(true);
      teardown = null;
      pending = null;
      resolve();
    };

    root.render(
      <ThemeProvider theme={rvDarkTheme}>
        <TermsGate mode={mode} onAccept={finish} />
      </ThemeProvider>,
    );
  });
  return pending;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function TermsGate({ mode, onAccept }: { mode: GateMode; onAccept: () => void }) {
  const [view, setView] = useState<'terms' | 'info'>('terms');
  const dialogRef = useRef<HTMLDivElement>(null);
  const t = TEXTS[mode];

  // Focus the dialog itself on open and on every view switch, so a screen
  // reader announces title + description and Tab starts at the first control.
  useEffect(() => { dialogRef.current?.focus(); }, [view]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // ESC has no effect: it neither closes nor accepts.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    // Keep focus inside the dialog.
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const titleId = 'rv-terms-gate-title';
  const descId = 'rv-terms-gate-desc';
  const buttonSx = {
    minHeight: 44, textTransform: 'none' as const, fontWeight: 700, fontFamily: (t: Theme) => t.typography.fontFamily,
    whiteSpace: 'nowrap' as const, flex: '1 1 auto',
  };
  const linkSx = {
    position: 'relative' as const, fontFamily: (t: Theme) => t.typography.fontFamily, fontSize: 13, color: '#4fc3f7',
    alignSelf: 'flex-start', textDecorationColor: 'rgba(79,195,247,0.5)',
    '&:hover': { textDecoration: 'underline' },
  };
  const hiddenSx = {
    position: 'absolute' as const, width: '1px', height: '1px', m: '-1px', p: 0, overflow: 'hidden',
    clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap' as const, border: 0,
  };

  return (
    <Box sx={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      bgcolor: 'rgba(0,0,0,0.88)', backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))', p: 2,
    }}>
      <Paper
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        data-testid="rv-terms-gate"
        data-view={view}
        onKeyDown={onKeyDown}
        elevation={12}
        sx={{
          width: 520, maxWidth: '100%', maxHeight: '100%', overflowY: 'auto', overflowX: 'hidden',
          fontFamily: (t: Theme) => t.typography.fontFamily,
          scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.2) transparent',
          '&::-webkit-scrollbar': { width: 6 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.2)', borderRadius: '3px' }, p: { xs: 3, sm: 4 }, borderRadius: 1,
          bgcolor: 'rgba(30,30,30,0.97)', border: '1px solid rgba(255,255,255,0.08)',
          display: 'flex', flexDirection: 'column', gap: 2, outline: 'none',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{
            width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
            bgcolor: 'rgba(79,195,247,0.12)', border: '1px solid rgba(79,195,247,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <GavelOutlined sx={{ fontSize: 20, color: '#4fc3f7' }} />
          </Box>
          <Typography id={titleId} component="h2" sx={{ fontSize: 17, fontWeight: 700, color: 'rgba(255,255,255,0.92)' }}>
            {view === 'terms' ? t.title : t.infoTitle}
          </Typography>
        </Box>

        {view === 'terms' ? (
          <>
            <Box id={descId}>
              <Typography sx={{ fontSize: 13.5, color: 'rgba(255,255,255,0.75)', lineHeight: 1.55 }}>
                {t.intro}
              </Typography>
              <Box component="ul" sx={{ m: 0, mt: 1.25, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {t.points.map((point) => (
                  <Typography key={point} component="li" sx={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.5 }}>
                    {point}
                  </Typography>
                ))}
              </Box>
            </Box>

            <Link
              href={TERMS_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="rv-terms-gate-link"
              sx={linkSx}
            >
              {t.linkLabel}
              <Box component="span" sx={hiddenSx}>
                {` ${t.newTab}`}
              </Box>
            </Link>

            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1.5, mt: 0.5 }}>
              <Button
                variant="contained"
                onClick={onAccept}
                data-testid="rv-terms-gate-accept"
                sx={{ ...buttonSx, bgcolor: '#4fc3f7', color: '#0b1a22', '&:hover': { bgcolor: '#4fc3f7cc' } }}
              >
                {t.accept}
              </Button>
              <Button
                variant="outlined"
                onClick={() => setView('info')}
                data-testid="rv-terms-gate-not-now"
                sx={{ ...buttonSx, color: 'rgba(255,255,255,0.85)', borderColor: 'rgba(255,255,255,0.3)' }}
              >
                {t.notNow}
              </Button>
            </Box>

            <Typography data-testid="rv-terms-gate-version" sx={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              {t.version}
            </Typography>
          </>
        ) : (
          <>
            <Typography id={descId} sx={{ fontSize: 13.5, color: 'rgba(255,255,255,0.75)', lineHeight: 1.55 }}>
              {t.infoBody}
            </Typography>
            <Link
              href={INFO_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="rv-terms-gate-info-link"
              sx={linkSx}
            >
              {t.infoLink}
            </Link>
            <Button
              variant="outlined"
              onClick={() => setView('terms')}
              data-testid="rv-terms-gate-back"
              sx={{ ...buttonSx, alignSelf: 'flex-start', color: 'rgba(255,255,255,0.85)', borderColor: 'rgba(255,255,255,0.35)' }}
            >
              {t.back}
            </Button>
          </>
        )}
      </Paper>
    </Box>
  );
}
