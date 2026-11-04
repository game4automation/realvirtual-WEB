// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { budgeted, WAIT_BUDGET_MS, waitBudgetMs, waitForBudgeted } from './helpers/wait-budget';

vi.mock('@testing-library/react', () => ({ waitFor: vi.fn() }));

describe('wait budget', () => {
  beforeEach(() => { vi.mocked(waitFor).mockReset(); });

  it('uses a fixed 5000 ms default for both entry points', () => {
    expect(WAIT_BUDGET_MS).toBe(5000);
    expect(waitBudgetMs()).toBe(5000);
    expect(budgeted()).toEqual({ timeout: 5000 });
  });

  it('lets explicit options override the findBy budget', () => {
    expect(budgeted({ timeout: 123, interval: 17 })).toEqual({ timeout: 123, interval: 17 });
  });

  it('forwards the callback, default timeout and return promise to waitFor', async () => {
    const cb = () => 'ready';
    const pending = Promise.resolve('ready');
    vi.mocked(waitFor).mockReturnValue(pending);
    expect(waitForBudgeted(cb)).toBe(pending);
    expect(waitFor).toHaveBeenCalledExactlyOnceWith(cb, { timeout: 5000 });
    await expect(pending).resolves.toBe('ready');
  });

  it('forwards an explicit timeout and other waitFor options', () => {
    const cb = () => true;
    waitForBudgeted(cb, { timeout: 123, interval: 17 });
    expect(waitFor).toHaveBeenCalledExactlyOnceWith(cb, { timeout: 123, interval: 17 });
  });
});
