// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `_rv-livesync-extension.mjs` (plan-637 Phase 6).
 */

import type { Plugin } from 'vite';

export const LIVESYNC_KIT_DIR: string;
export const LIVESYNC_ZIP_FOLDER: string;
export const LIVESYNC_DOWNLOAD_DIR: string;
export const LIVESYNC_ROOT_FILES: string[];
export function readLivesyncVersion(kitDir: string): string;
export function livesyncZipName(version: string): string;
export function livesyncDownloadPath(version: string): string;
export function collectLivesyncFiles(kitDir: string): Array<{ rel: string; abs: string }>;
export function buildLivesyncZip(kitDir: string): {
  version: string;
  fileName: string;
  path: string;
  entries: string[];
  bytes: Uint8Array;
};
export function livesyncClientInfo(rootDir: string): { version: string; path: string } | null;
export function livesyncExtensionPlugin(rootDir: string): Plugin;
