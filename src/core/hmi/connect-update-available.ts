// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-update-available — "a newer CONNECT exists", derived, never fetched (plan-363 Phase 8).
 *
 * Both halves of the comparison were already in the viewer and were simply never put side by side:
 * the RUNNING release comes from `/health` via `connect-store`, the AVAILABLE one from the Bunny
 * channel manifest via `connect-downloads` — the same source `ConnectDownloadLinks` has always used
 * for its version labels. This module only compares them.
 *
 * Three properties this module exists to guarantee:
 *   1. **Pure.** No fetch, no timer, no store. It is called with what the panel already knows, so
 *      the hint costs exactly zero additional requests — plan-343 T26 pins the ConnectPanel to no
 *      `/update/` traffic at all, and that contract is not softened for a hint.
 *   2. **Display only.** Returning a value never starts anything; carrying an update out stays with
 *      the plan-343 flow in the CONNECT settings window, behind an explicit confirmation.
 *   3. **Silent unless it has something to say.** Same version, older offer, an unreadable version
 *      on either side, or an unreachable manifest all yield `null`. A version this code cannot
 *      compare is a reason to say nothing, never a reason to guess.
 */

import type { ConnectChannelInfo } from './connect-downloads';
import { updateReasonSentence } from './connect-update-store';

/**
 * Parses a version into its numeric segments, or `null` when it is not a plain dotted number.
 *
 * Pre-release and build metadata are cut off before parsing (`6.4.0-beta.1` → `6.4.0`), so a
 * prerelease compares equal to its final release and is therefore never proposed as an update to
 * it — which is exactly the plan-343 rule that a beta is offered but never pushed.
 */
export function parseVersionSegments(version: string): number[] | null {
  if (typeof version !== 'string') return null;
  const core = version.trim().replace(/^v/i, '').split(/[-+]/)[0];
  if (!core) return null;
  const segments: number[] = [];
  for (const part of core.split('.')) {
    if (!/^\d+$/.test(part)) return null;
    segments.push(Number(part));
  }
  return segments.length > 0 ? segments : null;
}

/**
 * Semantic comparison: `-1 | 0 | 1`, or `null` when either side is unreadable.
 *
 * Segment-wise and numeric on purpose — a string comparison would rank `6.3.9` above `6.3.10` and
 * hide precisely the update that matters. Missing segments count as zero, so `6.3` equals `6.3.0`.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersionSegments(a);
  const right = parseVersionSegments(b);
  if (!left || !right) return null;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** What the panel knows without asking anyone. */
export interface UpdateAvailabilityInput {
  /** Running release, `snapshot.serverVersion` from `/health`. Empty while not connected. */
  runningVersion: string;
  /**
   * The offer to compare against — the STABLE channel of the release manifest, `null` while it is
   * unreachable or not yet loaded. Only stable: a beta is a deliberate choice made in the settings
   * window, never something the panel proposes on its own (plan-343 section 3.2).
   */
  available: ConnectChannelInfo | null;
  /** `updateSupported` from `/health`. */
  updateSupported: boolean;
  /** `updateReason` from `/health` — a token of the gateway's closed set, or `null`. */
  updateReason: string | null;
}

/** A newer CONNECT exists, and what the operator can do about it. */
export interface UpdateAvailability {
  runningVersion: string;
  availableVersion: string;
  /** Download URL of the available build — the manual route when the automatic one is closed. */
  downloadUrl: string;
  /** True when this installation can carry the update out itself (the plan-343 flow). */
  supported: boolean;
  /**
   * One plain sentence why it cannot, when the gateway named a reason. `null` when the update is
   * supported, or when the gateway is old enough not to report a reason at all — in that case the
   * download link is the way forward, so the line still is not a dead end.
   */
  reasonSentence: string | null;
}

/**
 * Compares running against available and returns the hint to show, or `null` for "say nothing".
 *
 * `null` covers four cases that are not faults and must not produce a standing notice: no gateway
 * connected, an unreachable manifest (an offline channel is not a panel error), a version on either
 * side that cannot be parsed, and — the common case — an installation that is already current.
 */
export function resolveUpdateAvailability(input: UpdateAvailabilityInput): UpdateAvailability | null {
  const availableVersion = input.available?.version;
  if (!input.runningVersion || !input.available || !availableVersion) return null;

  const order = compareVersions(availableVersion, input.runningVersion);
  if (order === null || order <= 0) return null;

  return {
    runningVersion: input.runningVersion,
    availableVersion,
    downloadUrl: input.available.url,
    supported: input.updateSupported,
    reasonSentence: input.updateSupported ? null : updateReasonSentence(input.updateReason),
  };
}
