// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * live-link-types — the state and settings types of the USD live link store.
 * Type-only (erased at build time), so the documentation of the state lives
 * here without weighing on the entry chunk (plan-779 eager ratchet).
 */

/**
 * `needs-token`: the user switched sync on but no access token is stored — the
 * switch stays on and the link starts as soon as a token is committed.
 * `remounting` (plan-2239 Phase 3): the structure of the exported scene changed
 * (re-parent, rename, add, remove) — frames are frozen, a new mount follows
 * once the changes settle.
 */
export type LiveLinkStatus = 'off' | 'needs-token' | 'connecting' | 'mounting' | 'remounting' | 'live' | 'error';

/**
 * Durations of the last completed mount in ms (plan-2239 spike: the export and
 * mount time of the viewer was measured nowhere). `totalMs` runs from the mount
 * request to the `mounted` ack.
 */
export interface LiveLinkMountTimings {
  /** Why this mount ran: the first mount of a sync / model, or a structure change. */
  cause: 'initial' | 'structure';
  /** Waiting for `whenSceneReady()` (late placements). */
  sceneReadyMs: number;
  /** Export tree + `.usdz` (includes the structure baseline capture). */
  exportMs: number;
  compressMs: number;
  /** mountBegin + chunks handed to the socket. */
  uploadMs: number;
  /** Last chunk sent → `mounted` ack from Kit. */
  ackMs: number;
  totalMs: number;
  /** Exported prims and their size on the wire. */
  prims: number;
  rawBytes: number;
  compressedBytes: number;
}

export interface LiveLinkState {
  status: LiveLinkStatus;
  /** Current mount generation (0 before the first mount). */
  session: number;
  port: number;
  rateHz: number;
  /** Frames actually sent per second, measured. */
  sentHz: number;
  /** Updates per second the extension reports applying. */
  appliedHz?: number;
  /** Plain-language detail (progress, error, why the last attempt failed). */
  message?: string;
  /**
   * Number of the connection attempt in progress while `connecting` (1 = the
   * first). From 2 on the previous attempt failed and the link is retrying.
   */
  attempt?: number;
  /** Textures the last sync left out because they cannot be exported (undefined = none). */
  texturesSkipped?: number;
  /** "Isaac Sim extension outdated (…) — download v…" while the connected extension is too old. */
  extensionNotice?: string;
  /** Exported prims of the current mount and how many carry a realvirtual address. */
  prims?: { total: number; withAddress: number };
  /** Reason of the last structure remount, e.g. `re-parent: Gripper` (kept after it finished). */
  remountReason?: string;
  /** Number of structure remounts since sync was switched on. */
  remounts?: number;
  /** Durations of the last completed mount. */
  lastMountTimings?: LiveLinkMountTimings;
}

export interface LiveLinkSettings {
  port: number;
  token: string;
  rateHz: number;
  /** Quiet time after the last structure change before the remount, ms (250–5000). */
  remountDebounceMs?: number;
  /**
   * True once the user set the port in the menu. Stored with the settings so a
   * deliberately chosen port survives a later change of the default; records
   * without it predate the flag (see {@link loadLiveLinkSettings}).
   */
  portChosen?: boolean;
}
