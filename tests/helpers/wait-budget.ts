// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { waitFor, type waitForOptions } from '@testing-library/react';

// Testing Library's asyncUtilTimeout defaults to 1000 ms
// (node_modules/@testing-library/dom/dist/config.js:15). Under 24 parallel
// Chromium pages that is too tight; findBy* uses waitFor with the same default.
// This conservative fixed budget is not a measured worker-dependent scale.
export const WAIT_BUDGET_MS = 5000;

export function waitBudgetMs(): number {
  return WAIT_BUDGET_MS;
}

export function budgeted(opts?: waitForOptions): waitForOptions {
  return { timeout: waitBudgetMs(), ...opts };
}

export function waitForBudgeted<T>(
  cb: () => T | Promise<T>,
  opts?: waitForOptions,
): Promise<T> {
  return waitFor(cb, budgeted(opts));
}
