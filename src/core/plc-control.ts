// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-control.ts — structural public surface of the virtual PLC (plan-242).
 *
 * Follows the SimDesControl pattern: the public core (UI, MCP tools) talks to
 * the PLC runtime exclusively through this structurally-typed interface — it
 * never imports the private runner implementation. The private runner
 * implements `PlcControl` and registers itself via `registerPlcControl()`;
 * consumers read it back with `getPlcControl()` and must handle `null`
 * (public build without the PLC, or PLC not yet initialised).
 *
 * `PlcDiagnostic` is intentionally a structural duplicate of the private
 * ST-compiler diagnostic type so this file has zero private imports.
 *
 * plan-566 adds two optional seams for the signal cross-reference list:
 * `PlcRuntime.getSignalUsages()` (where ST programs use a signal) and
 * `PlcNavigation` (open the PLC editor at a line). Without the private PLC
 * both are absent and PLC usages simply do not appear / are not clickable.
 */

/** Run state of the virtual PLC. */
export type PlcRunState = 'stopped' | 'running' | 'error';

/** A PLC compiler/binding diagnostic with a 1-based source position. */
export interface PlcDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  /** 1-based source line. */
  line: number;
  /** 1-based source column. */
  column: number;
  /** Length of the offending source range in characters (when known). */
  length?: number;
}

/** One IF / CASE branch of the deployed program and whether it ran in the last scan. */
export interface PlcBranchActivity {
  /** 1-based line of the branch header (IF / ELSIF / ELSE / CASE label). */
  startLine: number;
  /** 1-based last line of the branch body. */
  endLine: number;
  /** True when the branch was entered during the last scan. */
  active: boolean;
}

/**
 * Control surface of the virtual PLC runtime.
 *
 * Scan semantics: one scan = input snapshot from the SignalStore → one full
 * pass of the compiled program → output batch write. Outputs only change at
 * scan boundaries. `deploy()` and `run()` are async because the underlying
 * script sandbox (QuickJS-WASM) is created lazily.
 */
export interface PlcControl {
  /**
   * Compiles and loads a program (COLD: fresh FB states, fresh memory).
   * Returns all diagnostics (compile errors/warnings + signal-binding
   * warnings). On compile errors the PLC enters the 'error' state.
   */
  deploy(code: string): Promise<PlcDiagnostic[]>;
  /** Starts cyclic scanning. After an error this performs a COLD restart (fresh sandbox + FB states). */
  run(): Promise<void>;
  /** Stops cyclic scanning (WARM — memory and FB states are kept). */
  stop(): void;
  /** Executes exactly one scan at the current sim time, independent of the run state. */
  step(): void;
  /** COLD reset: FB states to initial values, program memory rebuilt, sim time to 0. */
  reset(): Promise<void>;
  /** Current run state. */
  readonly state: PlcRunState;
  /** Duration of the last scan in milliseconds (input snapshot + scan + output write). */
  readonly scanTimeMs: number;
  /** Human-readable description of the last error, or null. */
  readonly lastError: string | null;
  /**
   * Online values for the watch panel: all VAR_EXTERNAL values (plus plain
   * VAR values while the online view is on) as of the last scan and function-block outputs keyed as
   * `<instance>.<output>` (e.g. `tDelay.Q`, `tDelay.ET`).
   */
  watch(): ReadonlyMap<string, boolean | number>;
  /**
   * Source of the deployed program (null before a successful deploy). The
   * online view annotates the editor only while its buffer equals this source.
   */
  readonly deployedSource?: string | null;
  /**
   * Online view on/off (the PLC editor turns it on while open). Only then do
   * scans report VAR values and branch activity — off costs nothing per scan.
   */
  setOnlineView?(enabled: boolean): void;
  /** IF / CASE branches with their last-scan activity (empty before the first scan and while the online view is off). */
  branchActivity?(): readonly PlcBranchActivity[];
}

/** One program of a virtual PLC with several programs. */
export interface PlcProgramInfo {
  /** Scene path of the node carrying the PLCProgram ('' = editor buffer without a node yet). */
  path: string;
  name: string;
  /** Scan order: programs run one after another in ascending order within one tick. */
  order: number;
  /** True for the program the editor and the single-program API (getPlcControl) address. */
  selected: boolean;
  state: PlcRunState;
  scanTimeMs: number;
  lastError: string | null;
}

/** How an ST program line touches a signal (plan-566). */
export type PlcSignalUsageAccess = 'declaration' | 'read' | 'write' | 'read-write';

/**
 * One place an ST program uses a signal (plan-566): the VAR_EXTERNAL
 * declaration or a body line that reads and/or writes the bound identifier.
 * Structural duplicate of the private scanner result — no private imports here.
 */
export interface PlcSignalUsage {
  /** Scene path of the node carrying the PLCProgram. */
  programPath: string;
  programName: string;
  /** Signal name the identifier binds to (the `@signal` pragma, else the identifier). */
  signal: string;
  /** The ST identifier as declared. */
  identifier: string;
  /** 1-based source line. */
  line: number;
  access: PlcSignalUsageAccess;
  /** True when this line assigns the signal (`write` / `read-write`). */
  written?: boolean;
  /** True when the PLC editor holds unsaved changes for this program — the line may be stale. */
  unsaved?: boolean;
}

/**
 * The virtual PLC with all its programs (one per PLCProgram node). Programs are
 * scanned in order within the same tick and exchange data only through signals.
 */
export interface PlcRuntime {
  /** All programs in scan order. */
  programs(): PlcProgramInfo[];
  /** A program by scene path or name (case-insensitive), or null. */
  program(pathOrName: string): PlcControl | null;
  /** Outputs written by more than one program (bad practice on a real PLC too). */
  conflicts(): { signal: string; programs: string[] }[];
  /**
   * Every signal usage of every PLCProgram of the scene, read from the current
   * `PLCProgram.Code` data (not from the deployed program) — inactive and
   * uncompilable programs included (plan-566). Optional: older runtimes lack it.
   */
  getSignalUsages?(): PlcSignalUsage[];
}

let currentPlcRuntime: PlcRuntime | null = null;

/** Registers the multi-program runtime (pass null to unregister). Called by the private runtime. */
export function registerPlcRuntime(runtime: PlcRuntime | null): void {
  currentPlcRuntime = runtime;
  notifyPlcSignalUsagesChanged();
}

// ─── Signal usages: change channel + editor navigation (plan-566) ──────────

const usageListeners = new Set<() => void>();

/** Subscribe to "the PLC signal usages may have changed"; returns the unsubscribe. */
export function subscribePlcSignalUsages(cb: () => void): () => void {
  usageListeners.add(cb);
  return () => { usageListeners.delete(cb); };
}

/** Announce that the PLC signal usages changed (runtime / navigation registered, editor buffer dirty state flipped). */
export function notifyPlcSignalUsagesChanged(): void {
  for (const cb of [...usageListeners]) {
    try { cb(); } catch (e) { console.warn('[plc-control] usage listener failed:', e); }
  }
}

/** Opens the PLC editor at a program line. Registered by the private PLC plugin. */
export interface PlcNavigation {
  /** Opens `programPath` in the PLC editor, scrolls to `line` (1-based) and highlights it. */
  revealLine(programPath: string, line: number): void;
}

let currentPlcNavigation: PlcNavigation | null = null;

/** Registers the PLC editor navigation (pass null to unregister, e.g. on plugin dispose). */
export function registerPlcNavigation(navigation: PlcNavigation | null): void {
  currentPlcNavigation = navigation;
  notifyPlcSignalUsagesChanged();
}

/** The PLC editor navigation, or null without the PLC plugin — PLC usages are then not clickable. */
export function getPlcNavigation(): PlcNavigation | null {
  return currentPlcNavigation;
}

/** The multi-program runtime, or null when no PLC runtime is registered. */
export function getPlcRuntime(): PlcRuntime | null {
  return currentPlcRuntime;
}

// ─── Code persistence (deploy → PLCProgram.Code) ──────────────────────────

/** Outcome of persisting a deployed program's source into its scene node. */
export interface PlcCodePersistResult {
  /** True only when `PLCProgram.Code` of the node holds the code after the write. */
  persisted: boolean;
  /** Scene path of the node the code was written to. */
  nodePath?: string;
  /** Which document carries the write: the open asset (editor) or the scene. */
  document?: 'asset-doc' | 'scene-doc';
  /** True when the PLC node had to be created first. */
  created?: boolean;
  /** Why nothing (or not everything) was persisted. */
  error?: string;
  /** Saved, but something the user should know (e.g. the PLC editor kept unsaved edits). */
  warning?: string;
}

/**
 * Writes deployed ST source into `PLCProgram.Code` through the same undoable
 * scene ops the PLC editor uses (carrier node ensured, `setField`). Registered
 * by the private PLC plugin; without it a deploy runs but is not persisted.
 */
export interface PlcPersistence {
  /**
   * Persists `code` into `program` — a scene path (`''` = the node-less editor
   * buffer) or a name; undefined = the selected program. Callers resolve the
   * target BEFORE deploying so a selection change meanwhile cannot redirect it.
   */
  persistCode(code: string, program?: string): Promise<PlcCodePersistResult>;
}

let currentPlcPersistence: PlcPersistence | null = null;

/** Registers the code persistence (pass null to unregister, e.g. on plugin dispose). */
export function registerPlcPersistence(persistence: PlcPersistence | null): void {
  currentPlcPersistence = persistence;
}

/** The code persistence, or null without the private PLC plugin. */
export function getPlcPersistence(): PlcPersistence | null {
  return currentPlcPersistence;
}

// ─── Mini registry (private runner registers, public UI/MCP read) ──────────

let currentPlcControl: PlcControl | null = null;

/** Registers the active PLC control — the SELECTED program (pass null to unregister). Called by the private runtime. */
export function registerPlcControl(control: PlcControl | null): void {
  currentPlcControl = control;
}

/** The selected program's control, or null when no PLC runtime is registered. */
export function getPlcControl(): PlcControl | null {
  return currentPlcControl;
}
