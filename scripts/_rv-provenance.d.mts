// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `_rv-provenance.mjs`.
 *
 * Required because the Node tests import the module statically from TypeScript;
 * without it `npx tsc --noEmit` fails with TS7016. Keep in step with the .mjs —
 * there is no compiler check tying the two together.
 */

export type RvPublishTarget = 'bunny-private' | 'connect-embed' | 'delivery';

export interface RvPublishEntry {
  at: string;
  version?: string;
  code?: string;
  connectBuild?: string;
  coreCommit?: string;
  [key: string]: unknown;
}

export interface RvPublishManifest {
  lastPublished?: string;
  provenance?: {
    lastPublishedBy?: Partial<Record<RvPublishTarget, RvPublishEntry>>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const PUBLISH_TARGETS: readonly RvPublishTarget[];
export function publishTimestamp(now?: Date): string;
export function withPublishProvenance(
  manifest: RvPublishManifest,
  target: RvPublishTarget,
  info?: Record<string, unknown>,
  now?: Date,
): RvPublishManifest;
export function recordPublishProvenance(
  projectDir: string,
  target: RvPublishTarget,
  info?: Record<string, unknown>,
  now?: Date,
): RvPublishManifest | null;
