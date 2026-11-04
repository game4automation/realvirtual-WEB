// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RootErrorBoundary — the error boundary around the WHOLE HMI React root (plan-2022 Phase 0).
 *
 * Without it, a render error anywhere in the HMI unmounts the entire overlay: the 3D scene keeps
 * running, every panel is gone, and nothing tells the operator why (the "grey panels, only 3D
 * visible" reports). With it:
 *
 *  - the error is logged (`console.error('[RootErrorBoundary]', error, componentStack)`) and lands
 *    in the Problems list (`reportProblem`),
 *  - an optional structured receiver ({@link setOnRootError}) gets error + component stack — no
 *    receiver in Phase 0, the diagnostics collector registers here later,
 *  - a small card replaces the overlay with a "Rebuild interface" button,
 *  - the HMI is remounted automatically ONCE, 1 s after the crash. A second crash within 30 s of
 *    the previous one is not auto-remounted again (a crash loop would otherwise flicker forever);
 *    the card then stays until the user rebuilds by hand.
 *
 * The card itself uses no store, no context and no lazy import: it must render even when the
 * state that crashed the HMI is still broken. It sits outside the HMI's ThemeProvider, so every
 * colour is set explicitly from the shared design values.
 */

import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { Box, ButtonBase, Typography } from '@mui/material';
import { WarningAmber } from '@mui/icons-material';
import { reportProblem } from './problems-store';
import { ACCENT, FS, ICON_SIZE, INK_HIGH, INK_MID, PANEL_SURFACE, WARN } from './shared-sx';

/** Delay before the one automatic remount, in milliseconds. */
export const ROOT_AUTO_REMOUNT_DELAY_MS = 1000;

/** A crash within this many milliseconds of the previous one is not auto-remounted. */
export const ROOT_CRASH_LOOP_WINDOW_MS = 30_000;

/** Problems-list id of the HMI crash entry (re-reported, never appended). */
export const ROOT_CRASH_PROBLEM_ID = 'hmi-root-crash';

/** Structured receiver of a root render error. */
export type RootErrorHandler = (error: unknown, componentStack: string) => void;

let _onRootError: RootErrorHandler | null = null;
let _onSaveDiagnostics: (() => void) | null = null;

/**
 * Registers (or with `null` removes) the one structured receiver of root render errors.
 * Phase 0 has no receiver; the diagnostics collector registers here in Phase 1.
 */
export function setOnRootError(handler: RootErrorHandler | null): void {
  _onRootError = handler;
}

/** Optional Phase 3 action; kept injectable so this crash-safe boundary has no diagnostics import. */
export function setOnRootSaveDiagnostics(handler: (() => void) | null): void {
  _onSaveDiagnostics = handler;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  failed: boolean;
  /** Key of the children wrapper — bumping it remounts the whole HMI tree. */
  generation: number;
}

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { failed: false, generation: 0 };

  private lastCrashAt: number | null = null;
  private remountTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(): Partial<RootErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? '';
    console.error('[RootErrorBoundary]', error, componentStack);
    try {
      reportProblem({
        id: ROOT_CRASH_PROBLEM_ID,
        severity: 'error',
        code: ROOT_CRASH_PROBLEM_ID,
        title: 'The interface crashed',
        detail: errorMessage(error),
      });
    } catch { /* the card must appear even if the problems list is broken */ }
    try {
      _onRootError?.(error, componentStack);
    } catch { /* a faulty receiver must not take the boundary down */ }

    const now = Date.now();
    const inLoop = this.lastCrashAt !== null && now - this.lastCrashAt < ROOT_CRASH_LOOP_WINDOW_MS;
    this.lastCrashAt = now;
    this.clearTimer();
    if (!inLoop) {
      this.remountTimer = setTimeout(() => {
        this.remountTimer = null;
        this.rebuild();
      }, ROOT_AUTO_REMOUNT_DELAY_MS);
    }
  }

  componentWillUnmount(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.remountTimer !== null) {
      clearTimeout(this.remountTimer);
      this.remountTimer = null;
    }
  }

  private rebuild = (): void => {
    this.clearTimer();
    this.setState(s => ({ failed: false, generation: s.generation + 1 }));
  };

  render(): ReactNode {
    if (!this.state.failed) {
      return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
    }
    return (
      <Box
        data-testid="root-error-card"
        role="alert"
        sx={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
          pointerEvents: 'auto', zIndex: 1,
          display: 'flex', alignItems: 'center', gap: 1.5,
          px: 2, py: 1.25, borderRadius: 1,
          bgcolor: PANEL_SURFACE, border: `1px solid ${WARN}66`,
        }}
      >
        <WarningAmber role="img" aria-label="Warning" sx={{ fontSize: ICON_SIZE.lg, color: WARN, flexShrink: 0 }} />
        <Typography sx={{ fontSize: FS.body, color: INK_HIGH }}>The interface crashed.</Typography>
        <ButtonBase
          data-testid="root-error-rebuild"
          onClick={this.rebuild}
          sx={{
            px: 1.25, py: 0.5, borderRadius: 1,
            fontSize: FS.body, color: ACCENT, border: `1px solid ${ACCENT}66`,
            '&:hover': { bgcolor: `${ACCENT}1a` },
          }}
        >
          Rebuild interface
        </ButtonBase>
        {_onSaveDiagnostics && (
          <ButtonBase
            data-testid="root-error-save-diagnostics"
            onClick={_onSaveDiagnostics}
            sx={{
              px: 1.25, py: 0.5, borderRadius: 1,
              fontSize: FS.body, color: ACCENT, border: `1px solid ${ACCENT}66`,
              '&:hover': { bgcolor: `${ACCENT}1a` },
            }}
          >
            Save diagnostics
          </ButtonBase>
        )}
        <Typography component="span" sx={{ fontSize: FS.micro, color: INK_MID }}>
          Details are in the browser console.
        </Typography>
      </Box>
    );
  }
}
