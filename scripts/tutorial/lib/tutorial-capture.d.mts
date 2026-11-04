// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `tutorial-capture.mjs` (plan-2004). Required for TS7016 — the node tests
 * import the module statically from TypeScript. Keep in step with the .mjs by hand.
 */

export interface Region { x: number; y: number; w: number; h: number }

export function aviRawChunks(buffer: Buffer): Buffer[];

export function run(
  binary: string,
  args: string[],
  options?: { input?: Buffer; maxBuffer?: number },
): Promise<{ stdout: Buffer; stderr: string }>;

/** Teardown: kills every still running child started by `run()`; returns how many were signalled. */
export function killActiveChildren(): number;

export function resolveEncoders(options?: {
  ffmpeg?: string;
  ffprobe?: string;
  repoRoot?: string;
  env?: Record<string, string | undefined>;
}): { ffmpeg: string; ffprobe: string; source: string | null };

export function createEncoder(options: { ffmpeg: string; fps: number; out: string }): {
  write(buffer: Buffer): Promise<void>;
  finish(): Promise<string>;
  /** Teardown only: kills ffmpeg without a finished file; resolves with its exit code. */
  abort(): Promise<number | null>;
};

export function encodeFrames(options: { ffmpeg: string; frames: Buffer[]; fps: number; out: string }): Promise<string>;

export function probeFrames(ffprobe: string, mp4: string): Promise<{
  frames: number;
  frameRate: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
}>;

export function measureMotion(options: { ffmpeg: string; mp4: string; region: Region }): Promise<{
  diffs: number[];
  thumbnails: Uint8Array[];
  frames: number;
}>;

export function extractFrame(options: { ffmpeg: string; mp4: string; frame: number; out: string; quality?: number }): Promise<string>;
export function thumbnailOf(options: { ffmpeg: string; image: string; region: Region }): Promise<Uint8Array>;

export const STAMP: Readonly<{ x: number; y: number; w: number; h: number; bits: number }>;
export function readStamps(options: { ffmpeg: string; mp4: string }): Promise<{ stamps: number[]; blockWidth: number }>;
export function stampsContiguous(stamps: number[]): { contiguous: boolean; firstBreak: number | null; reason: string | null };
export const MARKER_PROBE: Readonly<Region>;
export const MARKER_RGB: Readonly<{ r: number; g: number; b: number }>;
export function readMarkerFrames(options: { ffmpeg: string; mp4: string }): Promise<boolean[]>;
export function markerOnsets(flags: boolean[]): { start: number | null; end: number | null; count: number };
export function distInfo(dist: string): { path: string; mtime: string | null };
