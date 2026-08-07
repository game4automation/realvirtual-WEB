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
   * Online values for the watch panel: all VAR_EXTERNAL values as of the last
   * scan plus function-block outputs keyed as `<instance>.<output>`
   * (e.g. `tDelay.Q`, `tDelay.ET`).
   */
  watch(): ReadonlyMap<string, boolean | number>;
}

// ─── Mini registry (private runner registers, public UI/MCP read) ──────────

let currentPlcControl: PlcControl | null = null;

/** Registers the active PLC control (pass null to unregister). Called by the private runtime. */
export function registerPlcControl(control: PlcControl | null): void {
  currentPlcControl = control;
}

/** The active PLC control, or null when no PLC runtime is registered. */
export function getPlcControl(): PlcControl | null {
  return currentPlcControl;
}
