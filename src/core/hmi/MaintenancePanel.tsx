// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MaintenancePanel — Step-by-step maintenance wizard UI.
 *
 * Renders a vertical stepper with ISA-101 color coding, three completion types,
 * progress bar, and navigation. Subscribes to maintenance-mode-changed events
 * via the useMaintenanceMode() hook.
 *
 * States:
 *   idle       — not rendered (MessagePanel shows normal messages)
 *   dialog     — mode selection: flythrough vs step-by-step
 *   flythrough — auto-playing camera tour (read-only stepper)
 *   stepbystep — manual step-by-step guide
 *   completed  — summary screen with pass/fail per step
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Paper,
  IconButton,
  Checkbox,
  FormControlLabel,
  LinearProgress,
  Tooltip,
} from '@mui/material';
import {
  ArrowBack,
  NavigateBefore,
  NavigateNext,
  Build,
  Warning,
  CheckCircle,
  RadioButtonUnchecked,
  PlayArrow,
  ListAlt,
  Close,
  SettingsInputComponent,
  MenuBook,
  PanTool,
  OilBarrel,
  Visibility,
  Straighten,
  CleaningServices,
  Lock,
} from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useMaintenanceMode } from '../../hooks/use-maintenance-mode';
import type { MaintenancePluginAPI } from '../types/plugin-types';
import type { MaintenanceDocumentLink, MaintenanceStep } from '../maintenance-parser';
import {
  documentButtonLabel,
  resolveMaintenanceDocument,
  type ResolvedMaintenanceDocument,
} from './maintenance-document-link';
import { openPdfViewer } from './pdf-viewer-store';
import { ISA_GREEN, ISA_AMBER, ISA_RED } from './isa-colors';
import { FS, INK_MID, LIVE } from './shared-sx';

// ─── ISA-101 Colors ──────────────────────────────────────────────────────

const COLOR_DONE    = ISA_GREEN;
const COLOR_ACTIVE  = ISA_AMBER;
const COLOR_PENDING = 'rgba(255,255,255,0.3)';
const COLOR_WARNING = ISA_RED;

// ─── UI texts (plan-522) ────────────────────────────────────────────────

/** Why Next is disabled on an unconfirmed safety step. */
export const MAINTENANCE_BARRIER_HINT = 'Confirm the safety step first';
/** Shown while a live interface is connected — the guide does not move the machine. */
export const MAINTENANCE_LIVE_HINT = 'Live connection — machine is not moved by the guide';

// ─── Step symbols (plan-522 Phase 6) ────────────────────────────────────

/** Material icon of a step symbol key (same keys as the 3D markers). */
const STEP_SYMBOL_ICON: Record<string, typeof Build> = {
  MoveByHand: PanTool,
  Lubricate: OilBarrel,
  TurnScrew: Build,
  Inspect: Visibility,
  Measure: Straighten,
  Clean: CleaningServices,
  Safety: Lock,
  Done: CheckCircle,
};

function StepSymbol({ symbol, color }: { symbol?: string; color: string }) {
  const Icon = symbol ? STEP_SYMBOL_ICON[symbol] : undefined;
  if (!Icon) return null;
  return <Icon data-testid="maintenance-step-symbol" sx={{ fontSize: 14, color, flexShrink: 0, mt: '1px' }} />;
}

// ─── Helper: Get plugin instance ────────────────────────────────────────

function getPlugin(viewer: ReturnType<typeof useViewer>): MaintenancePluginAPI | null {
  return viewer.getPlugin<MaintenancePluginAPI>('maintenance') ?? null;
}

// ─── Step Icon ──────────────────────────────────────────────────────────

function StepIcon({ stepIndex, currentStep, stepResults }: {
  stepIndex: number;
  currentStep: number;
  stepResults: (string | null)[];
}) {
  const result = stepResults[stepIndex];
  const isActive = stepIndex === currentStep;

  if (result === 'pass') {
    return <CheckCircle sx={{ fontSize: 20, color: COLOR_DONE }} />;
  }
  if (result === 'fail') {
    return <Warning sx={{ fontSize: 20, color: COLOR_WARNING }} />;
  }
  if (isActive) {
    return (
      <Box sx={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        border: `2px solid ${COLOR_ACTIVE}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Box sx={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          bgcolor: COLOR_ACTIVE,
        }} />
      </Box>
    );
  }
  return <RadioButtonUnchecked sx={{ fontSize: 20, color: COLOR_PENDING }} />;
}

// ─── Completion UI per type ─────────────────────────────────────────────

function CompletionUI({ step, stepIndex, plugin }: {
  step: MaintenanceStep;
  stepIndex: number;
  plugin: MaintenancePluginAPI;
}) {
  const handleComplete = useCallback(() => {
    plugin.completeStep(stepIndex, 'pass');
    plugin.nextStep();
  }, [plugin, stepIndex]);

  switch (step.completionType) {
    case 'ConfirmWarning':
      return (
        <Box sx={{
          mt: 1.5,
          p: 1.5,
          border: `1px solid ${COLOR_WARNING}`,
          borderRadius: 1,
          bgcolor: 'rgba(239, 83, 80, 0.08)',
        }}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                sx={{
                  color: COLOR_WARNING,
                  '&.Mui-checked': { color: COLOR_WARNING },
                }}
                onChange={handleComplete}
              />
            }
            label={
              <Typography variant="body2" sx={{ color: COLOR_WARNING, fontWeight: 500, fontSize: 12 }}>
                {step.checkboxLabel}
              </Typography>
            }
          />
        </Box>
      );

    case 'Observation':
      return (
        <Box sx={{ mt: 1.5 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={handleComplete}
            sx={{
              textTransform: 'none',
              borderColor: 'rgba(255,255,255,0.2)',
              color: 'text.primary',
              fontSize: 12,
              '&:hover': { borderColor: 'rgba(255,255,255,0.4)' },
            }}
          >
            {step.checkboxLabel || 'Got it'}
          </Button>
        </Box>
      );

    case 'Checkbox':
    default:
      return (
        <Box sx={{ mt: 1.5 }}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                sx={{
                  color: 'rgba(255,255,255,0.3)',
                  '&.Mui-checked': { color: COLOR_DONE },
                }}
                onChange={handleComplete}
              />
            }
            label={
              <Typography variant="body2" sx={{ fontSize: 12 }}>
                {step.checkboxLabel}
              </Typography>
            }
          />
        </Box>
      );
  }
}

// ─── Mode Dialog (flythrough vs step-by-step) ───────────────────────────

function ModeDialog({ plugin }: { plugin: MaintenancePluginAPI }) {
  const state = plugin.getState();
  const proc = state.procedure;
  if (!proc) return null;

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Build sx={{ color: COLOR_ACTIVE, fontSize: 20 }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {proc.name}
        </Typography>
      </Box>

      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {proc.steps.length} steps
        {proc.estimatedMinutes > 0 ? ` / ~${proc.estimatedMinutes} min` : ''}
      </Typography>

      <Button
        variant="outlined"
        startIcon={<PlayArrow />}
        onClick={() => plugin.startScenario(null, 'flythrough')}
        sx={{
          textTransform: 'none',
          borderColor: 'rgba(255,255,255,0.15)',
          color: 'text.primary',
          justifyContent: 'flex-start',
          '&:hover': { borderColor: 'rgba(255,255,255,0.3)' },
        }}
      >
        Overview Flythrough
      </Button>

      <Button
        variant="contained"
        startIcon={<ListAlt />}
        onClick={() => plugin.startScenario(null, 'stepbystep')}
        sx={{
          textTransform: 'none',
          bgcolor: COLOR_ACTIVE,
          color: '#000',
          justifyContent: 'flex-start',
          '&:hover': { bgcolor: '#ffb74d' },
        }}
      >
        Start Step-by-Step
      </Button>

      <Button
        size="small"
        startIcon={<Close />}
        onClick={() => plugin.exitMaintenance()}
        sx={{
          textTransform: 'none',
          color: 'text.secondary',
          justifyContent: 'flex-start',
        }}
      >
        Cancel
      </Button>
    </Box>
  );
}

// ─── Completion Summary ─────────────────────────────────────────────────

function CompletionSummary({ plugin }: { plugin: MaintenancePluginAPI }) {
  const state = plugin.getState();
  const proc = state.procedure;
  if (!proc) return null;

  const passCount = state.stepResults.filter(r => r === 'pass').length;
  const failCount = state.stepResults.filter(r => r === 'fail').length;
  const totalSteps = proc.steps.length;

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CheckCircle sx={{ color: failCount > 0 ? COLOR_WARNING : COLOR_DONE, fontSize: 24 }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {failCount > 0 ? 'Completed with Issues' : 'All Steps Completed'}
        </Typography>
      </Box>

      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {proc.name}
      </Typography>

      <Box sx={{ display: 'flex', gap: 2 }}>
        <Box sx={{ textAlign: 'center' }}>
          <Typography variant="h5" sx={{ color: COLOR_DONE, fontWeight: 700 }}>{passCount}</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>Passed</Typography>
        </Box>
        {failCount > 0 && (
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="h5" sx={{ color: COLOR_WARNING, fontWeight: 700 }}>{failCount}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Failed</Typography>
          </Box>
        )}
        <Box sx={{ textAlign: 'center' }}>
          <Typography variant="h5" sx={{ color: COLOR_PENDING, fontWeight: 700 }}>{totalSteps - passCount - failCount}</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>Open</Typography>
        </Box>
      </Box>

      {/* Per-step results list */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1 }}>
        {proc.steps.map((step, i) => {
          const result = state.stepResults[i];
          const color = result === 'pass' ? COLOR_DONE : result === 'fail' ? COLOR_WARNING : COLOR_PENDING;
          return (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {result === 'pass' ? (
                <CheckCircle sx={{ fontSize: 14, color }} />
              ) : result === 'fail' ? (
                <Warning sx={{ fontSize: 14, color }} />
              ) : (
                <RadioButtonUnchecked sx={{ fontSize: 14, color }} />
              )}
              <Typography variant="caption" sx={{ color, fontSize: 11 }}>
                {step.title}
              </Typography>
              {result === null && (
                <Typography variant="caption" sx={{ color: COLOR_PENDING, fontSize: FS.micro, ml: 'auto' }}>
                  Open
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>

      <Button
        variant="contained"
        onClick={() => plugin.exitMaintenance()}
        sx={{
          textTransform: 'none',
          bgcolor: COLOR_DONE,
          color: '#000',
          mt: 1,
          '&:hover': { bgcolor: '#81c784' },
        }}
      >
        Back to Overview
      </Button>
    </Box>
  );
}

// ─── Step-by-Step Stepper ───────────────────────────────────────────────

function StepperView({ plugin, isFlythrough }: { plugin: MaintenancePluginAPI; isFlythrough: boolean }) {
  const state = plugin.getState();
  const proc = state.procedure;
  if (!proc) return null;

  const { currentStep, stepResults, isCameraAnimating, isLive } = state;
  // plan-522: the safety barrier — Next stays disabled on an unconfirmed ConfirmWarning step.
  const blockedByBarrier = !isFlythrough && plugin.clampToBarrier(currentStep + 1) <= currentStep;
  const progressPct = proc.steps.length > 0
    ? (stepResults.filter(r => r !== null).length / proc.steps.length) * 100
    : 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Box sx={{ p: 1.5, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <IconButton
            size="small"
            onClick={() => plugin.exitMaintenance()}
            sx={{ p: 0.5, color: 'text.secondary' }}
          >
            <ArrowBack sx={{ fontSize: 18 }} />
          </IconButton>
          <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: 11 }}>
            Back to Overview
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <Build sx={{ color: COLOR_ACTIVE, fontSize: 16 }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 600, fontSize: 13 }}>
            {proc.name}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ flex: 1 }}>
            <LinearProgress
              variant="determinate"
              value={progressPct}
              sx={{
                height: 4,
                borderRadius: 2,
                bgcolor: 'rgba(255,255,255,0.06)',
                '& .MuiLinearProgress-bar': { bgcolor: COLOR_DONE, borderRadius: 2 },
              }}
            />
          </Box>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10, whiteSpace: 'nowrap' }}>
            Step {currentStep + 1}/{proc.steps.length}
          </Typography>
        </Box>

        {isFlythrough && (
          <Typography variant="caption" sx={{ color: COLOR_ACTIVE, fontSize: 10, mt: 0.5, display: 'block' }}>
            Flythrough in progress...
          </Typography>
        )}

        {isLive && (
          <Box
            data-testid="maintenance-live-hint"
            sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.75 }}
          >
            <SettingsInputComponent sx={{ fontSize: FS.body, color: LIVE }} />
            <Typography variant="caption" sx={{ color: INK_MID, fontSize: FS.micro, lineHeight: 1.4 }}>
              {MAINTENANCE_LIVE_HINT}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Step list */}
      <Box sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
        {proc.steps.map((step, i) => (
          <StepItem
            key={i}
            step={step}
            stepIndex={i}
            currentStep={currentStep}
            stepResults={stepResults}
            isActive={i === currentStep}
            plugin={plugin}
            isFlythrough={isFlythrough}
            reachable={plugin.clampToBarrier(i) === i}
          />
        ))}
      </Box>

      {/* Navigation buttons (step-by-step only) */}
      {!isFlythrough && (
        <Box sx={{
          p: 1,
          borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          gap: 1,
        }}>
          <Button
            size="small"
            startIcon={<NavigateBefore />}
            disabled={currentStep === 0}
            onClick={() => plugin.prevStep()}
            sx={{
              flex: 1,
              textTransform: 'none',
              fontSize: 11,
              color: 'text.secondary',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
            }}
          >
            Prev
          </Button>
          <Tooltip title={blockedByBarrier ? MAINTENANCE_BARRIER_HINT : ''}>
            <Box component="span" sx={{ flex: 1, display: 'flex' }}>
              <Button
                size="small"
                endIcon={<NavigateNext />}
                disabled={isCameraAnimating || blockedByBarrier}
                onClick={() => plugin.nextStep()}
                data-testid="maintenance-next"
                sx={{
                  flex: 1,
                  textTransform: 'none',
                  fontSize: 11,
                  color: COLOR_ACTIVE,
                  '&:hover': { bgcolor: 'rgba(255,167,38,0.08)' },
                  '&.Mui-disabled': { color: 'rgba(255,255,255,0.15)' },
                }}
              >
                Next
              </Button>
            </Box>
          </Tooltip>
        </Box>
      )}
      {blockedByBarrier && (
        <Typography
          variant="caption"
          data-testid="maintenance-barrier-hint"
          sx={{ px: 1.5, pb: 1, color: COLOR_WARNING, fontSize: FS.micro, display: 'block' }}
        >
          {MAINTENANCE_BARRIER_HINT}
        </Typography>
      )}
    </Box>
  );
}

// ─── Individual Step Item ───────────────────────────────────────────────

function StepItem({ step, stepIndex, currentStep, stepResults, isActive, plugin, isFlythrough, reachable }: {
  step: MaintenanceStep;
  stepIndex: number;
  currentStep: number;
  stepResults: (string | null)[];
  isActive: boolean;
  plugin: MaintenancePluginAPI;
  isFlythrough: boolean;
  /** plan-522: false for entries behind an unconfirmed safety step — not clickable. */
  reachable: boolean;
}) {
  const clickable = !isFlythrough && reachable;
  const handleStepClick = useCallback(() => {
    if (clickable) {
      plugin.goToStep(stepIndex);
    }
  }, [plugin, stepIndex, clickable]);

  return (
    <Box
      onClick={handleStepClick}
      data-testid={`maintenance-step-${stepIndex}`}
      aria-disabled={clickable ? undefined : true}
      sx={{
        display: 'flex',
        gap: 1,
        px: 1.5,
        py: 0.75,
        cursor: clickable ? 'pointer' : 'default',
        opacity: !isFlythrough && !reachable ? 0.5 : 1,
        bgcolor: isActive ? 'rgba(255,167,38,0.06)' : 'transparent',
        '&:hover': clickable ? { bgcolor: 'rgba(255,255,255,0.03)' } : {},
        transition: 'background-color 0.15s',
      }}
    >
      {/* Step connector line + icon */}
      <Box sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: 20,
        flexShrink: 0,
      }}>
        <StepIcon stepIndex={stepIndex} currentStep={currentStep} stepResults={stepResults} />
        {stepIndex < (plugin.getState().procedure?.steps.length ?? 0) - 1 && (
          <Box sx={{
            width: 1,
            flex: 1,
            minHeight: 8,
            bgcolor: stepResults[stepIndex] === 'pass' ? COLOR_DONE : 'rgba(255,255,255,0.08)',
            mt: 0.5,
          }} />
        )}
      </Box>

      {/* Step content */}
      <Box sx={{ flex: 1, minWidth: 0, pb: isActive ? 1 : 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
          <StepSymbol
            symbol={step.symbol}
            color={isActive ? COLOR_ACTIVE : stepResults[stepIndex] === 'pass' ? COLOR_DONE : 'rgba(255,255,255,0.6)'}
          />
          <Typography
            variant="body2"
            sx={{
              fontWeight: isActive ? 600 : 400,
              fontSize: 12,
              color: isActive ? COLOR_ACTIVE : stepResults[stepIndex] === 'pass' ? COLOR_DONE : 'text.primary',
              lineHeight: 1.4,
            }}
          >
            {step.title}
          </Typography>
        </Box>

        {/* Expanded content for active step */}
        {isActive && (
          <Box sx={{ mt: 1 }}>
            {/* Warning note */}
            {step.warningNote && (
              <Box sx={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 0.75,
                p: 1,
                mb: 1,
                borderRadius: 1,
                bgcolor: 'rgba(239, 83, 80, 0.08)',
                border: `1px solid rgba(239, 83, 80, 0.2)`,
              }}>
                <Warning sx={{ fontSize: 14, color: COLOR_WARNING, mt: 0.25 }} />
                <Typography variant="caption" sx={{ color: COLOR_WARNING, fontSize: 11, lineHeight: 1.4 }}>
                  {step.warningNote}
                </Typography>
              </Box>
            )}

            {/* Instruction text */}
            {step.instruction && (
              <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: 12, lineHeight: 1.5, mb: 0.5 }}>
                {step.instruction}
              </Typography>
            )}

            {/* Document link (plan-522 Phase 6) */}
            {step.document && <StepDocumentButton link={step.document} />}

            {/* Estimated time */}
            {step.estimatedMinutes > 0 && (
              <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
                ~{step.estimatedMinutes} min
              </Typography>
            )}

            {/* Completion UI (only in stepbystep mode, not flythrough) */}
            {!isFlythrough && !stepResults[stepIndex] && (
              <CompletionUI step={step} stepIndex={stepIndex} plugin={plugin} />
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ─── Document link (plan-522 Phase 6) ──────────────────────────────────

/**
 * "Betriebsanleitung, S. 18": resolved when the step is shown, so the click
 * opens synchronously (a new tab after an await would be blocked).
 */
function StepDocumentButton({ link }: { link: MaintenanceDocumentLink }) {
  const viewer = useViewer();
  const [resolved, setResolved] = useState<ResolvedMaintenanceDocument | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setResolved(undefined);
    resolveMaintenanceDocument(link, viewer)
      .then((r) => { if (alive) setResolved(r); })
      .catch((e) => {
        console.warn('[MaintenancePanel] document link not resolved:', e);
        if (alive) setResolved(null);
      });
    return () => { alive = false; };
  }, [link, viewer]);

  const label = documentButtonLabel(link);
  const open = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!resolved) return;
    // External: the project's mirrored copy inline at the page (docs/aas/mirror.json), else a new tab.
    if (resolved.kind === 'external') openPdfViewer(link.title, { type: 'external', url: resolved.href });
    else openPdfViewer(link.title, { type: 'blob', aasId: resolved.aasId, zipPath: resolved.zipPath }, { initialPage: resolved.page || undefined });
  }, [resolved, link.title]);

  return (
    <Tooltip title={resolved === null ? 'Document not available' : ''}>
      <span>
        <Button
          size="small"
          variant="outlined"
          startIcon={<MenuBook sx={{ fontSize: 14 }} />}
          onClick={open}
          disabled={!resolved}
          data-testid="maintenance-step-document"
          sx={{ mt: 0.5, mb: 0.5, fontSize: 11, textTransform: 'none', py: 0.25 }}
        >
          {label}
        </Button>
      </span>
    </Tooltip>
  );
}

// ─── Main Panel Component ───────────────────────────────────────────────

export function MaintenancePanel() {
  const viewer = useViewer();
  const state = useMaintenanceMode();
  const plugin = getPlugin(viewer);

  if (!plugin || state.mode === 'idle') return null;

  return (
    <Paper
      elevation={4}
      sx={{
        width: '100%',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        pointerEvents: 'auto',
      }}
    >
      {state.mode === 'dialog' && <ModeDialog plugin={plugin} />}
      {state.mode === 'completed' && <CompletionSummary plugin={plugin} />}
      {(state.mode === 'stepbystep' || state.mode === 'flythrough') && (
        <StepperView plugin={plugin} isFlythrough={state.mode === 'flythrough'} />
      )}
    </Paper>
  );
}
