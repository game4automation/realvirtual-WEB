// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// The HMI side of `npm run record` (plan-556) — see rv-record-hmi.mjs.

export const HMI_MODES: string[];
export const DEFAULT_HMI_TIMEOUT_S: number;
export interface HmiCliOptions {
  mode: 'off' | 'composite' | 'layer';
  on: boolean;
  open: string[];
  still: string | null;
  at: number;
  steps: number;
  keepFrames: boolean;
  timeoutMs: number;
}
export function hmiFileName(index: number): string;
export function stillLayerPath(file: string): string;
export function hmiCliOptions(opts: Record<string, unknown>, quality: string, fail: (msg: string) => never): HmiCliOptions;
export function checkFreshOutDir(dir: string): void;
export function bootCleanupInitScript(): void;
export function writeFramePng(dir: string, index: number, bytes: Uint8Array): string;
export function writeHmiPng(dir: string, index: number, bytes: Uint8Array): string;
export function scanPairs(dir: string, frames: number, o: { layer: boolean }): { firstIncomplete: number; complete: number };
export function createHmiFrameWriter(o: {
  page: unknown; dir: string; mode: string; timeoutMs: number; onWritten?: (i: number) => void;
}): { readonly generation: number; expose(): Promise<void>; stop(): void };
export function installPageHook(cfg: { gen: number; timeoutMs: number }): void;
export function enterRecordingPage(page: unknown, o: { open: string[] }): Promise<{
  warnings: string[]; viewport: { width: number; height: number }; rect: { width: number; height: number } | null;
}>;
export function exitRecordingPage(page: unknown): Promise<void>;
export function countFrames(file: string): Promise<{ frames: number; duration: number; width: number; height: number }>;
export function muxFrameDir(page: unknown, o: {
  dir: string; frames: number; fps: number; width: number; height: number; out: string;
  codec?: string; bitrate?: number; fileName?: (i: number) => string;
  verify?: (file: string) => Promise<{ frames: number; duration: number; width: number; height: number }>;
}): Promise<{ mux: Record<string, unknown>; check: { frames: number; duration: number; width: number; height: number }; size: number }>;
export function deleteCompositeFrames(dir: string, frames: number): void;
