// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DemoHMIPlugin — Registers demo HMI content into the slot system.
 *
 * Each element self-registers with a slot and order. To customize:
 * create your own RVViewerPlugin with a `slots` array.
 */

import { useState, useSyncExternalStore } from 'react';
import { Speed, Sensors, Warning, Build, PrecisionManufacturing } from '@mui/icons-material';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';

// Core reusable components
import { KpiCard } from '../../core/hmi/KpiCard';
import { TileCard } from '../../core/hmi/TileCard';
import { pulseSeverityOutline } from '../../core/hmi/severity-pulse';
import { NavButton } from '../../core/hmi/NavButton';

// Demo charts (co-located in plugins/demo/)
import { OeeChart } from './OeeChart';
import { PartsChart } from './PartsChart';
import { CycleTimeChart } from './CycleTimeChart';
import { EnergyChart } from './EnergyChart';

// Demo chart overlays (co-located in plugins/demo/)
import { SensorChartOverlay } from './SensorChartOverlay';
import { DriveChartOverlay } from './DriveChartOverlay';
import { openPdfViewer } from '../../core/hmi/pdf-viewer-store';

// Robot AI alarm assistant (FANUC CRX SYST-320)
import { RobotContactForceAlarm } from './robot-alarm/RobotContactForceAlarm';

const BOSCH_AAS_ID = 'https://aas.boschrexroth.com/ctrlxdrive/R911410072-MS2N-Demo-0001';
const BOSCH_MS2N_PDF_ZIP_PATH = 'aasx/Documentation/R911347581_MS2N_Synchronous_Servomotors_Operating_Instructions_0002.pdf';
// Page 22 in the MS2N Operating Instructions covers "Thermal motor protection" (chapter 5.1.3).
const BOSCH_MS2N_F8060_MANUAL_PAGE = 22;

const SEW_AAS_ID = 'https://demo.realvirtual.io/aas/sew/KA47-DRN90M4-Demo-0001';
const SEW_MOTOR_BA_PDF_ZIP_PATH = 'aasx/Documentation/MotorBA_DRN_25957074.pdf';
// Page 265 = the "9.2 Motor malfunctions" fault table. Its rows include
// "Severe speed loss under load" (slip) and "Motor heats up excessively (measure temperature)".
const SEW_DRN_MALFUNCTIONS_PAGE = 265;

/**
 * Active model option id, e.g. 'sew' | 'bosch'. Checks the loaded model URL
 * (selector entries embed `?option=`) and falls back to the page URL (`?option=`
 * deep links such as `?model=…&option=sew`). Mirrors the resolution in
 * ModelOptionPlugin so the HMI message and the AAS swap stay in sync.
 */
function activeModelOption(viewer: { currentModelUrl: string | null }): string | null {
  const m = viewer.currentModelUrl?.match(/[?&]option=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  try { return new URLSearchParams(window.location.search).get('option'); } catch { return null; }
}

/** True when the Bosch supplier option is active. */
function isBoschModel(viewer: { currentModelUrl: string | null }): boolean {
  return activeModelOption(viewer) === 'bosch';
}

/** True when the SEW supplier option is active. */
function isSewModel(viewer: { currentModelUrl: string | null }): boolean {
  return activeModelOption(viewer) === 'sew';
}

// Hooks
import { useDriveChartOpen } from '../../hooks/use-drive-chart';
import { useSensorChartOpen } from '../../hooks/use-sensor-chart';
import { useMaintenanceMode } from '../../hooks/use-maintenance-mode';

// Layout constants
import { MACHINE_PANEL_WIDTH } from '../../core/hmi/layout-constants';
import { useMessagePanelOpen, toggleMessagePanel } from '../../core/hmi/message-panel-store';

// ─── KPI Bar Entries ────────────────────────────────────────────────────

function OeeKpi(_props: UISlotProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <KpiCard label="OEE" value="87" unit="%" color="#66bb6a" secondary="Target: 90%" onClick={() => setOpen((o) => !o)} />
      <OeeChart open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function PartsKpi(_props: UISlotProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <KpiCard label="Parts/h" value="28" unit="p/h" color="#4fc3f7" secondary="Shift total: 186" onClick={() => setOpen((o) => !o)} />
      <PartsChart open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function CycleTimeKpi(_props: UISlotProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <KpiCard label="Cycle Time" value="129" unit="s" color="#ffa726" secondary="Avg last hour" onClick={() => setOpen((o) => !o)} />
      <CycleTimeChart open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function PowerKpi(_props: UISlotProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <KpiCard label="Power" value="23.4" unit="kW" color="#ef5350" secondary="Avg: 18.7 kW" onClick={() => setOpen((o) => !o)} />
      <EnergyChart open={open} onClose={() => setOpen(false)} />
    </>
  );
}

// ─── Button Group Entries ───────────────────────────────────────────────

function DrivesButton({ viewer }: UISlotProps) {
  const open = useDriveChartOpen();
  return (
    <>
      <NavButton icon={<Speed />} label="Drives" active={open} onClick={() => viewer.toggleDriveChart()} />
      <DriveChartOverlay />
    </>
  );
}

function SensorsButton({ viewer }: UISlotProps) {
  const open = useSensorChartOpen();
  return (
    <>
      <NavButton icon={<Sensors />} label="Sensors" active={open} onClick={() => viewer.toggleSensorChart()} />
      <SensorChartOverlay />
    </>
  );
}

function AlarmsButton(_props: UISlotProps) {
  const messagesOpen = useMessagePanelOpen();
  return <NavButton icon={<Warning />} label="Alarms" badge={3} active={messagesOpen} onClick={() => toggleMessagePanel()} />;
}

function MaintenanceButton({ viewer }: UISlotProps) {
  const maintenanceState = useMaintenanceMode();
  const isActive = maintenanceState.mode !== 'idle';
  return (
    <NavButton
      icon={<Build />}
      label="Maintenance"
      badge={isActive ? undefined : 1}
      active={isActive}
      onClick={() => viewer.emit('enter-maintenance' as string, undefined)}
    />
  );
}

function MachineControlButton({ viewer }: UISlotProps) {
  const lpm = viewer.leftPanelManager;
  const panelSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isActive = panelSnapshot.activePanel === 'machine-control';
  return (
    <NavButton
      icon={<PrecisionManufacturing />}
      label="Machine"
      active={isActive}
      onClick={() => lpm.toggle('machine-control', MACHINE_PANEL_WIDTH)}
    />
  );
}

// ─── Message Panel Entries ──────────────────────────────────────────────

function DriveOverloadMessage(_props: UISlotProps) {
  return (
    <TileCard
      title="Drive Overload"
      subtitle="Axis3 — Current: 142%"
      severity="error"
      icon="warning"
      timestamp="12:34:05"
      componentPath="A3"
    />
  );
}

function MaintenanceDueMessage({ viewer }: UISlotProps) {
  return (
    <TileCard
      title="Maintenance Due"
      subtitle="Belt Conveyor 2 — 4800h / 5000h"
      severity="warning"
      icon="build"
      timestamp="Today"
      componentPath="ConveyorEntry2"
      onAction={() => viewer.emit('enter-maintenance' as string, undefined)}
    />
  );
}

function DriveInfoMessage({ viewer }: UISlotProps) {
  if (isBoschModel(viewer)) {
    return <BoschMotorOvertempMessage viewer={viewer} />;
  }
  if (isSewModel(viewer)) {
    return <SewMotorSlipMessage viewer={viewer} />;
  }
  return (
    <TileCard
      title="Drive 1 — Entry Conveyor"
      subtitle="Position: 234.5 mm | Speed: 120 mm/s"
      severity="info"
      icon="speed"
      timestamp="Live"
      componentPath="DemoCell/Conveyors/ConveyorEntry1/Motor"
    />
  );
}

const DRIVE1_MOTOR_PATH = 'DemoCell/Conveyors/ConveyorEntry1/Motor';

/**
 * Frame the Drive 1 motor in 3D and flash it red for a few seconds (visual cue
 * matching the error severity). Delegates to the shared severity flash — the
 * highlighter's flash channel is independent of the selection, so the user's
 * selection outline survives the alarm. Camera-only fit, no focus event.
 */
function pulseMotorAlarm(viewer: UISlotProps['viewer'], path: string): void {
  pulseSeverityOutline(viewer, path, 'error');
}

/**
 * Bosch ctrlX DRIVE F8060 motor overtemperature error.
 * Replaces the Festo "Drive Info" tile when the Bosch supplier option is active.
 *
 * "see manual p.22" opens the MS2N Operating Instructions PDF embedded
 * inside the Bosch AASX (zero duplication — single source of truth).
 */
function BoschMotorOvertempMessage({ viewer }: UISlotProps) {
  const openManual = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openPdfViewer(
      'MS2N Synchronous Servomotors — Operating Instructions',
      { type: 'blob', aasId: BOSCH_AAS_ID, zipPath: BOSCH_MS2N_PDF_ZIP_PATH },
      { initialPage: BOSCH_MS2N_F8060_MANUAL_PAGE },
    );
  };

  return (
    <TileCard
      title="F8060 — Motor overtemperature"
      subtitle={
        <>
          MS2N servomotor (Drive 1) —{' '}
          <a
            href="#"
            onClick={openManual}
            style={{ color: '#4fc3f7', textDecoration: 'underline', cursor: 'pointer' }}
          >
            see manual p.22
          </a>
        </>
      }
      severity="error"
      icon="warning"
      timestamp="14:23"
      componentPath={DRIVE1_MOTOR_PATH}
      onAction={() => pulseMotorAlarm(viewer, DRIVE1_MOTOR_PATH)}
    />
  );
}

/**
 * SEW DRN gearmotor slip fault — speed deviation between commanded and actual speed.
 * Replaces the Festo "Drive Info" tile when the SEW supplier option is active.
 *
 * "see manual p.265" opens the "9.2 Motor malfunctions" fault table of the DRN motor
 * operating instructions embedded inside the SEW AASX (single source of truth) — the
 * page covers "Severe speed loss under load" (slip) and excessive motor temperature.
 */
function SewMotorSlipMessage({ viewer }: UISlotProps) {
  const openManual = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openPdfViewer(
      'DRN.. AC Motors — Operating Instructions',
      { type: 'blob', aasId: SEW_AAS_ID, zipPath: SEW_MOTOR_BA_PDF_ZIP_PATH },
      { initialPage: SEW_DRN_MALFUNCTIONS_PAGE },
    );
  };

  return (
    <TileCard
      title="Slip fault — speed deviation"
      subtitle={
        <>
          KA47-DRN90M4 gearmotor (Drive 1) —{' '}
          <a
            href="#"
            onClick={openManual}
            style={{ color: '#4fc3f7', textDecoration: 'underline', cursor: 'pointer' }}
          >
            see manual p.265
          </a>
        </>
      }
      severity="error"
      icon="warning"
      timestamp="14:23"
      componentPath={DRIVE1_MOTOR_PATH}
      onAction={() => pulseMotorAlarm(viewer, DRIVE1_MOTOR_PATH)}
    />
  );
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class DemoHMIPlugin implements RVViewerPlugin {
  readonly id = 'demo-hmi';
  readonly slots: UISlotEntry[] = [
    // KPI bar (top center)
    { slot: 'kpi-bar', component: OeeKpi, order: 10 },
    { slot: 'kpi-bar', component: PartsKpi, order: 20 },
    { slot: 'kpi-bar', component: CycleTimeKpi, order: 30 },
    { slot: 'kpi-bar', component: PowerKpi, order: 40 },

    // Button group (left sidebar)
    { slot: 'button-group', component: MachineControlButton, order: 5 },
    { slot: 'button-group', component: DrivesButton, order: 10 },
    { slot: 'button-group', component: SensorsButton, order: 20 },
    { slot: 'button-group', component: AlarmsButton, order: 30 },
    { slot: 'button-group', component: MaintenanceButton, order: 40 },

    // Messages (right panel)
    { slot: 'messages', component: DriveOverloadMessage, order: 10 },
    { slot: 'messages', component: MaintenanceDueMessage, order: 20 },
    { slot: 'messages', component: DriveInfoMessage, order: 30 },
    { slot: 'messages', component: RobotContactForceAlarm, order: 40 },
  ];
}
