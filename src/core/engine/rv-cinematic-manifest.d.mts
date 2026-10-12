// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export const MANIFEST_NAME: string;
export const MANIFEST_VERSION: number;
export const BYTES_PER_FRAME_ESTIMATE: number;
export const DISK_MARGIN: number;
export const RESUME_FIELDS: string[];
export interface ManifestWording { place: string; advice: string }
export const CLI_WORDING: ManifestWording;
export function frameFileName(index: number): string;
export function frameIndexOf(name: string): number;
export function isCompletePng(bytes: Uint8Array | null | undefined): boolean;
export function classifyFrameNames(names: Iterable<string>, frames: number): { present: number[]; tempFiles: string[] };
export function resumePoint(present: Iterable<number>, frames: number): { existing: number[]; firstMissing: number; gaps: number[] };
export function stableStringify(v: unknown): string;
export function utf8Bytes(text: string): Uint8Array;
export function optionsHashSync(options: unknown, digestHexSync: (bytes: Uint8Array) => string): string;
export function optionsHashAsync(options: unknown, digestHex: (bytes: Uint8Array) => Promise<string>): Promise<string>;
export function compareManifest(stored: Record<string, unknown> | null, current: Record<string, unknown>, wording?: ManifestWording): string | null;
export interface CinematicManifestOptions {
  width: number; height: number; fps: number; seconds: number; warmupSeconds: number;
  samples: number; denoise: string; path: unknown;
  /** plan-553 look options (absent = defaults: studio, vignette 0.15, DoF off, presets on). */
  look?: string; dof?: boolean; fStop?: number; vignette?: number; materialPresets?: boolean; materialOverrides?: unknown;
  /** plan-554 motion blur (absent = defaults: on, 180°, 8 sub-frames). */
  motionBlur?: { enabled?: boolean; shutterDeg?: number; subFrames?: number };
  /** plan-556 HMI in the video (absent / 'off' = none — nothing enters the hash). */
  hmi?: 'off' | 'composite' | 'layer';
  /** plan-556: panels opened for the recording (`--hmi-open`). */
  hmiOpen?: string[];
  /** plan-556: the browser viewport the HMI was laid out in. */
  viewport?: { width: number; height: number; dpr?: number } | null;
  /** plan-556 F10 (dialog): ids, collapsed state and rects of the visible panels. */
  layoutFingerprint?: string;
}
export const DEFAULTED_RESUME_FIELDS: Record<string, unknown>;
export function hmiOn(options: { hmi?: string } | null | undefined): boolean;
export function cinematicHmiOptions(options: Partial<CinematicManifestOptions>): {
  hmi?: string; hmiOpen?: string[]; viewport?: CinematicManifestOptions['viewport']; layoutFingerprint?: string;
};
export interface CinematicMotionBlurOptions { enabled: boolean; shutterDeg: number; subFrames: number }
export const MOTION_BLUR_DEFAULTS: CinematicMotionBlurOptions;
export function cinematicMotionBlurOptions(options: Partial<CinematicManifestOptions> | null | undefined): CinematicMotionBlurOptions;
export type CinematicBlurManifestFields = { resolvedBlur: string; blurFallbackReason: string | null; blurSubFrames: number };
export function blurManifestFields(
  resolution: { resolved?: string; reason?: string | null; subFrames?: number } | null | undefined,
): CinematicBlurManifestFields;
export interface CinematicLookOptions {
  look: string; dof: boolean; fStop: number | null; vignette: number; materialPresets: boolean; materialOverrides: unknown;
}
export const LOOK_OPTION_DEFAULTS: { look: string; vignette: number; fStop: number };
export function cinematicLookOptions(options: Partial<CinematicManifestOptions>): CinematicLookOptions;
export interface CinematicBaseManifest {
  version: number; optionsHash: string; frames: number; fps: number; width: number; height: number;
  samples: number; denoise: string; warmupSeconds: number; cameraPath: unknown;
  lookOptions: Omit<CinematicLookOptions, 'materialOverrides'> & { materialOverrides: 'set' | null };
  motionBlur: CinematicMotionBlurOptions;
  hmi?: string; hmiOpen?: string[]; viewport?: CinematicManifestOptions['viewport']; layoutFingerprint?: string;
}
export function cinematicHashedOptions(options: CinematicManifestOptions, hdrFileHash: string | null): Record<string, unknown>;
export function cinematicBaseManifestWith(options: CinematicManifestOptions, optionsHashHex: string): CinematicBaseManifest;
export function cinematicBaseManifestAsync(
  options: CinematicManifestOptions, hdrFileHash: string | null, digestHex: (bytes: Uint8Array) => Promise<string>,
): Promise<CinematicBaseManifest>;
export function resumeRefusal(
  stored: Record<string, unknown> | null, current: Record<string, unknown>, existingFrames: number, wording?: ManifestWording,
): string | null;
export function formatDuration(seconds: number): string;
