// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { DesExperimentsToolbarButton, DesExperimentWindowHost } from './DesExperimentsButton';


/**
 * DESControllerToolbar — the leading sim-control group shown while the DES
 * workspace mode is active. It REPLACES the continuous `SimControllerToolbar`
 * (hidden in `mode:des`) so the top-left toolbar always reflects the active
 * execution kernel: Realtime controls outside DES, DES controls inside.
 *
 * One unified toolbar. Layout:
 *   [ Play/Pause ] | [ Reset ] | [ Animated · Hybrid N× · FastForward · Step ]
 *   | [ time DD:HH:MM:SS.s ] | [ Event Queue ] | [ Save · Load ]
 * plus an inline FastForward progress bar + cancel while a FF run is in flight.
 *
 * Play/Pause + Reset are the SHARED segments. Everything DES-specific is driven
 * through the PUBLIC structural `SimDesControl` surface (`kernel.desControl()`):
 * sub-mode, `eventStats()` (time/counters), `snapshotJson()`/`restoreJson()`.
 * It never imports the private `DESRunner` (Plan 194 V7), so it works unchanged
 * whether the DES runner is private (today) or public (later).
 *
 * The Event Queue button toggles a shared open-store; the actual window (with
 * filter/category/footer) is the private `DESEventQueueWindow`, rendered by the
 * `@rv-private` overlay the DES workspace registers.
 */

import { useState, useCallback, useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { Box, Chip, Tooltip, Menu, MenuItem, LinearProgress, TextField, Checkbox, FormControlLabel, Divider, Typography, ToggleButton, ToggleButtonGroup } from '@mui/material';
import {
  Speed, FastForward, SkipNext, Close, Schedule, CheckCircleOutline, WarningAmber,
} from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { ActionSegment, ActionDivider } from '../../core/hmi/action-group';
import { useCommandView } from '../../core/hmi/rv-command-view';
import { ensureDesRunCommandsRegistered } from '../../core/hmi/des-run-commands';
import { ensureDesPlcCommandsRegistered } from '../../core/hmi/des-plc-commands';
import { useKernelSnapshot } from '../../hooks/use-kernel-snapshot';
import { PlayPauseSegment, ResetSegment } from './SimControllerToolbar';
import type { SimDesControl } from '../../core/material-flow/simulation-kernel';
import { commandRegistry } from '../../core/hmi/rv-command-registry';
import { formatSimClock, formatDesDuration, formatDesTimeArg, parseDesDuration, formatRunFinishedTime } from './format-sim-time';
import { setDesStatsWindowOpen } from './des-stats-window-store';
import { FloatingPanel } from '../../core/hmi/FloatingPanel';
import { desRunSettingsStore, setCheckpointAutosaveInterval, setCheckpointKeep, type SeedMode } from '../../core/hmi/des-run-settings-store';
import { ensureActiveScope } from '../../core/material-flow/rv-project-manager';
import { DES_DEFAULT_CYCLE_TIME, findDesManager } from '../../core/material-flow/des-manager-settings';
import { isRecordingMode } from '../../core/recording-mode';

ensureDesRunCommandsRegistered();

ensureDesPlcCommandsRegistered();

/** Play-speed factors: 1× = real-time (animated), higher = time-lapse (hybrid). */
const SPEED_FACTORS = [1, 5, 10, 50] as const;

function SpeedMenuItem({ viewer, factor, selected, onClose, autoFocus, tabIndex }: {
  autoFocus?: boolean; tabIndex?: number;
  viewer: UISlotProps['viewer']; factor: number; selected: boolean; onClose: () => void;
}) {
  const view = useCommandView({
    id: 'des.setMode', viewer, buttonKey: `des.speed.${factor}`,
    args: () => factor === 1 ? { subMode: 'animated' } : { subMode: 'hybrid', multiplier: factor },
  });
  return (
    <MenuItem
      {...view.dataAttrs}
      autoFocus={autoFocus}
      tabIndex={tabIndex}
      selected={selected}
      disabled={view.disabled}
      onClick={() => { view.onClick(); onClose(); }}
      sx={{ fontSize: 13, minHeight: 0, py: 0.5, justifyContent: 'center' }}
    >
      {factor}×
    </MenuItem>
  );
}

// Duration format/parse moved to format-sim-time.ts (shared with the matrix);
// re-exported here so existing importers keep working.
export { formatDesDuration, parseDesDuration } from './format-sim-time';

/** Compact, centered monospace DD:HH:MM:SS input with a subtle helper line (no
 *  floating label — the section header + helper give the context). */
/**
 * Edit draft of a settings field: typing stays local, blur / Enter commits only an actual edit (a
 * focus + blur without typing commits nothing). Without a draft the field shows the stored value.
 */
function useCommitDraft(stored: string, onCommit: (v: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    value: draft ?? stored,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      if (draft === null) return;
      setDraft(null);
      if (draft !== stored) onCommit(draft);
    },
    onKeyDown: (e: { key: string; target: unknown }) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); },
  };
}

function TimeField({ defaultValue, onCommit, helper, error }: {
  /** Called once per finished edit (blur or Enter) — typing is a local draft and commits nothing. */
  defaultValue: string; onCommit: (v: string) => void; helper: string;
  /** A refused or failed write (variant in the scene, scene not accepting edits) — shown instead of the helper. */
  error?: string | null;
}) {
  const draft = useCommitDraft(defaultValue, onCommit);
  return (
    <TextField
      size="small"
      fullWidth
      {...draft}
      placeholder="00:00:00:00"
      inputProps={{ style: { fontFamily: 'ui-monospace, monospace', fontSize: 14, letterSpacing: 1.5, textAlign: 'center', padding: '6px 8px' } }}
      error={!!error}
      helperText={error ?? helper}
      FormHelperTextProps={{ sx: { fontSize: 10, mx: 0, mt: 0.4, textAlign: 'center', ...(error ? {} : { color: 'text.disabled' }) } }}
    />
  );
}

/** Explanation in the run-state chip tooltip (replaces the former bottom notice). */
function runFinishedTooltip(r: { runState: string; reason: string; endTime: number; finishedAt: number | null }): string {
  const at = formatRunFinishedTime(r.finishedAt ?? 0);
  if (r.runState === 'stalled') return `No more events at ${at}, before the end time. Reset to run again.`;
  if (r.reason === 'duration-reached') {
    return `End time ${formatRunFinishedTime(r.endTime)} reached, not blocked. Press Play to continue; Reset starts again.`;
  }
  return `No more events at ${at}, the run is complete. Reset to run again.`;
}

export function DESControllerToolbar({ viewer }: UISlotProps) {
  const snap = useKernelSnapshot(viewer);
  const [hybridAnchor, setHybridAnchor] = useState<HTMLElement | null>(null);

  // Resolve the live DES control surface on demand (structural — public-only).
  const desControl = useCallback(
    (): SimDesControl | null => viewer.simulationKernel?.desControl() ?? null,
    [viewer],
  );

  // ── Clock settings (sim end + statistics-reset) ──
  // Each change goes through the des.setEnd command (→ `applyDesClockSettings`): the
  // scene's DESManager component first (durable setField op, awaited and read back),
  // the live manager only after — refused during a batch and while a variant is in
  // the scene (Base setting).
  // The FIRST edit creates the `Simulation` node (plan-616 Teil 1 — mode entry
  // only reads): `ensureDesManagerNode` queues its `addNode` op before the `setField`.
  const [clockOpen, setClockOpen] = useState(false);
  const endInfinite = !Number.isFinite(snap.endTime);
  // A refused write (variant in the scene, run lease) or a failed one is shown under its field.
  const [endError, setEndError] = useState<string | null>(null);
  const [statError, setStatError] = useState<string | null>(null);
  const [cycleError, setCycleError] = useState<string | null>(null);
  // ONE path for the window and MCP (LOP #248): the des.setEnd / des.seed.set commands, so the window
  // gets the same run-lease, variant and document checks. Resolves to the refusal text, or null.
  const runClockCommand = useCallback((id: string, args: Record<string, unknown>): Promise<string | null> =>
    commandRegistry.execute(id, args, { origin: 'ui', viewer }).then(r => (r.ok ? null : r.reason)), [viewer]);
  const setEndInfinite = useCallback((infinite: boolean) => {
    const seconds = infinite ? Infinity : (Number.isFinite(snap.endTime) ? snap.endTime : 86400);
    void runClockCommand('des.setEnd', { end: formatDesTimeArg(seconds) }).then(setEndError);
  }, [runClockCommand, snap.endTime]);
  /** A finished end edit: validated here, 0 is not "indefinite" (that is the checkbox). */
  const setEndValue = useCallback((v: string) => {
    const seconds = parseDesDuration(v);
    const arg = seconds == null ? null : formatDesTimeArg(seconds);
    if (seconds == null || arg == null || seconds <= 0) {
      setEndError('Enter an end time greater than 0 (DD:HH:MM:SS), or tick "Run indefinitely"');
      return;
    }
    void runClockCommand('des.setEnd', { end: arg }).then(setEndError);
  }, [runClockCommand]);
  const setStatResetValue = useCallback((v: string) => {
    const seconds = v.trim() === '' ? 0 : parseDesDuration(v); // empty → off (0)
    const arg = seconds == null ? null : formatDesTimeArg(seconds);
    if (arg == null) { setStatError('Enter the warm-up as DD:HH:MM:SS, or leave it empty for none'); return; }
    void runClockCommand('des.setEnd', { statReset: arg }).then(setStatError);
  }, [runClockCommand]);

  // ── Seed + run settings (plan-260) ──
  const runSettings = useSyncExternalStore(desRunSettingsStore.subscribe, desRunSettingsStore.getSnapshot);
  const currentSeed = desControl()?.masterSeed ?? 42;
  const [seedError, setSeedError] = useState<string | null>(null);

  // Bootstrap the run scope (default project + experiment by glb fingerprint)
  // once a DES runner is active — the private lifecycle archives into it.
  useEffect(() => {
    if (snap.hasDes && snap.mode === 'des') void ensureActiveScope(viewer).catch(() => {});
  }, [snap.hasDes, snap.mode, viewer]);

  const setSeedValue = useCallback((v: string) => {
    // A refused seed (a variant is in the scene, a batch) or a failed scene write is shown under the
    // field; an incomplete entry while typing is not sent.
    const seed = Number(v);
    if (!Number.isInteger(seed) || seed < 1 || seed > 0x7fffffff) { setSeedError('The seed must be an integer from 1 to 2147483647'); return; }
    void runClockCommand('des.seed.set', { seed }).then(setSeedError);
  }, [runClockCommand]);

  const seedDraft = useCommitDraft(String(currentSeed), setSeedValue);

  const setSeedMode = useCallback((mode: SeedMode | null) => {
    if (mode) void runClockCommand('des.seed.set', { mode }).then(setSeedError);
  }, [runClockCommand]);

  const setAutoSave = useCallback((v: string) => {
    const seconds = parseDesDuration(v) ?? 0; // empty → off (0)
    setCheckpointAutosaveInterval(seconds);
  }, []);

  const setKeepN = useCallback((v: string) => {
    setCheckpointKeep(Number(v));
  }, []);

  const handleStep = useCallback(() => {
    const ctl = desControl();
    ctl?.setSubMode('step');
    ctl?.step();
  }, [desControl]);

  const handleCancelFf = useCallback(() => {
    desControl()?.cancelFastForward?.();
  }, [desControl]);

  // Snapshot Save/Load moved to the side DES tool menu (DES-HMI plugin
  // button-group) so the top toolbar stays focused on sim controls.

  return (
    <>
      <PlayPauseSegment viewer={viewer} />
      <ActionDivider />
      <ResetSegment viewer={viewer} />

      {/* DES sub-mode row + clock/counters + snapshots — only with a DES runner. */}
      {snap.hasDes && (
        <>
          <ActionDivider />
          {/* ONE speed selector (1× real-time … N× time-lapse) — Play runs the DES
              at this factor. Replaces the redundant Animated + Hybrid buttons. */}
          <ActionSegment
            title="Play speed — 1× real-time up to N× time-lapse (click to pick)"
            active={snap.subMode === 'animated' || snap.subMode === 'hybrid'}
            icon={<Speed />}
            label={snap.subMode === 'animated' ? '1×' : `${snap.multiplier}×`}
            buttonProps={{
              'data-testid': 'des-speed',
              onClick: (e: MouseEvent<HTMLElement>) => setHybridAnchor(e.currentTarget),
            }}
          />
          <ActionSegment
            title="Fast Forward (max throughput, no animation) — click again to return to the previous speed"
            command={{ id: 'des.fastForward', viewer }}
            active={snap.subMode === 'fastforward'}
            icon={<FastForward />}
            buttonProps={{ 'data-testid': 'des-submode-fastforward' }}
          />
          <ActionSegment
            title="Step (process one event)"
            onClick={handleStep}
            active={snap.subMode === 'step'}
            icon={<SkipNext />}
            buttonProps={{ 'data-testid': 'des-submode-step' }}
          />

          {/* Sim clock (DD:HH:MM:SS.s) — click to set the sim END + statistics reset. */}
          <ActionDivider />
          <Box
            onClick={() => setClockOpen((o) => !o)}
            sx={{
              display: 'inline-flex', alignItems: 'center', gap: 0.5, px: 0.75, height: '100%',
              whiteSpace: 'nowrap', cursor: 'pointer',
              // Reflect the window's open state — clock turns blue/active while open.
              bgcolor: clockOpen ? 'action.selected' : 'transparent',
              '&:hover': { bgcolor: clockOpen ? 'action.selected' : 'action.hover' },
            }}
            data-testid="des-clock"
            title={isRecordingMode() ? undefined : 'Simulation end + statistics reset (toggle)'}
            aria-label="Simulation end + statistics reset (toggle)"
          >
            <Schedule sx={{ fontSize: 18, color: clockOpen ? '#4fc3f7' : 'text.secondary' }} />
            <Box component="span" sx={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 600, color: '#4fc3f7', letterSpacing: 0.3 }}>
              {formatSimClock(snap.simTime)}
            </Box>
            {endInfinite && <Box component="span" sx={{ fontSize: 13, color: 'text.disabled', lineHeight: 1 }}>∞</Box>}
          </Box>

          {(snap.runState.runState === 'finished' || snap.runState.runState === 'stalled') && (
            <Tooltip title={runFinishedTooltip(snap.runState)}>
              <Chip
                data-testid="des-run-state"
                size="small"
                variant="outlined"
                color={snap.runState.runState === 'finished' ? 'success' : 'warning'}
                icon={snap.runState.runState === 'finished' ? <CheckCircleOutline /> : <WarningAmber />}
                label={`${snap.runState.runState === 'finished' ? 'Run finished' : 'No more events'} · ${formatRunFinishedTime(
                  snap.runState.reason === 'duration-reached' ? snap.runState.endTime : snap.runState.finishedAt ?? 0,
                )}`}
                onClick={() => setDesStatsWindowOpen(true)}
              />
            </Tooltip>
          )}
          {/* Experiments — first-class toolbar entry to THE Experiment Matrix window
              (plan-265). Core button; without the commercial experiment manager it shows
              the commercial notice (plan-2211 G5). */}
          <DesExperimentsToolbarButton viewer={viewer} />

          {/* Event Queue + Save/Load snapshot moved to the side DES tool menu. */}

          {/* Play-speed factor dropdown */}
          <Menu
            anchorEl={hybridAnchor}
            open={hybridAnchor !== null}
            onClose={() => setHybridAnchor(null)}
            MenuListProps={{ dense: true }}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            transformOrigin={{ vertical: 'top', horizontal: 'center' }}
          >
            {SPEED_FACTORS.map((n) => (
              <SpeedMenuItem
                key={n}
                viewer={viewer}
                factor={n}
                selected={n === 1 ? snap.subMode === 'animated' : (snap.subMode === 'hybrid' && snap.multiplier === n)}
                onClose={() => setHybridAnchor(null)}
              />
            ))}
          </Menu>

          {/* Clock settings — sim END (incl. infinite) + statistics reset (warmup).
              Built on the shared FloatingPanel window base (same frame, title bar,
              theme typography + glass styling as the DES Stats / Event Queue windows)
              so the look + fonts stay consistent without bespoke popover styling. */}
          <FloatingPanel
            open={clockOpen}
            onClose={() => setClockOpen(false)}
            title="Simulation clock"
            titleColor="#4fc3f7"
            panelId="des-clock-settings"
            defaultWidth={258}
            defaultHeight={400}
            minWidth={232}
          >
            {/* Scrollable: on small viewports (or after a manual shrink) the
                settings must never clip silently below the fold. */}
            <Box sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 0.75, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {/* Simulation end */}
              <Typography sx={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'text.secondary' }}>
                Simulation end
              </Typography>
              <FormControlLabel
                control={<Checkbox size="small" sx={{ p: 0.5 }} checked={endInfinite} onChange={(e) => setEndInfinite(e.target.checked)} />}
                label={<Typography sx={{ fontSize: 12.5 }}>Run indefinitely (∞)</Typography>}
                sx={{ m: 0, ml: -0.5 }}
              />
              {!endInfinite && (
                <TimeField
                  key={`end-${clockOpen ? 'o' : 'c'}`}
                  defaultValue={formatDesDuration(snap.endTime)}
                  onCommit={setEndValue}
                  helper="DD:HH:MM:SS — e.g. 01:00:00:00 = 1 day"
                  error={endError}
                />
              )}
              {endInfinite && endError && <Typography role="alert" sx={{ fontSize: 10, color: 'error.main', textAlign: 'center' }}>{endError}</Typography>}

              <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)', mt: 0.25 }} />

              <TextField
                key={`cycle-${clockOpen}`}
                label="Cycle time (s)"
                type="number" size="small"
                defaultValue={desControl()?.cycleTime ?? (viewer.scene ? findDesManager(viewer.scene)?.cycleTime : undefined) ?? DES_DEFAULT_CYCLE_TIME}
                inputProps={{ min: 0.001, max: 0.1, step: 0.001 }}
                error={!!cycleError}
                helperText={cycleError ?? 'Motion step for robot paths and moving drives in DES'}
                onBlur={e => {
                  const value = Number(e.target.value);
                  if (!Number.isFinite(value) || value < 0.001 || value > 0.1) {
                    setCycleError('Enter a cycle time between 0.001 and 0.1 s'); return;
                  }
                  void import('../../core/material-flow/des-manager-node').then(m => m.applyDesCycleTime(viewer, desControl(), value)).then(r => setCycleError(r.ok ? null : r.reason));
                }}
              />

              {/* Statistics reset */}
              <Typography sx={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'text.secondary' }}>
                Statistics reset (warmup)
              </Typography>
              <TimeField
                key={`stat-${clockOpen ? 'o' : 'c'}`}
                defaultValue={formatDesDuration(snap.statResetTime)}
                onCommit={setStatResetValue}
                helper="DD:HH:MM:SS — empty = off"
                error={statError}
              />

              <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)', mt: 0.25 }} />

              {/* Seed (plan-260 F1/F12) — fixed reproduces, auto rolls per run. */}
              <Typography sx={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'text.secondary' }}>
                Random seed
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
                <TextField
                  key={`seed-${clockOpen ? 'o' : 'c'}-${currentSeed}`}
                  size="small"
                  {...seedDraft}
                  disabled={runSettings.seedMode === 'auto'}
                  error={!!seedError}
                  helperText={seedError ?? undefined}
                  inputProps={{
                    'data-testid': 'des-seed-input',
                    style: { fontFamily: 'ui-monospace, monospace', fontSize: 13, textAlign: 'center', padding: '6px 8px' },
                  }}
                  sx={{ flex: 1 }}
                />
                <ToggleButtonGroup
                  size="small" exclusive value={runSettings.seedMode}
                  onChange={(_, v: SeedMode | null) => setSeedMode(v)}
                  sx={{ height: 28, '& .MuiToggleButton-root': { fontSize: 10, px: 0.75, py: 0 } }}
                >
                  <ToggleButton value="fixed" data-testid="des-seed-fixed">fixed</ToggleButton>
                  <ToggleButton value="auto" data-testid="des-seed-auto">auto</ToggleButton>
                </ToggleButtonGroup>
              </Box>

              <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)', mt: 0.25 }} />

              {/* Checkpoint auto-save (plan-260 F15/F17). */}
              <Typography sx={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'text.secondary' }}>
                Auto-save checkpoints
              </Typography>
              <TimeField
                key={`autosave-${clockOpen ? 'o' : 'c'}`}
                defaultValue={formatDesDuration(runSettings.autoSaveInterval)}
                onCommit={setAutoSave}
                helper="sim-time interval DD:HH:MM:SS — empty = off"
              />
              <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', flex: 1 }}>keep newest</Typography>
                <TextField
                  key={`keep-${clockOpen ? 'o' : 'c'}`}
                  size="small"
                  defaultValue={String(runSettings.checkpointMax)}
                  onChange={(e) => setKeepN(e.target.value)}
                  inputProps={{ 'data-testid': 'des-checkpoint-keep', style: { fontSize: 13, textAlign: 'center', padding: '6px 8px', width: 48 } }}
                />
              </Box>

            </Box>
          </FloatingPanel>

          {/* THE single DES Experiment Matrix window, rendered by the experiment manager's
              host (own chunk, fetched on the first open only). */}
          <DesExperimentWindowHost viewer={viewer} />

          {/* FastForward progress + cancel (only while a FF run is in flight). */}
          {snap.ffProgress !== null && (
            <>
              <ActionDivider />
              <Box
                sx={{ display: 'inline-flex', alignItems: 'center', px: 0.75, minWidth: 64 }}
                data-testid="des-ff-progress"
              >
                <LinearProgress
                  variant="determinate"
                  value={Math.round(snap.ffProgress * 100)}
                  sx={{ flex: 1, height: 4, borderRadius: 2, minWidth: 48 }}
                />
              </Box>
              <ActionSegment
                title="Cancel Fast Forward"
                onClick={handleCancelFf}
                icon={<Close />}
                buttonProps={{ 'data-testid': 'des-ff-cancel' }}
              />
            </>
          )}
        </>
      )}
    </>
  );
}
