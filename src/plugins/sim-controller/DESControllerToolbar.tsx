// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DESControllerToolbar — the leading sim-control group shown while the DES
 * workspace mode is active. It REPLACES the continuous `SimControllerToolbar`
 * (hidden in `mode:des`) so the top-left toolbar always reflects the active
 * execution kernel: Realtime controls outside DES, DES controls inside.
 *
 * One unified toolbar (the old bottom DESControlBar is gone). Layout:
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

import { useState, useCallback, useEffect, useSyncExternalStore, lazy, type MouseEvent } from 'react';
import { Box, Menu, MenuItem, LinearProgress, TextField, Checkbox, FormControlLabel, Divider, Typography, ToggleButton, ToggleButtonGroup } from '@mui/material';
import {
  Speed, FastForward, SkipNext, Close, Schedule, Science,
} from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { ActionSegment, ActionDivider } from '../../core/hmi/action-group';
import { useKernelSnapshot } from '../../hooks/use-kernel-snapshot';
import { PlayPauseSegment, ResetSegment } from './SimControllerToolbar';
import type { SimSubMode, SimDesControl } from '../../core/material-flow/simulation-kernel';
import { ensureDesManagerNode, persistDesEndTime, persistDesStatReset, persistDesMasterSeed } from '../../core/material-flow/des-manager-node';
import { formatSimClock, formatDesDuration, parseDesDuration } from './format-sim-time';
import { FloatingPanel } from '../../core/hmi/FloatingPanel';
import { desRunSettingsStore, updateDesRunSettings, type SeedMode } from '../../core/hmi/des-run-settings-store';
import { ensureActiveScope } from '../../core/material-flow/rv-project-manager';
import { LazyPanelBoundary } from '../../core/hmi/LazyPanelBoundary';
import {
  desMatrixWindowStore, closeDesMatrixWindow, toggleDesMatrixWindow,
} from './des-matrix-window-store';

/**
 * The Experiment Matrix is a 46 KB panel that most sessions never open, so it is
 * code-split out of the startup path (plan-344 Phase 4). `lazy()` alone would NOT
 * achieve that: the toolbar used to render the panel UNCONDITIONALLY and let the
 * `open` prop decide visibility, which means the chunk would be requested the
 * moment the toolbar first renders. The `matrixEverOpened || runsOpen` gate below
 * is the part that actually keeps it out of the initial load.
 */
const DESExperimentMatrixPanel = lazy(() =>
  import('./DESExperimentMatrixPanel').then((m) => ({ default: m.DESExperimentMatrixPanel })));

/** Play-speed factors: 1× = real-time (animated), higher = time-lapse (hybrid). */
const SPEED_FACTORS = [1, 5, 10, 50] as const;

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

export function DESControllerToolbar({ viewer }: UISlotProps) {
  const snap = useKernelSnapshot(viewer);
  const [hybridAnchor, setHybridAnchor] = useState<HTMLElement | null>(null);

  // Resolve the live DES control surface on demand (structural — public-only).
  const desControl = useCallback(
    (): SimDesControl | null => viewer.simulationKernel?.desControl() ?? null,
    [viewer],
  );

  const handleSubMode = useCallback(
    (m: SimSubMode) => { desControl()?.setSubMode(m); },
    [desControl],
  );

  // FastForward is a TOGGLE: click → FF (max throughput, no animation); click again
  // → back to the mode you came from (e.g. Hybrid 5×), so you can dip into FF and
  // return WITHOUT re-picking the speed in the dropdown. The pre-FF sub-mode lives
  // on the runner (`preFastForwardSubMode`), so it survives toolbar remounts and
  // covers FF entries from other paths (MCP, persisted mode); the multiplier-based
  // fallback covers runners without that surface.
  const handleFastForwardToggle = useCallback(() => {
    const ctl = desControl();
    if (!ctl) return;
    if (snap.subMode === 'fastforward') {
      ctl.setSubMode(ctl.preFastForwardSubMode ?? (snap.multiplier > 1 ? 'hybrid' : 'animated'));
    } else {
      ctl.setSubMode('fastforward');
    }
  }, [desControl, snap.subMode, snap.multiplier]);

  // ── Clock settings (sim end + statistics-reset) ──
  // Each change updates BOTH the live manager (desControl) AND the scene's
  // DESManager component (durable setField op) so the values survive a reload.
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
  // Shared open-state: the private DES side-tool button toggles the SAME window.
  const runsOpen = useSyncExternalStore(desMatrixWindowStore.subscribe, desMatrixWindowStore.getSnapshot);
  // `hasLoaded || open`, NOT a plain `open &&` (plan-344 Phase 4): the matrix
  // holds real user state — the experiment list, batch progress, the CRN flag and
  // half-typed parameter input. Unmounting it on close would silently discard all
  // of that, a behaviour regression dressed up as a performance patch. So it is
  // loaded on FIRST open and then stays mounted, exactly as before, and only the
  // startup cost is removed.
  const [matrixEverOpened, setMatrixEverOpened] = useState(false);
  useEffect(() => { if (runsOpen) setMatrixEverOpened(true); }, [runsOpen]);
  const currentSeed = desControl()?.masterSeed ?? 42;

  // Bootstrap the run scope (default project + experiment by glb fingerprint)
  // once a DES runner is active — the private lifecycle archives into it.
  useEffect(() => {
    if (snap.hasDes && snap.mode === 'des') void ensureActiveScope(viewer).catch(() => {});
  }, [snap.hasDes, snap.mode, viewer]);

  const setSeedValue = useCallback((v: string) => {
    const seed = Math.floor(Number(v));
    if (!Number.isFinite(seed) || seed <= 0) return;
    desControl()?.setMasterSeed?.(seed);
    persistDesMasterSeed(ensureDesManagerNode(viewer), seed);
  }, [desControl, viewer]);

  const setSeedMode = useCallback((mode: SeedMode | null) => {
    if (mode) updateDesRunSettings({ seedMode: mode });
  }, []);

  const setAutoSave = useCallback((v: string) => {
    const seconds = parseDesDuration(v) ?? 0; // empty → off (0)
    updateDesRunSettings({ autoSaveInterval: Math.max(0, seconds) });
  }, []);

  const setKeepN = useCallback((v: string) => {
    const n = Math.floor(Number(v));
    if (Number.isFinite(n) && n >= 1) updateDesRunSettings({ checkpointMax: n });
  }, []);

  // ONE speed selector replaces the old Animated + Hybrid buttons: 1× = real-time
  // ("animated"), any higher factor = time-lapse ("hybrid"). Running the DES is the
  // standard Play; this only picks HOW FAST.
  const handleSpeedPick = useCallback(
    (n: number) => {
      const ctl = desControl();
      if (n === 1) ctl?.setSubMode('animated');
      else { ctl?.setMultiplier(n); ctl?.setSubMode('hybrid'); }
      setHybridAnchor(null);
    },
    [desControl],
  );

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
            onClick={handleFastForwardToggle}
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

          {/* Experiments — first-class toolbar entry to THE Experiment Matrix
              window (plan-265). Same icon as the private side-tool toggle so
              both paths read as the same feature. */}
          <ActionSegment
            title="Experiments — run matrix (experiments × parameters × KPIs)"
            onClick={toggleDesMatrixWindow}
            active={runsOpen}
            icon={<Science />}
            buttonProps={{ 'data-testid': 'des-runs-open' }}
          />

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
              <MenuItem
                key={n}
                selected={n === 1 ? snap.subMode === 'animated' : (snap.subMode === 'hybrid' && snap.multiplier === n)}
                onClick={() => handleSpeedPick(n)}
                sx={{ fontSize: 13, minHeight: 0, py: 0.5, justifyContent: 'center' }}
              >
                {n}×
              </MenuItem>
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

          {/* THE single DES Experiment Matrix window (plan-265), code-split and
              gated so its chunk is fetched on the first open only. */}
          {(matrixEverOpened || runsOpen) && (
            <LazyPanelBoundary label="Experiment Matrix">
              <DESExperimentMatrixPanel viewer={viewer} open={runsOpen} onClose={closeDesMatrixWindow} />
            </LazyPanelBoundary>
          )}

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
