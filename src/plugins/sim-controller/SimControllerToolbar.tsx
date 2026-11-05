// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimControllerToolbar — the Play/Pause toggle + Reset action group. Registered
 * in the `toolbar-button-leading` slot, which the HMI renders as a floating
 * action group next to the workspace mode switcher (top-left of the viewport).
 *
 * Subscribes to `'simulation-pause-changed'` via `useSyncExternalStore`, so
 * UI updates fire only on idle↔paused transitions (or pause-reason add/
 * remove), not every render frame.
 */

import { useSyncExternalStore, useMemo, useRef, useState, useEffect } from 'react';
import { PlayArrow, Pause, Replay, Speed, Schedule } from '@mui/icons-material';
import { Menu, MenuItem, Box, Snackbar, Alert, Button, Portal } from '@mui/material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { ActionSegment, ActionDivider } from '../../core/hmi/action-group';
import { SIM_CONTROLLER_PAUSE_REASON } from './index';
import { getDriveSpeedOverride, subscribeDriveSpeedOverride } from '../../core/engine/rv-speed-override';
import { commandRegistry } from '../../core/hmi/rv-command-registry';
import { formatSimClock } from './format-sim-time';
import { useKernelSnapshot } from '../../hooks/use-kernel-snapshot';
import { shouldWarnDesSpeed, dismissDesSpeedWarningForSession, switchToDesMode } from './sim-speed-des-warning';
import { isRecordingMode } from '../../core/recording-mode';

/** Text of the DES speed warning (plan decision 2026-10-25, Thomas: variant B). */
export const DES_SPEED_WARNING_TEXT =
  'Running DES blocks faster in continuous mode — above ~10× parts can be missed by sensors. '
  + 'For long runs use DES mode (event jumps, fast forward). Switching resets moving parts.';

/** Snapshot shape returned by `getPauseSnapshot`. Compared by reference so
 *  `useSyncExternalStore` re-renders only when the underlying state changes. */
interface PauseSnapshot {
  paused: boolean;
  reasons: readonly string[];
  /** Stable signature used as the version key for `getSnapshot`. */
  version: number;
}

/**
 * Play/Pause toggle segment — toggles the user pause reason and reflects the
 * ACTUAL sim state (paused by ANY reason). Exported so other toolbars (e.g. the
 * DES controller toolbar) reuse the exact same control + behaviour. Works for
 * both the continuous and the DES execution mode: pausing holds the whole fixed
 * loop, so `kernel.tick()` (continuous OR DES) is skipped uniformly.
 */
export function PlayPauseSegment({ viewer }: UISlotProps) {
  const { subscribe, getSnapshot } = useMemo(() => makeStore(viewer), [viewer]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const userPaused = snap.reasons.includes(SIM_CONTROLLER_PAUSE_REASON);
  // DES "Run finished" (end time reached) is not a pause, yet Play continues the run:
  // show Play and send paused:false so one click continues instead of pausing first.
  const rs = useKernelSnapshot(viewer).runState;
  const canContinue = !snap.paused && rs.runState === 'finished' && rs.reason === 'duration-reached';

  // Icon reflects the ACTUAL sim state (paused by ANY reason — user, planner
  // 'layout-edit', AR, …) so the toolbar shows "paused" whenever the sim is
  // held, e.g. on entering the Layout-Planner. (Size is normalized by ActionSegment.)
  const playPauseIcon = snap.paused || canContinue ? <PlayArrow /> : <Pause />;
  // Detailed tooltip surfaces *all* active pause reasons — replaces the inline
  // chip that used to render in the toolbar. Keeps the info discoverable on
  // hover without cluttering the main menu.
  const reasonsList = snap.paused && snap.reasons.length > 0
    ? ` — paused by: ${snap.reasons.join(', ')}`
    : '';
  const playPauseTitle = (snap.paused ? 'Play (Space)' : canContinue ? 'Play - continue run (Space)' : 'Pause (Space)') + reasonsList;

  // Subtle visual hint when paused by *something else* (not the user button):
  // the play/pause button picks up the warning colour so the user notices the
  // sim is being held by another plugin (Planner, AR, …) even when they did
  // not press Pause themselves.
  const pausedByOther = snap.paused && !userPaused;
  const playPauseColor = userPaused ? 'primary.main' : pausedByOther ? 'warning.main' : 'inherit';

  return (
    <ActionSegment
      title={playPauseTitle}
      // plan-499: a view of `sim.playPause` (Space and web_sim_play_pause are the
      // others); the explicit value keeps the toggle semantics of the old onClick.
      command={{ id: 'sim.playPause', args: () => ({ paused: canContinue ? false : !userPaused }), viewer }}
      color={playPauseColor}
      icon={playPauseIcon}
      buttonProps={{ 'data-testid': 'sim-controller-playpause' }}
    />
  );
}

/**
 * Reset segment — clears MUs + LogicSteps via `resetSimulation()` (which also
 * resets the active kernel executor, so it works in DES mode too). Exported for
 * reuse by the DES controller toolbar.
 */
export function ResetSegment({ viewer }: UISlotProps) {
  return (
    <ActionSegment
      title="Reset MUs and LogicSteps (Shift+R)"
      // plan-499: a view of `sim.reset` (Shift+R and web_sim_reset are the others).
      command={{ id: 'sim.reset', viewer }}
      icon={<Replay />}
      buttonProps={{ 'data-testid': 'sim-controller-reset' }}
    />
  );
}

/**
 * Elapsed-simulation-time display (DD:HH:MM:SS.s). Polls `viewer.simTime` (the
 * continuous fixed-step accumulator) so the planner shows the running sim clock
 * during Play — the continuous parallel to the DES toolbar clock. Holds while
 * paused, returns to 0 on Reset.
 *
 * Exported for the same reason as the segments above: the editor's test-run
 * toolbar shows the identical clock while a run is live.
 */
export function SimClockSegment({ viewer }: UISlotProps) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT(viewer.simTime ?? 0), 200);
    return () => clearInterval(id);
  }, [viewer]);
  return (
    <Box
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, px: 0.75, height: '100%', whiteSpace: 'nowrap' }}
      data-testid="sim-clock"
      title={isRecordingMode() ? undefined : 'Elapsed simulation time'}
      aria-label="Elapsed simulation time"
    >
      <Schedule sx={{ fontSize: 18, color: 'text.secondary' }} />
      <Box component="span" sx={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 600, color: '#4fc3f7', letterSpacing: 0.3 }}>
        {formatSimClock(t)}
      </Box>
    </Box>
  );
}

export function SimControllerToolbar({ viewer }: UISlotProps) {
  // Segmented action group (shared design): full-height rectangular segments
  // split by a divider. The pill wrapper is provided by the host (TopBar).
  return (
    <>
      <PlayPauseSegment viewer={viewer} />
      <ActionDivider />
      <ResetSegment viewer={viewer} />
      <ActionDivider />
      <SpeedSelector viewer={viewer} />
      <ActionDivider />
      <SimClockSegment viewer={viewer} />
    </>
  );
}

// ── Simulation-speed selector ───────────────────────────────────────────────
// One master factor for the continuous simulation (1 = normal): drives move
// faster AND the time-based logic (sim clock, Source intervals, LogicStep Delay,
// DES Animated clock, PLC timers) advances by `factor × dt` — see
// rv-speed-override.ts. Sits next to Reset.

// Engine cap is 100× (see setDriveSpeedOverride). Above ~10–20× fast/small parts
// can tunnel past sensors in the fixed 60 Hz step — fine for large parts / big zones.
const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];

/** Exported for reuse by the editor's test-run toolbar (same override store). */
export function SpeedSelector({ viewer }: { viewer?: UISlotProps['viewer'] } = {}) {
  const factor = useSyncExternalStore(subscribeDriveSpeedOverride, getDriveSpeedOverride, getDriveSpeedOverride);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const segRef = useRef<HTMLElement | null>(null);
  const [desWarnOpen, setDesWarnOpen] = useState(false);
  const closeDesWarn = () => setDesWarnOpen(false);
  return (
    <>
      <ActionSegment
        title="Simulation speed — runs the simulation faster or slower (1× = real time)"
        icon={<Speed />}
        label={`${factor}×`}
        // plan-499: the segment is the (interactive) view of `sim.speedOverride`:
        // a click opens the menu, a menu item dispatches; the choreography and
        // the afterglow of web_drive_speed_override land on this segment.
        command={{ id: 'sim.speedOverride', args: () => ({ factor }), invoke: () => setAnchor(segRef.current), ...(viewer ? { viewer } : {}) }}
        buttonProps={{ 'data-testid': 'sim-speed-selector', ref: segRef }}
      />
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        MenuListProps={{ dense: true }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        {SPEED_OPTIONS.map(o => (
          <MenuItem
            key={o}
            selected={o === factor}
            onClick={() => {
              // Non-blocking: the speed is applied either way; the warning only
              // points DES scenes to DES mode. UI-only — MCP calls never get here.
              const warn = shouldWarnDesSpeed(viewer, o, factor);
              void commandRegistry.execute('sim.speedOverride', { factor: o }, { origin: 'ui', ...(viewer ? { viewer } : {}) });
              setAnchor(null);
              if (warn) setDesWarnOpen(true);
            }}
            sx={{ fontSize: 13, minHeight: 0, py: 0.5, justifyContent: 'center' }}
          >
            {o}×
          </MenuItem>
        ))}
      </Menu>
      {/* Portal: the toolbar pill clips (overflow hidden) and is a containing
          block for fixed children — the Snackbar must live on <body>. */}
      <Portal>
      <Snackbar
        open={desWarnOpen}
        onClose={(_e, reason) => { if (reason !== 'clickaway') closeDesWarn(); }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="warning"
          variant="filled"
          onClose={closeDesWarn}
          data-testid="sim-speed-des-warning"
          sx={{ fontSize: 12, alignItems: 'center', maxWidth: 760, '& .MuiAlert-action': { pt: 0 } }}
          action={(
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
              <Button
                color="inherit"
                size="small"
                data-testid="sim-speed-des-warning-switch"
                onClick={() => { closeDesWarn(); switchToDesMode(viewer); }}
              >
                Switch to DES mode
              </Button>
              <Button color="inherit" size="small" data-testid="sim-speed-des-warning-stay" onClick={closeDesWarn}>
                Stay
              </Button>
              <Button
                color="inherit"
                size="small"
                data-testid="sim-speed-des-warning-dismiss"
                onClick={() => { dismissDesSpeedWarningForSession(); closeDesWarn(); }}
              >
                Don&apos;t ask again
              </Button>
            </Box>
          )}
        >
          {DES_SPEED_WARNING_TEXT}
        </Alert>
      </Snackbar>
      </Portal>
    </>
  );
}

// ── Per-viewer pause-state store ───────────────────────────────────────────
//
// We attach a single subscribe/getSnapshot pair per viewer instance so
// multiple toolbar consumers share the same memoised snapshot.

interface PauseStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PauseSnapshot;
}

const _storeCache = new WeakMap<object, PauseStore>();

function makeStore(viewer: UISlotProps['viewer']): PauseStore {
  const cached = _storeCache.get(viewer);
  if (cached) return cached;

  let version = 0;
  let snapshot: PauseSnapshot = {
    paused: viewer.isSimulationPaused,
    reasons: [...viewer.simulationPauseReasons],
    version,
  };
  const listeners = new Set<() => void>();

  const refresh = (): void => {
    version++;
    snapshot = {
      paused: viewer.isSimulationPaused,
      reasons: [...viewer.simulationPauseReasons],
      version,
    };
    for (const l of listeners) l();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const off = viewer.on('simulation-pause-changed', refresh as (data: unknown) => void);
    return () => {
      listeners.delete(listener);
      off();
    };
  };

  const getSnapshot = (): PauseSnapshot => snapshot;

  const store: PauseStore = { subscribe, getSnapshot };
  _storeCache.set(viewer, store);
  return store;
}
