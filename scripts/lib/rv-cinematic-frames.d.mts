// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Node adapter of the cinematic out dir; the portable part is re-exported from
// src/core/engine/rv-cinematic-manifest.mjs (plan-551 F24).

export const MANIFEST_NAME: string;
export const MANIFEST_VERSION: number;
export const BYTES_PER_FRAME_ESTIMATE: number;
export const DISK_MARGIN: number;
export const RESUME_FIELDS: string[];
export function frameFileName(index: number): string;
export function frameIndexOf(name: string): number;
export function isCompletePng(bytes: Uint8Array | null | undefined): boolean;
export function scanFrames(dir: string, frames: number): {
  existing: number[]; firstMissing: number; gaps: number[]; removedBroken: string | null; tempFiles: string[];
};
export function removeTempFiles(dir: string, names: string[]): void;
export function writeFrameAtomic(dir: string, index: number, bytes: Uint8Array): string;
export function sha256(data: string | Uint8Array): string;
export function optionsHash(options: unknown): string;
export function compareManifest(stored: Record<string, unknown> | null, current: Record<string, unknown>): string | null;
export function readManifest(dir: string): Record<string, unknown> | null;
export function writeManifest(dir: string, manifest: Record<string, unknown>): void;
export function checkDiskSpace(
  dir: string, remainingFrames: number, statfs?: (dir: string) => { bavail: number | bigint; bsize: number | bigint },
): { need: number; free: number | null };
export function framesBytes(dir: string, frames: number): number;
export function formatDuration(seconds: number): string;
export function stableStringify(v: unknown): string;
