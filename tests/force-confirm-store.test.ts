// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * force-confirm-store — first-force-in-session confirmation gate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  requestForceConfirm,
  resolveForceConfirm,
  isForceConfirmed,
  getForceConfirmOpen,
  resetForceConfirm,
} from '../src/core/hmi/force-confirm-store';

describe('force-confirm-store', () => {
  beforeEach(() => resetForceConfirm());

  it('opens a prompt on the first request and resolves true when confirmed', async () => {
    expect(isForceConfirmed()).toBe(false);
    const p = requestForceConfirm();
    expect(getForceConfirmOpen()).toBe(true);
    resolveForceConfirm(true);
    expect(await p).toBe(true);
    expect(isForceConfirmed()).toBe(true);
    expect(getForceConfirmOpen()).toBe(false);
  });

  it('does not prompt again once confirmed (until reset/reload)', async () => {
    resolveForceConfirm(true); // not strictly needed, but ensure clean state
    resetForceConfirm();
    const p1 = requestForceConfirm();
    resolveForceConfirm(true);
    await p1;
    // Second request short-circuits without opening the prompt.
    const p2 = requestForceConfirm();
    expect(getForceConfirmOpen()).toBe(false);
    expect(await p2).toBe(true);
  });

  it('resolves false and stays unconfirmed when cancelled', async () => {
    const p = requestForceConfirm();
    resolveForceConfirm(false);
    expect(await p).toBe(false);
    expect(isForceConfirmed()).toBe(false);
    // A later request prompts again.
    const p2 = requestForceConfirm();
    expect(getForceConfirmOpen()).toBe(true);
    resolveForceConfirm(false);
    expect(await p2).toBe(false);
  });

  it('chains concurrent requests onto a single decision', async () => {
    const a = requestForceConfirm();
    const b = requestForceConfirm();
    expect(getForceConfirmOpen()).toBe(true);
    resolveForceConfirm(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
  });
});
