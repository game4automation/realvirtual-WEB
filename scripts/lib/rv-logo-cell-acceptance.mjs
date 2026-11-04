// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-logo-cell-acceptance.mjs - the ONE throughput floor of the logo cell acceptance (plan-2219 E14).
 *
 * Shared by the test harness (the logo-cell model acceptance test, criterion A1) and the
 * real-viewer soak (scripts/logo-cell-soak-viewer.mjs, criterion A2), so both judge the same numbers.
 * Calibrated on the smooth-motion provider (S-curve drives, as in the viewer): one cycle takes
 * about 16.3 s, i.e. 36 scans per 600 s; minus 2 scans tolerance for the run-in.
 * Pure functions, no Node imports: the harness runs in browser mode.
 */

//! Scans per 600 s sim time the floor is calibrated on.
export const CELL_SCANS_PER_600_S = 36;

//! Minimum scans (first + follow-up) for a run of `seconds` sim seconds.
export function cellMinimumVolume(seconds) {
  return Math.floor(seconds / 600 * CELL_SCANS_PER_600_S) - 2;
}

//! Minimum follow-up scans: the minimum volume minus one first scan per distinct box, at least 1.
export function cellMinimumFollowUps(minimumVolume, distinctBoxes) {
  return Math.max(1, minimumVolume - distinctBoxes);
}
