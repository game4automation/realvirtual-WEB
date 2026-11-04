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
import { ensureDesManagerNode, persistDesEndTime, persistDesStatReset, applyDesMasterSeed } from '../../core/material-flow/des-manager-node';
import { formatSimClock, formatDesDuration, parseDesDuration, formatRunFinishedTime } from './format-sim-time';
import { setDesStatsWindowOpen } from './des-stats-window-store';
import { FloatingPanel } from '../../core/hmi/FloatingPanel';
import { desRunSettingsStore, updateDesRunSettings, setCheckpointAutosaveInterval, setCheckpointKeep, type SeedMode } from '../../core/hmi/des-run-settings-store';
import { ensureActiveScope } from '../../core/material-flow/rv-project-manager';

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
function TimeField({ defaultValue, onChange, helper }: {
  defaultValue: string; onChange: (v: string) => void; helper: string;
}) {
  return (
    <TextField
      size="small"
      fullWidth
      defaultValue={defaultValue}
      onChange={(e) => onChange(e.target.value)}
      placeholder="00:00:00:00"
      inputProps={{ style: { fontFamily: 'ui-monospace, monospace', fontSize: 14, letterSpacing: 1.5, textAlign: 'center', padding: '6px 8px' } }}
      helperText={helper}
      FormHelperTextProps={{ sx: { fontSize: 10, mx: 0, mt: 0.4, textAlign: 'center', color: 'text.disabled' } }}
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
  // Each change updates BOTH the live manager (desControl) AND the scene's
  // DESManager component (durable setField op) so the values survive a reload.
  // The FIRST edit creates the `Simulation` node (plan-616 Teil 1 — mode entry
  // only reads): `ensureDesManagerNode` queues its `addNode` op, the persister
  // then queues the `setField`, and the document's single-flight op queue runs
  // them in that call order, so no await is needed between the two.
  const [clockOpen, setClockOpen] = useState(false);
  const endInfinite = !Number.isFinite(snap.endTime);
  const setEndInfinite = useCallback((infinite: boolean) => {
    const seconds = infinite ? Infinity : (Number.isFinite(snap.endTime) ? snap.endTime : 86400);
    desControl()?.setEndTime?.(seconds);
    persistDesEndTime(ensureDesManagerNode(viewer), seconds);
  }, [desControl, snap.endTime, viewer]);
  const setEndValue = useCallback((v: string) => {
    const seconds = parseDesDuration(v);
    if (seconds == null) return; // partial / invalid entry → leave unchanged
    desControl()?.setEndTime?.(seconds);
    persistDesEndTime(ensureDesManagerNode(viewer), seconds);
  }, [desControl, viewer]);
  const setStatResetValue = useCallback((v: string) => {
    const seconds = parseDesDuration(v) ?? 0; // empty → off (0)
    desControl()?.setStatResetTime?.(seconds);
    persistDesStatReset(ensureDesManagerNode(viewer), seconds);
  }, [desControl, viewer]);

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
    // A refused seed (a variant is in the scene) or a failed scene write is shown under the field;
    // an incomplete entry while typing is not.
    void applyDesMasterSeed(viewer, desControl(), Number(v))
      .then(r => setSeedError(r.ok || r.code === 'invalid' ? null : r.reason));
  }, [desControl, viewer]);

  const setSeedMode = useCallback((mode: SeedMode | null) => {
    if (mode) updateDesRunSettings({ seedMode: mode });
  }, []);

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
            title="Simulation end + statistics reset (toggle)"
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
                  onChange={setEndValue}
                  helper="DD:HH:MM:SS — e.g. 01:00:00:00 = 1 day"
                />
              )}

              <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)', mt: 0.25 }} />

              {/* Statistics reset */}
              <Typography sx={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'text.secondary' }}>
                Statistics reset (warmup)
              </Typography>
              <TimeField
                key={`stat-${clockOpen ? 'o' : 'c'}`}
                defaultValue={formatDesDuration(snap.statResetTime)}
                onChange={setStatResetValue}
                helper="DD:HH:MM:SS — empty = off"
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
                  defaultValue={String(currentSeed)}
                  disabled={runSettings.seedMode === 'auto'}
                  onChange={(e) => setSeedValue(e.target.value)}
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
                onChange={setAutoSave}
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
