// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

export const EXIT_RESUMABLE: number;
export function parseArgs(argv: string[]): { url: string | null; opts: Record<string, string | boolean> };
export function buildUrl(url: string | null, opts: Record<string, unknown>): string;
export function recordOptions(opts: Record<string, unknown>): Record<string, any>;
export function cinematicBaseManifest(options: Record<string, any>, hdrFileHash: string | null): Record<string, unknown>;
/** plan-554 F8: the CLI blur flags as the `motionBlur` option (defaults left to the page). */
export function motionBlurOptions(opts: Record<string, unknown>): { enabled?: boolean; shutterDeg?: number; subFrames?: number };
/** plan-554 F7: the second resume compare after the page's setup (the RESOLVED blur); null = allowed. */
export function setupBlurRefusal(
  stored: Record<string, unknown> | null, info: { motionBlur?: { resolved?: string; reason?: string | null; subFrames?: number } } | null,
  resuming: boolean, wording?: { place: string; advice: string },
): string | null;
/** plan-556: a usage error (exit code 2), thrown by the option rules. */
export class CliUsageError extends Error {}
/** plan-556: the HMI / still options of an argv option map. */
export function hmiOptionsOf(opts: Record<string, unknown>, quality: string): import('./lib/rv-record-hmi.mjs').HmiCliOptions;
/** plan-556: VideoRecordOptions without the CLI-only HMI fields. */
export function engineOptions(options: Record<string, any>): Record<string, any>;
/** plan-556 F5b: the still options of a recording option set. */
export function stillOptions(options: Record<string, any>, hmi: { steps: number }): Record<string, any>;
