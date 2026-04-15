// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MachineControlPanel — Demo machine control HMI panel.
 *
 * Displays PackML-inspired machine state, mode selector, dedicated subsystem
 * buttons (Robot, Entry Conveyor, Exit Conveyor), sensor indicators, door
 * status, and an auto-discovered component list with 3D integration
 * (hover -> highlight, click -> fly-to).
 *
 * This is a DEMO panel — subsystem buttons and sensor states are visual only.
 */

import { useRef, useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { Box, Typography, Button, ToggleButton, ToggleButtonGroup, IconButton } from '@mui/material';
import {
  PlayArrow, Stop, Warning,
  PrecisionManufacturing, LocalShipping,
} from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useMachineControl } from '../../hooks/use-machine-control';
import { LeftPanel } from './LeftPanel';
import { MACHINE_PANEL_WIDTH } from './layout-constants';
import type { MachineControlPluginAPI, MachineState, MachineMode, MachineComponent, ComponentStatus } from '../types/plugin-types';

// ─── ISA-101 Inspired Colors ─────────────────────────────────────────────

const C = {
  green:   '#66bb6a',
  blue:    '#42a5f5',
  orange:  '#ffa726',
  red:     '#ef5350',
  cyan:    '#4fc3f7',
  dimWhite: 'rgba(255,255,255,0.5)',
  faintWhite: 'rgba(255,255,255,0.25)',
  subtleBorder: 'rgba(255,255,255,0.06)',
} as const;

const STATE_COLORS: Record<MachineState, string> = {
  RUNNING: C.green, IDLE: C.dimWhite, STOPPED: C.faintWhite, HELD: C.orange, ERROR: C.red,
};

const MODE_COLORS: Record<MachineMode, string> = {
  AUTO: C.green, MANUAL: C.blue, MAINTENANCE: C.orange,
};

// ─── Section Header ──────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <Typography sx={{
      fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase',
      color: 'rgba(255,255,255,0.35)', mb: 0.75,
    }}>
      {children}
    </Typography>
  );
}

// ─── State Badge (prominent) ────────────────────────────────────────────

function StateBadge({ state }: { state: MachineState }) {
  const color = STATE_COLORS[state];
  const isRunning = state === 'RUNNING';
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 1,
      px: 1.5, py: 0.75, borderRadius: 1.5,
      bgcolor: `${color}15`,
      border: `1px solid ${color}30`,
    }}>
      <Box sx={{
        width: 10, height: 10, borderRadius: '50%', bgcolor: color, flexShrink: 0,
        boxShadow: isRunning ? `0 0 10px ${color}, 0 0 4px ${color}` : 'none',
        animation: isRunning ? 'pulse-glow 2s ease-in-out infinite' : 'none',
        '@keyframes pulse-glow': {
          '0%, 100%': { boxShadow: `0 0 6px ${color}` },
          '50%': { boxShadow: `0 0 14px ${color}, 0 0 6px ${color}` },
        },
      }} />
      <Typography sx={{
        fontSize: 14, fontWeight: 800, letterSpacing: 1.5, fontFamily: 'monospace', color,
      }}>
        {state}
      </Typography>
    </Box>
  );
}

// ─── Mode Selector ───────────────────────────────────────────────────────

function ModeSelector({ mode, onModeChange }: { mode: MachineMode; onModeChange: (m: MachineMode) => void }) {
  return (
    <ToggleButtonGroup
      value={mode}
      exclusive
      onChange={(_, val) => { if (val) onModeChange(val as MachineMode); }}
      size="small"
      fullWidth
      sx={{ '& .MuiToggleButton-root': { fontSize: 11, py: 0.5, textTransform: 'none', fontWeight: 600 } }}
    >
      {(['AUTO', 'MANUAL', 'MAINTENANCE'] as MachineMode[]).map((m) => {
        const c = MODE_COLORS[m];
        return (
          <ToggleButton key={m} value={m} sx={{
            color: mode === m ? c : undefined,
            '&.Mui-selected': { bgcolor: `${c}20`, color: c },
            '&.Mui-selected:hover': { bgcolor: `${c}30` },
          }}>
            {m === 'MAINTENANCE' ? 'Maint.' : m.charAt(0) + m.slice(1).toLowerCase()}
          </ToggleButton>
        );
      })}
    </ToggleButtonGroup>
  );
}

// ─── Control Buttons (with icons) ───────────────────────────────────────

function ControlButtons({ state, plugin }: { state: MachineState; plugin: MachineControlPluginAPI }) {
  const isRunning = state === 'RUNNING';
  const isError = state === 'ERROR';

  const handleStartStop = () => {
    if (isError) { plugin.clearError(); plugin.start(); return; }
    if (isRunning) { plugin.stop(); } else { plugin.start(); }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Box sx={{ display: 'flex', gap: 0.75 }}>
        <Button
          variant="contained"
          size="small"
          onClick={handleStartStop}
          startIcon={isRunning ? <Stop sx={{ fontSize: '14px !important' }} /> : <PlayArrow sx={{ fontSize: '14px !important' }} />}
          sx={{
            flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'none',
            bgcolor: isRunning ? C.green : 'rgba(255,255,255,0.15)',
            color: isRunning ? '#fff' : undefined,
            '&:hover': { bgcolor: isRunning ? '#4caf50' : 'rgba(255,255,255,0.25)' },
          }}
        >
          {isRunning ? 'Running' : 'Start'}
        </Button>
      </Box>
      <Button
        variant="contained"
        size="small"
        onClick={() => plugin.emergencyStop()}
        disabled={isError}
        startIcon={<Warning sx={{ fontSize: '14px !important' }} />}
        sx={{
          fontSize: 12, fontWeight: 800, textTransform: 'none', letterSpacing: 0.5,
          bgcolor: '#d32f2f', color: '#fff',
          '&:hover': { bgcolor: '#b71c1c' },
          '&.Mui-disabled': { bgcolor: 'rgba(211,47,47,0.3)', color: 'rgba(255,255,255,0.3)' },
        }}
      >
        E-STOP
      </Button>
    </Box>
  );
}

// ─── Subsystem Button (Robot, Entry Conveyor, etc.) ─────────────────────

function SubsystemButton({ icon, label, active, onClick }: {
  icon: React.ReactNode; label: string; active: boolean; onClick?: () => void;
}) {
  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.25,
        flex: 1, py: 1, px: 0.5, borderRadius: 1.5, cursor: 'pointer',
        bgcolor: active ? 'rgba(102,187,106,0.12)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${active ? 'rgba(102,187,106,0.3)' : 'rgba(255,255,255,0.08)'}`,
        transition: 'all 0.15s',
        '&:hover': { bgcolor: active ? 'rgba(102,187,106,0.18)' : 'rgba(255,255,255,0.08)' },
      }}
    >
      <Box sx={{ color: active ? C.green : C.dimWhite, display: 'flex' }}>
        {icon}
      </Box>
      <Typography sx={{ fontSize: 10, fontWeight: 600, color: active ? C.green : 'text.secondary', textAlign: 'center', lineHeight: 1.2 }}>
        {label}
      </Typography>
    </Box>
  );
}

// ─── Indicator Dot (for sensors, door) ──────────────────────────────────

function Indicator({ label, active, color }: { label: string; active: boolean; color?: string }) {
  const c = color ?? (active ? C.green : C.faintWhite);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.25 }}>
      <Box sx={{
        width: 8, height: 8, borderRadius: '50%', bgcolor: c, flexShrink: 0,
        boxShadow: active ? `0 0 6px ${c}` : 'none',
        border: active ? 'none' : '1px solid rgba(255,255,255,0.15)',
      }} />
      <Typography sx={{ fontSize: 11, color: active ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)' }}>
        {label}
      </Typography>
    </Box>
  );
}

// ─── Sensor State History Chart ─────────────────────────────────────────

/** Max data points kept per sensor timeline. */
const HISTORY_LENGTH = 60;
/** Interval in ms between history samples. */
const HISTORY_INTERVAL = 500;

/** Hook that reads actual sensor occupied states from the viewer, polled at a fixed interval. */
function useSensorStates(viewer: ReturnType<typeof useViewer>, interval = HISTORY_INTERVAL): Map<string, boolean> {
  const [states, setStates] = useState<Map<string, boolean>>(new Map());
  const prevRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    const poll = () => {
      const sensors = viewer.transportManager?.sensors;
      if (!sensors || sensors.length === 0) return;
      const next = new Map<string, boolean>();
      let changed = false;
      for (const s of sensors) {
        const val = s.occupied;
        next.set(s.node.name, val);
        if (prevRef.current.get(s.node.name) !== val) changed = true;
      }
      if (changed || next.size !== prevRef.current.size) {
        prevRef.current = next;
        setStates(next);
      }
    };
    poll(); // immediate
    const id = setInterval(poll, interval);
    return () => clearInterval(id);
  }, [viewer, interval]);

  return states;
}

/** Hook that samples a boolean value at a fixed interval and returns a rolling history array. */
function useBoolHistory(value: boolean, maxLen = HISTORY_LENGTH, interval = HISTORY_INTERVAL): boolean[] {
  const histRef = useRef<boolean[]>([]);
  const valueRef = useRef(value);
  const [history, setHistory] = useState<boolean[]>([]);

  // Keep valueRef in sync so the interval always reads the latest value
  valueRef.current = value;

  useEffect(() => {
    const id = setInterval(() => {
      const h = histRef.current;
      h.push(valueRef.current);
      if (h.length > maxLen) h.shift();
      setHistory([...h]);
    }, interval);
    return () => clearInterval(id);
  }, [maxLen, interval]);

  return history;
}

/** Mini canvas timeline showing boolean on/off states over time. */
function SensorTimeline({ history, activeColor }: { history: boolean[]; activeColor: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (history.length < 2) return;

    // Draw baseline
    const baseY = h - 2;
    const topY = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(w, baseY);
    ctx.stroke();

    // Draw state timeline as filled areas
    const step = w / (HISTORY_LENGTH - 1);
    const offset = HISTORY_LENGTH - history.length;

    ctx.fillStyle = activeColor + '30';
    ctx.strokeStyle = activeColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    let started = false;
    for (let i = 0; i < history.length; i++) {
      const x = (i + offset) * step;
      const y = history[i] ? topY : baseY;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under the line
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = (i + offset) * step;
      const y = history[i] ? topY : baseY;
      if (i === 0) ctx.moveTo(x, baseY);
      ctx.lineTo(x, y);
    }
    const lastX = (history.length - 1 + offset) * step;
    ctx.lineTo(lastX, baseY);
    ctx.closePath();
    ctx.fill();
  }, [history, activeColor]);

  return (
    <canvas
      ref={canvasRef}
      width={200}
      height={20}
      style={{ width: '100%', height: 20, display: 'block' }}
    />
  );
}

/** Sensor indicator row with inline state history chart. */
function SensorIndicatorWithHistory({ label, active, color }: { label: string; active: boolean; color?: string }) {
  const c = color ?? C.green;
  const history = useBoolHistory(active);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      <Indicator label={label} active={active} color={color} />
      <Box sx={{ pl: 2, pr: 0.5 }}>
        <SensorTimeline history={history} activeColor={c} />
      </Box>
    </Box>
  );
}

// ─── Component Status Icon ──────────────────────────────────────────────

function StatusDot({ status }: { status: ComponentStatus }) {
  const color = status === 'error' ? C.red
    : (status === 'running' || status === 'active') ? 'rgba(255,255,255,0.65)'
    : 'rgba(255,255,255,0.2)';
  const glow = status === 'error' ? `0 0 6px ${C.red}` : 'none';
  return (
    <Box sx={{
      width: 7, height: 7, borderRadius: '50%', bgcolor: color, flexShrink: 0,
      boxShadow: glow,
      border: (status === 'stopped' || status === 'inactive') ? '1px solid rgba(255,255,255,0.15)' : 'none',
    }} />
  );
}

function statusLabel(status: ComponentStatus): string {
  switch (status) {
    case 'running': return 'RUN';
    case 'stopped': return 'OFF';
    case 'active': return 'ON';
    case 'inactive': return 'OFF';
    case 'error': return 'ERR';
    default: return '--';
  }
}

// ─── Component Row ──────────────────────────────────────────────────────

function ComponentRow({ component, isHighlighted, onHover, onClick, onLeave, rowRef, position }: {
  component: MachineComponent; isHighlighted: boolean;
  onHover: () => void; onClick: () => void; onLeave: () => void;
  rowRef?: React.Ref<HTMLDivElement>;
  position?: string;
}) {
  const isActive = component.status === 'running' || component.status === 'active';
  const isErr = component.status === 'error';
  const lightColor = isErr ? C.red : isActive ? C.green : C.faintWhite;

  return (
    <Box
      ref={rowRef}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
      sx={{
        display: 'flex', alignItems: 'center', gap: 0.75,
        px: 1, py: 0.4, cursor: 'pointer', borderRadius: 0.75,
        bgcolor: isHighlighted ? 'rgba(79,195,247,0.12)' : 'transparent',
        '&:hover': { bgcolor: 'rgba(79,195,247,0.08)' },
        transition: 'background-color 0.15s',
      }}
    >
      {/* Indicator light */}
      <Box sx={{
        width: 7, height: 7, borderRadius: '50%', bgcolor: lightColor, flexShrink: 0,
        boxShadow: (isActive || isErr) ? `0 0 5px ${lightColor}` : 'none',
        border: (!isActive && !isErr) ? '1px solid rgba(255,255,255,0.15)' : 'none',
      }} />
      <Typography sx={{
        fontSize: 11, color: 'text.primary', flex: 1, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {component.name}
      </Typography>
      {position && (
        <Typography sx={{
          fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)',
          minWidth: 48, textAlign: 'right',
        }}>
          {position}
        </Typography>
      )}
    </Box>
  );
}

// ─── Component List ─────────────────────────────────────────────────────

/** Generate a fake position string for demo drives. */
function fakeDrivePosition(name: string, isRunning: boolean): string {
  if (!isRunning) return '0.0 mm';
  // Use hash of name to produce a stable fake position
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  const pos = (Math.abs(h) % 3600) / 10;
  return `${pos.toFixed(1)} mm`;
}

function ComponentList({ components, plugin, highlightedPath, machineRunning }: {
  components: MachineComponent[]; plugin: MachineControlPluginAPI; highlightedPath: string | null;
  machineRunning: boolean;
}) {
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (highlightedPath) {
      const el = rowRefs.current.get(highlightedPath);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [highlightedPath]);

  if (components.length === 0) {
    return (
      <Box sx={{ px: 1.5, py: 2, textAlign: 'center' }}>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontStyle: 'italic' }}>
          No components discovered
        </Typography>
      </Box>
    );
  }

  const drives = components.filter(c => c.type === 'drive');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {drives.map((comp) => (
        <ComponentRow
          key={comp.path || comp.name}
          component={comp}
          isHighlighted={highlightedPath === comp.path}
          onHover={() => plugin.hoverComponent(comp.path)}
          onClick={() => plugin.clickComponent(comp.path)}
          onLeave={() => plugin.leaveComponent()}
          position={fakeDrivePosition(comp.name, machineRunning)}
          rowRef={(el: HTMLDivElement | null) => {
            if (el) rowRefs.current.set(comp.path, el);
            else rowRefs.current.delete(comp.path);
          }}
        />
      ))}
    </Box>
  );
}

// ─── Main Panel ─────────────────────────────────────────────────────────

export function MachineControlPanel() {
  const viewer = useViewer();
  const isMobile = useMobileLayout();
  const controlState = useMachineControl();
  const plugin = viewer.getPlugin<MachineControlPluginAPI>('machine-control');
  const lpm = viewer.leftPanelManager;

  const panelSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isOpen = panelSnapshot.activePanel === 'machine-control';

  // Demo: toggle subsystem buttons
  const [robotActive, setRobotActive] = useState(true);
  const [doorClosed, setDoorClosed] = useState(true);

  // Real sensor states from RVSensor.occupied (polled)
  const sensorStates = useSensorStates(viewer);

  // Sync subsystem states with machine state (ref-based to avoid double render)
  const isRunning = controlState.state === 'RUNNING';
  const prevRunningRef = useRef(isRunning);
  if (prevRunningRef.current !== isRunning) {
    prevRunningRef.current = isRunning;
    // Inline state update during render — React batches this correctly
    setRobotActive(isRunning);
    setDoorClosed(true);
  }

  // Derive sensor active from actual occupied state
  const entrySensorOccupied = sensorStates.get('EntryConveyorSensor') ?? sensorStates.get('EntrySensor') ?? false;
  const exitSensorOccupied = sensorStates.get('ExitConveyorSensor') ?? sensorStates.get('ExitSensor') ?? false;

  // Track 3D-clicked component for highlighting
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const off = viewer.on('selection-changed', (snapshot) => {
      const path = snapshot.primaryPath;
      if (!path) { setHighlightedPath(null); return; }
      const match = controlState.components.find(c => c.path === path || path.startsWith(c.path + '/'));
      setHighlightedPath(match?.path ?? null);
    });
    return off;
  }, [viewer, isOpen, controlState.components]);

  const handleClose = useCallback(() => { lpm.close('machine-control'); }, [lpm]);
  const handleModeChange = useCallback((mode: MachineMode) => { plugin?.setMode(mode); }, [plugin]);

  if (!isOpen || !plugin) return null;

  const drivesRunning = controlState.components.filter(c => c.type === 'drive' && c.status === 'running').length;
  const drivesTotal = controlState.components.filter(c => c.type === 'drive').length;

  return (
    <LeftPanel
      title="Machine Control"
      onClose={handleClose}
      width={MACHINE_PANEL_WIDTH}
      mobile={isMobile ? 'full-screen' : undefined}
    >
      <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>

        {/* ── State & Mode ── */}
        <Box sx={{ px: 1.5, pt: 1.25, pb: 1, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <StateBadge state={controlState.state} />
            <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontStyle: 'italic' }}>
              Demo
            </Typography>
          </Box>
          <ModeSelector mode={controlState.mode} onModeChange={handleModeChange} />
        </Box>

        {/* ── Controls ── */}
        <Box sx={{ px: 1.5, py: 1, borderTop: `1px solid ${C.subtleBorder}` }}>
          <SectionHeader>Controls</SectionHeader>
          <ControlButtons state={controlState.state} plugin={plugin} />
        </Box>

        {/* ── Subsystems ── */}
        <Box sx={{ px: 1.5, py: 1, borderTop: `1px solid ${C.subtleBorder}` }}>
          <SectionHeader>Subsystems</SectionHeader>
          <Box sx={{ display: 'flex', gap: 0.75 }}>
            <SubsystemButton
              icon={<PrecisionManufacturing sx={{ fontSize: 20 }} />}
              label="Robot"
              active={robotActive}
              onClick={() => setRobotActive(!robotActive)}
            />
            <SubsystemButton
              icon={<LocalShipping sx={{ fontSize: 20 }} />}
              label="Entry Conv."
              active={entrySensorOccupied}
            />
            <SubsystemButton
              icon={<LocalShipping sx={{ fontSize: 20, transform: 'scaleX(-1)' }} />}
              label="Exit Conv."
              active={exitSensorOccupied}
            />
          </Box>
        </Box>

        {/* ── Status Indicators ── */}
        <Box sx={{ px: 1.5, py: 1, borderTop: `1px solid ${C.subtleBorder}` }}>
          <SectionHeader>Status</SectionHeader>
          <Box sx={{ display: 'flex', gap: 3, mb: 0.5 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
              <Indicator label={doorClosed ? 'Door Closed' : 'Door Open'} active={doorClosed} color={doorClosed ? C.green : C.orange} />
              <Indicator label={`${drivesRunning}/${drivesTotal} Drives`} active={drivesRunning > 0} />
            </Box>
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            <SensorIndicatorWithHistory label="Entry Sensor" active={entrySensorOccupied} />
            <SensorIndicatorWithHistory label="Exit Sensor" active={exitSensorOccupied} />
          </Box>
        </Box>

        {/* ── Components ── */}
        <Box sx={{ px: 0.5, py: 1, borderTop: `1px solid ${C.subtleBorder}`, flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Box sx={{ px: 1, mb: 0.25 }}>
            <SectionHeader>Drives ({controlState.components.filter(c => c.type === 'drive').length})</SectionHeader>
          </Box>
          <ComponentList
            components={controlState.components}
            plugin={plugin}
            highlightedPath={highlightedPath}
            machineRunning={isRunning}
          />
        </Box>
      </Box>

      {/* Demo disclaimer footer */}
      <Box sx={{ px: 1.5, py: 0.75, borderTop: `1px solid ${C.subtleBorder}`, textAlign: 'center' }}>
        <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', fontStyle: 'italic', letterSpacing: 0.5 }}>
          Demo HMI — controls are for demonstration only
        </Typography>
      </Box>
    </LeftPanel>
  );
}
