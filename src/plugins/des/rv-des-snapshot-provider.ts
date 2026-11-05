// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export type { SnapshotProvider } from '../../core/sdk/rv-snapshot-contract-types';

/** Extra components are derived topology, outside desIdentity/model fingerprint.
 * Missing owners are rejected by the registry's missing-participant check. */
export type SnapshotComponentProvider = (ctx: {
  addressOf(node: import('three').Object3D): string | null;
}) => ReadonlyMap<string, import('./rv-des-component').DESComponent>;
