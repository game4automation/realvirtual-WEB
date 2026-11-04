// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Manual snapshots must never label a completed batch run as the live run. */
export interface LiveSnapshotIdentity {
  runId?: string;
  seed: number;
  rngVersion?: 1 | 2;
  configKey?: string;
}
export interface SnapshotTarget extends LiveSnapshotIdentity {
  index: number;
  status?: string;
}
export function liveSnapshotIndex(runs: readonly SnapshotTarget[], live: LiveSnapshotIdentity): number {
  const match = runs.find(r => (r.status === undefined || r.status === 'running') && (live.runId
    ? r.runId === live.runId
    : !!live.configKey && r.seed === live.seed && r.rngVersion === live.rngVersion && r.configKey === live.configKey));
  return match?.index ?? Math.max(-1, ...runs.map(r => r.index)) + 1;
}
