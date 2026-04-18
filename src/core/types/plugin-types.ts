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
}

/**
 * Public API surface of MaintenancePlugin consumed by core HMI panels.
 * The actual class implements RVViewerPlugin + this interface.
 */
export interface MaintenancePluginAPI {
  readonly id: string;
  getState(): MaintenanceState;
  getProcedures(): MaintenanceProcedure[];
  enterMaintenance(): void;
  exitMaintenance(): void;
  startScenario(procedure: MaintenanceProcedure | null, mode: 'flythrough' | 'stepbystep'): void;
  goToStep(stepIndex: number): void;
  nextStep(): void;
  prevStep(): void;
  completeStep(stepIndex: number, result?: 'pass' | 'fail'): void;
  restoreProgress(stepResults: StepResult[]): void;
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
}

// ─── MCP Bridge Types ───────────────────────────────────────────────────

/**
 * Public API surface of McpBridgePlugin consumed by core HMI panels.
 */
export interface McpBridgePluginAPI {
  readonly id: string;
  reconnect(port?: string): void;
  setEnabled(enabled: boolean): void;
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
   * Metadata value labels to match as article number (first match wins).
   * Compared case-insensitively against `<value label="...">` in RuntimeMetadata content.
   * Default: ['Article', 'ArticleNumber', 'OrderCode', 'PartNumber']
   */
  metadataArticleLabels?: string[];
  /**
   * Metadata value labels to match as description (first match wins).
   * Default: ['English', 'Description', 'Designation']
   */
  metadataDescriptionLabels?: string[];
  /**
   * Metadata value labels to match as manufacturer (first match wins).
   * Default: ['Manufacturer', 'ManufacturerName']
   */
  metadataManufacturerLabels?: string[];
}
