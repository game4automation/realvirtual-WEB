// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-proc.mjs (plan-587 Phase 3a). */

/** Grace period between SIGTERM and SIGKILL on POSIX. */
export const KILL_ESCALATION_MS: number;

/** The only phase in which an expired deadline kills the child (F4). */
export const KILLABLE_PHASES: readonly string[];

export interface KillTreeOptions {
  escalateAfterMs?: number;
  platform?: string;
  runSync?: (file: string, args: string[], options?: Record<string, unknown>) => { status?: number | null } | undefined;
  kill?: (target: number, signal: string) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
}

export interface KillTreeResult {
  platform: string;
  ok: boolean;
  /** `'tree'` on Windows, `'group'` or `'pid'` on POSIX, `null` when nothing was signalled. */
  target: 'tree' | 'group' | 'pid' | null;
  escalation: unknown;
}

/**
 * Ends a process and, as far as the platform allows, its children. Windows:
 * `taskkill /T /F` (measured). POSIX: SIGTERM to the process group with a pid
 * fallback and a SIGKILL escalation — reliability against grandchildren is
 * NOT measured (plan-587 §4b M3). Never throws.
 */
export function killTree(pid: number | undefined | null, options?: KillTreeOptions): KillTreeResult;

export interface TimeoutKillVerdict {
  kill: boolean;
  phase: string | null;
  reason: string;
}

/**
 * Decides whether an expired deadline may kill the child, from the phase the
 * child REPORTED in `phaseFile` (`{ phase, at }`). No phase file = plain
 * timeout (kill); a missing or unreadable one = conservative (no kill).
 */
export function decideTimeoutKill(
  phaseFile: string | null | undefined,
  options?: { killablePhases?: readonly string[]; readFile?: (path: string, encoding: string) => string },
): TimeoutKillVerdict;

export interface SpawnLoggedResult {
  code: number;
  signal: string | null;
  timedOut: boolean;
  killed: boolean;
  /** The phase read from `phaseFile` when the deadline passed, else null. */
  timeoutPhase: string | null;
  error: string | null;
  stdout: string;
  stderr: string;
  pid: number | undefined;
}

export interface SpawnLoggedOptions {
  file: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** stdout AND stderr into this file, on one descriptor closed right after the spawn. */
  logPath?: string | null;
  /** Collect stdout/stderr as strings instead; defaults to true without `logPath`. */
  capture?: boolean;
  timeoutMs?: number | null;
  afterKill?: (() => void) | null;
  /** The child's `{ phase, at }` file — see `decideTimeoutKill`. */
  phaseFile?: string | null;
  killablePhases?: readonly string[];
  detached?: boolean;
  stdin?: string;
  windowsHide?: boolean;
  deps?: Record<string, unknown>;
}

/**
 * Spawns a child, routes its output, enforces a phase-aware time limit and
 * resolves its outcome. `exit` never rejects and resolves on `close`.
 */
export function spawnLogged(options: SpawnLoggedOptions): { pid: number | undefined; exit: Promise<SpawnLoggedResult> };
