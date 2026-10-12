// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

//! Types for scripts/lib/rv-dotenv.mjs (plan-587 F7). Sibling declaration file,
//! the established answer in this repo for a .mjs imported from a .ts test.

export type MergePolicy = 'firstNonEmpty' | 'last';

export declare function parseDotEnvText(text: unknown): Array<[string, string]>;

export declare function mergeEnv(
  entries: Iterable<[string, string]> | null | undefined,
  policy: MergePolicy,
  into?: Record<string, string | undefined>,
): Record<string, string | undefined>;

export declare function loadDotEnvText(
  text: unknown,
  policy: MergePolicy,
  into?: Record<string, string | undefined>,
): Record<string, string | undefined>;
