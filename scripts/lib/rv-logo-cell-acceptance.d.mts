// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

//! Types for scripts/lib/rv-logo-cell-acceptance.mjs (plan-2219 E14).

export declare const CELL_SCANS_PER_600_S: number;

export declare function cellMinimumVolume(seconds: number): number;

export declare function cellMinimumFollowUps(minimumVolume: number, distinctBoxes: number): number;
