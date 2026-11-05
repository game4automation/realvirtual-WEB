// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * usd-record-commands — EAGER descriptors of the animated USD recording
 * (plan-2229 Phase 3).
 *
 *   usd.record.start     start a recording (live, or deterministic N seconds)
 *   usd.record.stop      end it, keep the data for the export
 *   usd.record.cancel    end it and drop the data (also aborts a running job)
 *   usd.record.status    read-only state (`web_query`)
 *   usd.export.animated  write the recording as an animated .usdz; with
 *                        `mode: "record-and-export"` ONE job records
 *                        deterministically and exports afterwards (the
 *                        `web_export_usd mode:"animated"` shortcut)
 *
 * Open on purpose (tier-boundary 6): `web_commands` lists them and the Phase-4
 * record button binds to them before any private code is loaded. The
 * implementations come lazily from
 * `@rv-private/plugins/usd/anim/usd-record-commands`; the community stub has
 * `impls = {}`, so every command answers kind `unavailable` with
 * {@link USD_RECORD_UNAVAILABLE} and never "unknown" (commands-mcp 4, 5).
 *
 * The option rules (limits, defaults, units) live HERE, open, so the record
 * dialog, the command and the MCP shortcut validate the same way (commands-mcp 1).
 */

import {
  commandRegistry,
  type CommandArgType,
  type CommandDescriptor,
  type CommandImpl,
  type CommandRegistry,
} from '../rv-command-registry';

// ─── Texts and limits ───────────────────────────────────────────────────

export const USD_RECORD_UNAVAILABLE = 'USD animation export is a commercial module (realvirtual Commercial)';
export const USD_RECORD_FPS = [24, 30, 60] as const;
export type UsdRecordFps = (typeof USD_RECORD_FPS)[number];
export const USD_RECORD_DEFAULT_FPS: UsdRecordFps = 30;
/** Upper bound of a recording in SIM seconds (Q5). */
export const USD_RECORD_MAX_SECONDS = 600;
/** Cumulative MU prims per file (Q3, 2.9 Nr. 15). */
export const USD_RECORD_MAX_MUS = 2000;
/** Warning threshold of the size estimate (Q5) — a warning, never an abort. */
export const USD_RECORD_WARN_BYTES = 200 * 1024 * 1024;
export const USD_RECORD_DEFAULT_POS_MM = 0.1;
export const USD_RECORD_DEFAULT_ANGLE_DEG = 0.05;
export const USD_RECORD_DEFAULT_SCALE_REL = 1e-4;
/** Project folder an export with `target: "project"` writes into. */
export const USD_EXPORTS_FOLDER = 'exports';

/** Above the 120 s `web_execute` limit: an MCP call of these commands always runs as a job. */
export const USD_RECORD_JOB_TIMEOUT_MS = 60 * 60 * 1000;

export const USD_RECORD_COMMAND_IDS = [
  'usd.record.start', 'usd.record.stop', 'usd.record.cancel', 'usd.record.status', 'usd.export.animated',
] as const;

// ─── Args ───────────────────────────────────────────────────────────────

/** `usd.record.start` (null / absent = default). */
export interface UsdRecordStartArgs {
  readonly fps?: number | null;
  /** `live` (default) | `deterministic`. */
  readonly mode?: string | null;
  /** Sim seconds. Deterministic: required; live: upper bound (default 600). */
  readonly durationSec?: number | null;
  /** Keyframe reduction on (default) or off. */
  readonly reduce?: boolean | null;
  /** Translation tolerance in millimetres (0 = lossless), default 0.1. */
  readonly posMm?: number | null;
  /** Rotation tolerance in degrees (0 = lossless), default 0.05. */
  readonly angleDeg?: number | null;
  /** Cumulative MU prims, 1-2000, default 2000. */
  readonly maxMus?: number | null;
  /** Extra scale-0 step for Blender (S-Q1), default on. */
  readonly blenderVisibilityCompat?: boolean | null;
}

/**
 * `usd.export.animated`. The recording options apply to `mode: "record-and-export"`
 * (always deterministic, `durationSec` required); the reduction / compat options
 * override what the recording was started with.
 */
export interface UsdExportAnimatedArgs extends Omit<UsdRecordStartArgs, 'mode'> {
  /** `recording` (default: export the stopped recording) | `record-and-export`. */
  readonly mode?: string | null;
  /** File name without extension. */
  readonly name?: string | null;
  /** `download` (default) | `project` (exports/<name>.usdz). */
  readonly target?: string | null;
  /** NodeId addresses in customData (ID3), default on. */
  readonly writeAddresses?: boolean | null;
}

export interface UsdRecordOptions {
  readonly fps: UsdRecordFps;
  readonly mode: 'live' | 'deterministic';
  readonly durationSec: number;
  readonly reduce: boolean;
  readonly posMm: number;
  readonly angleDeg: number;
  readonly maxMus: number;
  readonly blenderVisibilityCompat: boolean;
}

export interface UsdExportOptions {
  readonly mode: 'recording' | 'record-and-export';
  readonly name: string;
  readonly target: 'download' | 'project';
  readonly writeAddresses: boolean;
  /** Overrides of the recording's reduction / compat settings (absent = as recorded). */
  readonly reduce?: boolean;
  readonly posMm?: number;
  readonly angleDeg?: number;
  readonly blenderVisibilityCompat?: boolean;
}

export type Resolved<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate + default the recording options (the one rule of dialog, command and MCP). */
export function resolveUsdRecordOptions(a: UsdRecordStartArgs | undefined | null): Resolved<UsdRecordOptions> {
  const args = a ?? {};
  const fps = args.fps ?? USD_RECORD_DEFAULT_FPS;
  if (!(USD_RECORD_FPS as readonly number[]).includes(fps)) return { ok: false, reason: 'fps must be 24, 30 or 60' };
  const mode = (args.mode ?? 'live').trim().toLowerCase();
  if (mode !== 'live' && mode !== 'deterministic') return { ok: false, reason: 'mode must be "live" or "deterministic"' };
  const duration = args.durationSec ?? null;
  if (mode === 'deterministic' && duration === null) return { ok: false, reason: 'durationSec is required for a deterministic recording (1-600 s)' };
  if (duration !== null && (!isNum(duration) || duration < 1 || duration > USD_RECORD_MAX_SECONDS)) {
    return { ok: false, reason: `durationSec must be between 1 and ${USD_RECORD_MAX_SECONDS} seconds` };
  }
  const posMm = args.posMm ?? USD_RECORD_DEFAULT_POS_MM;
  if (!isNum(posMm) || posMm < 0) return { ok: false, reason: 'posMm must be a number >= 0 (millimetres)' };
  const angleDeg = args.angleDeg ?? USD_RECORD_DEFAULT_ANGLE_DEG;
  if (!isNum(angleDeg) || angleDeg < 0) return { ok: false, reason: 'angleDeg must be a number >= 0 (degrees)' };
  const maxMus = args.maxMus ?? USD_RECORD_MAX_MUS;
  if (!Number.isInteger(maxMus) || maxMus < 1 || maxMus > USD_RECORD_MAX_MUS) {
    return { ok: false, reason: `maxMus must be an integer between 1 and ${USD_RECORD_MAX_MUS}` };
  }
  return {
    ok: true,
    value: {
      fps: fps as UsdRecordFps,
      mode,
      durationSec: duration ?? USD_RECORD_MAX_SECONDS,
      reduce: args.reduce !== false,
      posMm,
      angleDeg,
      maxMus,
      blenderVisibilityCompat: args.blenderVisibilityCompat !== false,
    },
  };
}

/** A file name an agent or the dialog passes, reduced to a safe stem (extension stripped). */
export function usdExportFileStem(name: string): string {
  return name.trim()
    .replace(/\.(usdz|usda|usd)$/i, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Validate + default the export options. */
export function resolveUsdExportOptions(a: UsdExportAnimatedArgs | undefined | null): Resolved<UsdExportOptions> {
  const args = a ?? {};
  const mode = (args.mode ?? 'recording').trim().toLowerCase();
  if (mode !== 'recording' && mode !== 'record-and-export') return { ok: false, reason: 'mode must be "recording" or "record-and-export"' };
  const target = (args.target ?? 'download').trim().toLowerCase();
  if (target !== 'download' && target !== 'project') return { ok: false, reason: 'target must be "download" or "project"' };
  if (args.posMm != null && (!isNum(args.posMm) || args.posMm < 0)) return { ok: false, reason: 'posMm must be a number >= 0 (millimetres)' };
  if (args.angleDeg != null && (!isNum(args.angleDeg) || args.angleDeg < 0)) return { ok: false, reason: 'angleDeg must be a number >= 0 (degrees)' };
  const stem = args.name ? usdExportFileStem(args.name) : '';
  return {
    ok: true,
    value: {
      mode,
      name: stem || 'usd-animation',
      target,
      writeAddresses: args.writeAddresses !== false,
      ...(args.reduce != null ? { reduce: args.reduce } : {}),
      ...(args.posMm != null ? { posMm: args.posMm } : {}),
      ...(args.angleDeg != null ? { angleDeg: args.angleDeg } : {}),
      ...(args.blenderVisibilityCompat != null ? { blenderVisibilityCompat: args.blenderVisibilityCompat } : {}),
    },
  };
}

// ─── Descriptor table ───────────────────────────────────────────────────

/** Shape of the (private or stub) implementation module. */
export interface UsdRecordCommandsModule {
  readonly impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>>;
}

export interface UsdRecordDescriptorOptions {
  /** Module loader — production: the `@rv-private` alias (stub in the community build). */
  readonly load: () => Promise<UsdRecordCommandsModule>;
}

const START_SCHEMA: Readonly<Record<string, CommandArgType>> = {
  fps: 'number', mode: 'string', durationSec: 'number', reduce: 'boolean',
  posMm: 'number', angleDeg: 'number', maxMus: 'number', blenderVisibilityCompat: 'boolean',
};

interface Spec {
  readonly id: (typeof USD_RECORD_COMMAND_IDS)[number];
  readonly label: string;
  readonly readOnly: boolean;
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  /** Long-running: an MCP call returns a job (the deterministic run, the record-and-export chain). */
  readonly job?: boolean;
}

const SPECS: readonly Spec[] = [
  { id: 'usd.record.start', label: 'Record USD animation', readOnly: false, argsSchema: START_SCHEMA, job: true },
  { id: 'usd.record.stop', label: 'Stop USD recording', readOnly: false, argsSchema: {} },
  { id: 'usd.record.cancel', label: 'Discard USD recording', readOnly: false, argsSchema: {} },
  { id: 'usd.record.status', label: 'USD recording status', readOnly: true, argsSchema: {} },
  {
    id: 'usd.export.animated', label: 'Export as USD (animated)', readOnly: false, job: true,
    argsSchema: { ...START_SCHEMA, name: 'string', target: 'string', writeAddresses: 'boolean' },
  },
];

/**
 * Build the descriptors against a module loader (testable seam, no registry side effect).
 *
 * `available: true` on purpose: the eager flag would answer the asset editor's
 * text; the stub's missing implementation answers {@link USD_RECORD_UNAVAILABLE}
 * (kind `unavailable`) and loads nothing private. Every writing command is
 * class `file` (it produces or prepares a file, commands-mcp 7) — none is a
 * history step or a macro line (commands-mcp 3, 6).
 */
export function createUsdRecordCommandDescriptors(opts: UsdRecordDescriptorOptions): CommandDescriptor<never, unknown>[] {
  const implOf = (id: string) => () =>
    opts.load().then((m) => (m.impls?.[id] ?? null) as CommandImpl<never, unknown> | null);
  return SPECS.map((sp): CommandDescriptor<never, unknown> => ({
    id: sp.id,
    label: sp.label,
    readOnly: sp.readOnly,
    scope: 'none',
    available: true,
    unavailableReason: USD_RECORD_UNAVAILABLE,
    ...(sp.readOnly ? {} : { toolClass: 'file' as const }),
    ...(sp.job ? { timeoutMs: USD_RECORD_JOB_TIMEOUT_MS, cancellable: true } : {}),
    argsSchema: sp.argsSchema,
    impl: implOf(sp.id),
  }));
}

/** Production loader: the private implementation, or the community stub. */
const loadUsdRecordCommands = (): Promise<UsdRecordCommandsModule> =>
  import('@rv-private/plugins/usd/anim/usd-record-commands') as Promise<UsdRecordCommandsModule>;

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the five USD recording commands. */
export function ensureUsdRecordCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createUsdRecordCommandDescriptors({ load: loadUsdRecordCommands })) registry.register(d);
}
