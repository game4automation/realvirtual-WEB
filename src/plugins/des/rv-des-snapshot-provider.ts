// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { DESSnapshotV4 } from './rv-des-snapshot-v4';
import type { Snapshottable } from './rv-snapshot-registry';

export type SnapshotProvider = (ctx: { raw?: DESSnapshotV4; restoring: boolean }) => readonly Snapshottable[];

/** Extra components are derived topology, outside desIdentity/model fingerprint.
 * Missing owners are rejected by the registry's missing-participant check. */
export type SnapshotComponentProvider = (ctx: {
  addressOf(node: import('three').Object3D): string | null;
}) => ReadonlyMap<string, import('./rv-des-component').DESComponent>;
