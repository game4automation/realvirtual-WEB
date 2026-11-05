// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plugin-types.ts — Shared type definitions for the contract between core HMI
 * panels and their companion plugins.
 *
 * The actual plugin implementations live in src/plugins/ (public) or in the
 * private repo. Core HMI code imports ONLY from this file, never from plugins
 * directly. This inverts the dependency correctly:
 *   plugins depend on core types, core depends on core types.
 */

// ─── Machine Control Types ──────────────────────────────────────────────

export type MachineState = 'STOPPED' | 'IDLE' | 'RUNNING' | 'HELD' | 'ERROR';
export type MachineMode = 'AUTO' | 'MANUAL' | 'MAINTENANCE';

export type ComponentType = 'drive' | 'sensor';
export type ComponentStatus = 'running' | 'stopped' | 'active' | 'inactive' | 'error';

export interface MachineComponent {
  name: string;
  path: string;
  type: ComponentType;
  status: ComponentStatus;
}

export interface MachineControlState {
  state: MachineState;
  mode: MachineMode;
  components: MachineComponent[];
  /** Index into components[] of the component in error state (E-Stop demo). -1 = none. */
  errorComponentIdx: number;
}

/**
 * Public API surface of MachineControlPlugin consumed by core HMI panels.
 * The actual class implements RVViewerPlugin + this interface.
 */
export interface MachineControlPluginAPI {
  readonly id: string;
  readonly machineState: MachineState;
  readonly machineMode: MachineMode;
  readonly components: MachineComponent[];
  readonly errorComponentIdx: number;
  getState(): MachineControlState;
  start(): void;
  stop(): void;
  hold(): void;
  resume(): void;
  reset(): void;
  emergencyStop(): void;
  clearError(): void;
  setMode(mode: MachineMode): void;
  hoverComponent(path: string): void;
  clickComponent(path: string): void;
  leaveComponent(): void;
}

// ─── Maintenance Types ──────────────────────────────────────────────────

import type { MaintenanceProcedure, MaintenanceStep } from '../maintenance-parser';
export type { MaintenanceProcedure, MaintenanceStep };

export type MaintenanceMode = 'idle' | 'dialog' | 'flythrough' | 'stepbystep' | 'completed';
export type StepResult = 'pass' | 'fail' | 'skipped' | null;

export interface MaintenanceState {
  mode: MaintenanceMode;
  procedure: MaintenanceProcedure | null;
  currentStep: number;
  stepResults: StepResult[];
  /** Whether a camera animation is currently in progress. */
  isCameraAnimating: boolean;
  /** plan-522: a live industrial interface is connected — no freeze, no machine actions. */
  isLive: boolean;
  /** plan-522: a guide with a maintenance runtime runs — render-mode changes are refused. */
  renderModeLocked: boolean;
}

/** One maintenance tile of the message panel (plan-522 Phase 6). */
export interface MaintenanceMessageEntry {
  procedure: MaintenanceProcedure;
  /** Due or overdue (`level >= 2`). */
  due: boolean;
  /** 0 ok, 1 upcoming, 2 due, 3 overdue (plan-522 Phase 7). */
  level: 0 | 1 | 2 | 3;
  levelName: 'ok' | 'upcoming' | 'due' | 'overdue';
  /** Counter of the deciding trigger in `unit` (0 without counter). */
  value: number;
  /** Interval of the deciding trigger in `unit` (0 without counter). */
  interval: number;
  /** Unit of the deciding trigger's counter; '' = a count; null = no counter. */
  unit: 'km' | 'h' | '' | null;
  /** Name of the deciding trigger node; '' for the Phase-6 fields or none. */
  triggerName: string;
  /** Path of the deciding trigger's signal / drive ('' = none). */
  sourcePath: string;
  /** Live without a PLC counter: this browser counts only while it is open. */
  liveBrowserCount: boolean;
}

/**
 * Public API surface of MaintenancePlugin consumed by core HMI panels.
 * The actual class implements RVViewerPlugin + this interface.
 */
export interface MaintenancePluginAPI {
  readonly id: string;
  getState(): MaintenanceState;
  getProcedures(): MaintenanceProcedure[];
  /** Re-read the procedures from the scene (procedure nodes added at runtime after the load). */
  rescanProcedures(): void;
  /** Open the mode dialog for the named procedure (default: the first). */
  enterMaintenance(procedureName?: string): void;
  /** Message-panel tiles (plan-522 Phase 6). */
  getMessageEntries(): MaintenanceMessageEntry[];
  exitMaintenance(): void;
  startScenario(procedure: MaintenanceProcedure | null, mode: 'flythrough' | 'stepbystep'): void;
  goToStep(stepIndex: number): void;
  nextStep(): void;
  prevStep(): void;
  completeStep(stepIndex: number, result?: 'pass' | 'fail'): void;
  restoreProgress(stepResults: StepResult[]): void;
  /**
   * plan-522: clamp a target step to the safety barrier — the first
   * `ConfirmWarning` step that is not confirmed (`'pass'`). Next, the stepper
   * and resume never pass it; the flythrough preview is exempt.
   */
  clampToBarrier(target: number): number;
}

// ─── WebXR Types ────────────────────────────────────────────────────────

/**
 * Public API surface of WebXRPlugin consumed by core HMI panels.
 */
export interface WebXRPluginAPI {
  readonly id: string;
  /** True when AR sessions are supported by the browser. */
  arSupported: boolean;
  /** True when VR sessions are supported by the browser. */
  vrSupported: boolean;
  /** Start an AR session. */
  startAR(): Promise<void>;
}

// ─── FPV Types ──────────────────────────────────────────────────────────

/**
 * Public API surface of FpvPlugin consumed by core HMI panels.
 */
export interface FpvPluginAPI {
  readonly id: string;
  toggle(): void;
  /** Whether FPV is active. */
  readonly isActive?: boolean;
  /** Leave FPV (no-op when inactive). */
  exit?(): void;
}

// ─── Camera Follow / Sit-On Types ─────────────────────────────────────────

/** Active camera follow mode exposed by CameraFollowPlugin (null = inactive). */
export type CameraFollowMode = 'follow' | 'siton' | null;

/**
 * Public API surface of CameraFollowPlugin consumed by the camera toolbar.
 */
export interface CameraFollowPluginAPI {
  readonly id: string;
  /** Active mode, or null when neither Follow nor Sit-On is running. */
  readonly mode: CameraFollowMode;
  /** Toggle a mode: re-invoking the active mode exits, otherwise enters it. */
  toggle(mode: 'follow' | 'siton'): void;
  /** Enter a mode for the current selection (no-op if nothing followable). */
  enter(mode: 'follow' | 'siton'): void;
  /** Leave the active mode and restore the entry view. */
  exit(): void;
  /** Whether a followable part is currently selected. */
  canFollow(): boolean;
}

// ─── MCP Bridge Types ───────────────────────────────────────────────────

/**
 * Public API surface of McpBridgePlugin consumed by core HMI panels.
 */
export interface McpBridgePluginAPI {
  readonly id: string;
  reconnect(port?: string): void;
  /** plan-668: switch AI control on/off (the CONNECT channel is independent). */
  setEnabled(enabled: boolean): void;
  /** plan-2220 E8: "AI may control SolidCraft" (default off). */
  setAiSolidCraft?(enabled: boolean): void;
  /** plan-668: a user action holds the CONNECT channel open (page without CONNECT). */
  acquireChannel?(holder: string): void;
  /** plan-668: release a holder taken with {@link acquireChannel}. */
  releaseChannel?(holder: string): void;
  /** Set the target port without connecting (applied on next enable/reconnect). */
  setPort(port: string): void;
  /** Ask the bridge server to shut down (process exits; restart via the MCP host). */
  shutdownServer(): void;
  /** Pause the bridge server (stop accepting browser connections). */
  pauseServer(): void;
  /** Resume accepting browser connections. */
  resumeServer(): void;
}

// ─── Multiuser Types ────────────────────────────────────────────────────

/**
 * Public API surface of MultiuserPlugin consumed by core HMI panels.
 */
export interface MultiuserPluginAPI {
  readonly id: string;
  /** Current server URL (set via joinSession or URL params). */
  readonly serverUrl: string;
  /** Current local display name. */
  readonly localName: string;
  /** Current join code (empty string if none). */
  readonly joinCode: string;
  /** Current local role ('observer' | 'operator'). */
  readonly localRole: string;
  joinSession(serverUrl: string, name: string, color?: string, role?: string, joinCode?: string): void;
  leaveSession(): void;
}

// ─── Annotation Types ──────────────────────────────────────────────────

/** A 3D annotation marker placed on a surface in the scene. */
export interface Annotation {
  id: string;
  position: [number, number, number];
  normal: [number, number, number];
  text: string;
  color: string;
  author: string;
  timestamp: number;
  nodePath?: string;
  category?: 'note' | 'issue' | 'measurement';
  /** Drawing annotation: polyline points in world space. */
  points?: [number, number, number][];
  lineColor?: string;
  lineWidth?: number;
  /** Saved camera view — restored when clicking the annotation. */
  cameraPos?: [number, number, number];
  cameraTarget?: [number, number, number];
}

/**
 * Public API surface of AnnotationPlugin consumed by core HMI panels.
 */
export interface AnnotationPluginAPI {
  readonly id: string;
  addAnnotation(position: [number, number, number], normal: [number, number, number], text: string, color?: string, nodePath?: string, category?: Annotation['category']): Annotation;
  removeAnnotation(id: string): void;
  updateAnnotation(id: string, changes: Partial<Pick<Annotation, 'text' | 'color' | 'category'>>): void;
  getAnnotations(): Annotation[];
  /** Whether annotation placement mode is active. */
  annotationMode: boolean;
  /** Currently selected annotation ID, or null. */
  selectedAnnotation: string | null;
  /** Focus camera on an annotation. */
  focusAnnotation(id: string): void;
  /** Add a drawing annotation (polyline). */
  addDrawing?(points: [number, number, number][], lineColor?: string, lineWidth?: number): Annotation;
}

// ─── Order Manager Types ──────────────────────────────────────────────

/** A single item in the order cart. */
export interface OrderItem {
  /** AAS ID or unique component identifier. */
  aasId: string;
  /** Display name (ManufacturerProductDesignation or node name). */
  displayName: string;
  /** Manufacturer name from AAS nameplate. */
  manufacturer: string;
  /** Article/order number from AAS nameplate. */
  articleNumber: string;
  /** Quantity (min 1). */
  quantity: number;
  /** Timestamp when added. */
  addedAt: number;
  /** Optional: node path in scene for camera navigation. */
  nodePath?: string;
}

/** Snapshot of the order store state for React useSyncExternalStore. */
export interface OrderSnapshot {
  items: readonly OrderItem[];
  totalPositions: number;
  totalQuantity: number;
}

/**
 * Public API surface of OrderManagerPlugin consumed by core HMI panels
 * and other plugins (e.g. aas-link-plugin tooltip).
 */
export interface OrderManagerPluginAPI {
  readonly id: string;
  addItem(aasId: string, displayName: string, manufacturer: string, articleNumber: string, nodePath?: string): void;
  removeItem(aasId: string): void;
  updateQuantity(aasId: string, qty: number): void;
  clear(): void;
  getItems(): readonly OrderItem[];
  exportCsv(): string;
  orderOnline(): void;
}

/** Configuration for the Order Manager plugin in settings.json or constructor. */
export interface OrderManagerConfig {
  /** URL for online ordering. If absent or empty, demo mode is used. */
  orderUrl?: string;
  /** HTTP method for orderUrl (default: 'POST'). */
  orderMethod?: 'GET' | 'POST';
  /** Default recipient email for mailto export. */
  orderEmail?: string;
  /**
   * Metadata value labels to match as article number (first match wins,
   * exact label matches preferred over substring matches).
   * Compared case-insensitively against `<value label="...">` in RuntimeMetadata content.
   * Default: ['Article', 'ArticleNumber', 'OrderCode', 'PartNumber', 'Artikel', 'Artikelnummer']
   */
  metadataArticleLabels?: string[];
  /**
   * Metadata value labels to match as description (first match wins).
   * Default: ['English', 'Description', 'Designation', 'Beschreibung', 'Bezeichnung']
   */
  metadataDescriptionLabels?: string[];
  /**
   * Metadata value labels to match as manufacturer (first match wins).
   * Default: ['Manufacturer', 'ManufacturerName', 'Hersteller']
   */
  metadataManufacturerLabels?: string[];
}

// ─── Measurement Types ──────────────────────────────────────────────────

/** A 3D distance measurement between two surface points. */
export interface Measurement {
  id: string;
  name: string;
  pointA: [number, number, number];
  pointB: [number, number, number];
  normalA: [number, number, number] | null;
  normalB: [number, number, number] | null;
  distance: number;       // Meters
  visible: boolean;
  color: string;
  timestamp: number;
  cameraPos?: [number, number, number];
  cameraTarget?: [number, number, number];
}

/**
 * Public API surface of MeasurementPlugin consumed by core HMI panels.
 */
export interface MeasurementPluginAPI {
  readonly id: string;
  measurementMode: boolean;
  addMeasurement(pointA: [number, number, number], pointB: [number, number, number]): Measurement;
  removeMeasurement(id: string): void;
  updateMeasurement(id: string, changes: Partial<Pick<Measurement, 'name' | 'color' | 'visible'>>): void;
  removeAll(): void;
  getMeasurements(): Measurement[];
  focusMeasurement(id: string): void;
}

import type { SixDofNavInput, SixDofSample } from '../engine/rv-spacemouse-nav';

/** SpaceMouse connection state: `unavailable` = no WebHID, `failed` = the last open attempt threw. */
export type SpaceMouseConnectionStatus = 'not-connected' | 'connecting' | 'connected' | 'unavailable' | 'failed';

export interface SpaceMousePluginAPI {
  readonly id: string;
  readonly navInput: SixDofNavInput;
  readonly status: SpaceMouseConnectionStatus;
  readonly connected: boolean;
  readonly deviceName: string;
  readonly lastAxes: Readonly<SixDofSample>;
  readonly message: string;
  connect(): Promise<void>;
}

/** Stereo state (plan-2215): `requested` = layout chosen, waiting for fullscreen; `active` = rendering stereo. */
export type StereoState = 'off' | 'requested' | 'active';

/** `web_status.stereo` — the stereo plugin's state as the MCP status reports it. */
export interface StereoStatus {
  state: StereoState;
  active: boolean;
  layout: string;
  eyeSepMm: number;
  scaleMode: string;
  zeroParallax: string;
  /** Distance of the zero-parallax plane in metres (last rendered frame; 0 before the first). */
  zeroParallaxM: number;
  swapEyes: boolean;
  /** Why stereo is not (or no longer) active, or null. */
  refusedReason: string | null;
  /** Plugins whose own back-buffer drawing is not visible in stereo (e.g. Gaussian splats). */
  hiddenInStereo: string[];
}

/** Public contract of the commercial stereo plugin (id `stereo`); the core only reads it. */
export interface StereoPluginAPI {
  readonly id: string;
  readonly status: StereoStatus;
}

/** Status contract of an optional display wall strategy owner (plan-2215 P5). */
export interface WallStatus {
  state: 'off' | 'requested' | 'active';
  active: boolean;
  refusedReason: string | null;
  mode: 'wall' | 'wall-preview';
  node: string | null;
  canvasWidth: number;
  canvasHeight: number;
  configErrors: { path: string; message: string }[];
  outputMismatch: {
    expected: { width: number; height: number };
    actual: { width: number; height: number };
  } | null;
  viewports: {
    label: string;
    /** plan-2233 F9: slots bound / no pose slots (sweet spot) / pose slots without a Frame slot. */
    tracking: 'slots' | 'sweet-spot' | 'unavailable';
    /** Signal of the Frame (heartbeat) slot, or null. */
    frameSlot: string | null;
    ageMs: number | null;
    status: 'fresh' | 'sweet spot' | 'too close' | 'paused' | 'unavailable';
    rect: { x: number; y: number; w: number; h: number };
    eye: string;
  }[];
}

export interface DisplayWallPluginAPI {
  readonly id: string;
  readonly status: WallStatus;
  start(preview?: boolean, path?: string): Promise<void>;
  deactivate(reason: string, next?: 'off' | 'requested'): void;
}
