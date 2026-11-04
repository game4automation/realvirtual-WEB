// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { preflightSnapshot, type PreflightContext } from '@rv/plugins/des/rv-des-preflight';

const fingerprint = { schemaVersion: 4 as const, rngVersion: 2, components: [], modelHash: 'current', runConfigHash: 'run' };
const lookup = vi.fn(() => undefined);
const handles = vi.fn(() => []);
const ctx: PreflightContext = {
  fingerprint, participants: new Map(), componentTypeOf: lookup, getActionSchema: lookup, handleRefs: handles,
};

describe('legacy snapshot rejection without conversion', () => {
  it.each([
    { version: 1, simTime: 0, components: [] },
    { version: 2, simTime: 0, eventQueue: [] },
    { version: 3, simTime: 0, components: [] },
    { version: 3, fingerprint, simTime: 0, eventQueue: [], parts: [] },
    { currentTime: 0, events: [] },
    { simTime: 0, components: [] },
    { simTime: 0 },
    { version: 3, experimentId: 'old-run', checkpoints: [{ simTime: 10, components: [] }] },
    { version: 99, fingerprint },
  ])('rejects legacy envelope %j immediately', raw => {
    lookup.mockClear();
    handles.mockClear();
    const before = structuredClone(raw);
    expect(preflightSnapshot(raw, ctx)).toEqual({ ok: false, problems: [
      { code: 'des-snapshot-legacy', path: 'version', reason: expect.stringContaining('start a new run') },
    ] });
    expect(lookup).not.toHaveBeenCalled();
    expect(handles).not.toHaveBeenCalled();
    expect(raw).toEqual(before);
  });
});
